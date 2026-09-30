import { createHash, randomBytes } from "node:crypto"

import type { FastifyInstance, FastifyRequest } from "fastify"
import { Prisma, prisma } from "@workspace/db"
import { API_PREFIX, SCRIPT_TEMPLATES, resolveTemplateParameters, scriptTemplateById } from "@workspace/shared"

import { appendAudit, listAudit } from "./audit.js"
import { assistantNeedsConfirm, assistantPrompt, parseAssistantText, type AssistantAction } from "./assistant-lib.js"
import { queueDeviceCommand } from "./command-queue.js"
import { errorBody } from "./lib.js"
import { deviceInventory, jsonSafe } from "./inventory-store.js"
import { escapeLike, softwareFleetArgs } from "./inventory-lib.js"
import { normalizeMetrics, storeMetrics } from "./metrics.js"
import { operatorAuthorized } from "./operator-auth.js"
import { parseCron } from "./cron-match.js"
import { queueScriptRun } from "./scripts-run.js"
import { ScriptParameterError, validateScriptWrite, type ScriptLanguage } from "./scripts-lib.js"
import { getSettings } from "./settings.js"
import { openaiChatCompletionsUrl } from "./chat.js"
import { inMaintenanceWindow, nextUpdateApproval, normalizeKb, type RebootPolicy, REBOOT_POLICIES } from "./updates-lib.js"

