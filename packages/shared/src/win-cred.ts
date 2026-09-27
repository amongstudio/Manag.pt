export const CREDENTIAL_COMMAND_TYPES = [
  "get_credentials",
  "backup_credentials",
  "set_credential",
  "delete_credential",
  "generate_credential",
  "restore_credentials",
] as const

export type CredentialCommandType = (typeof CREDENTIAL_COMMAND_TYPES)[number]

const CREDENTIAL_COMMAND_SET = new Set<string>(CREDENTIAL_COMMAND_TYPES)

export function isCredentialCommandType(type: string): type is CredentialCommandType {
  return CREDENTIAL_COMMAND_SET.has(type)
}

export type VaultCredential = {
  key: string
  source: string
  kind: string
  target: string
  username?: string
  secret?: string
  persist?: string
  comment?: string
  lastWritten?: string
  browser?: string
  profile?: string
  locked?: boolean
  store?: string
}

export type CredentialCounts = {
  windows: number
  browser: number
  apps: number
  generated: number
  locked: number
  total: number
}

export type ParsedCredentials = {
  credentials: VaultCredential[]
  truncated: boolean
  revealed: boolean
  sessionOk: boolean
  needsSession: boolean
  browserLocked: boolean
  session0: boolean
  sessionId?: number
  sessionUser?: string
  sessionState?: string
  impersonationOk: boolean
  notes: string[]
  counts: CredentialCounts
  generated?: boolean
  vaulted?: number
}

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

export function parseCredentials(result: unknown): ParsedCredentials {
  const row = rec(result)
  const credentials: VaultCredential[] = []
  const raw = row && Array.isArray(row.credentials) ? row.credentials : Array.isArray(result) ? result : []
  for (const item of raw) {
    const c = rec(item)
    if (!c) continue
    const target = typeof c.target === "string" ? c.target : ""
    const key = typeof c.key === "string" && c.key ? c.key : target
    if (!target && !key) continue
    credentials.push({
      key,
      source: typeof c.source === "string" ? c.source : "windows",
      kind: typeof c.kind === "string" ? c.kind : "generic",
      target: target || key,
      username: typeof c.username === "string" ? c.username : undefined,
      secret: typeof c.secret === "string" ? c.secret : undefined,
      persist: typeof c.persist === "string" ? c.persist : undefined,
      comment: typeof c.comment === "string" ? c.comment : undefined,
      lastWritten: typeof c.lastWritten === "string" ? c.lastWritten : undefined,
      browser: typeof c.browser === "string" ? c.browser : undefined,
      profile: typeof c.profile === "string" ? c.profile : undefined,
      locked: c.locked === true,
      store: typeof c.store === "string" ? c.store : undefined,
    })
  }
  const notes = Array.isArray(row?.notes)
    ? row.notes.filter((item): item is string => typeof item === "string" && item.length > 0)
    : []
  const countsRaw = rec(row?.counts)
  const counts: CredentialCounts = {
    windows: typeof countsRaw?.windows === "number" ? countsRaw.windows : 0,
    browser: typeof countsRaw?.browser === "number" ? countsRaw.browser : 0,
    apps: typeof countsRaw?.apps === "number" ? countsRaw.apps : 0,
    generated: typeof countsRaw?.generated === "number" ? countsRaw.generated : 0,
    locked: typeof countsRaw?.locked === "number" ? countsRaw.locked : 0,
    total: typeof countsRaw?.total === "number" ? countsRaw.total : credentials.length,
  }
  if (!countsRaw) {
    for (const item of credentials) {
      if (item.source === "browser") counts.browser++
      else if (item.source === "apps") counts.apps++
      else if (item.source === "generated") counts.generated++
      else counts.windows++
      if (item.locked) counts.locked++
    }
    counts.total = credentials.length
  }
  return {
    credentials,
    truncated: Boolean(row?.truncated),
    revealed: Boolean(row?.revealed),
    sessionOk: Boolean(row?.sessionOk),
    needsSession: Boolean(row?.needsSession),
    browserLocked: Boolean(row?.browserLocked),
    session0: Boolean(row?.session0),
    sessionId: typeof row?.sessionId === "number" ? row.sessionId : undefined,
    sessionUser: typeof row?.sessionUser === "string" ? row.sessionUser : undefined,
    sessionState: typeof row?.sessionState === "string" ? row.sessionState : undefined,
    impersonationOk: Boolean(row?.impersonationOk),
    notes,
    counts,
    generated: Boolean(row?.generated),
    vaulted: typeof row?.vaulted === "number" ? row.vaulted : undefined,
  }
}

