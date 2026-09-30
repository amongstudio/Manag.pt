import { EventEmitter } from "node:events"

import websocket from "@fastify/websocket"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { WebSocket } from "ws"
import { prisma, type Device } from "@workspace/db"
import {
  AGENT_WS_BIN_TYPE,
  AGENT_WS_HELLO_TIMEOUT_MS,
  AGENT_WS_NONCE_QUERY,
  AGENT_WS_PATH,
  AGENT_WS_PING_INTERVAL_MS,
  AGENT_WS_PROTOCOL_VERSION,
  AGENT_WS_STALE_MS,
  AGENT_WS_TYPE,
  WS_EVENTS,
  agentWsNonceSchema,
  commandAckSchema,
  commandResultFrameSchema,
  decodeAgentWsBinary,
  e2eBinHeaderSchema,
  e2eEnvelopeFrameSchema,
  encodeAgentWsBinary,
  fileChunkHeaderSchema,
  heartbeatFrameSchema,
  helloSchema,
  pingSchema,
  pongSchema,
  SHELL_DATA_MAX_CHARS,
  shellCloseFrameSchema,
  shellDataFrameSchema,
  shellExecFrameSchema,
  shellOpenFrameSchema,
  shellResizeFrameSchema,
  webrtcSignalFrameSchema,
  meshSignalFrameSchema,
  meshRelayFrameSchema,
  meshRelayResultFrameSchema,
  type Command as AgentWsCommand,
  type FileChunk,
} from "@workspace/shared"

import { agentConfigPayload, claimPendingCommands, ingestCommandResult, ingestHeartbeat, lanDiscoveryData, markDeviceWsOffline, revertCommandToPending, touchDeviceOnline, watchPayload } from "./agent-ingest.js"
import { hydrateCommandPayload } from "./vault.js"
import { notifyCommandsQueued } from "./command-waiters.js"
import { deviceFromHeaders } from "./device-auth.js"
import { acceptE2EAnswer, closeE2ESession, envelopeForOperator, matchesE2ESession } from "./e2e-relay.js"
import { ingestUploadChunk, readDownloadChunk } from "./file-transfer.js"
import { emitDevice } from "./io-emit.js"
import { clientIp, hmacSha256Hex, safeEqual } from "./lib.js"
import { normalizeMetrics, storeMetrics } from "./metrics.js"
import { afterPeerCommandIngest } from "./peer-copy.js"
import { dropWebrtcSession, touchWebrtcSession } from "./remote-session.js"
import { releaseWebrtcSession, webrtcSessionFor } from "./webrtc-relay.js"
import { ingestScreenshotBytes } from "./screenshot-ingest.js"
import { closeShellSession } from "./shell-relay.js"
import { consumeWsChallenge } from "./ws-challenge.js"
import { zstdDecodeAvailable } from "./zstd.js"
import { issueMeshBundle, meshSessionExtras } from "./mesh.js"

type AgentConn = {
  socket: WebSocket
  device: Device
  unacked: Set<string>
}

const agents = new Map<string, AgentConn>()

function enrollmentKey(req: FastifyRequest): string | null {
  const key = req.headers["x-enrollment-key"]
  return typeof key === "string" ? key : null
}

