import assert from "node:assert/strict"
import { test } from "node:test"

import {
  WAC_SERVICE_NAME,
  parseAdminCenter,
  parseBitLocker,
  parseCapabilities,
  parseDefender,
  parseEventLog,
  parseTaskList,
  parseWindowsUpdate,
  quickAssistConfirm,
  taskEnabledConfirm,
  isMediaFeaturePack,
  mediaFeaturePackConfirm,
  bitLockerActionConfirm,
  defenderCancelScanConfirm,
  defenderCommandErrorMessage,
} from "./win-native.ts"

test("parseEventLog skips bad rows", () => {
  const parsed = parseEventLog({
    log: "System",
    truncated: true,
    entries: [
      { time: "2026-01-01T00:00:00Z", type: "Error", source: "Service Control Manager", id: 7034, message: "stopped" },
      { source: "x" },
      { id: 1 },
    ],
  })
  assert.equal(parsed.entries.length, 1)
  assert.equal(parsed.truncated, true)
  assert.equal(parsed.log, "System")
  assert.equal(parsed.entries[0]?.id, 7034)
})

test("parseEventLog unwraps nested command result envelopes", () => {
  const nested = parseEventLog({
    result: {
      log: "Application",
      entries: [{ time: "2026-01-01T00:00:00Z", type: "Error", source: "Application", id: 1000 }],
    },
  })
  assert.equal(nested.log, "Application")
  assert.equal(nested.entries.length, 1)
  const wu = parseWindowsUpdate({
    result: { pending: [{ title: "KB1" }], installed: [] },
  })
  assert.equal(wu.pending[0]?.title, "KB1")
})

test("parseWindowsUpdate and admin center", () => {
  const wu = parseWindowsUpdate({
    online: false,
    truncated: false,
    pending: [{ title: "KB5034441", kb: ["5034441"], rebootRequired: true }],
    installed: [{ title: "Security Update", date: "2026-01-01T00:00:00Z", result: "succeeded" }],
  })
  assert.equal(wu.pending[0]?.title, "KB5034441")
  assert.equal(wu.installed.length, 1)
  const wac = parseAdminCenter({
    name: WAC_SERVICE_NAME,
    installed: true,
    running: false,
    port: 6516,
    url: "https://localhost:6516",
  })
  assert.equal(wac?.installed, true)
  assert.equal(wac?.port, 6516)
  assert.match(quickAssistConfirm("msra"), /msra/i)
  assert.match(quickAssistConfirm(), /Quick Assist/)
})

