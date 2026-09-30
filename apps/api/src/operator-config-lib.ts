import yaml from "js-yaml"

import { parseAutomations } from "./automations-lib.js"
import { parseSoftwareRules } from "./posture-lib.js"
import { parseRules } from "./rules.js"
import { validateScanScopeText } from "./scan-scope.js"

export type HelperOptions = {
  agentServiceName: string
  statusPort: number
  backoffSec: number
  probeIntervalSec: number
  failThreshold: number
  maxBackoffSec: number
  startupGraceSec: number
}

export const DEFAULT_HELPER: HelperOptions = {
  agentServiceName: "PCManagerAgent",
  statusPort: 17890,
  backoffSec: 30,
  probeIntervalSec: 45,
  failThreshold: 3,
  maxBackoffSec: 300,
  startupGraceSec: 60,
}

const RULE_KEYS = new Set(["id", "metric", "comparator", "threshold", "forSamples", "duration", "cooldownSec", "title", "body", "notify", "correlate"])
const CLAUSE_KEYS = new Set(["metric", "comparator", "threshold", "labels"])
const NOTIFY_KEYS = new Set(["telegram", "smtp", "webhook", "teams"])
const COMPARATORS = new Set(["lt", "lte", "gt", "gte", "eq"])
const AUTOMATION_KEYS = new Set(["id", "enabled", "when", "service", "cooldownSec", "ruleId", "staleSec", "process"])
const AUTOMATION_WHEN = new Set(["service_stopped", "rule", "defender_disabled", "heartbeat_stale", "process_present"])
const SOFTWARE_KEYS = new Set(["name", "below", "severity", "title", "remediation", "remediationType"])
const SEVERITIES = new Set(["critical", "high", "medium", "low", "info"])
const REMEDIATION = new Set(["patch", "config", "uninstall", "upgrade"])

