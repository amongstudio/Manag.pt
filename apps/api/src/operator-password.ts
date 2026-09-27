import { randomBytes, scrypt, timingSafeEqual, type BinaryLike, type ScryptOptions } from "node:crypto"

const KEY_LEN = 32
const SCRYPT_N = 16_384
const SCRYPT_R = 8
const SCRYPT_P = 1

function scryptAsync(password: BinaryLike, salt: BinaryLike, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err)
      else resolve(derivedKey)
    })
  })
}

export const USERNAME_RE = /^[a-zA-Z0-9_]{3,64}$/

export function normalizeUsername(raw: string): string | null {
  const username = raw.trim().toLowerCase()
  if (!USERNAME_RE.test(username)) return null
  return username
}

export function passwordStrongEnough(password: string): boolean {
  return password.length >= 8 && password.length <= 200 && !password.includes("\0")
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = (await scryptAsync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })) as Buffer
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${key.toString("hex")}`
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const parts = stored.split("$")
  if (parts.length !== 6 || parts[0] !== "scrypt") return false
  const n = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false
  let salt: Buffer
  let want: Buffer
  try {
    salt = Buffer.from(parts[4] ?? "", "hex")
    want = Buffer.from(parts[5] ?? "", "hex")
  } catch {
    return false
  }
  if (!salt.length || !want.length) return false
  const got = (await scryptAsync(password, salt, want.length, { N: n, r, p })) as Buffer
  if (got.length !== want.length) return false
  return timingSafeEqual(got, want)
}
