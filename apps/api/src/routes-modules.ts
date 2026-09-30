import fsp from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"

import type { FastifyInstance, FastifyRequest } from "fastify"
import {
  Prisma,
  prisma,
  type ModuleArtifact,
  type ModuleDeviceGrant,
} from "@workspace/db"
import {
  API_PREFIX,
  moduleArgumentsSchemaSchema,
  moduleGrantsSchema,
  modulePatchSchema,
  moduleRegistrationSchema,
  moduleRunRequestSchema,
  WS_EVENTS,
} from "@workspace/shared"

import { buildAuditRow } from "./audit.js"
import { dispatchQueuedCommands } from "./agent-ws.js"
import { env, dataPath } from "./env.js"
import { emitFleet } from "./io-emit.js"
import { errorBody, multipartValue, randomToken } from "./lib.js"
import { filterModuleTargets } from "./module-access.js"
import { inspectPeArtifact } from "./module-artifact.js"
import {
  moduleManifestFromRow,
  moduleSigner,
  signModuleManifest,
  verifyStoredModule,
} from "./module-signing.js"
import { operatorAuthorized } from "./operator-auth.js"
import {
  isFileTooLargeError,
  readMultipartFile,
  writeUploadStream,
} from "./upload.js"

type ModuleRow = ModuleArtifact & { grants: ModuleDeviceGrant[] }

async function actorOf(req: FastifyRequest): Promise<string> {
  const auth = await operatorAuthorized(req.headers as Record<string, unknown>)
  return auth.username || "operator"
}

function parseIntField(raw: string): number {
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : Number.NaN
}

