import { REGISTRY_AGENT_KEY_PATH } from "./constants.ts"

export const REGISTRY_COMMAND_TYPES = ["get_registry", "set_registry", "delete_registry"] as const
export type RegistryCommandType = (typeof REGISTRY_COMMAND_TYPES)[number]

export const REGISTRY_HIVES = ["HKLM", "HKCU"] as const
export type RegistryHive = (typeof REGISTRY_HIVES)[number]

export const REGISTRY_VALUE_TYPES = [
  "REG_SZ",
  "REG_EXPAND_SZ",
  "REG_DWORD",
  "REG_QWORD",
  "REG_MULTI_SZ",
  "REG_BINARY",
] as const
export type RegistryValueType = (typeof REGISTRY_VALUE_TYPES)[number]

export const REGISTRY_WELL_KNOWN = [
  { hive: "HKLM" as const, path: "", label: "HKLM" },
  { hive: "HKLM" as const, path: "SOFTWARE", label: "HKLM\\SOFTWARE" },
  { hive: "HKLM" as const, path: REGISTRY_AGENT_KEY_PATH, label: "Agent (HKLM)" },
  { hive: "HKCU" as const, path: REGISTRY_AGENT_KEY_PATH, label: "Agent (HKCU)" },
  { hive: "HKLM" as const, path: "SOFTWARE\\Microsoft\\Windows\\CurrentVersion", label: "CurrentVersion" },
  { hive: "HKLM" as const, path: "SYSTEM\\CurrentControlSet\\Services", label: "Services" },
  { hive: "HKCU" as const, path: "", label: "HKCU" },
  { hive: "HKCU" as const, path: "SOFTWARE", label: "HKCU\\SOFTWARE" },
] as const

export type RegistryValue = {
  name: string
  type: string
  data?: unknown
  truncated?: boolean
}

export type ParsedRegistryKey = {
  hive: string
  path: string
  keys: string[]
  values: RegistryValue[]
  truncated: boolean
}

export type RegistryCommandSeed = {
  id: string
  type: string
  status: string
  result?: unknown
}

export function isRegistryCommandType(type: string): type is RegistryCommandType {
  return (REGISTRY_COMMAND_TYPES as readonly string[]).includes(type)
}

export function isRegistryHive(value: string): value is RegistryHive {
  return (REGISTRY_HIVES as readonly string[]).includes(value)
}

export function normalizeRegistryPath(path: string): string {
  return path
    .replaceAll("/", "\\")
    .split("\\")
    .map((p) => p.trim())
    .filter((p) => p && p !== ".")
    .join("\\")
}

export function registryDisplayPath(hive: string, path: string): string {
  const p = normalizeRegistryPath(path)
  return p ? `${hive}\\${p}` : hive
}

export function registryCrumbs(hive: string, path: string): Array<{ hive: string; path: string; label: string }> {
  const crumbs = [{ hive, path: "", label: hive }]
  const parts = normalizeRegistryPath(path).split("\\").filter(Boolean)
  let acc = ""
  for (const part of parts) {
    acc = acc ? `${acc}\\${part}` : part
    crumbs.push({ hive, path: acc, label: part })
  }
  return crumbs
}

export function parentRegistryPath(path: string): string {
  const parts = normalizeRegistryPath(path).split("\\").filter(Boolean)
  if (parts.length <= 1) return ""
  return parts.slice(0, -1).join("\\")
}

export function joinRegistryPath(base: string, name: string): string {
  const left = normalizeRegistryPath(base)
  const right = name.replaceAll("/", "\\").trim()
  if (!left) return right
  if (!right) return left
  return `${left}\\${right}`
}

const DANGEROUS_PATH = [
  /\\CurrentVersion\\Run(?:Once(?:Ex)?)?$/i,
  /\\CurrentVersion\\Policies\\Explorer\\Run$/i,
  /\\Windows NT\\CurrentVersion\\Winlogon$/i,
  /\\Image File Execution Options(?:\\|$)/i,
]

/** Documented keys that can affect logon or image launch. Writes still go through after operator confirm. */
export function isDangerousRegistryPath(hive: string, path: string): boolean {
  const full = registryDisplayPath(hive, path)
  return DANGEROUS_PATH.some((re) => re.test(full))
}

function isRegistryValue(value: unknown): value is RegistryValue {
  if (!value || typeof value !== "object") return false
  const rec = value as { name?: unknown; type?: unknown }
  return typeof rec.name === "string" && typeof rec.type === "string"
}

export function parseRegistryKey(result: unknown): ParsedRegistryKey | null {
  if (!result || typeof result !== "object") return null
  const rec = result as {
    hive?: unknown
    path?: unknown
    keys?: unknown
    values?: unknown
    truncated?: unknown
  }
  if (typeof rec.hive !== "string" || !isRegistryHive(rec.hive)) return null
  const keys = Array.isArray(rec.keys) ? rec.keys.filter((k): k is string => typeof k === "string") : []
  const values = Array.isArray(rec.values) ? rec.values.filter(isRegistryValue) : []
  return {
    hive: rec.hive,
    path: typeof rec.path === "string" ? rec.path : "",
    keys,
    values,
    truncated: Boolean(rec.truncated),
  }
}

export function latestSuccessfulRegistry(commands: RegistryCommandSeed[]): RegistryCommandSeed | undefined {
  return commands.find((c) => c.type === "get_registry" && c.status === "success")
}

export function formatRegistryData(value: RegistryValue): string {
  const data = value.data
  if (data == null) return ""
  if (Array.isArray(data)) return data.map((v) => String(v)).join("\n")
  if (typeof data === "number") {
    if (value.type === "REG_DWORD") return `${data} (0x${(data >>> 0).toString(16)})`
    return String(data)
  }
  return String(data)
}
