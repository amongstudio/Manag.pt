import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import { promisify } from "node:util"

import type { FastifyInstance } from "fastify"
import cron from "node-cron"
import { DESTRUCTIVE_COMMANDS, WS_EVENTS, summarizeClipboardResult } from "@workspace/shared"
import { prisma } from "@workspace/db"

import { moduleIdFromPayload, pluginIdFromPayload, runningCommandTimeoutMs } from "./command-policy.js"
import { env, dataPath } from "./env.js"
import { emitFleet } from "./io-emit.js"
import { enqueueAlert, flushNotifications } from "./notify.js"
import { runPlatformJobs } from "./platform-jobs.js"
import { expireRemoteSessions } from "./remote-session.js"
import { getSettings } from "./settings.js"
import { expireWebrtcRelaySessions, hangupExpiredWebrtc } from "./ws.js"

const execFileAsync = promisify(execFile)

async function timeoutStuckCommands(app: FastifyInstance): Promise<void> {
  const settings = await getSettings()
  const minutes = Math.max(1, settings.agent.commandTimeoutMin || 15)
  const cutoff = new Date(Date.now() - minutes * 60_000)
  const candidates = await prisma.command.findMany({
    where: { status: "running", updatedAt: { lt: cutoff } },
  })
  if (candidates.length === 0) return
  const pluginIds = [
    ...new Set(
      candidates
        .filter((command) => command.type === "run_plugin")
        .map((command) => pluginIdFromPayload(command.payload))
        .filter((id): id is string => Boolean(id))
    ),
  ]
  const plugins = pluginIds.length
    ? await prisma.plugin.findMany({ where: { id: { in: pluginIds } }, select: { id: true, timeoutSec: true } })
    : []
  const timeoutByPlugin = new Map(plugins.map((plugin) => [plugin.id, plugin.timeoutSec]))
  const moduleIds = [
    ...new Set(
      candidates
        .filter((command) => command.type === "run_module")
        .map((command) => moduleIdFromPayload(command.payload))
        .filter((id): id is string => Boolean(id))
    ),
  ]
  const modules = moduleIds.length
    ? await prisma.moduleArtifact.findMany({
        where: { id: { in: moduleIds } },
        select: { id: true, timeoutSec: true },
      })
    : []
  const timeoutByModule = new Map(modules.map((module) => [module.id, module.timeoutSec]))
  const now = Date.now()
  const stuck = candidates.filter((command) => {
    let artifactTimeoutSec: number | undefined
    if (command.type === "run_plugin") {
      const pluginId = pluginIdFromPayload(command.payload)
      artifactTimeoutSec = pluginId ? timeoutByPlugin.get(pluginId) : undefined
    } else if (command.type === "run_module") {
      const moduleId = moduleIdFromPayload(command.payload)
      artifactTimeoutSec = moduleId ? timeoutByModule.get(moduleId) : undefined
    } else {
      return true
    }
    const deadline = command.updatedAt.getTime() + runningCommandTimeoutMs(minutes, artifactTimeoutSec)
    return now >= deadline
  })
  if (stuck.length === 0) return
  await prisma.command.updateMany({
    where: { id: { in: stuck.map((command) => command.id) }, status: "running" },
    data: { status: "failed", result: JSON.stringify({ error: "timeout" }) },
  })
  for (const command of stuck) {
    app.log.warn({ deviceId: command.deviceId, commandId: command.id, type: command.type }, "command timeout")
    emitFleet(app, WS_EVENTS.COMMAND_RESULT, {
      id: command.id,
      deviceId: command.deviceId,
      type: command.type,
      status: "failed",
      result: { error: "timeout" },
    })
  }
}

async function expirePendingDestructive(app: FastifyInstance): Promise<void> {
  const settings = await getSettings()
  const minutes = Math.max(1, settings.agent.commandTimeoutMin || 15)
  const cutoff = new Date(Date.now() - minutes * 60_000)
  const expired = await prisma.command.findMany({
    where: {
      status: "pending",
      createdAt: { lt: cutoff },
      type: { in: [...DESTRUCTIVE_COMMANDS] },
    },
  })
  if (expired.length === 0) return
  await prisma.command.updateMany({
    where: { id: { in: expired.map((command) => command.id) }, status: "pending" },
    data: { status: "cancelled", result: JSON.stringify({ error: "expired" }) },
  })
  for (const command of expired) {
    app.log.warn({ deviceId: command.deviceId, commandId: command.id, type: command.type }, "pending command expired")
    emitFleet(app, WS_EVENTS.COMMAND_RESULT, {
      id: command.id,
      deviceId: command.deviceId,
      type: command.type,
      status: "cancelled",
      result: { error: "expired" },
    })
  }
}

