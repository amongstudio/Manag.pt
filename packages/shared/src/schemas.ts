import { z } from "zod"

import { COMMAND_TYPES, LOG_LEVELS, PLUGIN_RUNTIMES, type CommandType } from "./commands.ts"
import { MESH_FORWARD_KEY, PEER_LAN_ADDRS_MAX } from "./constants.ts"
import { meshPolicySchema } from "./mesh.ts"
import {
  COMMAND_RESULT_MAX_BYTES,
  HEARTBEAT_EXTRAS_MAX_BYTES,
  MAX_CREATE_COMMAND_DEVICES,
  MAX_WATCH_DURATION_MIN,
  PROCESS_CAP,
} from "./constants.ts"

export function extrasWithinCap(extras: unknown): boolean {
  if (extras == null) return true
  try {
    return JSON.stringify(extras).length <= HEARTBEAT_EXTRAS_MAX_BYTES
  } catch {
    return false
  }
}

export function capCommandResult(result: unknown): unknown {
  try {
    const raw = JSON.stringify(result ?? null)
    if (raw.length <= COMMAND_RESULT_MAX_BYTES) return result ?? null
  } catch {
    return { error: "result_unserializable" }
  }
  return { error: "result_too_large" }
}

/** Agent hello_ok / heartbeat ack config, including the live transfer cap. */
export const agentConfigSchema = z.object({
  heartbeatIntervalSec: z.number().int().min(1),
  pollIntervalSec: z.number().int().min(1),
  screenshotIntervalSec: z.number().int().min(0),
  autoRestartTime: z.string(),
  sandboxRoots: z.array(z.string()),
  lightweight: z.boolean(),
  idleHeartbeatSec: z.number().int().min(1),
  watchedHeartbeatSec: z.number().int().min(1),
  maxUploadBytes: z.number().int().positive(),
  mesh: meshPolicySchema.optional(),
})

export const processInfoSchema = z.object({
  pid: z.number().int(),
  name: z.string(),
  cpu: z.number().optional(),
  ram: z.number().optional(),
})

export const registerSchema = z.object({
  enrollmentSecret: z.string().min(1),
  deviceId: z.string().uuid(),
  hostname: z.string().min(1).max(255),
  platform: z.enum(["windows", "linux", "darwin"]),
  arch: z.string().min(1).max(32),
  agentVersion: z.string().min(1).max(64),
  ip: z.string().max(64).optional(),
  mac: z.string().max(64).optional(),
  e2ePub: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, "invalid e2e public key")
    .optional(),
  /** Required to mutate an already-enrolled device. */
  deviceKey: z.string().min(16).max(128).optional(),
})

export const e2eSessionRequestSchema = z.object({
  operatorPub: z.string().regex(/^[0-9a-f]{64}$/i, "invalid operator public key"),
})

export const iceServerSchema = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
})

/**
 * Presence ping. cpu/ram/disk/extras/processes are accepted for older agents
 * and ignored by ingest (no Stat rows). A body of `{}` is a valid heartbeat.
 */
export const heartbeatSchema = z.object({
  cpu: z.number().min(0).max(100).optional(),
  ram: z.number().min(0).max(100).optional(),
  disk: z.number().min(0).max(100).optional(),
  gpu: z.number().min(0).max(100).optional(),
  temp: z.number().optional(),
  netUp: z.number().optional(),
  netDown: z.number().optional(),
  // Agents send `processes: null` when enumeration is empty or unavailable
  // (Go marshals a nil slice as null). Normalize null/undefined to [].
  processes: z
    .array(processInfoSchema)
    .max(PROCESS_CAP)
    .nullable()
    .optional()
    .transform((v) => v ?? []),
  extras: z
    .record(z.string(), z.unknown())
    .optional()
    .refine((v) => extrasWithinCap(v), "extras exceed cap"),
  lanAddrs: z
    .array(z.string().min(1).max(64))
    .max(PEER_LAN_ADDRS_MAX)
    .nullable()
    .optional()
    .transform((v) => v ?? undefined),
  lanPort: z.number().int().min(1).max(65535).optional(),
})

export const commandResultSchema = z.object({
  commandId: z.string().min(1),
  resultId: z.string().uuid(),
  status: z.enum(["success", "failed", "cancelled", "running"]),
  result: z.unknown().optional(),
  progress: z.number().min(0).max(100).optional(),
})

