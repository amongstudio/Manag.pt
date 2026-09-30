import fs from "node:fs"

import { prisma } from "@workspace/db"

import { appendAudit } from "./audit.js"
import { setAutomationsOverride } from "./automations-lib.js"
import { queueDeviceCommand } from "./command-queue.js"
import { env } from "./env.js"
import { DEFAULT_HELPER, installCommandLine, validateHelper, validateSection, type HelperOptions } from "./operator-config-lib.js"
import { setRulesOverride } from "./rules.js"
import { setSoftwareRulesOverride } from "./scan-store.js"
import { loadScanScope, parseScanScope, setScanScopeOverride } from "./scan-scope.js"
import type { FastifyInstance } from "fastify"

export { installCommandLine, validateHelper, validateSection, DEFAULT_HELPER }
export type { HelperOptions }

export const CONFIG_SECTIONS = ["rules", "automations", "scan-scope", "software-rules", "helper", "agent"] as const
export type ConfigSection = (typeof CONFIG_SECTIONS)[number]

const KEYS: Record<Exclude<ConfigSection, "agent">, string> = {
  rules: "yaml.rules",
  automations: "yaml.automations",
  "scan-scope": "yaml.scan-scope",
  "software-rules": "yaml.software-rules",
  helper: "yaml.helper",
}

function fileText(name: string): string {
  for (const candidate of [`config/${name}`, `../../config/${name}`]) {
    try {
      return fs.readFileSync(candidate, "utf8")
    } catch {
      /* next */
    }
  }
  return ""
}

function applyOverride(section: ConfigSection, text: string): void {
  if (section === "rules") setRulesOverride(text)
  if (section === "automations") setAutomationsOverride(text)
  if (section === "scan-scope") setScanScopeOverride(text)
  if (section === "software-rules") setSoftwareRulesOverride(text)
}

async function seedText(key: string, fileName: string): Promise<string> {
  const row = await prisma.setting.findUnique({ where: { key } })
  if (row) return row.value
  const text = fileText(fileName)
  await prisma.setting.create({ data: { key, value: text } })
  return text
}

export async function primeOperatorConfig(): Promise<void> {
  const rules = await seedText(KEYS.rules, "rules.yaml")
  const automations = await seedText(KEYS.automations, "automations.yaml")
  const scope = await seedText(KEYS["scan-scope"], "scan-scope.yaml")
  const software = await seedText(KEYS["software-rules"], "software-rules.yaml")
  setRulesOverride(rules)
  setAutomationsOverride(automations)
  setScanScopeOverride(scope)
  setSoftwareRulesOverride(software)
  const helper = await prisma.setting.findUnique({ where: { key: KEYS.helper } })
  if (!helper) {
    await prisma.setting.create({ data: { key: KEYS.helper, value: JSON.stringify(DEFAULT_HELPER) } })
  }
}

export async function readOperatorConfig(): Promise<{
  rules: string
  automations: string
  scanScope: ReturnType<typeof parseScanScope>
  scanScopeText: string
  softwareRules: string
  helper: HelperOptions
  installCommand: string
  publicUrl: string
  fileOnly: string[]
}> {
  await primeOperatorConfig()
  const helperRow = await prisma.setting.findUnique({ where: { key: KEYS.helper } })
  const helperParsed = validateHelper(helperRow ? JSON.parse(helperRow.value) : DEFAULT_HELPER)
  const scanScopeText = (await prisma.setting.findUnique({ where: { key: KEYS["scan-scope"] } }))?.value ?? ""
  return {
    rules: (await prisma.setting.findUnique({ where: { key: KEYS.rules } }))?.value ?? "",
    automations: (await prisma.setting.findUnique({ where: { key: KEYS.automations } }))?.value ?? "",
    scanScopeText,
    scanScope: loadScanScope(),
    softwareRules: (await prisma.setting.findUnique({ where: { key: KEYS["software-rules"] } }))?.value ?? "",
    helper: helperParsed.ok ? helperParsed.value : DEFAULT_HELPER,
    installCommand: installCommandLine(env.publicUrl),
    publicUrl: env.publicUrl,
    fileOnly: [
      "OPERATOR_TOKEN",
      "NEXT_PUBLIC_OPERATOR_TOKEN",
      "NEXT_PUBLIC_WS_URL",
      "ENROLLMENT_SECRET",
      "CREDENTIALS_KEY",
      "UPDATE_SIGNING_SECRET",
      "helper.update_signing_secret",
      "helper.agent_exe",
      "PUBLIC_URL",
      "ENABLE_AGENT_COMPILE",
    ],
  }
}

export async function saveOperatorSection(
  app: FastifyInstance,
  section: string,
  body: unknown,
  actor: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!CONFIG_SECTIONS.includes(section as ConfigSection) || section === "agent") {
    if (section !== "agent") return { ok: false, error: "unknown_section" }
  }
  const checked = section === "agent" ? { ok: true as const } : validateSection(section, body)
  if (!checked.ok) return checked
  if (section === "helper") {
    const helper = validateHelper(body)
    if (!helper.ok) return helper
    await prisma.setting.upsert({
      where: { key: KEYS.helper },
      create: { key: KEYS.helper, value: JSON.stringify(helper.value) },
      update: { value: JSON.stringify(helper.value) },
    })
    await appendAudit({ actor, action: "config_save", detail: { section, keys: Object.keys(helper.value) } })
    await pushApplyConfig(app, helper.value)
    return { ok: true }
  }
  if (section === "rules" || section === "automations" || section === "scan-scope" || section === "software-rules") {
    const text = (body as { text: string }).text
    const key = KEYS[section]
    await prisma.setting.upsert({
      where: { key },
      create: { key, value: text },
      update: { value: text },
    })
    applyOverride(section, text)
    await appendAudit({ actor, action: "config_save", detail: { section } })
    return { ok: true }
  }
  return { ok: false, error: "unknown_section" }
}

async function pushApplyConfig(app: FastifyInstance, helper: HelperOptions): Promise<void> {
  const devices = await prisma.device.findMany({ where: { status: "online" }, select: { id: true }, take: 100 })
  for (const device of devices) {
    await queueDeviceCommand(app, device.id, "apply_config", { helper }, "operator").catch(() => undefined)
  }
}
