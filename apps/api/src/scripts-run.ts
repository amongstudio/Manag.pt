import type { FastifyInstance } from "fastify"
import { prisma } from "@workspace/db"

import { appendAudit } from "./audit.js"
import { queueDeviceCommand } from "./command-queue.js"
import { cronMatches, minuteStart, parseCron } from "./cron-match.js"
import { renderScript, resolveParameters, type ScriptLanguage, type ScriptParameter } from "./scripts-lib.js"

export async function queueScriptRun(
  app: FastifyInstance,
  input: {
    deviceId: string
    actor: string
    trigger: "on_demand" | "schedule"
    scriptId?: string | null
    language: ScriptLanguage
    content: string
    timeoutSeconds: number
    parameters?: ScriptParameter[]
    provided?: Record<string, string>
  }
): Promise<{ runId: string; commandId: string }> {
  const rendered = renderScript(input.content, resolveParameters(input.parameters ?? [], input.provided))
  const run = await prisma.scriptRun.create({
    data: {
      deviceId: input.deviceId,
      scriptId: input.scriptId ?? null,
      language: input.language,
      content: rendered,
      status: "queued",
      trigger: input.trigger,
    },
  })
  const command = await queueDeviceCommand(
    app,
    input.deviceId,
    "run_script",
    {
      script: rendered,
      language: input.language,
      timeoutSeconds: input.timeoutSeconds,
      scriptRunId: run.id,
    },
    input.actor
  )
  await prisma.scriptRun.update({ where: { id: run.id }, data: { commandId: command.id } })
  await appendAudit({
    actor: input.actor,
    action: "script_run",
    deviceId: input.deviceId,
    detail: { runId: run.id, commandId: command.id, scriptId: input.scriptId ?? null, trigger: input.trigger, language: input.language },
  })
  return { runId: run.id, commandId: command.id }
}

export async function runDueSchedules(app: FastifyInstance): Promise<number> {
  const now = new Date()
  const schedules = await prisma.scriptSchedule.findMany({
    where: { enabled: true },
    include: { script: true },
  })
  let fired = 0
  for (const schedule of schedules) {
    if (!parseCron(schedule.cron) || !cronMatches(schedule.cron, now)) continue
    const claimed = await prisma.scriptSchedule.updateMany({
      where: {
        id: schedule.id,
        enabled: true,
        OR: [{ lastFiredAt: null }, { lastFiredAt: { lt: minuteStart(now) } }],
      },
      data: { lastFiredAt: now },
    })
    if (claimed.count !== 1) continue
    const parameters = parseStoredParameters(schedule.script.parameters)
    const devices = schedule.deviceId
      ? [schedule.deviceId]
      : (await prisma.device.findMany({ select: { id: true }, take: 200 })).map((device) => device.id)
    for (const deviceId of devices) {
      await queueScriptRun(app, {
        deviceId,
        actor: "schedule",
        trigger: "schedule",
        scriptId: schedule.scriptId,
        language: schedule.script.language as ScriptLanguage,
        content: schedule.script.content,
        timeoutSeconds: schedule.script.timeoutSeconds,
        parameters,
      }).catch((error) => {
        app.log.error({ err: error, scheduleId: schedule.id, deviceId }, "scheduled script failed to queue")
      })
    }
    fired += 1
  }
  return fired
}

function parseStoredParameters(raw: string): ScriptParameter[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return []
      const row = item as { name?: unknown; default?: unknown }
      if (typeof row.name !== "string") return []
      return [{ name: row.name, default: typeof row.default === "string" ? row.default : undefined }]
    })
  } catch {
    return []
  }
}
