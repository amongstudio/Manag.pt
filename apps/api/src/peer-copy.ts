import { randomUUID } from "node:crypto"

import type { FastifyInstance } from "fastify"
import { prisma, type Device } from "@workspace/db"
import {
  PEER_LAN_PORT,
  PEER_TICKET_TTL_SEC,
  WS_EVENTS,
  lanPeersForDevice,
  parseStoredLanAddrs,
  peerCopyRequestSchema,
  peerTicketMessage,
  sanitizeLanPort,
  type PeerTicket,
} from "@workspace/shared"

import { env } from "./env.js"
import { emitFileProgress } from "./file-transfer.js"
import { emitFleet } from "./io-emit.js"
import { parseJson, signPeerTicket } from "./lib.js"
import { getSettings } from "./settings.js"

export type LanPeerRow = ReturnType<typeof lanPeersForDevice>[number]

export function deviceLanView(device: Pick<Device, "id" | "hostname" | "status" | "ip" | "lanAddrs" | "lanPort">) {
  return {
    id: device.id,
    hostname: device.hostname,
    status: device.status,
    ip: device.ip,
    lanAddrs: parseStoredLanAddrs(device.lanAddrs),
    lanPort: sanitizeLanPort(device.lanPort) ?? PEER_LAN_PORT,
  }
}

export async function lanPeersFor(device: Device): Promise<LanPeerRow[]> {
  const others = await prisma.device.findMany({
    where: { id: { not: device.id } },
    select: { id: true, hostname: true, status: true, ip: true, lanAddrs: true, lanPort: true },
    orderBy: { hostname: "asc" },
    take: 200,
  })
  return lanPeersForDevice(deviceLanView(device), others.map(deviceLanView))
}

async function dispatchPeerCommands(app: FastifyInstance, deviceId: string): Promise<void> {
  const { dispatchQueuedCommands } = await import("./agent-ws.js")
  await dispatchQueuedCommands(app, deviceId)
}

function ticketFrom(fields: Omit<PeerTicket, "sig">): PeerTicket {
  const sig = signPeerTicket(peerTicketMessage(fields))
  return { ...fields, sig }
}

async function createPeerFileRow(input: {
  deviceId: string
  remotePath: string
  copyId: string
}) {
  return prisma.fileInfo.create({
    data: {
      deviceId: input.deviceId,
      direction: "peer",
      localPath: `peer:${input.copyId}`,
      remotePath: input.remotePath,
      size: 0,
      offset: 0,
      status: "transferring",
    },
  })
}

export async function createOperatorPeerCopy(
  app: FastifyInstance,
  src: Device,
  body: unknown
): Promise<{ ok: true; copyId: string; commands: { id: string; deviceId: string; type: string }[] } | { ok: false; status: number; error: string; details?: unknown }> {
  const parsed = peerCopyRequestSchema.safeParse(body)
  if (!parsed.success) return { ok: false, status: 400, error: "invalid_body", details: parsed.error.flatten() }
  const destId = parsed.data.destDeviceId
  if (destId === src.id) return { ok: false, status: 400, error: "same_device" }
  const dest = await prisma.device.findUnique({ where: { id: destId } })
  if (!dest) return { ok: false, status: 404, error: "dest_not_found" }
  const srcOnline = src.status === "online"
  const destOnline = dest.status === "online"
  if (!srcOnline) return { ok: false, status: 409, error: "src_offline" }
  if (!destOnline) return { ok: false, status: 409, error: "dest_offline" }

  const destView = deviceLanView(dest)
  const copyId = randomUUID()
  const settings = await getSettings()
  const meshOn = Boolean(settings.mesh?.enabled)

  const srcRow = await createPeerFileRow({
    deviceId: src.id,
    remotePath: `${parsed.data.srcPath} → ${dest.hostname}:${parsed.data.destPath}`,
    copyId,
  })
  const destRow = await createPeerFileRow({
    deviceId: dest.id,
    remotePath: parsed.data.destPath,
    copyId,
  })
  emitFileProgress(app, src.id, srcRow)
  emitFileProgress(app, dest.id, destRow)

  const listenPayload = meshOn
    ? { mesh: true as const, copyId, destPath: parsed.data.destPath, fileId: destRow.id }
    : {
        ticket: ticketFrom({
          copyId,
          srcDeviceId: src.id,
          dstDeviceId: dest.id,
          srcPath: parsed.data.srcPath,
          destPath: parsed.data.destPath,
          exp: Math.floor(Date.now() / 1000) + PEER_TICKET_TTL_SEC,
          maxBytes: env.maxUploadBytes,
          port: destView.lanPort,
          addrs: destView.lanAddrs,
        }),
        fileId: destRow.id,
      }
  const offerPayload = meshOn
    ? {
        mesh: true as const,
        copyId,
        destDeviceId: dest.id,
        srcPath: parsed.data.srcPath,
        destPath: parsed.data.destPath,
        addrs: destView.lanAddrs,
        port: destView.lanPort,
        fileId: srcRow.id,
      }
    : { ticket: (listenPayload as { ticket: PeerTicket }).ticket, fileId: srcRow.id }
  const [listenCmd, offerCmd] = await prisma.$transaction([
    prisma.command.create({
      data: {
        deviceId: dest.id,
        type: "peer_listen",
        payload: JSON.stringify(listenPayload),
        createdBy: "operator",
      },
    }),
    prisma.command.create({
      data: {
        deviceId: src.id,
        type: "peer_offer",
        payload: JSON.stringify(offerPayload),
        createdBy: "operator",
      },
    }),
  ])

  await dispatchPeerCommands(app, dest.id)
  await dispatchPeerCommands(app, src.id)
  for (const row of [listenCmd, offerCmd]) {
    emitFleet(app, WS_EVENTS.COMMAND_QUEUED, {
      id: row.id,
      deviceId: row.deviceId,
      type: row.type,
      status: row.status,
    })
  }
  return {
    ok: true,
    copyId,
    commands: [
      { id: listenCmd.id, deviceId: listenCmd.deviceId, type: listenCmd.type },
      { id: offerCmd.id, deviceId: offerCmd.deviceId, type: offerCmd.type },
    ],
  }
}

