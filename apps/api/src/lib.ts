import { createHmac, randomBytes, timingSafeEqual, createHash } from "node:crypto"
import { BlockList } from "node:net"
import fsp from "node:fs/promises"

import { env } from "./env.js"
import { API_PREFIX } from "@workspace/shared"

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

export function hmacSha256Hex(key: string, message: string): string {
  return createHmac("sha256", key).update(message).digest("hex")
}

export function hashDeviceKey(key: string): string {
  const pepper = env.deviceKeyPepper
  if (pepper) return hmacSha256Hex(pepper, key)
  return sha256(key)
}

export function deviceKeyMatches(storedHash: string, key: string): boolean {
  if (!storedHash) return false
  if (safeEqual(storedHash, hashDeviceKey(key))) return true
  if (safeEqual(storedHash, sha256(key))) return true
  const signing = env.updateSigningSecret
  if (signing && signing !== env.deviceKeyPepper) {
    return safeEqual(storedHash, hmacSha256Hex(signing, key))
  }
  return false
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("hex")
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export function signUpdateToken(updateId: string, exp: number): string {
  return createHmac("sha256", env.updateSigningSecret).update(`${updateId}:${exp}`).digest("hex")
}

export function verifyUpdateToken(updateId: string, exp: number, sig: string): boolean {
  if (Date.now() / 1000 > exp) return false
  return safeEqual(signUpdateToken(updateId, exp), sig)
}

export function signPeerTicket(message: string): string {
  return createHmac("sha256", env.updateSigningSecret).update(message).digest("hex")
}

export function verifyPeerTicket(message: string, sig: string, exp: number): boolean {
  if (Date.now() / 1000 > exp) return false
  return safeEqual(signPeerTicket(message), sig)
}

/**
 * Client address. Fastify already resolves `req.ip` from `trustProxy`; this
 * helper must not re-parse X-Forwarded-For (that is how the allowlist was
 * spoofed). Callers should pass `req.ip`.
 */
export function clientIp(_headers: Record<string, unknown>, ip?: string): string {
  return (ip ?? "unknown").replace(/^::ffff:/, "")
}

const SAFE_FILE_SEGMENT = /[^A-Za-z0-9._-]+/g

/** Basename-only, traversal-safe upload segment. */
export function safeUploadFilename(input: string, fallback = "upload"): string {
  const base = input.replaceAll("\\", "/").split("/").pop() ?? fallback
  const cleaned = base.replace(SAFE_FILE_SEGMENT, "_").replace(/^\.+/, "") || fallback
  if (cleaned.includes("..")) return fallback
  return cleaned.slice(0, 180)
}

function ipMatchesCidr(ip: string, cidr: string): boolean {
  const slash = cidr.lastIndexOf("/")
  if (slash <= 0) return false
  const range = cidr.slice(0, slash)
  const bits = Number(cidr.slice(slash + 1))
  if (!Number.isInteger(bits) || bits < 0) return false
  const rangeV4 = range.includes(".") && !range.includes(":")
  const ipV4Mapped = ip.startsWith("::ffff:") ? ip.slice(7) : ip
  const ipV4 = ipV4Mapped.includes(".") && !ipV4Mapped.includes(":")
  try {
    const list = new BlockList()
    list.addSubnet(range, bits, rangeV4 ? "ipv4" : "ipv6")
    if (rangeV4) {
      if (ipV4) return list.check(ipV4Mapped, "ipv4")
      return false
    }
    return list.check(ip, "ipv6")
  } catch {
    return false
  }
}

export function ipAllowed(ip: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true
  const normalized = ip.replace(/^::ffff:/, "")
  return allowlist.some((entry) => {
    const item = entry.trim()
    if (!item) return false
    if (item.includes("/")) return ipMatchesCidr(normalized, item) || ipMatchesCidr(ip, item)
    return item === normalized || item === ip
  })
}

const DENY_FRAGMENTS = [
  "windows\\system32\\config",
  "windows/system32/config",
  "/etc/shadow",
  "/etc/passwd",
]

export function multipartValue(
  fields: Record<string, { value?: unknown } | Array<{ value?: unknown }> | undefined> | undefined,
  key: string
): string {
  const raw = fields?.[key]
  if (!raw) return ""
  const item = Array.isArray(raw) ? raw[0] : raw
  if (item && typeof item === "object" && "value" in item && item.value != null) {
    return String(item.value)
  }
  return ""
}

export function isHelperArtifact(filePath: string, notes?: string | null): boolean {
  const base = filePath.replaceAll("\\", "/").split("/").pop() ?? ""
  const blob = `${base} ${notes ?? ""}`.toLowerCase()
  return blob.includes("helper")
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.access(target)
    return true
  } catch {
    return false
  }
}

export function errorBody(error: string, details?: unknown): { error: string; details?: unknown } {
  return details === undefined ? { error } : { error, details }
}

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null || raw === "") return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function httpRateLimitBucket(url: string | undefined): "agent" | "admin" | "other" {
  const path = (url ?? "").split("?")[0] ?? ""
  if (path.startsWith(`${API_PREFIX}/agent`)) return "agent"
  if (path.startsWith(`${API_PREFIX}/admin`)) return "admin"
  return "other"
}

export function updateKindFromArtifact(filePath: string, notes?: string | null): "agent" | "helper" {
  return isHelperArtifact(filePath, notes) ? "helper" : "agent"
}

export function trySafePath(input: string): string | null {
  try {
    return assertSafePath(input)
  } catch {
    return null
  }
}

export function assertSafePath(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) throw new Error("path required")
  if (trimmed.includes("\0")) throw new Error("path denied")
  const normalized = trimmed.replaceAll("\\", "/")
  for (const segment of normalized.split("/")) {
    if (segment === "..") throw new Error("path denied")
  }
  const lowerSlash = normalized.toLowerCase()
  const lowerBackslash = lowerSlash.replaceAll("/", "\\")
  for (const fragment of DENY_FRAGMENTS) {
    const slash = fragment.replaceAll("\\", "/").toLowerCase()
    const backslash = fragment.replaceAll("/", "\\").toLowerCase()
    if (lowerSlash.includes(slash) || lowerBackslash.includes(backslash)) {
      throw new Error("path denied")
    }
  }
  return trimmed
}
