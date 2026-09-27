import { AGENT_WS_CHALLENGE_TTL_SEC, agentWsNonceSchema } from "@workspace/shared"

import { randomToken } from "./lib.js"

type Challenge = { deviceId: string; exp: number }

const pending = new Map<string, Challenge>()

function sweep(now = Date.now()): void {
  for (const [nonce, row] of pending) {
    if (row.exp <= now) pending.delete(nonce)
  }
}

export function issueWsChallenge(deviceId: string): { nonce: string; expiresInSec: number } {
  sweep()
  const nonce = randomToken(16)
  pending.set(nonce, { deviceId, exp: Date.now() + AGENT_WS_CHALLENGE_TTL_SEC * 1000 })
  return { nonce, expiresInSec: AGENT_WS_CHALLENGE_TTL_SEC }
}

/** Single-use. Returns false if missing, expired, or bound to another device. */
export function consumeWsChallenge(nonce: string, deviceId: string): boolean {
  const parsed = agentWsNonceSchema.safeParse(nonce)
  if (!parsed.success) return false
  const row = pending.get(parsed.data)
  if (!row) return false
  pending.delete(parsed.data)
  if (row.exp <= Date.now()) return false
  return row.deviceId === deviceId
}
