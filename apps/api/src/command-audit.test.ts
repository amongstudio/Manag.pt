import assert from "node:assert/strict"
import { test } from "node:test"

import {
  auditPayload,
  isAuditedCommand,
  listSafeResult,
} from "./command-audit.ts"

test("audited command set covers the new admin actions", () => {
  for (const type of [
    "install_app",
    "uninstall_app",
    "local_user_action",
    "install_scan_tool",
  ]) {
    assert.equal(isAuditedCommand(type), true, type)
  }
  assert.equal(isAuditedCommand("get_connections"), false)
})

test("audit payload never carries passwords or script bodies", () => {
  const user = auditPayload("local_user_action", {
    name: "kiosk",
    action: "set_password",
    password: "hunter2",
  })
  assert.equal(user.password, "[redacted]")
  assert.equal(JSON.stringify(user).includes("hunter2"), false)

  const script = auditPayload("run_script", {
    shell: "powershell",
    script: "Write-Output 'secret-body'",
  })
  assert.equal(script.script, undefined)
  assert.equal(script.scriptBytes, 26)
  assert.match(String(script.scriptSha256), /^[0-9a-f]{64}$/)
  assert.equal(JSON.stringify(script).includes("secret-body"), false)

  const big = auditPayload("install_app", { name: "x".repeat(5000) })
  assert.deepEqual(big, { truncated: true, keys: ["name"] })
})

test("list-safe result hides clipboard text", () => {
  const safe = listSafeResult("get_clipboard", {
    current: { kind: "text", text: "top-secret" },
    history: [{ kind: "text", text: "top-secret" }],
  })
  assert.deepEqual(safe, { redacted: true, history: 1, hasCurrent: true })
  assert.equal(JSON.stringify(safe).includes("top-secret"), false)
  const other = { ok: true }
  assert.equal(listSafeResult("get_connections", other), other)
})