export const agentLogSchema = z.object({
  entries: z
    .array(
      z.object({
        timestamp: z.string().optional(),
        level: z.enum(LOG_LEVELS),
        source: z.string().max(128).optional(),
        message: z.string().max(8000),
      })
    )
    .min(1)
    .max(200),
})

export const createCommandSchema = z.object({
  deviceIds: z.array(z.string().min(1).max(128)).min(1).max(MAX_CREATE_COMMAND_DEVICES),
  type: z.enum(COMMAND_TYPES),
  payload: z.record(z.string(), z.unknown()).default({}),
  /** When set, the source agent forwards over mesh instead of executing locally. */
  forwardTo: z.string().min(1).max(128).optional(),
})

export const meshForwardRequestSchema = z.object({
  destDeviceId: z.string().min(1).max(128),
  type: z.enum(COMMAND_TYPES),
  payload: z.record(z.string(), z.unknown()).default({}),
})

export const deleteDeviceCommandsSchema = z
  .object({
    ids: z.array(z.string().min(1).max(128)).max(500).optional(),
    all: z.boolean().optional(),
    includeActive: z.boolean().optional(),
  })
  .refine((v) => v.all === true || (Array.isArray(v.ids) && v.ids.length > 0), {
    message: "ids or all required",
  })

export const runPluginPayloadSchema = z.object({
  pluginId: z.string().min(1),
  args: z.array(z.string()).default([]),
})

export const pluginGrantsSchema = z.object({
  deviceIds: z.array(z.string().min(1)).max(10_000),
})

export const STAMP_PLATFORMS = ["windows", "linux", "darwin"] as const
export const STAMP_ARCHES = ["amd64", "arm64"] as const

export const stampPackSchema = z.object({
  platform: z.enum(STAMP_PLATFORMS),
  arch: z.enum(STAMP_ARCHES),
  serverUrl: z.string().min(1).max(2048),
  fallbackUrls: z.array(z.string().min(1).max(2048)).default([]),
  enrollmentSecret: z.string().min(1).max(512),
  heartbeatIntervalSec: z.number().int().min(5).max(3600).default(90),
  idleHeartbeatSec: z.number().int().min(5).max(3600).default(90),
  watchedHeartbeatSec: z.number().int().min(5).max(3600).default(15),
  pollIntervalSec: z.number().int().min(1).max(3600).default(15),
  screenshotIntervalSec: z.number().int().min(0).max(3600).default(0),
  autoRestartTime: z.string().regex(/^$|^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM or empty").default(""),
  sandboxRoots: z.array(z.string().min(1).max(1024)).max(64).default([]),
  enableGpu: z.boolean().default(false),
  enableTemps: z.boolean().default(false),
  enablePlugins: z.boolean().default(true),
  enableScreenshot: z.boolean().default(true),
  enableWebrtc: z.boolean().default(false),
  includeHelper: z.boolean().default(false),
  notes: z.string().max(2000).optional(),
})

export const commandTemplateWriteSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).default(""),
  type: z.enum(COMMAND_TYPES),
  payload: z.record(z.string(), z.unknown()).default({}),
})

export const pluginFromTemplateSchema = z.object({
  templateId: z.string().min(1).max(64),
  runtime: z.enum(["python", "go_source"]).optional(),
  name: z.string().min(1).max(128).optional(),
  version: z.string().min(1).max(64).optional(),
  timeoutSec: z.number().int().min(1).max(900).optional(),
  networkAllowed: z.boolean().optional(),
  platform: z.string().min(1).max(32).optional(),
  arch: z.string().min(1).max(32).optional(),
})

export const PLUGIN_RUNTIME_SET = new Set<string>(PLUGIN_RUNTIMES)

const commandPathSchema = z.string().min(1).max(2048)

const serviceNameSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((v) => !/[\r\n\0]/.test(v), "invalid characters")

export const REGISTRY_HIVE_VALUES = ["HKLM", "HKCU"] as const
export const REGISTRY_VALUE_TYPE_VALUES = [
  "REG_SZ",
  "REG_EXPAND_SZ",
  "REG_DWORD",
  "REG_QWORD",
  "REG_MULTI_SZ",
  "REG_BINARY",
] as const

