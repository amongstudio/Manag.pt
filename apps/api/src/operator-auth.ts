import type { FastifyReply, FastifyRequest } from "fastify"
import { prisma } from "@workspace/db"
import { OPERATOR_SESSION_COOKIE, OPERATOR_SESSION_TTL_MS } from "@workspace/shared"

import { env } from "./env.js"
import { errorBody, randomToken, sha256, safeEqual } from "./lib.js"

const TOKEN_COOKIE = "pc_operator_token"

export function operatorTokenConfigured(): boolean {
  return Boolean(env.operatorToken)
}

function headerString(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value) && typeof value[0] === "string") return value[0]
  return ""
}

function normalizedOrigin(value: string): string {
  try {
    return new URL(value).origin
  } catch {
    return ""
  }
}

export function adminMutationOriginAllowed(
  method: string,
  headers: Record<string, unknown>
): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true
  const origin = normalizedOrigin(headerString(headers.origin))
  const fetchSite = headerString(headers["sec-fetch-site"]).toLowerCase()
  if (!origin) return fetchSite !== "cross-site"
  const configured = env.cors.origin === true ? [] : env.cors.origin
  const allowed = new Set(
    [...configured, env.publicUrl]
      .map(normalizedOrigin)
      .filter(Boolean)
  )
  return allowed.has(origin)
}

export function cookieNamed(cookieHeader: unknown, name: string): string {
  const raw = headerString(cookieHeader)
  if (!raw) return ""
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=")
    if (idx <= 0) continue
    if (part.slice(0, idx).trim() !== name) continue
    const value = part.slice(idx + 1).trim()
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  return ""
}

export function extractOperatorToken(req: {
  headers: Record<string, unknown>
  query?: unknown
}): string {
  const header = headerString(req.headers["x-operator-token"])
  if (header) return header
  const auth = headerString(req.headers.authorization)
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth)
    if (match?.[1]) return match[1].trim()
  }
  return cookieNamed(req.headers.cookie, TOKEN_COOKIE)
}

export function extractSessionToken(headers: Record<string, unknown>): string {
  return cookieNamed(headers.cookie, OPERATOR_SESSION_COOKIE)
}

export function operatorTokenMatches(provided: string, expected: string): boolean {
  if (!expected) return true
  if (!provided) return false
  return safeEqual(provided, expected)
}

export function isPublicAdminAuthPath(path: string): boolean {
  const clean = path.split("?")[0] ?? ""
  return (
    clean === "/api/v1/admin/auth/status" ||
    clean === "/api/v1/admin/auth/login" ||
    clean === "/api/v1/admin/auth/setup"
  )
}

export function sessionCookieHeader(token: string, maxAgeSec: number, secure: boolean): string {
  const parts = [
    `${OPERATOR_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, maxAgeSec)}`,
  ]
  if (secure) parts.push("Secure")
  return parts.join("; ")
}

export function clearSessionCookieHeader(secure: boolean): string {
  const parts = [`${OPERATOR_SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"]
  if (secure) parts.push("Secure")
  return parts.join("; ")
}

export function cookieSecure(): boolean {
  return env.publicUrl.startsWith("https://")
}

let passwordAuthCache: { at: number; enabled: boolean } | null = null

export async function passwordAuthEnabled(): Promise<boolean> {
  const now = Date.now()
  if (passwordAuthCache && now - passwordAuthCache.at < 5_000) return passwordAuthCache.enabled
  const count = await prisma.operatorAccount.count()
  passwordAuthCache = { at: now, enabled: count > 0 }
  return passwordAuthCache.enabled
}

export function invalidatePasswordAuthCache(): void {
  passwordAuthCache = null
}

export async function lookupOperatorSession(token: string): Promise<{ id: string; username: string } | null> {
  if (!token) return null
  const tokenHash = sha256(token)
  const row = await prisma.operatorSession.findUnique({
    where: { tokenHash },
    include: { account: { select: { id: true, username: true } } },
  })
  if (!row || row.expiresAt.getTime() <= Date.now()) return null
  void prisma.operatorSession
    .update({ where: { id: row.id }, data: { lastSeen: new Date() } })
    .catch(() => undefined)
  return { id: row.account.id, username: row.account.username }
}

export async function issueOperatorSession(accountId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32)
  const expiresAt = new Date(Date.now() + OPERATOR_SESSION_TTL_MS)
  await prisma.operatorSession.create({
    data: { accountId, tokenHash: sha256(token), expiresAt },
  })
  return { token, expiresAt }
}

export async function revokeOperatorSession(token: string): Promise<void> {
  if (!token) return
  await prisma.operatorSession.deleteMany({ where: { tokenHash: sha256(token) } })
}

export async function authStatus(): Promise<{
  mode: "open" | "token" | "password"
  needsSetup: boolean
}> {
  const password = await passwordAuthEnabled()
  if (password) return { mode: "password", needsSetup: false }
  if (env.operatorToken) return { mode: "token", needsSetup: true }
  return { mode: "open", needsSetup: true }
}

export async function operatorAuthorized(
  headers: Record<string, unknown>,
  auth?: unknown
): Promise<{ ok: boolean; username?: string }> {
  const rec = auth && typeof auth === "object" ? (auth as Record<string, unknown>) : {}
  const fromAuth = typeof rec.token === "string" ? rec.token : ""
  const token = fromAuth || extractOperatorToken({ headers })
  const sessionToken = extractSessionToken(headers) || fromAuth
  const passwordOn = await passwordAuthEnabled()
  if (passwordOn) {
    const session = await lookupOperatorSession(sessionToken)
    if (session) return { ok: true, username: session.username }
    if (env.operatorToken && operatorTokenMatches(token, env.operatorToken)) return { ok: true }
    return { ok: false }
  }
  if (!env.operatorToken) return { ok: true }
  if (operatorTokenMatches(token, env.operatorToken)) return { ok: true }
  return { ok: false }
}

export async function requireOperator(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const path = (req.url ?? "").split("?")[0] ?? ""
  if (isPublicAdminAuthPath(path)) return true
  const authed = await operatorAuthorized(req.headers as Record<string, unknown>)
  if (authed.ok) return true
  void reply.code(401).send(errorBody("unauthorized"))
  return false
}

export async function socketOperatorOk(auth: unknown, headers: Record<string, unknown>): Promise<boolean> {
  const authed = await operatorAuthorized(headers, auth)
  return authed.ok
}
