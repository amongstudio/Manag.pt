export type AssistantAction =
  | { action: "run_script"; scriptName: string }
  | { action: "restart_service"; name: string }
  | { action: "start_service"; name: string }
  | { action: "stop_service"; name: string }
  | { action: "kill_process"; name: string }
  | { action: "collect_inventory" }
  | { action: "get_processes" }
  | { action: "get_services" }

const DESTRUCTIVE = new Set(["restart_service", "stop_service", "kill_process"])

export function assistantNeedsConfirm(action: AssistantAction): boolean {
  return DESTRUCTIVE.has(action.action)
}

export function assistantPrompt(text: string): { system: string; user: string } {
  return {
    system:
      "You propose one operator action as JSON. Allowed actions: run_script, restart_service, start_service, stop_service, kill_process, collect_inventory, get_processes, get_services. " +
      "Reply with only a JSON object. Do not include credentials, keys, or secrets.",
    user: text.slice(0, 2000),
  }
}

export function parseAssistantText(text: string): AssistantAction | null {
  const trimmed = text.trim()
  const json = parseJsonAction(trimmed) ?? parseJsonAction(extractJson(trimmed))
  if (json) return json
  const lower = trimmed.toLowerCase()
  if (/^refresh inventory$|^collect inventory$/.test(lower)) return { action: "collect_inventory" }
  if (lower === "list processes" || lower === "get processes") return { action: "get_processes" }
  if (lower === "list services" || lower === "get services") return { action: "get_services" }
  let match = /^(restart|start|stop) service\s+([A-Za-z0-9_. -]{1,80})$/i.exec(trimmed)
  if (match) {
    const verb = match[1]!.toLowerCase()
    const name = match[2]!.trim()
    if (verb === "restart") return { action: "restart_service", name }
    if (verb === "start") return { action: "start_service", name }
    return { action: "stop_service", name }
  }
  match = /^kill(?: process)?\s+([A-Za-z0-9_. -]{1,80})$/i.exec(trimmed)
  if (match) return { action: "kill_process", name: match[1]!.trim() }
  match = /^run script\s+(.{1,120})$/i.exec(trimmed)
  if (match) return { action: "run_script", scriptName: match[1]!.trim() }
  return null
}

function extractJson(text: string): string {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return ""
  return text.slice(start, end + 1)
}

function parseJsonAction(text: string): AssistantAction | null {
  if (!text.startsWith("{")) return null
  try {
    const raw = JSON.parse(text) as Record<string, unknown>
    const action = raw.action
    if (action === "collect_inventory" || action === "get_processes" || action === "get_services") return { action }
    if (action === "run_script" && typeof raw.scriptName === "string" && raw.scriptName.trim()) {
      return { action, scriptName: raw.scriptName.trim().slice(0, 120) }
    }
    if (
      (action === "restart_service" || action === "start_service" || action === "stop_service" || action === "kill_process") &&
      typeof raw.name === "string" &&
      raw.name.trim()
    ) {
      return { action, name: raw.name.trim().slice(0, 80) }
    }
    return null
  } catch {
    return null
  }
}
