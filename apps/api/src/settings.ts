import { prisma } from "@workspace/db"
import { DEFAULT_SETTINGS, appSettingsPatchSchema, type AppSettings, type AppSettingsPatch } from "@workspace/shared"

const KEY = "app"
const SETTINGS_TTL_MS = 5_000

let cache: { settings: AppSettings; expiresAt: number } | null = null

function invalidateSettingsCache(): void {
  cache = null
}

function mergeSettings(raw: unknown): AppSettings {
  const parsed = (raw ?? {}) as Partial<AppSettings>
  return {
    telegram: { ...DEFAULT_SETTINGS.telegram, ...parsed.telegram },
    teams: { ...DEFAULT_SETTINGS.teams, ...parsed.teams },
    discord: { ...DEFAULT_SETTINGS.discord, ...parsed.discord },
    smtp: { ...DEFAULT_SETTINGS.smtp, ...parsed.smtp },
    thresholds: { ...DEFAULT_SETTINGS.thresholds, ...parsed.thresholds },
    retention: { ...DEFAULT_SETTINGS.retention, ...parsed.retention },
    agent: {
      ...DEFAULT_SETTINGS.agent,
      ...parsed.agent,
      sandboxRoots: Array.isArray(parsed.agent?.sandboxRoots)
        ? parsed.agent.sandboxRoots.filter((item) => typeof item === "string")
        : DEFAULT_SETTINGS.agent.sandboxRoots,
    },
    llm: {
      ...DEFAULT_SETTINGS.llm,
      ...(parsed.llm && typeof parsed.llm === "object" ? parsed.llm : {}),
    },
    mesh: {
      ...DEFAULT_SETTINGS.mesh,
      ...(parsed.mesh && typeof parsed.mesh === "object" ? parsed.mesh : {}),
      allowCommands: Array.isArray(parsed.mesh?.allowCommands)
        ? parsed.mesh.allowCommands.filter((item) => typeof item === "string")
        : DEFAULT_SETTINGS.mesh.allowCommands,
    },
  }
}

async function loadSettings(): Promise<AppSettings> {
  const row = await prisma.setting.findUnique({ where: { key: KEY } })
  if (!row) {
    await prisma.setting.create({ data: { key: KEY, value: JSON.stringify(DEFAULT_SETTINGS) } })
    return DEFAULT_SETTINGS
  }
  try {
    return mergeSettings(JSON.parse(row.value) as unknown)
  } catch {
    return DEFAULT_SETTINGS
  }
}

export async function getSettings(): Promise<AppSettings> {
  if (cache && cache.expiresAt > Date.now()) return cache.settings
  const settings = await loadSettings()
  cache = { settings, expiresAt: Date.now() + SETTINGS_TTL_MS }
  return settings
}

export async function saveSettings(next: AppSettings): Promise<AppSettings> {
  await prisma.setting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  })
  invalidateSettingsCache()
  return next
}

export function parseSettingsPatch(body: unknown): AppSettingsPatch {
  const parsed = appSettingsPatchSchema.parse(body)
  return parsed
}

export async function patchSettings(patch: AppSettingsPatch): Promise<AppSettings> {
  const current = await getSettings()
  const keepSecret = (incoming: string | undefined, existing: string) =>
    !incoming || incoming.includes("•") ? existing : incoming

  const next: AppSettings = {
    telegram: {
      ...current.telegram,
      ...patch.telegram,
      botToken: keepSecret(patch.telegram?.botToken, current.telegram.botToken),
    },
    teams: {
      ...current.teams,
      ...patch.teams,
      webhookUrl: keepSecret(patch.teams?.webhookUrl, current.teams.webhookUrl),
    },
    discord: {
      ...current.discord,
      ...patch.discord,
      webhookUrl: keepSecret(patch.discord?.webhookUrl, current.discord.webhookUrl),
    },
    smtp: {
      ...current.smtp,
      ...patch.smtp,
      password: keepSecret(patch.smtp?.password, current.smtp.password),
    },
    thresholds: { ...current.thresholds, ...patch.thresholds },
    retention: { ...current.retention, ...patch.retention },
    agent: {
      ...current.agent,
      ...patch.agent,
      sandboxRoots: patch.agent?.sandboxRoots ?? current.agent.sandboxRoots,
      heartbeatIntervalSec:
        patch.agent?.idleHeartbeatSec ?? patch.agent?.heartbeatIntervalSec ?? current.agent.heartbeatIntervalSec,
    },
    llm: {
      ...DEFAULT_SETTINGS.llm,
      ...current.llm,
      ...patch.llm,
      apiKey: keepSecret(patch.llm?.apiKey, current.llm?.apiKey ?? ""),
    },
    mesh: {
      ...DEFAULT_SETTINGS.mesh,
      ...current.mesh,
      ...patch.mesh,
      allowCommands: patch.mesh?.allowCommands ?? current.mesh?.allowCommands ?? DEFAULT_SETTINGS.mesh.allowCommands,
    },
  }
  return saveSettings(next)
}
