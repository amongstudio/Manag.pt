import { unwrapCommandResult } from "./command-result.ts"

export const NATIVE_WINDOWS_COMMAND_TYPES = [
  "get_event_log",
  "get_windows_update",
  "start_quick_assist",
  "get_admin_center",
  "get_tasks",
  "set_task_enabled",
  "get_defender",
  "set_defender",
  "get_bitlocker",
  "get_capabilities",
] as const

export type NativeWindowsCommandType = (typeof NATIVE_WINDOWS_COMMAND_TYPES)[number]

export const WAC_SERVICE_NAME = "ServerManagementGateway"

export const EVENT_LOG_LEVELS = ["all", "critical", "error", "warning", "information", "verbose"] as const
export type EventLogLevel = (typeof EVENT_LOG_LEVELS)[number]

export type EventLogEntry = {
  time: string
  type: string
  source: string
  id: number
  message?: string
  channel?: string
}

export type ParsedEventLog = {
  log: string
  entries: EventLogEntry[]
  truncated: boolean
}

export type WindowsUpdateItem = {
  title: string
  kb?: string[]
  severity?: string
  isDownloaded?: boolean
  rebootRequired?: boolean
  date?: string
  result?: string
}

export type ParsedWindowsUpdate = {
  pending: WindowsUpdateItem[]
  installed: WindowsUpdateItem[]
  online: boolean
  truncated: boolean
}

export type ParsedAdminCenter = {
  name: string
  installed: boolean
  running: boolean
  startType?: string
  displayName?: string
  port?: number
  url?: string
}

export type ParsedQuickAssist = {
  started: boolean
  app: string
  path?: string
}

export type ScheduledTask = {
  name: string
  path: string
  enabled: boolean
  state?: string
  lastRunTime?: string
  nextRunTime?: string
  lastTaskResult?: string
  missedRuns?: number
  author?: string
}

export type ParsedTaskList = {
  tasks: ScheduledTask[]
  truncated: boolean
}

export type ParsedDefender = {
  available: boolean
  antivirusEnabled: boolean
  antispywareEnabled: boolean
  realtimeProtectionEnabled: boolean
  ioavProtectionEnabled?: boolean
  nisEnabled?: boolean
  amServiceEnabled?: boolean
  onAccessProtectionEnabled?: boolean
  behaviorMonitorEnabled?: boolean
  antivirusSignatureVersion?: string
  antivirusSignatureAge?: number
  antivirusSignatureUpdated?: string
  antispywareSignatureVersion?: string
  nisSignatureVersion?: string
  amEngineVersion?: string
  productVersion?: string
  serviceVersion?: string
  quickScanAge?: number
  fullScanAge?: number
  computerState?: string
  lastQuickScan?: string
  lastFullScan?: string
  lastQuickScanStart?: string
  lastFullScanStart?: string
  tamperProtected?: boolean
  isVirtualMachine?: boolean
  defenderSignaturesOutOfDate?: boolean
  fullScanOverdue?: boolean
  quickScanOverdue?: boolean
  rebootRequired?: boolean
  threatCount?: number
  activeThreatCount?: number
  scanInProgress?: boolean
  scanType?: string
  source?: string
  preferences?: DefenderPreferences
  threats?: DefenderThreat[]
  threatsTruncated?: boolean
}

export type DefenderPreferences = {
  realtimeMonitoring: boolean
  behaviorMonitoring: boolean
  ioavProtection: boolean
  scriptScanning: boolean
  cloudProtection?: string
  cloudBlockLevel?: string
  submitSamples?: string
  puaProtection?: string
  networkProtection?: string
  controlledFolderAccess?: string
  asrRules?: ASRRule[]
  exclusionPaths?: string[]
  exclusionExtensions?: string[]
  exclusionProcesses?: string[]
}

export type ASRRule = {
  id: string
  name?: string
  action?: string
}

export type DefenderThreat = {
  id: string
  instanceId?: string
  name: string
  severity?: string
  status?: string
  resources?: string[]
  detectionTime?: string
  action?: string
  process?: string
  user?: string
}

