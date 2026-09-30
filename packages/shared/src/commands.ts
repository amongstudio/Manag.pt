export const COMMAND_TYPES = [
  "restart",
  "shutdown",
  "install_app",
  "uninstall_app",
  "run_script",
  "get_processes",
  "kill_process",
  "kill_switch",
  "capture_screenshot",
  "get_files",
  "upload_file",
  "download_file",
  "delete_file",
  "mkdir",
  "rename_file",
  "move_file",
  "copy_file",
  "preview_file",
  "search_files",
  "start_watch",
  "stop_watch",
  "update_agent",
  "run_plugin",
  "run_module",
  "get_services",
  "start_service",
  "stop_service",
  "restart_service",
  "get_registry",
  "set_registry",
  "delete_registry",
	"get_adapters",
	"get_ports",
	"get_firewall",
	"set_firewall_rule",
	"delete_firewall_rule",
	"get_event_log",
	"get_windows_update",
	"start_quick_assist",
	"get_admin_center",
	"get_tasks",
	"set_task_enabled",
	"get_defender",
	"set_defender",
	"start_defender_scan",
	"update_defender",
	"defender_action",
	"cancel_defender_scan",
	"get_bitlocker",
	"set_bitlocker",
	"get_capabilities",
	"install_capability",
	"get_smb",
	"smb_list",
	"smb_connect",
	"smb_disconnect",
	"get_credentials",
	"set_credential",
	"delete_credential",
	"generate_credential",
	"backup_credentials",
	"restore_credentials",
	"collect_inventory",
	"install_windows_update",
	"network_scan",
	"nuclei_scan",
	"host_posture",
	"apply_config",
	"peer_listen",
	"peer_offer",
	"get_clipboard",
	"get_local_users",
	"local_user_action",
	"get_connections",
	"get_scan_tools",
	"install_scan_tool",
] as const

export type CommandType = (typeof COMMAND_TYPES)[number]

export const PLUGIN_RUNTIMES = ["python", "go_source", "binary", "js_goja"] as const
export type PluginRuntime = (typeof PLUGIN_RUNTIMES)[number]

export const UPDATE_KINDS = ["agent", "helper"] as const
export type UpdateKind = (typeof UPDATE_KINDS)[number]

export const DESTRUCTIVE_COMMANDS = new Set<CommandType>([
  "restart",
  "shutdown",
  "kill_switch",
  "kill_process",
  "delete_file",
  "install_app",
  "uninstall_app",
  "run_plugin",
  "run_module",
  "start_service",
  "stop_service",
  "restart_service",
  "set_registry",
  "delete_registry",
  "set_firewall_rule",
  "delete_firewall_rule",
  "start_quick_assist",
  "set_task_enabled",
  "set_defender",
  "start_defender_scan",
  "update_defender",
  "defender_action",
  "cancel_defender_scan",
  "set_bitlocker",
  "install_capability",
  "smb_connect",
  "smb_disconnect",
  "set_credential",
  "delete_credential",
  "generate_credential",
  "backup_credentials",
  "restore_credentials",
  "install_windows_update",
  "local_user_action",
  "install_scan_tool",
])

/** Commands whose queueing is always written to the audit log with the operator identity. */
export const AUDITED_COMMANDS = new Set<CommandType>([
  "start_service",
  "stop_service",
  "restart_service",
  "kill_process",
  "install_app",
  "uninstall_app",
  "get_clipboard",
  "get_local_users",
  "local_user_action",
  "install_scan_tool",
  "run_script",
])

export const COMMAND_STATUS = ["pending", "running", "success", "failed", "cancelled"] as const
export type CommandStatus = (typeof COMMAND_STATUS)[number]

export const COMMAND_TERMINAL_STATUS = ["success", "failed", "cancelled"] as const
export type CommandTerminalStatus = (typeof COMMAND_TERMINAL_STATUS)[number]
export const COMMAND_TERMINAL_STATUS_SET = new Set<string>(COMMAND_TERMINAL_STATUS)

export const COMMAND_ACTIVE_STATUS = ["pending", "running"] as const
export type CommandActiveStatus = (typeof COMMAND_ACTIVE_STATUS)[number]
export const COMMAND_ACTIVE_STATUS_SET = new Set<string>(COMMAND_ACTIVE_STATUS)

export function isCommandTerminal(status: string): boolean {
  return COMMAND_TERMINAL_STATUS_SET.has(status)
}

export function isCommandActive(status: string): boolean {
  return COMMAND_ACTIVE_STATUS_SET.has(status)
}

/** Ticketed LAN copy. Queued by the admin peer-copy route, not the composer. */
export const PEER_COMMAND_TYPES = ["peer_listen", "peer_offer"] as const
export type PeerCommandType = (typeof PEER_COMMAND_TYPES)[number]
export const PEER_COMMAND_TYPE_SET = new Set<string>(PEER_COMMAND_TYPES)

export function isPeerCommandType(type: string): type is PeerCommandType {
  return PEER_COMMAND_TYPE_SET.has(type)
}

export function isComposerCommandType(type: string): type is CommandType {
  return (
    (COMMAND_TYPES as readonly string[]).includes(type) &&
    !isPeerCommandType(type) &&
    type !== "run_plugin" &&
    type !== "run_module"
  )
}

export const DEVICE_STATUS = ["online", "offline"] as const
export type DeviceStatus = (typeof DEVICE_STATUS)[number]

export const LOG_LEVELS = ["DEBUG", "INFO", "WARNING", "ERROR"] as const
export type LogLevel = (typeof LOG_LEVELS)[number]
