export const UPDATE_APPROVALS = ["pending", "approved", "deferred", "installing", "installed", "failed"] as const
export type UpdateApproval = (typeof UPDATE_APPROVALS)[number]
export const REBOOT_POLICIES = ["never", "if_required", "scheduled"] as const
export type RebootPolicy = (typeof REBOOT_POLICIES)[number]

const TRANSITIONS: Record<UpdateApproval, UpdateApproval[]> = {
  pending: ["approved", "deferred"],
  approved: ["deferred", "installing"],
  deferred: ["approved", "pending"],
  installing: ["installed", "failed", "approved"],
  installed: [],
  failed: ["approved", "pending"],
}

export function nextUpdateApproval(current: string, action: string): UpdateApproval | null {
  const from = UPDATE_APPROVALS.find((item) => item === current)
  const to = UPDATE_APPROVALS.find((item) => item === action)
  if (!from || !to) return null
  return TRANSITIONS[from].includes(to) ? to : null
}

export function inMaintenanceWindow(now: Date, start: string, end: string): boolean {
  if (!start && !end) return true
  const startMin = clockMinutes(start)
  const endMin = clockMinutes(end)
  if (startMin == null || endMin == null) return false
  const current = now.getHours() * 60 + now.getMinutes()
  if (startMin === endMin) return true
  if (startMin < endMin) return current >= startMin && current < endMin
  return current >= startMin || current < endMin
}

function clockMinutes(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim())
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

export function normalizeKb(value: string): string | null {
  const kb = value.trim().toUpperCase()
  return /^KB\d{4,10}$/.test(kb) ? kb : null
}
