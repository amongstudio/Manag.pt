import type { FastifyInstance } from "fastify"
import { Prisma, prisma, type Device } from "@workspace/db"
import {
  DEFAULT_MESH_POLICY,
  DEFAULT_WATCH_INTERVAL_MS,
  WS_EVENTS,
  capCommandResult,
  needsSecretRedaction,
  sanitizeLanAddrs,
  sanitizeLanPort,
  stripCredentialSecrets,
  type CommandResultInput,
  type HeartbeatInput,
  type MeshPolicy,
} from "@workspace/shared"

import { env } from "./env.js"
import { emitFleet } from "./io-emit.js"
import { listSafeResult } from "./command-audit.js"
import { applyCommandEffects } from "./command-effects.js"
import { enqueueAlert } from "./notify.js"
import { getSettings } from "./settings.js"
import { ingestCredentialResult } from "./vault.js"

export type AgentConfigPayload = {
  heartbeatIntervalSec: number
  pollIntervalSec: number
  screenshotIntervalSec: number
  autoRestartTime: string
  sandboxRoots: string[]
  lightweight: boolean
  idleHeartbeatSec: number
  watchedHeartbeatSec: number
  maxUploadBytes: number
  mesh: MeshPolicy
}

export type HeartbeatAck = {
  serverTime: string
  watch: { intervalMs: number } | null
  agentConfig: AgentConfigPayload
  device: Device
}

export async function claimPendingCommands(deviceId: string) {
  return prisma.$transaction(async (tx) => {
    const pending = await tx.command.findMany({
      where: { deviceId, status: "pending" },
      orderBy: { createdAt: "asc" },
      take: 20,
    })
    if (pending.length === 0) return []
    const ids = pending.map((command) => command.id)
    await tx.command.updateMany({
      where: { id: { in: ids }, status: "pending" },
      data: { status: "running" },
    })
    return tx.command.findMany({
      where: { id: { in: ids }, status: "running" },
      orderBy: { createdAt: "asc" },
    })
  })
}

export async function revertCommandToPending(id: string): Promise<void> {
  await prisma.command.updateMany({
    where: { id, status: "running" },
    data: { status: "pending" },
  })
}

export function lanDiscoveryData(input: { lanAddrs?: string[]; lanPort?: number }): {
  lanAddrs?: string
  lanPort?: number
} | null {
  if (input.lanAddrs === undefined && input.lanPort === undefined) return null
  const data: { lanAddrs?: string; lanPort?: number } = {}
  if (input.lanAddrs !== undefined) data.lanAddrs = JSON.stringify(sanitizeLanAddrs(input.lanAddrs))
  const port = sanitizeLanPort(input.lanPort)
  if (port) data.lanPort = port
  return Object.keys(data).length ? data : null
}

export async function touchDeviceOnline(
  app: FastifyInstance,
  device: Device,
  ip: string,
  lan?: { lanAddrs?: string; lanPort?: number } | null
): Promise<Device> {
  const wasOffline = device.status !== "online"
  const updated = await prisma.device.update({
    where: { id: device.id },
    data: { status: "online", lastSeen: new Date(), ip, ...(lan ?? {}) },
  })
  if (wasOffline) {
    emitFleet(app, WS_EVENTS.DEVICE_STATUS, { id: device.id, status: "online", hostname: updated.hostname })
    await enqueueAlert(app, {
      type: "device_online",
      deviceId: device.id,
      title: `${updated.hostname} is online`,
      body: "Agent connected",
    })
  }
  return updated
}

export async function markDeviceWsOffline(
  app: FastifyInstance | undefined,
  deviceId: string,
  hostname: string,
  stillConnected: () => boolean
): Promise<void> {
  if (stillConnected()) return
  const now = new Date()
  const result = await prisma.device.updateMany({
    where: { id: deviceId, status: "online" },
    data: { status: "offline", lastSeen: now },
  })
  if (stillConnected()) {
    await prisma.device.updateMany({
      where: { id: deviceId },
      data: { status: "online" },
    })
    return
  }
  if (result.count === 0) return
  if (!app) return
  emitFleet(app, WS_EVENTS.DEVICE_STATUS, { id: deviceId, status: "offline", lastSeen: now })
  await enqueueAlert(app, {
    type: "device_offline",
    deviceId,
    title: `${hostname} went offline`,
    body: `Agent websocket closed at ${now.toISOString()}`,
  })
}

export async function agentConfigPayload(): Promise<AgentConfigPayload> {
  const settings = await getSettings()
  const idle = settings.agent.idleHeartbeatSec || settings.agent.heartbeatIntervalSec
  const mesh: MeshPolicy = {
    ...DEFAULT_MESH_POLICY,
    ...settings.mesh,
    allowCommands: Array.isArray(settings.mesh?.allowCommands) ? settings.mesh.allowCommands : [],
  }
  return {
    heartbeatIntervalSec: idle,
    pollIntervalSec: settings.agent.pollIntervalSec,
    screenshotIntervalSec: settings.agent.screenshotIntervalSec,
    autoRestartTime: settings.agent.autoRestartTime,
    sandboxRoots: settings.agent.sandboxRoots,
    lightweight: settings.agent.lightweight,
    idleHeartbeatSec: idle,
    watchedHeartbeatSec: settings.agent.watchedHeartbeatSec,
    maxUploadBytes: env.maxUploadBytes,
    mesh,
  }
}

