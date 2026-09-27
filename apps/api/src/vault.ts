import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto"

import { prisma } from "@workspace/db"
import {
  isCredentialCommandType,
  MESH_FORWARD_KEY,
  needsSecretRedaction,
  redactCredentialCommand,
  stripCredentialSecrets,
  stripMeshCommandSecrets,
  type VaultCredential,
} from "@workspace/shared"

import { env } from "./env.js"

const HKDF_SALT = "pcmanager-vault-v1"
const HKDF_INFO = "credential-vault"
const PREFIX = "v1:"

function vaultKey(): Buffer {
  return Buffer.from(hkdfSync("sha256", env.updateSigningSecret, HKDF_SALT, HKDF_INFO, 32))
}

export function encryptVaultSecret(plain: string): string {
  if (!plain) return ""
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", vaultKey(), iv)
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return PREFIX + Buffer.concat([iv, tag, ct]).toString("base64")
}

export function decryptVaultSecret(enc: string): string {
  const raw = enc.trim()
  if (!raw) return ""
  if (!raw.startsWith(PREFIX)) throw new Error("unsupported_vault_version")
  const buf = Buffer.from(raw.slice(PREFIX.length), "base64")
  if (buf.length < 12 + 16) throw new Error("invalid_vault_blob")
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const ct = buf.subarray(28)
  const decipher = createDecipheriv("aes-256-gcm", vaultKey(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8")
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function credKeyOf(c: { source?: string; target?: string; username?: string; key?: string }): string {
  if (c.key && c.key.trim()) return c.key.trim().toLowerCase()
  return `${c.source ?? "windows"}|${c.target ?? ""}|${c.username ?? ""}`.toLowerCase()
}

export type VaultRowInput = {
  source: string
  kind?: string
  target: string
  username?: string
  persist?: string
  comment?: string
  browser?: string
  profile?: string
  lastWritten?: string
  key?: string
  secret?: string
}

function usableSecret(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value === "[redacted]") return undefined
  return value
}

export async function upsertVaultEntry(deviceId: string, input: VaultRowInput): Promise<{ id: string; credKey: string }> {
  const credKey = credKeyOf(input)
  const secretEnc = usableSecret(input.secret) ? encryptVaultSecret(input.secret as string) : ""
  const row = await prisma.deviceCredential.upsert({
    where: { deviceId_credKey: { deviceId, credKey } },
    create: {
      deviceId,
      credKey,
      source: input.source || "windows",
      kind: input.kind || "generic",
      target: input.target,
      username: input.username ?? "",
      persist: input.persist,
      comment: input.comment,
      browser: input.browser,
      profile: input.profile,
      lastWritten: input.lastWritten,
      secretEnc,
    },
    update: {
      source: input.source || "windows",
      kind: input.kind || "generic",
      target: input.target,
      username: input.username ?? "",
      persist: input.persist,
      comment: input.comment,
      browser: input.browser,
      profile: input.profile,
      lastWritten: input.lastWritten,
      ...(secretEnc ? { secretEnc, backedUpAt: new Date() } : {}),
    },
  })
  return { id: row.id, credKey: row.credKey }
}

function vaultInputFromUnknown(item: unknown): VaultRowInput | null {
  const c = asRecord(item)
  if (!c) return null
  const target = typeof c.target === "string" ? c.target : ""
  if (!target) return null
  return {
    key: typeof c.key === "string" ? c.key : undefined,
    source: typeof c.source === "string" ? c.source : "windows",
    kind: typeof c.kind === "string" ? c.kind : "generic",
    target,
    username: typeof c.username === "string" ? c.username : "",
    persist: typeof c.persist === "string" ? c.persist : undefined,
    comment: typeof c.comment === "string" ? c.comment : undefined,
    browser: typeof c.browser === "string" ? c.browser : undefined,
    profile: typeof c.profile === "string" ? c.profile : undefined,
    lastWritten: typeof c.lastWritten === "string" ? c.lastWritten : undefined,
    secret: usableSecret(c.secret),
  }
}

export async function ingestCredentialResult(deviceId: string, type: string, result: unknown): Promise<unknown> {
  if ((!isCredentialCommandType(type) && type !== "set_bitlocker") || result == null) {
    if (needsSecretRedaction(type)) return stripCredentialSecrets(result)
    return result
  }
  const row = asRecord(result)
  let vaulted = 0
  if (type === "backup_credentials" || type === "set_bitlocker") {
    const list = row && Array.isArray(row.credentials) ? row.credentials : Array.isArray(result) ? result : []
    for (const item of list) {
      const input = vaultInputFromUnknown(item)
      if (!input) continue
      if (type === "set_bitlocker" && !input.source) input.source = "bitlocker"
      await upsertVaultEntry(deviceId, input)
      vaulted++
    }
    if (type === "set_bitlocker" && row) {
      const secret = usableSecret(row.recoveryPassword)
      const target = typeof row.mountPoint === "string" ? row.mountPoint : ""
      if (secret && target) {
        await upsertVaultEntry(deviceId, {
          source: "bitlocker",
          kind: "recovery_key",
          target,
          secret,
          comment: typeof row.protectorId === "string" ? `BitLocker recovery password ${row.protectorId}` : "BitLocker recovery password",
        })
        vaulted++
      }
    }
  }
  if (type === "set_credential") {
    const input = vaultInputFromUnknown(result)
    if (input) {
      await upsertVaultEntry(deviceId, input)
      vaulted++
    }
  }
  if (type === "generate_credential" && row) {
    const password = usableSecret(row.password) ?? ""
    const saved = vaultInputFromUnknown(row.saved)
    if (saved) {
      if (!saved.secret && password) saved.secret = password
      const stored = await upsertVaultEntry(deviceId, saved)
      vaulted++
      const stripped = stripCredentialSecrets(result) as Record<string, unknown>
      stripped.generated = true
      stripped.vaultId = stored.id
      stripped.vaulted = vaulted
      return stripped
    }
    if (password) {
      const stored = await upsertVaultEntry(deviceId, {
        source: "generated",
        kind: "password",
        target: `generated:${new Date().toISOString()}`,
        secret: password,
      })
      vaulted++
      const stripped = stripCredentialSecrets(result) as Record<string, unknown>
      stripped.generated = true
      stripped.vaultId = stored.id
      stripped.vaulted = vaulted
      return stripped
    }
  }
  const stripped = stripCredentialSecrets(result) as Record<string, unknown>
  if (vaulted) stripped.vaulted = vaulted
  return stripped
}

export async function prepareCredentialCommand(
  deviceId: string,
  type: string,
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (type === "set_credential") {
    const target = typeof payload.target === "string" ? payload.target : ""
    if (target && usableSecret(payload.secret)) {
      await upsertVaultEntry(deviceId, {
        source: typeof payload.source === "string" ? payload.source : "windows",
        target,
        username: typeof payload.username === "string" ? payload.username : "",
        secret: usableSecret(payload.secret),
        persist: typeof payload.persist === "string" ? payload.persist : undefined,
        comment: typeof payload.comment === "string" ? payload.comment : undefined,
      })
    }
  }
  if (type === "restore_credentials" && Array.isArray(payload.credentials)) {
    for (const item of payload.credentials) {
      const input = vaultInputFromUnknown(item)
      if (input?.secret) await upsertVaultEntry(deviceId, input)
    }
  }
  return sealCommandPayload(type, payload)
}

export function sealCommandPayload(type: string, payload: Record<string, unknown>): Record<string, unknown> {
  if (type === "smb_connect" || type === "set_bitlocker") {
    if (typeof payload[MESH_FORWARD_KEY] === "string" && payload[MESH_FORWARD_KEY]) {
      return stripMeshCommandSecrets(type, payload)
    }
    const next: Record<string, unknown> = { ...payload }
    if (typeof next.password === "string" && next.password.length > 0) {
      next.passwordEnc = encryptVaultSecret(next.password as string)
      delete next.password
    }
    if (typeof next.recoveryPassword === "string" && next.recoveryPassword.length > 0) {
      next.recoveryPasswordEnc = encryptVaultSecret(next.recoveryPassword as string)
      delete next.recoveryPassword
    }
    return next
  }
  if (!isCredentialCommandType(type)) return payload
  if (type === "set_credential" && typeof payload.secret === "string") {
    const next: Record<string, unknown> = { ...payload, secretEnc: encryptVaultSecret(payload.secret) }
    delete next.secret
    return next
  }
  if (type === "restore_credentials" && Array.isArray(payload.credentials)) {
    return {
      ...payload,
      credentials: payload.credentials.map((item) => {
        const c = asRecord(item)
        if (!c || typeof c.secret !== "string") return item
        const next: Record<string, unknown> = { ...c, secretEnc: encryptVaultSecret(c.secret) }
        delete next.secret
        return next
      }),
    }
  }
  return payload
}

export function hydrateCommandPayload(type: string, payload: unknown): unknown {
  const row = asRecord(payload)
  if (!row) return payload
  if ((type === "smb_connect" || type === "set_bitlocker") && (row.passwordEnc || row.recoveryPasswordEnc)) {
    const next: Record<string, unknown> = { ...row }
    if (typeof row.passwordEnc === "string" && !row.password) {
      try {
        next.password = decryptVaultSecret(row.passwordEnc)
        delete next.passwordEnc
      } catch {
        /* keep encoded */
      }
    }
    if (typeof row.recoveryPasswordEnc === "string" && !row.recoveryPassword) {
      try {
        next.recoveryPassword = decryptVaultSecret(row.recoveryPasswordEnc)
        delete next.recoveryPasswordEnc
      } catch {
        /* keep encoded */
      }
    }
    return next
  }
  if (!isCredentialCommandType(type)) return payload
  if (type === "set_credential" && typeof row.secretEnc === "string" && !row.secret) {
    try {
      const next: Record<string, unknown> = { ...row, secret: decryptVaultSecret(row.secretEnc) }
      delete next.secretEnc
      return next
    } catch {
      return row
    }
  }
  if (type === "restore_credentials" && Array.isArray(row.credentials)) {
    return {
      ...row,
      credentials: row.credentials.map((item) => {
        const c = asRecord(item)
        if (!c || typeof c.secretEnc !== "string" || c.secret) return item
        try {
          const next: Record<string, unknown> = { ...c, secret: decryptVaultSecret(c.secretEnc) }
          delete next.secretEnc
          return next
        } catch {
          return c
        }
      }),
    }
  }
  return payload
}

export function serializeCredentialCommand<T extends { type?: string; payload: unknown; result: unknown }>(
  type: string,
  row: T
): T {
  const redacted = redactCredentialCommand(type, row.payload, row.result)
  return { ...row, payload: redacted.payload, result: redacted.result }
}

export type PublicVaultCredential = Omit<VaultCredential, "secret"> & {
  id: string
  hasSecret: boolean
  backedUpAt: string
}

export function toPublicVault(row: {
  id: string
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
}): PublicVaultCredential {
  return {
    id: row.id,
    key: row.credKey,
    source: row.source,
    kind: row.kind,
    target: row.target,
    username: row.username || undefined,
    persist: row.persist || undefined,
    comment: row.comment || undefined,
    browser: row.browser || undefined,
    profile: row.profile || undefined,
    lastWritten: row.lastWritten || undefined,
    hasSecret: Boolean(row.secretEnc),
    backedUpAt: row.backedUpAt.toISOString(),
  }
}
