import assert from "node:assert/strict"
import { test } from "node:test"

import { COMMAND_TIMEOUT_GRACE_MS } from "@workspace/shared"

import {
  isDestructiveCommand,
  pendingDestructiveExpired,
  pluginIdFromPayload,
  runningCommandTimeoutMs,
  deviceHasPluginGrant,
  planUploadInit,
} from "./command-policy.ts"

test("running timeout uses the larger of commandTimeoutMin and plugin timeoutSec plus grace", () => {
  assert.equal(runningCommandTimeoutMs(15), 15 * 60_000 + COMMAND_TIMEOUT_GRACE_MS)
  assert.equal(runningCommandTimeoutMs(5, 60), 5 * 60_000 + COMMAND_TIMEOUT_GRACE_MS)
  assert.equal(runningCommandTimeoutMs(5, 900), 900_000 + COMMAND_TIMEOUT_GRACE_MS)
  assert.equal(runningCommandTimeoutMs(15, 900), 15 * 60_000 + COMMAND_TIMEOUT_GRACE_MS)
})

test("pending destructive TTL uses commandTimeoutMin", () => {
  const created = new Date("2026-01-01T00:00:00.000Z")
  assert.equal(pendingDestructiveExpired(created, new Date("2026-01-01T00:14:59.000Z"), 15), false)
  assert.equal(pendingDestructiveExpired(created, new Date("2026-01-01T00:15:00.000Z"), 15), true)
  assert.equal(isDestructiveCommand("kill_switch"), true)
  assert.equal(isDestructiveCommand("get_files"), false)
  assert.equal(isDestructiveCommand("start_service"), true)
  assert.equal(isDestructiveCommand("set_registry"), true)
  assert.equal(isDestructiveCommand("get_services"), false)
  assert.equal(isDestructiveCommand("set_firewall_rule"), true)
  assert.equal(isDestructiveCommand("delete_firewall_rule"), true)
  assert.equal(isDestructiveCommand("get_adapters"), false)
  assert.equal(isDestructiveCommand("get_ports"), false)
  assert.equal(isDestructiveCommand("get_firewall"), false)
  assert.equal(isDestructiveCommand("get_event_log"), false)
  assert.equal(isDestructiveCommand("get_windows_update"), false)
  assert.equal(isDestructiveCommand("get_admin_center"), false)
  assert.equal(isDestructiveCommand("get_tasks"), false)
  assert.equal(isDestructiveCommand("get_defender"), false)
  assert.equal(isDestructiveCommand("get_bitlocker"), false)
  assert.equal(isDestructiveCommand("get_capabilities"), false)
  assert.equal(isDestructiveCommand("set_task_enabled"), true)
  assert.equal(isDestructiveCommand("start_quick_assist"), true)
  assert.equal(isDestructiveCommand("set_defender"), true)
  assert.equal(isDestructiveCommand("install_capability"), true)
  assert.equal(isDestructiveCommand("smb_connect"), true)
  assert.equal(isDestructiveCommand("smb_disconnect"), true)
  assert.equal(isDestructiveCommand("get_smb"), false)
  assert.equal(isDestructiveCommand("backup_credentials"), true)
  assert.equal(isDestructiveCommand("restore_credentials"), true)
  assert.equal(isDestructiveCommand("set_bitlocker"), true)
  assert.equal(isDestructiveCommand("cancel_defender_scan"), true)
  assert.equal(isDestructiveCommand("defender_action"), true)
})

test("pluginIdFromPayload reads pluginId and ignores bad JSON", () => {
  assert.equal(pluginIdFromPayload('{"pluginId":"plug-1","args":[]}'), "plug-1")
  assert.equal(pluginIdFromPayload("{"), null)
  assert.equal(pluginIdFromPayload("{}"), null)
})

test("allDevices grant allows any device without a Device FK row", () => {
  assert.equal(deviceHasPluginGrant({ allDevices: true, grants: [] }, "dev-1"), true)
  assert.equal(deviceHasPluginGrant({ allDevices: true, grants: [{ deviceId: "other" }] }, "dev-1"), true)
})

test("concrete grants allow only listed devices", () => {
  const plugin = { allDevices: false, grants: [{ deviceId: "dev-1" }, { deviceId: "dev-2" }] }
  assert.equal(deviceHasPluginGrant(plugin, "dev-1"), true)
  assert.equal(deviceHasPluginGrant(plugin, "dev-3"), false)
  assert.equal(deviceHasPluginGrant({ allDevices: false, grants: [] }, "dev-1"), false)
})

test("init upload resumes when size matches and resets on mismatch", () => {
  assert.equal(planUploadInit(100, 100), "resume")
  assert.equal(planUploadInit(100, 200), "reset")
  assert.equal(planUploadInit(0, 1), "reset")
})
