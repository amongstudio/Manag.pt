import { test } from "node:test"
import assert from "node:assert/strict"

import { parseAssistantText, assistantNeedsConfirm, assistantPrompt } from "./assistant-lib.ts"
import { buildAuditRow } from "./audit-row.ts"
import { cronMatches, parseCron } from "./cron-match.ts"
import { cleanSerial, escapeLike, normalizeInventory } from "./inventory-lib.ts"
import { clauseHolds, compare, parseRules, ruleHolds, type MetricPoint } from "./rules.ts"
import { renderScript, validateScriptWrite } from "./scripts-lib.ts"
import { inMaintenanceWindow, nextUpdateApproval } from "./updates-lib.ts"
import { defenderDisabled, parseAutomations } from "./automations-lib.ts"

test("script validation and render", () => {
  const parsed = validateScriptWrite({
    name: "Disk",
    language: "powershell",
    content: "Write-Output {{Name}}",
    timeoutSeconds: 30,
    parameters: [{ name: "Name", default: "C" }],
  })
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.equal(renderScript(parsed.value.content, { Name: "D" }), "Write-Output D")
  assert.equal(validateScriptWrite({ name: "", language: "shell", content: "x" }).ok, false)
})

test("cron matches a minute and rejects garbage", () => {
  const at = new Date(Date.UTC(2026, 0, 2, 3, 15))
  assert.equal(cronMatches("15 3 * * *", at), true)
  assert.equal(cronMatches("0 3 * * *", at), false)
  assert.equal(parseCron("nope"), null)
})

test("rule holds for N samples and correlates", () => {
  assert.equal(compare(10, "lt", 15), true)
  const points: MetricPoint[] = [
    { name: "disk_free_pct", value: 10, labels: { mount: "C:" }, sampledAt: 3000 },
    { name: "disk_free_pct", value: 9, labels: { mount: "C:" }, sampledAt: 2000 },
    { name: "service_up", value: 0, labels: { name: "Spooler" }, sampledAt: 3000 },
    { name: "service_up", value: 0, labels: { name: "Spooler" }, sampledAt: 2000 },
  ]
  const rules = parseRules(`
rules:
  - id: storage-failure
    title: storage failure
    forSamples: 2
    correlate:
      - { metric: disk_free_pct, comparator: lt, threshold: 15 }
      - { metric: service_up, comparator: eq, threshold: 0, labels: { name: Spooler } }
`)
  assert.equal(rules.length, 1)
  assert.equal(ruleHolds(points, rules[0]!), true)
  assert.equal(clauseHolds(points, rules[0]!.clauses[0]!, 3), false)
})

test("audit row is append-only shape", () => {
  const row = buildAuditRow({ actor: "ada", action: "script_run", deviceId: "d1", detail: { ok: true } })
  assert.equal(row.actor, "ada")
  assert.equal("updatedAt" in row, false)
  assert.equal(JSON.parse(row.detail).ok, true)
})

test("inventory drops placeholder serials", () => {
  assert.equal(cleanSerial("To be filled by O.E.M."), "")
  assert.equal(cleanSerial("ABC123"), "ABC123")
  const report = normalizeInventory({
    hardware: { serial: "Default string", model: "Test" },
    os: { name: "linux" },
    software: [{ name: "curl", version: "8" }],
  })
  assert.ok(report)
  assert.equal(report?.hardware.serial, "")
  assert.equal(report?.hardware.model, "Test")
  assert.equal(report?.software[0]?.name, "curl")
  assert.equal(escapeLike("100%"), "100\\%")
})

test("update approval transitions and maintenance window", () => {
  assert.equal(nextUpdateApproval("pending", "approved"), "approved")
  assert.equal(nextUpdateApproval("pending", "installing"), null)
  assert.equal(nextUpdateApproval("approved", "installing"), "installing")
  assert.equal(inMaintenanceWindow(new Date(2026, 0, 1, 2, 0), "", ""), true)
  assert.equal(inMaintenanceWindow(new Date(2026, 0, 1, 2, 0), "01:00", "03:00"), true)
  assert.equal(inMaintenanceWindow(new Date(2026, 0, 1, 4, 0), "01:00", "03:00"), false)
})

test("assistant parses local actions and hides secrets from the prompt", () => {
  const action = parseAssistantText("restart service Spooler")
  assert.deepEqual(action, { action: "restart_service", name: "Spooler" })
  assert.equal(assistantNeedsConfirm(action!), true)
  assert.equal(parseAssistantText("refresh inventory")?.action, "collect_inventory")
  const prompt = assistantPrompt("restart service Spooler")
  assert.equal(prompt.system.includes("deviceKey"), false)
  assert.equal(prompt.user.includes("enrollment"), false)
})

test("automations parse and defender flag", () => {
  const rows = parseAutomations(`
automations:
  - id: restart-stopped-service
    when: service_stopped
    service: Spooler
  - id: disk-free-alert
    when: rule
    ruleId: disk-free-low
`)
  assert.equal(rows.length, 2)
  assert.equal(defenderDisabled({ realtimeProtectionEnabled: false }), true)
  assert.equal(defenderDisabled({ realtimeProtectionEnabled: true }), false)
})
