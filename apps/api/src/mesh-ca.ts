import { createHash, createPrivateKey, createPublicKey, createSign, generateKeyPairSync, hkdfSync, randomBytes, X509Certificate, type KeyObject } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { MESH_CERT_REFRESH_DAYS, MESH_CERT_TTL_DAYS, MESH_DEVICE_URI_PREFIX } from "@workspace/shared"

const CA_CN = "pc-manager-mesh-ca"
const CA_DAYS = 3650
const HKDF_SALT = "pc-manager-mesh-ca-v1"

const OID_ECDSA_SHA256 = "1.2.840.10045.4.3.2"
const OID_EC_PUBLIC = "1.2.840.10045.2.1"
const OID_P256 = "1.2.840.10045.3.1.7"
const OID_CN = "2.5.4.3"
const OID_SAN = "2.5.29.17"
const OID_BC = "2.5.29.19"
const OID_KU = "2.5.29.15"
const OID_EKU = "2.5.29.37"
const OID_SERVER_AUTH = "1.3.6.1.5.5.7.3.1"
const OID_CLIENT_AUTH = "1.3.6.1.5.5.7.3.2"

const P256_P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
const P256_A = P256_P - 3n
const P256_GX = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n
const P256_GY = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n

type Pt = { x: bigint; y: bigint }

export type MeshCA = {
  certPem: string
  keyPem: string
  key: KeyObject
  cert: X509Certificate
}

export type IssuedCert = {
  certPem: string
  keyPem: string
  serial: string
  notAfter: string
}

type StateFile = {
  issued: Record<string, { serial: string; notAfter: string }>
  revoked: Array<{ serial: string; at: number }>
}

function mod(a: bigint): bigint {
  const r = a % P256_P
  return r < 0n ? r + P256_P : r
}

function modInv(a: bigint, m: bigint): bigint {
  let t = 0n
  let newt = 1n
  let r = m
  let newr = ((a % m) + m) % m
  while (newr !== 0n) {
    const q = r / newr
    ;[t, newt] = [newt, t - q * newt]
    ;[r, newr] = [newr, r - q * newr]
  }
  if (r > 1n) throw new Error("not invertible")
  if (t < 0n) t += m
  return t
}

function pointAdd(p: Pt | null, q: Pt | null): Pt | null {
  if (!p) return q
  if (!q) return p
  if (p.x === q.x) {
    if (p.y !== q.y) return null
    return pointDbl(p)
  }
  const s = mod((q.y - p.y) * modInv(q.x - p.x, P256_P))
  const x = mod(s * s - p.x - q.x)
  const y = mod(s * (p.x - x) - p.y)
  return { x, y }
}

function pointDbl(p: Pt): Pt {
  const s = mod((3n * p.x * p.x + P256_A) * modInv(mod(2n * p.y), P256_P))
  const x = mod(s * s - 2n * p.x)
  const y = mod(s * (p.x - x) - p.y)
  return { x, y }
}

function scalarMult(k: bigint): Pt {
  let r: Pt | null = null
  let base: Pt | null = { x: P256_GX, y: P256_GY }
  let n = k
  while (n > 0n && base) {
    if (n & 1n) r = pointAdd(r, base)
    base = pointDbl(base)
    n >>= 1n
  }
  if (!r) throw new Error("invalid scalar")
  return r
}

function i2osp(n: bigint, len: number): Buffer {
  const hex = n.toString(16).padStart(len * 2, "0")
  return Buffer.from(hex.slice(-len * 2), "hex")
}

function os2ip(buf: Buffer): bigint {
  return BigInt("0x" + buf.toString("hex"))
}

function validScalar(d: bigint): boolean {
  return d > 0n && d < P256_N
}

function encodeLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len])
  if (len < 0x100) return Buffer.from([0x81, len])
  if (len < 0x10000) return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff])
  return Buffer.from([0x83, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff])
}

function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts)
  return Buffer.concat([Buffer.from([tag]), encodeLength(body.length), body])
}

function encodeOid(oid: string): Buffer {
  const parts = oid.split(".").map((x) => Number(x))
  const out = [40 * parts[0]! + parts[1]!]
  for (const n of parts.slice(2)) {
    const stack: number[] = []
    let v = n
    stack.push(v & 0x7f)
    v >>= 7
    while (v > 0) {
      stack.push((v & 0x7f) | 0x80)
      v >>= 7
    }
    for (let i = stack.length - 1; i >= 0; i--) out.push(stack[i]!)
  }
  return tlv(0x06, Buffer.from(out))
}

