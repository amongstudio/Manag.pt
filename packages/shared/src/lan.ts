import { PEER_LAN_ADDRS_MAX, PEER_LAN_PORT } from "./constants.ts"

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

export type LanPeerDevice = {
  id: string
  hostname: string
  status: string
  ip: string | null
  lanAddrs: string[]
  lanPort: number | null
}

export type LanPeer = LanPeerDevice & { likely: boolean }

function octet(n: string): number | null {
  if (!/^\d{1,3}$/.test(n)) return null
  const v = Number(n)
  if (!Number.isInteger(v) || v < 0 || v > 255) return null
  return v
}

/** Strip an optional zone id (`fe80::1%eth0`) and surrounding brackets. */
export function normalizeIpLiteral(raw: string): string {
  let s = raw.trim()
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1)
  const zone = s.indexOf("%")
  if (zone >= 0) s = s.slice(0, zone)
  if (s.startsWith("::ffff:")) {
    const mapped = s.slice(7)
    if (IPV4.test(mapped)) return mapped
  }
  return s
}

export function parseIpv4(addr: string): [number, number, number, number] | null {
  const m = IPV4.exec(normalizeIpLiteral(addr))
  if (!m) return null
  const a = octet(m[1]!)
  const b = octet(m[2]!)
  const c = octet(m[3]!)
  const d = octet(m[4]!)
  if (a == null || b == null || c == null || d == null) return null
  return [a, b, c, d]
}

export function isRfc1918Ipv4(addr: string): boolean {
  const v = parseIpv4(addr)
  if (!v) return false
  const [a, b] = v
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

/** IPv6 unique-local (fc00::/7). */
export function isIpv6Ula(addr: string): boolean {
  const s = normalizeIpLiteral(addr)
  if (!s.includes(":")) return false
  if (s.includes(".")) return false
  const first = s.split(":")[0]
  if (!first) return false
  const n = Number.parseInt(first, 16)
  if (!Number.isFinite(n)) return false
  return (n & 0xfe00) === 0xfc00
}

export function isPrivateLanAddr(addr: string): boolean {
  const s = normalizeIpLiteral(addr)
  if (!s) return false
  if (isRfc1918Ipv4(s)) return true
  return isIpv6Ula(s)
}

export function ipv4Slash24(addr: string): string | null {
  const v = parseIpv4(addr)
  if (!v) return null
  return `${v[0]}.${v[1]}.${v[2]}.0`
}

export function sanitizeLanAddrs(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of input) {
    if (typeof item !== "string") continue
    const addr = normalizeIpLiteral(item).slice(0, 64)
    if (!isPrivateLanAddr(addr)) continue
    const key = addr.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(addr)
    if (out.length >= PEER_LAN_ADDRS_MAX) break
  }
  return out
}

export function sanitizeLanPort(input: unknown): number | null {
  const n = typeof input === "number" ? input : Number(input)
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null
  return n
}

export function parseStoredLanAddrs(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    return sanitizeLanAddrs(JSON.parse(raw) as unknown)
  } catch {
    return []
  }
}

export function publicIpKey(ip: string | null | undefined): string {
  if (!ip) return ""
  return normalizeIpLiteral(ip).toLowerCase()
}

export function likelyLanPeer(
  self: { lanAddrs: string[]; ip?: string | null },
  other: { lanAddrs: string[]; ip?: string | null }
): boolean {
  const selfPub = publicIpKey(self.ip)
  const otherPub = publicIpKey(other.ip)
  if (selfPub && otherPub && selfPub === otherPub) return true
  const nets = new Set<string>()
  for (const addr of self.lanAddrs) {
    const net = ipv4Slash24(addr)
    if (net) nets.add(net)
  }
  if (nets.size === 0) return false
  for (const addr of other.lanAddrs) {
    const net = ipv4Slash24(addr)
    if (net && nets.has(net)) return true
  }
  return false
}

export function lanPeersForDevice(
  self: { id: string; lanAddrs: string[]; ip?: string | null },
  others: LanPeerDevice[]
): LanPeer[] {
  const peers: LanPeer[] = []
  for (const other of others) {
    if (other.id === self.id) continue
    peers.push({
      ...other,
      lanAddrs: sanitizeLanAddrs(other.lanAddrs),
      lanPort: sanitizeLanPort(other.lanPort) ?? PEER_LAN_PORT,
      likely: likelyLanPeer(self, other),
    })
  }
  peers.sort((a, b) => {
    if (a.likely !== b.likely) return a.likely ? -1 : 1
    if (a.status !== b.status) return a.status === "online" ? -1 : 1
    return a.hostname.localeCompare(b.hostname)
  })
  return peers
}

export type PeerTicketFields = {
  copyId: string
  srcDeviceId: string
  dstDeviceId: string
  srcPath: string
  destPath: string
  exp: number
  maxBytes: number
  port: number
  addrs: string[]
}

/** Canonical HMAC message. Field order is part of the ticket contract. */
export function peerTicketMessage(fields: PeerTicketFields): string {
  const addrs = [...fields.addrs].map((a) => normalizeIpLiteral(a)).sort()
  return [
    "peer-copy-v1",
    fields.copyId,
    fields.srcDeviceId,
    fields.dstDeviceId,
    fields.srcPath,
    fields.destPath,
    String(fields.exp),
    String(fields.maxBytes),
    String(fields.port),
    addrs.join(","),
  ].join("\n")
}
