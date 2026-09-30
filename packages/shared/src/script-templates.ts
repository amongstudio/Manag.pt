/**
 * Reviewed, read-only administrative script templates. Content is static; the
 * only variable input is `{{name}}` parameters, each constrained by an anchored
 * pattern with no quotes, spaces, or shell metacharacters so substitution
 * cannot change the script's structure. None of these change system state.
 */
export type ScriptTemplateParameter = {
  name: string
  label: string
  default: string
  pattern: string
  description: string
}

export type ScriptTemplate = {
  id: string
  name: string
  description: string
  category: "inventory" | "updates" | "storage" | "software" | "health"
  language: "powershell"
  platform: "windows"
  timeoutSeconds: number
  destructive: false
  parameters: ScriptTemplateParameter[]
  content: string
}

const WINGET_RESOLVE = String.raw`$winget = (Get-Command winget.exe -ErrorAction SilentlyContinue).Source
if (-not $winget) {
  $winget = Get-ChildItem -Path "$env:ProgramFiles\WindowsApps" -Filter winget.exe -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -like '*Microsoft.DesktopAppInstaller_*' } |
    Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $winget) { Write-Error 'winget_not_found'; exit 2 }`

export const SCRIPT_TEMPLATES: readonly ScriptTemplate[] = [
  {
    id: "inventory_snapshot",
    name: "Inventory snapshot",
    description:
      "OS, CPU, memory, and fixed-disk summary as JSON. Use Refresh inventory to store a full snapshot.",
    category: "inventory",
    language: "powershell",
    platform: "windows",
    timeoutSeconds: 120,
    destructive: false,
    parameters: [],
    content: String.raw`$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$disks = Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
  [pscustomobject]@{ drive = $_.DeviceID; sizeGB = [math]::Round($_.Size / 1GB, 1); freeGB = [math]::Round($_.FreeSpace / 1GB, 1) }
}
[pscustomobject]@{
  host = $env:COMPUTERNAME
  os = "$($os.Caption) $($os.Version)"
  lastBoot = $os.LastBootUpTime
  model = "$($cs.Manufacturer) $($cs.Model)"
  cpu = $cpu.Name
  memoryGB = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
  disks = $disks
} | ConvertTo-Json -Depth 4`,
  },
  {
    id: "windows_update_check",
    name: "Windows Update check",
    description:
      "Lists pending updates from the Windows Update Agent. Search only; nothing is downloaded or installed.",
    category: "updates",
    language: "powershell",
    platform: "windows",
    timeoutSeconds: 600,
    destructive: false,
    parameters: [],
    content: String.raw`$session = New-Object -ComObject Microsoft.Update.Session
$searcher = $session.CreateUpdateSearcher()
$result = $searcher.Search('IsInstalled=0 and IsHidden=0')
$rows = foreach ($u in $result.Updates) {
  [pscustomobject]@{ title = $u.Title; kb = ($u.KBArticleIDs -join ','); severity = $u.MsrcSeverity; rebootLikely = $u.InstallationBehavior.RebootBehavior -ne 0 }
}
"Pending updates: $($result.Updates.Count)"
$rows | Format-Table -AutoSize | Out-String -Width 200`,
  },
  {
    id: "disk_cleanup_preview",
    name: "Disk cleanup preview",
    description:
      "Reports how much space temp folders, the update download cache, and the recycle bin use on a drive. Deletes nothing.",
    category: "storage",
    language: "powershell",
    platform: "windows",
    timeoutSeconds: 300,
    destructive: false,
    parameters: [
      {
        name: "drive",
        label: "Drive letter",
        default: "C",
        pattern: "^[A-Za-z]$",
        description: "Single drive letter to measure.",
      },
    ],
    content: String.raw`$drive = '{{drive}}'
$targets = @(
  "$env:SystemRoot\Temp",
  "$env:SystemRoot\SoftwareDistribution\Download",
  "$($drive):\`$Recycle.Bin"
) + (Get-ChildItem "$($drive):\Users" -Directory -ErrorAction SilentlyContinue | ForEach-Object { Join-Path $_.FullName 'AppData\Local\Temp' })
$rows = foreach ($path in $targets) {
  if (-not (Test-Path -LiteralPath $path)) { continue }
  $bytes = (Get-ChildItem -LiteralPath $path -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
  [pscustomobject]@{ path = $path; sizeMB = [math]::Round(($bytes / 1MB), 1) }
}
$rows | Sort-Object sizeMB -Descending | Format-Table -AutoSize | Out-String -Width 200
"Preview only. Nothing was deleted."`,
  },
  {
    id: "winget_upgrade_dry_run",
    name: "winget upgrade (dry run)",
    description:
      "Lists packages with available upgrades. Runs winget upgrade without --all, so nothing is installed.",
    category: "software",
    language: "powershell",
    platform: "windows",
    timeoutSeconds: 300,
    destructive: false,
    parameters: [],
    content: `${WINGET_RESOLVE}
& $winget upgrade --include-unknown --accept-source-agreements --disable-interactivity
"Dry run only. No package was upgraded."`,
  },
  {
    id: "service_status",
    name: "Service status",
    description:
      "Shows the state, start type, and account of one Windows service.",
    category: "health",
    language: "powershell",
    platform: "windows",
    timeoutSeconds: 60,
    destructive: false,
    parameters: [
      {
        name: "service",
        label: "Service name",
        default: "wuauserv",
        pattern: "^[A-Za-z0-9_.-]{1,80}$",
        description: "Service short name, e.g. wuauserv or Spooler.",
      },
    ],
    content: String.raw`Get-CimInstance Win32_Service -Filter "Name='{{service}}'" |
  Select-Object Name, DisplayName, State, StartMode, StartName, ProcessId |
  Format-List | Out-String -Width 200`,
  },
  {
    id: "recent_system_errors",
    name: "Recent system errors",
    description: "Newest critical and error events from the System log.",
    category: "health",
    language: "powershell",
    platform: "windows",
    timeoutSeconds: 120,
    destructive: false,
    parameters: [
      {
        name: "hours",
        label: "Look back (hours)",
        default: "24",
        pattern: "^(?:[1-9]|[1-9][0-9]|1[0-5][0-9]|16[0-8])$",
        description: "1 to 168 hours.",
      },
      {
        name: "max",
        label: "Max events",
        default: "50",
        pattern: "^(?:[1-9]|[1-9][0-9]|1[0-9][0-9]|200)$",
        description: "1 to 200 events.",
      },
    ],
    content: String.raw`$since = (Get-Date).AddHours(-{{hours}})
Get-WinEvent -FilterHashtable @{ LogName = 'System'; Level = 1, 2; StartTime = $since } -MaxEvents {{max}} -ErrorAction SilentlyContinue |
  Select-Object TimeCreated, Id, ProviderName, LevelDisplayName, @{ n = 'Message'; e = { ($_.Message -split "\r?\n")[0] } } |
  Format-Table -AutoSize -Wrap | Out-String -Width 220`,
  },
  {
    id: "defender_status",
    name: "Defender status",
    description: "Microsoft Defender protection state and signature age.",
    category: "health",
    language: "powershell",
    platform: "windows",
    timeoutSeconds: 60,
    destructive: false,
    parameters: [],
    content: String.raw`Get-MpComputerStatus |
  Select-Object AMServiceEnabled, AntivirusEnabled, RealTimeProtectionEnabled, AntivirusSignatureAge, AntivirusSignatureLastUpdated, QuickScanAge, FullScanAge |
  Format-List | Out-String -Width 200`,
  },
]

const TEMPLATE_BY_ID = new Map(SCRIPT_TEMPLATES.map((t) => [t.id, t]))

export function scriptTemplateById(id: string): ScriptTemplate | undefined {
  return TEMPLATE_BY_ID.get(id)
}

/** Resolves operator input against a template's parameter patterns; unknown keys are ignored. */
export function resolveTemplateParameters(
  template: ScriptTemplate,
  provided: Record<string, unknown> | undefined
): { ok: true; values: Record<string, string> } | { ok: false; error: string } {
  const values: Record<string, string> = {}
  for (const param of template.parameters) {
    const raw = provided?.[param.name]
    const value = typeof raw === "string" && raw !== "" ? raw : param.default
    if (!new RegExp(param.pattern).test(value))
      return { ok: false, error: `invalid_parameter:${param.name}` }
    values[param.name] = value
  }
  return { ok: true, values }
}
