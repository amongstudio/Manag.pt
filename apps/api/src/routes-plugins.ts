import fsp from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"

import type { FastifyInstance } from "fastify"
import { prisma, type Plugin, type PluginDeviceGrant } from "@workspace/db"
import { API_PREFIX, PLUGIN_RUNTIME_SET, pluginFromTemplateSchema, pluginGrantsSchema } from "@workspace/shared"

import { env, dataPath } from "./env.js"
import { errorBody, multipartValue, randomToken } from "./lib.js"
import { isFileTooLargeError, readMultipartFile, writeUploadStream } from "./upload.js"
import {
  getPluginStarter,
  listPluginStarters,
  readPluginStarterSource,
  type PluginStarterRuntime,
} from "./plugin-templates.js"

function parseBool(raw: string): boolean {
  switch (raw.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true
    default:
      return false
  }
}

function clampTimeout(raw: string): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return 60
  return Math.min(900, Math.max(1, Math.floor(n)))
}

async function serializePlugin(row: Plugin & { grants: PluginDeviceGrant[] }) {
  let size = 0
  try {
    size = (await fsp.stat(row.path)).size
  } catch {
    /* missing blob */
  }
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    runtime: row.runtime,
    platform: row.platform,
    arch: row.arch,
    sha256: row.sha256,
    timeoutSec: row.timeoutSec,
    networkAllowed: row.networkAllowed,
    createdAt: row.createdAt,
    size,
    grants: row.allDevices ? ["*"] : row.grants.map((g) => g.deviceId),
  }
}

