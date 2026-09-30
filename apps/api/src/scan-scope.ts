import fs from "node:fs"
import path from "node:path"

import yaml from "js-yaml"

export type ScanScope = {
  authorizedNetworks: string[]
  excludedHosts: string[]
  scanRateLimit: number
  scanTimeoutMinutes: number
  labMode: boolean
  labNetworks: string[]
  enableVulners: boolean
}

export type AuthResult = { ok: true; target: string } | { ok: false; error: string }

const DEFAULT_SCOPE: ScanScope = {
  authorizedNetworks: ["127.0.0.1/32"],
  excludedHosts: [],
  scanRateLimit: 100,
  scanTimeoutMinutes: 10,
  labMode: true,
  labNetworks: [],
  enableVulners: false,
}

export function parseScanScope(text: string): ScanScope {
  let parsed: unknown
  try {
    parsed = yaml.load(text)
  } catch {
    return { ...DEFAULT_SCOPE }
  }
  const raw = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
  const list = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : []
  const rate = Number(raw.scan_rate_limit)
  const timeout = Number(raw.scan_timeout_minutes)
  return {
    authorizedNetworks: list(raw.authorized_networks),
    excludedHosts: list(raw.excluded_hosts),
    scanRateLimit: Number.isFinite(rate) && rate > 0 ? Math.min(rate, 10_000) : DEFAULT_SCOPE.scanRateLimit,
    scanTimeoutMinutes: Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 120) : DEFAULT_SCOPE.scanTimeoutMinutes,
    labMode: raw.lab_mode !== false,
    labNetworks: list(raw.lab_networks),
    enableVulners: raw.enable_vulners === true,
  }
}

export function scopePath(): string {
  const fromEnv = process.env.SCAN_SCOPE_PATH?.trim()
  if (fromEnv) return fromEnv
  const candidates = [
    path.resolve(process.cwd(), "config/scan-scope.yaml"),
    path.resolve(process.cwd(), "../../config/scan-scope.yaml"),
  ]
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[1]!
}

let scopeOverride: string | null = null

export function setScanScopeOverride(text: string | null): void {
  scopeOverride = text
}

export function loadScanScope(): ScanScope {
  if (scopeOverride != null) return parseScanScope(scopeOverride)
  try {
    return parseScanScope(fs.readFileSync(scopePath(), "utf8"))
  } catch {
    return { ...DEFAULT_SCOPE, labMode: true, authorizedNetworks: ["127.0.0.1/32"] }
  }
}

export function isCidrOrIp(token: string): boolean {
  return parseNet(token.trim()) != null
}

const SCOPE_KEYS = new Set([
  "authorized_networks",
  "excluded_hosts",
  "scan_rate_limit",
  "scan_timeout_minutes",
  "lab_mode",
  "lab_networks",
  "enable_vulners",
])

export function validateScanScopeText(text: string): { ok: true; scope: ScanScope } | { ok: false; error: string } {
  if (text.length > 100_000) return { ok: false, error: "too_large" }
  let parsed: unknown
  try {
    parsed = yaml.load(text)
  } catch {
    return { ok: false, error: "invalid_yaml" }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, error: "invalid_yaml" }
  const raw = parsed as Record<string, unknown>
  for (const key of Object.keys(raw)) {
    if (!SCOPE_KEYS.has(key)) return { ok: false, error: "unknown_key" }
  }
  if ("scan_rate_limit" in raw) {
    const rate = raw.scan_rate_limit
    if (typeof rate !== "number" || !Number.isInteger(rate) || rate <= 0 || rate > 10_000) return { ok: false, error: "invalid_range" }
  }
  if ("scan_timeout_minutes" in raw) {
    const timeout = raw.scan_timeout_minutes
    if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1 || timeout > 120) return { ok: false, error: "invalid_range" }
  }
  if ("lab_mode" in raw && typeof raw.lab_mode !== "boolean") return { ok: false, error: "invalid_body" }
  if ("enable_vulners" in raw && typeof raw.enable_vulners !== "boolean") return { ok: false, error: "invalid_body" }
  for (const key of ["authorized_networks", "excluded_hosts", "lab_networks"] as const) {
    if (!(key in raw)) continue
    if (!Array.isArray(raw[key]) || (raw[key] as unknown[]).some((item) => typeof item !== "string")) {
      return { ok: false, error: "invalid_network" }
    }
  }
  const scope = parseScanScope(text)
  if (!scope.labMode && scope.authorizedNetworks.length === 0) return { ok: false, error: "empty_allowlist" }
  for (const item of [...scope.authorizedNetworks, ...scope.excludedHosts, ...scope.labNetworks]) {
    if (!isCidrOrIp(item)) return { ok: false, error: "invalid_network" }
    if (item === "0.0.0.0/0" || item.endsWith("/0")) return { ok: false, error: "allowlist_too_wide" }
  }
  return { ok: true, scope }
}

function ipv4(ip: string): number | null {
  const parts = ip.split(".")
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    value = (value << 8) | n
  }
  return value >>> 0
}

function parseNet(token: string): { base: number; bits: number } | null {
  const [addr, prefix] = token.split("/")
  const base = ipv4(addr ?? "")
  if (base == null) return null
  const bits = prefix == null || prefix === "" ? 32 : Number(prefix)
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return { base: (base & mask) >>> 0, bits }
}

function contains(outer: { base: number; bits: number }, ip: number): boolean {
  if (outer.bits === 0) return true
  const mask = (0xffffffff << (32 - outer.bits)) >>> 0
  return (ip & mask) >>> 0 === outer.base
}

function within(inner: { base: number; bits: number }, outer: { base: number; bits: number }): boolean {
  if (inner.bits < outer.bits) return false
  return contains(outer, inner.base)
}

function overlaps(a: { base: number; bits: number }, b: { base: number; bits: number }): boolean {
  return contains(a, b.base) || contains(b, a.base)
}

/** Refuse targets outside the YAML allowlist. Accepts an IPv4 address or CIDR only. */
export function authorizeTarget(target: string, scope: ScanScope): AuthResult {
  const trimmed = target.trim()
  if (!trimmed || /[\s"'`$;&|<>\\]/.test(trimmed)) return { ok: false, error: "target_refused" }
  if (trimmed === "::1" || trimmed === "[::1]") {
    if (!scope.labMode) return { ok: false, error: "target_refused" }
    return { ok: true, target: "::1" }
  }
  const net = parseNet(trimmed)
  if (!net) return { ok: false, error: "target_refused" }
  const excluded = scope.excludedHosts.map(parseNet).filter((item): item is { base: number; bits: number } => item != null)
  if (excluded.some((host) => overlaps(net, host))) return { ok: false, error: "target_excluded" }
  const allowed = scope.labMode
    ? [parseNet("127.0.0.1/32"), ...scope.labNetworks.map(parseNet)].filter((item): item is { base: number; bits: number } => item != null)
    : scope.authorizedNetworks.map(parseNet).filter((item): item is { base: number; bits: number } => item != null)
  if (!allowed.some((network) => within(net, network))) return { ok: false, error: "target_refused" }
  return { ok: true, target: trimmed }
}

export function authorizeURL(raw: string, scope: ScanScope): AuthResult {
  let host = ""
  try {
    const url = new URL(raw)
    if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, error: "target_refused" }
    host = url.hostname.replace(/^\[|\]$/g, "")
  } catch {
    return authorizeTarget(raw, scope)
  }
  return authorizeTarget(host, scope)
}
