import fs from "node:fs"
import path from "node:path"

import yaml from "js-yaml"

export type Automation =
  | { id: string; enabled: boolean; when: "service_stopped"; service: string; cooldownSec: number }
  | { id: string; enabled: boolean; when: "rule"; ruleId: string }
  | { id: string; enabled: boolean; when: "defender_disabled"; cooldownSec: number }
  | { id: string; enabled: boolean; when: "heartbeat_stale"; staleSec: number; cooldownSec: number }
  | { id: string; enabled: boolean; when: "process_present"; process: string; cooldownSec: number }

export function parseAutomations(text: string): Automation[] {
  let parsed: unknown
  try {
    parsed = yaml.load(text)
  } catch {
    return []
  }
  const root = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).automations : null
  if (!Array.isArray(root)) return []
  const out: Automation[] = []
  for (const item of root) {
    if (!item || typeof item !== "object") continue
    const raw = item as Record<string, unknown>
    const id = typeof raw.id === "string" ? raw.id.trim() : ""
    if (!id) continue
    const enabled = raw.enabled !== false
    const when = raw.when
    const cooldownSec = Number.isFinite(Number(raw.cooldownSec)) ? Math.max(60, Number(raw.cooldownSec)) : 900
    if (when === "service_stopped" && typeof raw.service === "string" && raw.service.trim()) {
      out.push({ id, enabled, when, service: raw.service.trim(), cooldownSec })
    } else if (when === "rule" && typeof raw.ruleId === "string") {
      out.push({ id, enabled, when, ruleId: raw.ruleId.trim() })
    } else if (when === "defender_disabled") {
      out.push({ id, enabled, when, cooldownSec })
    } else if (when === "heartbeat_stale") {
      const staleSec = Number.isFinite(Number(raw.staleSec)) ? Math.max(60, Number(raw.staleSec)) : 600
      out.push({ id, enabled, when, staleSec, cooldownSec })
    } else if (when === "process_present" && typeof raw.process === "string" && raw.process.trim()) {
      out.push({ id, enabled, when, process: raw.process.trim(), cooldownSec })
    }
  }
  return out
}

export function automationsPath(): string {
  const fromEnv = process.env.AUTOMATIONS_PATH?.trim()
  if (fromEnv) return fromEnv
  const candidates = [
    path.resolve(process.cwd(), "config/automations.yaml"),
    path.resolve(process.cwd(), "../../config/automations.yaml"),
  ]
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[1]!
}

let automationsOverride: string | null = null
let automationsCache: Automation[] | null = null

export function setAutomationsOverride(text: string | null): void {
  automationsOverride = text
  automationsCache = null
}

export function loadAutomations(): Automation[] {
  if (automationsCache) return automationsCache
  let text = automationsOverride
  if (text == null) {
    try {
      text = fs.readFileSync(automationsPath(), "utf8")
    } catch {
      text = ""
    }
  }
  automationsCache = parseAutomations(text)
  return automationsCache
}

export function defenderDisabled(result: unknown): boolean {
  if (!result || typeof result !== "object") return false
  const raw = result as Record<string, unknown>
  if (raw.realtimeProtectionEnabled === false) return true
  const preference = raw.preference
  if (preference && typeof preference === "object") {
    const pref = preference as Record<string, unknown>
    if (pref.disableRealtimeMonitoring === true || pref.DisableRealtimeMonitoring === true) return true
  }
  return false
}