const registryHiveSchema = z.enum(REGISTRY_HIVE_VALUES)
const registryPathSchema = z
  .string()
  .max(1024)
  .refine((v) => !/[\r\n\0]/.test(v), "invalid characters")
const registryValueNameSchema = z
  .string()
  .max(256)
  .refine((v) => !/[\r\n\0]/.test(v), "invalid characters")
const registryValueTypeSchema = z.enum(REGISTRY_VALUE_TYPE_VALUES)
const registryDataSchema = z.union([z.string(), z.number(), z.array(z.string())])

export const FIREWALL_DIRECTION_VALUES = ["inbound", "outbound"] as const
export const FIREWALL_ACTION_VALUES = ["allow", "block"] as const
export const FIREWALL_PROTOCOL_VALUES = ["tcp", "udp", "any", "icmp"] as const

const firewallNameSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((v) => !/[\r\n\0]/.test(v), "invalid characters")

const firewallTextSchema = (max: number) =>
  z
    .string()
    .max(max)
    .refine((v) => !/[\r\n\0]/.test(v), "invalid characters")

const firewallProfilesSchema = z
  .string()
  .max(64)
  .refine((v) => {
    if (!v.trim()) return true
    return v
      .split(",")
      .map((p) => p.trim().toLowerCase())
      .every((p) => p === "all" || p === "domain" || p === "private" || p === "public")
  }, "invalid profiles")

export const fileListQuerySchema = z.object({
  path: z.string().min(1).max(1024),
})

/** App/process names: no control chars and no leading "-" (package-manager flag injection). */
const commandNameSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((v) => !/[\r\n\0]/.test(v), "invalid characters")
  .refine((v) => !v.trimStart().startsWith("-"), "must not start with '-'")

/**
 * Per-command payload validation applied when operators queue commands.
 * Unknown keys are stripped, so the persisted payload is exactly what agents read.
 */
