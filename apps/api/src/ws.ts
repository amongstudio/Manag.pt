import type { FastifyInstance } from "fastify"
import { Server } from "socket.io"
import { prisma } from "@workspace/db"
import {
  AGENT_WS_PATH,
  AGENT_WS_TYPE,
  WS_CLIENT_EVENTS,
  WS_EVENTS,
  WS_FLEET_ROOM,
  WS_PATH,
  e2eEnvelopeFrameSchema,
  shellCloseClientSchema,
  shellDataClientSchema,
  shellExecClientSchema,
  shellOpenClientSchema,
  shellResizeClientSchema,
  webrtcSignalFrameSchema,
  wsDeviceRoom,
} from "@workspace/shared"

import { sendToAgent } from "./agent-ws.js"
import { closeE2ESession } from "./e2e-relay.js"
import { emitDevice } from "./io-emit.js"
import { env } from "./env.js"
import { clientIp, ipAllowed } from "./lib.js"
import { socketOperatorIdentity } from "./operator-auth.js"
import { dropWebrtcSession, touchWebrtcSession } from "./remote-session.js"
import {
  allowWebrtcSignal,
  claimWebrtcSession,
  expiredWebrtcSessions,
  forgetWebrtcSignalBudget,
  ownsWebrtcSession,
  releaseWebrtcSession,
  releaseWebrtcSessionsForSocket,
  webrtcSessionFor,
} from "./webrtc-relay.js"
import {
  closeShellSession,
  closeShellSessionsForSocket,
  openShellSession,
  ownsShellSession,
} from "./shell-relay.js"

declare module "fastify" {
  interface FastifyInstance {
    io: Server
  }
}

type SocketData = {
  deviceRooms: Set<string>
  e2eDevices: Set<string>
  actor: string
}

function hangupAgentWebrtc(deviceId: string, reason = "operator_disconnect"): void {
  sendToAgent(deviceId, { type: "webrtc_signal", payload: { kind: "hangup", reason } })
}

/** Ends expired relay sessions: agent hangup plus a notice to the owner socket. */
export function expireWebrtcRelaySessions(app: FastifyInstance): void {
  for (const session of expiredWebrtcSessions()) {
    hangupAgentWebrtc(session.deviceId, "session_expired")
    app.io.to(session.socketId).emit(WS_EVENTS.WEBRTC_SIGNAL, {
      deviceId: session.deviceId,
      payload: { kind: "hangup", error: "session_expired", reason: "session_expired" },
    })
    void dropWebrtcSession(session.deviceId, { actor: session.actor, reason: "session_expired" }).catch(() => undefined)
  }
}

export function hangupExpiredWebrtc(deviceId: string): void {
  releaseWebrtcSession(deviceId)
  hangupAgentWebrtc(deviceId, "session_expired")
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null
}

function collectDeviceIds(raw: unknown): string[] {
  const rec = asRecord(raw)
  if (!rec) return []
  const ids: string[] = []
  if (typeof rec.deviceId === "string" && rec.deviceId) ids.push(rec.deviceId)
  if (Array.isArray(rec.deviceIds)) {
    for (const item of rec.deviceIds) {
      if (typeof item === "string" && item) ids.push(item)
    }
  }
  return [...new Set(ids)].slice(0, 500)
}

const connectHits = new Map<string, { count: number; resetAt: number }>()

function allowConnect(ip: string): boolean {
  const now = Date.now()
  const windowMs = 60_000
  const cur = connectHits.get(ip)
  if (!cur || cur.resetAt <= now) {
    connectHits.set(ip, { count: 1, resetAt: now + windowMs })
    return true
  }
  cur.count++
  return cur.count <= env.wsConnectPerMinute
}