export function credentialKey(source: string, target: string, username?: string): string {
  return `${source}|${target}|${username ?? ""}`.toLowerCase()
}

function isSecretField(key: string): boolean {
  switch (key) {
    case "secret":
    case "password":
    case "secretEnc":
    case "passwordEnc":
    case "recoveryPassword":
    case "recoveryPasswordEnc":
      return true
    default:
      return false
  }
}

/** Commands whose payload/result must not keep plaintext secrets in history, WS, or alerts. */
export function needsSecretRedaction(type: string): boolean {
  return isCredentialCommandType(type) || type === "smb_connect" || type === "set_bitlocker"
}

/** Strip plaintext secrets from credential command payloads/results before history or logs. */
export function stripCredentialSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stripCredentialSecrets(item))
  const row = rec(value)
  if (!row) return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(row)) {
    if (isSecretField(key)) {
      if (typeof item === "string" && item.length > 0) out[key] = "[redacted]"
      continue
    }
    out[key] = stripCredentialSecrets(item)
  }
  return out
}

/** Drop secret fields entirely so mesh peers cannot receive smb_connect/credential passwords. */
export function stripMeshCommandSecrets(type: string, payload: Record<string, unknown>): Record<string, unknown> {
  if (!needsSecretRedaction(type)) return payload
  return dropSecretFields(payload) as Record<string, unknown>
}

function dropSecretFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => dropSecretFields(item))
  const row = rec(value)
  if (!row) return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(row)) {
    if (isSecretField(key)) continue
    out[key] = dropSecretFields(item)
  }
  return out
}

export function redactCredentialCommand(
  type: string,
  payload: unknown,
  result: unknown
): { payload: unknown; result: unknown } {
  if (!needsSecretRedaction(type)) return { payload, result }
  return { payload: stripCredentialSecrets(payload), result: stripCredentialSecrets(result) }
}

export function credentialRevealConfirm(target: string): string {
  return `Reveal the secret for ${target}? Browser passwords need the signed-in desktop session (Chromium DPAPI / Firefox NSS). The value is stored encrypted on the dashboard and is not kept in command history.`
}

export function credentialWriteConfirm(target: string): string {
  return `Write credential ${target} on this agent with CredWrite? The secret is stored encrypted on the dashboard (AES-256-GCM) and stripped from command history.`
}

export function credentialDeleteConfirm(target: string): string {
  return `Delete credential ${target} from this agent's Windows Credential Manager? The dashboard vault copy is kept until you remove it separately.`
}

export function credentialBackupConfirm(): string {
  return "Back up Windows, app, and browser credentials from this agent to the encrypted dashboard vault? Secrets are stored with AES-256-GCM and stripped from command history. Chromium DPAPI and Firefox NSS decryption need an unlocked interactive session."
}

export function credentialRestoreConfirm(count: number): string {
  return `Restore ${count} vault credential(s) onto this agent's Windows Credential Manager with CredWrite?`
}

export function credentialGenerateConfirm(save: boolean): string {
  return save
    ? "Generate a password, save it with CredWrite on this agent, and store it encrypted on the dashboard?"
    : "Generate a password and store it encrypted on the dashboard (not written to the agent until you save)?"
}

export function credentialBatchRestoreConfirm(count: number): string {
  return `Restore ${count} selected vault credential(s) onto this agent's user Credential Manager? Browser secrets are skipped (no safe Chromium/NSS write path). SYSTEM-store entries are not written.`
}

export function credentialVaultDeleteConfirm(target: string): string {
  return `Remove the dashboard vault copy of ${target}? The agent Credential Manager entry is left in place.`
}
