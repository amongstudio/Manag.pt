import type { FastifyInstance } from "fastify"
import { Prisma, prisma } from "@workspace/db"
import { API_PREFIX } from "@workspace/shared"

import { appendAudit } from "./audit.js"
import { queueDeviceCommand } from "./command-queue.js"
import { errorBody } from "./lib.js"
import { operatorAuthorized } from "./operator-auth.js"
import { authorizeTarget, authorizeURL, loadScanScope } from "./scan-scope.js"
import { cacheFresh } from "./findings-lib.js"
import { postureFindings } from "./posture-lib.js"
import { storedPosture, upsertFindings } from "./scan-store.js"

async function actorOf(headers: Record<string, unknown>): Promise<string> {
  const authed = await operatorAuthorized(headers)
  return authed.username || "operator"
}

export async function registerScanRoutes(app: FastifyInstance): Promise<void> {
  app.post(`${API_PREFIX}/admin/scans`, async (req, reply) => {
    const body = (req.body ?? {}) as { deviceId?: string; kind?: string; target?: string; scriptId?: string }
    const kind = body.kind
    if (kind !== "network_scan" && kind !== "nuclei_scan" && kind !== "host_posture") {
      return reply.code(400).send(errorBody("invalid_kind"))
    }
    const deviceId = body.deviceId?.trim() || ""
    if (!deviceId) return reply.code(400).send(errorBody("device_required"))
    const device = await prisma.device.findUnique({ where: { id: deviceId }, select: { id: true } })
    if (!device) return reply.code(404).send(errorBody("not_found"))
    const scope = loadScanScope()
    const target = (body.target ?? "").trim()
    if (kind !== "host_posture") {
      const decision = kind === "nuclei_scan" ? authorizeURL(target, scope) : authorizeTarget(target, scope)
      if (!decision.ok) return reply.code(403).send(errorBody(decision.error))
    }
    let enableVulners = scope.enableVulners
    if (kind === "network_scan" && enableVulners) {
      const cached = await prisma.cveCache.findMany({ take: 200 })
      if (cached.length && cached.every((row) => cacheFresh(row.fetchedAt))) enableVulners = false
    }
    const actor = await actorOf(req.headers as Record<string, unknown>)
    const scan = await prisma.scan.create({
      data: { deviceId, kind, target: target || deviceId, status: "pending" },
    })
    await appendAudit({ actor, action: "scan_start", deviceId, detail: { scanId: scan.id, kind, target: target || deviceId } })
    try {
      const command = await queueDeviceCommand(
        app,
        deviceId,
        kind,
        kind === "host_posture"
          ? { scanId: scan.id }
          : {
              target,
              scanId: scan.id,
              maxRate: scope.scanRateLimit,
              timeoutMinutes: scope.scanTimeoutMinutes,
              ...(kind === "network_scan" ? { enableVulners } : {}),
            },
        actor
      )
      const updated = await prisma.scan.update({
        where: { id: scan.id },
        data: { commandId: command.id, status: "running", startedAt: new Date() },
      })
      if (kind === "host_posture") {
        const stored = await storedPosture(deviceId)
        await upsertFindings({
          scanId: scan.id,
          deviceId,
          scriptId: body.scriptId,
          drafts: postureFindings({ hostIp: deviceId, ...stored }),
        })
      }
      return { scan: updated }
    } catch (error) {
      await prisma.scan.update({
        where: { id: scan.id },
        data: { status: "failed", summary: error instanceof Error ? error.message : "queue_failed", finishedAt: new Date() },
      })
      return reply.code(400).send(errorBody(error instanceof Error ? error.message : "queue_failed"))
    }
  })

  app.get(`${API_PREFIX}/admin/scans`, async () => {
    const scans = await prisma.scan.findMany({ orderBy: { createdAt: "desc" }, take: 100 })
    return { scans }
  })

  app.get(`${API_PREFIX}/admin/scans/:id`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const scan = await prisma.scan.findUnique({ where: { id }, include: { findings: { take: 500 } } })
    if (!scan) return reply.code(404).send(errorBody("not_found"))
    return { scan }
  })

  app.get(`${API_PREFIX}/admin/findings`, async (req) => {
    const q = req.query as { severity?: string; cve?: string; status?: string; host?: string; port?: string; service?: string }
    if (q.port || q.service) {
      const port = Number(q.port)
      const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT id, hostIp, hostHostname, hostOs, source, category, severity, title, cveId, status, evidence, remediation, remediationType, scriptId, firstSeen, lastSeen
        FROM Finding
        WHERE status != 'fixed'
        AND (${q.severity ?? ""} = '' OR severity = ${q.severity ?? ""})
        AND (${q.cve ?? ""} = '' OR cveId = ${q.cve ?? ""})
        AND (${q.status ?? ""} = '' OR status = ${q.status ?? ""})
        AND (${q.host ?? ""} = '' OR hostIp = ${q.host ?? ""})
        AND (${Number.isFinite(port) && q.port ? port : -1} < 0 OR CAST(json_extract(evidence, '$.port') AS INTEGER) = ${Number.isFinite(port) ? port : -1})
        AND (${q.service ?? ""} = '' OR lower(json_extract(evidence, '$.service')) = lower(${q.service ?? ""}))
        ORDER BY lastSeen DESC
        LIMIT 300
      `)
      return { findings: rows }
    }
    const findings = await prisma.finding.findMany({
      where: {
        severity: q.severity || undefined,
        cveId: q.cve || undefined,
        status: q.status || undefined,
        hostIp: q.host || undefined,
      },
      orderBy: { lastSeen: "desc" },
      take: 300,
    })
    return { findings }
  })

  app.post(`${API_PREFIX}/admin/findings/:id/acknowledge`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const row = await prisma.finding.findUnique({ where: { id } })
    if (!row) return reply.code(404).send(errorBody("not_found"))
    const finding = await prisma.finding.update({ where: { id }, data: { status: "acknowledged" } })
    await appendAudit({ actor: await actorOf(req.headers as Record<string, unknown>), action: "finding_acknowledge", deviceId: row.deviceId, detail: { id } })
    return { finding }
  })

  app.post(`${API_PREFIX}/admin/findings/:id/accept`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const reason = typeof (req.body as { reason?: string })?.reason === "string" ? (req.body as { reason: string }).reason.slice(0, 500) : ""
    if (!reason.trim()) return reply.code(400).send(errorBody("reason_required"))
    const row = await prisma.finding.findUnique({ where: { id } })
    if (!row) return reply.code(404).send(errorBody("not_found"))
    const finding = await prisma.finding.update({ where: { id }, data: { status: "accepted", acceptReason: reason } })
    await appendAudit({
      actor: await actorOf(req.headers as Record<string, unknown>),
      action: "finding_accept",
      deviceId: row.deviceId,
      detail: { id, reason },
    })
    return { finding }
  })

  app.post(`${API_PREFIX}/admin/findings/:id/remediate`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const row = await prisma.finding.findUnique({ where: { id } })
    if (!row) return reply.code(404).send(errorBody("not_found"))
    if (!row.scriptId || !row.deviceId) return reply.code(409).send(errorBody("no_linked_script"))
    const script = await prisma.script.findUnique({ where: { id: row.scriptId } })
    if (!script) return reply.code(404).send(errorBody("script_not_found"))
    const { queueScriptRun } = await import("./scripts-run.js")
    const queued = await queueScriptRun(app, {
      deviceId: row.deviceId,
      actor: await actorOf(req.headers as Record<string, unknown>),
      trigger: "on_demand",
      scriptId: script.id,
      language: script.language as "powershell" | "python" | "batch" | "shell",
      content: script.content,
      timeoutSeconds: script.timeoutSeconds,
      parameters: JSON.parse(script.parameters),
    })
    const finding = await prisma.finding.update({ where: { id }, data: { status: "remediating" } })
    await appendAudit({
      actor: await actorOf(req.headers as Record<string, unknown>),
      action: "finding_remediate",
      deviceId: row.deviceId,
      detail: { id, scriptId: script.id, commandId: queued.commandId },
    })
    return { finding, commandId: queued.commandId }
  })

  app.get(`${API_PREFIX}/admin/reports/findings.csv`, async (_req, reply) => {
    const rows = await prisma.finding.findMany({ where: { status: "open" }, orderBy: { severity: "asc" }, take: 1000 })
    const lines = ["host,source,severity,title,cve,status,remediation", ...rows.map((row) => [row.hostIp, row.source, row.severity, row.title, row.cveId, row.status, row.remediation].map(csv).join(","))]
    return reply.type("text/csv").send(lines.join("\n"))
  })
}

function csv(value: unknown): string {
  const text = value == null ? "" : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}
