import { test } from "node:test"
import assert from "node:assert/strict"

import { renderSafeMarkdown, safeDocSlug } from "./markdown-safe.ts"
import { installCommandLine, validateHelper, validateSection } from "./operator-config-lib.ts"
import { validateScanScopeText } from "./scan-scope.ts"

test("scan scope save rejects an empty allowlist and the whole internet", () => {
  const empty = validateScanScopeText("lab_mode: false\nauthorized_networks: []\nexcluded_hosts: []\nscan_rate_limit: 10\nscan_timeout_minutes: 5\n")
  assert.equal(empty.ok, false)
  if (!empty.ok) assert.equal(empty.error, "empty_allowlist")
  const world = validateScanScopeText(
    "lab_mode: false\nauthorized_networks:\n  - 0.0.0.0/0\nexcluded_hosts: []\nscan_rate_limit: 10\nscan_timeout_minutes: 5\n"
  )
  assert.equal(world.ok, false)
  if (!world.ok) assert.equal(world.error, "allowlist_too_wide")
  const lab = validateScanScopeText(
    "lab_mode: true\nauthorized_networks:\n  - 127.0.0.1/32\nexcluded_hosts: []\nscan_rate_limit: 10\nscan_timeout_minutes: 5\nlab_networks: []\nenable_vulners: false\n"
  )
  assert.equal(lab.ok, true)
})

test("yaml sections reject unknown keys and bad severity", () => {
  const rules = validateSection("rules", { text: "rules:\n  - id: x\n    metric: cpu\n    comparator: lt\n    threshold: 1\n    extra: 1\n" })
  assert.equal(rules.ok, false)
  const software = validateSection("software-rules", {
    text: "rules:\n  - name: curl\n    below: '8.0.0'\n    severity: catastrophic\n",
  })
  assert.equal(software.ok, false)
  if (!software.ok) assert.equal(software.error, "invalid_severity")
  const rate = validateScanScopeText(
    "lab_mode: true\nauthorized_networks:\n  - 127.0.0.1/32\nexcluded_hosts: []\nscan_rate_limit: 0\nscan_timeout_minutes: 5\n"
  )
  assert.equal(rate.ok, false)
  if (!rate.ok) assert.equal(rate.error, "invalid_range")
})

test("helper options reject unknown keys and inverted backoff", () => {
  const bad = validateHelper({ statusPort: 17890, backoffSec: 100, maxBackoffSec: 10, mystery: true })
  assert.equal(bad.ok, false)
  const ok = validateHelper({
    agentServiceName: "PCManagerAgent",
    statusPort: 17890,
    backoffSec: 30,
    probeIntervalSec: 45,
    failThreshold: 3,
    maxBackoffSec: 300,
    startupGraceSec: 60,
  })
  assert.equal(ok.ok, true)
  assert.equal(validateSection("nope", {}).ok, false)
})

test("install command masks the enrollment secret", () => {
  const line = installCommandLine("https://pc.example.com")
  assert.match(line, /\/SERVER=https:\/\/pc\.example\.com/)
  assert.match(line, /\/SECRET=••••/)
  assert.equal(line.includes("change-me"), false)
})

test("markdown escapes html and drops javascript links", () => {
  const html = renderSafeMarkdown("# Title\n\n<script>alert(1)</script>\n\n[ok](https://example.com)\n\n[bad](javascript:alert(1))\n")
  assert.equal(html.includes("<script>"), false)
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /href="https:\/\/example.com"/)
  assert.equal(html.includes("javascript:"), false)
  assert.equal(safeDocSlug("../etc/passwd"), null)
  assert.equal(safeDocSlug("users/getting-started"), "users/getting-started")
  assert.equal(safeDocSlug("users/public-access"), "users/public-access")
})
