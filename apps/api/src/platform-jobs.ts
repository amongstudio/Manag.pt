import type { FastifyInstance } from "fastify"
import { prisma } from "@workspace/db"

import { appendAudit } from "./audit.js"
import { defenderDisabled, loadAutomations } from "./automations-lib.js"
import { queueDeviceCommand } from "./command-queue.js"
import { enqueueAlert, sendGenericWebhook, sendTeamsWebhook } from "./notify.js"
import { getSettings } from "./settings.js"
import { pruneMetricSamples } from "./metrics.js"
import { loadRules, ruleDelivery, ruleHolds, type MetricPoint } from "./rules.js"
import { finishScan } from "./scan-store.js"
import { runDueSchedules } from "./scripts-run.js"

let lastSlow = 0
let inventoryDay = ""

export async function runPlatformJobs(app: FastifyInstance): Promise<void> {
  const now = Date.now()
  if (now - lastSlow < 55_000) return
  lastSlow = now
  await evaluateRules(app).catch((error) => app.log.error(error))
  await runAutomations(app).catch((error) => app.log.error(error))
  await runDueSchedules(app).catch((error) => app.log.error(error))
  await pruneMetricSamples().catch((error) => app.log.error(error))
  await reconcileFinishedScans(app).catch((error) => app.log.error(error))
  await queueDailyInventory(app).catch((error) => app.log.error(error))
}

async function evaluateRules(app: FastifyInstance): Promise<void> {
  const rules = loadRules()
  if (rules.length === 0) return
  const settings = await getSettings()
  const since = new Date(Date.now() - 6 * 3600_000)
  const devices = await prisma.device.findMany({ select: { id: true, hostname: true }, take: 500 })
  const deviceIds = devices.map((device) => device.id)
  const allRows = deviceIds.length
    ? await prisma.metricSample.findMany({
        where: { deviceId: { in: deviceIds }, sampledAt: { gte: since } },
        orderBy: { sampledAt: "desc" },
        take: 8_000,
      })
    : []
  const byDevice = new Map<string, typeof allRows>()
  for (const row of allRows) {
    const bucket = byDevice.get(row.deviceId) ?? []
    if (bucket.length < 400) bucket.push(row)
    byDevice.set(row.deviceId, bucket)
  }
  for (const device of devices) {
    const rows = byDevice.get(device.id) ?? []
    const points: MetricPoint[] = rows.map((row) => ({
      name: row.name,
      value: row.value,
      sampledAt: row.sampledAt.getTime(),
      labels: parseLabels(row.labels),
    }))
    for (const rule of rules) {
      if (!ruleHolds(points, rule)) {
        await prisma.alertState.updateMany({
          where: { ruleId: rule.id, deviceId: device.id },
          data: { pendingSince: null },
        })
        continue
      }
      const state = await prisma.alertState.findUnique({
        where: { ruleId_deviceId: { ruleId: rule.id, deviceId: device.id } },
      })
      if (state?.lastFiredAt && Date.now() - state.lastFiredAt.getTime() < rule.cooldownSec * 1000) continue
      const title = rule.title
      const body = rule.body || `${device.hostname}: ${rule.clauses.map((clause) => clause.metric).join(" + ")}`
      const type = rule.id === "storage-failure" ? "storage_failure" : "metric_rule"
      const delivery = ruleDelivery({
        ruleTeams: rule.notify.teams,
        ruleWebhook: rule.notify.webhook,
        settingsTeams: settings.teams.webhookUrl,
        settingsTeamsEnabled: settings.teams.enabled,
      })
      await enqueueAlert(app, {
        type,
        deviceId: device.id,
        title,
        body,
        force: true,
        extraChannels: [
          ...(rule.notify.telegram ? (["telegram"] as const) : []),
          ...(rule.notify.smtp ? (["smtp"] as const) : []),
        ],
      })
      if (delivery.webhook) {
        await sendGenericWebhook(delivery.webhook, title, body).catch((error) => {
          app.log.warn({ ruleId: rule.id, err: error instanceof Error ? error.message : "webhook failed" }, "rule webhook")
        })
      }
      if (delivery.teamsURL) {
        await sendTeamsWebhook(delivery.teamsURL, title, body).catch((error) => {
          app.log.warn({ ruleId: rule.id, err: error instanceof Error ? error.message : "teams failed" }, "rule teams")
        })
      }
      await prisma.alertState.upsert({
        where: { ruleId_deviceId: { ruleId: rule.id, deviceId: device.id } },
        create: { ruleId: rule.id, deviceId: device.id, pendingSince: new Date(), lastFiredAt: new Date() },
        update: { pendingSince: new Date(), lastFiredAt: new Date() },
      })
      await appendAudit({
        actor: "rules",
        action: "alert_rule",
        deviceId: device.id,
        detail: { ruleId: rule.id, title },
      })
    }
  }
}

