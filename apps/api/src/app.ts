import "./env.js"

import cors from "@fastify/cors"
import multipart from "@fastify/multipart"
import rateLimit from "@fastify/rate-limit"
import Fastify from "fastify"

import { env } from "./env.js"
import { attachSocket } from "./ws.js"
import { registerAgentWs } from "./agent-ws.js"
import { registerAgentRoutes } from "./routes-agent.js"
import { registerAdminRoutes } from "./routes-admin.js"
import { registerCredentialRoutes } from "./routes-credentials.js"
import { registerChatRoutes } from "./routes-chat.js"
import { registerPluginRoutes } from "./routes-plugins.js"
import { registerBuilderRoutes } from "./routes-builder.js"
import { registerPlatformRoutes } from "./routes-platform.js"
import { registerScanRoutes } from "./routes-scans.js"
import { registerConfigRoutes } from "./routes-config.js"
import { primeOperatorConfig } from "./operator-config.js"
import { startJobs } from "./jobs.js"
import { getSettings } from "./settings.js"
import { clientIp, httpRateLimitBucket, ipAllowed } from "./lib.js"
import { requireOperator, operatorTokenConfigured, passwordAuthEnabled } from "./operator-auth.js"
import { registerAuthRoutes } from "./routes-auth.js"
import { hydrateRemoteSessions } from "./remote-session.js"
import { restoreE2ESession } from "./e2e-relay.js"
import { API_PREFIX } from "@workspace/shared"

function isHealthz(url: string | undefined): boolean {
  const path = (url ?? "").split("?")[0]
  return path === "/healthz"
}

async function main() {
  await getSettings()
  await primeOperatorConfig().catch((error) => {
    console.error("config seed failed", error instanceof Error ? error.message : error)
  })
  const restored = await hydrateRemoteSessions()
  for (const session of restored) restoreE2ESession(session)

  const app = Fastify({
    logger: true,
    bodyLimit: 12 * 1024 * 1024,
    trustProxy: env.trustProxy,
  })

  await app.register(cors, {
    origin: env.cors.origin,
    credentials: env.cors.credentials,
  })
  await app.register(multipart, {
    limits: { fileSize: env.maxUploadBytes, files: 1 },
  })
  await app.register(rateLimit, {
    max: env.rateLimitPerMinute,
    timeWindow: "1 minute",
    keyGenerator: (req) => `${httpRateLimitBucket(req.url)}:${clientIp(req.headers as Record<string, unknown>, req.ip)}`,
  })

  app.addHook("onRequest", async (req, reply) => {
    if (isHealthz(req.url)) return
    const path = (req.url ?? "").split("?")[0] ?? ""
    if (path.startsWith(`${API_PREFIX}/admin`)) {
      if (!(await requireOperator(req, reply))) return
    }
    if (env.ipAllowlist.length === 0) return
    const ip = clientIp(req.headers as Record<string, unknown>, req.ip)
    if (!ipAllowed(ip, env.ipAllowlist)) {
      return reply.code(403).send({ error: "ip_not_allowed", details: { ip } })
    }
  })

  app.get("/healthz", async () => ({ ok: true }))

  attachSocket(app)
  await registerAgentWs(app)
  await registerAgentRoutes(app)
  await registerAdminRoutes(app)
  await registerCredentialRoutes(app)
  await registerAuthRoutes(app)
  await registerChatRoutes(app)
  await registerPluginRoutes(app)
  await registerBuilderRoutes(app)
  await registerPlatformRoutes(app)
  await registerScanRoutes(app)
  await registerConfigRoutes(app)
  startJobs(app)

  await app.listen({ port: env.port, host: env.host })
  app.log.info(`API listening on ${env.host}:${env.port}`)
  if (!operatorTokenConfigured() && !(await passwordAuthEnabled())) {
    app.log.warn(
      "OPERATOR_TOKEN is unset and no operator password exists; /api/v1/admin/* and Socket.io are open. Set OPERATOR_TOKEN in production."
    )
  }

  let closing = false
  const shutdown = async (signal: string) => {
    if (closing) return
    closing = true
    app.log.info({ signal }, "shutting down")
    try {
      await app.io.close()
    } catch {
      /* ignore */
    }
    try {
      await app.close()
    } catch (error) {
      app.log.error({ err: error }, "close failed")
    }
    process.exit(0)
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"))
  process.on("SIGINT", () => void shutdown("SIGINT"))
}

process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection", reason)
})

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