const CLIPBOARD_RESULT_TTL_MS = 15 * 60_000

/** Clipboard contents are kept only long enough for the operator to view them. */
async function purgeClipboardResults(): Promise<void> {
  const rows = await prisma.command.findMany({
    where: {
      type: "get_clipboard",
      status: { in: ["success", "failed", "cancelled"] },
      updatedAt: { lt: new Date(Date.now() - CLIPBOARD_RESULT_TTL_MS) },
      NOT: { result: { contains: '"redacted":true' } },
    },
    select: { id: true, result: true },
    take: 200,
  })
  for (const row of rows) {
    let parsed: unknown = null
    try {
      parsed = row.result ? JSON.parse(row.result) : null
    } catch {
      parsed = null
    }
    const summary = summarizeClipboardResult(parsed)
    const safe = summary && typeof summary === "object" ? summary : { redacted: true }
    await prisma.command.update({ where: { id: row.id }, data: { result: JSON.stringify(safe) } })
  }
}

async function markOffline(app: FastifyInstance): Promise<void> {
  const settings = await getSettings()
  const cutoff = new Date(Date.now() - settings.thresholds.offlineThresholdSec * 1000)
  const stale = await prisma.device.findMany({
    where: { status: "online", lastSeen: { lt: cutoff } },
  })
  if (stale.length === 0) return
  await prisma.device.updateMany({
    where: { id: { in: stale.map((device) => device.id) }, status: "online" },
    data: { status: "offline" },
  })
  for (const device of stale) {
    emitFleet(app, WS_EVENTS.DEVICE_STATUS, { id: device.id, status: "offline", lastSeen: device.lastSeen })
    await enqueueAlert(app, {
      type: "device_offline",
      deviceId: device.id,
      title: `${device.hostname} went offline`,
      body: `Last seen ${device.lastSeen.toISOString()}`,
    })
  }
}

async function markHeartbeatMissed(app: FastifyInstance): Promise<void> {
  const settings = await getSettings()
  const now = Date.now()
  const heartbeatCutoff = new Date(now - settings.thresholds.heartbeatTimeoutSec * 1000)
  const offlineCutoff = new Date(now - settings.thresholds.offlineThresholdSec * 1000)
  const missed = await prisma.device.findMany({
    where: {
      status: "online",
      lastSeen: { lt: heartbeatCutoff, gte: offlineCutoff },
    },
  })
  for (const device of missed) {
    await enqueueAlert(app, {
      type: "heartbeat_missed",
      deviceId: device.id,
      title: `Missed heartbeat: ${device.hostname}`,
      body: `No heartbeat within ${settings.thresholds.heartbeatTimeoutSec}s`,
    })
  }
}

/** CPU/RAM/disk threshold alerts are unused: heartbeats are presence-only (no Stat writes). */

const ABANDONED_TRANSFER_MS = 24 * 3600_000

async function pruneAbandonedTransfers(): Promise<void> {
  const cutoff = new Date(Date.now() - ABANDONED_TRANSFER_MS)
  const stale = await prisma.fileInfo.findMany({
    where: { status: "transferring", createdAt: { lt: cutoff } },
  })
  if (stale.length === 0) return
  for (const file of stale) {
    await fs.unlink(file.localPath).catch(() => undefined)
  }
  await prisma.fileInfo.updateMany({
    where: { id: { in: stale.map((file) => file.id) }, status: "transferring" },
    data: { status: "failed" },
  })
}

async function downsampleStats(): Promise<void> {
  const settings = await getSettings()
  const cutoff24h = new Date(Date.now() - 24 * 3600_000)
  const retainAfter = new Date(Date.now() - settings.retention.statsDays * 86400_000)
  await prisma.$executeRaw`
    DELETE FROM "Stat"
    WHERE timestamp < ${cutoff24h}
      AND timestamp >= ${retainAfter}
      AND id NOT IN (
        SELECT keep_id FROM (
          SELECT MIN(id) AS keep_id
          FROM "Stat"
          WHERE timestamp < ${cutoff24h} AND timestamp >= ${retainAfter}
          GROUP BY deviceId, strftime('%Y-%m-%d %H:%M', timestamp)
        )
      )
  `
}

