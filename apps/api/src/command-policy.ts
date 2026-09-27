import {
  COMMAND_TIMEOUT_GRACE_MS,
  DESTRUCTIVE_COMMANDS,
  type CommandType,
} from "@workspace/shared"

export function runningCommandTimeoutMs(
  commandTimeoutMin: number,
  pluginTimeoutSec?: number | null
): number {
  const baseMs = Math.max(1, commandTimeoutMin) * 60_000
  const pluginMs = pluginTimeoutSec != null && pluginTimeoutSec > 0 ? pluginTimeoutSec * 1000 : 0
  return Math.max(baseMs, pluginMs) + COMMAND_TIMEOUT_GRACE_MS
}

export function isDestructiveCommand(type: string): boolean {
  return DESTRUCTIVE_COMMANDS.has(type as CommandType)
}

export function pendingDestructiveExpired(createdAt: Date, now: Date, ttlMin: number): boolean {
  return now.getTime() - createdAt.getTime() >= Math.max(1, ttlMin) * 60_000
}

export function pluginIdFromPayload(payload: string): string | null {
  try {
    const parsed = JSON.parse(payload) as { pluginId?: unknown }
    return typeof parsed.pluginId === "string" && parsed.pluginId ? parsed.pluginId : null
  } catch {
    return null
  }
}

export type PluginGrantSource = {
  allDevices: boolean
  grants: Array<{ deviceId: string }>
}

export function deviceHasPluginGrant(plugin: PluginGrantSource, deviceId: string): boolean {
  if (plugin.allDevices) return true
  return plugin.grants.some((g) => g.deviceId === deviceId)
}

export function planUploadInit(existingSize: number, incomingSize: number): "resume" | "reset" {
  return existingSize === incomingSize ? "resume" : "reset"
}