export function validateHelper(body: unknown): { ok: true; value: HelperOptions } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "invalid_body" }
  const raw = body as Record<string, unknown>
  const allowed = new Set(Object.keys(DEFAULT_HELPER))
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) return { ok: false, error: "unknown_key" }
  }
  const num = (key: keyof HelperOptions, min: number, max: number) => {
    const value = Number(raw[key] ?? DEFAULT_HELPER[key])
    if (!Number.isInteger(value) || value < min || value > max) return null
    return value
  }
  const statusPort = num("statusPort", 1, 65535)
  const backoffSec = num("backoffSec", 1, 3600)
  const probeIntervalSec = num("probeIntervalSec", 5, 3600)
  const failThreshold = num("failThreshold", 1, 20)
  const maxBackoffSec = num("maxBackoffSec", 1, 86_400)
  const startupGraceSec = num("startupGraceSec", 0, 3600)
  const agentServiceName = typeof raw.agentServiceName === "string" ? raw.agentServiceName.trim() : DEFAULT_HELPER.agentServiceName
  if (!statusPort || !backoffSec || !probeIntervalSec || !failThreshold || !maxBackoffSec || startupGraceSec == null) {
    return { ok: false, error: "invalid_range" }
  }
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(agentServiceName)) return { ok: false, error: "invalid_service_name" }
  if (maxBackoffSec < backoffSec) return { ok: false, error: "invalid_range" }
  return {
    ok: true,
    value: { agentServiceName, statusPort, backoffSec, probeIntervalSec, failThreshold, maxBackoffSec, startupGraceSec },
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function unknownKey(raw: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(raw).some((key) => !allowed.has(key))
}

function loadYaml(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (text.length > 100_000) return { ok: false, error: "too_large" }
  try {
    return { ok: true, value: yaml.load(text) }
  } catch {
    return { ok: false, error: "invalid_yaml" }
  }
}

function validateRulesText(text: string): { ok: true } | { ok: false; error: string } {
  const loaded = loadYaml(text)
  if (!loaded.ok) return loaded
  const root = asRecord(loaded.value)
  if (!root || !Array.isArray(root.rules) || unknownKey(root, new Set(["rules"]))) return { ok: false, error: "invalid_yaml" }
  for (const item of root.rules) {
    const raw = asRecord(item)
    if (!raw || unknownKey(raw, RULE_KEYS)) return { ok: false, error: "unknown_key" }
    if (typeof raw.id !== "string" || !raw.id.trim()) return { ok: false, error: "invalid_rule" }
    if (raw.notify != null) {
      const notify = asRecord(raw.notify)
      if (!notify || unknownKey(notify, NOTIFY_KEYS)) return { ok: false, error: "unknown_key" }
      for (const key of ["webhook", "teams"] as const) {
        if (notify[key] != null && (typeof notify[key] !== "string" || (notify[key] !== "" && !String(notify[key]).startsWith("https://")))) {
          return { ok: false, error: "invalid_rule" }
        }
      }
    }
    const clauses = Array.isArray(raw.correlate) ? raw.correlate : [raw]
    if (!clauses.length) return { ok: false, error: "invalid_rule" }
    for (const clause of clauses) {
      const row = clause === raw ? raw : asRecord(clause)
      if (!row || (clause !== raw && unknownKey(row, CLAUSE_KEYS))) return { ok: false, error: "unknown_key" }
      if (typeof row.metric !== "string" || !COMPARATORS.has(String(row.comparator)) || typeof row.threshold !== "number") {
        return { ok: false, error: "invalid_rule" }
      }
    }
  }
  if (parseRules(text).length !== root.rules.length) return { ok: false, error: "invalid_rule" }
  return { ok: true }
}

function validateAutomationsText(text: string): { ok: true } | { ok: false; error: string } {
  const loaded = loadYaml(text)
  if (!loaded.ok) return loaded
  if (loaded.value == null || text.trim() === "") return { ok: true }
  const root = asRecord(loaded.value)
  if (!root || !Array.isArray(root.automations) || unknownKey(root, new Set(["automations"]))) return { ok: false, error: "invalid_yaml" }
  for (const item of root.automations) {
    const raw = asRecord(item)
    if (!raw || unknownKey(raw, AUTOMATION_KEYS)) return { ok: false, error: "unknown_key" }
    if (typeof raw.id !== "string" || !raw.id.trim() || !AUTOMATION_WHEN.has(String(raw.when))) return { ok: false, error: "invalid_yaml" }
  }
  if (parseAutomations(text).length !== root.automations.length) return { ok: false, error: "invalid_yaml" }
  return { ok: true }
}

function validateSoftwareText(text: string): { ok: true } | { ok: false; error: string } {
  const loaded = loadYaml(text)
  if (!loaded.ok) return loaded
  const root = asRecord(loaded.value)
  if (!root || !Array.isArray(root.rules) || unknownKey(root, new Set(["rules"]))) return { ok: false, error: "invalid_yaml" }
  for (const item of root.rules) {
    const raw = asRecord(item)
    if (!raw || unknownKey(raw, SOFTWARE_KEYS)) return { ok: false, error: "unknown_key" }
    if (typeof raw.name !== "string" || !raw.name.trim() || typeof raw.below !== "string" || !raw.below.trim()) {
      return { ok: false, error: "invalid_rule" }
    }
    const severity = typeof raw.severity === "string" ? raw.severity : "medium"
    if (!SEVERITIES.has(severity)) return { ok: false, error: "invalid_severity" }
    if (raw.remediationType != null && !REMEDIATION.has(String(raw.remediationType))) return { ok: false, error: "invalid_rule" }
  }
  if (parseSoftwareRules(text).length !== root.rules.length) return { ok: false, error: "invalid_rule" }
  return { ok: true }
}

export function validateSection(section: string, body: unknown): { ok: true } | { ok: false; error: string } {
  if (section === "rules" || section === "automations" || section === "scan-scope" || section === "software-rules") {
    if (!body || typeof body !== "object" || typeof (body as { text?: unknown }).text !== "string") return { ok: false, error: "invalid_body" }
    const text = (body as { text: string }).text
    if (section === "rules") return validateRulesText(text)
    if (section === "automations") return validateAutomationsText(text)
    if (section === "scan-scope") return validateScanScopeText(text)
    return validateSoftwareText(text)
  }
  if (section === "helper") return validateHelper(body)
  return { ok: false, error: "unknown_section" }
}

export function installCommandLine(serverUrl: string): string {
  const server = serverUrl.trim() || "http://localhost:4000"
  return `pc-manager-setup.exe /VERYSILENT /SERVER=${server} /SECRET=••••`
}
