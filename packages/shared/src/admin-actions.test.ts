import assert from "node:assert/strict"
import { test } from "node:test"

import {
  CLIPBOARD_HISTORY_MAX,
  MESH_NEVER_COMMANDS,
  MODULE_TEMPLATES,
  SCRIPT_TEMPLATES,
  clipContentKey,
  isLocalAccountName,
  moduleRegistrationSchema,
  moduleTemplateRunnable,
  parseConnectionsResult,
  parseLocalUsersResult,
  parseScanToolsResult,
  pushClipHistory,
  scanToolInstallConfirm,
  redactCredentialCommand,
  resolveTemplateParameters,
  scriptTemplateById,
  summarizeClipboardResult,
  validateCommandPayload,
} from "./index.ts"

test("install_app accepts winget ids and rejects shell or flag injection", () => {
  assert.equal(
    validateCommandPayload("install_app", {
      id: "Git.Git",
      version: "2.45.1",
      scope: "machine",
    }).ok,
    true
  )
  for (const id of ["Git.Git; calc", "-o evil", "a b", "Git.Git&&x", ""]) {
    assert.equal(validateCommandPayload("install_app", { id }).ok, false, id)
  }
  assert.equal(
    validateCommandPayload("install_app", {
      id: "Git.Git",
      version: "1.0 --force",
    }).ok,
    false
  )
})

test("uninstall_app validates MSI product codes and winget ids", () => {
  assert.equal(
    validateCommandPayload("uninstall_app", {
      name: "7-Zip",
      productCode: "{23170F69-40C1-2702-2409-000001000000}",
    }).ok,
    true
  )
  assert.equal(
    validateCommandPayload("uninstall_app", {
      name: "7-Zip",
      productCode: "23170F69",
    }).ok,
    false
  )
  assert.equal(
    validateCommandPayload("uninstall_app", { name: "-x" }).ok,
    false
  )
})

test("local account names reject domain and UPN targets", () => {
  for (const ok of ["Administrator", "svc.backup", "Jane Doe"])
    assert.equal(isLocalAccountName(ok), true, ok)
  for (const bad of [
    "CORP\\jane",
    "jane@corp.local",
    "a/b",
    "..",
    "-admin",
    " padded",
    "x".repeat(21),
    "a*b",
  ]) {
    assert.equal(isLocalAccountName(bad), false, bad)
  }
})

test("local_user_action requires a password only for set_password", () => {
  assert.equal(
    validateCommandPayload("local_user_action", {
      username: "bob",
      action: "disable",
    }).ok,
    true
  )
  assert.equal(
    validateCommandPayload("local_user_action", {
      username: "bob",
      action: "set_password",
    }).ok,
    false
  )
  assert.equal(
    validateCommandPayload("local_user_action", {
      username: "bob",
      action: "enable",
      password: "Secret123!",
    }).ok,
    false
  )
  assert.equal(
    validateCommandPayload("local_user_action", {
      username: "bob",
      action: "set_password",
      password: "short",
    }).ok,
    false
  )
  const shown = redactCredentialCommand(
    "local_user_action",
    { username: "bob", password: "Secret123!" },
    null
  )
  assert.equal((shown.payload as { password?: string }).password, "[redacted]")
})

test("privileged admin actions are never mesh-forwardable", () => {
  for (const type of [
    "local_user_action",
    "install_scan_tool",
    "get_clipboard",
    "install_app",
    "uninstall_app",
  ]) {
    assert.equal(
      (MESH_NEVER_COMMANDS as readonly string[]).includes(type),
      true,
      type
    )
  }
})

test("scan tool installs are limited to the pinned tools", () => {
  assert.equal(
    validateCommandPayload("install_scan_tool", { tool: "nuclei" }).ok,
    true
  )
  assert.equal(
    validateCommandPayload("install_scan_tool", { tool: "metasploit" }).ok,
    false
  )
  assert.equal(
    validateCommandPayload("get_connections", { limit: 5000 }).ok,
    false
  )
})

test("clip history dedupes unchanged polls and moves repeats to the top", () => {
  const a = { kind: "text", text: "alpha", at: 1, id: "a" }
  const b = { kind: "text", text: "beta", at: 2, id: "b" }
  let items = pushClipHistory([], a)
  items = pushClipHistory(items, b)
  const again = pushClipHistory(items, { ...b, at: 99, id: "b2" })
  assert.equal(again, items, "unchanged newest clip is a no-op")
  const moved = pushClipHistory(items, { ...a, at: 5, id: "a2" })
  assert.deepEqual(
    moved.map((c) => c.id),
    ["a", "b"]
  )
  assert.equal(moved.length, 2)
  const pinned = pushClipHistory([{ ...a, pinned: true }], {
    ...a,
    at: 7,
    id: "x",
  })
  assert.equal(pinned.length, 1)
  let many: Array<{ kind: string; text: string; at: number }> = []
  for (let i = 0; i < CLIPBOARD_HISTORY_MAX + 10; i++)
    many = pushClipHistory(many, { kind: "text", text: `t${i}`, at: i })
  assert.equal(many.length, CLIPBOARD_HISTORY_MAX)
  assert.notEqual(
    clipContentKey({ kind: "files", files: ["a"] }),
    clipContentKey({ kind: "files", files: ["b"] })
  )
})

