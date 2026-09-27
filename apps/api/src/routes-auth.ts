import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { prisma } from "@workspace/db"
import { API_PREFIX, OPERATOR_SESSION_TTL_MS } from "@workspace/shared"

import { env } from "./env.js"
import { errorBody } from "./lib.js"
import {
  authStatus,
  clearSessionCookieHeader,
  cookieSecure,
  extractOperatorToken,
  extractSessionToken,
  invalidatePasswordAuthCache,
  issueOperatorSession,
  lookupOperatorSession,
  operatorTokenMatches,
  passwordAuthEnabled,
  revokeOperatorSession,
  sessionCookieHeader,
} from "./operator-auth.js"
import { hashPassword, normalizeUsername, passwordStrongEnough, verifyPassword } from "./operator-password.js"

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(200),
})

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.get(`${API_PREFIX}/admin/auth/status`, async () => authStatus())

  app.get(`${API_PREFIX}/admin/auth/me`, async (req, reply) => {
    const session = await lookupOperatorSession(extractSessionToken(req.headers as Record<string, unknown>))
    if (session) return { username: session.username, method: "session" as const }
    const token = extractOperatorToken(req)
    if (env.operatorToken && operatorTokenMatches(token, env.operatorToken)) {
      return { username: "token", method: "token" as const }
    }
    const passwordOn = await passwordAuthEnabled()
    if (!passwordOn && !env.operatorToken) return { username: "local", method: "open" as const }
    return reply.code(401).send(errorBody("unauthorized"))
  })

  app.post(`${API_PREFIX}/admin/auth/setup`, async (req, reply) => {
    if (await passwordAuthEnabled()) return reply.code(409).send(errorBody("already_configured"))
    if (env.operatorToken) {
      const token = extractOperatorToken(req)
      if (!operatorTokenMatches(token, env.operatorToken)) {
        return reply.code(401).send(errorBody("unauthorized"))
      }
    }
    const parsed = loginSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send(errorBody("invalid_body", parsed.error.flatten()))
    const username = normalizeUsername(parsed.data.username)
    if (!username) return reply.code(400).send(errorBody("invalid_username"))
    if (!passwordStrongEnough(parsed.data.password)) return reply.code(400).send(errorBody("weak_password"))
    const passwordHash = await hashPassword(parsed.data.password)
    const account = await prisma.operatorAccount.create({ data: { username, passwordHash } })
    invalidatePasswordAuthCache()
    const session = await issueOperatorSession(account.id)
    void reply.header("set-cookie", sessionCookieHeader(session.token, Math.floor(OPERATOR_SESSION_TTL_MS / 1000), cookieSecure()))
    return { ok: true, username, token: session.token }
  })

  app.post(`${API_PREFIX}/admin/auth/login`, async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send(errorBody("invalid_body", parsed.error.flatten()))
    const username = normalizeUsername(parsed.data.username)
    if (!username) return reply.code(401).send(errorBody("invalid_credentials"))
    const account = await prisma.operatorAccount.findUnique({ where: { username } })
    if (!account || !(await verifyPassword(account.passwordHash, parsed.data.password))) {
      return reply.code(401).send(errorBody("invalid_credentials"))
    }
    const session = await issueOperatorSession(account.id)
    void reply.header("set-cookie", sessionCookieHeader(session.token, Math.floor(OPERATOR_SESSION_TTL_MS / 1000), cookieSecure()))
    return { ok: true, username, token: session.token }
  })

  app.post(`${API_PREFIX}/admin/auth/logout`, async (req, reply) => {
    await revokeOperatorSession(extractSessionToken(req.headers as Record<string, unknown>))
    void reply.header("set-cookie", clearSessionCookieHeader(cookieSecure()))
    return { ok: true }
  })
}
