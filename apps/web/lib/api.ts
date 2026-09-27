export function operatorToken(): string {
  if (typeof window === "undefined") {
    return process.env.OPERATOR_TOKEN || process.env.NEXT_PUBLIC_OPERATOR_TOKEN || ""
  }
  return sessionToken() || process.env.NEXT_PUBLIC_OPERATOR_TOKEN || ""
}

const SESSION_KEY = "pc_operator_session"

export function sessionToken(): string {
  if (typeof window === "undefined") return ""
  try {
    return sessionStorage.getItem(SESSION_KEY) || ""
  } catch {
    return ""
  }
}

export function storeSessionToken(token: string | null): void {
  if (typeof window === "undefined") return
  try {
    if (!token) sessionStorage.removeItem(SESSION_KEY)
    else sessionStorage.setItem(SESSION_KEY, token)
  } catch {
    /* ignore */
  }
}

export function applyOperatorAuth(headers: Headers): void {
  const token = operatorToken()
  if (token) headers.set("x-operator-token", token)
}

export function operatorAuthHeaders(): Record<string, string> {
  const token = operatorToken()
  return token ? { "x-operator-token": token } : {}
}

/** Same-origin img/download GETs cannot set headers; the API also accepts this cookie. */
export function syncOperatorCookie(): void {
  if (typeof document === "undefined") return
  const token = operatorToken()
  if (!token) return
  document.cookie = `pc_operator_token=${encodeURIComponent(token)}; Path=/; SameSite=Lax`
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  applyOperatorAuth(headers)
  if (init?.body && !(init.body instanceof FormData) && !headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }
  const res = await fetch(path, {
    ...init,
    headers,
    credentials: "include",
  })
  if (!res.ok) {
    let message = res.statusText || `request failed (${res.status})`
    try {
      const body = (await res.json()) as { error?: string; message?: string }
      if (body.error) message = body.error
      else if (body.message) message = body.message
    } catch {
      /* ignore */
    }
    throw new Error(message)
  }
  if (res.status === 204) return undefined as T
  const text = await res.text()
  if (!text) return undefined as T
  return JSON.parse(text) as T
}

export function wsUrl(): string {
  if (process.env.NEXT_PUBLIC_WS_URL) return process.env.NEXT_PUBLIC_WS_URL
  // Same-origin /ws is rewritten to the API in next.config. Production Caddy also proxies /ws.
  return ""
}

export function formatWhen(value: string | Date | null | undefined): string {
  if (value == null || value === "") return "—"
  const date = typeof value === "string" ? new Date(value) : value
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "—"
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)
}

export function formatPct(value: number): string {
  return `${value.toFixed(0)}%`
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export function formatRate(n: number): string {
  return `${formatBytes(n)}/s`
}

export function snippet(value: unknown, max = 140): string {
  if (value == null) return ""
  const text = typeof value === "string" ? value : JSON.stringify(value)
  return text.length > max ? `${text.slice(0, max)}…` : text
}
