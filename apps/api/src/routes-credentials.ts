import type { FastifyInstance } from "fastify"
import { prisma } from "@workspace/db"
import {
  API_PREFIX,
  WS_EVENTS,
  credentialGenerateConfirm,
  credentialRestoreConfirm,
  validateCommandPayload,
  type CommandType,
} from "@workspace/shared"

import { dispatchQueuedCommands } from "./agent-ws.js"
import { emitFleet } from "./io-emit.js"
import { errorBody } from "./lib.js"
import { operatorAuthorized } from "./operator-auth.js"
import { decryptVaultSecret, prepareCredentialCommand, toPublicVault } from "./vault.js"
import { createStoredCredential, deleteStoredCredential, revealStoredCredential, updateStoredCredential } from "./vault-store.js"

async function actorOf(headers: Record<string, unknown>): Promise<string> {
  const authed = await operatorAuthorized(headers)
  return authed.username || "operator"
}

export async function registerCredentialRoutes(app: FastifyInstance): Promise<void> {
  app.get(`${API_PREFIX}/admin/devices/:id/credentials`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const device = await prisma.device.findUnique({ where: { id }, select: { id: true } })
    if (!device) return reply.code(404).send(errorBody("not_found"))
    const includeFleet = String((req.query as { includeFleet?: string }).includeFleet ?? "") === "1"
    const rows = await prisma.deviceCredential.findMany({
      where: { deviceId: id, scope: "device" },
      orderBy: [{ source: "asc" }, { target: "asc" }],
    })
    const fleet = includeFleet ? await prisma.deviceCredential.findMany({ where: { scope: "fleet" }, orderBy: { target: "asc" } }) : []
    return {
      credentials: [...rows, ...fleet].map((row) => ({ ...toPublicVault(row), scope: row.scope, deviceId: row.deviceId })),
    }
  })

  app.get(`${API_PREFIX}/admin/devices/:id/credentials/:credId`, async (req, reply) => {
    const { id, credId } = req.params as { id: string; credId: string }
    const row = await prisma.deviceCredential.findFirst({ where: { id: credId, deviceId: id, scope: "device" } })
    if (!row) return reply.code(404).send(errorBody("not_found"))
    return { credential: { ...toPublicVault(row), scope: row.scope, deviceId: row.deviceId } }
  })

  app.post(`${API_PREFIX}/admin/devices/:id/credentials`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { target?: string; username?: string; secret?: string; comment?: string; scope?: string; source?: string }
    const scope = body.scope === "fleet" ? "fleet" : "device"
    if (scope === "device") {
      const device = await prisma.device.findUnique({ where: { id }, select: { id: true } })
      if (!device) return reply.code(404).send(errorBody("not_found"))
    }
    try {
      const credential = await createStoredCredential({
        deviceId: scope === "fleet" ? null : id,
        scope,
        target: body.target ?? "",
        username: body.username,
        secret: body.secret ?? "",
        comment: body.comment,
        source: body.source,
        actor: await actorOf(req.headers as Record<string, unknown>),
      })
      return { credential }
    } catch (error) {
      const code = error instanceof Error ? error.message : "invalid_body"
      return reply.code(400).send(errorBody(code))
    }
  })

  app.put(`${API_PREFIX}/admin/devices/:id/credentials/:credId`, async (req, reply) => {
    const { id, credId } = req.params as { id: string; credId: string }
    const body = (req.body ?? {}) as { secret?: string; scope?: string }
    const saved = await updateStoredCredential({
      deviceId: body.scope === "fleet" ? null : id,
      id: credId,
      secret: body.secret ?? "",
      actor: await actorOf(req.headers as Record<string, unknown>),
    })
    if (!saved.ok) return reply.code(saved.error === "not_found" ? 404 : 400).send(errorBody(saved.error))
    return { credential: saved.credential }
  })

  app.post(`${API_PREFIX}/admin/devices/:id/credentials/:credId/reveal`, async (req, reply) => {
    const { id, credId } = req.params as { id: string; credId: string }
    const body = (req.body ?? {}) as { scope?: string }
    try {
      const revealed = await revealStoredCredential(body.scope === "fleet" ? null : id, credId)
      app.log.info({ deviceId: id, credId }, "credential revealed")
      return { credential: { target: revealed.target, secret: revealed.secret } }
    } catch {
      return reply.code(404).send(errorBody("not_found"))
    }
  })

  app.delete(`${API_PREFIX}/admin/devices/:id/credentials/:credId`, async (req, reply) => {
    const { id, credId } = req.params as { id: string; credId: string }
    const removed = await deleteStoredCredential({
      deviceId: id,
      id: credId,
      actor: await actorOf(req.headers as Record<string, unknown>),
    })
    if (!removed) {
      const fleet = await deleteStoredCredential({
        deviceId: null,
        id: credId,
        actor: await actorOf(req.headers as Record<string, unknown>),
      })
      if (!fleet) return reply.code(404).send(errorBody("not_found"))
    }
    return { ok: true, id: credId }
  })

  app.post(`${API_PREFIX}/admin/devices/:id/credentials/backup`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const device = await prisma.device.findUnique({ where: { id }, select: { id: true } })
    if (!device) return reply.code(404).send(errorBody("not_found"))
    const body = (req.body ?? {}) as { sources?: string[] }
    const type = "backup_credentials" as CommandType
    const checked = validateCommandPayload(type, { sources: body.sources })
    if (!checked.ok) return reply.code(400).send(errorBody("invalid_payload", checked.error.flatten()))
    const row = await prisma.command.create({
      data: { deviceId: id, type, payload: JSON.stringify(checked.payload), createdBy: "operator" },
    })
    await dispatchQueuedCommands(app, id)
    emitFleet(app, WS_EVENTS.COMMAND_QUEUED, { id: row.id, deviceId: id, type, status: row.status })
    app.log.info({ deviceId: id, commandId: row.id }, "credential backup queued")
    return { command: { id: row.id, type, status: row.status } }
  })

  app.post(`${API_PREFIX}/admin/devices/:id/credentials/generate`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const device = await prisma.device.findUnique({ where: { id }, select: { id: true } })
    if (!device) return reply.code(404).send(errorBody("not_found"))
    const type = "generate_credential" as CommandType
    const checked = validateCommandPayload(type, (req.body as Record<string, unknown>) ?? {})
    if (!checked.ok) return reply.code(400).send(errorBody("invalid_payload", checked.error.flatten()))
    const row = await prisma.command.create({
      data: { deviceId: id, type, payload: JSON.stringify(checked.payload), createdBy: "operator" },
    })
    await dispatchQueuedCommands(app, id)
    emitFleet(app, WS_EVENTS.COMMAND_QUEUED, { id: row.id, deviceId: id, type, status: row.status })
    return {
      command: { id: row.id, type, status: row.status },
      confirm: credentialGenerateConfirm(Boolean((checked.payload as { save?: boolean }).save)),
    }
  })

  app.post(`${API_PREFIX}/admin/devices/:id/credentials/restore`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const device = await prisma.device.findUnique({ where: { id }, select: { id: true } })
    if (!device) return reply.code(404).send(errorBody("not_found"))
    const body = (req.body ?? {}) as { ids?: string[] }
    const where = body.ids?.length
      ? { deviceId: id, id: { in: body.ids.slice(0, 50) }, secretEnc: { not: "" } }
      : { deviceId: id, secretEnc: { not: "" } }
    const rows = await prisma.deviceCredential.findMany({ where, take: 50 })
    if (!rows.length) return reply.code(400).send(errorBody("vault_empty"))
    const credentials: Array<Record<string, unknown>> = []
    for (const row of rows) {
      if (row.source === "browser" || row.source === "bitlocker") continue
      let secret = ""
      try {
        secret = decryptVaultSecret(row.secretEnc)
      } catch {
        continue
      }
      if (!secret) continue
      credentials.push({
        source: row.source === "apps" || row.source === "generated" ? row.source : "windows",
        target: row.target,
        username: row.username || undefined,
        secret,
        persist: row.persist || undefined,
        comment: row.comment || undefined,
      })
    }
    if (!credentials.length) return reply.code(400).send(errorBody("nothing_to_restore"))
    const type = "restore_credentials" as CommandType
    const checked = validateCommandPayload(type, { credentials })
    if (!checked.ok) return reply.code(400).send(errorBody("invalid_payload", checked.error.flatten()))
    const payload = await prepareCredentialCommand(id, type, checked.payload)
    const row = await prisma.command.create({
      data: { deviceId: id, type, payload: JSON.stringify(payload), createdBy: "operator" },
    })
    await dispatchQueuedCommands(app, id)
    emitFleet(app, WS_EVENTS.COMMAND_QUEUED, { id: row.id, deviceId: id, type, status: row.status })
    app.log.info({ deviceId: id, count: credentials.length }, "credential restore queued")
    return {
      command: { id: row.id, type, status: row.status },
      count: credentials.length,
      confirm: credentialRestoreConfirm(credentials.length),
    }
  })
}