export function watchPayload(device: Device): { intervalMs: number } | null {
  const watching = Boolean(device.watchUntil && device.watchUntil.getTime() > Date.now())
  return watching ? { intervalMs: DEFAULT_WATCH_INTERVAL_MS } : null
}

/** Presence-only: updates lastSeen/status. cpu/ram/disk/extras/processes are ignored (no Stat rows). */
export async function ingestHeartbeat(
  app: FastifyInstance,
  device: Device,
  _parsed: HeartbeatInput,
  ip: string
): Promise<HeartbeatAck> {
  const wasOffline = device.status !== "online"
  const now = new Date()
  const watchExpired = Boolean(device.watchUntil && device.watchUntil.getTime() <= now.getTime())
  const lan = lanDiscoveryData({ lanAddrs: _parsed.lanAddrs, lanPort: _parsed.lanPort })
  const updated = await prisma.device.update({
    where: { id: device.id },
    data: {
      status: "online",
      lastSeen: now,
      ip,
      ...(lan ?? {}),
      ...(watchExpired ? { watchUntil: null } : {}),
    },
  })
  if (wasOffline) {
    emitFleet(app, WS_EVENTS.DEVICE_STATUS, { id: updated.id, status: "online", hostname: updated.hostname })
    await enqueueAlert(app, {
      type: "device_online",
      deviceId: device.id,
      title: `${updated.hostname} is online`,
      body: "Heartbeat resumed",
    })
  }
  if (watchExpired) {
    emitFleet(app, WS_EVENTS.DEVICE_STATUS, {
      id: device.id,
      status: "online",
      hostname: updated.hostname,
      watching: false,
    })
  }
  return {
    serverTime: new Date().toISOString(),
    watch: watchPayload(updated),
    agentConfig: await agentConfigPayload(),
    device: updated,
  }
}

export async function ingestCommandResult(
  app: FastifyInstance,
  device: Device,
  parsed: CommandResultInput
): Promise<{ ok: true; duplicate?: boolean } | { ok: false; error: "not_found" }> {
  const terminal = new Set(["success", "failed", "cancelled"])
  const existing = await prisma.command.findFirst({
    where: { id: parsed.commandId, deviceId: device.id },
    select: { type: true },
  })
  let stored: unknown = parsed.result ?? null
  if (existing && needsSecretRedaction(existing.type)) {
    stored = await ingestCredentialResult(device.id, existing.type, stored)
  }
  stored = capCommandResult(stored)
  if (parsed.status === "running") {
    const base =
      stored && typeof stored === "object" && !Array.isArray(stored)
        ? { ...(stored as Record<string, unknown>) }
        : {}
    if (parsed.progress != null) base.progress = parsed.progress
    stored = capCommandResult(base)
  }

  let outcome: { kind: "missing" } | { kind: "duplicate" } | { kind: "ok"; updated: { id: string; type: string; status: string } }
  try {
    outcome = await prisma.$transaction(async (tx) => {
    const command = await tx.command.findFirst({
      where: { id: parsed.commandId, deviceId: device.id },
    })
    if (!command) return { kind: "missing" as const }
    if (terminal.has(command.status)) return { kind: "duplicate" as const }
    if (parsed.status === "running" && command.status !== "running") return { kind: "duplicate" as const }
    const byResultId = await tx.command.findUnique({ where: { resultId: parsed.resultId } })
    if (byResultId && byResultId.id !== command.id) return { kind: "duplicate" as const }
    const claimed = await tx.command.updateMany({
      where: {
        id: command.id,
        status: { notIn: [...terminal] },
      },
      data: {
        status: parsed.status,
        result: JSON.stringify(stored),
        resultId: parsed.resultId,
      },
    })
    if (claimed.count !== 1) return { kind: "duplicate" as const }
    const updated = await tx.command.findUniqueOrThrow({ where: { id: command.id } })
    return { kind: "ok" as const, updated }
    })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { ok: true, duplicate: true }
    }
    throw error
  }

  if (outcome.kind === "missing") return { ok: false, error: "not_found" }
  if (outcome.kind === "duplicate") return { ok: true, duplicate: true }

  const updated = outcome.updated
  const publicResult = listSafeResult(updated.type, needsSecretRedaction(updated.type) ? stripCredentialSecrets(stored) : stored)
  emitFleet(app, WS_EVENTS.COMMAND_RESULT, {
    id: updated.id,
    deviceId: device.id,
    type: updated.type,
    status: updated.status,
    result: publicResult,
  })
  if (updated.status === "failed") {
    app.log.warn({ deviceId: device.id, commandId: updated.id, type: updated.type }, "command failed")
    await enqueueAlert(app, {
      type: "command_failure",
      deviceId: device.id,
      title: `Command failed on ${device.hostname}`,
      body: needsSecretRedaction(updated.type)
        ? `${updated.type} failed (secrets omitted)`
        : `${updated.type}: ${JSON.stringify(listSafeResult(updated.type, stored) ?? {})}`,
    })
  }
  const full = await prisma.command.findUnique({ where: { id: updated.id } })
  if (full) {
    await applyCommandEffects(device.id, full).catch((error) => {
      app.log.error({ err: error, commandId: full.id }, "command side effect failed")
    })
  }
  if (updated.type === "kill_switch" && terminal.has(updated.status)) {
    await enqueueAlert(app, {
      type: "kill_switch",
      deviceId: device.id,
      title: `Kill switch on ${device.hostname}`,
      body: `Status ${updated.status}`,
    })
  }
  return { ok: true }
}
