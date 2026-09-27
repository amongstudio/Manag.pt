export function resultErrorMessage(
  result: unknown,
  status?: string,
  fallback = "Command failed"
): string {
  const unwrapped = unwrapCommandResult(result)
  if (unwrapped && typeof unwrapped === "object" && "error" in unwrapped) {
    const err = (unwrapped as { error?: unknown }).error
    if (typeof err === "string" && err.trim()) return err
  }
  if (typeof unwrapped === "string" && unwrapped.trim()) return unwrapped
  if (status === "cancelled") return "Cancelled"
  if (status === "timeout") return "Timed out"
  return fallback
}

/** True when a "success" result is only `{ error }` (e.g. result_too_large). */
export function resultPayloadError(result: unknown): string | null {
  const unwrapped = unwrapCommandResult(result)
  if (!unwrapped || typeof unwrapped !== "object" || Array.isArray(unwrapped)) return null
  const rec = unwrapped as Record<string, unknown>
  if (typeof rec.error !== "string" || !rec.error.trim()) return null
  const keys = Object.keys(rec).filter((key) => key !== "error" && key !== "progress")
  if (keys.length === 0) return rec.error
  return null
}

const RESULT_ENVELOPE_KEYS = new Set(["status", "id", "type", "deviceId"])

function nestedLooksLikePayload(nested: object): boolean {
  if (Array.isArray(nested)) return true
  const inner = nested as Record<string, unknown>
  return (
    inner.rules != null ||
    inner.volumes != null ||
    inner.capabilities != null ||
    inner.profiles != null ||
    inner.entries != null ||
    inner.pending != null ||
    inner.installed != null ||
    inner.shares != null ||
    inner.adapters != null ||
    inner.ports != null ||
    inner.services != null ||
    inner.tasks != null ||
    inner.error != null
  )
}

/** Parse a JSON string or nested `{ result }` envelope from command payloads. */
export function unwrapCommandResult(result: unknown): unknown {
  let cur: unknown = result
  if (typeof cur === "string") {
    const s = cur.trim()
    if (s.startsWith("{") || s.startsWith("[")) {
      try {
        cur = JSON.parse(s) as unknown
      } catch {
        return result
      }
    }
  }
  if (cur && typeof cur === "object" && !Array.isArray(cur)) {
    const rec = cur as Record<string, unknown>
    if (typeof rec.error === "string" && rec.error.trim()) {
      return cur
    }
    const nested = rec.result
    if (nested && typeof nested === "object") {
      const extras = Object.keys(rec).filter((key) => key !== "result" && key !== "progress")
      if (extras.every((key) => RESULT_ENVELOPE_KEYS.has(key))) {
        return nested
      }
      if (
        nestedLooksLikePayload(nested) &&
        rec.rules == null &&
        rec.volumes == null &&
        rec.capabilities == null &&
        rec.entries == null &&
        rec.shares == null &&
        rec.adapters == null &&
        rec.ports == null &&
        rec.services == null &&
        rec.tasks == null &&
        rec.pending == null &&
        rec.installed == null &&
        rec.profiles == null
      ) {
        return nested
      }
    }
  }
  return cur
}
