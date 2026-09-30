import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"

import type { FastifyInstance } from "fastify"
import { Prisma, prisma } from "@workspace/db"
import {
  API_PREFIX,
  commandTemplateWriteSchema,
  COMMAND_ACTIVE_STATUS,
  COMMAND_TERMINAL_STATUS,
  createCommandSchema,
  meshForwardRequestSchema,
  meshCommandAllowed,
  MESH_FORWARD_KEY,
  deleteDeviceCommandsSchema,
  DEFAULT_WATCH_DURATION_MIN,
  e2eSessionRequestSchema,
  isCommandActive,
  MAX_WATCH_DURATION_MIN,
  parseStoredLanAddrs,
  redactCredentialCommand,
  redactSettings,
  runPluginPayloadSchema,
  validateCommandPayload,
  WS_EVENTS,
  type CommandType,
} from "@workspace/shared"

import { disconnectAgent, dispatchQueuedCommands, isAgentWsConnected, sendToAgent } from "./agent-ws.js"
import { beginE2ESession, closeE2ESession, e2eSessionFor } from "./e2e-relay.js"
import { webrtcMetaFor } from "./remote-session.js"
import { env, dataPath, iceServersForClient } from "./env.js"
import { emitFleet } from "./io-emit.js"
import { errorBody, multipartValue, pathExists, randomToken, safeUploadFilename, trySafePath, parseJson, updateKindFromArtifact } from "./lib.js"
import { sqliteBackup } from "./jobs.js"
import { filterPluginTargets } from "./plugin-access.js"
import { appendAudit } from "./audit.js"
import { operatorAuthorized } from "./operator-auth.js"
import { getSettings, parseSettingsPatch, patchSettings } from "./settings.js"
import { enqueueAlert } from "./notify.js"
import { revokeMeshDevice } from "./mesh.js"
import { createOperatorPeerCopy, lanPeersFor } from "./peer-copy.js"
import { isFileTooLargeError, readMultipartFile, writeUploadStream } from "./upload.js"
import { prepareCredentialCommand } from "./vault.js"

function serializeCommand<T extends { type: string; payload: string; result: string | null }>(row: T) {
  const payload = parseJson(row.payload, {})
  const result = parseJson(row.result, null)
  const redacted = redactCredentialCommand(row.type, payload, result)
  return {
    ...row,
    payload: redacted.payload,
    result: redacted.result,
  }
}

function pageLimit(raw: string | undefined, fallback: number, max = 200): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.max(Math.trunc(n), 1), max)
}

function pageCursor(raw: string | undefined): { at: Date; id: string } | undefined {
  if (!raw) return undefined
  const sep = raw.lastIndexOf("::")
  const datePart = sep === -1 ? raw : raw.slice(0, sep)
  const id = sep === -1 ? "" : raw.slice(sep + 2)
  const at = new Date(datePart)
  return Number.isNaN(at.getTime()) ? undefined : { at, id }
}

function encodeCursor(at: Date, id: string): string {
  return `${at.toISOString()}::${id}`
}

function cursorWhere(field: "createdAt" | "timestamp", cursor?: { at: Date; id: string }) {
  if (!cursor) return undefined
  if (!cursor.id) return { [field]: { lt: cursor.at } }
  return {
    OR: [{ [field]: { lt: cursor.at } }, { AND: [{ [field]: cursor.at }, { id: { lt: cursor.id } }] }],
  }
}

const LATEST_SUCCESS_TYPES = [
  "get_services",
  "get_registry",
  "get_adapters",
  "get_ports",
  "get_firewall",
  "get_event_log",
  "get_windows_update",
  "get_admin_center",
  "get_tasks",
  "get_defender",
  "get_bitlocker",
  "get_capabilities",
  "get_smb",
  "get_credentials",
] as const

type LatestSuccessType = (typeof LATEST_SUCCESS_TYPES)[number]