export function attachSocket(app: FastifyInstance): Server {
  const io = new Server(app.server, {
    path: WS_PATH,
    // /agent-ws is forwarded separately; do not let Engine.IO destroy those sockets.
    destroyUpgrade: false,
    maxHttpBufferSize: 12 * 1024 * 1024,
    cors: {
      origin: env.cors.origin,
      credentials: env.cors.credentials,
    },
  })

  io.use(async (socket, next) => {
    const ip = clientIp(socket.request.headers as Record<string, unknown>, socket.handshake.address)
    if (env.ipAllowlist.length > 0 && !ipAllowed(ip, env.ipAllowlist)) {
      next(new Error("ip_not_allowed"))
      return
    }
    const identity = await socketOperatorIdentity(socket.handshake.auth, socket.request.headers as Record<string, unknown>)
    if (!identity.ok) {
      next(new Error("unauthorized"))
      return
    }
    ;(socket.data as SocketData).actor = identity.actor
    if (!allowConnect(ip)) {
      next(new Error("rate_limited"))
      return
    }
    next()
  })

  io.on("connection", (socket) => {
    const data = socket.data as SocketData
    data.deviceRooms = new Set()
    data.e2eDevices = new Set()
    data.actor ||= "operator"

    const endOwnedWebrtc = (deviceId: string, reason: string) => {
      if (!ownsWebrtcSession(deviceId, socket.id)) return
      releaseWebrtcSession(deviceId)
      hangupAgentWebrtc(deviceId)
      void dropWebrtcSession(deviceId, { actor: data.actor, reason }).catch(() => undefined)
    }

    socket.on(WS_CLIENT_EVENTS.ATTACH, async (raw: unknown, ack?: (value: unknown) => void) => {
      try {
        const ids = collectDeviceIds(raw)
        await socket.join(WS_FLEET_ROOM)
        const found =
          ids.length === 0
            ? []
            : await prisma.device.findMany({
                where: { id: { in: ids } },
                select: { id: true },
              })
        const ok = new Set(found.map((d) => d.id))
        const nextRooms = new Set<string>()
        for (const id of ids) {
          if (!ok.has(id)) continue
          const room = wsDeviceRoom(id)
          nextRooms.add(room)
          await socket.join(room)
        }
        for (const room of data.deviceRooms) {
          if (!nextRooms.has(room)) {
            await socket.leave(room)
            const deviceId = room.startsWith("device:") ? room.slice("device:".length) : ""
            if (deviceId && ownsShellSession(deviceId, socket.id)) {
              closeShellSession(deviceId)
              sendToAgent(deviceId, { type: AGENT_WS_TYPE.shell_close, reason: "operator_detach" })
              emitDevice(app, deviceId, WS_EVENTS.SHELL_CLOSE, { deviceId, reason: "operator_detach" })
            }
            if (deviceId) endOwnedWebrtc(deviceId, "operator_detach")
          }
        }
        data.deviceRooms = nextRooms
        ack?.({ ok: true })
      } catch (error) {
        app.log.warn({ err: error }, "ws attach failed")
        ack?.({ ok: false, error: "attach_failed" })
      }
    })

    socket.on(WS_CLIENT_EVENTS.DETACH, async (raw: unknown) => {
      const ids = collectDeviceIds(raw)
      for (const id of ids) {
        const room = wsDeviceRoom(id)
        await socket.leave(room)
        data.deviceRooms.delete(room)
        if (ownsShellSession(id, socket.id)) {
          closeShellSession(id)
          sendToAgent(id, { type: AGENT_WS_TYPE.shell_close, reason: "operator_detach" })
          emitDevice(app, id, WS_EVENTS.SHELL_CLOSE, { deviceId: id, reason: "operator_detach" })
        }
        endOwnedWebrtc(id, "operator_detach")
      }
    })

    socket.on(WS_EVENTS.WEBRTC_SIGNAL, (raw: unknown) => {
      const rec = asRecord(raw)
      if (!rec) return
      const framed = rec.type ? rec : { type: "webrtc_signal", ...rec }
      const parsed = webrtcSignalFrameSchema.safeParse(framed)
      if (!parsed.success) return
      const deviceId = parsed.data.deviceId
      if (!deviceId) return
      if (!socket.rooms.has(wsDeviceRoom(deviceId))) return
      const signal = asRecord(parsed.data.payload)
      const kindText = typeof signal?.kind === "string" ? signal.kind : undefined
      const refuse = (reason: string) =>
        socket.emit(WS_EVENTS.WEBRTC_SIGNAL, { deviceId, payload: { kind: "hangup", error: reason, reason } })
      if (!allowWebrtcSignal(socket.id)) {
        refuse("signal_rate_limited")
        return
      }
      const allowInput = typeof signal?.allowInput === "boolean" ? signal.allowInput : undefined
      if (kindText === "offer") {
        const { fresh, replaced } = claimWebrtcSession(deviceId, socket.id, data.actor)
        if (replaced) {
          app.io.to(replaced.socketId).emit(WS_EVENTS.WEBRTC_SIGNAL, {
            deviceId,
            payload: { kind: "hangup", error: "session_replaced", reason: "session_replaced" },
          })
        }
        if (fresh) {
          void dropWebrtcSession(deviceId, {
            actor: replaced?.actor,
            reason: replaced ? "session_replaced" : "session_restarted",
          }).catch(() => undefined)
        }
      } else if (!ownsWebrtcSession(deviceId, socket.id)) {
        if (kindText !== "hangup") refuse(webrtcSessionFor(deviceId) ? "session_not_owned" : "session_expired")
        return
      }
      if (kindText === "hangup") {
        releaseWebrtcSession(deviceId)
        void dropWebrtcSession(deviceId, { actor: data.actor, reason: "operator_hangup" }).catch(() => undefined)
      } else {
        void touchWebrtcSession(deviceId, kindText, { actor: data.actor, allowInput }).catch(() => undefined)
      }
      const sent = sendToAgent(deviceId, {
        type: "webrtc_signal",
        payload: parsed.data.payload,
      })
      if (!sent) {
        releaseWebrtcSession(deviceId)
        void dropWebrtcSession(deviceId, { actor: data.actor, reason: "agent_offline" }).catch(() => undefined)
        socket.emit(WS_EVENTS.WEBRTC_SIGNAL, {
          deviceId,
          payload: { kind: "hangup", error: "agent_offline", reason: "agent_offline" },
        })
      }
    })
    socket.on(WS_EVENTS.E2E_ENVELOPE, (raw: unknown) => {
      const rec = asRecord(raw)
      if (!rec) return
      const framed = rec.type ? rec : { type: "e2e_envelope", ...rec }
      const parsed = e2eEnvelopeFrameSchema.safeParse(framed)
      if (!parsed.success) return
      const deviceId = parsed.data.deviceId
      if (!deviceId) return
      if (!socket.rooms.has(wsDeviceRoom(deviceId))) return
      data.e2eDevices.add(deviceId)
      const sent = sendToAgent(deviceId, {
        type: "e2e_envelope",
        payload: parsed.data.payload,
      })
      if (!sent) {
        emitDevice(app, deviceId, WS_EVENTS.WEBRTC_SIGNAL, {
          deviceId,
          payload: { kind: "hangup", error: "agent_offline", reason: "agent_offline" },
        })
      }
    })

    socket.on(WS_EVENTS.SHELL_OPEN, (raw: unknown) => {
      const rec = asRecord(raw)
      if (!rec) return
      const framed = rec.type ? rec : { type: AGENT_WS_TYPE.shell_open, ...rec }
      const parsed = shellOpenClientSchema.safeParse(framed)
      if (!parsed.success) return
      const deviceId = parsed.data.deviceId
      if (!socket.rooms.has(wsDeviceRoom(deviceId))) return
      const previous = openShellSession(deviceId, socket.id)
      if (previous) {
        sendToAgent(deviceId, { type: AGENT_WS_TYPE.shell_close, reason: "replaced" })
      }
      const sent = sendToAgent(deviceId, {
        type: AGENT_WS_TYPE.shell_open,
        cols: parsed.data.cols,
        rows: parsed.data.rows,
        shell: parsed.data.shell,
      })
      if (!sent) {
        closeShellSession(deviceId)
        emitDevice(app, deviceId, WS_EVENTS.SHELL_CLOSE, { deviceId, reason: "agent_offline" })
      }
    })
    socket.on(WS_EVENTS.SHELL_DATA, (raw: unknown) => {
      const rec = asRecord(raw)
      if (!rec) return
      const framed = rec.type ? rec : { type: AGENT_WS_TYPE.shell_data, ...rec }
      const parsed = shellDataClientSchema.safeParse(framed)
      if (!parsed.success) return
      const deviceId = parsed.data.deviceId
      if (!socket.rooms.has(wsDeviceRoom(deviceId))) return
      if (!ownsShellSession(deviceId, socket.id)) return
      sendToAgent(deviceId, { type: AGENT_WS_TYPE.shell_data, data: parsed.data.data })
    })
    socket.on(WS_EVENTS.SHELL_RESIZE, (raw: unknown) => {
      const rec = asRecord(raw)
      if (!rec) return
      const framed = rec.type ? rec : { type: AGENT_WS_TYPE.shell_resize, ...rec }
      const parsed = shellResizeClientSchema.safeParse(framed)
      if (!parsed.success) return
      const deviceId = parsed.data.deviceId
      if (!socket.rooms.has(wsDeviceRoom(deviceId))) return
      if (!ownsShellSession(deviceId, socket.id)) return
      sendToAgent(deviceId, {
        type: AGENT_WS_TYPE.shell_resize,
        cols: parsed.data.cols,
        rows: parsed.data.rows,
      })
    })
    socket.on(WS_EVENTS.SHELL_CLOSE, (raw: unknown) => {
      const rec = asRecord(raw)
      if (!rec) return
      const framed = rec.type ? rec : { type: AGENT_WS_TYPE.shell_close, ...rec }
      const parsed = shellCloseClientSchema.safeParse(framed)
      if (!parsed.success) return
      const deviceId = parsed.data.deviceId
      if (!socket.rooms.has(wsDeviceRoom(deviceId))) return
      if (!ownsShellSession(deviceId, socket.id)) return
      closeShellSession(deviceId)
      sendToAgent(deviceId, { type: AGENT_WS_TYPE.shell_close, reason: parsed.data.reason })
      emitDevice(app, deviceId, WS_EVENTS.SHELL_CLOSE, {
        deviceId,
        reason: parsed.data.reason ?? "operator_close",
      })
    })
    socket.on(WS_EVENTS.SHELL_EXEC, (raw: unknown) => {
      const rec = asRecord(raw)
      if (!rec) return
      const framed = rec.type ? rec : { type: AGENT_WS_TYPE.shell_exec, ...rec }
      const parsed = shellExecClientSchema.safeParse(framed)
      if (!parsed.success) return
      const deviceId = parsed.data.deviceId
      if (!socket.rooms.has(wsDeviceRoom(deviceId))) return
      const sent = sendToAgent(deviceId, {
        type: AGENT_WS_TYPE.shell_exec,
        id: parsed.data.id,
        command: parsed.data.command,
        shell: parsed.data.shell,
      })
      if (!sent) {
        emitDevice(app, deviceId, WS_EVENTS.SHELL_EXEC, {
          deviceId,
          id: parsed.data.id,
          done: true,
          error: "agent_offline",
        })
      }
    })

    socket.on("disconnect", () => {
      for (const deviceId of data.e2eDevices) {
        const session = closeE2ESession(deviceId)
        if (session) {
          sendToAgent(deviceId, {
            type: "e2e_envelope",
            payload: { action: "close", sessionId: session.sessionId },
          })
        }
      }
      for (const deviceId of closeShellSessionsForSocket(socket.id)) {
        sendToAgent(deviceId, { type: AGENT_WS_TYPE.shell_close, reason: "operator_disconnect" })
        emitDevice(app, deviceId, WS_EVENTS.SHELL_CLOSE, { deviceId, reason: "operator_disconnect" })
      }
      for (const session of releaseWebrtcSessionsForSocket(socket.id)) {
        hangupAgentWebrtc(session.deviceId)
        void dropWebrtcSession(session.deviceId, { actor: session.actor, reason: "operator_disconnect" }).catch(() => undefined)
      }
      forgetWebrtcSignalBudget(socket.id)
    })
  })

  // Destroy leftover Upgrade sockets that are neither Engine.IO nor /agent-ws.
  app.server.on("upgrade", (req, socket) => {
    const path = (req.url ?? "").split("?")[0] ?? ""
    if (path === AGENT_WS_PATH) return
    if (path === WS_PATH || path.startsWith(`${WS_PATH}/`)) return
    socket.destroy()
  })

  app.decorate("io", io)
  return io
}