export async function registerPluginRoutes(app: FastifyInstance): Promise<void> {
  app.get(`${API_PREFIX}/admin/plugins/templates`, async () => {
    return { templates: listPluginStarters() }
  })

  app.post(`${API_PREFIX}/admin/plugins/from-template`, async (req, reply) => {
    const parsed = pluginFromTemplateSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send(errorBody("invalid_body", parsed.error.flatten()))
    const starter = getPluginStarter(parsed.data.templateId)
    if (!starter) return reply.code(404).send(errorBody("unknown_template"))
    const runtime = (parsed.data.runtime ?? starter.defaultRuntime) as PluginStarterRuntime
    if (!starter.runtimes.includes(runtime)) {
      return reply.code(400).send(errorBody("invalid_runtime", { runtime, allowed: starter.runtimes }))
    }
    const file = readPluginStarterSource(starter, runtime)
    if (!file) return reply.code(500).send(errorBody("template_source_missing"))
    const destDir = dataPath("plugins")
    await fsp.mkdir(destDir, { recursive: true })
    const sha256 = createHash("sha256").update(file.source).digest("hex")
    const row = await prisma.plugin.create({
      data: {
        name: parsed.data.name ?? starter.name,
        version: parsed.data.version ?? "1.0.0",
        runtime,
        platform: parsed.data.platform ?? starter.suggestedPlatform ?? null,
        arch: parsed.data.arch ?? null,
        sha256,
        path: path.join(destDir, "pending"),
        timeoutSec: parsed.data.timeoutSec ?? starter.timeoutSec,
        networkAllowed: parsed.data.networkAllowed ?? starter.networkAllowed,
      },
      include: { grants: true },
    })
    const dest = path.join(destDir, row.id)
    try {
      await fsp.writeFile(dest, file.source)
    } catch (error) {
      await prisma.plugin.delete({ where: { id: row.id } }).catch(() => undefined)
      throw error
    }
    const updated = await prisma.plugin.update({
      where: { id: row.id },
      data: { path: dest },
      include: { grants: true },
    })
    return { plugin: await serializePlugin(updated) }
  })

  app.get(`${API_PREFIX}/admin/plugins`, async () => {
    const plugins = await prisma.plugin.findMany({
      orderBy: { createdAt: "desc" },
      include: { grants: true },
    })
    return { plugins: await Promise.all(plugins.map(serializePlugin)) }
  })

  app.get(`${API_PREFIX}/admin/plugins/:id`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const row = await prisma.plugin.findUnique({ where: { id }, include: { grants: true } })
    if (!row) return reply.code(404).send(errorBody("not_found"))
    return { plugin: await serializePlugin(row) }
  })

  app.post(`${API_PREFIX}/admin/plugins`, async (req, reply) => {
    const taken = await readMultipartFile(() => req.file())
    if (!taken.ok) return reply.code(400).send(errorBody("file_too_large"))
    const file = taken.file
    if (!file) return reply.code(400).send(errorBody("file_required"))
    const name = multipartValue(file.fields as never, "name")
    const version = multipartValue(file.fields as never, "version")
    const runtime = multipartValue(file.fields as never, "runtime")
    const platform = multipartValue(file.fields as never, "platform") || null
    const arch = multipartValue(file.fields as never, "arch") || null
    const timeoutSec = clampTimeout(multipartValue(file.fields as never, "timeoutSec"))
    const networkAllowed = parseBool(multipartValue(file.fields as never, "networkAllowed"))
    if (!name || !version) return reply.code(400).send(errorBody("missing_meta"))
    if (!PLUGIN_RUNTIME_SET.has(runtime)) return reply.code(400).send(errorBody("invalid_runtime"))
    const destDir = dataPath("plugins")
    await fsp.mkdir(destDir, { recursive: true })
    const tmp = path.join(destDir, `tmp-${randomToken(8)}`)
    const hash = createHash("sha256")
    try {
      await writeUploadStream(file.file, tmp, {
        maxBytes: env.maxUploadBytes,
        onChunk: (buf) => {
          hash.update(buf)
        },
      })
    } catch (error) {
      if (isFileTooLargeError(error)) {
        return reply.code(400).send(errorBody("file_too_large"))
      }
      throw error
    }
    const sha256 = hash.digest("hex")
    const row = await prisma.plugin.create({
      data: {
        name,
        version,
        runtime,
        platform,
        arch,
        sha256,
        path: tmp,
        timeoutSec,
        networkAllowed,
      },
      include: { grants: true },
    })
    const dest = path.join(destDir, row.id)
    try {
      await fsp.rename(tmp, dest)
    } catch (error) {
      await fsp.unlink(tmp).catch(() => undefined)
      await prisma.plugin.delete({ where: { id: row.id } }).catch(() => undefined)
      throw error
    }
    const updated = await prisma.plugin.update({
      where: { id: row.id },
      data: { path: dest },
      include: { grants: true },
    })
    return { plugin: await serializePlugin(updated) }
  })

  app.put(`${API_PREFIX}/admin/plugins/:id/grants`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = pluginGrantsSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send(errorBody("invalid_body", parsed.error.flatten()))
    const plugin = await prisma.plugin.findUnique({ where: { id } })
    if (!plugin) return reply.code(404).send(errorBody("not_found"))
    const unique = [...new Set(parsed.data.deviceIds.map((d) => d.trim()).filter(Boolean))]
    const allDevices = unique.includes("*")
    const requested = unique.filter((deviceId) => deviceId !== "*")
    let deviceIds: string[] = []
    if (!allDevices && requested.length) {
      const found = await prisma.device.findMany({
        where: { id: { in: requested } },
        select: { id: true },
      })
      const foundSet = new Set(found.map((row) => row.id))
      const missing = requested.filter((deviceId) => !foundSet.has(deviceId))
      if (missing.length) {
        return reply.code(400).send(errorBody("unknown_devices", { missing }))
      }
      deviceIds = requested
    }
    await prisma.$transaction([
      prisma.plugin.update({ where: { id }, data: { allDevices } }),
      prisma.pluginDeviceGrant.deleteMany({ where: { pluginId: id } }),
      ...(allDevices || !deviceIds.length
        ? []
        : [
            prisma.pluginDeviceGrant.createMany({
              data: deviceIds.map((deviceId) => ({ pluginId: id, deviceId })),
            }),
          ]),
    ])
    const row = await prisma.plugin.findUnique({ where: { id }, include: { grants: true } })
    return { plugin: await serializePlugin(row!) }
  })

  app.delete(`${API_PREFIX}/admin/plugins/:id`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const row = await prisma.plugin.findUnique({ where: { id } })
    if (!row) return reply.code(404).send(errorBody("not_found"))
    await fsp.unlink(row.path).catch(() => undefined)
    await prisma.plugin.delete({ where: { id } })
    return { ok: true }
  })
}
