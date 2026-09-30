import assert from "node:assert/strict"
import { test } from "node:test"

import { meshCommandAllowed, meshExtraCommandChoices, meshSignalFrameSchema } from "./index.ts"

test("mesh allowlist defaults to files-adjacent get_* only", () => {
  assert.equal(meshCommandAllowed("get_processes", []), true)
  assert.equal(meshCommandAllowed("get_files", []), true)
  assert.equal(meshCommandAllowed("get_services", []), true)
  assert.equal(meshCommandAllowed("get_registry", []), true)
  assert.equal(meshCommandAllowed("get_adapters", []), true)
  assert.equal(meshCommandAllowed("get_ports", []), true)
  assert.equal(meshCommandAllowed("get_firewall", []), true)
  assert.equal(meshCommandAllowed("get_event_log", []), true)
  assert.equal(meshCommandAllowed("get_windows_update", []), true)
  assert.equal(meshCommandAllowed("get_admin_center", []), true)
  assert.equal(meshCommandAllowed("get_tasks", []), true)
  assert.equal(meshCommandAllowed("get_defender", []), true)
  assert.equal(meshCommandAllowed("get_bitlocker", []), true)
  assert.equal(meshCommandAllowed("get_capabilities", []), true)
  assert.equal(meshCommandAllowed("get_smb", []), true)
  assert.equal(meshCommandAllowed("smb_connect", []), false)
  assert.equal(meshCommandAllowed("get_credentials", []), false)
  assert.equal(meshCommandAllowed("get_credentials", ["get_credentials"]), false)
  assert.equal(meshCommandAllowed("set_bitlocker", []), false)
  assert.equal(meshCommandAllowed("set_bitlocker", ["set_bitlocker"]), false)
  assert.equal(meshCommandAllowed("set_task_enabled", []), false)
  assert.equal(meshCommandAllowed("start_quick_assist", []), false)
  assert.equal(meshCommandAllowed("kill_switch", []), false)
  assert.equal(meshCommandAllowed("set_registry", []), false)
  assert.equal(meshCommandAllowed("kill_process", []), false)
})

test("mesh never allows plugin blobs or ticketed peer ops from peers", () => {
  assert.equal(meshCommandAllowed("run_plugin", ["run_plugin"]), false)
  assert.equal(meshCommandAllowed("run_module", ["run_module"]), false)
  assert.equal(meshCommandAllowed("peer_listen", ["peer_listen"]), false)
  assert.equal(meshCommandAllowed("peer_offer", ["peer_offer"]), false)
  assert.equal(meshCommandAllowed("update_agent", ["update_agent"]), false)
  assert.equal(meshCommandAllowed("backup_credentials", ["backup_credentials"]), false)
  assert.equal(meshCommandAllowed("restore_credentials", ["restore_credentials"]), false)
})

test("mesh extras require explicit allowCommands", () => {
  assert.equal(meshCommandAllowed("kill_switch", ["kill_switch"]), true)
  assert.equal(meshCommandAllowed("set_registry", ["set_registry"]), true)
  assert.equal(meshCommandAllowed("smb_connect", ["smb_connect"]), true)
  assert.equal(meshExtraCommandChoices().includes("kill_switch"), true)
  assert.equal(meshExtraCommandChoices().includes("smb_connect"), true)
  assert.equal(meshExtraCommandChoices().includes("get_processes"), false)
  assert.equal(meshExtraCommandChoices().includes("run_plugin"), false)
  assert.equal(meshExtraCommandChoices().includes("run_module"), false)
  assert.equal(meshExtraCommandChoices().includes("get_credentials"), false)
  assert.equal(meshExtraCommandChoices().includes("set_bitlocker"), false)
})

test("mesh_signal frame requires session and dest", () => {
  const ok = meshSignalFrameSchema.safeParse({
    type: "mesh_signal",
    payload: { sessionId: "s1", to: "dev-b", kind: "offer", sdp: "v=0", sdpType: "offer" },
  })
  assert.equal(ok.success, true)
  assert.equal(meshSignalFrameSchema.safeParse({ type: "mesh_signal", payload: { kind: "offer" } }).success, false)
})
