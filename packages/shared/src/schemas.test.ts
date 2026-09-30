import assert from "node:assert/strict"
import { test } from "node:test"

import {
  AGENT_WS_BIN_TYPE,
  AGENT_WS_TYPE,
  APP_VERSION,
  COMMAND_RESULT_MAX_BYTES,
  COMMAND_TEMPLATES,
  COMMAND_TYPES,
  COPILOT_COMMAND_TYPES,
  copilotToolNeedsConfirm,
  HEARTBEAT_EXTRAS_MAX_BYTES,
  isComposerCommandType,
  isCopilotCommandType,
  isPeerCommandType,
  MAX_CREATE_COMMAND_DEVICES,
  MAX_UPLOAD_BYTES,
  WEBRTC_ERROR,
  h264FallbackLabel,
  WS_EVENTS,
  agentConfigSchema,
  appSettingsPatchSchema,
  capCommandResult,
  clipboardPayloadSchema,
  createCommandSchema,
  extrasWithinCap,
  fileListQuerySchema,
  groupedBuiltinCommandTemplates,
  helloSchema,
  heartbeatSchema,
  registerSchema,
  deleteDeviceCommandsSchema,
  isCommandActive,
  isCommandTerminal,
  shellCloseClientSchema,
  shellDataClientSchema,
  shellExecClientSchema,
  shellExecFrameSchema,
  shellOpenClientSchema,
  shellOpenFrameSchema,
  shellResizeClientSchema,
  stampConfigYaml,
  stampPackSchema,
  validateCommandPayload,
  webrtcSignalPayloadSchema,
  formatRegistryData,
  isDangerousRegistryPath,
  isOfficialService,
  normalizeRegistryPath,
  parseRegistryKey,
  parseServiceList,
  resultErrorMessage,
  registryDisplayPath,
} from "./index.ts"

test("app version is 3.3.0", () => {
  assert.equal(APP_VERSION, "3.3.0")
})

test("shell socket events match agent-ws type strings", () => {
  assert.equal(WS_EVENTS.SHELL_OPEN, AGENT_WS_TYPE.shell_open)
  assert.equal(WS_EVENTS.SHELL_DATA, AGENT_WS_TYPE.shell_data)
  assert.equal(WS_EVENTS.SHELL_RESIZE, AGENT_WS_TYPE.shell_resize)
  assert.equal(WS_EVENTS.SHELL_CLOSE, AGENT_WS_TYPE.shell_close)
  assert.equal(WS_EVENTS.SHELL_EXEC, AGENT_WS_TYPE.shell_exec)
  assert.equal(AGENT_WS_BIN_TYPE.shell_data, 4)
})

test("unused stat_batch and plugin_progress protocol is gone", () => {
  assert.equal("stat_batch" in AGENT_WS_TYPE, false)
  assert.equal("plugin_progress" in AGENT_WS_TYPE, false)
  assert.equal("STAT_UPDATE" in WS_EVENTS, false)
})

test("heartbeat accepts processes null", () => {
  const parsed = heartbeatSchema.parse({
    cpu: 1,
    ram: 2,
    disk: 3,
    processes: null,
  })
  assert.deepEqual(parsed.processes, [])
})

test("heartbeat accepts presence-only empty body", () => {
  const parsed = heartbeatSchema.parse({})
  assert.deepEqual(parsed.processes, [])
  assert.equal(parsed.cpu, undefined)
  assert.equal(parsed.extras, undefined)
})

test("heartbeat and hello accept lan discovery fields", () => {
  const hb = heartbeatSchema.parse({
    lanAddrs: ["10.0.0.8", "fd00::1"],
    lanPort: 17891,
  })
  assert.deepEqual(hb.lanAddrs, ["10.0.0.8", "fd00::1"])
  assert.equal(hb.lanPort, 17891)
  const hello = helloSchema.parse({
    type: "hello",
    deviceId: "dev-1",
    keyProof: "a".repeat(64),
    lanAddrs: ["192.168.1.9"],
    lanPort: 17891,
  })
  assert.deepEqual(hello.lanAddrs, ["192.168.1.9"])
})

