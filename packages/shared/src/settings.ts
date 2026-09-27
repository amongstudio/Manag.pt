import { z } from "zod"

import { APP_EMAIL, APP_NAME } from "./constants.ts"
import { DEFAULT_MESH_POLICY, meshPolicySchema, type MeshPolicy } from "./mesh.ts"

export const SETTING_KEYS = {
  notifications: "notifications",
  security: "security",
} as const

export type AppSettings = {
  telegram: {
    enabled: boolean
    botToken: string
    chatId: string
    notifyOnline: boolean
    notifyOffline: boolean
    notifyHighCpu: boolean
    notifyHighMemory: boolean
    notifyDiskLow: boolean
    notifyCommandFailure: boolean
    notifyKillSwitch: boolean
    notifyHeartbeatMissed: boolean
  }
  discord: {
    enabled: boolean
    webhookUrl: string
    username: string
  }
  smtp: {
    enabled: boolean
    host: string
    port: number
    username: string
    password: string
    fromEmail: string
    fromName: string
    adminEmails: string[]
  }
  thresholds: {
    cpu: number
    ram: number
    disk: number
    heartbeatTimeoutSec: number
    offlineThresholdSec: number
    alertCooldownSec: number
  }
  retention: {
    statsDays: number
    logsDays: number
    commandsDays: number
    screenshotsDays: number
    notificationsDays: number
    filesDays: number
  }
  agent: {
    heartbeatIntervalSec: number
    pollIntervalSec: number
    screenshotIntervalSec: number
    autoRestartTime: string
    sandboxRoots: string[]
    commandTimeoutMin: number
    lightweight: boolean
    idleHeartbeatSec: number
    watchedHeartbeatSec: number
  }
  llm: {
    baseUrl: string
    apiKey: string
    model: string
  }
  mesh: MeshPolicy
}

export const DEFAULT_SETTINGS: AppSettings = {
  telegram: {
    enabled: false,
    botToken: "",
    chatId: "",
    notifyOnline: true,
    notifyOffline: true,
    notifyHighCpu: true,
    notifyHighMemory: true,
    notifyDiskLow: true,
    notifyCommandFailure: true,
    notifyKillSwitch: true,
    notifyHeartbeatMissed: true,
  },
  discord: {
    enabled: false,
    webhookUrl: "",
    username: APP_NAME,
  },
  smtp: {
    enabled: false,
    host: "",
    port: 587,
    username: "",
    password: "",
    fromEmail: APP_EMAIL,
    fromName: APP_NAME,
    adminEmails: [],
  },
  thresholds: {
    cpu: 90,
    ram: 90,
    disk: 85,
    heartbeatTimeoutSec: 3600,
    offlineThresholdSec: 7200,
    alertCooldownSec: 1800,
  },
  retention: {
    statsDays: 14,
    logsDays: 30,
    commandsDays: 90,
    screenshotsDays: 14,
    notificationsDays: 60,
    filesDays: 30,
  },
  agent: {
    heartbeatIntervalSec: 90,
    pollIntervalSec: 15,
    screenshotIntervalSec: 0,
    autoRestartTime: "",
    sandboxRoots: [],
    commandTimeoutMin: 15,
    lightweight: true,
    idleHeartbeatSec: 90,
    watchedHeartbeatSec: 15,
  },
  llm: {
    baseUrl: "",
    apiKey: "",
    model: "gpt-4o-mini",
  },
  mesh: { ...DEFAULT_MESH_POLICY },
}

export function redactSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    telegram: {
      ...settings.telegram,
      botToken: settings.telegram.botToken ? "••••••••" : "",
    },
    discord: {
      ...settings.discord,
      webhookUrl: settings.discord.webhookUrl ? "••••••••" : "",
    },
    smtp: {
      ...settings.smtp,
      password: settings.smtp.password ? "••••••••" : "",
    },
    llm: {
      ...settings.llm,
      apiKey: settings.llm.apiKey ? "••••••••" : "",
    },
    mesh: { ...DEFAULT_MESH_POLICY, ...settings.mesh },
  }
}

const REDACT_CHAR = "•"

/**
 * Secret-bearing field. Accepts empty, a redacted placeholder echoed back by the
 * dashboard (contains "•", the server keeps the stored value), or a real value
 * matching `pattern`.
 */
function secretField(max: number, pattern: RegExp, message: string) {
  return z
    .string()
    .max(max)
    .refine((v) => v === "" || v.includes(REDACT_CHAR) || pattern.test(v), message)
}

