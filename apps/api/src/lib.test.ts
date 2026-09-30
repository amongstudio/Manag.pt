import { test } from "node:test"
import assert from "node:assert/strict"

import { deviceKeyMatches, hashDeviceKey, httpRateLimitBucket, ipAllowed, isHelperArtifact, parseJson, sha256, signPeerTicket, trySafePath, updateKindFromArtifact, verifyPeerTicket } from "./lib.ts"
import { adminMutationOriginAllowed, extractOperatorToken, operatorTokenMatches } from "./operator-auth.ts"

test("ipAllowed empty list permits all", () => {
  assert.equal(ipAllowed("10.0.0.8", []), true)
})

test("ipAllowed exact match", () => {
  assert.equal(ipAllowed("10.0.0.8", ["10.0.0.8"]), true)
  assert.equal(ipAllowed("10.0.0.9", ["10.0.0.8"]), false)
})

test("ipAllowed CIDR v4", () => {
  assert.equal(ipAllowed("10.0.0.8", ["10.0.0.0/24"]), true)
  assert.equal(ipAllowed("10.0.1.1", ["10.0.0.0/24"]), false)
  assert.equal(ipAllowed("192.168.1.50", ["192.168.1.0/24"]), true)
})

test("operator token unset allows", () => {
  assert.equal(operatorTokenMatches("anything", ""), true)
})

test("operator token requires match when set", () => {
  assert.equal(operatorTokenMatches("secret", "secret"), true)
  assert.equal(operatorTokenMatches("nope", "secret"), false)
  assert.equal(operatorTokenMatches("", "secret"), false)
})

test("extractOperatorToken reads cookie", () => {
  assert.equal(
    extractOperatorToken({ headers: { cookie: "pc_operator_token=secret" } }),
    "secret"
  )
  assert.equal(extractOperatorToken({ headers: { "x-operator-token": "hdr" } }), "hdr")
})

test("admin mutations reject cross-site origins and allow configured dashboard origin", () => {
  assert.equal(
    adminMutationOriginAllowed("POST", {
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
    }),
    false
  )
  assert.equal(adminMutationOriginAllowed("POST", { origin: "http://localhost:3000" }), true)
  assert.equal(adminMutationOriginAllowed("POST", {}), true)
  assert.equal(adminMutationOriginAllowed("GET", { origin: "https://attacker.example" }), true)
})

test("deviceKeyMatches accepts legacy sha256 hashes", () => {
  const key = "a".repeat(32)
  assert.equal(deviceKeyMatches(sha256(key), key), true)
})

test("deviceKeyMatches accepts preferred hmac hashes", () => {
  const key = "b".repeat(32)
  assert.equal(deviceKeyMatches(hashDeviceKey(key), key), true)
})

test("isHelperArtifact matches helper binaries and notes", () => {
  assert.equal(isHelperArtifact("pc-manager-helper-windows-amd64.exe"), true)
  assert.equal(isHelperArtifact("pc-manager-agent-windows-amd64.exe"), false)
  assert.equal(isHelperArtifact("agent.bin", "watchdog helper"), true)
  assert.equal(isHelperArtifact("agent.bin", "includes agent binary"), false)
})

test("updateKindFromArtifact discriminates agent vs helper", () => {
  assert.equal(updateKindFromArtifact("pc-manager-helper.exe"), "helper")
  assert.equal(updateKindFromArtifact("pc-manager-agent.exe"), "agent")
  assert.equal(updateKindFromArtifact("agent.bin", "watchdog helper"), "helper")
})

test("parseJson returns fallback on empty or invalid JSON", () => {
  assert.deepEqual(parseJson("{\"a\":1}", {}), { a: 1 })
  assert.deepEqual(parseJson("", { ok: true }), { ok: true })
  assert.deepEqual(parseJson("not-json", {}), {})
  assert.equal(parseJson(null, 3), 3)
})

test("httpRateLimitBucket splits agent vs admin vs other", () => {
  assert.equal(httpRateLimitBucket("/api/v1/agent/heartbeat"), "agent")
  assert.equal(httpRateLimitBucket("/api/v1/agent/commands?wait=5"), "agent")
  assert.equal(httpRateLimitBucket("/api/v1/admin/devices"), "admin")
  assert.equal(httpRateLimitBucket("/api/v1/admin/plugins/x/grants"), "admin")
  assert.equal(httpRateLimitBucket("/healthz"), "other")
  assert.equal(httpRateLimitBucket("/api/v1/builder/download?id=1"), "other")
})

test("peer ticket HMAC verifies until expiry", () => {
  const msg = "peer-copy-v1\nc1\nsrc\ndst\n/a\n/b\n9999999999\n10\n17891\n10.0.0.2"
  const sig = signPeerTicket(msg)
  assert.equal(verifyPeerTicket(msg, sig, 9_999_999_999), true)
  assert.equal(verifyPeerTicket(msg, "ab".repeat(32), 9_999_999_999), false)
  assert.equal(verifyPeerTicket(msg, sig, 1), false)
})

test("trySafePath allows UNC share paths and rejects traversal", () => {
  assert.equal(trySafePath("\\\\filesrv\\share\\report.pdf"), "\\\\filesrv\\share\\report.pdf")
  assert.equal(trySafePath("Z:\\inbox\\a.txt"), "Z:\\inbox\\a.txt")
  assert.equal(trySafePath("\\\\filesrv\\share\\..\\secret"), null)
})