export type BitLockerKeyProtector = {
  id?: string
  type: string
}

export type BitLockerVolume = {
  mountPoint?: string
  deviceId?: string
  protectionStatus: string
  conversionStatus?: string
  encryptionMethod?: string
  encryptionPercent?: number
  volumeType?: string
  persistentVolumeId?: string
  lockStatus?: string
  autoUnlock?: boolean
  encryptionFlags?: string
  keyProtectors?: BitLockerKeyProtector[]
}

export type ParsedBitLocker = {
  volumes: BitLockerVolume[]
  available: boolean
  truncated: boolean
  reason?: string
}

export type WindowsCapability = {
  name: string
  state: string
  kind?: string
}

export type ParsedCapabilities = {
  capabilities: WindowsCapability[]
  truncated: boolean
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function asBool(value: unknown): boolean {
  return value === true
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function parseEventLog(result: unknown): ParsedEventLog {
  const rec = asRecord(unwrapCommandResult(result))
  const entries: EventLogEntry[] = []
  const raw = rec && Array.isArray(rec.entries) ? rec.entries : []
  for (const item of raw) {
    const row = asRecord(item)
    if (!row) continue
    const id = asNumber(row.id)
    const source = asString(row.source)
    if (id == null || !source) continue
    entries.push({
      time: asString(row.time),
      type: asString(row.type) || "LogAlways",
      source,
      id,
      message: asString(row.message) || undefined,
      channel: asString(row.channel) || undefined,
    })
  }
  return {
    log: asString(rec?.log) || "System",
    entries,
    truncated: asBool(rec?.truncated),
  }
}

function parseUpdateItem(value: unknown): WindowsUpdateItem | null {
  const row = asRecord(value)
  if (!row) return null
  const title = asString(row.title)
  if (!title) return null
  const kb = Array.isArray(row.kb) ? row.kb.filter((item): item is string => typeof item === "string" && item.length > 0) : []
  return {
    title,
    kb: kb.length ? kb : undefined,
    severity: asString(row.severity) || undefined,
    isDownloaded: asBool(row.isDownloaded),
    rebootRequired: asBool(row.rebootRequired),
    date: asString(row.date) || undefined,
    result: asString(row.result) || undefined,
  }
}

export function parseWindowsUpdate(result: unknown): ParsedWindowsUpdate {
  const rec = asRecord(unwrapCommandResult(result))
  const pending = rec && Array.isArray(rec.pending) ? rec.pending.map(parseUpdateItem).filter((v): v is WindowsUpdateItem => v != null) : []
  const installed =
    rec && Array.isArray(rec.installed) ? rec.installed.map(parseUpdateItem).filter((v): v is WindowsUpdateItem => v != null) : []
  return {
    pending,
    installed,
    online: asBool(rec?.online),
    truncated: asBool(rec?.truncated),
  }
}

export function parseAdminCenter(result: unknown): ParsedAdminCenter | null {
  const rec = asRecord(unwrapCommandResult(result))
  if (!rec) return null
  const name = asString(rec.name) || WAC_SERVICE_NAME
  return {
    name,
    installed: asBool(rec.installed),
    running: asBool(rec.running),
    startType: asString(rec.startType) || undefined,
    displayName: asString(rec.displayName) || undefined,
    port: asNumber(rec.port),
    url: asString(rec.url) || undefined,
  }
}

export function parseQuickAssist(result: unknown): ParsedQuickAssist | null {
  const rec = asRecord(result)
  if (!rec) return null
  return {
    started: asBool(rec.started),
    app: asString(rec.app) || "quickassist",
    path: asString(rec.path) || undefined,
  }
}

export function parseTaskList(result: unknown): ParsedTaskList {
  const rec = asRecord(unwrapCommandResult(result))
  const tasks: ScheduledTask[] = []
  const raw = rec && Array.isArray(rec.tasks) ? rec.tasks : []
  for (const item of raw) {
    const row = asRecord(item)
    if (!row) continue
    const name = asString(row.name)
    const path = asString(row.path)
    if (!name && !path) continue
    tasks.push({
      name: name || path,
      path: path || name,
      enabled: asBool(row.enabled),
      state: asString(row.state) || undefined,
      lastRunTime: asString(row.lastRunTime) || undefined,
      nextRunTime: asString(row.nextRunTime) || undefined,
      lastTaskResult: asString(row.lastTaskResult) || undefined,
      missedRuns: asNumber(row.missedRuns),
      author: asString(row.author) || undefined,
    })
  }
  return { tasks, truncated: asBool(rec?.truncated) }
}

export function parseDefender(result: unknown): ParsedDefender | null {
  const rec = asRecord(unwrapCommandResult(result))
  if (!rec) return null
  if (typeof rec.error === "string" && rec.error.trim() && !defenderHasStatus(rec)) return null
  if (!defenderHasStatus(rec)) return null
  const pref = asRecord(rec.preferences)
  const threats: DefenderThreat[] = []
  if (Array.isArray(rec.threats)) {
    for (const item of rec.threats) {
      const row = asRecord(item)
      if (!row) continue
      const name = asString(row.name)
      const id = asString(row.id) || name
      if (!id && !name) continue
      threats.push({
        id: id || name,
        instanceId: asString(row.instanceId) || undefined,
        name: name || id,
        severity: asString(row.severity) || undefined,
        status: asString(row.status) || undefined,
        resources: Array.isArray(row.resources)
          ? row.resources.filter((v): v is string => typeof v === "string" && v.length > 0)
          : undefined,
        detectionTime: asString(row.detectionTime) || undefined,
        action: asString(row.action) || undefined,
        process: asString(row.process) || undefined,
        user: asString(row.user) || undefined,
      })
    }
  }
  return {
    available: rec.available !== false,
    antivirusEnabled: asBool(rec.antivirusEnabled),
    antispywareEnabled: asBool(rec.antispywareEnabled),
    realtimeProtectionEnabled: asBool(rec.realtimeProtectionEnabled),
    ioavProtectionEnabled: asBool(rec.ioavProtectionEnabled),
    nisEnabled: asBool(rec.nisEnabled),
    amServiceEnabled: asBool(rec.amServiceEnabled),
    onAccessProtectionEnabled: asBool(rec.onAccessProtectionEnabled),
    behaviorMonitorEnabled: asBool(rec.behaviorMonitorEnabled),
    antivirusSignatureVersion: asString(rec.antivirusSignatureVersion) || undefined,
    antivirusSignatureAge: asNumber(rec.antivirusSignatureAge),
    antivirusSignatureUpdated: asString(rec.antivirusSignatureUpdated) || undefined,
    antispywareSignatureVersion: asString(rec.antispywareSignatureVersion) || undefined,
    nisSignatureVersion: asString(rec.nisSignatureVersion) || undefined,
    amEngineVersion: asString(rec.amEngineVersion) || undefined,
    productVersion: asString(rec.productVersion) || undefined,
    serviceVersion: asString(rec.serviceVersion) || undefined,
    quickScanAge: asNumber(rec.quickScanAge),
    fullScanAge: asNumber(rec.fullScanAge),
    computerState: asString(rec.computerState) || undefined,
    lastQuickScan: asString(rec.lastQuickScan) || undefined,
    lastFullScan: asString(rec.lastFullScan) || undefined,
    lastQuickScanStart: asString(rec.lastQuickScanStart) || undefined,
    lastFullScanStart: asString(rec.lastFullScanStart) || undefined,
    tamperProtected: asBool(rec.tamperProtected),
    isVirtualMachine: asBool(rec.isVirtualMachine),
    defenderSignaturesOutOfDate: asBool(rec.defenderSignaturesOutOfDate),
    fullScanOverdue: asBool(rec.fullScanOverdue),
    quickScanOverdue: asBool(rec.quickScanOverdue),
    rebootRequired: asBool(rec.rebootRequired),
    threatCount: asNumber(rec.threatCount),
    activeThreatCount: asNumber(rec.activeThreatCount),
    scanInProgress: asBool(rec.scanInProgress),
    scanType: asString(rec.scanType) || undefined,
    source: asString(rec.source) || undefined,
    preferences: pref
      ? {
          realtimeMonitoring: asBool(pref.realtimeMonitoring),
          behaviorMonitoring: asBool(pref.behaviorMonitoring),
          ioavProtection: asBool(pref.ioavProtection),
          scriptScanning: asBool(pref.scriptScanning),
          cloudProtection: asString(pref.cloudProtection) || undefined,
          cloudBlockLevel: asString(pref.cloudBlockLevel) || undefined,
          submitSamples: asString(pref.submitSamples) || undefined,
          puaProtection: asString(pref.puaProtection) || undefined,
          networkProtection: asString(pref.networkProtection) || undefined,
          controlledFolderAccess: asString(pref.controlledFolderAccess) || undefined,
          asrRules: Array.isArray(pref.asrRules)
            ? pref.asrRules.flatMap((item) => {
                const row = asRecord(item)
                if (!row) return []
                const id = asString(row.id)
                if (!id) return []
                const rule: ASRRule = {
                  id,
                  name: asString(row.name) || undefined,
                  action: asString(row.action) || undefined,
                }
                return [rule]
              })
            : undefined,
          exclusionPaths: Array.isArray(pref.exclusionPaths)
            ? pref.exclusionPaths.filter((v): v is string => typeof v === "string")
            : undefined,
          exclusionExtensions: Array.isArray(pref.exclusionExtensions)
            ? pref.exclusionExtensions.filter((v): v is string => typeof v === "string")
            : undefined,
          exclusionProcesses: Array.isArray(pref.exclusionProcesses)
            ? pref.exclusionProcesses.filter((v): v is string => typeof v === "string")
            : undefined,
        }
      : undefined,
    threats: threats.length ? threats : undefined,
    threatsTruncated: asBool(rec.threatsTruncated),
  }
}

function defenderHasStatus(rec: Record<string, unknown>): boolean {
  if (typeof rec.source === "string" && rec.source) return true
  if (rec.available === true || rec.available === false) return true
  if ("antivirusEnabled" in rec || "realtimeProtectionEnabled" in rec || "antispywareEnabled" in rec) return true
  if (rec.preferences && typeof rec.preferences === "object") return true
  if (typeof rec.amEngineVersion === "string" && rec.amEngineVersion) return true
  return false
}

export function parseBitLocker(result: unknown): ParsedBitLocker {
  const rec = asRecord(unwrapCommandResult(result))
  if (!rec) return { volumes: [], available: false, truncated: false, reason: "unavailable" }
  const err = asString(rec.error)
  const raw = Array.isArray(rec.volumes) ? rec.volumes : Array.isArray(rec.Volumes) ? rec.Volumes : Array.isArray(rec.items) ? rec.items : null
  const availableFlag =
    rec.available === true || rec.Available === true ? true : rec.available === false || rec.Available === false ? false : undefined
  if (raw == null && availableFlag !== true) {
    return {
      volumes: [],
      available: false,
      truncated: false,
      reason: asString(rec.reason) || asString(rec.Reason) || err || "unavailable",
    }
  }
  const volumes: BitLockerVolume[] = []
  for (const item of raw ?? []) {
    const row = asRecord(item)
    if (!row) continue
    const protection = asString(row.protectionStatus) || asString(row.ProtectionStatus) || protectionFromNumber(row.protectionStatus ?? row.ProtectionStatus)
    const protectors = parseKeyProtectors(row.keyProtectors ?? row.KeyProtector ?? row.KeyProtectors)
    const autoUnlock = row.autoUnlock
    volumes.push({
      mountPoint: asString(row.mountPoint) || asString(row.MountPoint) || undefined,
      deviceId: asString(row.deviceId) || asString(row.DeviceID) || asString(row.DeviceId) || undefined,
      protectionStatus: protection || "unknown",
      conversionStatus: asString(row.conversionStatus) || asString(row.ConversionStatus) || asString(row.VolumeStatus) || undefined,
      encryptionMethod: asString(row.encryptionMethod) || asString(row.EncryptionMethod) || undefined,
      encryptionPercent: asNumber(row.encryptionPercent) ?? asNumber(row.EncryptionPercent) ?? asNumber(row.EncryptionPercentage),
      volumeType: asString(row.volumeType) || asString(row.VolumeType) || undefined,
      persistentVolumeId: asString(row.persistentVolumeId) || asString(row.PersistentVolumeID) || undefined,
      lockStatus: asString(row.lockStatus) || asString(row.LockStatus) || (row.lockStatus === 1 || row.LockStatus === 1 ? "locked" : row.lockStatus === 0 || row.LockStatus === 0 ? "unlocked" : undefined),
      autoUnlock: typeof autoUnlock === "boolean" ? autoUnlock : typeof row.AutoUnlockEnabled === "boolean" ? (row.AutoUnlockEnabled as boolean) : undefined,
      encryptionFlags: asString(row.encryptionFlags) || asString(row.EncryptionFlags) || undefined,
      keyProtectors: protectors.length ? protectors : undefined,
    })
  }
  const reason = asString(rec.reason) || asString(rec.Reason) || (err && !volumes.length ? err : "") || undefined
  return {
    volumes,
    available: availableFlag !== undefined ? availableFlag : !err,
    truncated: asBool(rec.truncated) || asBool(rec.Truncated),
    reason,
  }
}

function parseKeyProtectors(value: unknown): BitLockerKeyProtector[] {
  if (!Array.isArray(value)) return []
  const out: BitLockerKeyProtector[] = []
  for (const item of value) {
    if (typeof item === "string" && item.trim()) {
      out.push({ type: item.trim().toLowerCase().replace(/\s+/g, "_") })
      continue
    }
    const row = asRecord(item)
    if (!row) continue
    const type = asString(row.type) || asString(row.KeyProtectorType) || asString(row.Type)
    if (!type) continue
    out.push({
      id: asString(row.id) || asString(row.KeyProtectorId) || undefined,
      type: type.toLowerCase().replace(/\s+/g, "_"),
    })
  }
  return out
}

function protectionFromNumber(value: unknown): string {
  if (value === 0) return "off"
  if (value === 1) return "on"
  return ""
}

export function parseCapabilities(result: unknown): ParsedCapabilities {
  const rec = asRecord(unwrapCommandResult(result))
  const capabilities: WindowsCapability[] = []
  const raw =
    rec && Array.isArray(rec.capabilities)
      ? rec.capabilities
      : rec && Array.isArray(rec.Capabilities)
        ? rec.Capabilities
        : rec && Array.isArray(rec.items)
          ? rec.items
          : []
  for (const item of raw) {
    const row = asRecord(item)
    if (!row) continue
    const name = asString(row.name) || asString(row.Name)
    if (!name) continue
    capabilities.push({
      name,
      state: asString(row.state) || asString(row.State) || "unknown",
      kind: asString(row.kind) || asString(row.Kind) || (isMediaFeaturePack(name) ? "media" : undefined),
    })
  }
  return { capabilities, truncated: asBool(rec?.truncated) || asBool(rec?.Truncated) }
}

export function taskEnabledConfirm(path: string, enabled: boolean): string {
  const action = enabled ? "Enable" : "Disable"
  return `${action} scheduled task ${path}? This uses ITaskService only and does not launch Task Scheduler MMC.`
}

export function latestSuccessfulNative(
  commands: Array<{ type: string; status: string }>,
  type: NativeWindowsCommandType
) {
  return commands.find((c) => c.type === type && c.status === "success")
}

export function quickAssistConfirm(app?: string): string {
  const name = app === "msra" ? "Remote Assistance (msra)" : "Quick Assist"
  return `Open ${name} on the signed-in desktop? This is a second remote-control path. It will not launch MMC from Session 0.`
}

export function eventLogLevelLabel(level: string): string {
  switch (level.toLowerCase()) {
    case "critical":
      return "Critical"
    case "error":
      return "Error"
    case "warning":
      return "Warning"
    case "information":
      return "Information"
    case "verbose":
      return "Verbose"
    default:
      return level || "LogAlways"
  }
}

export const MEDIA_FEATURE_PACK = "Media.MediaFeaturePack~~~~0.0.1.0"

export function isMediaFeaturePack(name: string): boolean {
  return name.trim().toLowerCase().startsWith("media.mediafeaturepack")
}

export function mediaFeaturePackConfirm(): string {
  return "Install the Windows Media Feature Pack on this device? This uses DISM Add-Capability (Media.MediaFeaturePack) so H.264 remote desktop can work on Windows N. A reboot may be required. Other capabilities are not installed."
}

export function defenderSettingConfirm(summary: string): string {
  return `Apply Microsoft Defender setting: ${summary}? This uses Set-MpPreference on the agent. It does not disable antivirus globally.`
}

export function defenderScanConfirm(type: string): string {
  return `Start a ${type} Microsoft Defender scan on this device? Offline scans reboot into Windows Defender Offline.`
}

export function defenderActionConfirm(action: string, name: string): string {
  const verb =
    action === "restore"
      ? "Restore"
      : action === "allow"
        ? "Allow"
        : action === "quarantine"
          ? "Quarantine"
          : "Remove / remediate"
  return `${verb} Defender threat ${name}? This uses Restore-MpThreat or Remove-MpThreat.`
}

export function defenderCancelScanConfirm(): string {
  return "Cancel the Microsoft Defender scan in progress on this device? This uses Stop-MpScan."
}

/** Map agent Defender write errors to operator-facing text. */
export function defenderCommandErrorMessage(raw: string): string {
  const msg = raw.trim()
  if (!msg) return "Defender command failed"
  if (msg.includes("defender_no_interactive_session") || msg.includes("no_interactive_session")) {
    return "No signed-in user session on this device. Defender actions need an interactive desktop (agent service runs in Session 0)."
  }
  if (msg.includes("tamper_protection_blocks_preference") || msg.toLowerCase().includes("tamper protection")) {
    return "Tamper Protection blocked this change. Turn it off in Windows Security → Virus & threat protection → Manage settings, then retry."
  }
  if (msg === "defender_access_denied" || msg.includes("access denied")) {
    return "Access denied running Defender on this device. The agent may need elevation or Tamper Protection may be on."
  }
  if (msg === "defender_set_failed") {
    return "Defender did not confirm the setting change (no ok from PowerShell). Check agent logs or retry with Tamper Protection off."
  }
  if (msg.startsWith("defender_failed:")) {
    return msg.slice("defender_failed:".length).trim() || "Defender command failed"
  }
  return msg
}

export function bitLockerActionConfirm(action: string, mount: string): string {
  const vol = mount || "this volume"
  switch (action) {
    case "protect":
      return `Turn BitLocker on for ${vol}? A recovery password protector is added and stored encrypted in the dashboard vault. This can take a long time.`
    case "unprotect":
      return `Turn BitLocker off for ${vol}? The volume will decrypt. This can take a long time and is destructive.`
    case "lock":
      return `Lock ${vol}? Open files on that volume will become inaccessible until it is unlocked.`
    case "unlock":
      return `Unlock ${vol} with the password or recovery password you entered? The secret is AES-256-GCM in transit and stripped from command history.`
    case "suspend":
      return `Suspend BitLocker protection on ${vol}? Encryption stays; protectors are temporarily disabled (for example for firmware updates).`
    case "resume":
      return `Resume BitLocker protection on ${vol}?`
    case "add_protector":
      return `Add a key protector on ${vol}? TPM/password/recovery only — PIN is not written from this dashboard.`
    case "remove_protector":
      return `Remove the selected key protector from ${vol}? Leaving a volume with no protectors can make it unrecoverable.`
    case "backup_key":
      return `Read the BitLocker recovery password for ${vol} and store it encrypted in the dashboard credential vault (AES-256-GCM)? It is stripped from command history.`
    default:
      return `Apply BitLocker action ${action} on ${vol}?`
  }
}