function parseArgumentsSchema(raw: string): unknown {
  if (!raw.trim()) return []
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

function serializeModule(row: ModuleRow) {
  const signatureValid = verifyStoredModule(row)
  let argumentsSchema: unknown[] = []
  try {
    argumentsSchema = moduleArgumentsSchemaSchema.parse(
      JSON.parse(row.argumentsSchema) as unknown
    )
  } catch {
    // A corrupt manifest must remain visible to admins but cannot be enabled or dispatched.
  }
  return {
    id: row.id,
    displayName: row.displayName,
    version: row.version,
    kind: row.kind,
    platform: row.platform,
    arch: row.arch,
    sha256: row.sha256,
    size: row.size,
    signer: row.signer,
    signature: row.signature,
    signatureValid,
    entrypoint: row.entrypoint,
    action: row.action,
    argumentsSchema,
    timeoutSec: row.timeoutSec,
    maxOutputBytes: row.maxOutputBytes,
    networkAllowed: row.networkAllowed,
    enabled: row.enabled,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    grants: row.allDevices ? ["*"] : row.grants.map((grant) => grant.deviceId),
    dllHostSupported: false,
  }
}

export async function registerModuleRoutes(
  app: FastifyInstance
): Promise<void> {
  app.get(`${API_PREFIX}/admin/modules`, async () => {
    const modules = await prisma.moduleArtifact.findMany({
      orderBy: { createdAt: "desc" },
      include: { grants: true },
    })
    return { modules: modules.map(serializeModule), signer: moduleSigner() }
  })

  app.get(`${API_PREFIX}/admin/modules/:id`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const module = await prisma.moduleArtifact.findUnique({
      where: { id },
      include: { grants: true },
    })
    if (!module) return reply.code(404).send(errorBody("not_found"))
    return { module: serializeModule(module), signer: moduleSigner() }
  })

  app.post(`${API_PREFIX}/admin/modules`, async (req, reply) => {
    const taken = await readMultipartFile(() => req.file())
    if (!taken.ok) return reply.code(400).send(errorBody("file_too_large"))
    const file = taken.file
    if (!file) return reply.code(400).send(errorBody("file_required"))
    const fields = file.fields as never
    const parsed = moduleRegistrationSchema.safeParse({
      id: multipartValue(fields, "id"),
      displayName: multipartValue(fields, "displayName"),
      version: multipartValue(fields, "version"),
      kind: multipartValue(fields, "kind"),
      platform: multipartValue(fields, "platform"),
      arch: multipartValue(fields, "arch"),
      entrypoint: multipartValue(fields, "entrypoint"),
      action: multipartValue(fields, "action"),
      argumentsSchema: parseArgumentsSchema(
        multipartValue(fields, "argumentsSchema")
      ),
      timeoutSec: parseIntField(multipartValue(fields, "timeoutSec")),
      maxOutputBytes: parseIntField(multipartValue(fields, "maxOutputBytes")),
    })
    if (!parsed.success)
      return reply
        .code(400)
        .send(errorBody("invalid_manifest", parsed.error.flatten()))
    if (
      await prisma.moduleArtifact.findUnique({
        where: { id: parsed.data.id },
        select: { id: true },
      })
    ) {
      return reply.code(409).send(errorBody("module_id_exists"))
    }
    const expectedExt = parsed.data.kind === "exe" ? ".exe" : ".dll"
    if (
      path.extname(file.filename).toLowerCase() !== expectedExt ||
      path.extname(parsed.data.entrypoint).toLowerCase() !== expectedExt
    ) {
      return reply.code(400).send(errorBody("artifact_extension_mismatch"))
    }

    const root = dataPath("modules")
    await fsp.mkdir(root, { recursive: true })
    const tmp = path.join(root, `tmp-${randomToken(12)}`)
    const hash = createHash("sha256")
    let size = 0
    try {
      size = await writeUploadStream(file.file, tmp, {
        maxBytes: env.maxUpdateBytes,
        onChunk: (chunk) => hash.update(chunk),
      })
    } catch (error) {
      if (isFileTooLargeError(error))
        return reply.code(400).send(errorBody("file_too_large"))
      throw error
    }
    if (size <= 0) {
      await fsp.unlink(tmp).catch(() => undefined)
      return reply.code(400).send(errorBody("empty_artifact"))
    }
    let inspected
    try {
      inspected = await inspectPeArtifact(tmp)
    } catch (error) {
      await fsp.unlink(tmp).catch(() => undefined)
      return reply.code(400).send(
        errorBody("invalid_pe_artifact", {
          reason: error instanceof Error ? error.message : "invalid",
        })
      )
    }
    if (
      inspected.kind !== parsed.data.kind ||
      inspected.arch !== parsed.data.arch
    ) {
      await fsp.unlink(tmp).catch(() => undefined)
      return reply
        .code(400)
        .send(errorBody("artifact_manifest_mismatch", { inspected }))
    }
    const sha256 = hash.digest("hex")
    const manifest = {
      ...parsed.data,
      sha256,
      size,
      networkAllowed: false,
    }
    const signed = signModuleManifest(manifest)
    const moduleDir = path.join(root, parsed.data.id)
    await fsp.mkdir(moduleDir, { recursive: true })
    const dest = path.join(moduleDir, `${sha256}${expectedExt}`)
    const actor = await actorOf(req)
    let moved = false
    try {
      await fsp.rename(tmp, dest)
      moved = true
      const module = await prisma.$transaction(async (tx) => {
        const created = await tx.moduleArtifact.create({
          data: {
            id: parsed.data.id,
            displayName: parsed.data.displayName,
            version: parsed.data.version,
            kind: parsed.data.kind,
            platform: parsed.data.platform,
            arch: parsed.data.arch,
            sha256,
            size,
            signer: signed.signer,
            signature: signed.signature,
            path: dest,
            entrypoint: parsed.data.entrypoint,
            action: parsed.data.action,
            argumentsSchema: JSON.stringify(parsed.data.argumentsSchema),
            timeoutSec: parsed.data.timeoutSec,
            maxOutputBytes: parsed.data.maxOutputBytes,
            networkAllowed: false,
            enabled: false,
          },
          include: { grants: true },
        })
        await tx.auditLog.create({
          data: buildAuditRow({
            actor,
            action: "module_register",
            detail: {
              id: created.id,
              version: created.version,
              kind: created.kind,
              platform: created.platform,
              arch: created.arch,
              sha256: created.sha256,
              size: created.size,
            },
          }),
        })
        return created
      })
      return reply.code(201).send({ module: serializeModule(module) })
    } catch (error) {
      await fsp.unlink(tmp).catch(() => undefined)
      if (moved) await fsp.unlink(dest).catch(() => undefined)
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return reply.code(409).send(errorBody("module_id_exists"))
      }
      throw error
    }
  })

  app.patch(`${API_PREFIX}/admin/modules/:id`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = modulePatchSchema.safeParse(req.body)
    if (!parsed.success)
      return reply
        .code(400)
        .send(errorBody("invalid_body", parsed.error.flatten()))
    const existing = await prisma.moduleArtifact.findUnique({ where: { id } })
    if (!existing) return reply.code(404).send(errorBody("not_found"))
    if (existing.revokedAt)
      return reply.code(410).send(errorBody("module_revoked"))
    if (!verifyStoredModule(existing))
      return reply.code(409).send(errorBody("module_signature_invalid"))
    const next = {
      ...existing,
      ...parsed.data,
      argumentsSchema: parsed.data.argumentsSchema
        ? JSON.stringify(parsed.data.argumentsSchema)
        : existing.argumentsSchema,
    }
    const signed = signModuleManifest(moduleManifestFromRow(next))
    const actor = await actorOf(req)
    const action =
      parsed.data.enabled === true
        ? "module_enable"
        : parsed.data.enabled === false
          ? "module_disable"
          : "module_update"
    const module = await prisma.$transaction(async (tx) => {
      const updated = await tx.moduleArtifact.update({
        where: { id },
        data: {
          ...parsed.data,
          argumentsSchema: next.argumentsSchema,
          signer: signed.signer,
          signature: signed.signature,
        },
        include: { grants: true },
      })
      await tx.auditLog.create({
        data: buildAuditRow({
          actor,
          action,
          detail: {
            id,
            fields: Object.keys(parsed.data),
            signature: updated.signature,
          },
        }),
      })
      return updated
    })
    return { module: serializeModule(module) }
  })

  app.put(`${API_PREFIX}/admin/modules/:id/grants`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = moduleGrantsSchema.safeParse(req.body)
    if (!parsed.success)
      return reply
        .code(400)
        .send(errorBody("invalid_body", parsed.error.flatten()))
    const module = await prisma.moduleArtifact.findUnique({ where: { id } })
    if (!module) return reply.code(404).send(errorBody("not_found"))
    if (module.revokedAt)
      return reply.code(410).send(errorBody("module_revoked"))
    if (!verifyStoredModule(module))
      return reply.code(409).send(errorBody("module_signature_invalid"))
    const unique = [...new Set(parsed.data.deviceIds)]
    const allDevices = unique.includes("*")
    const requested = unique.filter((deviceId) => deviceId !== "*")
    let deviceIds: string[] = []
    if (!allDevices && requested.length) {
      const found = await prisma.device.findMany({
        where: { id: { in: requested } },
        select: { id: true },
      })
      const foundIds = new Set(found.map((device) => device.id))
      const missing = requested.filter((deviceId) => !foundIds.has(deviceId))
      if (missing.length)
        return reply.code(400).send(errorBody("unknown_devices", { missing }))
      deviceIds = requested
    }
    const actor = await actorOf(req)
    await prisma.$transaction([
      prisma.moduleArtifact.update({ where: { id }, data: { allDevices } }),
      prisma.moduleDeviceGrant.deleteMany({ where: { moduleId: id } }),
      ...(allDevices || !deviceIds.length
        ? []
        : [
            prisma.moduleDeviceGrant.createMany({
              data: deviceIds.map((deviceId) => ({ moduleId: id, deviceId })),
            }),
          ]),
      prisma.auditLog.create({
        data: buildAuditRow({
          actor,
          action: "module_grants_update",
          detail: { id, grants: allDevices ? ["*"] : deviceIds },
        }),
      }),
    ])
    const updated = await prisma.moduleArtifact.findUniqueOrThrow({
      where: { id },
      include: { grants: true },
    })
    return { module: serializeModule(updated) }
  })

  app.post(`${API_PREFIX}/admin/modules/:id/revoke`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const existing = await prisma.moduleArtifact.findUnique({ where: { id } })
    if (!existing) return reply.code(404).send(errorBody("not_found"))
    if (existing.revokedAt)
      return reply.code(409).send(errorBody("already_revoked"))
    const revokedAt = new Date()
    const actor = await actorOf(req)
    await prisma.$transaction([
      prisma.moduleArtifact.update({
        where: { id },
        data: { enabled: false, allDevices: false, revokedAt },
      }),
      prisma.moduleDeviceGrant.deleteMany({ where: { moduleId: id } }),
      prisma.auditLog.create({
        data: buildAuditRow({
          actor,
          action: "module_revoke",
          detail: { id, version: existing.version, sha256: existing.sha256 },
        }),
      }),
    ])
    return { ok: true, revokedAt }
  })

  app.post(`${API_PREFIX}/admin/modules/:id/runs`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = moduleRunRequestSchema.safeParse(req.body)
    if (!parsed.success)
      return reply
        .code(400)
        .send(errorBody("invalid_body", parsed.error.flatten()))
    const filtered = await filterModuleTargets({
      moduleId: id,
      args: parsed.data.args,
      deviceIds: parsed.data.deviceIds,
    })
    if (!filtered.ok)
      return reply
        .code(filtered.status)
        .send(errorBody(filtered.error, filtered.details))
    if (!filtered.deviceIds.length) {
      return reply
        .code(403)
        .send(errorBody("module_target_denied", { skipped: filtered.skipped }))
    }
    const actor = await actorOf(req)
    const payload = JSON.stringify({
      moduleId: filtered.module.id,
      expectedSignature: filtered.module.signature,
      args: parsed.data.args,
    })
    const commands = await prisma.$transaction(async (tx) => {
      const created = await Promise.all(
        filtered.deviceIds.map((deviceId) =>
          tx.command.create({
            data: {
              deviceId,
              type: "run_module",
              payload,
              createdBy: actor.slice(0, 128),
            },
          })
        )
      )
      await tx.auditLog.create({
        data: buildAuditRow({
          actor,
          action: "module_run",
          detail: {
            id: filtered.module.id,
            version: filtered.module.version,
            signature: filtered.module.signature,
            deviceIds: filtered.deviceIds,
            commandIds: created.map((command) => command.id),
            skipped: filtered.skipped,
          },
        }),
      })
      return created
    })
    await Promise.all(
      commands.map(async (command) => {
        await dispatchQueuedCommands(app, command.deviceId)
        emitFleet(app, WS_EVENTS.COMMAND_QUEUED, {
          id: command.id,
          deviceId: command.deviceId,
          type: command.type,
          status: command.status,
        })
      })
    )
    return reply.code(202).send({
      commands: commands.map((command) => ({
        id: command.id,
        deviceId: command.deviceId,
        type: command.type,
        status: command.status,
      })),
      skipped: filtered.skipped,
    })
  })
}
