import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export type PluginStarterRuntime = "python" | "go_source"

export type PluginStarter = {
  id: string
  name: string
  description: string
  defaultRuntime: PluginStarterRuntime
  runtimes: PluginStarterRuntime[]
  files: Partial<Record<PluginStarterRuntime, string>>
  networkAllowed: false
  timeoutSec: number
  suggestedArgs: string[]
  suggestedPlatform?: string
}

const STARTERS: PluginStarter[] = [
  {
    id: "inventory",
    name: "Host inventory",
    description: "OS, hostname, CPU/arch, and disk usage for home and temp.",
    defaultRuntime: "python",
    runtimes: ["python", "go_source"],
    files: { python: "inventory.py", go_source: "inventory.go" },
    networkAllowed: false,
    timeoutSec: 30,
    suggestedArgs: [],
  },
  {
    id: "process_snapshot",
    name: "Process snapshot",
    description: "Short process list from /proc or tasklist. Optional max-count argument.",
    defaultRuntime: "python",
    runtimes: ["python", "go_source"],
    files: { python: "process_snapshot.py", go_source: "process_snapshot.go" },
    networkAllowed: false,
    timeoutSec: 30,
    suggestedArgs: ["50"],
  },
  {
    id: "sandbox_disk",
    name: "Sandbox disk usage",
    description: "Disk usage for home/temp, or paths passed as arguments.",
    defaultRuntime: "python",
    runtimes: ["python", "go_source"],
    files: { python: "sandbox_disk.py", go_source: "sandbox_disk.go" },
    networkAllowed: false,
    timeoutSec: 30,
    suggestedArgs: [],
  },
  {
    id: "installed_programs",
    name: "Installed programs",
    description: "Windows Uninstall registry (HKLM/HKCU). Runs PowerShell; requires Python or Go on the agent.",
    defaultRuntime: "python",
    runtimes: ["python", "go_source"],
    files: { python: "installed_programs.py", go_source: "installed_programs.go" },
    networkAllowed: false,
    timeoutSec: 45,
    suggestedArgs: [],
    suggestedPlatform: "windows",
  },
  {
    id: "win_services",
    name: "Windows services",
    description: "Get-Service name, status, and start type. Runs PowerShell; requires Python or Go on the agent.",
    defaultRuntime: "python",
    runtimes: ["python", "go_source"],
    files: { python: "win_services.py", go_source: "win_services.go" },
    networkAllowed: false,
    timeoutSec: 45,
    suggestedArgs: [],
    suggestedPlatform: "windows",
  },
  {
    id: "system_event_log",
    name: "System event log",
    description: "Prefer the native get_event_log command (EvtQuery). This starter uses Get-WinEvent for older agents.",
    defaultRuntime: "python",
    runtimes: ["python", "go_source"],
    files: { python: "system_event_log.py", go_source: "system_event_log.go" },
    networkAllowed: false,
    timeoutSec: 45,
    suggestedArgs: [],
    suggestedPlatform: "windows",
  },
  {
    id: "disk_volumes",
    name: "Disk volumes",
    description: "Windows Get-Volume size and health. Runs PowerShell; requires Python or Go on the agent.",
    defaultRuntime: "python",
    runtimes: ["python", "go_source"],
    files: { python: "disk_volumes.py", go_source: "disk_volumes.go" },
    networkAllowed: false,
    timeoutSec: 30,
    suggestedArgs: [],
    suggestedPlatform: "windows",
  },
]

export function pluginTemplatesDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.join(here, "plugin-templates"),
    path.join(here, "../src/plugin-templates"),
    path.join(process.cwd(), "src/plugin-templates"),
  ]
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "inventory.py"))) return dir
  }
  return candidates[0]!
}

export function listPluginStarters(): PluginStarter[] {
  return STARTERS.map((s) => ({ ...s, files: { ...s.files } }))
}

export function getPluginStarter(id: string): PluginStarter | undefined {
  return STARTERS.find((s) => s.id === id)
}

export function readPluginStarterSource(
  starter: PluginStarter,
  runtime: PluginStarterRuntime
): { filename: string; source: Buffer } | null {
  const filename = starter.files[runtime]
  if (!filename) return null
  const full = path.join(pluginTemplatesDir(), filename)
  if (!fs.existsSync(full)) return null
  return { filename, source: fs.readFileSync(full) }
}
