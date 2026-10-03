import "./env.ts"

import assert from "node:assert/strict"
import { test } from "node:test"

import { prisma } from "@workspace/db"

import {
  createStoredCredential,
  deleteStoredCredential,
  listStoredCredentials,
  revealStoredCredential,
  updateStoredCredential,
  usableVaultSecret,
} from "./vault-store.ts"
import { decryptVaultSecretWith, encryptVaultSecretWith } from "./vault.ts"

const DEVICE_A = "11111111-1111-4111-8111-111111111111"
const DEVICE_B = "22222222-2222-4222-8222-222222222222"

test("a wrong vault key does not return plaintext", () => {
  const enc = encryptVaultSecretWith("credentials-key-correct", "s3cret-value")
  assert.throws(() => decryptVaultSecretWith("credentials-key-wrong", enc))
  try {
    decryptVaultSecretWith("credentials-key-wrong", enc)
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    assert.equal(text.includes("s3cret-value"), false)
  }
  assert.equal(decryptVaultSecretWith("credentials-key-correct", enc), "s3cret-value")
})

test("a masked replacement is not a new secret", () => {
  assert.equal(usableVaultSecret("••••"), undefined)
  assert.equal(usableVaultSecret("[redacted]"), undefined)
  assert.equal(usableVaultSecret("real-secret"), "real-secret")
})

async function ensureDevice(id: string, hostname: string): Promise<void> {
  await prisma.device.upsert({
    where: { id },
    create: {
      id,
      hostname,
      platform: "linux",
      arch: "amd64",
      agentVersion: "test",
      enrollmentKeyHash: hostname,
    },
    update: {},
  })
}

test("vault list and detail stay masked, scope is device-only, update and delete audit without the secret", async () => {
  await ensureDevice(DEVICE_A, "vault-scope-a")
  await ensureDevice(DEVICE_B, "vault-scope-b")
  const secret = "vault-plain-secret"
  const created = await createStoredCredential({
    deviceId: DEVICE_A,
    scope: "device",
    target: "app:demo",
    username: "ops",
    secret,
    actor: "tester",
  })
  assert.equal("secret" in created, false)
  assert.equal(JSON.stringify(created).includes(secret), false)
  const listedA = await listStoredCredentials(DEVICE_A)
  const listedB = await listStoredCredentials(DEVICE_B)
  assert.equal(listedA.some((row) => row.id === created.id), true)
  assert.equal(listedB.some((row) => row.id === created.id), false)
  assert.equal(JSON.stringify(listedA).includes(secret), false)
  const detail = await listStoredCredentials(DEVICE_A)
  const row = detail.find((item) => item.id === created.id)
  assert.ok(row)
  assert.equal("secret" in row, false)
  const revealed = await revealStoredCredential(DEVICE_A, created.id)
  assert.equal(revealed.secret, secret)
  const updated = await updateStoredCredential({
    deviceId: DEVICE_A,
    id: created.id,
    secret: "vault-plain-next",
    actor: "tester",
  })
  assert.equal(JSON.stringify(updated).includes("vault-plain-next"), false)
  const again = await revealStoredCredential(DEVICE_A, created.id)
  assert.equal(again.secret, "vault-plain-next")
  const masked = await updateStoredCredential({
    deviceId: DEVICE_A,
    id: created.id,
    secret: "••••",
    actor: "tester",
  })
  assert.equal(masked.ok, false)
  const still = await revealStoredCredential(DEVICE_A, created.id)
  assert.equal(still.secret, "vault-plain-next")
  await deleteStoredCredential({ deviceId: DEVICE_A, id: created.id, actor: "tester" })
  const after = await listStoredCredentials(DEVICE_A)
  assert.equal(after.some((item) => item.id === created.id), false)
  const fleet = await createStoredCredential({
    deviceId: null,
    scope: "fleet",
    target: "fleet:smtp",
    username: "mail",
    secret: "fleet-secret",
    actor: "tester",
  })
  const onA = await listStoredCredentials(DEVICE_A)
  const onB = await listStoredCredentials(DEVICE_B)
  assert.equal(onA.some((item) => item.id === fleet.id), false)
  assert.equal(onB.some((item) => item.id === fleet.id), false)
  const fleetRows = await listStoredCredentials(null)
  assert.equal(fleetRows.some((item) => item.id === fleet.id), true)
  assert.equal(JSON.stringify(fleetRows).includes("fleet-secret"), false)
  const audits = await prisma.auditLog.findMany({
    where: { action: { in: ["credential_create", "credential_update", "credential_delete"] } },
    orderBy: { at: "desc" },
    take: 10,
  })
  const blob = JSON.stringify(audits)
  assert.equal(blob.includes("vault-plain-secret"), false)
  assert.equal(blob.includes("vault-plain-next"), false)
  assert.equal(blob.includes("fleet-secret"), false)
  assert.equal(audits.some((row) => row.action === "credential_create" && row.detail.includes("app:demo")), true)
  assert.equal(audits.some((row) => row.action === "credential_update" && row.detail.includes("app:demo")), true)
  assert.equal(audits.some((row) => row.action === "credential_delete" && row.detail.includes("app:demo")), true)
  await deleteStoredCredential({ deviceId: null, id: fleet.id, actor: "tester" })
  await prisma.device.delete({ where: { id: DEVICE_B } }).catch(() => undefined)
})