test("clipboard results are summarized for history views", () => {
  const summary = summarizeClipboardResult({
    current: { text: "hunter2" },
    history: [{}, {}],
  }) as Record<string, unknown>
  assert.deepEqual(summary, { redacted: true, history: 2, hasCurrent: true })
  assert.equal(JSON.stringify(summary).includes("hunter2"), false)
})

test("script templates are static, read-only, and parameter patterns are strict", () => {
  const ids = new Set<string>()
  for (const template of SCRIPT_TEMPLATES) {
    assert.equal(ids.has(template.id), false, template.id)
    ids.add(template.id)
    assert.equal(template.destructive, false)
    assert.doesNotMatch(
      template.content,
      /Remove-Item|Clear-RecycleBin|Format-Volume|Stop-Computer|Restart-Computer|--all\b|mimikatz|sekurlsa/i
    )
    for (const param of template.parameters) {
      assert.match(
        param.pattern,
        /^\^.*\$$/,
        `${template.id}.${param.name} must be anchored`
      )
      assert.equal(new RegExp(param.pattern).test(param.default), true)
      for (const hostile of ["C'; calc", "$(calc)", "a b", "`calc`", "1;2"]) {
        assert.equal(
          new RegExp(param.pattern).test(hostile),
          false,
          `${template.id}.${param.name} ${hostile}`
        )
      }
      assert.ok(template.content.includes(`{{${param.name}}}`))
    }
  }
  const disk = scriptTemplateById("disk_cleanup_preview")!
  assert.deepEqual(resolveTemplateParameters(disk, { drive: "D" }), {
    ok: true,
    values: { drive: "D" },
  })
  assert.deepEqual(resolveTemplateParameters(disk, { drive: "D:\\" }), {
    ok: false,
    error: "invalid_parameter:drive",
  })
  const errors = scriptTemplateById("recent_system_errors")!
  assert.equal(resolveTemplateParameters(errors, { hours: "109" }).ok, true)
  assert.equal(resolveTemplateParameters(errors, { hours: "169" }).ok, false)
})

test("module templates pass the registration schema and DLLs stay non-runnable", () => {
  for (const template of MODULE_TEMPLATES) {
    const parsed = moduleRegistrationSchema.safeParse(template.registration)
    assert.equal(parsed.success, true, template.templateId)
    assert.equal(
      moduleTemplateRunnable(template),
      template.registration.kind === "exe"
    )
  }
  const dll = MODULE_TEMPLATES.find((t) => t.registration.kind === "dll-plugin")
  assert.ok(dll)
  assert.equal(moduleTemplateRunnable(dll), false)
})

test("agent result parsers keep metadata and drop malformed rows", () => {
  const conns = parseConnectionsResult({
    connections: [
      {
        protocol: "tcp",
        localAddr: "10.0.0.2",
        localPort: 50000,
        remoteAddr: "1.1.1.1",
        remotePort: 443,
        state: "ESTABLISHED",
        pid: 4,
        process: "svc.exe",
      },
      { protocol: "tcp" },
    ],
    interfaces: [{ name: "Ethernet", bytesSent: 10, bytesRecv: 20 }],
    processIo: [{ pid: 4, readBytes: 1, writeBytes: 2 }, { pid: 0 }],
    total: 7,
    byteCounts: "interface and process I/O totals",
  })
  assert.equal(conns?.connections.length, 1)
  assert.equal(conns?.total, 7)
  assert.equal(conns?.processIo.length, 1)
  assert.equal(parseConnectionsResult({ error: "x" }), null)

  const users = parseLocalUsersResult({
    users: [{ name: "kiosk", enabled: true, admin: false }, { name: "" }],
    computer: "PC1",
  })
  assert.equal(users?.users.length, 1)
  assert.equal(users?.users[0]?.enabled, true)
  assert.equal("password" in (users?.users[0] ?? {}), false)

  const tools = parseScanToolsResult({
    tools: [
      { tool: "nmap", available: false, canInstall: true },
      { tool: "sqlmap" },
    ],
    rawScan: false,
  })
  assert.deepEqual(
    tools?.tools.map((t) => t.tool),
    ["nmap"]
  )
  assert.match(scanToolInstallConfirm("nmap"), /Visual C\+\+ runtime/)
})