function queryNonce(req: FastifyRequest): string | null {
  const raw = (req.query as Record<string, unknown>)[AGENT_WS_NONCE_QUERY]
  if (typeof raw !== "string") return null
  const parsed = agentWsNonceSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

function sendJson(socket: WebSocket, frame: unknown): boolean {
  if (socket.readyState !== socket.OPEN) return false
  try {
    socket.send(JSON.stringify(frame))
    return true
  } catch {
    return false
  }
}

export function isAgentWsConnected(deviceId: string): boolean {
  const conn = agents.get(deviceId)
  return Boolean(conn && conn.socket.readyState === conn.socket.OPEN)
}

export function disconnectAgent(deviceId: string): void {
  const conn = agents.get(deviceId)
  if (conn) {
    try {
      conn.socket.close(1000, "device_deleted")
    } catch {
      /* already closing */
    }
    dropConn(deviceId, conn.socket, undefined)
    return
  }
  closeE2ESession(deviceId)
}

export function sendToAgent(deviceId: string, frame: unknown): boolean {
  const conn = agents.get(deviceId)
  if (!conn) return false
  return sendJson(conn.socket, frame)
}

export function sendToAgentBinary(deviceId: string, data: Uint8Array): boolean {
  const conn = agents.get(deviceId)
  if (!conn || conn.socket.readyState !== conn.socket.OPEN) return false
  try {
    conn.socket.send(data)
    return true
  } catch {
    return false
  }
}

function dropConn(deviceId: string, socket: WebSocket, app?: FastifyInstance): void {
  const current = agents.get(deviceId)
  if (current && current.socket === socket) {
    agents.delete(deviceId)
    const ids = [...current.unacked]
    current.unacked.clear()
    void Promise.all(ids.map((id) => revertCommandToPending(id))).catch((error) => {
      console.error("revert unacked commands", error)
    })
    closeE2ESession(deviceId)
    const shell = closeShellSession(deviceId)
    if (shell && app) {
      emitDevice(app, deviceId, WS_EVENTS.SHELL_CLOSE, { deviceId, reason: "agent_disconnect" })
    }
    const hostname = current.device.hostname
    void markDeviceWsOffline(app, deviceId, hostname, () => isAgentWsConnected(deviceId)).catch((error) => {
      console.error("mark agent-ws offline", error)
    })
  }
}

function parsePayload(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return {}
  }
}

function commandFrame(row: {
  id: string
  type: string
  payload: string
  createdAt: Date
}): AgentWsCommand {
  return {
    type: AGENT_WS_TYPE.command,
    id: row.id,
    cmdType: row.type,
    payload: hydrateCommandPayload(row.type, parsePayload(row.payload)),
    createdAt: row.createdAt.toISOString(),
  }
}

async function pushPendingCommands(app: FastifyInstance, deviceId: string): Promise<boolean> {
  while (isAgentWsConnected(deviceId)) {
    const batch = await claimPendingCommands(deviceId)
    if (batch.length === 0) return true
    const conn = agents.get(deviceId)
    if (!conn || conn.socket.readyState !== conn.socket.OPEN) {
      for (const cmd of batch) await revertCommandToPending(cmd.id)
      return false
    }
    for (let i = 0; i < batch.length; i++) {
      const cmd = batch[i]!
      if (!sendJson(conn.socket, commandFrame(cmd))) {
        for (let j = i; j < batch.length; j++) {
          await revertCommandToPending(batch[j]!.id)
          conn.unacked.delete(batch[j]!.id)
        }
        return false
      }
      conn.unacked.add(cmd.id)
    }
    if (batch.length < 20) return true
  }
  return false
}

/** Push over /agent-ws when connected; otherwise wake HTTP long-poll waiters. */
export async function dispatchQueuedCommands(app: FastifyInstance, deviceId: string): Promise<void> {
  if (!isAgentWsConnected(deviceId)) {
    notifyCommandsQueued(deviceId)
    return
  }
  const pushed = await pushPendingCommands(app, deviceId)
  if (!pushed) notifyCommandsQueued(deviceId)
}

function messageText(raw: unknown): string {
  if (typeof raw === "string") return raw
  if (Buffer.isBuffer(raw)) return raw.toString("utf8")
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8")
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8")
  return String(raw)
}

function messageBytes(raw: unknown): Uint8Array {
  if (typeof raw === "string") return Buffer.from(raw)
  if (Buffer.isBuffer(raw)) return raw
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw)
  if (Array.isArray(raw)) return Buffer.concat(raw)
  return Buffer.from(String(raw))
}

function agentCaps() {
  return { zstd: zstdDecodeAvailable(), webrtc: true, e2e: true }
}

