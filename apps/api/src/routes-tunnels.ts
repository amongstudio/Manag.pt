import type { FastifyInstance } from "fastify"
import { API_PREFIX } from "@workspace/shared"

import { appendAudit } from "./audit.js"
import { errorBody } from "./lib.js"
import { operatorAuthorized } from "./operator-auth.js"
import { getTunnelSupervisor } from "./tunnel-store.js"

async function actorOf(headers: Record<string, unknown>): Promise<string> {
  const authed = await operatorAuthorized(headers)
  return authed.username || "operator"
}

export async function registerTunnelRoutes(app: FastifyInstance): Promise<void> {
  app.get(`${API_PREFIX}/admin/tunnels`, async () => {
    return { tunnel: await getTunnelSupervisor().view() }
  })

  app.put(`${API_PREFIX}/admin/tunnels`, async (req, reply) => {
    const saved = await getTunnelSupervisor().save(req.body)
    if (!saved.ok) return reply.code(saved.http).send(errorBody(saved.error))
    await appendAudit({
      actor: await actorOf(req.headers as Record<string, unknown>),
      action: "tunnel_save",
      detail: { provider: saved.tunnel.provider },
    })
    return { tunnel: saved.tunnel }
  })

  app.post(`${API_PREFIX}/admin/tunnels/start`, async (req, reply) => {
    const started = await getTunnelSupervisor().start(req.body ?? {})
    if (!started.ok) {
      return reply.code(started.http).send(
        started.install ? errorBody(started.error, { install: started.install, provider: started.provider }) : errorBody(started.error)
      )
    }
    await appendAudit({
      actor: await actorOf(req.headers as Record<string, unknown>),
      action: "tunnel_start",
      detail: { provider: started.tunnel.provider, exposeApi: started.tunnel.exposeApi },
    })
    return { tunnel: started.tunnel }
  })

  app.post(`${API_PREFIX}/admin/tunnels/stop`, async (req) => {
    const stopped = await getTunnelSupervisor().stop()
    await appendAudit({
      actor: await actorOf(req.headers as Record<string, unknown>),
      action: "tunnel_stop",
      detail: { provider: stopped.tunnel.provider },
    })
    return { tunnel: stopped.tunnel }
  })
}
