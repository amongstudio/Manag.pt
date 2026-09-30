import fs from "node:fs"
import path from "node:path"

import yaml from "js-yaml"

export type Comparator = "lt" | "lte" | "gt" | "gte" | "eq"

export type RuleClause = {
  metric: string
  comparator: Comparator
  threshold: number
  labels?: Record<string, string>
}

export type AlertRule = {
  id: string
  title: string
  body: string
  forSamples: number
  cooldownSec: number
  clauses: RuleClause[]
  notify: {
    telegram: boolean
    smtp: boolean
    webhook: string
    teams: string
  }
}

export type MetricPoint = {
  name: string
  value: number
  labels: Record<string, string>
  sampledAt: number
}

const COMPARATORS = new Set<Comparator>(["lt", "lte", "gt", "gte", "eq"])

export function compare(value: number, comparator: Comparator, threshold: number): boolean {
  switch (comparator) {
    case "lt":
      return value < threshold
    case "lte":
      return value <= threshold
    case "gt":
      return value > threshold
    case "gte":
      return value >= threshold
    case "eq":
      return value === threshold
    default:
      return false
  }
}

export function durationToSamples(duration: string | undefined, explicit: number | undefined): number {
  if (Number.isInteger(explicit) && (explicit as number) > 0) return Math.min(explicit as number, 120)
  if (!duration) return 1
  const match = /^(\d+)(s|m|h)$/.exec(duration.trim())
  if (!match) return 1
  const amount = Number(match[1])
  const unit = match[2]
  const seconds = unit === "h" ? amount * 3600 : unit === "m" ? amount * 60 : amount
  return Math.min(120, Math.max(1, Math.ceil(seconds / 60)))
}

function labelsMatch(point: Record<string, string>, want: Record<string, string> | undefined): boolean {
  if (!want) return true
  return Object.entries(want).every(([key, value]) => point[key] === value)
}

export function clauseHolds(points: MetricPoint[], clause: RuleClause, forSamples: number): boolean {
  const matching = points
    .filter((point) => point.name === clause.metric && labelsMatch(point.labels, clause.labels))
    .sort((a, b) => b.sampledAt - a.sampledAt)
  if (matching.length < forSamples) return false
  return matching.slice(0, forSamples).every((point) => compare(point.value, clause.comparator, clause.threshold))
}

export function ruleHolds(points: MetricPoint[], rule: AlertRule): boolean {
  return rule.clauses.every((clause) => clauseHolds(points, clause, rule.forSamples))
}

function asClause(value: unknown): RuleClause | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Record<string, unknown>
  const metric = typeof raw.metric === "string" ? raw.metric.trim() : ""
  const comparator = raw.comparator
  const threshold = Number(raw.threshold)
  if (!metric || typeof comparator !== "string" || !COMPARATORS.has(comparator as Comparator)) return null
  if (!Number.isFinite(threshold)) return null
  const labels =
    raw.labels && typeof raw.labels === "object" && !Array.isArray(raw.labels)
      ? Object.fromEntries(
          Object.entries(raw.labels as Record<string, unknown>)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string")
            .slice(0, 8)
        )
      : undefined
  return { metric, comparator: comparator as Comparator, threshold, labels }
}

export function parseRules(text: string): AlertRule[] {
  let parsed: unknown
  try {
    parsed = yaml.load(text)
  } catch {
    return []
  }
  const root = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).rules : null
  if (!Array.isArray(root)) return []
  const out: AlertRule[] = []
  for (const item of root) {
    if (!item || typeof item !== "object") continue
    const raw = item as Record<string, unknown>
    const id = typeof raw.id === "string" ? raw.id.trim() : ""
    if (!id || id.length > 80) continue
    const clauses: RuleClause[] = []
    if (Array.isArray(raw.correlate)) {
      for (const clause of raw.correlate) {
        const parsedClause = asClause(clause)
        if (parsedClause) clauses.push(parsedClause)
      }
    } else {
      const parsedClause = asClause(raw)
      if (parsedClause) clauses.push(parsedClause)
    }
    if (clauses.length === 0) continue
    const notify = raw.notify && typeof raw.notify === "object" ? (raw.notify as Record<string, unknown>) : {}
    out.push({
      id,
      title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : id,
      body: typeof raw.body === "string" ? raw.body.slice(0, 2000) : "",
      forSamples: durationToSamples(typeof raw.duration === "string" ? raw.duration : undefined, Number(raw.forSamples)),
      cooldownSec: Number.isFinite(Number(raw.cooldownSec)) ? Math.max(0, Number(raw.cooldownSec)) : 1800,
      clauses,
      notify: {
        telegram: notify.telegram !== false,
        smtp: notify.smtp !== false,
        webhook: typeof notify.webhook === "string" && notify.webhook.startsWith("https://") ? notify.webhook : "",
        teams: typeof notify.teams === "string" && notify.teams.startsWith("https://") ? notify.teams : "",
      },
    })
  }
  return out
}

/** Avoid sending the same Teams or webhook URL twice in one evaluation. */
export function ruleDelivery(input: {
  ruleTeams: string
  ruleWebhook: string
  settingsTeams?: string
  settingsTeamsEnabled: boolean
}): { webhook: string; teamsURL: string } {
  const settings = input.settingsTeamsEnabled && (input.settingsTeams ?? "").startsWith("https://") ? input.settingsTeams! : ""
  const ruleTeams = input.ruleTeams.startsWith("https://") ? input.ruleTeams : ""
  const webhook = input.ruleWebhook.startsWith("https://") ? input.ruleWebhook : ""
  return {
    webhook,
    teamsURL: ruleTeams && ruleTeams !== settings ? ruleTeams : "",
  }
}

export function rulesPath(): string {
  const fromEnv = process.env.RULES_PATH?.trim()
  if (fromEnv) return fromEnv
  const candidates = [
    path.resolve(process.cwd(), "config/rules.yaml"),
    path.resolve(process.cwd(), "../../config/rules.yaml"),
  ]
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[1]!
}

let rulesOverride: string | null = null
let rulesCache: AlertRule[] | null = null

export function setRulesOverride(text: string | null): void {
  rulesOverride = text
  rulesCache = null
}

export function loadRules(): AlertRule[] {
  if (rulesCache) return rulesCache
  let text = rulesOverride
  if (text == null) {
    try {
      text = fs.readFileSync(rulesPath(), "utf8")
    } catch {
      text = ""
    }
  }
  rulesCache = parseRules(text)
  return rulesCache
}