async function handleFileChunkText(
  app: FastifyInstance,
  socket: WebSocket,
  device: Device,
  parsed: unknown
): Promise<void> {
  const header = fileChunkHeaderSchema.safeParse(parsed)
  if (!header.success) return
  const chunk = header.data as FileChunk
  if (chunk.action === "request") {
    const result = await readDownloadChunk(app, device.id, chunk)
    if ("error" in result) {
      sendJson(socket, result.error)
      return
    }
    sendToAgentBinary(device.id, encodeAgentWsBinary(AGENT_WS_BIN_TYPE.file_chunk, result.header, result.payload))
    return
  }
  if (chunk.action === "ack") return
}

async function handleBinaryFrame(
  app: FastifyInstance,
  socket: WebSocket,
  device: Device,
  raw: Uint8Array
): Promise<void> {
  const decoded = decodeAgentWsBinary(raw)
  if (decoded.binType === AGENT_WS_BIN_TYPE.screenshot_bin) {
    await ingestScreenshotBytes(app, device, decoded.payload)
    return
  }
  if (decoded.binType === AGENT_WS_BIN_TYPE.file_chunk) {
    const header = fileChunkHeaderSchema.safeParse(decoded.header)
    if (!header.success) return
    const chunk = header.data as FileChunk
    if (chunk.direction === "download" || chunk.action === "request") {
      const result = await readDownloadChunk(app, device.id, chunk)
      if ("error" in result) {
        sendJson(socket, result.error)
        return
      }
      sendToAgentBinary(device.id, encodeAgentWsBinary(AGENT_WS_BIN_TYPE.file_chunk, result.header, result.payload))
      return
    }
    const ack = await ingestUploadChunk(app, device.id, chunk, decoded.payload)
    sendJson(socket, ack)
    return
  }
  if (decoded.binType === AGENT_WS_BIN_TYPE.e2e_envelope) {
    const header = e2eBinHeaderSchema.safeParse(decoded.header)
    if (!header.success) return
    if (!matchesE2ESession(device.id, header.data.sessionId)) return
    emitDevice(
      app,
      device.id,
      WS_EVENTS.E2E_ENVELOPE,
      envelopeForOperator(device.id, {
        action: "data",
        sessionId: header.data.sessionId,
        kind: header.data.kind,
        nonce: header.data.nonce,
        ciphertext: Buffer.from(decoded.payload).toString("base64"),
        aad: header.data.aad,
      })
    )
    return
  }
  if (decoded.binType === AGENT_WS_BIN_TYPE.shell_data) {
    if (decoded.payload.length > SHELL_DATA_MAX_CHARS) return
    const data = Buffer.from(decoded.payload).toString("utf8")
    emitDevice(app, device.id, WS_EVENTS.SHELL_DATA, { deviceId: device.id, data })
  }
}

async function handleE2EFrame(app: FastifyInstance, device: Device, parsed: unknown): Promise<void> {
  const frame = e2eEnvelopeFrameSchema.safeParse(parsed)
  if (!frame.success) return
  const payload = frame.data.payload
  if (!matchesE2ESession(device.id, payload.sessionId)) return
  if (payload.action === "answer") {
    acceptE2EAnswer(payload.sessionId, payload.agentPub.toLowerCase(), device.id)
    return
  }
  if (payload.action === "data") {
    emitDevice(app, device.id, WS_EVENTS.E2E_ENVELOPE, envelopeForOperator(device.id, payload))
  }
}

