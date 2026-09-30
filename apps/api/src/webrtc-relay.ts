import { REMOTE_SESSION_TTL_MS } from "@workspace/shared"

/**
 * One WebRTC desktop session per device, bound to the operator socket that
 * sent the offer. Only the owner may send ICE/control/hangup, and the session
 * has an absolute deadline regardless of signaling activity.
 */
export type WebrtcRelaySession = {
  deviceId: string
  socketId: string
  actor: string
  openedAt: number
  expiresAt: number
}

const byDevice = new Map<string, WebrtcRelaySession>()

export function webrtcSessionFor(
  deviceId: string
): WebrtcRelaySession | undefined {
  return byDevice.get(deviceId)
}

/** Claim the device for this socket; returns the replaced session if another socket held it. */
export function claimWebrtcSession(
  deviceId: string,
  socketId: string,
  actor: string,
  now = Date.now()
): {
  session: WebrtcRelaySession
  fresh: boolean
  replaced?: WebrtcRelaySession
} {
  const previous = byDevice.get(deviceId)
  if (previous && previous.socketId === socketId && previous.expiresAt > now) {
    return { session: previous, fresh: false }
  }
  const session = {
    deviceId,
    socketId,
    actor,
    openedAt: now,
    expiresAt: now + REMOTE_SESSION_TTL_MS,
  }
  byDevice.set(deviceId, session)
  return {
    session,
    fresh: true,
    replaced: previous && previous.socketId !== socketId ? previous : undefined,
  }
}

export function ownsWebrtcSession(
  deviceId: string,
  socketId: string,
  now = Date.now()
): boolean {
  const session = byDevice.get(deviceId)
  return Boolean(
    session && session.socketId === socketId && session.expiresAt > now
  )
}

export function releaseWebrtcSession(
  deviceId: string
): WebrtcRelaySession | undefined {
  const session = byDevice.get(deviceId)
  byDevice.delete(deviceId)
  return session
}

export function releaseWebrtcSessionsForSocket(
  socketId: string
): WebrtcRelaySession[] {
  const out: WebrtcRelaySession[] = []
  for (const [deviceId, session] of byDevice) {
    if (session.socketId !== socketId) continue
    byDevice.delete(deviceId)
    out.push(session)
  }
  return out
}

export function expiredWebrtcSessions(now = Date.now()): WebrtcRelaySession[] {
  const out: WebrtcRelaySession[] = []
  for (const [deviceId, session] of byDevice) {
    if (session.expiresAt > now) continue
    byDevice.delete(deviceId)
    out.push(session)
  }
  return out
}

/** Per-socket signaling budget: ICE trickle is bursty but bounded. */
export const WEBRTC_SIGNAL_WINDOW_MS = 10_000
export const WEBRTC_SIGNAL_MAX_PER_WINDOW = 150

const signalHits = new Map<string, { count: number; resetAt: number }>()

export function allowWebrtcSignal(socketId: string, now = Date.now()): boolean {
  const cur = signalHits.get(socketId)
  if (!cur || cur.resetAt <= now) {
    signalHits.set(socketId, {
      count: 1,
      resetAt: now + WEBRTC_SIGNAL_WINDOW_MS,
    })
    return true
  }
  cur.count++
  return cur.count <= WEBRTC_SIGNAL_MAX_PER_WINDOW
}

export function forgetWebrtcSignalBudget(socketId: string): void {
  signalHits.delete(socketId)
}