test("settings patch rejects non-discord webhook", () => {
  const result = appSettingsPatchSchema.safeParse({
    discord: { webhookUrl: "http://evil.example/hook" },
  })
  assert.equal(result.success, false)
})

test("settings patch accepts mesh.enabled default-off shape", () => {
  const parsed = appSettingsPatchSchema.parse({ mesh: { enabled: true } })
  assert.equal(parsed.mesh?.enabled, true)
})

test("settings patch accepts mesh.wan and allowCommands", () => {
  const parsed = appSettingsPatchSchema.parse({
    mesh: { enabled: true, wan: true, allowCommands: ["kill_process"] },
  })
  assert.equal(parsed.mesh?.wan, true)
  assert.deepEqual(parsed.mesh?.allowCommands, ["kill_process"])
})

test("createCommandSchema accepts optional forwardTo", () => {
  const parsed = createCommandSchema.parse({
    deviceIds: ["dev-a"],
    type: "get_processes",
    payload: {},
    forwardTo: "dev-b",
  })
  assert.equal(parsed.forwardTo, "dev-b")
})

test("validateCommandPayload keeps meshForward after stripping unknown keys", () => {
  const checked = validateCommandPayload("get_processes", { meshForward: "dev-b", extra: 1 })
  assert.equal(checked.ok, true)
  if (checked.ok) {
    assert.equal(checked.payload.meshForward, "dev-b")
    assert.equal(checked.payload.extra, undefined)
  }
})

test("peer mesh payload is valid without HMAC ticket", () => {
  assert.equal(
    validateCommandPayload("peer_offer", {
      mesh: true,
      copyId: "c1",
      destDeviceId: "dst",
      srcPath: "C:\\a.txt",
      destPath: "C:\\b.txt",
      addrs: ["10.0.0.2"],
      port: 17891,
    }).ok,
    true
  )
  assert.equal(validateCommandPayload("peer_listen", { mesh: true, copyId: "c1", destPath: "C:\\b.txt" }).ok, true)
})

test("settings patch accepts OpenAI-compatible llm section", () => {
  const parsed = appSettingsPatchSchema.parse({
    llm: { baseUrl: "http://127.0.0.1:11434/v1", apiKey: "", model: "gpt-4o-mini" },
  })
  assert.equal(parsed.llm?.baseUrl, "http://127.0.0.1:11434/v1")
  assert.equal(
    appSettingsPatchSchema.safeParse({ llm: { baseUrl: "javascript:alert(1)" } }).success,
    false
  )
})

test("copilot tools are existing command types and only run_plugin confirms", () => {
  assert.equal(COPILOT_COMMAND_TYPES.every((t) => (COMMAND_TYPES as readonly string[]).includes(t)), true)
  assert.equal(isCopilotCommandType("get_files"), true)
  assert.equal(isCopilotCommandType("get_adapters"), true)
  assert.equal(isCopilotCommandType("get_ports"), true)
  assert.equal(isCopilotCommandType("get_firewall"), true)
  assert.equal(isCopilotCommandType("get_event_log"), true)
  assert.equal(isCopilotCommandType("get_windows_update"), true)
  assert.equal(isCopilotCommandType("get_admin_center"), true)
  assert.equal(isCopilotCommandType("get_tasks"), true)
  assert.equal(isCopilotCommandType("get_defender"), true)
  assert.equal(isCopilotCommandType("get_bitlocker"), true)
  assert.equal(isCopilotCommandType("get_capabilities"), true)
  assert.equal(isCopilotCommandType("set_task_enabled"), false)
  assert.equal(isCopilotCommandType("start_quick_assist"), false)
  assert.equal(isCopilotCommandType("set_firewall_rule"), false)
  assert.equal(isCopilotCommandType("kill_switch"), false)
  assert.equal(copilotToolNeedsConfirm("run_plugin"), true)
  assert.equal(copilotToolNeedsConfirm("run_script"), false)
  assert.equal(copilotToolNeedsConfirm("get_processes"), false)
  assert.equal(WS_EVENTS.CHAT_DELTA, "chat_delta")
  assert.equal(isPeerCommandType("peer_offer"), true)
  assert.equal(isPeerCommandType("peer_listen"), true)
  assert.equal(isComposerCommandType("peer_offer"), false)
  assert.equal(isComposerCommandType("get_files"), true)
  assert.equal(isCopilotCommandType("peer_copy" as string), false)
  assert.equal(isCopilotCommandType("peer_offer"), false)
})

