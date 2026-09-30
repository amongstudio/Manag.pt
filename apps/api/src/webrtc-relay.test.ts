import assert from "node:assert/strict"
import { test } from "node:test"

import { REMOTE_SESSION_TTL_MS } from "@workspace/shared"

import {
  WEBRTC_SIGNAL_MAX_PER_WINDOW,
  WEBRTC_SIGNAL_WINDOW_MS,
  allowWebrtcSignal,
  claimWebrtcSession,
  expiredWebrtcSessions,
  ownsWebrtcSession,
  releaseWebrtcSession,
  releaseWebrtcSessionsForSocket,
} from "./webrtc-relay.ts"

test("webrtc session is bound to the claiming socket", () => {
  const first = claimWebrtcSession("dev-a", "sock-1", "alice", 1000)
  assert.equal(first.replaced, undefined)
  assert.equal(first.fresh, true)
  assert.equal(ownsWebrtcSession("dev-a", "sock-1", 1001), true)
  assert.equal(ownsWebrtcSession("dev-a", "sock-2", 1001), false)
  const again = claimWebrtcSession("dev-a", "sock-1", "alice", 2000)
  assert.equal(again.fresh, false)
  assert.equal(
    again.session.openedAt,
    1000,
    "re-offer from the owner keeps the original deadline"
  )
  const taken = claimWebrtcSession("dev-a", "sock-2", "bob", 3000)
  assert.equal(taken.fresh, true)
  assert.equal(taken.replaced?.socketId, "sock-1")
  assert.equal(ownsWebrtcSession("dev-a", "sock-1", 3001), false)
  assert.equal(releaseWebrtcSession("dev-a")?.actor, "bob")
})

test("webrtc sessions expire at an absolute deadline", () => {
  claimWebrtcSession("dev-b", "sock-1", "alice", 0)
  assert.equal(
    ownsWebrtcSession("dev-b", "sock-1", REMOTE_SESSION_TTL_MS + 1),
    false
  )
  const expired = expiredWebrtcSessions(REMOTE_SESSION_TTL_MS + 1)
  assert.deepEqual(
    expired.map((s) => s.deviceId),
    ["dev-b"]
  )
})

test("socket disconnect releases every owned session", () => {
  claimWebrtcSession("dev-c", "sock-9", "alice", Date.now())
  claimWebrtcSession("dev-d", "sock-9", "alice", Date.now())
  assert.deepEqual(
    releaseWebrtcSessionsForSocket("sock-9")
      .map((s) => s.deviceId)
      .sort(),
    ["dev-c", "dev-d"]
  )
})

test("signal rate limit caps a burst and resets per window", () => {
  let allowed = 0
  for (let i = 0; i < WEBRTC_SIGNAL_MAX_PER_WINDOW + 20; i++)
    if (allowWebrtcSignal("sock-r", 10)) allowed++
  assert.equal(allowed, WEBRTC_SIGNAL_MAX_PER_WINDOW)
  assert.equal(allowWebrtcSignal("sock-r", 10 + WEBRTC_SIGNAL_WINDOW_MS), true)
})