export type PeerRelayPlan = {
  destDeviceId: string
  destPath: string
  srcFileId: string
  size?: number
}

export async function queuePeerRelayDownload(app: FastifyInstance, plan: PeerRelayPlan): Promise<void> {
  const srcFile = await prisma.fileInfo.findUnique({ where: { id: plan.srcFileId } })
  if (!srcFile || !(srcFile.status === "complete" || srcFile.status === "transferring")) return
  if (srcFile.direction !== "upload") return

  const destFile = await prisma.fileInfo.create({
    data: {
      deviceId: plan.destDeviceId,
      direction: "download",
      localPath: srcFile.localPath,
      remotePath: plan.destPath,
      size: plan.size && plan.size > 0 ? plan.size : srcFile.size,
      offset: 0,
      status: "transferring",
    },
  })
  emitFileProgress(app, plan.destDeviceId, destFile)
  const cmd = await prisma.command.create({
    data: {
      deviceId: plan.destDeviceId,
      type: "download_file",
      payload: JSON.stringify({ fileId: destFile.id, dest: plan.destPath }),
      createdBy: "operator",
    },
  })
  await dispatchPeerCommands(app, plan.destDeviceId)
  emitFleet(app, WS_EVENTS.COMMAND_QUEUED, {
    id: cmd.id,
    deviceId: cmd.deviceId,
    type: cmd.type,
    status: cmd.status,
  })
}

export async function touchPeerFileProgress(
  app: FastifyInstance,
  deviceId: string,
  payload: Record<string, unknown>,
  result: unknown,
  status: string
): Promise<void> {
  const fileId = typeof payload.fileId === "string" ? payload.fileId : ""
  if (!fileId) return
  const rec = result && typeof result === "object" ? (result as Record<string, unknown>) : {}
  const size = typeof rec.size === "number" && Number.isFinite(rec.size) ? Math.max(0, rec.size) : undefined
  const offset =
    typeof rec.offset === "number" && Number.isFinite(rec.offset)
      ? Math.max(0, rec.offset)
      : typeof rec.progress === "number" && size
        ? Math.round((Math.min(100, Math.max(0, rec.progress)) / 100) * size)
        : undefined
  const nextStatus =
    status === "failed" || status === "cancelled"
      ? "failed"
      : status === "success" && rec.via !== "listen_timeout"
        ? "complete"
        : "transferring"
  const row = await prisma.fileInfo.findFirst({ where: { id: fileId, deviceId } })
  if (!row) return
  const updated = await prisma.fileInfo.update({
    where: { id: row.id },
    data: {
      ...(size != null ? { size } : {}),
      ...(offset != null ? { offset } : {}),
      status: nextStatus,
    },
  })
  emitFileProgress(app, deviceId, updated)
}

export async function afterPeerCommandIngest(
  app: FastifyInstance,
  device: Device,
  parsed: { commandId: string; status: string; result?: unknown }
): Promise<void> {
  const command = await prisma.command.findFirst({
    where: { id: parsed.commandId, deviceId: device.id },
  })
  if (!command || (command.type !== "peer_offer" && command.type !== "peer_listen")) return
  const payload = parseJson<Record<string, unknown>>(command.payload, {})
  await touchPeerFileProgress(app, device.id, payload, parsed.result, parsed.status)
  if (command.type !== "peer_offer" || parsed.status !== "success") return
  const rec = parsed.result && typeof parsed.result === "object" ? (parsed.result as Record<string, unknown>) : {}
  if (rec.via !== "relay") return
  const srcFileId = typeof rec.fileId === "string" ? rec.fileId : ""
  const ticket = payload.ticket && typeof payload.ticket === "object" ? (payload.ticket as PeerTicket) : null
  const destDeviceId =
    ticket?.dstDeviceId || (typeof payload.destDeviceId === "string" ? payload.destDeviceId : "")
  const destPath = ticket?.destPath || (typeof payload.destPath === "string" ? payload.destPath : "")
  if (!srcFileId || !destPath || !destDeviceId) return
  await queuePeerRelayDownload(app, {
    destDeviceId,
    destPath,
    srcFileId,
    size: typeof rec.size === "number" ? rec.size : undefined,
  })
}