test("file list query requires a bounded path", () => {
  assert.equal(fileListQuerySchema.safeParse({ path: "C:/Users" }).success, true)
  assert.equal(fileListQuerySchema.safeParse({ path: "C:\\Windows\\System32\\config" }).success, true)
  assert.equal(fileListQuerySchema.safeParse({ path: "../etc/passwd" }).success, true)
  assert.equal(fileListQuerySchema.safeParse({ path: "C:\\bad\0path" }).success, false)
  assert.equal(fileListQuerySchema.safeParse({ path: "" }).success, false)
})

test("register rejects empty enrollment secret", () => {
  const result = registerSchema.safeParse({
    enrollmentSecret: "",
    deviceId: "11111111-1111-4111-8111-111111111111",
    hostname: "box",
    platform: "linux",
    arch: "amd64",
    agentVersion: "3.2.1",
  })
  assert.equal(result.success, false)
})

test("register accepts optional deviceKey", () => {
  const parsed = registerSchema.parse({
    enrollmentSecret: "secret",
    deviceId: "11111111-1111-4111-8111-111111111111",
    hostname: "box",
    platform: "linux",
    arch: "amd64",
    agentVersion: "3.2.1",
    deviceKey: "a".repeat(32),
  })
  assert.equal(parsed.deviceKey?.length, 32)
})

test("service and registry command payloads", () => {
  assert.equal(validateCommandPayload("get_services", {}).ok, true)
  assert.equal(validateCommandPayload("start_service", { name: "Spooler" }).ok, true)
  assert.equal(validateCommandPayload("stop_service", { name: "PCManagerAgent" }).ok, true)
  assert.equal(validateCommandPayload("restart_service", { name: "PCManagerHelper" }).ok, true)
  assert.equal(validateCommandPayload("start_service", {}).ok, false)
  assert.equal(validateCommandPayload("start_service", { name: "bad\nname" }).ok, false)
  const listed = validateCommandPayload("get_registry", { hive: "HKLM", path: "SOFTWARE\\PC Manager\\Agent" })
  assert.equal(listed.ok, true)
  assert.equal(validateCommandPayload("get_registry", { hive: "HKU" }).ok, false)
  const setValue = validateCommandPayload("set_registry", {
    hive: "HKCU",
    path: "SOFTWARE\\PC Manager\\Agent",
    name: "notes",
    type: "REG_SZ",
    data: "ok",
  })
  assert.equal(setValue.ok, true)
  assert.equal(validateCommandPayload("set_registry", { hive: "HKLM", path: "SOFTWARE", target: "key" }).ok, true)
  assert.equal(validateCommandPayload("set_registry", { hive: "HKLM", path: "SOFTWARE", name: "x" }).ok, false)
  assert.equal(
    validateCommandPayload("delete_registry", { hive: "HKLM", path: "SOFTWARE\\PC Manager\\Agent", name: "notes" }).ok,
    true
  )
})

test("network and firewall command payloads", () => {
  assert.equal(validateCommandPayload("get_adapters", {}).ok, true)
  assert.equal(validateCommandPayload("get_ports", {}).ok, true)
  assert.equal(validateCommandPayload("get_ports", { listenOnly: true }).ok, true)
  assert.equal(validateCommandPayload("get_firewall", {}).ok, true)
  const setRule = validateCommandPayload("set_firewall_rule", {
    name: "Peer LAN",
    direction: "inbound",
    action: "allow",
    protocol: "tcp",
    localPorts: "17891",
    enabled: true,
  })
  assert.equal(setRule.ok, true)
  assert.equal(validateCommandPayload("set_firewall_rule", { name: "bad\nname" }).ok, false)
  assert.equal(validateCommandPayload("set_firewall_rule", { name: "x", protocol: "esp" }).ok, false)
  assert.equal(validateCommandPayload("set_firewall_rule", { name: "x", profiles: "evil" }).ok, false)
  assert.equal(validateCommandPayload("delete_firewall_rule", { name: "Peer LAN" }).ok, true)
  assert.equal(validateCommandPayload("delete_firewall_rule", {}).ok, false)
})

