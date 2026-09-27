import { E2E_HKDF_INFO, E2E_HKDF_SALT_LEN } from "@workspace/shared"

export type OperatorKey = {
  privateKey: CryptoKey
  publicHex: string
}

export type E2ESession = {
  sessionId: string
  key: CryptoKey
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.toLowerCase()
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

export function bytesToB64(bytes: Uint8Array): string {
  let bin = ""
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export async function generateOperatorKey(): Promise<OperatorKey> {
  const pair = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey)
  return { privateKey: pair.privateKey, publicHex: bytesToHex(new Uint8Array(raw)) }
}

export async function deriveSessionKey(privateKey: CryptoKey, agentPubHex: string): Promise<CryptoKey> {
  const pub = await crypto.subtle.importKey("raw", hexToBytes(agentPubHex) as BufferSource, { name: "X25519" }, false, [])
  const bits = await crypto.subtle.deriveBits({ name: "X25519", public: pub }, privateKey, 256)
  const hkdfKey = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"])
  const info = new TextEncoder().encode(E2E_HKDF_INFO)
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(E2E_HKDF_SALT_LEN), info },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  )
}

export async function encryptBytes(
  key: CryptoKey,
  plaintext: Uint8Array,
  aad = ""
): Promise<{ nonce: string; ciphertext: string }> {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const extra = aad ? { name: "AES-GCM" as const, iv: nonce, additionalData: new TextEncoder().encode(aad) } : { name: "AES-GCM" as const, iv: nonce }
  const ct = await crypto.subtle.encrypt(extra, key, plaintext as BufferSource)
  return { nonce: bytesToB64(nonce), ciphertext: bytesToB64(new Uint8Array(ct)) }
}

export async function decryptBytes(key: CryptoKey, nonceB64: string, ciphertextB64: string, aad = ""): Promise<Uint8Array> {
  const nonce = b64ToBytes(nonceB64)
  const ct = b64ToBytes(ciphertextB64)
  const extra = aad
    ? { name: "AES-GCM" as const, iv: nonce, additionalData: new TextEncoder().encode(aad) }
    : { name: "AES-GCM" as const, iv: nonce }
  const plain = await crypto.subtle.decrypt(extra, key, ct as BufferSource)
  return new Uint8Array(plain)
}

export function encodeChunkPlain(header: unknown, payload: Uint8Array): Uint8Array {
  const raw = new TextEncoder().encode(JSON.stringify(header))
  const out = new Uint8Array(4 + raw.length + payload.length)
  new DataView(out.buffer).setUint32(0, raw.length)
  out.set(raw, 4)
  out.set(payload, 4 + raw.length)
  return out
}

export function decodeChunkPlain(plain: Uint8Array): { header: Record<string, unknown>; payload: Uint8Array } {
  if (plain.length < 4) throw new Error("chunk too short")
  const n = new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getUint32(0)
  if (4 + n > plain.length) throw new Error("chunk header truncated")
  const header = JSON.parse(new TextDecoder().decode(plain.subarray(4, 4 + n))) as Record<string, unknown>
  return { header, payload: plain.subarray(4 + n) }
}