export const commandPayloadSchemas = {
  restart: z.object({}),
  shutdown: z.object({}),
  kill_switch: z.object({}),
  get_processes: z.object({}),
  capture_screenshot: z.object({}),
  stop_watch: z.object({}),
  update_agent: z.object({}),
  install_app: z
    .object({ name: commandNameSchema.optional(), id: commandNameSchema.optional() })
    .refine((v) => Boolean(v.name || v.id), "name or id required"),
  uninstall_app: z.object({ name: commandNameSchema }),
  run_script: z.object({
    script: z.string().min(1).max(65_536),
    language: z.enum(["powershell", "python", "batch", "shell"]).optional(),
    timeoutSeconds: z.number().int().min(1).max(3600).optional(),
    scriptRunId: z.string().min(1).max(128).optional(),
    parameters: z.record(z.string().max(64), z.string().max(1024)).optional(),
  }),
  kill_process: z
    .object({
      pid: z.number().int().min(1).optional(),
      name: z.string().min(1).max(256).optional(),
    })
    .refine((v) => v.pid != null || Boolean(v.name?.trim()), "pid or name required"),
  get_files: fileListQuerySchema.partial(),
  mkdir: z.object({ path: commandPathSchema }),
  rename_file: z.object({ from: commandPathSchema, to: commandPathSchema }),
  move_file: z.object({ from: commandPathSchema, to: commandPathSchema }),
  copy_file: z.object({ from: commandPathSchema, to: commandPathSchema }),
  preview_file: z.object({ path: commandPathSchema }),
  search_files: z.object({
    path: commandPathSchema,
    name: z.string().max(256).optional(),
    ext: z.string().max(64).optional(),
    content: z.string().max(256).optional(),
  }),
  upload_file: z.object({ path: commandPathSchema }),
  download_file: z.object({ fileId: z.string().min(1).max(128), dest: commandPathSchema }),
  delete_file: z.object({ path: commandPathSchema }),
  start_watch: z.object({ durationMin: z.number().min(1).max(MAX_WATCH_DURATION_MIN).optional() }),
  run_plugin: runPluginPayloadSchema,
  get_services: z.object({ query: z.string().max(256).optional() }),
  start_service: z.object({ name: serviceNameSchema }),
  stop_service: z.object({ name: serviceNameSchema }),
  restart_service: z.object({ name: serviceNameSchema }),
  get_registry: z.object({
    hive: registryHiveSchema,
    path: registryPathSchema.optional().default(""),
  }),
  set_registry: z
    .object({
      hive: registryHiveSchema,
      path: registryPathSchema.optional().default(""),
      target: z.enum(["value", "key"]).default("value"),
      name: registryValueNameSchema.optional(),
      type: registryValueTypeSchema.optional(),
      data: registryDataSchema.optional(),
    })
    .superRefine((v, ctx) => {
      if (v.target === "key") return
      if (!v.type) {
        ctx.addIssue({ code: "custom", message: "type required", path: ["type"] })
      }
      if (v.data === undefined) {
        ctx.addIssue({ code: "custom", message: "data required", path: ["data"] })
      }
    }),
  delete_registry: z.object({
    hive: registryHiveSchema,
    path: registryPathSchema.optional().default(""),
    target: z.enum(["value", "key"]).default("value"),
    name: registryValueNameSchema.optional(),
  }),
  get_adapters: z.object({}),
  get_ports: z.object({ listenOnly: z.boolean().optional() }),
  get_firewall: z.object({ query: z.string().max(256).optional() }),
  get_event_log: z.object({
    log: z.string().min(1).max(256).optional(),
    newest: z.number().int().min(1).max(200).optional(),
    level: z.enum(["all", "critical", "error", "warning", "information", "verbose"]).optional(),
    eventId: z.number().int().min(0).max(65535).optional(),
    source: z.string().max(128).optional(),
    since: z.string().max(40).optional(),
    until: z.string().max(40).optional(),
  }),
  collect_inventory: z.object({}),
  install_windows_update: z.object({
    kbs: z.array(z.string().regex(/^KB\d{4,10}$/)).min(1).max(40),
    reboot: z.enum(["never", "if_required", "scheduled"]).optional(),
  }),
  get_windows_update: z.object({
    online: z.boolean().optional(),
  }),
  start_quick_assist: z.object({
    app: z.enum(["quickassist", "msra"]).optional(),
  }),
  get_admin_center: z.object({}),
  get_tasks: z.object({ query: z.string().max(256).optional() }),
  set_task_enabled: z.object({
    path: z.string().min(1).max(512),
    enabled: z.boolean(),
  }),
  get_defender: z.object({}),
  set_defender: z
    .object({
      realtime: z.boolean().optional(),
      behavior: z.boolean().optional(),
      ioav: z.boolean().optional(),
      scriptScanning: z.boolean().optional(),
      cloudProtection: z.enum(["disabled", "basic", "advanced"]).optional(),
      pua: z.boolean().optional(),
      networkProtection: z.enum(["disabled", "enabled", "audit"]).optional(),
      controlledFolderAccess: z.enum(["disabled", "enabled", "audit"]).optional(),
    })
    .refine(
      (v) =>
        v.realtime != null ||
        v.behavior != null ||
        v.ioav != null ||
        v.scriptScanning != null ||
        v.cloudProtection != null ||
        v.pua != null ||
        v.networkProtection != null ||
        v.controlledFolderAccess != null,
      "at least one Defender setting"
    ),
  start_defender_scan: z.object({
    type: z.enum(["quick", "full", "offline"]).optional(),
  }),
  update_defender: z.object({}),
  defender_action: z.object({
    threatId: z.string().min(1).max(128),
    action: z.enum(["remove", "restore", "quarantine", "allow"]),
  }),
  cancel_defender_scan: z.object({}),
  get_bitlocker: z.object({}),
  set_bitlocker: z
    .object({
      action: z.enum([
        "protect",
        "unprotect",
        "lock",
        "unlock",
        "suspend",
        "resume",
        "add_protector",
        "remove_protector",
        "backup_key",
      ]),
      mountPoint: z.string().min(1).max(128),
      password: z.string().min(1).max(256).optional(),
      recoveryPassword: z.string().min(1).max(256).optional(),
      protectorType: z.enum(["tpm", "password", "recovery"]).optional(),
      protectorId: z.string().max(128).optional(),
      encryptionMethod: z.enum(["xts_aes128", "xts_aes256", "aes128", "aes256"]).optional(),
      usedSpaceOnly: z.boolean().optional(),
    })
    .superRefine((v, ctx) => {
      if (v.action === "unlock" && !v.password && !v.recoveryPassword) {
        ctx.addIssue({ code: "custom", message: "password or recoveryPassword required", path: ["password"] })
      }
      if (v.action === "add_protector" && !v.protectorType) {
        ctx.addIssue({ code: "custom", message: "protectorType required", path: ["protectorType"] })
      }
      if (v.action === "add_protector" && v.protectorType === "password" && !v.password) {
        ctx.addIssue({ code: "custom", message: "password required", path: ["password"] })
      }
      if (v.action === "remove_protector" && !v.protectorId?.trim()) {
        ctx.addIssue({ code: "custom", message: "protectorId required", path: ["protectorId"] })
      }
    }),
  get_capabilities: z.object({ query: z.string().max(256).optional() }),
  install_capability: z.object({
    name: z
      .string()
      .min(1)
      .max(256)
      .regex(/^Media\.MediaFeaturePack/i, "only Media Feature Pack")
      .optional()
      .default("Media.MediaFeaturePack~~~~0.0.1.0"),
  }),
  get_smb: z.object({}),
  smb_list: z.object({ path: z.string().min(1).max(512) }),
  smb_connect: z.object({
    unc: z.string().min(3).max(512),
    username: z.string().max(256).optional(),
    password: z.string().max(256).optional(),
    persist: z.boolean().optional(),
    drive: z.string().max(2).optional(),
  }),
  smb_disconnect: z
    .object({
      unc: z.string().max(512).optional(),
      path: z.string().max(512).optional(),
      drive: z.string().max(2).optional(),
    })
    .refine((v) => Boolean(v.unc?.trim() || v.path?.trim() || v.drive?.trim()), {
      message: "unc, path, or drive required",
    }),
  get_credentials: z.object({
    sources: z.array(z.enum(["windows", "browser", "apps", "generated"])).max(8).optional(),
    reveal: z.boolean().optional(),
  }),
  backup_credentials: z.object({
    sources: z.array(z.enum(["windows", "browser", "apps", "generated"])).max(8).optional(),
  }),
  set_credential: z.object({
    source: z.enum(["windows", "apps", "generated"]).optional(),
    target: z.string().min(1).max(256),
    username: z.string().max(256).optional(),
    secret: z.string().min(1).max(2048),
    persist: z.enum(["local", "session", "enterprise"]).optional(),
    comment: z.string().max(256).optional(),
  }),
  delete_credential: z.object({
    source: z.enum(["windows", "apps", "generated", "browser"]).optional(),
    target: z.string().min(1).max(256),
    kind: z.string().max(32).optional(),
  }),
  generate_credential: z
    .object({
      length: z.number().int().min(8).max(64).optional(),
      save: z.boolean().optional(),
      target: z.string().max(256).optional(),
      username: z.string().max(256).optional(),
      upper: z.boolean().optional(),
      lower: z.boolean().optional(),
      digits: z.boolean().optional(),
      symbols: z.boolean().optional(),
    })
    .refine((v) => !v.save || Boolean(v.target?.trim()), "target required when save is true")
    .refine((v) => {
      const flags = [v.upper, v.lower, v.digits, v.symbols]
      if (flags.every((item) => item === undefined)) return true
      return flags.some((item) => item !== false)
    }, "at least one character class"),
  restore_credentials: z.object({
    credentials: z
      .array(
        z.object({
          source: z.enum(["windows", "apps", "generated"]).optional(),
          target: z.string().min(1).max(256),
          username: z.string().max(256).optional(),
          secret: z.string().min(1).max(2048),
          persist: z.enum(["local", "session", "enterprise"]).optional(),
          comment: z.string().max(256).optional(),
        })
      )
      .min(1)
      .max(50),
  }),
  set_firewall_rule: z.object({
    name: firewallNameSchema,
    direction: z.enum(FIREWALL_DIRECTION_VALUES).optional(),
    action: z.enum(FIREWALL_ACTION_VALUES).optional(),
    enabled: z.boolean().optional(),
    protocol: z.enum(FIREWALL_PROTOCOL_VALUES).optional(),
    localPorts: firewallTextSchema(256).optional(),
    remotePorts: firewallTextSchema(256).optional(),
    localAddresses: firewallTextSchema(512).optional(),
    remoteAddresses: firewallTextSchema(512).optional(),
    application: firewallTextSchema(1024).optional(),
    serviceName: firewallTextSchema(256).optional(),
    description: firewallTextSchema(1024).optional(),
    grouping: firewallTextSchema(256).optional(),
    profiles: firewallProfilesSchema.optional(),
  }),
  delete_firewall_rule: z.object({
    name: firewallNameSchema,
  }),
  peer_listen: z.union([
    z.object({
      ticket: z.lazy(() => peerTicketSchema),
      fileId: z.string().min(1).max(128).optional(),
    }),
    z.object({
      mesh: z.literal(true),
      copyId: z.string().min(1).max(128),
      destPath: commandPathSchema,
      fileId: z.string().min(1).max(128).optional(),
    }),
  ]),
  peer_offer: z.union([
    z.object({
      ticket: z.lazy(() => peerTicketSchema),
      fileId: z.string().min(1).max(128).optional(),
    }),
    z.object({
      mesh: z.literal(true),
      copyId: z.string().min(1).max(128),
      destDeviceId: z.string().min(1).max(128),
      srcPath: commandPathSchema,
      destPath: commandPathSchema,
      addrs: z.array(z.string().min(1).max(64)).max(PEER_LAN_ADDRS_MAX),
      port: z.number().int().min(1).max(65535),
      fileId: z.string().min(1).max(128).optional(),
    }),
  ]),
} as const satisfies Record<CommandType, z.ZodType>