async function reconcileFinishedScans(app: FastifyInstance): Promise<void> {
  const open = await prisma.scan.findMany({
    where: { status: { in: ["pending", "running"] }, commandId: { not: null } },
    take: 40,
    orderBy: { createdAt: "asc" },
  })
  for (const scan of open) {
    if (!scan.commandId) continue
    const command = await prisma.command.findUnique({ where: { id: scan.commandId } })
    if (!command || (command.status !== "success" && command.status !== "failed" && command.status !== "cancelled")) continue
    let result: unknown = null
    try {
      result = command.result ? JSON.parse(command.result) : { error: command.status }
    } catch {
      result = { error: "result_unreadable" }
    }
    await finishScan({
      scanId: scan.id,
      deviceId: scan.deviceId,
      status: command.status === "success" ? "success" : "failed",
      result,
      kind: scan.kind,
    }).catch((error) => app.log.error({ err: error, scanId: scan.id }, "scan reconcile failed"))
  }
}

async function cooled(action: string, deviceId: string, cooldownSec: number): Promise<boolean> {
  const recent = await prisma.auditLog.findFirst({
    where: { action, deviceId, at: { gte: new Date(Date.now() - cooldownSec * 1000) } },
  })
  return !recent
}

async function runAutomations(app: FastifyInstance): Promise<void> {
  const automations = loadAutomations().filter((item) => item.enabled)
  if (automations.length === 0) return
  const devices = await prisma.device.findMany({
    select: { id: true, hostname: true, platform: true, lastSeen: true, status: true },
    take: 500,
  })
  for (const automation of automations) {
    if (automation.when === "rule") continue
    for (const device of devices) {
      try {
        if (automation.when === "service_stopped") {
          const stopped = await serviceStopped(device.id, automation.service)
          if (!stopped) continue
          if (!(await cooled(`automation:${automation.id}`, device.id, automation.cooldownSec))) continue
          await queueDeviceCommand(app, device.id, "restart_service", { name: automation.service }, "automation")
          await appendAudit({
            actor: "automation",
            action: `automation:${automation.id}`,
            deviceId: device.id,
            detail: { service: automation.service, command: "restart_service" },
          })
        } else if (automation.when === "defender_disabled") {
          if (device.platform.toLowerCase() !== "windows") continue
          const command = await prisma.command.findFirst({
            where: { deviceId: device.id, type: "get_defender", status: "success" },
            orderBy: { createdAt: "desc" },
          })
          if (!command?.result || !defenderDisabled(JSON.parse(command.result))) continue
          if (!(await cooled(`automation:${automation.id}`, device.id, automation.cooldownSec))) continue
          await queueDeviceCommand(app, device.id, "set_defender", { realtime: true }, "automation")
          await appendAudit({
            actor: "automation",
            action: `automation:${automation.id}`,
            deviceId: device.id,
            detail: { command: "set_defender" },
          })
        } else if (automation.when === "heartbeat_stale") {
          const age = Date.now() - device.lastSeen.getTime()
          if (age < automation.staleSec * 1000) continue
          if (!(await cooled(`automation:${automation.id}`, device.id, automation.cooldownSec))) continue
          if (device.platform.toLowerCase() === "windows" && age < 2 * 3600_000) {
            const pending = await prisma.command.findFirst({
              where: { deviceId: device.id, type: "restart_service", status: { in: ["pending", "running"] } },
            })
            if (!pending) {
              await queueDeviceCommand(app, device.id, "restart_service", { name: "PCManagerAgent" }, "automation")
            }
            await appendAudit({
              actor: "automation",
              action: `automation:${automation.id}`,
              deviceId: device.id,
              detail: { command: "restart_service", service: "PCManagerAgent", ageSec: Math.floor(age / 1000) },
            })
          } else {
            await appendAudit({
              actor: "automation",
              action: `automation:${automation.id}`,
              deviceId: device.id,
              detail: { skipped: "stale agent cannot receive a host reboot; helper or SCM recovery is the on-box path" },
            })
          }
        } else if (automation.when === "process_present") {
          const snapshot = await prisma.processSnapshot.findFirst({
            where: { deviceId: device.id },
            orderBy: { collectedAt: "desc" },
            include: { processes: true },
          })
          const want = automation.process.toLowerCase().replace(/\.exe$/, "")
          const found = snapshot?.processes.some((row) => row.name.toLowerCase().replace(/\.exe$/, "") === want)
          if (!found) continue
          if (!(await cooled(`automation:${automation.id}`, device.id, automation.cooldownSec))) continue
          await queueDeviceCommand(app, device.id, "kill_process", { name: automation.process }, "automation")
          await appendAudit({
            actor: "automation",
            action: `automation:${automation.id}`,
            deviceId: device.id,
            detail: { process: automation.process },
          })
        }
      } catch (error) {
        app.log.error({ err: error, automation: automation.id, deviceId: device.id }, "automation failed")
        await enqueueAlert(app, {
          type: "automation_failed",
          deviceId: device.id,
          title: `Automation failed: ${automation.id}`,
          body: error instanceof Error ? error.message : "automation failed",
          force: true,
        }).catch(() => undefined)
        await appendAudit({
          actor: "automation",
          action: `automation:${automation.id}`,
          deviceId: device.id,
          detail: { error: error instanceof Error ? error.message : "failed" },
        }).catch(() => undefined)
      }
    }
  }
}