test("parse N2 windows snapshots", () => {
  const tasks = parseTaskList({
    truncated: true,
    tasks: [
      { name: "Defrag", path: "\\Microsoft\\Windows\\Defrag\\ScheduledDefrag", enabled: true, state: "ready" },
      { name: "" },
    ],
  })
  assert.equal(tasks.tasks.length, 1)
  assert.equal(tasks.truncated, true)
  assert.match(taskEnabledConfirm("\\Foo", false), /Disable/)
  const def = parseDefender({
    antivirusEnabled: true,
    realtimeProtectionEnabled: false,
    antispywareEnabled: true,
    threatCount: 2,
    activeThreatCount: 1,
    preferences: {
      realtimeMonitoring: true,
      behaviorMonitoring: true,
      ioavProtection: true,
      scriptScanning: true,
      asrRules: [{ id: "d4f940ab-401b-4efc-aadc-ad5f3c50688a", name: "block_office_child", action: "block" }],
    },
    threats: [{ id: "9", name: "Test", status: "quarantined", process: "foo.exe" }],
  })
  assert.equal(def?.antivirusEnabled, true)
  assert.equal(def?.realtimeProtectionEnabled, false)
  assert.equal(def?.threatCount, 2)
  assert.equal(def?.preferences?.asrRules?.[0]?.action, "block")
  assert.equal(def?.threats?.[0]?.process, "foo.exe")
  const bl = parseBitLocker({
    available: true,
    volumes: [{ mountPoint: "C:", protectionStatus: "on", encryptionPercent: 100 }],
  })
  assert.equal(bl.volumes[0]?.protectionStatus, "on")
  const blPascal = parseBitLocker({
    Available: true,
    Volumes: [{ MountPoint: "D:", ProtectionStatus: 0, EncryptionPercentage: 0 }],
  })
  assert.equal(blPascal.volumes[0]?.mountPoint, "D:")
  assert.equal(blPascal.volumes[0]?.protectionStatus, "off")
  const blHome = parseBitLocker({ available: false, reason: "home_sku_or_no_wmi", volumes: [] })
  assert.equal(blHome.available, false)
  assert.equal(blHome.volumes.length, 0)
  assert.equal(blHome.reason, "home_sku_or_no_wmi")
  const blErr = parseBitLocker({ error: "bitlocker_access_denied" })
  assert.equal(blErr.available, false)
  assert.equal(blErr.reason, "bitlocker_access_denied")
  const blEmpty = parseBitLocker({})
  assert.equal(blEmpty.available, false)
  const blRich = parseBitLocker({
    available: true,
    volumes: [
      {
        mountPoint: "E:",
        protectionStatus: "on",
        lockStatus: 1,
        autoUnlock: false,
        encryptionFlags: "used_space",
        keyProtectors: [{ id: "{abc}", type: "TPM" }, { type: "Numerical Password" }],
      },
    ],
  })
  assert.equal(blRich.volumes[0]?.lockStatus, "locked")
  assert.equal(blRich.volumes[0]?.autoUnlock, false)
  assert.equal(blRich.volumes[0]?.keyProtectors?.length, 2)
  assert.equal(blRich.volumes[0]?.keyProtectors?.[0]?.type, "tpm")
  assert.equal(blRich.volumes[0]?.keyProtectors?.[1]?.type, "numerical_password")
  const defErr = parseDefender({ error: "defender_unavailable" })
  assert.equal(defErr, null)
  const defEmpty = parseDefender({})
  assert.equal(defEmpty, null)
  const defOff = parseDefender({
    available: true,
    antivirusEnabled: false,
    realtimeProtectionEnabled: false,
    antispywareEnabled: false,
    source: "wmi",
  })
  assert.equal(defOff?.available, true)
  assert.equal(defOff?.antivirusEnabled, false)
  const defScan = parseDefender({
    antivirusEnabled: true,
    realtimeProtectionEnabled: true,
    scanInProgress: true,
    scanType: "quick",
    source: "wmi",
  })
  assert.equal(defScan?.scanInProgress, true)
  assert.equal(defScan?.scanType, "quick")
  const caps = parseCapabilities({
    capabilities: [
      { name: "Rsat.ActiveDirectory.DS-LDS.Tools~~~~0.0.1.0", state: "not_present", kind: "rsat" },
      { state: "installed" },
    ],
  })
  assert.equal(caps.capabilities.length, 1)
  assert.equal(caps.capabilities[0]?.kind, "rsat")
  const capsPascal = parseCapabilities({
    Capabilities: [{ Name: "Media.MediaFeaturePack~~~~0.0.1.0", State: "NotPresent" }],
  })
  assert.equal(capsPascal.capabilities[0]?.name, "Media.MediaFeaturePack~~~~0.0.1.0")
  assert.equal(capsPascal.capabilities[0]?.kind, "media")
  assert.equal(isMediaFeaturePack("Media.MediaFeaturePack~~~~0.0.1.0"), true)
  assert.equal(isMediaFeaturePack("Rsat.Foo"), false)
  assert.match(mediaFeaturePackConfirm(), /Media Feature Pack/)
  assert.match(bitLockerActionConfirm("unprotect", "C:"), /Turn BitLocker off/)
  assert.match(defenderCancelScanConfirm(), /Stop-MpScan/)
  assert.match(
    defenderCommandErrorMessage("tamper_protection_blocks_preference"),
    /Tamper Protection blocked/
  )
  assert.match(defenderCommandErrorMessage("defender_no_interactive_session"), /signed-in user session/)
  const dupThreats = parseDefender({
    antivirusEnabled: true,
    realtimeProtectionEnabled: true,
    source: "wmi",
    threats: [
      { id: "311942", instanceId: "a", name: "Test:Malware", detectionTime: "2026-01-01T00:00:00Z" },
      { id: "311942", instanceId: "b", name: "Test:Malware", detectionTime: "2026-01-02T00:00:00Z" },
    ],
  })
  assert.equal(dupThreats?.threats?.length, 2)
  assert.equal(dupThreats?.threats?.[0]?.instanceId, "a")
  assert.notEqual(dupThreats?.threats?.[0]?.instanceId, dupThreats?.threats?.[1]?.instanceId)
})
