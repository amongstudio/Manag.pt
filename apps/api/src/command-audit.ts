import { createHash } from "node:crypto"

import {
  AUDITED_COMMANDS,
  isClipboardResultCommand,
  stripCredentialSecrets,
  summarizeClipboardResult,
} from "@workspace/shared"

const AUDIT_PAYLOAD_MAX = 2000

export function isAuditedCommand(type: string): boolean {
  return (AUDITED_COMMANDS as ReadonlySet<string>).has(type)
}

/**
 * Audit-safe payload: secrets redacted, script bodies replaced by length and
 * SHA-256, and anything still large reduced to its key names.
 */
export function auditPayload(
  type: string,
  payload: Record<string, unknown>
): Record<string, unknown> {
  const redacted = stripCredentialSecrets(payload) as Record<string, unknown>
  if (type === "run_script" && typeof redacted.script === "string") {
    const script = redacted.script
    redacted.script = undefined
    redacted.scriptBytes = Buffer.byteLength(script, "utf8")
    redacted.scriptSha256 = createHash("sha256").update(script).digest("hex")
  }
  const text = JSON.stringify(redacted)
  if (text.length > AUDIT_PAYLOAD_MAX)
    return { truncated: true, keys: Object.keys(redacted).slice(0, 20) }
  return JSON.parse(text) as Record<string, unknown>
}

/** Result shape for list/socket/alert views; full clipboard content only via GET /admin/commands/:id. */
export function listSafeResult(type: string, result: unknown): unknown {
  return isClipboardResultCommand(type)
    ? summarizeClipboardResult(result)
    : result
}
