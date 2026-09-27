import type { CommandType } from "./commands.ts"

export const COMMAND_TEMPLATE_CATEGORIES = ["host", "watch", "files", "script", "apps", "windows"] as const

export type CommandTemplateCategory = (typeof COMMAND_TEMPLATE_CATEGORIES)[number]

export const COMMAND_TEMPLATE_CATEGORY_LABELS: Record<CommandTemplateCategory, string> = {
  host: "Host",
  watch: "Watch",
  files: "Files",
  script: "Scripts",
  apps: "Apps",
  windows: "Windows",
}

export type BuiltinCommandTemplate = {
  id: string
  name: string
  description: string
  type: CommandType
  payload: Record<string, unknown>
  builtin: true
  /** Gallery group used by the command composer. */
  category: CommandTemplateCategory
}

/** Operator gallery. Payloads pass `validateCommandPayload` for the given type. */
export const COMMAND_TEMPLATES: readonly BuiltinCommandTemplate[] = [
  {
    id: "builtin:restart",
    name: "Restart host",
    description: "Schedule an OS restart on the device.",
    type: "restart",
    payload: {},
    builtin: true,
    category: "host",
  },
  {
    id: "builtin:shutdown",
    name: "Shut down host",
    description: "Schedule an OS shutdown on the device.",
    type: "shutdown",
    payload: {},
    builtin: true,
    category: "host",
  },
  {
    id: "builtin:get_processes",
    name: "List processes",
    description: "Return the current top-process snapshot.",
    type: "get_processes",
    payload: {},
    builtin: true,
    category: "host",
  },
  {
    id: "builtin:capture_screenshot",
    name: "Capture screenshot",
    description: "Take a still JPEG and upload it to the fleet.",
    type: "capture_screenshot",
    payload: {},
    builtin: true,
    category: "watch",
  },
  {
    id: "builtin:start_watch",
    name: "Start watch",
    description: "Raise heartbeat rate and enable watch stills for one hour.",
    type: "start_watch",
    payload: { durationMin: 60 },
    builtin: true,
    category: "watch",
  },
  {
    id: "builtin:stop_watch",
    name: "Stop watch",
    description: "Return the device to idle heartbeat and stop watch stills.",
    type: "stop_watch",
    payload: {},
    builtin: true,
    category: "watch",
  },
  {
    id: "builtin:list_home",
    name: "List home folder",
    description: "List the sandboxed home directory.",
    type: "get_files",
    payload: {},
    builtin: true,
    category: "files",
  },
  {
    id: "builtin:search_by_name",
    name: "Search by name",
    description: "Search the current folder for a filename fragment. Edit path and name before queueing.",
    type: "search_files",
    payload: { path: ".", name: "readme" },
    builtin: true,
    category: "files",
  },
  {
    id: "builtin:print_env_unix",
    name: "Print environment (Unix)",
    description: "Run printenv on Linux or macOS.",
    type: "run_script",
    payload: { script: "printenv" },
    builtin: true,
    category: "script",
  },
  {
    id: "builtin:print_env_windows",
    name: "Print environment (Windows)",
    description: "Dump process environment variables via PowerShell.",
    type: "run_script",
    payload: { script: "Get-ChildItem Env: | Format-Table -AutoSize | Out-String" },
    builtin: true,
    category: "script",
  },
  {
    id: "builtin:install_app",
    name: "Install app",
    description: "Install a package with winget, apt-get, or dnf. Replace the name first.",
    type: "install_app",
    payload: { name: "git" },
    builtin: true,
    category: "apps",
  },
  {
    id: "builtin:uninstall_app",
    name: "Uninstall app",
    description: "Remove a package. Replace the name first.",
    type: "uninstall_app",
    payload: { name: "git" },
    builtin: true,
    category: "apps",
  },
  {
    id: "builtin:win_ipconfig",
    name: "ipconfig /all",
    description: "Windows adapter, DNS, and DHCP details.",
    type: "run_script",
    payload: { script: "ipconfig /all" },
    builtin: true,
    category: "windows",
  },
  {
    id: "builtin:win_computer_info",
    name: "Computer info",
    description: "Windows Get-ComputerInfo summary.",
    type: "run_script",
    payload: { script: "Get-ComputerInfo | Out-String" },
    builtin: true,
    category: "windows",
  },
  {
    id: "builtin:win_services",
    name: "List services (script)",
    description: "Windows Get-Service table via PowerShell. Prefer the device Services section for start/stop/restart.",
    type: "run_script",
    payload: { script: "Get-Service | Format-Table -AutoSize | Out-String" },
    builtin: true,
    category: "windows",
  },
  {
    id: "builtin:get_services",
    name: "List services (SCM)",
    description: "Enumerate Win32 services through the Service Control Manager, including PCManagerAgent and PCManagerHelper.",
    type: "get_services",
    payload: {},
    builtin: true,
    category: "windows",
  },
  {
    id: "builtin:get_registry_agent",
    name: "Open agent registry key",
    description: "Browse HKLM\\SOFTWARE\\PC Manager\\Agent (documented agent config store).",
    type: "get_registry",
    payload: { hive: "HKLM", path: "SOFTWARE\\PC Manager\\Agent" },
    builtin: true,
    category: "windows",
  },
  {
    id: "builtin:get_adapters",
    name: "List adapters",
    description: "Windows IP Helper adapters, addresses, DNS, and DHCP. Prefer the device Network section.",
    type: "get_adapters",
    payload: {},
    builtin: true,
    category: "windows",
  },
  {
    id: "builtin:get_ports",
    name: "List listening ports",
    description: "TCP/UDP tables with owning PID. Port 17891 is the official LAN peer port.",
    type: "get_ports",
    payload: { listenOnly: true },
    builtin: true,
    category: "windows",
  },
  {
    id: "builtin:get_firewall",
    name: "List firewall rules",
    description: "Windows Firewall profiles and rules via INetFwPolicy2. Writes confirm; the firewall is never disabled globally.",
    type: "get_firewall",
    payload: {},
    builtin: true,
    category: "windows",
  },
  {
    id: "builtin:win_event_log",
    name: "Recent System log",
    description: "Newest Windows System events via EvtQuery (not Get-EventLog).",
    type: "get_event_log",
    payload: { log: "System", newest: 50 },
    builtin: true,
    category: "windows",
  },
  {
    id: "builtin:get_windows_update",
    name: "Windows Update status",
    description: "Pending and recently installed updates via WUAPI IUpdateSearcher (read-only).",
    type: "get_windows_update",
    payload: {},
    builtin: true,
    category: "windows",
  },
  {
    id: "builtin:get_admin_center",
    name: "Windows Admin Center",
    description: "Detect ServerManagementGateway (read-only). Does not start the gateway.",
    type: "get_admin_center",
    payload: {},
    builtin: true,
    category: "windows",
  },
  {
    id: "builtin:start_quick_assist",
    name: "Open Quick Assist",
    description: "Start Quick Assist or msra in the signed-in session. Confirms. Does not launch MMC from Session 0.",
    type: "start_quick_assist",
    payload: { app: "quickassist" },
    builtin: true,
    category: "windows",
  },
  {
    id: "builtin:get_tasks",
    name: "List scheduled tasks",
    description: "Enumerate Task Scheduler via ITaskService. Enable/disable confirms. Does not launch taskschd.msc.",
    type: "get_tasks",
    payload: {},
    builtin: true,
    category: "windows",
  },
  {
    id: "builtin:get_defender",
    name: "Defender health",
    description: "Read Microsoft Defender status, preferences, and recent threat history.",
    type: "get_defender",
    payload: {},
    builtin: true,
    category: "windows",
  },
  {
    id: "builtin:get_bitlocker",
    name: "BitLocker volumes",
    description: "Read-only BitLocker protection status via Win32_EncryptableVolume.",
    type: "get_bitlocker",
    payload: {},
    builtin: true,
    category: "windows",
  },
  {
    id: "builtin:get_capabilities",
    name: "Windows capabilities",
    description: "List optional features / RSAT via DISM. Does not install anything.",
    type: "get_capabilities",
    payload: {},
    builtin: true,
    category: "windows",
  },
  {
    id: "builtin:install_capability",
    name: "Install Media Feature Pack",
    description: "DISM Add-Capability for Media.MediaFeaturePack so H.264 live desktop works on Windows N. Confirms. Does not install RSAT or other features.",
    type: "install_capability",
    payload: { name: "Media.MediaFeaturePack~~~~0.0.1.0" },
    builtin: true,
    category: "windows",
  },
  {
    id: "builtin:get_smb",
    name: "SMB shares",
    description: "List hosted and mapped SMB shares on the agent.",
    type: "get_smb",
    payload: {},
    builtin: true,
    category: "windows",
  },
  {
    id: "builtin:get_credentials",
    name: "List credentials",
    description: "List Windows Credential Manager and browser login metadata (no secrets).",
    type: "get_credentials",
    payload: { sources: ["windows", "browser", "apps"] },
    builtin: true,
    category: "windows",
  },
  {
    id: "builtin:backup_credentials",
    name: "Back up credentials",
    description: "Export Windows, app, and browser secrets into the encrypted dashboard vault. Chrome/Edge need a signed-in session.",
    type: "backup_credentials",
    payload: { sources: ["windows", "browser", "apps"] },
    builtin: true,
    category: "windows",
  },
  {
    id: "builtin:win_gpupdate",
    name: "gpupdate /force",
    description: "Force a Group Policy refresh on Windows.",
    type: "run_script",
    payload: { script: "gpupdate /force" },
    builtin: true,
    category: "windows",
  },
  {
    id: "builtin:win_whoami",
    name: "whoami /all",
    description: "Windows user, group, and privilege listing.",
    type: "run_script",
    payload: { script: "whoami /all" },
    builtin: true,
    category: "windows",
  },
  {
    id: "builtin:win_flush_dns",
    name: "Flush DNS",
    description: "Clear the Windows DNS resolver cache (ipconfig /flushdns).",
    type: "run_script",
    payload: { script: "ipconfig /flushdns" },
    builtin: true,
    category: "windows",
  },
]

export type CommandTemplateGroup<T extends { category: CommandTemplateCategory } = BuiltinCommandTemplate> = {
  category: CommandTemplateCategory
  label: string
  templates: T[]
}

/** Stable composer order: host, watch, files, script, apps, windows. Empty groups are omitted. */
export function groupCommandTemplatesByCategory<T extends { category: CommandTemplateCategory }>(
  templates: readonly T[]
): CommandTemplateGroup<T>[] {
  const buckets = new Map<CommandTemplateCategory, T[]>()
  for (const category of COMMAND_TEMPLATE_CATEGORIES) buckets.set(category, [])
  for (const tpl of templates) {
    const list = buckets.get(tpl.category)
    if (list) list.push(tpl)
  }
  return COMMAND_TEMPLATE_CATEGORIES.flatMap((category) => {
    const group = buckets.get(category)
    if (!group?.length) return []
    return [{ category, label: COMMAND_TEMPLATE_CATEGORY_LABELS[category], templates: group }]
  })
}

export function groupedBuiltinCommandTemplates(): CommandTemplateGroup[] {
  return groupCommandTemplatesByCategory(COMMAND_TEMPLATES)
}
