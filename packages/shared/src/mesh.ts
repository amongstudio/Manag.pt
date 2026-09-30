import { z } from "zod"

import { COMMAND_TYPES, type CommandType } from "./commands.ts"

/** Fleet mesh policy. Last-known copy on the agent applies while the API is down. */
export type MeshPolicy = {
  enabled: boolean
  wan: boolean
  allowCommands: string[]
}

export const DEFAULT_MESH_POLICY: MeshPolicy = {
  enabled: false,
  wan: false,
  allowCommands: [],
}

/** Implicit mesh command allowlist when `allowCommands` is empty. Files use the `file` op, not these. */
export const MESH_DEFAULT_COMMANDS = [
  "get_files",
  "get_processes",
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
  "collect_inventory",
] as const satisfies readonly CommandType[]

/** Never accepted from a peer, even if listed in `allowCommands`. */
export const MESH_NEVER_COMMANDS = [
  "run_plugin",
  "peer_listen",
  "peer_offer",
  "update_agent",
  "get_credentials",
  "backup_credentials",
  "set_credential",
  "delete_credential",
  "generate_credential",
  "restore_credentials",
  "set_bitlocker",
  "install_windows_update",
  "network_scan",
  "nuclei_scan",
] as const satisfies readonly CommandType[]

const NEVER = new Set<string>(MESH_NEVER_COMMANDS)
const DEFAULTS = new Set<string>(MESH_DEFAULT_COMMANDS)

export function meshCommandAllowed(type: string, allowCommands: string[] | undefined): boolean {
  const typ = type.trim()
  if (!typ || NEVER.has(typ)) return false
  if (DEFAULTS.has(typ)) return true
  return (allowCommands ?? []).some((item) => item === typ)
}

export function meshExtraCommandChoices(): CommandType[] {
  return COMMAND_TYPES.filter((type) => !DEFAULTS.has(type) && !NEVER.has(type))
}

export const meshPolicySchema = z.strictObject({
  enabled: z.boolean(),
  wan: z.boolean(),
  allowCommands: z.array(z.string().min(1).max(64)).max(64),
})

export type MeshBundle = {
  cert?: string
  key?: string
  ca: string
  serial: string
  notAfter: string
  revokedSerials?: string[]
}

export const meshBundleSchema = z.object({
  cert: z.string().min(1).max(16_384).optional(),
  key: z.string().min(1).max(16_384).optional(),
  ca: z.string().min(1).max(16_384),
  serial: z.string().min(1).max(128),
  notAfter: z.string().min(1).max(64),
  revokedSerials: z.array(z.string().min(1).max(128)).max(512).optional(),
})