async function retention(): Promise<void> {
  const settings = await getSettings()
  const ago = (days: number) => new Date(Date.now() - days * 86400_000)
  await prisma.stat.deleteMany({ where: { timestamp: { lt: ago(settings.retention.statsDays) } } })
  await prisma.log.deleteMany({ where: { timestamp: { lt: ago(settings.retention.logsDays) } } })
  await prisma.command.deleteMany({
    where: { createdAt: { lt: ago(settings.retention.commandsDays) }, status: { not: "pending" } },
  })
  await prisma.command.updateMany({
    where: { createdAt: { lt: ago(settings.retention.commandsDays) }, status: "pending" },
    data: { status: "cancelled", result: JSON.stringify({ error: "expired" }) },
  })
  const oldShots = await prisma.screenshot.findMany({
    where: { createdAt: { lt: ago(settings.retention.screenshotsDays) } },
  })
  for (const shot of oldShots) {
    await fs.unlink(shot.path).catch(() => undefined)
  }
  if (oldShots.length) {
    await prisma.screenshot.deleteMany({ where: { id: { in: oldShots.map((s) => s.id) } } })
  }
  await prisma.notification.deleteMany({
    where: { createdAt: { lt: ago(settings.retention.notificationsDays) }, status: { not: "pending" } },
  })
  const oldFiles = await prisma.fileInfo.findMany({
    where: { createdAt: { lt: ago(settings.retention.filesDays) }, status: { not: "transferring" } },
  })
  for (const file of oldFiles) {
    await fs.unlink(file.localPath).catch(() => undefined)
  }
  if (oldFiles.length) {
    await prisma.fileInfo.deleteMany({ where: { id: { in: oldFiles.map((f) => f.id) } } })
  }
  await pruneAbandonedTransfers()
  await downsampleStats()
  await pruneDir(dataPath("staged"), settings.retention.filesDays)
  await pruneDir(dataPath("updates"), settings.retention.filesDays)
  await pruneDir(dataPath("packs"), settings.retention.filesDays)
}

async function pruneDir(dir: string, days: number): Promise<void> {
  const cutoff = Date.now() - days * 86400_000
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const full = `${dir}/${entry.name}`
    const stat = await fs.stat(full).catch(() => null)
    if (!stat || stat.mtimeMs >= cutoff) continue
    if (entry.isDirectory()) await fs.rm(full, { recursive: true, force: true }).catch(() => undefined)
    else await fs.unlink(full).catch(() => undefined)
  }
}

async function backupViaSqliteCli(src: string, dest: string): Promise<boolean> {
  try {
    const destArg = dest.replaceAll("\\", "/").replaceAll("'", "''")
    await execFileAsync("sqlite3", [src, `.backup '${destArg}'`], {
      timeout: 120_000,
      windowsHide: true,
    })
    const stat = await fs.stat(dest)
    return stat.isFile() && stat.size > 0
  } catch {
    await fs.unlink(dest).catch(() => undefined)
    return false
  }
}

async function pruneOldBackups(): Promise<void> {
  const files = await fs.readdir(dataPath("backups"))
  const cutoff = Date.now() - 14 * 86400_000
  for (const file of files) {
    const full = dataPath("backups", file)
    const stat = await fs.stat(full)
    if (stat.mtimeMs < cutoff) await fs.unlink(full).catch(() => undefined)
  }
}

export async function sqliteBackup(): Promise<string> {
  const dest = dataPath("backups", `pcmanager-${new Date().toISOString().replaceAll(":", "-")}.db`)
  const ok = await backupViaSqliteCli(env.dbFile, dest)
  if (!ok) {
    await prisma.$executeRawUnsafe("PRAGMA wal_checkpoint(TRUNCATE)")
    await fs.copyFile(env.dbFile, dest)
  }
  await pruneOldBackups()
  return dest
}

export function startJobs(app: FastifyInstance): void {
  let fastTickBusy = false
  cron.schedule("*/30 * * * * *", () => {
    if (fastTickBusy) {
      app.log.warn("skipping overlapping job tick")
      return
    }
    fastTickBusy = true
    void runFastTicks(app).finally(() => {
      fastTickBusy = false
    })
  })
  cron.schedule("*/60 * * * * *", () => {
    void flushNotifications().catch((error) => app.log.error(error))
  })
  cron.schedule("5 3 * * *", () => {
    void retention()
      .then(() => sqliteBackup())
      .catch((error) => app.log.error(error))
  })
}

async function runFastTicks(app: FastifyInstance): Promise<void> {
  await markOffline(app).catch((error) => app.log.error(error))
  await markHeartbeatMissed(app).catch((error) => app.log.error(error))
  await timeoutStuckCommands(app).catch((error) => app.log.error(error))
  await expirePendingDestructive(app).catch((error) => app.log.error(error))
  await pruneAbandonedTransfers().catch((error) => app.log.error(error))
  expireWebrtcRelaySessions(app)
  await expireRemoteSessions(hangupExpiredWebrtc).catch((error) => app.log.error(error))
  await purgeClipboardResults().catch((error) => app.log.error(error))
  await runPlatformJobs(app).catch((error) => app.log.error(error))
}
