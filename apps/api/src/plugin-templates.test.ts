import assert from "node:assert/strict"
import { test } from "node:test"

import { listPluginStarters, readPluginStarterSource } from "./plugin-templates.ts"

const WINDOWS_IDS = ["installed_programs", "win_services", "system_event_log", "disk_volumes"]

test("plugin starters ship python and go sources", () => {
  const list = listPluginStarters()
  assert.equal(list.length, 7)
  for (const starter of list) {
    const py = readPluginStarterSource(starter, "python")
    const go = readPluginStarterSource(starter, "go_source")
    assert.ok(py && py.source.length > 20, `${starter.id} python`)
    assert.ok(go && go.source.length > 20, `${starter.id} go`)
    assert.equal(starter.networkAllowed, false)
  }
  const ids = new Set(list.map((s) => s.id))
  for (const id of WINDOWS_IDS) {
    assert.ok(ids.has(id), id)
    const starter = list.find((s) => s.id === id)!
    assert.equal(starter.suggestedPlatform, "windows")
    assert.equal(starter.networkAllowed, false)
  }
  const eventLog = list.find((s) => s.id === "system_event_log")!
  assert.match(eventLog.description, /get_event_log/)
  const pySrc = readPluginStarterSource(eventLog, "python")!.source.toString("utf8")
  const goSrc = readPluginStarterSource(eventLog, "go_source")!.source.toString("utf8")
  assert.match(pySrc, /Get-WinEvent/)
  assert.match(goSrc, /Get-WinEvent/)
})