function encodeInt(buf: Buffer): Buffer {
  let v = buf
  while (v.length > 1 && v[0] === 0) v = v.subarray(1)
  if (v[0]! & 0x80) v = Buffer.concat([Buffer.from([0]), v])
  return tlv(0x02, v)
}

function encodeIntN(n: number): Buffer {
  return encodeInt(Buffer.from([n]))
}

function bitString(data: Buffer): Buffer {
  return tlv(0x03, Buffer.from([0]), data)
}

function octetString(data: Buffer): Buffer {
  return tlv(0x04, data)
}

function utf8(s: string): Buffer {
  return tlv(0x0c, Buffer.from(s, "utf8"))
}

function ia5(s: string): Buffer {
  return Buffer.from(s, "ascii")
}

function sequence(...parts: Buffer[]): Buffer {
  return tlv(0x30, ...parts)
}

function set(...parts: Buffer[]): Buffer {
  return tlv(0x31, ...parts)
}

function explicit(n: number, ...parts: Buffer[]): Buffer {
  return tlv(0xa0 + n, ...parts)
}

function utcTime(d: Date): Buffer {
  const yy = String(d.getUTCFullYear()).slice(-2)
  const pad = (n: number) => String(n).padStart(2, "0")
  const s = `${yy}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  return tlv(0x17, Buffer.from(s, "ascii"))
}

function nameCN(cn: string): Buffer {
  return sequence(set(sequence(encodeOid(OID_CN), utf8(cn))))
}

function algId(): Buffer {
  return sequence(encodeOid(OID_ECDSA_SHA256))
}

function boolTrue(): Buffer {
  return tlv(0x01, Buffer.from([0xff]))
}

function extension(oid: string, critical: boolean, value: Buffer): Buffer {
  const parts = [encodeOid(oid)]
  if (critical) parts.push(boolTrue())
  parts.push(octetString(value))
  return sequence(...parts)
}

function pemEncode(type: string, der: Buffer): string {
  const b64 = der.toString("base64")
  const lines = b64.match(/.{1,64}/g) ?? []
  return `-----BEGIN ${type}-----\n${lines.join("\n")}\n-----END ${type}-----\n`
}

function splitPem(pem: string): { certs: string[]; keys: string[] } {
  const certs: string[] = []
  const keys: string[] = []
  const re = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/g
  let m: RegExpExecArray | null
  while ((m = re.exec(pem))) {
    const block = m[0]
    const label = m[1] ?? ""
    if (label.includes("CERTIFICATE") && !label.includes("REQUEST")) certs.push(block)
    else if (label.includes("PRIVATE KEY")) keys.push(block)
  }
  return { certs, keys }
}

function readMaybeFile(raw: string): string {
  const s = raw.trim()
  if (!s) return ""
  if (s.includes("-----BEGIN")) return s
  try {
    return fs.readFileSync(s, "utf8")
  } catch {
    return s
  }
}

function scalarFromSecret(secret: string): bigint {
  for (let i = 0; i < 32; i++) {
    const info = Buffer.from(`key-${i}`, "utf8")
    const raw = Buffer.from(hkdfSync("sha256", secret, HKDF_SALT, info, 32))
    const d = os2ip(raw)
    if (validScalar(d)) return d
  }
  throw new Error("unable to derive mesh CA scalar")
}

function privateKeyFromScalar(d: bigint): KeyObject {
  const pt = scalarMult(d)
  const jwk = {
    kty: "EC" as const,
    crv: "P-256",
    d: i2osp(d, 32).toString("base64url"),
    x: i2osp(pt.x, 32).toString("base64url"),
    y: i2osp(pt.y, 32).toString("base64url"),
  }
  return createPrivateKey({ key: jwk, format: "jwk" })
}

function signTbs(tbs: Buffer, key: KeyObject): Buffer {
  const signer = createSign("SHA256")
  signer.update(tbs)
  return signer.sign(key)
}

function buildCert(opts: {
  serial: Buffer
  issuerCN: string
  subjectCN: string
  notBefore: Date
  notAfter: Date
  spki: Buffer
  ca: boolean
  dnsNames?: string[]
  uris?: string[]
  issuerKey: KeyObject
}): Buffer {
  const ku = opts.ca ? Buffer.from([0x06]) : Buffer.from([0x80])
  const kuUnused = opts.ca ? 1 : 7
  const kuBits = tlv(0x03, Buffer.from([kuUnused]), ku)
  const eku = sequence(encodeOid(OID_SERVER_AUTH), encodeOid(OID_CLIENT_AUTH))
  const bc = opts.ca ? sequence(boolTrue(), encodeIntN(0)) : sequence()
  const exts: Buffer[] = [
    extension(OID_BC, true, bc),
    extension(OID_KU, true, kuBits),
    extension(OID_EKU, false, eku),
  ]
  const sanParts: Buffer[] = []
  for (const d of opts.dnsNames ?? []) sanParts.push(tlv(0x82, ia5(d)))
  for (const u of opts.uris ?? []) sanParts.push(tlv(0x86, ia5(u)))
  if (sanParts.length) exts.push(extension(OID_SAN, false, sequence(...sanParts)))

  const tbs = sequence(
    explicit(0, encodeIntN(2)),
    encodeInt(opts.serial),
    algId(),
    nameCN(opts.issuerCN),
    sequence(utcTime(opts.notBefore), utcTime(opts.notAfter)),
    nameCN(opts.subjectCN),
    opts.spki,
    explicit(3, sequence(...exts))
  )
  const sig = signTbs(tbs, opts.issuerKey)
  return sequence(tbs, algId(), bitString(sig))
}

function selfSignCA(key: KeyObject, notBefore: Date, notAfter: Date): Buffer {
  const pub = createPublicKey(key)
  const spki = pub.export({ type: "spki", format: "der" }) as Buffer
  const serial = createHash("sha256").update("mesh-ca-serial").digest().subarray(0, 8)
  return buildCert({
    serial,
    issuerCN: CA_CN,
    subjectCN: CA_CN,
    notBefore,
    notAfter,
    spki,
    ca: true,
    issuerKey: key,
  })
}

export function deriveMeshCA(secret: string): MeshCA {
  const key = privateKeyFromScalar(scalarFromSecret(secret))
  const notBefore = new Date(Date.UTC(2020, 0, 1))
  const notAfter = new Date(Date.UTC(2020, 0, 1) + CA_DAYS * 86_400_000)
  const der = selfSignCA(key, notBefore, notAfter)
  const certPem = pemEncode("CERTIFICATE", der)
  const keyPem = key.export({ type: "pkcs8", format: "pem" }) as string
  return { certPem, keyPem, key, cert: new X509Certificate(certPem) }
}

export function loadMeshCAFromPem(certPem: string, keyPem: string): MeshCA {
  const key = createPrivateKey(keyPem)
  const cert = new X509Certificate(certPem)
  if (!cert.checkPrivateKey(key)) throw new Error("MESH_CA key does not match certificate")
  return { certPem, keyPem, key, cert }
}

export function loadOrCreateMeshCA(opts: {
  secret: string
  dataDir: string
  caPem?: string
  caKeyPem?: string
}): MeshCA {
  const fromEnv = readMaybeFile(opts.caPem ?? "")
  const keyEnv = readMaybeFile(opts.caKeyPem ?? "")
  if (fromEnv.includes("-----BEGIN CERTIFICATE-----")) {
    const parts = splitPem(fromEnv)
    const certPem = parts.certs[0] ?? fromEnv
    const keyPem = keyEnv || parts.keys[0]
    if (!keyPem) throw new Error("MESH_CA is missing a private key (set MESH_CA_KEY)")
    return loadMeshCAFromPem(certPem, keyPem)
  }
  const persisted = path.join(opts.dataDir, "mesh-ca.pem")
  try {
    const raw = fs.readFileSync(persisted, "utf8")
    const parts = splitPem(raw)
    if (parts.certs[0] && parts.keys[0]) {
      return loadMeshCAFromPem(parts.certs[0], parts.keys[0])
    }
  } catch {
    /* derive */
  }
  const derived = deriveMeshCA(opts.secret)
  try {
    fs.mkdirSync(opts.dataDir, { recursive: true })
    fs.writeFileSync(persisted, `${derived.certPem}${derived.keyPem}`, { mode: 0o600 })
  } catch {
    /* still usable in-memory */
  }
  return derived
}

export function deviceURI(deviceId: string): string {
  return `${MESH_DEVICE_URI_PREFIX}${deviceId}`
}

export function issueDeviceCert(ca: MeshCA, deviceId: string, ttlDays = MESH_CERT_TTL_DAYS): IssuedCert {
  const id = deviceId.trim()
  if (!id) throw new Error("deviceId required")
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  const spki = pair.publicKey.export({ type: "spki", format: "der" }) as Buffer
  const serial = randomBytes(16)
  serial[0] = serial[0]! & 0x7f
  if (serial[0] === 0) serial[0] = 1
  const now = new Date()
  const notBefore = new Date(now.getTime() - 60_000)
  const notAfter = new Date(now.getTime() + ttlDays * 86_400_000)
  const der = buildCert({
    serial,
    issuerCN: CA_CN,
    subjectCN: id,
    notBefore,
    notAfter,
    spki,
    ca: false,
    dnsNames: [id],
    uris: [deviceURI(id)],
    issuerKey: ca.key,
  })
  const certPem = pemEncode("CERTIFICATE", der)
  const keyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }) as string
  const leaf = new X509Certificate(certPem)
  if (!leaf.verify(ca.cert.publicKey)) throw new Error("issued mesh cert failed CA verify")
  return {
    certPem,
    keyPem,
    serial: serial.toString("hex"),
    notAfter: notAfter.toISOString(),
  }
}

function emptyState(): StateFile {
  return { issued: {}, revoked: [] }
}

function loadState(file: string): StateFile {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<StateFile>
    return {
      issued: raw.issued && typeof raw.issued === "object" ? raw.issued : {},
      revoked: Array.isArray(raw.revoked) ? raw.revoked.filter((e) => e && typeof e.serial === "string") : [],
    }
  } catch {
    return emptyState()
  }
}

function saveState(file: string, state: StateFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

const CRL_KEEP_MS = 40 * 86_400_000

function pruneRevoked(state: StateFile, now = Date.now()): void {
  state.revoked = state.revoked.filter((e) => now - e.at < CRL_KEEP_MS)
  const seen = new Set<string>()
  const out: StateFile["revoked"] = []
  for (let i = state.revoked.length - 1; i >= 0; i--) {
    const e = state.revoked[i]!
    if (seen.has(e.serial)) continue
    seen.add(e.serial)
    out.push(e)
  }
  state.revoked = out.reverse()
}

export function revokedSerials(stateFile: string): string[] {
  const state = loadState(stateFile)
  pruneRevoked(state)
  return state.revoked.map((e) => e.serial)
}

export function revokeDeviceMesh(stateFile: string, deviceId: string): void {
  const state = loadState(stateFile)
  const prev = state.issued[deviceId]
  if (prev?.serial) {
    state.revoked.push({ serial: prev.serial, at: Date.now() })
    delete state.issued[deviceId]
  }
  pruneRevoked(state)
  saveState(stateFile, state)
}

export function shouldRefreshIssued(notAfter: string, now = Date.now()): boolean {
  const t = Date.parse(notAfter)
  if (!Number.isFinite(t)) return true
  return t - now < MESH_CERT_REFRESH_DAYS * 86_400_000
}

export type MeshIssueResult = IssuedCert & { revokedSerials: string[]; reused: boolean }

export function issueAndRecord(
  ca: MeshCA,
  stateFile: string,
  deviceId: string,
  haveSerial?: string
): MeshIssueResult {
  const state = loadState(stateFile)
  const prev = state.issued[deviceId]
  const known = (haveSerial ?? "").trim().toLowerCase()
  if (prev && !shouldRefreshIssued(prev.notAfter) && known && known === prev.serial.toLowerCase()) {
    pruneRevoked(state)
    return {
      certPem: "",
      keyPem: "",
      serial: prev.serial,
      notAfter: prev.notAfter,
      revokedSerials: state.revoked.map((e) => e.serial),
      reused: true,
    }
  }
  const issued = issueDeviceCert(ca, deviceId)
  if (prev?.serial && prev.serial !== issued.serial) {
    state.revoked.push({ serial: prev.serial, at: Date.now() })
  }
  state.issued[deviceId] = { serial: issued.serial, notAfter: issued.notAfter }
  pruneRevoked(state)
  saveState(stateFile, state)
  return { ...issued, revokedSerials: state.revoked.map((e) => e.serial), reused: false }
}
