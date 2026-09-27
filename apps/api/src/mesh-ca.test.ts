import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { X509Certificate } from "node:crypto"
import { test } from "node:test"
import assert from "node:assert/strict"

import { MESH_CERT_TTL_DAYS, MESH_DEVICE_URI_PREFIX } from "@workspace/shared"

import {
  deriveMeshCA,
  deviceURI,
  issueAndRecord,
  issueDeviceCert,
  revokeDeviceMesh,
  shouldRefreshIssued,
} from "./mesh-ca.ts"

test("derived mesh CA is deterministic and can issue device certs", () => {
  const a = deriveMeshCA("test-update-signing-secret")
  const b = deriveMeshCA("test-update-signing-secret")
  assert.equal(a.keyPem, b.keyPem)
  assert.deepEqual(a.cert.publicKey.export({ type: "spki", format: "der" }), b.cert.publicKey.export({ type: "spki", format: "der" }))

  const id = "11111111-2222-4333-8444-555555555555"
  const issued = issueDeviceCert(a, id)
  const leaf = new X509Certificate(issued.certPem)
  assert.equal(leaf.verify(a.cert.publicKey), true)
  const san = leaf.subjectAltName ?? ""
  assert.ok(san.includes(id), san)
  assert.ok(san.toLowerCase().includes(MESH_DEVICE_URI_PREFIX + id) || san.includes(deviceURI(id)), san)
  const until = Date.parse(leaf.validTo)
  const days = (until - Date.now()) / 86_400_000
  assert.ok(days > MESH_CERT_TTL_DAYS - 2 && days < MESH_CERT_TTL_DAYS + 2, `ttl days=${days}`)
  assert.equal(issued.serial.length, 32)
})

test("issueAndRecord reuses while serial matches and refreshes when unknown", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mesh-ca-"))
  const state = path.join(dir, "mesh-state.json")
  const ca = deriveMeshCA("another-secret")
  const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
  try {
    const first = issueAndRecord(ca, state, id)
    assert.equal(first.reused, false)
    assert.ok(first.certPem.includes("BEGIN CERTIFICATE"))
    const again = issueAndRecord(ca, state, id, first.serial)
    assert.equal(again.reused, true)
    assert.equal(again.serial, first.serial)
    assert.equal(again.certPem, "")
    const lost = issueAndRecord(ca, state, id, "")
    assert.equal(lost.reused, false)
    assert.notEqual(lost.serial, first.serial)
    assert.ok(lost.revokedSerials.includes(first.serial))
    revokeDeviceMesh(state, id)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("shouldRefreshIssued trips near expiry", () => {
  const soon = new Date(Date.now() + 2 * 86_400_000).toISOString()
  const later = new Date(Date.now() + 20 * 86_400_000).toISOString()
  assert.equal(shouldRefreshIssued(soon), true)
  assert.equal(shouldRefreshIssued(later), false)
  assert.equal(shouldRefreshIssued("nope"), true)
})
