import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { prisma, type Device } from "@workspace/db"
import {
  API_PREFIX,
  agentLogSchema,
  commandResultSchema,
  heartbeatSchema,
  registerSchema,
  WS_EVENTS,
} from "@workspace/shared"

import { isAgentWsConnected } from "./agent-ws.js"
import { claimPendingCommands, ingestCommandResult, ingestHeartbeat, revertCommandToPending } from "./agent-ingest.js"
import { hydrateCommandPayload } from "./vault.js"
import { COMMAND_POLL_MS, waitForDeviceCommands } from "./command-waiters.js"
import { deviceFromHeaders } from "./device-auth.js"
import { env, dataPath } from "./env.js"
import { normalizeMetrics, storeMetrics } from "./metrics.js"
import { getTransfer, initUploadTransfer } from "./file-transfer.js"
import { emitFleet } from "./io-emit.js"
import {
  clientIp,
  deviceKeyMatches,
  errorBody,
  hashDeviceKey,
  ipAllowed,
  multipartValue,
  pathExists,
  randomToken,
  safeEqual,
  signUpdateToken,
  trySafePath,
  verifyUpdateToken,
  parseJson,
} from "./lib.js"
import { decideEnroll } from "./enroll.js"
import { issueMeshBundle } from "./mesh.js"
import { issueWsChallenge } from "./ws-challenge.js"
import { enqueueAlert } from "./notify.js"
import { afterPeerCommandIngest } from "./peer-copy.js"
import { pluginGrantedToDevice } from "./plugin-access.js"
import { ingestScreenshotBytes } from "./screenshot-ingest.js"
import { isFileTooLargeError, writeUploadStream } from "./upload.js"

async function requireDevice(req: FastifyRequest, reply: FastifyReply): Promise<Device | null> {
  if (!ipAllowed(clientIp(req.headers as Record<string, unknown>, req.ip), env.ipAllowlist)) {
    reply.code(403).send(errorBody("ip_not_allowed"))
    return null
  }
  const device = await deviceFromHeaders(req)
  if (!device) {
    reply.code(401).send(errorBody("unauthorized"))
    return null
  }
  return device
}