async function serviceStopped(deviceId: string, name: string): Promise<boolean> {
  const metric = await prisma.metricSample.findFirst({
    where: { deviceId, name: "service_up" },
    orderBy: { sampledAt: "desc" },
  })
  if (metric) {
    const labels = parseLabels(metric.labels)
    if (labels.name?.toLowerCase() === name.toLowerCase()) return metric.value === 0
  }
  const row = await prisma.service.findFirst({
    where: { deviceId, name },
    orderBy: { collectedAt: "desc" },
  })
  if (!row) return false
  return /stopped|stop/i.test(row.state)
}

async function queueDailyInventory(app: FastifyInstance): Promise<void> {
  const day = new Date().toISOString().slice(0, 10)
  const hour = new Date().getUTCHours()
  if (hour !== 3 || inventoryDay === day) return
  inventoryDay = day
  const devices = await prisma.device.findMany({ where: { status: "online" }, select: { id: true }, take: 200 })
  for (const device of devices) {
    const pending = await prisma.command.findFirst({
      where: { deviceId: device.id, type: "collect_inventory", status: { in: ["pending", "running"] } },
    })
    if (pending) continue
    await queueDeviceCommand(app, device.id, "collect_inventory", {}, "schedule").catch((error) => {
      app.log.error({ err: error, deviceId: device.id }, "inventory queue failed")
    })
  }
}

function parseLabels(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
  } catch {
    return {}
  }
}