test("native windows command payloads", () => {
  assert.equal(validateCommandPayload("get_event_log", {}).ok, true)
  assert.equal(validateCommandPayload("get_event_log", { log: "Application", newest: 20, level: "error" }).ok, true)
  assert.equal(validateCommandPayload("get_event_log", { newest: 201 }).ok, false)
  assert.equal(validateCommandPayload("get_windows_update", {}).ok, true)
  assert.equal(validateCommandPayload("get_windows_update", { online: true }).ok, true)
  assert.equal(validateCommandPayload("get_admin_center", {}).ok, true)
  assert.equal(validateCommandPayload("start_quick_assist", {}).ok, true)
  assert.equal(validateCommandPayload("start_quick_assist", { app: "msra" }).ok, true)
  assert.equal(validateCommandPayload("start_quick_assist", { app: "compmgmt.msc" }).ok, false)
  assert.equal(validateCommandPayload("get_tasks", {}).ok, true)
  assert.equal(validateCommandPayload("get_tasks", { query: "Defrag" }).ok, true)
  assert.equal(validateCommandPayload("set_task_enabled", { path: "\\Foo", enabled: false }).ok, true)
  assert.equal(validateCommandPayload("set_task_enabled", { path: "\\Foo" }).ok, false)
  assert.equal(validateCommandPayload("get_defender", {}).ok, true)
  assert.equal(validateCommandPayload("get_bitlocker", {}).ok, true)
  assert.equal(validateCommandPayload("get_capabilities", {}).ok, true)
  assert.equal(validateCommandPayload("get_capabilities", { query: "Rsat" }).ok, true)
  assert.equal(validateCommandPayload("install_capability", {}).ok, true)
  assert.equal(validateCommandPayload("install_capability", { name: "Rsat.Foo" }).ok, false)
  assert.equal(validateCommandPayload("get_smb", {}).ok, true)
  assert.equal(validateCommandPayload("smb_list", { path: "\\\\srv\\share" }).ok, true)
  assert.equal(validateCommandPayload("smb_list", {}).ok, false)
  assert.equal(validateCommandPayload("smb_connect", { unc: "\\\\srv\\share", username: "u" }).ok, true)
  assert.equal(validateCommandPayload("smb_disconnect", { drive: "Z" }).ok, true)
  assert.equal(validateCommandPayload("smb_disconnect", {}).ok, false)
  assert.equal(validateCommandPayload("get_credentials", { sources: ["windows"] }).ok, true)
  assert.equal(validateCommandPayload("backup_credentials", {}).ok, true)
  assert.equal(validateCommandPayload("generate_credential", { save: true }).ok, false)
  assert.equal(validateCommandPayload("generate_credential", { save: true, target: "app:demo" }).ok, true)
  assert.equal(
    validateCommandPayload("restore_credentials", { credentials: [{ target: "app:demo", secret: "s" }] }).ok,
    true
  )
  assert.equal(validateCommandPayload("defender_action", { threatId: "1", action: "quarantine" }).ok, true)
  assert.equal(validateCommandPayload("set_defender", { realtime: true }).ok, true)
  assert.equal(validateCommandPayload("set_defender", {}).ok, false)
  assert.equal(validateCommandPayload("cancel_defender_scan", {}).ok, true)
  assert.equal(validateCommandPayload("set_bitlocker", { action: "suspend", mountPoint: "C:" }).ok, true)
  assert.equal(validateCommandPayload("set_bitlocker", { action: "unlock", mountPoint: "D:" }).ok, false)
  assert.equal(
    validateCommandPayload("set_bitlocker", { action: "unlock", mountPoint: "D:", recoveryPassword: "111111-222222-333333-444444-555555-666666-777777-888888" }).ok,
    true
  )
  assert.equal(validateCommandPayload("set_bitlocker", { action: "add_protector", mountPoint: "C:" }).ok, false)
  assert.equal(validateCommandPayload("set_bitlocker", { action: "remove_protector", mountPoint: "C:", protectorId: "{id}" }).ok, true)
  assert.equal(validateCommandPayload("generate_credential", { length: 12, upper: false, lower: false, digits: false, symbols: false }).ok, false)
  assert.equal(validateCommandPayload("generate_credential", { length: 12, upper: true, lower: false, digits: false, symbols: false }).ok, true)
})

