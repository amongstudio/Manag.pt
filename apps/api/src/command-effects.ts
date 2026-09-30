import { prisma } from "@workspace/db"

import { upsertInventory } from "./inventory-store.js"
import { finishScan } from "./scan-store.js"
import { cleanText } from "./inventory-lib.js"

type CommandRow = {
  id: string
  type: string
  status: string
  payload: string
  result: string | null
}

export async function applyCommandEffects(deviceId: string, command: CommandRow): Promise<void> {
  const payload = parseObject(command.payload)
  const result = parseObject(command.result)
  if (command.type === "run_script" && typeof payload.scriptRunId === "string") {
    const terminal = command.status === "success" || command.status === "failed" || command.status === "cancelled"
    const exitCode =
      typeof result.exitCode === "number"
        ? result.exitCode
        : command.status === "success"
          ? 0
          : command.status === "failed"
            ? 1
            : null
    await prisma.scriptRun.updateMany({
      where: { id: payload.scriptRunId, deviceId },
      data: {
        status: command.status === "running" ? "running" : command.status,
        ...(terminal
          ? {
              stdout: typeof result.stdout === "string" ? result.stdout.slice(0, 65_536) : "",
              stderr: typeof result.stderr === "string" ? result.stderr.slice(0, 65_536) : "",
              exitCode,
              finishedAt: new Date(),
            }
          : {}),
        ...(command.status === "running" ? { startedAt: new Date() } : {}),
      },
    })
  }
  if (command.status !== "success") return
  if (command.type === "collect_inventory") {
    await upsertInventory(deviceId, result)
  }
  if (command.type === "get_windows_update") {
    await upsertWindowsUpdateResult(deviceId, result)
  }
  if (command.type === "network_scan" || command.type === "nuclei_scan" || command.type === "host_posture") {
    const scanId = typeof payload.scanId === "string" ? payload.scanId : ""
    if (scanId && (command.status === "success" || command.status === "failed")) {
      await finishScan({
        scanId,
        deviceId,
        status: command.status,
        result,
        kind: command.type,
      })
    }
  }
}

function parseObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

async function upsertWindowsUpdateResult(deviceId: string, result: Record<string, unknown>): Promise<void> {
  const pending = Array.isArray(result.pending) ? result.pending : []
  const collectedAt = new Date()
  for (const item of pending.slice(0, 200)) {
    if (!item || typeof item !== "object") continue
    const row = item as Record<string, unknown>
    const title = cleanText(row.title, 512)
    const kbs = Array.isArray(row.kb) ? row.kb : row.kb ? [row.kb] : [""]
    for (const kbValue of kbs.slice(0, 8)) {
      const kb = cleanText(kbValue, 32).toUpperCase().replace(/^(\d+)$/, "KB$1")
      if (!kb && !title) continue
      await prisma.windowsUpdate.upsert({
        where: { deviceId_kb_title: { deviceId, kb, title } },
        create: {
          deviceId,
          kb,
          title,
          severity: cleanText(row.severity, 32),
          collectedAt,
        },
        update: { severity: cleanText(row.severity, 32), collectedAt },
      })
    }
  }
}
