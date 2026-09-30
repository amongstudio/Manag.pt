import fs from "node:fs"
import path from "node:path"
import { createHmac } from "node:crypto"
import { fileURLToPath } from "node:url"

import { DEFAULT_STUN_URL, MAX_SCREENSHOT_BYTES, MAX_UPDATE_BYTES, MAX_UPLOAD_BYTES } from "@workspace/shared"
import dotenv from "dotenv"

const here = path.dirname(fileURLToPath(import.meta.url))
const cwd = process.cwd()

dotenv.config({ path: path.resolve(cwd, ".env") })
dotenv.config({ path: path.resolve(cwd, "../../.env") })
dotenv.config({ path: path.resolve(here, "../../../.env") })

function num(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

function csv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function resolveEnrollmentSecret(nodeEnv: string): string {
  const raw = process.env.ENROLLMENT_SECRET
  if (nodeEnv === "production") {
    if (!raw || raw.length < 16 || raw.startsWith("change-me-")) {
      throw new Error(
        "Refusing to start: set ENROLLMENT_SECRET to a unique value of at least 16 characters (not a change-me-* placeholder)"
      )
    }
    return raw
  }
  return raw ?? "change-me-enrollment-secret"
}

function resolveUpdateSigningSecret(nodeEnv: string): string {
  const raw = process.env.UPDATE_SIGNING_SECRET
  if (nodeEnv === "production") {
    if (!raw || raw.length < 16 || raw === "dev-update-secret") {
      throw new Error(
        "Refusing to start: set UPDATE_SIGNING_SECRET to a unique value of at least 16 characters (not the dev default)"
      )
    }
    return raw
  }
  return raw ?? "dev-update-secret"
}

/** Fastify types omit hop-count numbers; this matches proxy-addr `compileHops`. */
function trustHops(hops: number): (address: string, hop: number) => boolean {
  return (_address, hop) => hop < hops
}

/**
 * Fastify `trustProxy`: false, a hop-count function, or a comma-separated
 * list of trusted proxy IPs/CIDRs. `true`/`1` mean hop count 1 (one reverse
 * proxy), never “trust every X-Forwarded-For hop”.
 */
function resolveTrustProxy(): boolean | string | ((address: string, hop: number) => boolean) {
  const raw = (process.env.TRUST_PROXY ?? process.env.TRUSTED_PROXIES ?? "").trim()
  if (!raw || raw === "0" || raw.toLowerCase() === "false") return false
  if (raw.toLowerCase() === "true") return trustHops(1)
  const hops = Number(raw)
  if (Number.isInteger(hops) && hops > 0) return trustHops(hops)
  return raw
}

function resolveCors(): { origin: true | string[]; credentials: boolean } {
  const raw = process.env.CORS_ORIGIN ?? "http://localhost:3000"
  const credentials = process.env.CORS_CREDENTIALS !== "0"
  if (raw === "*" || raw.toLowerCase() === "true") {
    if (credentials) {
      throw new Error(
        "CORS_ORIGIN=* cannot be combined with credentialed requests. Set CORS_ORIGIN to the dashboard origin, or set CORS_CREDENTIALS=0"
      )
    }
    return { origin: true, credentials: false }
  }
  const publicUrl = process.env.PUBLIC_URL ?? "http://localhost:4000"
  const origins = [...new Set([raw, publicUrl].filter(Boolean))]
  return { origin: origins, credentials: true }
}

function resolveAgentSourceDir(): string {
  const raw = process.env.AGENT_SOURCE_DIR?.trim()
  if (raw) return path.resolve(raw)
  const fromApiCwd = path.resolve(cwd, "../agent")
  const fromRepoRoot = path.resolve(cwd, "apps/agent")
  if (fs.existsSync(path.join(fromApiCwd, "go.mod"))) return fromApiCwd
  if (fs.existsSync(path.join(fromRepoRoot, "go.mod"))) return fromRepoRoot
  return fromApiCwd
}

const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(cwd, "../../data"))
fs.mkdirSync(dataDir, { recursive: true })
for (const dir of ["files", "screenshots", "updates", "backups", "staged", "plugins", "packs"]) {
  fs.mkdirSync(path.join(dataDir, dir), { recursive: true })
}

const dbFile = path.join(dataDir, "pcmanager.db")
const dbUrl = `file:${dbFile.replaceAll("\\", "/")}?connection_limit=1`
process.env.DATABASE_URL = dbUrl

const nodeEnv = process.env.NODE_ENV ?? "development"
const cors = resolveCors()

/** coturn `use-auth-secret` time-limited credentials — never the long-lived secret. */
export function iceServersForClient(): Array<{ urls: string; username?: string; credential?: string }> {
  const stun = process.env.STUN_URL?.trim() || DEFAULT_STUN_URL
  const servers: Array<{ urls: string; username?: string; credential?: string }> = [{ urls: stun }]
  const turn = process.env.TURN_URL?.trim()
  if (!turn) return servers
  const secret = process.env.TURN_SECRET?.trim() || process.env.TURN_CREDENTIAL?.trim()
  if (!secret) {
    servers.push({ urls: turn })
    return servers
  }
  const ttl = 3_600
  const expiry = Math.floor(Date.now() / 1000) + ttl
  const username = `${expiry}:pcmanager`
  const credential = createHmac("sha1", secret).update(username).digest("base64")
  servers.push({ urls: turn, username, credential })
  return servers
}

export const env = {
  port: num("PORT", 4000),
  host: process.env.HOST ?? "::",
  dataDir,
  dbFile,
  enrollmentSecret: resolveEnrollmentSecret(nodeEnv),
  publicUrl: process.env.PUBLIC_URL ?? "http://localhost:4000",
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:3000",
  cors,
  trustProxy: resolveTrustProxy(),
  updateSigningSecret: resolveUpdateSigningSecret(nodeEnv),
  credentialsKey: (process.env.CREDENTIALS_KEY ?? "").trim(),
  rateLimitPerMinute: num("RATE_LIMIT_PER_MINUTE", 120),
  wsConnectPerMinute: num("WS_CONNECT_PER_MINUTE", 30),
  ipAllowlist: csv("IP_ALLOWLIST"),
  maxUploadBytes: num("MAX_UPLOAD_BYTES", MAX_UPLOAD_BYTES),
  maxUpdateBytes: num("MAX_UPDATE_BYTES", MAX_UPDATE_BYTES),
  maxScreenshotBytes: num("MAX_SCREENSHOT_BYTES", MAX_SCREENSHOT_BYTES),
  enableAgentCompile: process.env.ENABLE_AGENT_COMPILE === "1",
  agentSourceDir: resolveAgentSourceDir(),
  goBin: process.env.GO_BIN?.trim() || "go",
  turnConfigured: Boolean(process.env.TURN_URL?.trim()),
  operatorToken: (process.env.OPERATOR_TOKEN ?? "").trim(),
  deviceKeyPepper: (process.env.DEVICE_KEY_PEPPER ?? "").trim() || resolveUpdateSigningSecret(nodeEnv),
  meshCa: (process.env.MESH_CA ?? "").trim(),
  meshCaKey: (process.env.MESH_CA_KEY ?? "").trim(),
  nodeEnv,
}

export function dataPath(...parts: string[]): string {
  return path.join(env.dataDir, ...parts)
}
