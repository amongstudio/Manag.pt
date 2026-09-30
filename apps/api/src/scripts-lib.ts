export const SCRIPT_LANGUAGES = ["powershell", "python", "batch", "shell"] as const
export type ScriptLanguage = (typeof SCRIPT_LANGUAGES)[number]

export type ScriptParameter = { name: string; default?: string; pattern?: string }

/** Anchored, compilable, and short: a parameter pattern can only narrow input. */
export function validParameterPattern(pattern: string): boolean {
  if (pattern.length < 2 || pattern.length > 200 || !pattern.startsWith("^") || !pattern.endsWith("$")) return false
  try {
    new RegExp(pattern)
    return true
  } catch {
    return false
  }
}

export class ScriptParameterError extends Error {
  constructor(readonly parameter: string) {
    super(`invalid_parameter:${parameter}`)
  }
}

export type ScriptWrite = {
  name: string
  description: string
  language: ScriptLanguage
  content: string
  parameters: ScriptParameter[]
  timeoutSeconds: number
}

const NAME = /^[A-Za-z0-9_]+$/

export function validateScriptWrite(body: unknown): { ok: true; value: ScriptWrite } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "invalid_body" }
  const raw = body as Record<string, unknown>
  const name = typeof raw.name === "string" ? raw.name.trim() : ""
  if (name.length < 1 || name.length > 120) return { ok: false, error: "invalid_name" }
  const description = typeof raw.description === "string" ? raw.description.slice(0, 2000) : ""
  const language = raw.language
  if (typeof language !== "string" || !SCRIPT_LANGUAGES.includes(language as ScriptLanguage)) {
    return { ok: false, error: "invalid_language" }
  }
  const content = typeof raw.content === "string" ? raw.content : ""
  if (content.length < 1 || content.length > 65_536) return { ok: false, error: "invalid_content" }
  const timeoutSeconds = raw.timeoutSeconds == null ? 60 : Number(raw.timeoutSeconds)
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) {
    return { ok: false, error: "invalid_timeout" }
  }
  const parameters = parseParameters(raw.parameters)
  if (!parameters) return { ok: false, error: "invalid_parameters" }
  return {
    ok: true,
    value: { name, description, language: language as ScriptLanguage, content, parameters, timeoutSeconds },
  }
}

function parseParameters(value: unknown): ScriptParameter[] | null {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > 20) return null
  const out: ScriptParameter[] = []
  for (const item of value) {
    if (!item || typeof item !== "object") return null
    const row = item as Record<string, unknown>
    const name = typeof row.name === "string" ? row.name.trim() : ""
    if (!NAME.test(name) || name.length > 64) return null
    const fallback = row.default == null ? undefined : String(row.default)
    if (fallback != null && fallback.length > 1024) return null
    const pattern = typeof row.pattern === "string" && row.pattern !== "" ? row.pattern : undefined
    if (pattern != null && !validParameterPattern(pattern)) return null
    if (pattern != null && fallback != null && fallback !== "" && !new RegExp(pattern).test(fallback)) return null
    out.push({ name, ...(fallback == null ? {} : { default: fallback }), ...(pattern == null ? {} : { pattern }) })
  }
  return out
}

export function renderScript(content: string, parameters: Record<string, string>): string {
  return content.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_match, name: string) => {
    const value = parameters[name]
    return value == null ? "" : value.slice(0, 1024)
  })
}

/**
 * Throws ScriptParameterError when a value has a line break or NUL (which could
 * add statements) or fails the parameter's pattern.
 */
export function resolveParameters(
  defined: ScriptParameter[],
  provided: Record<string, unknown> | undefined
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const param of defined) {
    const given = provided?.[param.name]
    const value = typeof given === "string" && given !== "" ? given : (param.default ?? "")
    if (value.length > 1024 || /[\r\n\0]/.test(value)) throw new ScriptParameterError(param.name)
    if (param.pattern && !new RegExp(param.pattern).test(value)) throw new ScriptParameterError(param.name)
    out[param.name] = value
  }
  return out
}
