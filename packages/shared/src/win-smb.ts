import { resultErrorMessage, unwrapCommandResult } from "./command-result.ts"

export type SmbShare = {
  name: string
  path: string
  kind: string
  remark?: string
  drive?: string
  remote?: string
  connected: boolean
  hosted?: boolean
  status?: string
  username?: string
}

export type ParsedSmbShares = {
  shares: SmbShare[]
  truncated: boolean
}

export type SmbEntry = {
  name: string
  path: string
  dir: boolean
  size?: number
  mode?: string
  mtime?: string
}

export type ParsedSmbDir = {
  path: string
  entries: SmbEntry[]
  truncated: boolean
}

export type ParsedSmbConnect = {
  unc: string
  connected: boolean
  drive?: string
  action: string
}

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

export function parseSmbShares(result: unknown): ParsedSmbShares {
  const row = rec(unwrapCommandResult(result))
  const shares: SmbShare[] = []
  const raw = row && Array.isArray(row.shares) ? row.shares : []
  for (const item of raw) {
    const s = rec(item)
    if (!s) continue
    const path = typeof s.path === "string" ? s.path : ""
    const name = typeof s.name === "string" && s.name ? s.name : path
    if (!path && !name) continue
    shares.push({
      name,
      path: path || name,
      kind: typeof s.kind === "string" ? s.kind : "session",
      remark: typeof s.remark === "string" ? s.remark : undefined,
      drive: typeof s.drive === "string" ? s.drive : undefined,
      remote: typeof s.remote === "string" ? s.remote : undefined,
      connected: s.connected === true,
      hosted: s.hosted === true,
      status: typeof s.status === "string" ? s.status : undefined,
      username: typeof s.username === "string" ? s.username : undefined,
    })
  }
  return { shares, truncated: Boolean(row?.truncated) }
}

export function parseSmbDir(result: unknown): ParsedSmbDir {
  const row = rec(unwrapCommandResult(result))
  const entries: SmbEntry[] = []
  const raw = row && Array.isArray(row.entries) ? row.entries : []
  for (const item of raw) {
    const e = rec(item)
    if (!e) continue
    const name = typeof e.name === "string" ? e.name : ""
    const path = typeof e.path === "string" ? e.path : ""
    if (!name && !path) continue
    entries.push({
      name: name || path,
      path: path || name,
      dir: e.dir === true,
      size: typeof e.size === "number" ? e.size : undefined,
      mode: typeof e.mode === "string" ? e.mode : undefined,
      mtime: typeof e.mtime === "string" ? e.mtime : undefined,
    })
  }
  return { path: typeof row?.path === "string" ? row.path : "", entries, truncated: Boolean(row?.truncated) }
}

export function parseSmbConnect(result: unknown): ParsedSmbConnect | null {
  const row = rec(result)
  if (!row) return null
  const unc = typeof row.unc === "string" ? row.unc : ""
  const action = typeof row.action === "string" ? row.action : ""
  if (!unc && !action) return null
  return {
    unc,
    connected: row.connected === true,
    drive: typeof row.drive === "string" ? row.drive : undefined,
    action,
  }
}

export function smbConnectConfirm(unc: string): string {
  return `Connect this agent to SMB share ${unc}? Credentials are used only for WNetAddConnection2 on the device. This does not disable the firewall.`
}

export function smbDisconnectConfirm(target: string): string {
  return `Disconnect SMB mapping ${target} on this agent? Open file handles on that share will drop.`
}

export function isUncPath(p: string): boolean {
  const s = p.trim()
  return s.startsWith("\\\\") || s.startsWith("//")
}

export function smbJoinPath(base: string, name: string): string {
  if (!base) return name
  const n = name.replace(/[/\\]/g, "")
  if (!n || n === "." || n === "..") return base
  return `${normalizeShareBrowse(base).replace(/[/\\]+$/, "")}\\${n}`
}

export function smbPathCrumbs(p: string): Array<{ label: string; path: string }> {
  const s = normalizeShareBrowse(p)
  if (!s) return []
  const unc = isUncPath(s)
  const parts = s.split(/[/\\]/).filter(Boolean)
  if (unc) {
    if (parts.length < 2) return [{ label: s, path: s }]
    const crumbs: Array<{ label: string; path: string }> = []
    let acc = `\\\\${parts[0]}\\${parts[1]}`
    crumbs.push({ label: acc, path: acc })
    for (let i = 2; i < parts.length; i++) {
      acc = `${acc}\\${parts[i]}`
      crumbs.push({ label: parts[i]!, path: acc })
    }
    return crumbs
  }
  const crumbs: Array<{ label: string; path: string }> = []
  let acc = ""
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    if (i === 0 && /^[A-Za-z]:$/.test(part)) {
      acc = `${part.toUpperCase()}\\`
      crumbs.push({ label: part.toUpperCase(), path: acc })
      continue
    }
    acc = acc ? `${acc.replace(/\\+$/, "")}\\${part}` : part
    crumbs.push({ label: part, path: acc })
  }
  return crumbs
}

export function smbParentPath(p: string): string {
  const crumbs = smbPathCrumbs(p)
  if (crumbs.length < 2) return ""
  return crumbs[crumbs.length - 2]!.path
}

const SMB_ERROR_TEXT: Record<string, string> = {
  smb_access_denied:
    "Access denied. The signed-in session cannot open this share. Connect with credentials, or check share / NTFS permissions. If Windows already has a mapping with other credentials, disconnect it first.",
  smb_not_found: "Share or path not found.",
  smb_not_connected:
    "Not a connected or hosted share. Connect to the UNC path, or open a mapped drive / hosted share from the list.",
  invalid_smb_payload: "Invalid SMB path or payload.",
  unsupported: "SMB explorer is Windows-only.",
  no_interactive_session:
    "No signed-in desktop session. Mapped drives and user SMB credentials are not available from Session 0.",
}

export function smbFailureMessage(result: unknown, status?: string, fallback = "SMB command failed"): string {
  const raw = resultErrorMessage(result, status, "")
  if (raw && SMB_ERROR_TEXT[raw]) return SMB_ERROR_TEXT[raw]
  if (raw) return raw
  if (status === "cancelled") return "Cancelled"
  if (status === "timeout") return "Timed out"
  return fallback
}

export function shareBrowsePath(share: Pick<SmbShare, "path" | "remote" | "drive">): string {
  if (share.path?.trim()) return normalizeShareBrowse(share.path)
  if (share.remote?.trim()) return normalizeShareBrowse(share.remote)
  if (share.drive?.trim()) return normalizeShareBrowse(share.drive)
  return ""
}

export function normalizeShareBrowse(p: string): string {
  const s = p.trim().replace(/\//g, "\\")
  if (!s) return ""
  if (/^[A-Za-z]:$/.test(s)) return `${s[0]!.toUpperCase()}:\\`
  if (/^[A-Za-z]:\\$/.test(s)) return `${s[0]!.toUpperCase()}:\\`
  return s
}
