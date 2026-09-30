export type CronFields = {
  minute: number[]
  hour: number[]
  dom: number[]
  month: number[]
  dow: number[]
  anyDom: boolean
  anyDow: boolean
}

function expand(token: string, min: number, max: number): number[] | null {
  const values = new Set<number>()
  for (const part of token.split(",")) {
    const piece = part.trim()
    if (!piece) return null
    const stepSplit = piece.split("/")
    if (stepSplit.length > 2) return null
    const step = stepSplit.length === 2 ? Number(stepSplit[1]) : 1
    if (!Number.isInteger(step) || step < 1) return null
    const head = stepSplit[0] ?? ""
    const range = head === "*" ? `${min}-${max}` : head
    const bounds = range.split("-")
    if (bounds.length > 2) return null
    const start = Number(bounds[0])
    const end = bounds.length === 2 ? Number(bounds[1]) : start
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) return null
    if (head !== "*" && bounds.length === 1 && stepSplit.length === 2) return null
    for (let n = start; n <= end; n += step) values.add(n)
  }
  return [...values].sort((a, b) => a - b)
}

export function parseCron(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const minute = expand(parts[0]!, 0, 59)
  const hour = expand(parts[1]!, 0, 23)
  const dom = expand(parts[2]!, 1, 31)
  const month = expand(parts[3]!, 1, 12)
  const dow = expand(parts[4]!, 0, 7)
  if (!minute || !hour || !dom || !month || !dow) return null
  const normalizedDow = dow.map((value) => (value === 7 ? 0 : value))
  return {
    minute,
    hour,
    dom,
    month,
    dow: [...new Set(normalizedDow)].sort((a, b) => a - b),
    anyDom: parts[2] === "*",
    anyDow: parts[4] === "*",
  }
}

export function cronMatches(expr: string, date: Date): boolean {
  const fields = parseCron(expr)
  if (!fields) return false
  const minute = date.getUTCMinutes()
  const hour = date.getUTCHours()
  const dom = date.getUTCDate()
  const month = date.getUTCMonth() + 1
  const dow = date.getUTCDay()
  if (!fields.minute.includes(minute) || !fields.hour.includes(hour) || !fields.month.includes(month)) return false
  const domOk = fields.dom.includes(dom)
  const dowOk = fields.dow.includes(dow)
  if (fields.anyDom && fields.anyDow) return true
  if (fields.anyDom) return dowOk
  if (fields.anyDow) return domOk
  return domOk || dowOk
}

export function minuteStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes()))
}