test("copy_file and preview_file payloads", () => {
  const copy = validateCommandPayload("copy_file", { from: "/tmp/a", to: "/tmp/b" })
  assert.equal(copy.ok, true)
  const preview = validateCommandPayload("preview_file", { path: "/tmp/a.txt" })
  assert.equal(preview.ok, true)
  assert.equal(validateCommandPayload("copy_file", { from: "/tmp/a" }).ok, false)
  assert.equal(validateCommandPayload("preview_file", {}).ok, false)
})

test("peer copy command payloads require a ticket", () => {
  const ticket = {
    copyId: "copy-1",
    srcDeviceId: "src",
    dstDeviceId: "dst",
    srcPath: "/tmp/a.txt",
    destPath: "/tmp/b.txt",
    exp: 1_700_000_000,
    maxBytes: 1024,
    port: 17891,
    addrs: ["10.0.0.2"],
    sig: "b".repeat(64),
  }
  assert.equal(validateCommandPayload("peer_listen", { ticket }).ok, true)
  assert.equal(validateCommandPayload("peer_offer", { ticket, fileId: "f1" }).ok, true)
  assert.equal(validateCommandPayload("peer_offer", { ticket: { ...ticket, sig: "nope" } }).ok, false)
  assert.equal(validateCommandPayload("peer_listen", {}).ok, false)
})

test("built-in command templates validate", () => {
  for (const tpl of COMMAND_TEMPLATES) {
    const result = validateCommandPayload(tpl.type, tpl.payload)
    assert.equal(result.ok, true, tpl.id)
    assert.ok(tpl.category, tpl.id)
  }
  const ids = new Set(COMMAND_TEMPLATES.map((t) => t.id))
  for (const id of [
    "builtin:win_ipconfig",
    "builtin:win_computer_info",
    "builtin:win_services",
    "builtin:win_event_log",
    "builtin:get_windows_update",
    "builtin:get_admin_center",
    "builtin:start_quick_assist",
    "builtin:win_gpupdate",
    "builtin:win_whoami",
    "builtin:win_flush_dns",
    "builtin:get_services",
    "builtin:get_registry_agent",
    "builtin:get_adapters",
    "builtin:get_ports",
    "builtin:get_firewall",
    "builtin:get_tasks",
    "builtin:get_defender",
    "builtin:get_bitlocker",
    "builtin:get_capabilities",
    "builtin:install_capability",
    "builtin:get_smb",
    "builtin:get_credentials",
    "builtin:backup_credentials",
  ]) {
    assert.ok(ids.has(id), id)
  }
  const groups = groupedBuiltinCommandTemplates()
  const windows = groups.find((g) => g.category === "windows")
  assert.equal(windows?.templates.length, 23)
  assert.deepEqual(
    groups.map((g) => g.category),
    ["host", "watch", "files", "script", "apps", "windows"]
  )
})