export async function registerAgentWs(app: FastifyInstance): Promise<void> {
  const agentUpgrade = new EventEmitter()

  await app.register(websocket, {
    options: {
      // Isolated from Socket.io /ws: only /agent-ws upgrades are forwarded here.
      server: agentUpgrade as never,
      maxPayload: 12 * 1024 * 1024,
      clientTracking: false,
    },
  })

  app.server.on("upgrade", (req, socket, head) => {
    const path = (req.url ?? "").split("?")[0]
    if (path === AGENT_WS_PATH) agentUpgrade.emit("upgrade", req, socket, head)
  })

  app.get(AGENT_WS_PATH, { websocket: true }, (socket, req) => {
    const nonce = queryNonce(req)
    const key = enrollmentKey(req)
    if (!nonce || !key) {
      socket.close(4401, "unauthorized")
      return
    }

    const sessionPromise = deviceFromHeaders(req).catch(() => null)
    let authed = false
    let closed = false
    let device: Device | null = null
    let lastPong = Date.now()
    let pingTimer: ReturnType<typeof setInterval> | undefined

    const helloTimer = setTimeout(() => {
      if (!authed) socket.close(4408, "hello timeout")
    }, AGENT_WS_HELLO_TIMEOUT_MS)

    const cleanup = () => {
      closed = true
      clearTimeout(helloTimer)
      if (pingTimer) clearInterval(pingTimer)
      if (device) dropConn(device.id, socket, app)
    }

    let chain: Promise<void> = Promise.resolve()
    socket.on("message", (raw, isBinary) => {
      chain = chain
        .then(async () => {
          try {
          if (isBinary) {
            if (!authed || !device) return
            await handleBinaryFrame(app, socket, device, messageBytes(raw))
            lastPong = Date.now()
            return
          }
          const text = messageText(raw)
          const parsed = JSON.parse(text) as { type?: string }
          const type = parsed.type

          if (!authed) {
            if (type !== AGENT_WS_TYPE.hello) {
              socket.close(4401, "hello required")
              return
            }
            const hello = helloSchema.safeParse(parsed)
            const resolved = await sessionPromise
            if (!hello.success || !resolved) {
              socket.close(4401, "unauthorized")
              return
            }
            const headerId = req.headers["x-device-id"]
            if (hello.data.deviceId !== headerId || hello.data.deviceId !== resolved.id) {
              socket.close(4401, "unauthorized")
              return
            }
            const expected = hmacSha256Hex(key, nonce)
            if (!safeEqual(expected.toLowerCase(), hello.data.keyProof.toLowerCase())) {
              socket.close(4401, "unauthorized")
              return
            }
            if (!consumeWsChallenge(nonce, resolved.id)) {
              socket.close(4401, "nonce replay")
              return
            }
            if (closed || socket.readyState !== socket.OPEN) {
              cleanup()
              return
            }
            authed = true
            clearTimeout(helloTimer)
            device = resolved
            const previous = agents.get(device.id)
            if (previous && previous.socket !== socket) {
              const leftover = [...previous.unacked]
              previous.unacked.clear()
              try {
                previous.socket.close(1000, "replaced")
              } catch {
                /* ignore */
              }
              void Promise.all(leftover.map((id) => revertCommandToPending(id))).catch((error) => {
                app.log.warn({ err: error }, "revert replaced-socket commands")
              })
              const shell = closeShellSession(device.id)
              if (shell) {
                emitDevice(app, device.id, WS_EVENTS.SHELL_CLOSE, {
                  deviceId: device.id,
                  reason: "agent_replaced",
                })
              }
            }
            agents.set(device.id, { socket, device, unacked: new Set() })
            const ip = clientIp(req.headers as Record<string, unknown>, req.ip)
            const lan = lanDiscoveryData({
              lanAddrs: hello.data.lanAddrs ?? undefined,
              lanPort: hello.data.lanPort,
            })
            let online = await touchDeviceOnline(app, device, ip, lan)
            if (hello.data.e2ePub) {
              online = await prisma.device.update({
                where: { id: online.id },
                data: { e2ePub: hello.data.e2ePub.toLowerCase() },
              })
            }
            device = online
            const conn = agents.get(device.id)
            if (conn && conn.socket === socket) conn.device = online
            sendJson(socket, {
              type: AGENT_WS_TYPE.hello_ok,
              serverTime: new Date().toISOString(),
              protocolVersion: AGENT_WS_PROTOCOL_VERSION,
              watch: watchPayload(online),
              agentConfig: await agentConfigPayload(),
              caps: agentCaps(),
              mesh: issueMeshBundle(device.id, hello.data.meshSerial),
              ...(await meshSessionExtras(device.id, ip, true)),
            })
            lastPong = Date.now()
            pingTimer = setInterval(() => {
              if (socket.readyState !== socket.OPEN) return
              if (Date.now() - lastPong > AGENT_WS_STALE_MS) {
                socket.close(1001, "ping timeout")
                return
              }
              sendJson(socket, { type: AGENT_WS_TYPE.ping, ts: Date.now() })
            }, AGENT_WS_PING_INTERVAL_MS)
            const pushed = await pushPendingCommands(app, device.id)
            if (!pushed) notifyCommandsQueued(device.id)
            return
          }

          lastPong = Date.now()
          if (!device) return

          if (type === AGENT_WS_TYPE.ping) {
            const ping = pingSchema.safeParse(parsed)
            sendJson(socket, { type: AGENT_WS_TYPE.pong, ts: ping.success ? ping.data.ts : Date.now() })
            return
          }
          if (type === AGENT_WS_TYPE.pong) {
            pongSchema.safeParse(parsed)
            return
          }
          if (type === AGENT_WS_TYPE.command_ack) {
            const ack = commandAckSchema.safeParse(parsed)
            if (ack.success) agents.get(device.id)?.unacked.delete(ack.data.id)
            return
          }
          if (type === AGENT_WS_TYPE.metrics) {
            const samples = normalizeMetrics(parsed)
            if (samples) await storeMetrics(device.id, samples)
            return
          }
          if (type === AGENT_WS_TYPE.heartbeat) {
            const hb = heartbeatFrameSchema.safeParse(parsed)
            if (!hb.success) return
            const ip = clientIp(req.headers as Record<string, unknown>, req.ip)
            const ack = await ingestHeartbeat(app, device, hb.data, ip)
            device = ack.device
            sendJson(socket, {
              type: AGENT_WS_TYPE.agent_config,
              serverTime: ack.serverTime,
              watch: ack.watch,
              agentConfig: ack.agentConfig,
              ...(await meshSessionExtras(device.id, ip, false)),
            })
            return
          }
          if (type === AGENT_WS_TYPE.command_result) {
            const result = commandResultFrameSchema.safeParse(parsed)
            if (!result.success) {
              app.log.warn(
                {
                  deviceId: device.id,
                  issues: result.error.flatten(),
                  keys: parsed && typeof parsed === "object" ? Object.keys(parsed as object) : [],
                },
                "invalid command_result frame"
              )
              return
            }
            agents.get(device.id)?.unacked.delete(result.data.commandId)
            await ingestCommandResult(app, device, result.data)
            await afterPeerCommandIngest(app, device, result.data)
            return
          }
          if (type === AGENT_WS_TYPE.file_chunk) {
            await handleFileChunkText(app, socket, device, parsed)
            return
          }
          if (type === AGENT_WS_TYPE.webrtc_signal) {
            const signal = webrtcSignalFrameSchema.safeParse(parsed)
            if (!signal.success) return
            const payload = signal.data.payload as { kind?: unknown; reason?: unknown; error?: unknown }
            const kind = typeof payload.kind === "string" ? payload.kind : undefined
            const owner = webrtcSessionFor(device.id)
            if (kind === "hangup") {
              if (owner) releaseWebrtcSession(device.id)
              const reason = typeof payload.reason === "string" ? payload.reason : typeof payload.error === "string" ? payload.error : "agent_hangup"
              void dropWebrtcSession(device.id, { reason: `agent:${reason.slice(0, 60)}` }).catch(() => undefined)
            } else if (owner) {
              void touchWebrtcSession(device.id, kind).catch(() => undefined)
            }
            const frame = { deviceId: device.id, payload: signal.data.payload }
            if (owner) app.io.to(owner.socketId).emit(WS_EVENTS.WEBRTC_SIGNAL, frame)
            else emitDevice(app, device.id, WS_EVENTS.WEBRTC_SIGNAL, frame)
            return
          }
          if (type === AGENT_WS_TYPE.mesh_signal) {
            const signal = meshSignalFrameSchema.safeParse(parsed)
            if (!signal.success) return
            const dest = signal.data.payload.to
            if (!dest || dest === device.id) return
            const sent = sendToAgent(dest, {
              type: AGENT_WS_TYPE.mesh_signal,
              payload: { ...signal.data.payload, from: device.id },
            })
            if (!sent) {
              sendJson(socket, {
                type: AGENT_WS_TYPE.mesh_signal,
                payload: {
                  sessionId: signal.data.payload.sessionId,
                  to: device.id,
                  from: dest,
                  kind: "hangup",
                },
              })
            }
            return
          }
          if (type === AGENT_WS_TYPE.mesh_relay) {
            const relay = meshRelayFrameSchema.safeParse(parsed)
            if (!relay.success) return
            const dest = relay.data.to
            if (!dest || dest === device.id) return
            const sent = sendToAgent(dest, {
              type: AGENT_WS_TYPE.mesh_relay,
              to: dest,
              from: device.id,
              cmdType: relay.data.cmdType,
              payload: relay.data.payload,
              resultId: relay.data.resultId,
            })
            if (!sent) {
              sendJson(socket, {
                type: AGENT_WS_TYPE.mesh_relay_result,
                to: device.id,
                from: dest,
                resultId: relay.data.resultId,
                status: "failed",
                result: { error: "mesh_unreachable" },
              })
            }
            return
          }
          if (type === AGENT_WS_TYPE.mesh_relay_result) {
            const result = meshRelayResultFrameSchema.safeParse(parsed)
            if (!result.success) return
            const dest = result.data.to
            if (!dest || dest === device.id) return
            sendToAgent(dest, {
              type: AGENT_WS_TYPE.mesh_relay_result,
              to: dest,
              from: device.id,
              resultId: result.data.resultId,
              status: result.data.status,
              result: result.data.result,
            })
            return
          }
          if (type === AGENT_WS_TYPE.e2e_envelope) {
            await handleE2EFrame(app, device, parsed)
            return
          }
          if (type === AGENT_WS_TYPE.shell_open) {
            const frame = shellOpenFrameSchema.safeParse(parsed)
            if (!frame.success) return
            emitDevice(app, device.id, WS_EVENTS.SHELL_OPEN, {
              deviceId: device.id,
              cols: frame.data.cols,
              rows: frame.data.rows,
              shell: frame.data.shell,
            })
            return
          }
          if (type === AGENT_WS_TYPE.shell_data) {
            const frame = shellDataFrameSchema.safeParse(parsed)
            if (!frame.success) return
            emitDevice(app, device.id, WS_EVENTS.SHELL_DATA, { deviceId: device.id, data: frame.data.data })
            return
          }
          if (type === AGENT_WS_TYPE.shell_resize) {
            const frame = shellResizeFrameSchema.safeParse(parsed)
            if (!frame.success) return
            emitDevice(app, device.id, WS_EVENTS.SHELL_RESIZE, {
              deviceId: device.id,
              cols: frame.data.cols,
              rows: frame.data.rows,
            })
            return
          }
          if (type === AGENT_WS_TYPE.shell_close) {
            const frame = shellCloseFrameSchema.safeParse(parsed)
            if (!frame.success) return
            closeShellSession(device.id)
            emitDevice(app, device.id, WS_EVENTS.SHELL_CLOSE, {
              deviceId: device.id,
              reason: frame.data.reason,
            })
            return
          }
          if (type === AGENT_WS_TYPE.shell_exec) {
            const frame = shellExecFrameSchema.safeParse(parsed)
            if (!frame.success) return
            emitDevice(app, device.id, WS_EVENTS.SHELL_EXEC, {
              deviceId: device.id,
              id: frame.data.id,
              data: frame.data.data,
              done: frame.data.done,
              exitCode: frame.data.exitCode,
              error: frame.data.error,
            })
          }
        } catch (error) {
          app.log.warn({ err: error }, "agent-ws message error")
        }
        })
        .catch((error) => {
          app.log.warn({ err: error }, "agent-ws message error")
        })
    })

    socket.on("close", cleanup)
    socket.on("error", cleanup)
  })
}
