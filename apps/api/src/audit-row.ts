export type AuditInput = {
  actor: string
  action: string
  deviceId?: string | null
  detail?: unknown
}

export function buildAuditRow(input: AuditInput): {
  actor: string
  action: string
  deviceId: string | null
  detail: string
} {
  let detail = "{}"
  try {
    detail = JSON.stringify(input.detail ?? {})
  } catch {
    detail = JSON.stringify({ error: "unserializable" })
  }
  if (detail.length > 8000) detail = JSON.stringify({ truncated: true })
  return {
    actor: (input.actor || "operator").slice(0, 128),
    action: input.action.slice(0, 80),
    deviceId: input.deviceId ?? null,
    detail,
  }
}