test("shell frames require deviceId on the dashboard client", () => {
  const open = shellOpenClientSchema.parse({ deviceId: "dev-1", cols: 80, rows: 24, shell: "powershell" })
  assert.equal(open.deviceId, "dev-1")
  assert.equal(open.shell, "powershell")
  assert.equal(shellOpenClientSchema.safeParse({ cols: 80 }).success, false)
  assert.equal(shellOpenFrameSchema.parse({ type: "shell_open", cols: 120 }).cols, 120)
  assert.equal(shellDataClientSchema.parse({ deviceId: "dev-1", data: "dir\r" }).data, "dir\r")
  assert.equal(shellResizeClientSchema.parse({ deviceId: "dev-1", cols: 100, rows: 30 }).rows, 30)
  assert.equal(shellCloseClientSchema.parse({ deviceId: "dev-1", reason: "hangup" }).reason, "hangup")
  assert.equal(shellResizeClientSchema.safeParse({ deviceId: "dev-1", cols: 0, rows: 24 }).success, false)
  const exec = shellExecClientSchema.parse({
    deviceId: "dev-1",
    id: "e1",
    command: "Get-Date",
    shell: "powershell",
  })
  assert.equal(exec.command, "Get-Date")
  assert.equal(shellExecClientSchema.safeParse({ deviceId: "dev-1", id: "e1" }).success, false)
  assert.equal(shellExecFrameSchema.parse({ type: "shell_exec", id: "e1", data: "ok\n", done: true }).done, true)
})

test("delete device commands requires ids or all", () => {
  assert.equal(deleteDeviceCommandsSchema.safeParse({}).success, false)
  assert.equal(deleteDeviceCommandsSchema.safeParse({ ids: [] }).success, false)
  assert.equal(deleteDeviceCommandsSchema.parse({ all: true }).all, true)
  assert.deepEqual(deleteDeviceCommandsSchema.parse({ ids: ["c1"], includeActive: true }).ids, ["c1"])
  assert.equal(isCommandTerminal("success"), true)
  assert.equal(isCommandTerminal("pending"), false)
  assert.equal(isCommandActive("running"), true)
})

test("stamp yaml includes sandbox roots and heartbeats", () => {
  const input = stampPackSchema.parse({
    platform: "linux",
    arch: "amd64",
    serverUrl: "https://example.com",
    enrollmentSecret: "secret-value",
    sandboxRoots: ["/opt/data"],
    autoRestartTime: "03:30",
    idleHeartbeatSec: 120,
    watchedHeartbeatSec: 10,
    includeHelper: true,
  })
  const yaml = stampConfigYaml(input)
  assert.match(yaml, /sandbox_roots:/)
  assert.match(yaml, /\/opt\/data/)
  assert.match(yaml, /auto_restart_time: "03:30"/)
  assert.match(yaml, /idle_heartbeat_sec: 120/)
  assert.match(yaml, /watched_heartbeat_sec: 10/)
  assert.equal(input.includeHelper, true)
})

test("MAX_UPLOAD_BYTES default is 512 MiB", () => {
  assert.equal(MAX_UPLOAD_BYTES, 512 * 1024 * 1024)
})

test("agentConfigSchema requires a positive maxUploadBytes", () => {
  const parsed = agentConfigSchema.parse({
    heartbeatIntervalSec: 90,
    pollIntervalSec: 15,
    screenshotIntervalSec: 0,
    autoRestartTime: "",
    sandboxRoots: [],
    lightweight: true,
    idleHeartbeatSec: 90,
    watchedHeartbeatSec: 15,
    maxUploadBytes: MAX_UPLOAD_BYTES,
  })
  assert.equal(parsed.maxUploadBytes, MAX_UPLOAD_BYTES)
  assert.equal(
    agentConfigSchema.safeParse({
      heartbeatIntervalSec: 90,
      pollIntervalSec: 15,
      screenshotIntervalSec: 0,
      autoRestartTime: "",
      sandboxRoots: [],
      lightweight: true,
      idleHeartbeatSec: 90,
      watchedHeartbeatSec: 15,
    }).success,
    false
  )
})