async function actorOf(req: FastifyRequest): Promise<string> {
  const authed = await operatorAuthorized(req.headers as Record<string, unknown>)
  return authed.username || "operator"
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value)
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`
  return text
}

function htmlEscape(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

type SoftwareRow = {
  deviceId: string
  hostname: string
  name: string
  version: string
  publisher: string
  collectedAt: string
}

async function softwareFleet(name: string, version: string, limit: number): Promise<SoftwareRow[]> {
  const args = softwareFleetArgs(name, version, limit)
  const rows = await prisma.$queryRaw<SoftwareRow[]>(Prisma.sql`
    SELECT d.id AS deviceId, d.hostname AS hostname, s.name AS name, s.version AS version,
           s.publisher AS publisher, si.collectedAt AS collectedAt
    FROM SoftwareInstallation si
    INNER JOIN Software s ON s.id = si.softwareId
    INNER JOIN Device d ON d.id = si.deviceId
    WHERE si.collectedAt = (
      SELECT MAX(si2.collectedAt) FROM SoftwareInstallation si2 WHERE si2.deviceId = si.deviceId
    )
    AND (${args.name} = '' OR s.name LIKE ${"%" + escapeLike(args.name) + "%"} ESCAPE '\\')
    AND (${args.version} = '' OR s.version = ${args.version})
    ORDER BY s.name ASC, d.hostname ASC
    LIMIT ${args.limit}
  `)
  return rows
}

export async function registerPlatformRoutes(app: FastifyInstance): Promise<void> {
  app.get(`${API_PREFIX}/admin/scripts`, async () => {
    const scripts = await prisma.script.findMany({ orderBy: { updatedAt: "desc" }, take: 200 })
    return { scripts }
  })

  app.get(`${API_PREFIX}/admin/script-templates`, async () => ({ templates: SCRIPT_TEMPLATES }))

  app.post(`${API_PREFIX}/admin/scripts`, async (req, reply) => {
    const parsed = validateScriptWrite(req.body)
    if (!parsed.ok) return reply.code(400).send(errorBody(parsed.error))
    const script = await prisma.script.create({
      data: { ...parsed.value, parameters: JSON.stringify(parsed.value.parameters) },
    })
    await appendAudit({ actor: await actorOf(req), action: "script_create", detail: { id: script.id, name: script.name } })
    return { script }
  })

  app.put(`${API_PREFIX}/admin/scripts/:id`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = validateScriptWrite(req.body)
    if (!parsed.ok) return reply.code(400).send(errorBody(parsed.error))
    const existing = await prisma.script.findUnique({ where: { id } })
    if (!existing) return reply.code(404).send(errorBody("not_found"))
    const script = await prisma.script.update({
      where: { id },
      data: { ...parsed.value, parameters: JSON.stringify(parsed.value.parameters) },
    })
    await appendAudit({ actor: await actorOf(req), action: "script_update", detail: { id } })
    return { script }
  })

  app.delete(`${API_PREFIX}/admin/scripts/:id`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const existing = await prisma.script.findUnique({ where: { id } })
    if (!existing) return reply.code(404).send(errorBody("not_found"))
    await prisma.script.delete({ where: { id } })
    await appendAudit({ actor: await actorOf(req), action: "script_delete", detail: { id, name: existing.name } })
    return { ok: true }
  })

  app.get(`${API_PREFIX}/admin/script-runs`, async (req) => {
    const q = req.query as { deviceId?: string; scriptId?: string }
    const runs = await prisma.scriptRun.findMany({
      where: { deviceId: q.deviceId || undefined, scriptId: q.scriptId || undefined },
      orderBy: { createdAt: "desc" },
      take: 100,
    })
    return { runs }
  })

  app.post(`${API_PREFIX}/admin/devices/:id/scripts/run`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const device = await prisma.device.findUnique({ where: { id }, select: { id: true } })
    if (!device) return reply.code(404).send(errorBody("not_found"))
    const body = (req.body ?? {}) as Record<string, unknown>
    const actor = await actorOf(req)
    const provided =
      body.parameters && typeof body.parameters === "object" && !Array.isArray(body.parameters)
        ? (body.parameters as Record<string, unknown>)
        : {}
    if (typeof body.templateId === "string") {
      const template = scriptTemplateById(body.templateId)
      if (!template) return reply.code(404).send(errorBody("template_not_found"))
      const resolved = resolveTemplateParameters(template, provided)
      if (!resolved.ok) return reply.code(400).send(errorBody(resolved.error))
      return queueScriptRun(app, {
        deviceId: id,
        actor,
        trigger: "on_demand",
        templateId: template.id,
        language: template.language,
        content: template.content,
        timeoutSeconds: template.timeoutSeconds,
        parameters: template.parameters.map((p) => ({ name: p.name, default: p.default, pattern: p.pattern })),
        provided: resolved.values,
      })
    }
    if (typeof body.scriptId === "string") {
      const script = await prisma.script.findUnique({ where: { id: body.scriptId } })
      if (!script) return reply.code(404).send(errorBody("script_not_found"))
      try {
        return await queueScriptRun(app, {
          deviceId: id,
          actor,
          trigger: "on_demand",
          scriptId: script.id,
          language: script.language as ScriptLanguage,
          content: script.content,
          timeoutSeconds: script.timeoutSeconds,
          parameters: JSON.parse(script.parameters),
          provided,
        })
      } catch (error) {
        if (error instanceof ScriptParameterError) return reply.code(400).send(errorBody(error.message))
        throw error
      }
    }
    const adhoc = validateScriptWrite({
      name: "adhoc",
      language: body.language,
      content: body.content,
      timeoutSeconds: body.timeoutSeconds,
      parameters: [],
    })
    if (!adhoc.ok) return reply.code(400).send(errorBody(adhoc.error))
    return queueScriptRun(app, {
      deviceId: id,
      actor,
      trigger: "on_demand",
      language: adhoc.value.language,
      content: adhoc.value.content,
      timeoutSeconds: adhoc.value.timeoutSeconds,
    })
  })

  app.post(`${API_PREFIX}/admin/script-schedules`, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const scriptId = typeof body.scriptId === "string" ? body.scriptId : ""
    const cron = typeof body.cron === "string" ? body.cron.trim() : ""
    const deviceId = typeof body.deviceId === "string" && body.deviceId ? body.deviceId : null
    if (!parseCron(cron)) return reply.code(400).send(errorBody("invalid_cron"))
    const script = await prisma.script.findUnique({ where: { id: scriptId } })
    if (!script) return reply.code(404).send(errorBody("script_not_found"))
    if (deviceId) {
      const device = await prisma.device.findUnique({ where: { id: deviceId }, select: { id: true } })
      if (!device) return reply.code(404).send(errorBody("not_found"))
    }
    const schedule = await prisma.scriptSchedule.create({
      data: { scriptId, cron, deviceId, enabled: body.enabled !== false },
    })
    await appendAudit({ actor: await actorOf(req), action: "script_schedule", detail: { id: schedule.id, cron, deviceId } })
    return { schedule }
  })

  app.get(`${API_PREFIX}/admin/script-schedules`, async () => {
    const schedules = await prisma.scriptSchedule.findMany({ orderBy: { createdAt: "desc" }, take: 200, include: { script: { select: { name: true } } } })
    return { schedules }
  })

  app.delete(`${API_PREFIX}/admin/script-schedules/:id`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const existing = await prisma.scriptSchedule.findUnique({ where: { id } })
    if (!existing) return reply.code(404).send(errorBody("not_found"))
    await prisma.scriptSchedule.delete({ where: { id } })
    return { ok: true }
  })

  app.get(`${API_PREFIX}/admin/devices/:id/metrics`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const device = await prisma.device.findUnique({ where: { id }, select: { id: true } })
    if (!device) return reply.code(404).send(errorBody("not_found"))
    const q = req.query as { name?: string }
    const samples = await prisma.metricSample.findMany({
      where: { deviceId: id, name: q.name || undefined },
      orderBy: { sampledAt: "desc" },
      take: 200,
    })
    return { samples }
  })

  app.get(`${API_PREFIX}/admin/alerts`, async () => {
    const alerts = await prisma.notification.findMany({
      where: { channel: "socket" },
      orderBy: { createdAt: "desc" },
      take: 100,
    })
    return { alerts }
  })

  app.get(`${API_PREFIX}/admin/audit`, async () => {
    return { entries: await listAudit(100) }
  })

  app.get(`${API_PREFIX}/admin/devices/:id/inventory`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const device = await prisma.device.findUnique({ where: { id }, select: { id: true } })
    if (!device) return reply.code(404).send(errorBody("not_found"))
    return deviceInventory(id)
  })

  app.post(`${API_PREFIX}/admin/devices/:id/inventory/refresh`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const device = await prisma.device.findUnique({ where: { id }, select: { id: true } })
    if (!device) return reply.code(404).send(errorBody("not_found"))
    const actor = await actorOf(req)
    const command = await queueDeviceCommand(app, id, "collect_inventory", {}, actor)
    await appendAudit({ actor, action: "inventory_refresh", deviceId: id, detail: { commandId: command.id } })
    return { command }
  })

  app.get(`${API_PREFIX}/admin/software`, async (req) => {
    const q = req.query as { name?: string; version?: string; limit?: string }
    const rows = await softwareFleet(q.name ?? "", q.version ?? "", Number(q.limit) || 200)
    return { software: rows }
  })

  app.get(`${API_PREFIX}/admin/devices/:id/updates`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const updates = await prisma.windowsUpdate.findMany({ where: { deviceId: id }, orderBy: { title: "asc" }, take: 300 })
    return jsonSafe({ updates })
  })

  app.post(`${API_PREFIX}/admin/devices/:id/updates/:updateId`, async (req, reply) => {
    const { id, updateId } = req.params as { id: string; updateId: string }
    const body = (req.body ?? {}) as Record<string, unknown>
    const row = await prisma.windowsUpdate.findFirst({ where: { id: updateId, deviceId: id } })
    if (!row) return reply.code(404).send(errorBody("not_found"))
    const action = typeof body.approval === "string" ? body.approval : ""
    const next = nextUpdateApproval(row.approval, action)
    if (!next) return reply.code(409).send(errorBody("invalid_transition", { from: row.approval, to: action }))
    const rebootPolicy = typeof body.rebootPolicy === "string" && REBOOT_POLICIES.includes(body.rebootPolicy as RebootPolicy)
      ? body.rebootPolicy
      : row.rebootPolicy
    const windowStart = typeof body.windowStart === "string" ? body.windowStart : row.windowStart
    const windowEnd = typeof body.windowEnd === "string" ? body.windowEnd : row.windowEnd
    const updated = await prisma.windowsUpdate.update({
      where: { id: row.id },
      data: { approval: next, rebootPolicy, windowStart, windowEnd },
    })
    await appendAudit({
      actor: await actorOf(req),
      action: "update_approval",
      deviceId: id,
      detail: { id: row.id, kb: row.kb, from: row.approval, to: next },
    })
    return { update: updated }
  })

  app.post(`${API_PREFIX}/admin/devices/:id/updates/actions/install`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const device = await prisma.device.findUnique({ where: { id }, select: { id: true, platform: true } })
    if (!device) return reply.code(404).send(errorBody("not_found"))
    const approved = await prisma.windowsUpdate.findMany({ where: { deviceId: id, approval: "approved" } })
    const now = new Date()
    const due = approved.filter((row) => inMaintenanceWindow(now, row.windowStart, row.windowEnd) && normalizeKb(row.kb))
    if (due.length === 0) return reply.code(409).send(errorBody("nothing_approved"))
    const kbs = [...new Set(due.map((row) => normalizeKb(row.kb)!))]
    const reboot = due.some((row) => row.rebootPolicy === "if_required")
      ? "if_required"
      : due.some((row) => row.rebootPolicy === "scheduled")
        ? "scheduled"
        : "never"
    const actor = await actorOf(req)
    const command = await queueDeviceCommand(app, id, "install_windows_update", { kbs, reboot }, actor)
    await prisma.windowsUpdate.updateMany({
      where: { id: { in: due.map((row) => row.id) } },
      data: { approval: "installing" },
    })
    await appendAudit({ actor, action: "update_install", deviceId: id, detail: { kbs, reboot, commandId: command.id } })
    return { command, kbs }
  })

  app.post(`${API_PREFIX}/admin/devices/:id/assistant/propose`, async (req, reply) => {
    const body = (req.body ?? {}) as { text?: string }
    const text = typeof body.text === "string" ? body.text.trim() : ""
    if (!text) return reply.code(400).send(errorBody("invalid_body"))
    const settings = await getSettings()
    const local = parseAssistantText(text)
    if (!settings.llm.baseUrl) {
      return {
        model: "unset",
        proposal: local,
        confirm: local ? assistantNeedsConfirm(local) : false,
        message: local ? "Parsed locally. No model key is configured." : "No model key is configured, and the text is not a known action.",
      }
    }
    const prompt = assistantPrompt(text)
    try {
      const res = await fetch(openaiChatCompletionsUrl(settings.llm.baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(settings.llm.apiKey ? { authorization: `Bearer ${settings.llm.apiKey}` } : {}),
        },
        signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({
          model: settings.llm.model || "gpt-4o-mini",
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
          ],
          temperature: 0,
        }),
      })
      if (!res.ok) {
        return { model: "error", proposal: local, confirm: local ? assistantNeedsConfirm(local) : false, message: `model_http_${res.status}` }
      }
      const payload = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
      const content = payload.choices?.[0]?.message?.content ?? ""
      const proposal = parseAssistantText(content) ?? local
      return { model: "configured", proposal, confirm: proposal ? assistantNeedsConfirm(proposal) : false, message: content.slice(0, 500) }
    } catch {
      return { model: "error", proposal: local, confirm: local ? assistantNeedsConfirm(local) : false, message: "model_unreachable" }
    }
  })

  app.post(`${API_PREFIX}/admin/devices/:id/assistant/run`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const device = await prisma.device.findUnique({ where: { id }, select: { id: true } })
    if (!device) return reply.code(404).send(errorBody("not_found"))
    const body = (req.body ?? {}) as { proposal?: AssistantAction; confirmed?: boolean }
    const proposal = body.proposal
    if (!proposal || typeof proposal !== "object" || !proposal.action) return reply.code(400).send(errorBody("invalid_body"))
    const parsed = parseAssistantText(JSON.stringify(proposal))
    if (!parsed) return reply.code(400).send(errorBody("invalid_action"))
    if (assistantNeedsConfirm(parsed) && body.confirmed !== true) return reply.code(409).send(errorBody("confirm_required"))
    const actor = await actorOf(req)
    const command = await runAssistantAction(app, id, parsed, actor)
    await appendAudit({ actor, action: "assistant_run", deviceId: id, detail: parsed })
    return { command }
  })

  app.get(`${API_PREFIX}/admin/devices/:id/session`, async (req) => {
    const { id } = req.params as { id: string }
    const row = await prisma.remoteSession.findUnique({ where: { id: `webrtc:${id}` } })
    return { session: sessionView(row?.meta ?? null, row?.updatedAt ?? null) }
  })

  app.put(`${API_PREFIX}/admin/devices/:id/session`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const device = await prisma.device.findUnique({ where: { id }, select: { id: true } })
    if (!device) return reply.code(404).send(errorBody("not_found"))
    const body = (req.body ?? {}) as Record<string, unknown>
    const current = await prisma.remoteSession.findUnique({ where: { id: `webrtc:${id}` } })
    const meta = readMeta(current?.meta ?? null)
    if (typeof body.watermark === "string") meta.watermark = body.watermark.slice(0, 120)
    if (typeof body.consent === "boolean") meta.consent = body.consent
    if (typeof body.privacyScreen === "boolean") meta.privacyScreen = body.privacyScreen
    if (typeof body.owner === "string") meta.owner = body.owner.slice(0, 80)
    if (typeof body.timeoutMin === "number" && body.timeoutMin >= 5 && body.timeoutMin <= 240) meta.timeoutMin = body.timeoutMin
    let invite: string | undefined
    if (body.rotateInvite === true) {
      invite = randomBytes(18).toString("base64url")
      meta.inviteTokenHash = createHash("sha256").update(invite).digest("hex")
    }
    const expiresAt = new Date(Date.now() + (Number(meta.timeoutMin) || 60) * 60_000)
    await prisma.remoteSession.upsert({
      where: { id: `webrtc:${id}` },
      create: { id: `webrtc:${id}`, deviceId: id, kind: "webrtc", meta: JSON.stringify(meta), expiresAt },
      update: { meta: JSON.stringify(meta), expiresAt },
    })
    await appendAudit({
      actor: await actorOf(req),
      action: "session_flags",
      deviceId: id,
      detail: { watermark: meta.watermark ?? "", consent: meta.consent === true, privacyScreen: meta.privacyScreen === true, owner: meta.owner ?? "" },
    })
    return { session: sessionView(JSON.stringify(meta), new Date()), invite }
  })

  app.post(`${API_PREFIX}/admin/devices/:id/session/transfer`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { token?: string; owner?: string }
    const row = await prisma.remoteSession.findUnique({ where: { id: `webrtc:${id}` } })
    if (!row) return reply.code(404).send(errorBody("not_found"))
    const meta = readMeta(row.meta)
    const token = typeof body.token === "string" ? body.token : ""
    const hash = createHash("sha256").update(token).digest("hex")
    if (!token || hash !== meta.inviteTokenHash) return reply.code(403).send(errorBody("invalid_invite"))
    meta.owner = typeof body.owner === "string" ? body.owner.slice(0, 80) : ""
    await prisma.remoteSession.update({ where: { id: row.id }, data: { meta: JSON.stringify(meta) } })
    await appendAudit({ actor: await actorOf(req), action: "session_transfer", deviceId: id, detail: { owner: meta.owner } })
    return { session: sessionView(JSON.stringify(meta), new Date()) }
  })

  app.get(`${API_PREFIX}/admin/reports/software.csv`, async (req, reply) => {
    const q = req.query as { name?: string; version?: string }
    const rows = await softwareFleet(q.name ?? "", q.version ?? "", 500)
    const lines = ["hostname,name,version,publisher,collectedAt", ...rows.map((row) => [row.hostname, row.name, row.version, row.publisher, row.collectedAt].map(csvCell).join(","))]
    return reply.type("text/csv").send(lines.join("\n"))
  })

  app.get(`${API_PREFIX}/admin/reports/software.html`, async (req, reply) => {
    const q = req.query as { name?: string; version?: string }
    const rows = await softwareFleet(q.name ?? "", q.version ?? "", 500)
    return reply.type("text/html").send(tableHtml("Software inventory", ["Host", "Name", "Version", "Publisher"], rows.map((row) => [row.hostname, row.name, row.version, row.publisher])))
  })

  app.get(`${API_PREFIX}/admin/reports/updates.csv`, async (_req, reply) => {
    const rows = await prisma.windowsUpdate.findMany({ include: { device: { select: { hostname: true } } }, take: 500, orderBy: { updatedAt: "desc" } })
    const lines = ["hostname,kb,title,approval,rebootPolicy", ...rows.map((row) => [row.device.hostname, row.kb, row.title, row.approval, row.rebootPolicy].map(csvCell).join(","))]
    return reply.type("text/csv").send(lines.join("\n"))
  })

  app.get(`${API_PREFIX}/admin/reports/updates.html`, async (_req, reply) => {
    const rows = await prisma.windowsUpdate.findMany({ include: { device: { select: { hostname: true } } }, take: 500, orderBy: { updatedAt: "desc" } })
    return reply.type("text/html").send(tableHtml("Update compliance", ["Host", "KB", "Title", "Approval"], rows.map((row) => [row.device.hostname, row.kb, row.title, row.approval])))
  })

  app.get(`${API_PREFIX}/admin/reports/alerts.csv`, async (_req, reply) => {
    const rows = await prisma.notification.findMany({ where: { channel: "socket" }, orderBy: { createdAt: "desc" }, take: 500 })
    const lines = ["createdAt,type,title,deviceId", ...rows.map((row) => [row.createdAt.toISOString(), row.type, row.title, row.deviceId ?? ""].map(csvCell).join(","))]
    return reply.type("text/csv").send(lines.join("\n"))
  })

  app.get(`${API_PREFIX}/admin/reports/alerts.html`, async (_req, reply) => {
    const rows = await prisma.notification.findMany({ where: { channel: "socket" }, orderBy: { createdAt: "desc" }, take: 500 })
    return reply.type("text/html").send(tableHtml("Alert history", ["When", "Type", "Title"], rows.map((row) => [row.createdAt.toISOString(), row.type, row.title])))
  })
}

async function runAssistantAction(app: FastifyInstance, deviceId: string, action: AssistantAction, actor: string) {
  switch (action.action) {
    case "collect_inventory":
      return queueDeviceCommand(app, deviceId, "collect_inventory", {}, actor)
    case "get_processes":
      return queueDeviceCommand(app, deviceId, "get_processes", {}, actor)
    case "get_services":
      return queueDeviceCommand(app, deviceId, "get_services", {}, actor)
    case "restart_service":
      return queueDeviceCommand(app, deviceId, "restart_service", { name: action.name }, actor)
    case "start_service":
      return queueDeviceCommand(app, deviceId, "start_service", { name: action.name }, actor)
    case "stop_service":
      return queueDeviceCommand(app, deviceId, "stop_service", { name: action.name }, actor)
    case "kill_process":
      return queueDeviceCommand(app, deviceId, "kill_process", { name: action.name }, actor)
    case "run_script": {
      const script = await prisma.script.findFirst({ where: { name: action.scriptName } })
      if (!script) throw new Error("script_not_found")
      const queued = await queueScriptRun(app, {
        deviceId,
        actor,
        trigger: "on_demand",
        scriptId: script.id,
        language: script.language as ScriptLanguage,
        content: script.content,
        timeoutSeconds: script.timeoutSeconds,
        parameters: JSON.parse(script.parameters),
      })
      return { id: queued.commandId, type: "run_script", status: "pending", deviceId }
    }
    default:
      throw new Error("invalid_action")
  }
}

function readMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function sessionView(raw: string | null, updatedAt: Date | null) {
  const meta = readMeta(raw)
  return {
    watermark: typeof meta.watermark === "string" ? meta.watermark : "",
    consent: meta.consent === true,
    privacyScreen: meta.privacyScreen === true,
    owner: typeof meta.owner === "string" ? meta.owner : "",
    timeoutMin: typeof meta.timeoutMin === "number" ? meta.timeoutMin : 60,
    hasInvite: typeof meta.inviteTokenHash === "string" && meta.inviteTokenHash.length > 0,
    updatedAt,
  }
}

function tableHtml(title: string, headers: string[], rows: string[][]): string {
  const head = headers.map((header) => `<th>${htmlEscape(header)}</th>`).join("")
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${htmlEscape(cell)}</td>`).join("")}</tr>`)
    .join("")
  return `<!doctype html><html><head><meta charset="utf-8"><title>${htmlEscape(title)}</title></head><body><h1>${htmlEscape(title)}</h1><table border="1"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></body></html>`
}

export async function ingestMetricsBody(deviceId: string, body: unknown): Promise<number | null> {
  const samples = normalizeMetrics(body)
  if (!samples) return null
  return storeMetrics(deviceId, samples)
}