export async function registerAgentRoutes(app: FastifyInstance): Promise<void> {
  app.post(`${API_PREFIX}/agent/register`, async (req, reply) => {
    const parsed = registerSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send(errorBody("invalid_body", parsed.error.flatten()))
    if (!safeEqual(parsed.data.enrollmentSecret, env.enrollmentSecret)) {
      return reply.code(403).send(errorBody("invalid_enrollment_secret"))
    }
    const identity = {
      hostname: parsed.data.hostname,
      platform: parsed.data.platform,
      arch: parsed.data.arch,
      agentVersion: parsed.data.agentVersion,
      ip: parsed.data.ip,
      mac: parsed.data.mac,
      status: "online" as const,
      lastSeen: new Date(),
      ...(parsed.data.e2ePub ? { e2ePub: parsed.data.e2ePub.toLowerCase() } : {}),
    }
    const existingById = await prisma.device.findUnique({ where: { id: parsed.data.deviceId } })
    const existingByHost = await prisma.device.findFirst({
      where: { hostname: parsed.data.hostname, platform: parsed.data.platform },
      orderBy: { lastSeen: "desc" },
    })
    const decision = decideEnroll({
      deviceKey: parsed.data.deviceKey,
      byId: existingById
        ? {
            id: existingById.id,
            hostname: existingById.hostname,
            platform: existingById.platform,
            enrollmentKeyHash: existingById.enrollmentKeyHash,
          }
        : null,
      byHost: existingByHost
        ? {
            id: existingByHost.id,
            hostname: existingByHost.hostname,
            platform: existingByHost.platform,
            enrollmentKeyHash: existingByHost.enrollmentKeyHash,
          }
        : null,
      keyMatches: deviceKeyMatches,
    })
    if (decision.action === "forbidden") {
      return reply.code(403).send(errorBody("device_key_required"))
    }
    if (decision.action === "conflict") {
      return reply.code(409).send({
        error: "device_exists",
        deviceId: decision.deviceId,
        hostname: decision.hostname,
        details: { deviceId: decision.deviceId, hostname: decision.hostname },
      })
    }
    if (decision.action === "update") {
      let deviceKey: string | undefined
      const data = { ...identity }
      if (decision.mintKey) {
        deviceKey = randomToken(32)
        Object.assign(data, { enrollmentKeyHash: hashDeviceKey(deviceKey) })
      }
      const device = await prisma.device.update({
        where: { id: decision.deviceId },
        data,
      })
      emitFleet(app, WS_EVENTS.DEVICE_STATUS, { id: device.id, status: "online", hostname: device.hostname })
      const mesh = issueMeshBundle(device.id)
      return deviceKey ? { deviceId: device.id, deviceKey, mesh } : { deviceId: device.id, mesh }
    }
    const deviceKey = randomToken(32)
    const device = await prisma.device.create({
      data: {
        id: parsed.data.deviceId,
        ...identity,
        enrollmentKeyHash: hashDeviceKey(deviceKey),
      },
    })
    emitFleet(app, WS_EVENTS.DEVICE_STATUS, { id: device.id, status: "online", hostname: device.hostname })
    await enqueueAlert(app, {
      type: "device_online",
      deviceId: device.id,
      title: `${device.hostname} enrolled`,
      body: `${device.platform}/${device.arch} ${device.agentVersion}`,
    })
    return { deviceId: device.id, deviceKey, mesh: issueMeshBundle(device.id) }
  })

  app.post(`${API_PREFIX}/agent/ws-challenge`, async (req, reply) => {
    const device = await requireDevice(req, reply)
    if (!device) return
    return issueWsChallenge(device.id)
  })

  app.post(`${API_PREFIX}/agent/heartbeat`, async (req, reply) => {
    const device = await requireDevice(req, reply)
    if (!device) return
    const parsed = heartbeatSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send(errorBody("invalid_body", parsed.error.flatten()))
    const ack = await ingestHeartbeat(
      app,
      device,
      parsed.data,
      clientIp(req.headers as Record<string, unknown>, req.ip)
    )
    return { ok: true, serverTime: ack.serverTime, watch: ack.watch, agentConfig: ack.agentConfig }
  })

  app.get(`${API_PREFIX}/agent/commands`, async (req, reply) => {
    const device = await requireDevice(req, reply)
    if (!device) return
    if (isAgentWsConnected(device.id)) {
      return { commands: [] }
    }
    const waitSec = Math.min(Number((req.query as { wait?: string }).wait ?? 0) || 0, 25)
    const deadline = Date.now() + waitSec * 1000
    const abort = new AbortController()
    const onClose = () => abort.abort()
    req.raw.on("close", onClose)
    let commands = await claimPendingCommands(device.id)
    try {
      while (commands.length === 0 && Date.now() < deadline && !abort.signal.aborted) {
        if (isAgentWsConnected(device.id)) break
        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        await waitForDeviceCommands(device.id, Math.min(COMMAND_POLL_MS, remaining), abort.signal)
        if (abort.signal.aborted || isAgentWsConnected(device.id)) break
        commands = await claimPendingCommands(device.id)
      }
      if (abort.signal.aborted && commands.length) {
        await Promise.all(commands.map((cmd) => revertCommandToPending(cmd.id)))
        return { commands: [] }
      }
    } finally {
      req.raw.off("close", onClose)
    }
    return {
      commands: commands.map((c) => ({
        id: c.id,
        type: c.type,
        payload: hydrateCommandPayload(c.type, parseJson(c.payload, {})),
        createdAt: c.createdAt,
      })),
    }
  })

  app.post(`${API_PREFIX}/agent/command-result`, async (req, reply) => {
    const device = await requireDevice(req, reply)
    if (!device) return
    const parsed = commandResultSchema.safeParse(req.body)
    if (!parsed.success) {
      app.log.warn(
        { deviceId: device.id, issues: parsed.error.flatten() },
        "invalid command_result body"
      )
      return reply.code(400).send(errorBody("invalid_body", parsed.error.flatten()))
    }
    const result = await ingestCommandResult(app, device, parsed.data)
    if (!result.ok) return reply.code(404).send(errorBody("not_found"))
    await afterPeerCommandIngest(app, device, parsed.data)
    return result
  })

  app.post(`${API_PREFIX}/agent/metrics`, async (req, reply) => {
    const device = await requireDevice(req, reply)
    if (!device) return
    const samples = normalizeMetrics(req.body)
    if (!samples) return reply.code(400).send(errorBody("invalid_body"))
    const stored = await storeMetrics(device.id, samples)
    return { ok: true, stored }
  })

  app.post(`${API_PREFIX}/agent/logs`, async (req, reply) => {
    const device = await requireDevice(req, reply)
    if (!device) return
    const parsed = agentLogSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send(errorBody("invalid_body", parsed.error.flatten()))
    await prisma.log.createMany({
      data: parsed.data.entries.map((entry) => ({
        deviceId: device.id,
        level: entry.level,
        source: entry.source,
        message: entry.message,
        timestamp: entry.timestamp ? new Date(entry.timestamp) : new Date(),
      })),
    })
    return { ok: true }
  })

  app.post(`${API_PREFIX}/agent/screenshot`, async (req, reply) => {
    const device = await requireDevice(req, reply)
    if (!device) return
    let file
    try {
      file = await req.file()
    } catch (error) {
      if (isFileTooLargeError(error)) {
        return reply.code(400).send(errorBody("too_large"))
      }
      throw error
    }
    if (!file) return reply.code(400).send(errorBody("file_required"))
    const chunks: Buffer[] = []
    let size = 0
    try {
      for await (const part of file.file) {
        const buf = Buffer.isBuffer(part) ? part : Buffer.from(part as Uint8Array)
        size += buf.length
        if (size > env.maxScreenshotBytes) {
          return reply.code(400).send(errorBody("too_large"))
        }
        chunks.push(buf)
      }
    } catch (error) {
      if (isFileTooLargeError(error)) {
        return reply.code(400).send(errorBody("too_large"))
      }
      throw error
    }
    const result = await ingestScreenshotBytes(app, device, Buffer.concat(chunks))
    if ("error" in result) return reply.code(400).send(errorBody("too_large"))
    if ("skipped" in result) return { skipped: "e2e" }
    return { id: result.id, size: result.size }
  })

  app.post(`${API_PREFIX}/agent/files`, async (req, reply) => {
    const device = await requireDevice(req, reply)
    if (!device) return
    let file
    try {
      file = await req.file()
    } catch (error) {
      if (isFileTooLargeError(error)) {
        return reply.code(400).send(errorBody("too_large"))
      }
      throw error
    }
    if (!file) return reply.code(400).send(errorBody("file_required"))
    const remotePath = trySafePath(multipartValue(file.fields as never, "remotePath") || file.filename)
    if (!remotePath) return reply.code(400).send(errorBody("path_denied"))
    const destDir = dataPath("files", device.id)
    await fsp.mkdir(destDir, { recursive: true })
    const id = randomToken(16)
    const dest = path.join(destDir, `${id}-${path.basename(remotePath)}`)
    let size = 0
    try {
      size = await writeUploadStream(file.file, dest, { maxBytes: env.maxUploadBytes })
    } catch (error) {
      if (isFileTooLargeError(error)) {
        return reply.code(400).send(errorBody("too_large"))
      }
      throw error
    }
    const row = await prisma.fileInfo.create({
      data: {
        deviceId: device.id,
        direction: "upload",
        localPath: dest,
        remotePath,
        size,
        offset: size,
        status: "complete",
      },
    })
    return { id: row.id, size }
  })

  app.post(`${API_PREFIX}/agent/files/transfers`, async (req, reply) => {
    const device = await requireDevice(req, reply)
    if (!device) return
    const body = (req.body ?? {}) as { remotePath?: unknown; size?: unknown }
    const remotePath =
      typeof body.remotePath === "string" ? trySafePath(body.remotePath) : ""
    if (typeof body.remotePath === "string" && !remotePath) {
      return reply.code(400).send(errorBody("path_denied"))
    }
    const size = typeof body.size === "number" ? body.size : Number(body.size)
    if (!remotePath) return reply.code(400).send(errorBody("remote_path_required"))
    try {
      const row = await initUploadTransfer(device.id, remotePath, size)
      return { id: row.id, offset: row.offset, size: row.size, status: row.status }
    } catch (error) {
      if (error instanceof Error && error.message === "too_large") {
        return reply.code(400).send(errorBody("too_large"))
      }
      throw error
    }
  })

  app.get(`${API_PREFIX}/agent/files/transfers/:id`, async (req, reply) => {
    const device = await requireDevice(req, reply)
    if (!device) return
    const { id } = req.params as { id: string }
    const row = await getTransfer(device.id, id)
    if (!row) return reply.code(404).send(errorBody("not_found"))
    return { id: row.id, offset: row.offset, size: row.size, status: row.status, direction: row.direction }
  })

  app.get(`${API_PREFIX}/agent/files`, async (req, reply) => {
    const device = await requireDevice(req, reply)
    if (!device) return
    const q = req.query as { id?: string; offset?: string }
    const id = q.id
    if (!id) return reply.code(400).send(errorBody("id_required"))
    const row = await prisma.fileInfo.findFirst({ where: { id, deviceId: device.id, direction: "download" } })
    if (!row || !(await pathExists(row.localPath))) return reply.code(404).send(errorBody("not_found"))
    const offset = Math.max(0, Number(q.offset) || 0)
    if (offset > row.size) return reply.code(400).send(errorBody("offset_mismatch"))
    return reply.send(fs.createReadStream(row.localPath, { start: offset }))
  })

  app.get(`${API_PREFIX}/agent/update`, async (req, reply) => {
    const device = await requireDevice(req, reply)
    if (!device) return
    const latest = await prisma.agentUpdate.findFirst({
      where: { platform: device.platform, arch: device.arch, kind: "agent" },
      orderBy: { createdAt: "desc" },
    })
    if (!latest) return { update: null }
    const exp = Math.floor(Date.now() / 1000) + 600
    const sig = signUpdateToken(latest.id, exp)
    return {
      update: {
        id: latest.id,
        version: latest.version,
        notes: latest.notes,
        checksum: latest.checksum,
        size: latest.size,
        url: `${env.publicUrl}${API_PREFIX}/agent/download-update?id=${latest.id}&exp=${exp}&sig=${sig}`,
      },
    }
  })

  app.get(`${API_PREFIX}/agent/download-update`, async (req, reply) => {
    const query = req.query as { id?: string; exp?: string; sig?: string }
    if (!query.id || !query.exp || !query.sig) return reply.code(400).send(errorBody("missing_params"))
    if (!verifyUpdateToken(query.id, Number(query.exp), query.sig)) {
      return reply.code(403).send(errorBody("invalid_signature"))
    }
    const update = await prisma.agentUpdate.findUnique({ where: { id: query.id } })
    if (!update || !(await pathExists(update.path))) return reply.code(404).send(errorBody("not_found"))
    reply.header("content-type", "application/octet-stream")
    reply.header("content-disposition", `attachment; filename="${path.basename(update.path)}"`)
    return reply.send(fs.createReadStream(update.path))
  })

  app.get(`${API_PREFIX}/agent/plugins/:id`, async (req, reply) => {
    const device = await requireDevice(req, reply)
    if (!device) return
    const { id } = req.params as { id: string }
    const plugin = await prisma.plugin.findUnique({ where: { id } })
    if (!plugin) return reply.code(404).send(errorBody("not_found"))
    if (!(await pluginGrantedToDevice(plugin.id, device.id))) {
      return reply.code(403).send(errorBody("grant_denied"))
    }
    if (plugin.platform && plugin.platform !== device.platform) {
      return reply.code(409).send(errorBody("platform_mismatch"))
    }
    if (plugin.arch && plugin.arch !== device.arch) {
      return reply.code(409).send(errorBody("arch_mismatch"))
    }
    let size = 0
    try {
      size = (await fsp.stat(plugin.path)).size
    } catch {
      return reply.code(404).send(errorBody("not_found"))
    }
    return {
      plugin: {
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        runtime: plugin.runtime,
        platform: plugin.platform,
        arch: plugin.arch,
        sha256: plugin.sha256,
        timeoutSec: plugin.timeoutSec,
        networkAllowed: plugin.networkAllowed,
        size,
      },
    }
  })

  app.get(`${API_PREFIX}/agent/plugins/:id/blob`, async (req, reply) => {
    const device = await requireDevice(req, reply)
    if (!device) return
    const { id } = req.params as { id: string }
    const plugin = await prisma.plugin.findUnique({ where: { id } })
    if (!plugin || !(await pathExists(plugin.path))) return reply.code(404).send(errorBody("not_found"))
    if (!(await pluginGrantedToDevice(plugin.id, device.id))) {
      return reply.code(403).send(errorBody("grant_denied"))
    }
    if (plugin.platform && plugin.platform !== device.platform) {
      return reply.code(409).send(errorBody("platform_mismatch"))
    }
    if (plugin.arch && plugin.arch !== device.arch) {
      return reply.code(409).send(errorBody("arch_mismatch"))
    }
    reply.header("content-type", "application/octet-stream")
    reply.header("content-disposition", `attachment; filename="${plugin.id}"`)
    return reply.send(fs.createReadStream(plugin.path))
  })
}