async function latestSuccessfulCommands(deviceId: string) {
  const empty = Object.fromEntries(LATEST_SUCCESS_TYPES.map((type) => [type, null])) as Record<
    LatestSuccessType,
    ReturnType<typeof serializeCommand> | null
  >
  const ids = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM (
      SELECT id,
        ROW_NUMBER() OVER (PARTITION BY type ORDER BY createdAt DESC, id DESC) AS rn
      FROM "Command"
      WHERE deviceId = ${deviceId}
        AND status = 'success'
        AND type IN (${Prisma.join(LATEST_SUCCESS_TYPES)})
    ) ranked
    WHERE rn = 1
  `)
  if (ids.length === 0) return empty
  const rows = await prisma.command.findMany({ where: { id: { in: ids.map((row) => row.id) } } })
  for (const row of rows) {
    if ((LATEST_SUCCESS_TYPES as readonly string[]).includes(row.type)) {
      empty[row.type as LatestSuccessType] = serializeCommand(row)
    }
  }
  return empty
}

function watchingNow(watchUntil: Date | null | undefined): boolean {
  return Boolean(watchUntil && watchUntil.getTime() > Date.now())
}

function clampWatchMinutes(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WATCH_DURATION_MIN
  return Math.min(MAX_WATCH_DURATION_MIN, Math.max(1, Math.floor(n)))
}

async function applyWatchSideEffect(
  deviceId: string,
  type: string,
  payload: Record<string, unknown>
): Promise<void> {
  if (type === "start_watch") {
    const minutes = clampWatchMinutes(payload.durationMin)
    await prisma.device.update({
      where: { id: deviceId },
      data: { watchUntil: new Date(Date.now() + minutes * 60_000) },
    })
  }
  if (type === "stop_watch") {
    await prisma.device.update({
      where: { id: deviceId },
      data: { watchUntil: null },
    })
  }
}

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get(`${API_PREFIX}/admin/meta`, async () => {
    return {
      publicUrl: env.publicUrl,
      iceServers: iceServersForClient(),
      turnConfigured: env.turnConfigured,
      turnHint:
        "WebRTC is peer-to-peer UDP and bypasses Caddy. LAN often works with the default STUN server. Across NATs, run coturn with use-auth-secret and set TURN_URL plus TURN_SECRET (or TURN_CREDENTIAL as that secret). Static TURN passwords are never returned.",
      maxUploadBytes: env.maxUploadBytes,
    }
  })

  app.get(`${API_PREFIX}/admin/overview`, async () => {
    const [devices, online, pendingAlerts, activity, alerts] = await Promise.all([
      prisma.device.count(),
      prisma.device.count({ where: { status: "online" } }),
      prisma.notification.count({ where: { status: "pending" } }),
      prisma.command.findMany({
        orderBy: { createdAt: "desc" },
        take: 15,
        include: { device: true },
      }),
      prisma.notification.findMany({
        where: { channel: "socket" },
        orderBy: { createdAt: "desc" },
        take: 20,
        include: { device: true },
      }),
    ])
    return {
      devices,
      online,
      offline: devices - online,
      pendingAlerts,
      activity: activity.map((c) => ({
        id: c.id,
        type: c.type,
        status: c.status,
        hostname: c.device.hostname,
        deviceId: c.deviceId,
        createdAt: c.createdAt,
      })),
      alerts: alerts.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        body: n.body,
        status: n.status,
        deviceId: n.deviceId,
        hostname: n.device?.hostname ?? null,
        createdAt: n.createdAt,
      })),
    }
  })

  app.get(`${API_PREFIX}/admin/devices`, async (req) => {
    const q = req.query as { search?: string; status?: string }
    const devices = await prisma.device.findMany({
      where: {
        status: q.status ? q.status : undefined,
        OR: q.search
          ? [
              { hostname: { contains: q.search } },
              { ip: { contains: q.search } },
              { id: { contains: q.search } },
            ]
          : undefined,
      },
      orderBy: { lastSeen: "desc" },
    })
    return {
      devices: devices.map((d) => ({
        ...d,
        lanAddrs: parseStoredLanAddrs(d.lanAddrs),
        watching: watchingNow(d.watchUntil),
      })),
    }
  })

  app.get(`${API_PREFIX}/admin/devices/:id`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const device = await prisma.device.findUnique({ where: { id } })
    if (!device) return reply.code(404).send(errorBody("not_found"))
    const [screenshots, commands, files, latestSuccessful, lanPeers] = await Promise.all([
      prisma.screenshot.findMany({ where: { deviceId: id }, orderBy: { createdAt: "desc" }, take: 24 }),
      prisma.command.findMany({ where: { deviceId: id }, orderBy: { createdAt: "desc" }, take: 40 }),
      prisma.fileInfo.findMany({ where: { deviceId: id }, orderBy: { createdAt: "desc" }, take: 40 }),
      latestSuccessfulCommands(id),
      lanPeersFor(device),
    ])
    return {
      device: {
        ...device,
        lanAddrs: parseStoredLanAddrs(device.lanAddrs),
        watching: watchingNow(device.watchUntil),
        enrollmentOpen: !device.enrollmentKeyHash,
      },
      screenshots,
      commands: commands.map((c) => serializeCommand(c)),
      files,
      lanPeers,
      latestSuccessful,
    }
  })

  app.post(`${API_PREFIX}/admin/devices/:id/peer-copy`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const src = await prisma.device.findUnique({ where: { id } })
    if (!src) return reply.code(404).send(errorBody("not_found"))
    const result = await createOperatorPeerCopy(app, src, req.body)
    if (!result.ok) return reply.code(result.status).send(errorBody(result.error, result.details))
    return result
  })

  app.post(`${API_PREFIX}/admin/devices/:id/mesh-forward`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const src = await prisma.device.findUnique({ where: { id }, select: { id: true } })
    if (!src) return reply.code(404).send(errorBody("not_found"))
    const parsed = meshForwardRequestSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send(errorBody("invalid_body", parsed.error.flatten()))
    if (parsed.data.destDeviceId === id) return reply.code(400).send(errorBody("forward_self"))
    const dest = await prisma.device.findUnique({ where: { id: parsed.data.destDeviceId }, select: { id: true } })
    if (!dest) return reply.code(404).send(errorBody("dest_not_found"))
    const settings = await getSettings()
    if (!settings.mesh?.enabled) return reply.code(403).send(errorBody("mesh_disabled"))
    const type = parsed.data.type as CommandType
    if (!meshCommandAllowed(type, settings.mesh.allowCommands)) {
      return reply.code(403).send(errorBody("mesh_command_not_allowed"))
    }
    const checked = validateCommandPayload(type, parsed.data.payload ?? {})
    if (!checked.ok) return reply.code(400).send(errorBody("invalid_payload", checked.error.flatten()))
    const payload = await prepareCredentialCommand(id, type, {
      ...checked.payload,
      [MESH_FORWARD_KEY]: parsed.data.destDeviceId,
    })
    const row = await prisma.command.create({
      data: {
        deviceId: id,
        type,
        payload: JSON.stringify(payload),
        createdBy: "operator",
      },
    })
    await dispatchQueuedCommands(app, id)
    emitFleet(app, WS_EVENTS.COMMAND_QUEUED, {
      id: row.id,
      deviceId: id,
      type,
      status: row.status,
    })
    return { command: serializeCommand(row) }
  })

  app.post(`${API_PREFIX}/admin/devices/:id/reset-enrollment`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const device = await prisma.device.findUnique({ where: { id } })
    if (!device) return reply.code(404).send(errorBody("not_found"))
    disconnectAgent(id)
    revokeMeshDevice(id)
    await prisma.device.update({
      where: { id },
      data: { enrollmentKeyHash: "", status: "offline" },
    })
    return {
      ok: true,
      deviceId: device.id,
      hostname: device.hostname,
      message: "Next enroll without deviceKey will reclaim this device",
    }
  })

  app.delete(`${API_PREFIX}/admin/devices/:id`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const device = await prisma.device.findUnique({
      where: { id },
      include: { screenshots: true, files: true },
    })
    if (!device) return reply.code(404).send(errorBody("not_found"))
    disconnectAgent(id)
    await Promise.all([
      ...device.screenshots.map((shot) => fsp.unlink(shot.path).catch(() => undefined)),
      ...device.files.map((file) => fsp.unlink(file.localPath).catch(() => undefined)),
    ])
    await prisma.device.delete({ where: { id } })
    emitFleet(app, WS_EVENTS.DEVICE_STATUS, { id, deviceId: id, status: "deleted" })
    return { ok: true }
  })

  app.get(`${API_PREFIX}/admin/devices/:id/screenshots`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const q = req.query as { cursor?: string; limit?: string }
    const device = await prisma.device.findUnique({ where: { id }, select: { id: true } })
    if (!device) return reply.code(404).send(errorBody("not_found"))
    const limit = Math.min(Math.max(Number(q.limit) || 24, 1), 100)
    const screenshots = await prisma.screenshot.findMany({
      where: {
        deviceId: id,
        ...cursorWhere("createdAt", pageCursor(q.cursor)),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    })
    const page = screenshots.slice(0, limit)
    const extra = screenshots[limit]
    const last = page[page.length - 1]
    return {
      screenshots: page,
      nextCursor: extra && last ? encodeCursor(last.createdAt, last.id) : null,
    }
  })

  app.post(`${API_PREFIX}/admin/commands`, async (req, reply) => {
    const parsed = createCommandSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send(errorBody("invalid_body", parsed.error.flatten()))
    let deviceIds = parsed.data.deviceIds
    if (deviceIds.length === 1 && deviceIds[0] === "*") {
      const all = await prisma.device.findMany({ select: { id: true } })
      deviceIds = all.map((d) => d.id)
    }
    const type = parsed.data.type as CommandType
    const checked = validateCommandPayload(type, parsed.data.payload ?? {})
    if (!checked.ok) return reply.code(400).send(errorBody("invalid_payload", checked.error.flatten()))
    let payload = checked.payload
    if (parsed.data.forwardTo) {
      if (deviceIds.length !== 1) return reply.code(400).send(errorBody("forward_requires_one_source"))
      const destId = parsed.data.forwardTo
      if (destId === deviceIds[0]) return reply.code(400).send(errorBody("forward_self"))
      const dest = await prisma.device.findUnique({ where: { id: destId }, select: { id: true } })
      if (!dest) return reply.code(404).send(errorBody("dest_not_found"))
      const settings = await getSettings()
      if (!settings.mesh?.enabled) return reply.code(403).send(errorBody("mesh_disabled"))
      if (!meshCommandAllowed(type, settings.mesh.allowCommands)) {
        return reply.code(403).send(errorBody("mesh_command_not_allowed"))
      }
      payload = { ...payload, [MESH_FORWARD_KEY]: destId }
    }
    let skipped: Array<{ deviceId: string; reason: string }> = []
    if (type === "run_plugin") {
      const plug = runPluginPayloadSchema.safeParse(payload)
      if (!plug.success) return reply.code(400).send(errorBody("invalid_plugin_payload", plug.error.flatten()))
      payload = { pluginId: plug.data.pluginId, args: plug.data.args }
      const filtered = await filterPluginTargets(plug.data.pluginId, deviceIds)
      if (!filtered.ok) return reply.code(filtered.status).send(errorBody(filtered.error))
      skipped = filtered.skipped
      deviceIds = filtered.deviceIds
      if (!deviceIds.length) return reply.code(403).send(errorBody("grant_denied", { skipped }))
    }
    const sealed = await Promise.all(
      deviceIds.map(async (deviceId) => ({
        deviceId,
        payload: await prepareCredentialCommand(deviceId, type, { ...payload }),
      }))
    )
    const created = sealed.length
      ? await prisma.$transaction(
          sealed.map((row) =>
            prisma.command.create({
              data: {
                deviceId: row.deviceId,
                type,
                payload: JSON.stringify(row.payload),
                createdBy: "operator",
              },
            })
          )
        )
      : []
    await Promise.all(deviceIds.map((deviceId) => applyWatchSideEffect(deviceId, type, payload)))
    await Promise.all(
      created.map(async (row) => {
        await dispatchQueuedCommands(app, row.deviceId)
        emitFleet(app, WS_EVENTS.COMMAND_QUEUED, {
          id: row.id,
          deviceId: row.deviceId,
          type,
          status: row.status,
        })
      })
    )
    if (type === "start_service" || type === "stop_service" || type === "restart_service" || type === "kill_process") {
      const authed = await operatorAuthorized(req.headers as Record<string, unknown>)
      await appendAudit({
        actor: authed.username || "operator",
        action: type,
        detail: { deviceIds, payload },
      })
    }
    if (type === "kill_switch") {
      await enqueueAlert(app, {
        type: "kill_switch",
        title: "Kill switch queued",
        body: `Devices: ${deviceIds.join(", ")}`,
      })
    }
    return { commands: created.map(serializeCommand), skipped }
  })

  app.post(`${API_PREFIX}/admin/commands/:id/cancel`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const command = await prisma.command.findUnique({ where: { id } })
    if (!command) return reply.code(404).send(errorBody("not_found"))
    if (!isCommandActive(command.status)) {
      return reply.code(409).send(errorBody("not_cancellable", { status: command.status }))
    }
    const updated = await prisma.command.update({
      where: { id },
      data: { status: "cancelled", result: JSON.stringify({ error: "cancelled" }) },
    })
    if (updated.type === "start_watch") {
      await applyWatchSideEffect(updated.deviceId, "stop_watch", {})
    }
    emitFleet(app, WS_EVENTS.COMMAND_RESULT, {
      id: updated.id,
      deviceId: updated.deviceId,
      type: updated.type,
      status: updated.status,
      result: { error: "cancelled" },
    })
    return { command: serializeCommand(updated) }
  })

  app.post(`${API_PREFIX}/admin/commands/:id/retry`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const command = await prisma.command.findUnique({ where: { id } })
    if (!command) return reply.code(404).send(errorBody("not_found"))
    if (command.status !== "failed" && command.status !== "cancelled") {
      return reply.code(409).send(errorBody("not_retryable", { status: command.status }))
    }
    const payload = parseJson<Record<string, unknown>>(command.payload, {})
    const sealed = await prepareCredentialCommand(command.deviceId, command.type, payload)
    const row = await prisma.command.create({
      data: {
        deviceId: command.deviceId,
        type: command.type,
        payload: JSON.stringify(sealed),
        createdBy: "operator",
      },
    })
    await applyWatchSideEffect(row.deviceId, row.type, payload)
    await dispatchQueuedCommands(app, row.deviceId)
    emitFleet(app, WS_EVENTS.COMMAND_QUEUED, {
      id: row.id,
      deviceId: row.deviceId,
      type: row.type,
      status: row.status,
    })
    return { command: serializeCommand(row) }
  })

  app.delete(`${API_PREFIX}/admin/devices/:id/commands`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const device = await prisma.device.findUnique({ where: { id }, select: { id: true } })
    if (!device) return reply.code(404).send(errorBody("not_found"))
    const parsed = deleteDeviceCommandsSchema.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send(errorBody("invalid_body", parsed.error.flatten()))
    const allowed = parsed.data.includeActive
      ? [...COMMAND_TERMINAL_STATUS, ...COMMAND_ACTIVE_STATUS]
      : [...COMMAND_TERMINAL_STATUS]
    const allowedSet = new Set<string>(allowed)
    const skipped: Array<{ id: string; status: string; reason: string }> = []
    if (parsed.data.ids?.length) {
      const rows = await prisma.command.findMany({
        where: { deviceId: id, id: { in: parsed.data.ids } },
        select: { id: true, status: true },
      })
      const found = new Map(rows.map((row) => [row.id, row.status]))
      for (const commandId of parsed.data.ids) {
        const status = found.get(commandId)
        if (!status) {
          skipped.push({ id: commandId, status: "", reason: "not_found" })
          continue
        }
        if (!allowedSet.has(status)) {
          skipped.push({ id: commandId, status, reason: "not_terminal" })
        }
      }
    }
    const result = await prisma.command.deleteMany({
      where: parsed.data.all
        ? { deviceId: id, status: { in: allowed } }
        : { deviceId: id, id: { in: parsed.data.ids }, status: { in: allowed } },
    })
    return { deleted: result.count, skipped }
  })

  app.get(`${API_PREFIX}/admin/commands`, async (req) => {
    const q = req.query as { deviceId?: string; status?: string; cursor?: string; limit?: string }
    const limit = pageLimit(q.limit, 50)
    const cursor = pageCursor(q.cursor)
    const commands = await prisma.command.findMany({
      where: {
        deviceId: q.deviceId,
        status: q.status,
        ...cursorWhere("createdAt", cursor),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      include: { device: true },
    })
    const page = commands.slice(0, limit)
    const extra = commands[limit]
    const last = page[page.length - 1]
    return {
      commands: page.map((c) => ({
        ...serializeCommand(c),
        hostname: c.device.hostname,
      })),
      nextCursor: extra && last ? encodeCursor(last.createdAt, last.id) : null,
    }
  })

  app.get(`${API_PREFIX}/admin/commands/:id`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const command = await prisma.command.findUnique({ where: { id }, include: { device: true } })
    if (!command) return reply.code(404).send(errorBody("not_found"))
    return {
      command: {
        ...serializeCommand(command),
        hostname: command.device.hostname,
      },
    }
  })

  app.get(`${API_PREFIX}/admin/command-templates`, async () => {
    const rows = await prisma.commandTemplate.findMany({ orderBy: { createdAt: "desc" } })
    return {
      templates: rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        type: row.type,
        payload: parseJson(row.payloadJson, {}),
        createdAt: row.createdAt,
      })),
    }
  })

  app.post(`${API_PREFIX}/admin/command-templates`, async (req, reply) => {
    const parsed = commandTemplateWriteSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send(errorBody("invalid_body", parsed.error.flatten()))
    const type = parsed.data.type as CommandType
    const checked = validateCommandPayload(type, parsed.data.payload ?? {})
    if (!checked.ok) return reply.code(400).send(errorBody("invalid_payload", checked.error.flatten()))
    const row = await prisma.commandTemplate.create({
      data: {
        name: parsed.data.name,
        description: parsed.data.description,
        type,
        payloadJson: JSON.stringify(checked.payload),
      },
    })
    return {
      template: {
        id: row.id,
        name: row.name,
        description: row.description,
        type: row.type,
        payload: checked.payload,
        createdAt: row.createdAt,
      },
    }
  })

  app.delete(`${API_PREFIX}/admin/command-templates/:id`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const row = await prisma.commandTemplate.findUnique({ where: { id } })
    if (!row) return reply.code(404).send(errorBody("not_found"))
    await prisma.commandTemplate.delete({ where: { id } })
    return { ok: true }
  })

  app.get(`${API_PREFIX}/admin/logs`, async (req) => {
    const q = req.query as { deviceId?: string; level?: string; search?: string; cursor?: string; limit?: string }
    const limit = pageLimit(q.limit, 50)
    const cursor = pageCursor(q.cursor)
    const logs = await prisma.log.findMany({
      where: {
        deviceId: q.deviceId,
        level: q.level,
        message: q.search ? { contains: q.search } : undefined,
        ...cursorWhere("timestamp", cursor),
      },
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
      take: limit + 1,
      include: { device: true },
    })
    const page = logs.slice(0, limit)
    const extra = logs[limit]
    const last = page[page.length - 1]
    return {
      logs: page.map((l) => ({ ...l, hostname: l.device.hostname })),
      nextCursor: extra && last ? encodeCursor(last.timestamp, last.id) : null,
    }
  })

  app.get(`${API_PREFIX}/admin/screenshots/:id/file`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const shot = await prisma.screenshot.findUnique({ where: { id } })
    if (!shot || !(await pathExists(shot.path))) return reply.code(404).send(errorBody("not_found"))
    reply.header("content-type", "image/jpeg")
    return reply.send(fs.createReadStream(shot.path))
  })

  app.delete(`${API_PREFIX}/admin/screenshots/:id`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const shot = await prisma.screenshot.findUnique({ where: { id } })
    if (!shot) return reply.code(404).send(errorBody("not_found"))
    await fsp.unlink(shot.path).catch(() => undefined)
    await prisma.screenshot.delete({ where: { id } })
    return { ok: true }
  })

  app.get(`${API_PREFIX}/admin/files/:id/download`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const row = await prisma.fileInfo.findUnique({ where: { id } })
    if (!row || !(await pathExists(row.localPath))) return reply.code(404).send(errorBody("not_found"))
    reply.header("content-type", "application/octet-stream")
    reply.header("content-disposition", `attachment; filename="${path.basename(row.remotePath || row.localPath)}"`)
    return reply.send(fs.createReadStream(row.localPath))
  })

  app.post(`${API_PREFIX}/admin/devices/:id/files`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const device = await prisma.device.findUnique({ where: { id } })
    if (!device) return reply.code(404).send(errorBody("not_found"))
    const taken = await readMultipartFile(() => req.file())
    if (!taken.ok) return reply.code(400).send(errorBody("file_too_large"))
    const file = taken.file
    if (!file) return reply.code(400).send(errorBody("file_required"))
    const destDir = dataPath("staged", id)
    await fsp.mkdir(destDir, { recursive: true })
    const dest = path.join(destDir, `${randomToken(8)}-${safeUploadFilename(file.filename)}`)
    let size = 0
    try {
      size = await writeUploadStream(file.file, dest, { maxBytes: env.maxUploadBytes })
    } catch (error) {
      if (isFileTooLargeError(error)) {
        return reply.code(400).send(errorBody("file_too_large"))
      }
      throw error
    }
    const destPath = trySafePath(multipartValue(file.fields as never, "dest")) ?? safeUploadFilename(file.filename)
    const row = await prisma.fileInfo.create({
      data: {
        deviceId: id,
        direction: "download",
        localPath: dest,
        remotePath: destPath || file.filename,
        size,
        offset: 0,
        status: "staged",
      },
    })
    return { file: row }
  })

  app.get(`${API_PREFIX}/admin/settings`, async () => {
    return { settings: redactSettings(await getSettings()) }
  })

  app.put(`${API_PREFIX}/admin/settings`, async (req, reply) => {
    try {
      const patch = parseSettingsPatch(req.body)
      const next = await patchSettings(patch)
      const authed = await operatorAuthorized(req.headers as Record<string, unknown>)
      await appendAudit({
        actor: authed.username || "operator",
        action: "settings_update",
        detail: { sections: Object.keys(patch) },
      })
      return { settings: redactSettings(next) }
    } catch (error) {
      if (error && typeof error === "object" && "issues" in error) {
        return reply.code(400).send(errorBody("invalid_body", error))
      }
      throw error
    }
  })

  app.get(`${API_PREFIX}/admin/updates`, async () => {
    const updates = await prisma.agentUpdate.findMany({ orderBy: { createdAt: "desc" } })
    return { updates }
  })

  app.post(`${API_PREFIX}/admin/updates`, async (req, reply) => {
    const taken = await readMultipartFile(() => req.file())
    if (!taken.ok) return reply.code(400).send(errorBody("file_too_large"))
    const file = taken.file
    if (!file) return reply.code(400).send(errorBody("file_required"))
    const version = multipartValue(file.fields as never, "version")
    const platform = multipartValue(file.fields as never, "platform")
    const arch = multipartValue(file.fields as never, "arch")
    const notes = multipartValue(file.fields as never, "notes")
    if (!version || !platform || !arch) return reply.code(400).send(errorBody("missing_meta"))
    const destDir = dataPath("updates")
    await fsp.mkdir(destDir, { recursive: true })
    const dest = path.join(
      destDir,
      `${safeUploadFilename(platform)}-${safeUploadFilename(arch)}-${safeUploadFilename(version)}-${safeUploadFilename(file.filename)}`
    )
    if (!dest.startsWith(destDir)) return reply.code(400).send(errorBody("invalid_path"))
    const hash = createHash("sha256")
    let size = 0
    try {
      size = await writeUploadStream(file.file, dest, {
        maxBytes: env.maxUpdateBytes,
        onChunk: (buf) => {
          hash.update(buf)
        },
      })
    } catch (error) {
      if (isFileTooLargeError(error)) {
        return reply.code(400).send(errorBody("file_too_large"))
      }
      throw error
    }
    const checksum = hash.digest("hex")
    const kind = updateKindFromArtifact(dest, notes)
    const existing = await prisma.agentUpdate.findUnique({
      where: { kind_version_platform_arch: { kind, version, platform, arch } },
    })
    if (existing && existing.path !== dest) {
      await fsp.unlink(existing.path).catch(() => undefined)
    }
    const row = await prisma.agentUpdate.upsert({
      where: { kind_version_platform_arch: { kind, version, platform, arch } },
      create: { kind, version, platform, arch, notes, checksum, path: dest, size },
      update: { notes, checksum, path: dest, size },
    })
    return { update: row }
  })

  app.get(`${API_PREFIX}/admin/security`, async () => {
    return {
      rateLimitPerMinute: env.rateLimitPerMinute,
      ipAllowlist: env.ipAllowlist,
    }
  })

  app.post(`${API_PREFIX}/admin/backup`, async () => {
    const dest = await sqliteBackup()
    return { dest }
  })

  app.post(`${API_PREFIX}/admin/devices/:id/e2e/session`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = e2eSessionRequestSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send(errorBody("invalid_body", parsed.error.flatten()))
    const device = await prisma.device.findUnique({ where: { id } })
    if (!device) return reply.code(404).send(errorBody("not_found"))
    if (!isAgentWsConnected(id)) return reply.code(503).send(errorBody("agent_offline"))
    const sessionId = randomToken(16)
    const operatorPub = parsed.data.operatorPub.toLowerCase()
    const wait = beginE2ESession(id, operatorPub, sessionId)
    const sent = sendToAgent(id, {
      type: "e2e_envelope",
      payload: { action: "offer", sessionId, operatorPub },
    })
    if (!sent) {
      closeE2ESession(id)
      return reply.code(503).send(errorBody("agent_offline"))
    }
    try {
      const agentPub = await wait
      return { sessionId, agentPub, e2ePub: device.e2ePub }
    } catch {
      closeE2ESession(id)
      return reply.code(504).send(errorBody("e2e_timeout"))
    }
  })

  app.get(`${API_PREFIX}/admin/devices/:id/e2e/session`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const device = await prisma.device.findUnique({ where: { id } })
    if (!device) return reply.code(404).send(errorBody("not_found"))
    const session = e2eSessionFor(id)
    const webrtc = webrtcMetaFor(id)
    return {
      active: Boolean(session?.agentPub),
      sessionId: session?.sessionId ?? null,
      e2ePub: device.e2ePub,
      webrtc: webrtc
        ? { active: true, lastKind: webrtc.lastKind ?? null, updatedAt: webrtc.updatedAt }
        : { active: false, lastKind: null, updatedAt: null },
    }
  })

  app.delete(`${API_PREFIX}/admin/devices/:id/e2e/session`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const session = closeE2ESession(id)
    if (session) {
      sendToAgent(id, {
        type: "e2e_envelope",
        payload: { action: "close", sessionId: session.sessionId },
      })
    }
    return { ok: true }
  })
}