test("webrtc offer accepts jpeg/h264 codec and audio flag", () => {
  const jpeg = webrtcSignalPayloadSchema.parse({ kind: "offer", codec: "jpeg", audio: false })
  assert.equal(jpeg.codec, "jpeg")
  assert.equal(jpeg.audio, false)
  const h264 = webrtcSignalPayloadSchema.parse({ kind: "offer", codec: "h264", audio: true })
  assert.equal(h264.codec, "h264")
  assert.equal(h264.audio, true)
  assert.equal(webrtcSignalPayloadSchema.safeParse({ kind: "offer", codec: "vp8" }).success, false)
  const hangup = webrtcSignalPayloadSchema.parse({
    kind: "hangup",
    reason: "no_interactive_session",
    error: "no_interactive_session",
  })
  assert.equal(hangup.reason, "no_interactive_session")
  assert.equal(hangup.error, "no_interactive_session")
  const disabled = webrtcSignalPayloadSchema.parse({
    kind: "hangup",
    error: WEBRTC_ERROR.disabled,
    reason: WEBRTC_ERROR.disabled,
  })
  assert.equal(disabled.error, "webrtc_disabled")
  const offline = webrtcSignalPayloadSchema.parse({
    kind: "hangup",
    error: WEBRTC_ERROR.agentOffline,
    reason: WEBRTC_ERROR.agentOffline,
  })
  assert.equal(offline.reason, "agent_offline")
  const timeout = webrtcSignalPayloadSchema.parse({
    kind: "hangup",
    error: WEBRTC_ERROR.connectTimeout,
    reason: WEBRTC_ERROR.noFrame,
  })
  assert.equal(timeout.error, "connect_timeout")
  assert.equal(timeout.reason, "no_frame")
})

test("h264 fallback labels distinguish missing MFT vs blocked IMFTransform", () => {
  assert.match(h264FallbackLabel("mf_class_missing"), /Media Feature Pack/)
  assert.match(h264FallbackLabel("mf_transform_unavailable"), /IMFTransform/)
  assert.equal(h264FallbackLabel("mf_transform_unavailable").includes("Windows N"), false)
  assert.match(h264FallbackLabel("0xc00d36b4"), /0xc00d36b4/)
})

test("clipboard payload accepts text html image and file paths", () => {
  const text = clipboardPayloadSchema.parse({ type: "clip", kind: "text", text: "hello", at: 1 })
  assert.equal(text.kind, "text")
  const html = clipboardPayloadSchema.parse({
    type: "clip",
    kind: "html",
    html: "<b>x</b>",
    text: "x",
    at: 2,
  })
  assert.equal(html.html, "<b>x</b>")
  const files = clipboardPayloadSchema.parse({
    type: "clip",
    kind: "files",
    files: ["C:\\\\Temp\\\\a.txt"],
    at: 3,
  })
  assert.equal(files.files?.length, 1)
  const image = clipboardPayloadSchema.parse({
    type: "clip",
    kind: "image",
    image: { mime: "image/png", data: "aaaa", width: 1, height: 1 },
    at: 4,
  })
  assert.equal(image.image?.mime, "image/png")
  assert.equal(clipboardPayloadSchema.safeParse({ type: "clip", kind: "other", at: 0 }).success, false)
})

test("createCommandSchema caps deviceIds at 500 and allows star", () => {
  assert.equal(MAX_CREATE_COMMAND_DEVICES, 500)
  assert.equal(createCommandSchema.safeParse({ deviceIds: ["*"], type: "restart" }).success, true)
  assert.equal(
    createCommandSchema.safeParse({ deviceIds: Array.from({ length: 500 }, (_, i) => `d${i}`), type: "restart" })
      .success,
    true
  )
  assert.equal(
    createCommandSchema.safeParse({ deviceIds: Array.from({ length: 501 }, (_, i) => `d${i}`), type: "restart" })
      .success,
    false
  )
})

test("extrasWithinCap and heartbeat extras cap", () => {
  assert.equal(extrasWithinCap(undefined), true)
  assert.equal(extrasWithinCap({ ok: true }), true)
  const huge = { blob: "x".repeat(HEARTBEAT_EXTRAS_MAX_BYTES) }
  assert.equal(extrasWithinCap(huge), false)
  assert.equal(heartbeatSchema.safeParse({ extras: huge }).success, false)
  assert.equal(heartbeatSchema.safeParse({ extras: { ok: true } }).success, true)
})

test("capCommandResult replaces oversized payloads", () => {
  assert.deepEqual(capCommandResult({ ok: true }), { ok: true })
  const huge = { blob: "y".repeat(COMMAND_RESULT_MAX_BYTES) }
  assert.deepEqual(capCommandResult(huge), { error: "result_too_large" })
})

