import { WINDOWS_AGENT_SERVICE, WINDOWS_HELPER_SERVICE } from "./constants.ts"

export const SERVICE_COMMAND_TYPES = ["get_services", "start_service", "stop_service", "restart_service"] as const

export type ServiceCommandType = (typeof SERVICE_COMMAND_TYPES)[number]

export const SERVICE_CONTROL_ACTIONS = ["start", "stop", "restart"] as const
export type ServiceControlAction = (typeof SERVICE_CONTROL_ACTIONS)[number]

export type ServiceInfo = {
  name: string
  displayName?: string
  status: string
  startType?: string
  pid?: number
  official?: boolean
}

export type ParsedServiceList = {
  services: ServiceInfo[]
  truncated: boolean
}

export type ServiceCommandSeed = {
  id: string
  type: string
  status: string
  result?: unknown
}

export function isServiceCommandType(type: string): type is ServiceCommandType {
  return (SERVICE_COMMAND_TYPES as readonly string[]).includes(type)
}

export function isOfficialService(name: string): boolean {
  const n = name.trim().toLowerCase()
  return n === WINDOWS_AGENT_SERVICE.toLowerCase() || n === WINDOWS_HELPER_SERVICE.toLowerCase()
}

function isServiceInfo(value: unknown): value is ServiceInfo {
  if (!value || typeof value !== "object") return false
  const rec = value as { name?: unknown; status?: unknown }
  return typeof rec.name === "string" && rec.name.length > 0 && typeof rec.status === "string"
}

export function parseServiceList(result: unknown): ParsedServiceList {
  if (Array.isArray(result)) {
    return { services: result.filter(isServiceInfo), truncated: false }
  }
  if (!result || typeof result !== "object") {
    return { services: [], truncated: false }
  }
  const rec = result as { services?: unknown; items?: unknown; truncated?: unknown }
  const raw = Array.isArray(rec.services) ? rec.services : Array.isArray(rec.items) ? rec.items : []
  return { services: raw.filter(isServiceInfo), truncated: Boolean(rec.truncated) }
}

export function latestSuccessfulServiceList(commands: ServiceCommandSeed[]): ServiceCommandSeed | undefined {
  return commands.find((c) => c.type === "get_services" && c.status === "success")
}

export function serviceStatusLabel(status: string): string {
  switch (status) {
    case "stopped":
      return "Stopped"
    case "start_pending":
      return "Starting"
    case "stop_pending":
      return "Stopping"
    case "running":
      return "Running"
    case "continue_pending":
      return "Continuing"
    case "pause_pending":
      return "Pausing"
    case "paused":
      return "Paused"
    default:
      return status || "Unknown"
  }
}

export function serviceStartTypeLabel(startType: string | undefined): string {
  switch (startType) {
    case "automatic":
      return "Automatic"
    case "manual":
      return "Manual"
    case "disabled":
      return "Disabled"
    case "boot":
      return "Boot"
    case "system":
      return "System"
    default:
      return startType || "—"
  }
}

export function serviceControlConfirm(action: ServiceControlAction, name: string): string {
  const official = isOfficialService(name)
  if (action === "stop" && name.toLowerCase() === WINDOWS_HELPER_SERVICE.toLowerCase()) {
    return `Stop ${name}? The helper will no longer restart the agent if it crashes until you start this service again.`
  }
  if (action === "stop" && name.toLowerCase() === WINDOWS_AGENT_SERVICE.toLowerCase()) {
    return `Stop ${name}? The agent disconnects. SCM recovery and PCManagerHelper may start it again.`
  }
  if (action === "restart" && name.toLowerCase() === WINDOWS_AGENT_SERVICE.toLowerCase()) {
    return `Restart ${name}? The agent process restarts and this session may disconnect briefly.`
  }
  if (official) {
    return `${action === "start" ? "Start" : action === "stop" ? "Stop" : "Restart"} ${name}? This is an official Mnag.pt service.`
  }
  return `${action === "start" ? "Start" : action === "stop" ? "Stop" : "Restart"} ${name}?`
}
