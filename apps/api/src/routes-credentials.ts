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
import { appendAudit } from "./audit.js"
import { emitFleet } from "./io-emit.js"
import { errorBody } from "./lib.js"
import { requestActor } from "./operator-auth.js"
import { decryptVaultSecret, prepareCredentialCommand, toPublicVault } from "./vault.js"

export async function registerCredentialRoutes(app: FastifyInstance): Promise<void> {
  app.get(`${API_PREFIX}/admin/devices/:id/credentials`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const device = await prisma.device.findUnique({ where: { id }, select: { id: true } })
    if (!device) return reply.code(404).send(errorBody("not_found"))
    const rows = await prisma.deviceCredential.findMany({
      where: { deviceId: id },
      orderBy: [{ source: "asc" }, { target: "asc" }],
    })
    return { credentials: rows.map(toPublicVault) }
  })

  app.get(`${API_PREFIX}/admin/devices/:id/credentials/:credId`, async (req, reply) => {
    const { id, credId } = req.params as { id: string; credId: string }
    const reveal = String((req.query as { reveal?: string }).reveal ?? "") === "1"
    const row = await prisma.deviceCredential.findFirst({ where: { id: credId, deviceId: id } })
    if (!row) return reply.code(404).send(errorBody("not_found"))
    const pub = toPublicVault(row)
    if (!reveal) return { credential: pub }
    if (pub.secretState === "unsupported_source") return reply.code(404).send(errorBody("secret_unsupported_source"))
    if (pub.secretState === "metadata_only") return reply.code(404).send(errorBody("secret_not_vaulted"))
    let secret = ""
    try {
      secret = decryptVaultSecret(row.secretEnc)
    } catch {
      return reply.code(409).send(errorBody("vault_decrypt_failed"))
    }
    const actor = await requestActor(req)
    await appendAudit({
      actor,
      action: "credential_reveal",
      deviceId: id,
      detail: { credId: row.id, source: row.source, kind: row.kind, target: row.target },
    })
    app.log.info({ deviceId: id, credId: row.id, source: row.source, target: row.target }, "credential revealed")
    return { credential: { ...pub, secret } }
  })

  app.delete(`${API_PREFIX}/admin/devices/:id/credentials/:credId`, async (req, reply) => {
    const { id, credId } = req.params as { id: string; credId: string }
    const row = await prisma.deviceCredential.findFirst({ where: { id: credId, deviceId: id } })
    if (!row) return reply.code(404).send(errorBody("not_found"))
    await prisma.deviceCredential.delete({ where: { id: row.id } })
    await appendAudit({
      actor: await requestActor(req),
      action: "credential_unvault",
      deviceId: id,
      detail: { credId: row.id, source: row.source, target: row.target },
    })
    app.log.info({ deviceId: id, credId: row.id }, "vault credential deleted")
    return { ok: true, id: row.id }
  })

  app.post(`${API_PREFIX}/admin/devices/:id/credentials/clear-secrets`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { confirm?: unknown }
    if (body.confirm !== true) return reply.code(400).send(errorBody("confirm_required"))
    const device = await prisma.device.findUnique({ where: { id }, select: { id: true } })
    if (!device) return reply.code(404).send(errorBody("not_found"))
    const cleared = await prisma.deviceCredential.updateMany({
      where: { deviceId: id, secretEnc: { not: "" } },
      data: { secretEnc: "" },
    })
    await appendAudit({
      actor: await requestActor(req),
      action: "credential_vault_clear",
      deviceId: id,
      detail: { cleared: cleared.count },
    })
    app.log.info({ deviceId: id, cleared: cleared.count }, "vault secrets cleared")
    return { ok: true, cleared: cleared.count }
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