export const peerTicketSchema = z.object({
  copyId: z.string().min(1).max(128),
  srcDeviceId: z.string().min(1).max(128),
  dstDeviceId: z.string().min(1).max(128),
  srcPath: commandPathSchema,
  destPath: commandPathSchema,
  exp: z.number().int().positive(),
  maxBytes: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
  addrs: z.array(z.string().min(1).max(64)).max(PEER_LAN_ADDRS_MAX),
  sig: z.string().regex(/^[0-9a-f]{64}$/i),
})

export const peerCopyRequestSchema = z.object({
  destDeviceId: z.string().min(1).max(128),
  srcPath: commandPathSchema,
  destPath: commandPathSchema,
})

export function validateCommandPayload(
  type: CommandType,
  payload: Record<string, unknown>
): { ok: true; payload: Record<string, unknown> } | { ok: false; error: z.ZodError } {
  const forward =
    typeof payload[MESH_FORWARD_KEY] === "string" && (payload[MESH_FORWARD_KEY] as string).trim()
      ? String(payload[MESH_FORWARD_KEY]).trim()
      : undefined
  const rest = { ...payload }
  delete rest[MESH_FORWARD_KEY]
  const schema = commandPayloadSchemas[type]
  const parsed = schema.safeParse(rest)
  if (!parsed.success) return { ok: false, error: parsed.error }
  const out = parsed.data as Record<string, unknown>
  if (forward) out[MESH_FORWARD_KEY] = forward
  return { ok: true, payload: out }
}

export type RegisterInput = z.infer<typeof registerSchema>
export type HeartbeatInput = z.infer<typeof heartbeatSchema>
export type CommandResultInput = z.infer<typeof commandResultSchema>
export type CreateCommandInput = z.infer<typeof createCommandSchema>
export type DeleteDeviceCommandsInput = z.infer<typeof deleteDeviceCommandsSchema>
export type RunPluginPayload = z.infer<typeof runPluginPayloadSchema>
export type StampPackInput = z.infer<typeof stampPackSchema>
export type CommandTemplateWrite = z.infer<typeof commandTemplateWriteSchema>
export type PluginFromTemplateInput = z.infer<typeof pluginFromTemplateSchema>
export type E2ESessionRequest = z.infer<typeof e2eSessionRequestSchema>
export type AgentConfigInput = z.infer<typeof agentConfigSchema>
export type PeerTicket = z.infer<typeof peerTicketSchema>
export type PeerCopyRequest = z.infer<typeof peerCopyRequestSchema>
export type MeshForwardRequest = z.infer<typeof meshForwardRequestSchema>
