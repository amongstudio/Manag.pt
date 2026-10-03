import { prisma } from "@workspace/db"

import { appendAudit } from "./audit.js"
import { decryptVaultSecret, encryptVaultSecret, toPublicVault, usableVaultSecret, type PublicVaultCredential } from "./vault.js"

export { usableVaultSecret }

export type StoredCredential = PublicVaultCredential & { scope: string; deviceId: string | null }

function credKeyOf(target: string, username: string): string {
  return `vault|${target}|${username}`.toLowerCase()
}

function present(row: {
  id: string
  deviceId: string | null
  scope: string
  credKey: string
  source: string
  kind: string
  target: string
  username: string
  persist: string | null
  comment: string | null
  browser: string | null
  profile: string | null
  lastWritten: string | null
  secretEnc: string
  backedUpAt: Date
}): StoredCredential {
  return { ...toPublicVault(row), scope: row.scope, deviceId: row.deviceId }
}

function auditDetail(name: string, deviceId: string | null, scope: string) {
  return { name: name.slice(0, 256), deviceId, scope }
}

export async function listStoredCredentials(deviceId: string | null): Promise<StoredCredential[]> {
  const rows = await prisma.deviceCredential.findMany({
    where: deviceId == null ? { scope: "fleet" } : { deviceId, scope: "device" },
    orderBy: [{ target: "asc" }],
  })
  return rows.map(present)
}

export async function createStoredCredential(input: {
  deviceId: string | null
  scope: "device" | "fleet"
  target: string
  username?: string
  secret: string
  comment?: string
  source?: string
  actor: string
}): Promise<StoredCredential> {
  const secret = usableVaultSecret(input.secret)
  if (!secret) throw new Error("secret_required")
  const target = input.target.trim()
  if (!target) throw new Error("target_required")
  const scope = input.scope === "fleet" ? "fleet" : "device"
  const deviceId = scope === "fleet" ? null : input.deviceId
  if (scope === "device" && !deviceId) throw new Error("device_required")
  const username = input.username?.trim() ?? ""
  const credKey = credKeyOf(target, username)
  if (scope === "fleet") {
    const existing = await prisma.deviceCredential.findFirst({ where: { scope: "fleet", credKey } })
    if (existing) throw new Error("exists")
  }
  const row = await prisma.deviceCredential.create({
    data: {
      deviceId,
      scope,
      credKey,
      source: input.source || "vault",
      kind: "generic",
      target,
      username,
      comment: input.comment,
      secretEnc: encryptVaultSecret(secret),
    },
  })
  await appendAudit({
    actor: input.actor,
    action: "credential_create",
    deviceId,
    detail: auditDetail(target, deviceId, scope),
  })
  return present(row)
}

export async function updateStoredCredential(input: {
  deviceId: string | null
  id: string
  secret: string
  actor: string
}): Promise<{ ok: true; credential: StoredCredential } | { ok: false; error: string }> {
  const secret = usableVaultSecret(input.secret)
  if (!secret) return { ok: false, error: "secret_required" }
  const row = await prisma.deviceCredential.findFirst({
    where: input.deviceId == null ? { id: input.id, scope: "fleet" } : { id: input.id, deviceId: input.deviceId, scope: "device" },
  })
  if (!row) return { ok: false, error: "not_found" }
  const next = await prisma.deviceCredential.update({
    where: { id: row.id },
    data: { secretEnc: encryptVaultSecret(secret), backedUpAt: new Date() },
  })
  await appendAudit({
    actor: input.actor,
    action: "credential_update",
    deviceId: row.deviceId,
    detail: auditDetail(row.target, row.deviceId, row.scope),
  })
  return { ok: true, credential: present(next) }
}

export async function deleteStoredCredential(input: { deviceId: string | null; id: string; actor: string }): Promise<boolean> {
  const row = await prisma.deviceCredential.findFirst({
    where: input.deviceId == null ? { id: input.id, scope: "fleet" } : { id: input.id, deviceId: input.deviceId, scope: "device" },
  })
  if (!row) return false
  await prisma.deviceCredential.delete({ where: { id: row.id } })
  await appendAudit({
    actor: input.actor,
    action: "credential_delete",
    deviceId: row.deviceId,
    detail: auditDetail(row.target, row.deviceId, row.scope),
  })
  return true
}

export async function revealStoredCredential(deviceId: string | null, id: string): Promise<{ target: string; secret: string }> {
  const row = await prisma.deviceCredential.findFirst({
    where: deviceId == null ? { id, scope: "fleet" } : { id, deviceId, scope: "device" },
  })
  if (!row?.secretEnc) throw new Error("not_found")
  return { target: row.target, secret: decryptVaultSecret(row.secretEnc) }
}