const emptyOrEmail = z
  .string()
  .max(254)
  .regex(/^$|^[^\s@]+@[^\s@]+\.[^\s@]+$/, "invalid email")

export const telegramSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  botToken: secretField(256, /^\d{1,16}:[A-Za-z0-9_-]{10,}$/, "invalid bot token"),
  chatId: z.string().max(64).regex(/^$|^-?\d{1,20}$|^@[A-Za-z0-9_]{3,64}$/, "invalid chat id"),
  notifyOnline: z.boolean(),
  notifyOffline: z.boolean(),
  notifyHighCpu: z.boolean(),
  notifyHighMemory: z.boolean(),
  notifyDiskLow: z.boolean(),
  notifyCommandFailure: z.boolean(),
  notifyKillSwitch: z.boolean(),
  notifyHeartbeatMissed: z.boolean(),
})

export const discordSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  webhookUrl: secretField(
    512,
    /^https:\/\/(?:[a-z0-9-]+\.)?discord(?:app)?\.com\/api\/webhooks\//i,
    "must be a https://discord.com/api/webhooks/... URL"
  ),
  username: z.string().max(80),
})

export const smtpSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  host: z
    .string()
    .max(253)
    .regex(/^$|^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/, "invalid hostname"),
  port: z.number().int().min(1).max(65_535),
  username: z.string().max(256),
  password: secretField(256, /^[^\r\n]*$/, "invalid password"),
  fromEmail: emptyOrEmail,
  fromName: z.string().max(128),
  adminEmails: z.array(emptyOrEmail.refine((v) => v !== "", "email required")).max(20),
})

export const thresholdSettingsSchema = z.strictObject({
  cpu: z.number().min(1).max(100),
  ram: z.number().min(1).max(100),
  disk: z.number().min(1).max(100),
  heartbeatTimeoutSec: z.number().int().min(10).max(604_800),
  offlineThresholdSec: z.number().int().min(30).max(2_592_000),
  alertCooldownSec: z.number().int().min(0).max(604_800),
})

const retentionDays = z.number().int().min(1).max(3650)

export const retentionSettingsSchema = z.strictObject({
  statsDays: retentionDays,
  logsDays: retentionDays,
  commandsDays: retentionDays,
  screenshotsDays: retentionDays,
  notificationsDays: retentionDays,
  filesDays: retentionDays,
})

export const agentSettingsSchema = z.strictObject({
  heartbeatIntervalSec: z.number().int().min(5).max(3600),
  pollIntervalSec: z.number().int().min(1).max(3600),
  screenshotIntervalSec: z.number().int().min(0).max(86_400),
  autoRestartTime: z.string().regex(/^$|^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM or empty"),
  sandboxRoots: z.array(z.string().min(1).max(1024)).max(64),
  commandTimeoutMin: z.number().int().min(1).max(1440),
  lightweight: z.boolean(),
  idleHeartbeatSec: z.number().int().min(5).max(3600),
  watchedHeartbeatSec: z.number().int().min(5).max(3600),
})

export const llmSettingsSchema = z.strictObject({
  baseUrl: z
    .string()
    .max(2048)
    .refine((v) => v === "" || /^https?:\/\//i.test(v), "must be an http(s) URL"),
  apiKey: secretField(512, /^[^\r\n]*$/, "invalid api key"),
  model: z.string().max(128),
})

export const appSettingsSchema = z.strictObject({
  telegram: telegramSettingsSchema,
  discord: discordSettingsSchema,
  smtp: smtpSettingsSchema,
  thresholds: thresholdSettingsSchema,
  retention: retentionSettingsSchema,
  agent: agentSettingsSchema,
  llm: llmSettingsSchema,
  mesh: meshPolicySchema,
})

/** Deep-partial settings patch: each section optional, each field within optional. */
export const appSettingsPatchSchema = z.strictObject({
  telegram: telegramSettingsSchema.partial().optional(),
  discord: discordSettingsSchema.partial().optional(),
  smtp: smtpSettingsSchema.partial().optional(),
  thresholds: thresholdSettingsSchema.partial().optional(),
  retention: retentionSettingsSchema.partial().optional(),
  agent: agentSettingsSchema.partial().optional(),
  llm: llmSettingsSchema.partial().optional(),
  mesh: meshPolicySchema.partial().optional(),
})

export type AppSettingsPatch = {
  [K in keyof AppSettings]?: Partial<AppSettings[K]>
}
