import { z } from "zod"

/** winget package identifiers, e.g. `Git.Git`, `7zip.7zip`, `Microsoft.PowerToys`. */
export const WINGET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/
export const PACKAGE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/
export const MSI_PRODUCT_CODE_PATTERN =
  /^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$/

export const wingetIdSchema = z
  .string()
  .regex(WINGET_ID_PATTERN, "invalid winget package id")
export const packageVersionSchema = z
  .string()
  .regex(PACKAGE_VERSION_PATTERN, "invalid package version")
export const msiProductCodeSchema = z
  .string()
  .regex(MSI_PRODUCT_CODE_PATTERN, "invalid MSI product code")

/**
 * Local SAM account names: 1-20 chars, none of `"/\[]:;|=,+*?<>@`, no control
 * characters, not only dots/spaces, and no leading `-`. Rejects `DOMAIN\user`
 * and `user@domain` so actions can only target accounts on the managed device.
 */
export function isLocalAccountName(value: string): boolean {
  if (value.length < 1 || value.length > 20) return false
  if (/["/\\[\]:;|=,+*?<>@\x00-\x1f\x7f]/.test(value)) return false
  if (/^[. ]+$/.test(value)) return false
  if (value.startsWith("-")) return false
  return value.trim() === value
}

export const localAccountNameSchema = z
  .string()
  .refine(isLocalAccountName, "invalid local account name")

export const LOCAL_USER_ACTIONS = ["enable", "disable", "set_password"] as const
export type LocalUserAction = (typeof LOCAL_USER_ACTIONS)[number]
export const LOCAL_PASSWORD_MIN = 8
export const LOCAL_PASSWORD_MAX = 127

export function localUserActionConfirm(
  action: LocalUserAction,
  username: string
): string {
  if (action === "set_password") {
    return `Set a new password for the local account ${username}? The new password is sealed in the command payload and never stored in command history. The current password is not read or shown.`
  }
  return `${action === "enable" ? "Enable" : "Disable"} the local account ${username} on this device? This is written to the audit log.`
}

export const SCAN_TOOLS = ["nmap", "nuclei", "trivy"] as const
export type ScanTool = (typeof SCAN_TOOLS)[number]

/** Scan command kinds grouped by the tool that produced them (Trivy runs inside host posture). */
export const SCAN_TOOL_KINDS: Record<ScanTool, string> = {
  nmap: "network_scan",
  nuclei: "nuclei_scan",
  trivy: "host_posture",
}

export function scanToolInstallConfirm(tool: ScanTool): string {
  const extra =
    tool === "nmap"
      ? " nmap's bundled Microsoft Visual C++ runtime is also installed silently. Npcap is not installed, so scans use TCP connect mode."
      : tool === "trivy"
        ? " The Trivy vulnerability database is downloaded into the same directory."
        : ""
  return `Download and install the pinned official ${tool} release on this device? The agent verifies the SHA-256 before extracting into its own tools directory.${extra}`
}

export const CONNECTIONS_POLL_MIN_MS = 5_000
export const CONNECTIONS_POLL_MAX_MS = 5 * 60_000
export const CONNECTIONS_LIMIT_MAX = 1000

export function softwareUninstallConfirm(name: string): string {
  return `Uninstall ${name} from this device? MSI products use msiexec /x; others use winget or the vendor's quiet uninstaller. Interactive uninstallers are refused.`
}

export function softwareInstallConfirm(id: string): string {
  return `Install winget package ${id} on this device? It runs winget install --id ${id} --exact --silent with no shell.`
}

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

export type NetConnection = {
  protocol: string
  localAddr: string
  localPort: number
  remoteAddr?: string
  remotePort?: number
  state?: string
  pid?: number
  process?: string
}

export type ConnectionsSnapshot = {
  connections: NetConnection[]
  interfaces: Array<{ name: string; bytesSent: number; bytesRecv: number }>
  processIo: Array<{
    pid: number
    process?: string
    readBytes: number
    writeBytes: number
  }>
  total: number
  truncated: boolean
  collectedAt?: string
  byteCounts?: string
}

/** get_connections result: socket metadata and counters only, never payloads. */
export function parseConnectionsResult(
  raw: unknown
): ConnectionsSnapshot | null {
  const row = rec(raw)
  if (!row || !Array.isArray(row.connections)) return null
  const connections = row.connections
    .slice(0, CONNECTIONS_LIMIT_MAX)
    .flatMap((item): NetConnection[] => {
      const c = rec(item)
      if (!c || typeof c.localAddr !== "string") return []
      return [
        {
          protocol: str(c.protocol) ?? "tcp",
          localAddr: c.localAddr,
          localPort: num(c.localPort),
          remoteAddr: str(c.remoteAddr),
          remotePort: num(c.remotePort) || undefined,
          state: str(c.state),
          pid: num(c.pid) || undefined,
          process: str(c.process),
        },
      ]
    })
  const interfaces = (
    Array.isArray(row.interfaces) ? row.interfaces : []
  ).flatMap((item) => {
    const i = rec(item)
    return i && typeof i.name === "string"
      ? [
          {
            name: i.name,
            bytesSent: num(i.bytesSent),
            bytesRecv: num(i.bytesRecv),
          },
        ]
      : []
  })
  const processIo = (Array.isArray(row.processIo) ? row.processIo : []).flatMap(
    (item) => {
      const p = rec(item)
      return p && num(p.pid)
        ? [
            {
              pid: num(p.pid),
              process: str(p.process),
              readBytes: num(p.readBytes),
              writeBytes: num(p.writeBytes),
            },
          ]
        : []
    }
  )
  return {
    connections,
    interfaces,
    processIo,
    total: num(row.total) || connections.length,
    truncated: row.truncated === true,
    collectedAt: str(row.collectedAt),
    byteCounts: str(row.byteCounts),
  }
}

export type LocalUserRow = {
  name: string
  fullName?: string
  comment?: string
  sid?: string
  enabled: boolean
  lockedOut: boolean
  admin: boolean
  privilege?: string
  passwordRequired: boolean
  passwordCanChange: boolean
  passwordExpires: boolean
  passwordExpired: boolean
  passwordAgeDays: number
  lastLogon?: string
  accountExpires?: string
  badPasswordCount: number
  logonCount: number
}

/** get_local_users result. The agent never returns password hashes or values. */
export function parseLocalUsersResult(
  raw: unknown
): { users: LocalUserRow[]; computer?: string; truncated: boolean } | null {
  const row = rec(raw)
  if (!row || !Array.isArray(row.users)) return null
  const users = row.users.flatMap((item): LocalUserRow[] => {
    const u = rec(item)
    if (!u || typeof u.name !== "string" || !u.name) return []
    return [
      {
        name: u.name,
        fullName: str(u.fullName),
        comment: str(u.comment),
        sid: str(u.sid),
        enabled: u.enabled === true,
        lockedOut: u.lockedOut === true,
        admin: u.admin === true,
        privilege: str(u.privilege),
        passwordRequired: u.passwordRequired === true,
        passwordCanChange: u.passwordCanChange === true,
        passwordExpires: u.passwordExpires === true,
        passwordExpired: u.passwordExpired === true,
        passwordAgeDays: num(u.passwordAgeDays),
        lastLogon: str(u.lastLogon),
        accountExpires: str(u.accountExpires),
        badPasswordCount: num(u.badPasswordCount),
        logonCount: num(u.logonCount),
      },
    ]
  })
  return {
    users,
    computer: str(row.computer),
    truncated: row.truncated === true,
  }
}

export type ScanToolStatus = {
  tool: ScanTool
  available: boolean
  path?: string
  source?: string
  version?: string
  pinned?: string
  canInstall: boolean
  error?: string
  notes: string[]
}

/** get_scan_tools result: `{ tools, rawScan }`. Unknown tools are dropped. */
export function parseScanToolsResult(
  raw: unknown
): { tools: ScanToolStatus[]; rawScan: boolean } | null {
  const row = rec(raw)
  if (!row || !Array.isArray(row.tools)) return null
  const tools = row.tools.flatMap((item): ScanToolStatus[] => {
    const t = rec(item)
    if (!t || !(SCAN_TOOLS as readonly unknown[]).includes(t.tool)) return []
    return [
      {
        tool: t.tool as ScanTool,
        available: t.available === true,
        path: str(t.path),
        source: str(t.source),
        version: str(t.version),
        pinned: str(t.pinned),
        canInstall: t.canInstall === true,
        error: str(t.error),
        notes: Array.isArray(t.notes)
          ? t.notes
              .filter((n): n is string => typeof n === "string")
              .slice(0, 10)
          : [],
      },
    ]
  })
  return { tools, rawScan: row.rawScan === true }
}

export function vaultClearConfirm(count: number): string {
  return `Clear ${count} stored vault secret${count === 1 ? "" : "s"} for this device? Entries stay as metadata only, secrets are deleted from the dashboard, and the device's own credential stores are not changed. This cannot be undone.`
}
