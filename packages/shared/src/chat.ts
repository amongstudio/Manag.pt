import { DESTRUCTIVE_COMMANDS, type CommandType } from "./commands.ts"

/** Copilot may only queue these existing command types. No new agent protocol. */
export const COPILOT_COMMAND_TYPES = [
  "get_processes",
  "get_files",
  "get_services",
  "get_registry",
  "get_adapters",
  "get_ports",
  "get_firewall",
  "get_event_log",
  "get_windows_update",
  "get_admin_center",
  "get_tasks",
  "get_defender",
  "get_bitlocker",
  "get_capabilities",
  "get_smb",
  "smb_list",
  "run_script",
  "run_plugin",
  "preview_file",
  "search_files",
] as const satisfies readonly CommandType[]

export type CopilotCommandType = (typeof COPILOT_COMMAND_TYPES)[number]

export const COPILOT_COMMAND_TYPE_SET = new Set<string>(COPILOT_COMMAND_TYPES)

export function isCopilotCommandType(type: string): type is CopilotCommandType {
  return COPILOT_COMMAND_TYPE_SET.has(type)
}

export function copilotToolNeedsConfirm(type: string): boolean {
  return isCopilotCommandType(type) && DESTRUCTIVE_COMMANDS.has(type as CommandType)
}

export const CHAT_TOOL_STATUS = [
  "pending_confirm",
  "queued",
  "running",
  "success",
  "failed",
  "declined",
] as const
export type ChatToolStatus = (typeof CHAT_TOOL_STATUS)[number]

export type ChatToolCall = {
  id: string
  name: string
  arguments: Record<string, unknown>
  status: ChatToolStatus
  commandId?: string | null
  error?: string
}

export type ChatDeltaPayload = {
  deviceId: string
  threadId: string
  messageId?: string
  delta?: string
  done?: boolean
  error?: string
  tool?: ChatToolCall
}
