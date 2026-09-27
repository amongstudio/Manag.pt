import { E2E_SESSION_TIMEOUT_MS, type E2EPayload } from "@workspace/shared"

import { dropE2ESession, persistE2ESession } from "./remote-session.js"

/** In-memory E2E session metadata. Public keys only — never a session secret. */
export type E2ERelaySession = {
  sessionId: string
  deviceId: string
  operatorPub: string
  agentPub?: string
  createdAt: number
}

const byDevice = new Map<string, E2ERelaySession>()
const pending = new Map<
  string,
  {
    resolve: (agentPub: string) => void
    reject: (err: Error) => void
    timer: ReturnType<typeof setTimeout>
  }
>()

export function hasE2ESession(deviceId: string): boolean {
  return Boolean(byDevice.get(deviceId)?.agentPub)
}

export function e2eSessionFor(deviceId: string): E2ERelaySession | undefined {
  return byDevice.get(deviceId)
}

export function restoreE2ESession(session: E2ERelaySession): void {
  byDevice.set(session.deviceId, session)
}

export function beginE2ESession(deviceId: string, operatorPub: string, sessionId: string): Promise<string> {
  closeE2ESession(deviceId)
  const row: E2ERelaySession = { sessionId, deviceId, operatorPub, createdAt: Date.now() }
  byDevice.set(deviceId, row)
  void persistE2ESession(row).catch(() => undefined)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(sessionId)
      byDevice.delete(deviceId)
      void dropE2ESession(sessionId).catch(() => undefined)
      reject(new Error("e2e_timeout"))
    }, E2E_SESSION_TIMEOUT_MS)
    pending.set(sessionId, { resolve, reject, timer })
  })
}

export function acceptE2EAnswer(sessionId: string, agentPub: string, deviceId?: string): boolean {
  if (deviceId && !matchesE2ESession(deviceId, sessionId)) return false
  for (const session of byDevice.values()) {
    if (session.sessionId === sessionId) {
      if (deviceId && session.deviceId !== deviceId) continue
      session.agentPub = agentPub
      void persistE2ESession(session).catch(() => undefined)
    }
  }
  const waiter = pending.get(sessionId)
  if (!waiter) return false
  clearTimeout(waiter.timer)
  pending.delete(sessionId)
  waiter.resolve(agentPub)
  return true
}

export function closeE2ESession(deviceId: string): E2ERelaySession | undefined {
  const session = byDevice.get(deviceId)
  if (!session) return undefined
  const waiter = pending.get(session.sessionId)
  if (waiter) {
    clearTimeout(waiter.timer)
    pending.delete(session.sessionId)
    waiter.reject(new Error("e2e_closed"))
  }
  byDevice.delete(deviceId)
  void dropE2ESession(session.sessionId).catch(() => undefined)
  return session
}

export function matchesE2ESession(deviceId: string, sessionId: string): boolean {
  const session = byDevice.get(deviceId)
  return Boolean(session && session.sessionId === sessionId)
}

/** Relay helper: API must not inspect or persist ciphertext. */
export function envelopeForOperator(deviceId: string, payload: E2EPayload): { deviceId: string; payload: E2EPayload } {
  return { deviceId, payload }
}
