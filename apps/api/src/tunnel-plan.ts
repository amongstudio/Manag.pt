/**
 * Pure planning, parsing, and secret masking for reverse tunnels.
 * Process spawning lives in tunnel-supervisor.ts. Nothing here opens a socket.
 */

export const TUNNEL_PROVIDERS = ["ngrok", "cloudflare", "localtunnel", "zrok", "pinggy"] as const
export type TunnelProvider = (typeof TUNNEL_PROVIDERS)[number]

export const TUNNEL_STATUSES = ["stopped", "starting", "up", "error"] as const
export type TunnelStatusName = (typeof TUNNEL_STATUSES)[number]

export type TunnelRole = "dashboard" | "api"

export const LOOPBACK = "127.0.0.1"
export const MAX_TUNNEL_RETRIES = 5
export const DEFAULT_WEB_PORT = 3000
export const DEFAULT_API_PORT = 4000
export const DEFAULT_LOCALTUNNEL_HOST = "https://localtunnel.me"

export const INSTALL_COMMANDS: Record<TunnelProvider, string> = {
  ngrok: 'curl -fsSL https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz | tar -xz -C "$HOME/.local/bin"',
  cloudflare:
    'curl -fsSL -o "$HOME/.local/bin/cloudflared" https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x "$HOME/.local/bin/cloudflared"',
  localtunnel: "pnpm --filter api add localtunnel",
  zrok: "curl -sSLf https://get.openziti.io/install.bash | sudo bash -s zrok",
  pinggy: "sudo apt-get install -y openssh-client",
}

const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const SECRET_RE = /^[A-Za-z0-9+/=._~:-]+$/
const PINGGY_TOKEN_RE = /^[A-Za-z0-9._:-]+$/
const MASK_CHAR = "•"

export type TunnelSecrets = {
  ngrokAuthtoken: string
  cloudflareToken: string
  pinggyToken: string
  zrokToken: string
}

export type StoredTunnel = {
  provider: TunnelProvider
  exposeApi: boolean
  subdomain: string
  localtunnelHost: string
  webPort: number
  apiPort: number
  enabled: boolean
  status: TunnelStatusName
  publicUrl: string
  apiPublicUrl: string
  lastError: string
  startedAt: string | null
  retryCount: number
  secrets: TunnelSecrets
}

export type TunnelPatch = {
  provider?: TunnelProvider
  exposeApi?: boolean
  subdomain?: string
  localtunnelHost?: string
  webPort?: number
  apiPort?: number
  ngrokAuthtoken?: string
  cloudflareToken?: string
  pinggyToken?: string
  zrokToken?: string
}

export type TunnelPublic = Omit<StoredTunnel, "secrets"> & {
  secretsSet: Record<keyof TunnelSecrets, boolean>
  install: Record<TunnelProvider, string>
  available: Record<TunnelProvider, boolean>
  commands: { dashboard: string; api: string }
  note: string
}

export const EMPTY_SECRETS: TunnelSecrets = {
  ngrokAuthtoken: "",
  cloudflareToken: "",
  pinggyToken: "",
  zrokToken: "",
}

export const DEFAULT_TUNNEL: StoredTunnel = {
  provider: "ngrok",
  exposeApi: false,
  subdomain: "",
  localtunnelHost: DEFAULT_LOCALTUNNEL_HOST,
  webPort: DEFAULT_WEB_PORT,
  apiPort: DEFAULT_API_PORT,
  enabled: false,
  status: "stopped",
  publicUrl: "",
  apiPublicUrl: "",
  lastError: "",
  startedAt: null,
  retryCount: 0,
  secrets: { ...EMPTY_SECRETS },
}

export type ProcessSpec = {
  kind: "process"
  bin: "ngrok" | "cloudflared" | "zrok" | "ssh"
  args: string[]
  env: Record<string, string>
  redactedCommand: string
  port: number
  role: TunnelRole
}

export type LocaltunnelSpec = {
  kind: "localtunnel"
  port: number
  localHost: typeof LOOPBACK
  subdomain?: string
  host: string
  redactedCommand: string
  role: TunnelRole
}

export type TunnelSpec = ProcessSpec | LocaltunnelSpec

export type TunnelPlan =
  | { ok: true; specs: TunnelSpec[]; note: string }
  | { ok: false; error: string }

const PATCH_KEYS = new Set([
  "provider",
  "exposeApi",
  "subdomain",
  "localtunnelHost",
  "webPort",
  "apiPort",
  "ngrokAuthtoken",
  "cloudflareToken",
  "pinggyToken",
  "zrokToken",
])

export function isTunnelProvider(value: unknown): value is TunnelProvider {
  return typeof value === "string" && (TUNNEL_PROVIDERS as readonly string[]).includes(value)
}

export function isTunnelStatus(value: unknown): value is TunnelStatusName {
  return typeof value === "string" && (TUNNEL_STATUSES as readonly string[]).includes(value)
}

export function validPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535
}

export function validateLocaltunnelHost(host: string): boolean {
  if (host.length > 200) return false
  let url: URL
  try {
    url = new URL(host)
  } catch {
    return false
  }
  if (url.protocol !== "https:") return false
  if (url.username || url.password) return false
  if (url.search || url.hash) return false
  if (url.pathname !== "/" && url.pathname !== "") return false
  return /^[a-z0-9.-]+$/i.test(url.hostname)
}

export function validateSubdomain(value: string): boolean {
  return value === "" || SUBDOMAIN_RE.test(value)
}

function keepSecret(incoming: string | undefined, existing: string): string {
  if (incoming === undefined || incoming === "" || incoming.includes(MASK_CHAR)) return existing
  return incoming
}

function validGenericSecret(value: string): boolean {
  return value === "" || (value.length <= 4096 && SECRET_RE.test(value))
}

function validPinggyToken(value: string): boolean {
  return value === "" || (value.length <= 200 && PINGGY_TOKEN_RE.test(value))
}

export function parseTunnelPatch(body: unknown): { ok: true; patch: TunnelPatch } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "invalid_body" }
  const rec = body as Record<string, unknown>
  for (const key of Object.keys(rec)) {
    if (!PATCH_KEYS.has(key)) return { ok: false, error: "invalid_body" }
  }
  const patch: TunnelPatch = {}
  if ("provider" in rec) {
    if (!isTunnelProvider(rec.provider)) return { ok: false, error: "invalid_provider" }
    patch.provider = rec.provider
  }
  if ("exposeApi" in rec) {
    if (typeof rec.exposeApi !== "boolean") return { ok: false, error: "invalid_body" }
    patch.exposeApi = rec.exposeApi
  }
  if ("subdomain" in rec) {
    if (typeof rec.subdomain !== "string" || !validateSubdomain(rec.subdomain)) return { ok: false, error: "invalid_subdomain" }
    patch.subdomain = rec.subdomain
  }
  if ("localtunnelHost" in rec) {
    if (typeof rec.localtunnelHost !== "string" || !validateLocaltunnelHost(rec.localtunnelHost)) {
      return { ok: false, error: "invalid_host" }
    }
    patch.localtunnelHost = rec.localtunnelHost
  }
  if ("webPort" in rec) {
    if (!validPort(rec.webPort)) return { ok: false, error: "invalid_port" }
    patch.webPort = rec.webPort
  }
  if ("apiPort" in rec) {
    if (!validPort(rec.apiPort)) return { ok: false, error: "invalid_port" }
    patch.apiPort = rec.apiPort
  }
  for (const key of ["ngrokAuthtoken", "cloudflareToken", "zrokToken"] as const) {
    if (!(key in rec)) continue
    if (typeof rec[key] !== "string") return { ok: false, error: "invalid_token" }
    const value = rec[key]
    if (!value.includes(MASK_CHAR) && !validGenericSecret(value)) return { ok: false, error: "invalid_token" }
    patch[key] = value
  }
  if ("pinggyToken" in rec) {
    if (typeof rec.pinggyToken !== "string") return { ok: false, error: "invalid_token" }
    if (!rec.pinggyToken.includes(MASK_CHAR) && !validPinggyToken(rec.pinggyToken)) return { ok: false, error: "invalid_token" }
    patch.pinggyToken = rec.pinggyToken
  }
  if (patch.exposeApi === true && patch.webPort !== undefined && patch.apiPort !== undefined && patch.webPort === patch.apiPort) {
    return { ok: false, error: "ports_must_differ" }
  }
  return { ok: true, patch }
}

export function mergeTunnelConfig(
  current: StoredTunnel,
  patch: TunnelPatch
): { ok: true; value: StoredTunnel } | { ok: false; error: string } {
  const next: StoredTunnel = {
    ...current,
    secrets: { ...current.secrets },
    provider: patch.provider ?? current.provider,
    exposeApi: patch.exposeApi ?? current.exposeApi,
    subdomain: patch.subdomain ?? current.subdomain,
    localtunnelHost: patch.localtunnelHost ?? current.localtunnelHost,
    webPort: patch.webPort ?? current.webPort,
    apiPort: patch.apiPort ?? current.apiPort,
  }
  next.secrets.ngrokAuthtoken = keepSecret(patch.ngrokAuthtoken, current.secrets.ngrokAuthtoken)
  next.secrets.cloudflareToken = keepSecret(patch.cloudflareToken, current.secrets.cloudflareToken)
  next.secrets.pinggyToken = keepSecret(patch.pinggyToken, current.secrets.pinggyToken)
  next.secrets.zrokToken = keepSecret(patch.zrokToken, current.secrets.zrokToken)
  if (!validGenericSecret(next.secrets.ngrokAuthtoken) || !validGenericSecret(next.secrets.cloudflareToken) || !validGenericSecret(next.secrets.zrokToken)) {
    return { ok: false, error: "invalid_token" }
  }
  if (!validPinggyToken(next.secrets.pinggyToken)) return { ok: false, error: "invalid_token" }
  if (!validateSubdomain(next.subdomain)) return { ok: false, error: "invalid_subdomain" }
  if (!validateLocaltunnelHost(next.localtunnelHost)) return { ok: false, error: "invalid_host" }
  if (!validPort(next.webPort) || !validPort(next.apiPort)) return { ok: false, error: "invalid_port" }
  if (next.exposeApi && next.webPort === next.apiPort) return { ok: false, error: "ports_must_differ" }
  return { ok: true, value: next }
}

function clampPort(value: unknown, fallback: number): number {
  return validPort(value) ? value : fallback
}

function storedSecret(value: unknown, pinggy: boolean): string {
  if (typeof value !== "string") return ""
  if (pinggy ? !validPinggyToken(value) : !validGenericSecret(value)) return ""
  return value
}

export function normalizeStoredTunnel(raw: unknown): StoredTunnel {
  const rec = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const secretsRaw = rec.secrets && typeof rec.secrets === "object" ? (rec.secrets as Record<string, unknown>) : {}
  const host = typeof rec.localtunnelHost === "string" && validateLocaltunnelHost(rec.localtunnelHost)
    ? rec.localtunnelHost
    : DEFAULT_LOCALTUNNEL_HOST
  const subdomain = typeof rec.subdomain === "string" && validateSubdomain(rec.subdomain) ? rec.subdomain : ""
  return {
    provider: isTunnelProvider(rec.provider) ? rec.provider : DEFAULT_TUNNEL.provider,
    exposeApi: rec.exposeApi === true,
    subdomain,
    localtunnelHost: host,
    webPort: clampPort(rec.webPort, DEFAULT_WEB_PORT),
    apiPort: clampPort(rec.apiPort, DEFAULT_API_PORT),
    enabled: rec.enabled === true,
    status: isTunnelStatus(rec.status) ? rec.status : "stopped",
    publicUrl: typeof rec.publicUrl === "string" ? cleanUrl(rec.publicUrl) ?? "" : "",
    apiPublicUrl: typeof rec.apiPublicUrl === "string" ? cleanUrl(rec.apiPublicUrl) ?? "" : "",
    lastError: typeof rec.lastError === "string" ? rec.lastError.slice(0, 500) : "",
    startedAt: typeof rec.startedAt === "string" ? rec.startedAt.slice(0, 40) : null,
    retryCount: typeof rec.retryCount === "number" && Number.isFinite(rec.retryCount) ? Math.max(0, Math.min(100, Math.floor(rec.retryCount))) : 0,
    secrets: {
      ngrokAuthtoken: storedSecret(secretsRaw.ngrokAuthtoken, false),
      cloudflareToken: storedSecret(secretsRaw.cloudflareToken, false),
      pinggyToken: storedSecret(secretsRaw.pinggyToken, true),
      zrokToken: storedSecret(secretsRaw.zrokToken, false),
    },
  }
}

export function secretValues(secrets: TunnelSecrets): string[] {
  return [secrets.ngrokAuthtoken, secrets.cloudflareToken, secrets.pinggyToken, secrets.zrokToken].filter((value) => value.length >= 4)
}

export function redactText(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret.length < 4) continue
    out = out.split(secret).join("••••••••")
  }
  return out
}

export function cleanUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/[)\].,;>|]+$/g, "")
  if (!trimmed) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null
  if (url.username || url.password) return null
  const path = url.pathname === "/" ? "" : url.pathname
  return `${url.origin}${path}`
}

function firstMatch(text: string, pattern: RegExp): string | null {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`
  const re = new RegExp(pattern.source, flags)
  const matches = text.match(re) ?? []
  const preferred = matches.find((item) => item.startsWith("https://")) ?? matches[0]
  return preferred ? cleanUrl(preferred) : null
}

export function parseNgrokOutput(text: string): string | null {
  const assigned = text.match(/(?:url[=:]|"url"\s*:)\s*"?(https?:\/\/[a-zA-Z0-9.-]+\.ngrok[a-z0-9.-]*)/i)
  const hit = assigned?.[1]
  if (hit) return cleanUrl(hit)
  return firstMatch(text, /https?:\/\/[a-zA-Z0-9.-]+\.ngrok[a-z0-9.-]*/i)
}

export function parseNgrokApiBody(body: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body) as unknown
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const tunnels = (parsed as { tunnels?: unknown }).tunnels
  if (!Array.isArray(tunnels)) return null
  const urls: string[] = []
  for (const row of tunnels) {
    if (!row || typeof row !== "object") continue
    const url = (row as { public_url?: unknown }).public_url
    if (typeof url === "string") {
      const clean = cleanUrl(url)
      if (clean) urls.push(clean)
    }
  }
  return urls.find((url) => url.startsWith("https://")) ?? urls[0] ?? null
}

export function parseCloudflaredOutput(text: string): string | null {
  return firstMatch(text, /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)
}

export function cloudflaredRegistered(text: string): boolean {
  return /Registered tunnel connection/i.test(text)
}

export function parsePinggyOutput(text: string): string | null {
  return firstMatch(text, /https?:\/\/[a-zA-Z0-9.-]+\.pinggy\.link/gi)
}

export function parseZrokOutput(text: string): string | null {
  return firstMatch(text, /https?:\/\/[a-zA-Z0-9.-]+\.zrok\.io/gi)
}

export function parseProviderUrl(provider: TunnelProvider, text: string): string | null {
  switch (provider) {
    case "ngrok":
      return parseNgrokOutput(text)
    case "cloudflare":
      return parseCloudflaredOutput(text)
    case "pinggy":
      return parsePinggyOutput(text)
    case "zrok":
      return parseZrokOutput(text)
    default:
      return null
  }
}

export function nextBackoffMs(attempt: number): number {
  const exp = Math.min(Math.max(attempt, 1), 5)
  return Math.min(30_000, 1000 * 2 ** (exp - 1))
}

export function ngrokConfigFileContents(authtoken: string): string {
  return `version: "3"\nagent:\n  authtoken: ${authtoken}\n`
}

function upstream(port: number): string {
  return `http://${LOOPBACK}:${port}`
}

function ngrokSpec(port: number, role: TunnelRole, authtoken: string): ProcessSpec {
  const webAddr = role === "dashboard" ? `${LOOPBACK}:44040` : `${LOOPBACK}:44041`
  const args = ["http", upstream(port), "--log=stdout", "--log-format=logfmt", `--web-addr=${webAddr}`]
  const env: Record<string, string> = {}
  if (authtoken) env.NGROK_AUTHTOKEN = authtoken
  return {
    kind: "process",
    bin: "ngrok",
    args,
    env,
    redactedCommand: `ngrok ${args.join(" ")}`,
    port,
    role,
  }
}

function cloudflaredQuick(port: number, role: TunnelRole): ProcessSpec {
  const args = ["tunnel", "--url", upstream(port), "--no-autoupdate"]
  return {
    kind: "process",
    bin: "cloudflared",
    args,
    env: {},
    redactedCommand: `cloudflared ${args.join(" ")}`,
    port,
    role,
  }
}

function cloudflaredNamed(token: string): ProcessSpec {
  const args = ["tunnel", "run", "--token", token, "--no-autoupdate"]
  return {
    kind: "process",
    bin: "cloudflared",
    args,
    env: {},
    redactedCommand: "cloudflared tunnel run --token •••••••• --no-autoupdate",
    port: 0,
    role: "dashboard",
  }
}

function zrokSpec(port: number, role: TunnelRole, subdomain: string): ProcessSpec {
  const args = ["share", "public"]
  if (subdomain) args.push("--unique-name", subdomain)
  args.push(upstream(port))
  return {
    kind: "process",
    bin: "zrok",
    args,
    env: {},
    redactedCommand: `zrok ${args.join(" ")}`,
    port,
    role,
  }
}

function pinggySpec(port: number, role: TunnelRole, token: string): ProcessSpec {
  const remote = token ? `${token}@a.pinggy.io` : "a.pinggy.io"
  const args = [
    "-p",
    "443",
    "-R",
    `0:${LOOPBACK}:${port}`,
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ExitOnForwardFailure=yes",
    remote,
  ]
  const shownRemote = token ? "••••••••@a.pinggy.io" : "a.pinggy.io"
  const redactedCommand = `ssh -p 443 -R0:${LOOPBACK}:${port} -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes ${shownRemote}`
  return {
    kind: "process",
    bin: "ssh",
    args,
    env: {},
    redactedCommand,
    port,
    role,
  }
}

function localtunnelSpec(port: number, role: TunnelRole, host: string, subdomain: string): LocaltunnelSpec {
  const spec: LocaltunnelSpec = {
    kind: "localtunnel",
    port,
    localHost: LOOPBACK,
    host,
    redactedCommand: `localtunnel port=${port} host=${host}${subdomain ? ` subdomain=${subdomain}` : ""}`,
    role,
  }
  if (subdomain) spec.subdomain = subdomain
  return spec
}

export function buildTunnelPlan(config: StoredTunnel): TunnelPlan {
  if (!validPort(config.webPort) || !validPort(config.apiPort)) return { ok: false, error: "invalid_port" }
  if (config.exposeApi && config.webPort === config.apiPort) return { ok: false, error: "ports_must_differ" }
  if (!validateSubdomain(config.subdomain)) return { ok: false, error: "invalid_subdomain" }
  if (!validateLocaltunnelHost(config.localtunnelHost)) return { ok: false, error: "invalid_host" }
  const roles: TunnelRole[] = config.exposeApi ? ["dashboard", "api"] : ["dashboard"]
  const portFor = (role: TunnelRole) => (role === "dashboard" ? config.webPort : config.apiPort)
  if (config.provider === "cloudflare" && config.secrets.cloudflareToken) {
    return {
      ok: true,
      specs: [cloudflaredNamed(config.secrets.cloudflareToken)],
      note: "A named Cloudflare tunnel uses the hostname and ingress saved in Cloudflare. This API does not open a second tunnel for the API port.",
    }
  }
  const specs: TunnelSpec[] = []
  for (const role of roles) {
    const port = portFor(role)
    switch (config.provider) {
      case "ngrok":
        specs.push(ngrokSpec(port, role, config.secrets.ngrokAuthtoken))
        break
      case "cloudflare":
        specs.push(cloudflaredQuick(port, role))
        break
      case "localtunnel":
        specs.push(localtunnelSpec(port, role, config.localtunnelHost, config.subdomain))
        break
      case "zrok":
        specs.push(zrokSpec(port, role, config.subdomain))
        break
      case "pinggy":
        specs.push(pinggySpec(port, role, config.secrets.pinggyToken))
        break
      default:
        return { ok: false, error: "invalid_provider" }
    }
  }
  const note =
    config.provider === "zrok"
      ? "zrok share uses the account from a previous zrok enable. This API stores the token and does not run zrok enable, so the token is not written to process logs."
      : config.provider === "localtunnel"
        ? "The dashboard proxies /api to the API. Tunneling the web port is enough when that proxy accepts the tunnel Host header. The API port tunnel is optional."
        : "The dashboard proxies /api to the API. Tunneling the web port is enough when that proxy accepts the tunnel Host header. The API port tunnel is optional."
  return { ok: true, specs, note }
}

export function providerForSpec(spec: TunnelSpec): TunnelProvider {
  if (spec.kind === "localtunnel") return "localtunnel"
  switch (spec.bin) {
    case "ngrok":
      return "ngrok"
    case "cloudflared":
      return "cloudflare"
    case "zrok":
      return "zrok"
    case "ssh":
      return "pinggy"
    default:
      return "ngrok"
  }
}

export function toPublicTunnel(stored: StoredTunnel, available: Record<TunnelProvider, boolean>): TunnelPublic {
  const plan = buildTunnelPlan(stored)
  const commands = { dashboard: "", api: "" }
  let note = ""
  if (plan.ok) {
    note = plan.note
    for (const spec of plan.specs) {
      commands[spec.role] = spec.redactedCommand
    }
  }
  return {
    provider: stored.provider,
    exposeApi: stored.exposeApi,
    subdomain: stored.subdomain,
    localtunnelHost: stored.localtunnelHost,
    webPort: stored.webPort,
    apiPort: stored.apiPort,
    enabled: stored.enabled,
    status: stored.status,
    publicUrl: stored.publicUrl,
    apiPublicUrl: stored.apiPublicUrl,
    lastError: redactText(stored.lastError, secretValues(stored.secrets)),
    startedAt: stored.startedAt,
    retryCount: stored.retryCount,
    secretsSet: {
      ngrokAuthtoken: stored.secrets.ngrokAuthtoken.length > 0,
      cloudflareToken: stored.secrets.cloudflareToken.length > 0,
      pinggyToken: stored.secrets.pinggyToken.length > 0,
      zrokToken: stored.secrets.zrokToken.length > 0,
    },
    install: { ...INSTALL_COMMANDS },
    available,
    commands,
    note,
  }
}

export function publicJsonContainsSecret(view: TunnelPublic, secrets: TunnelSecrets): boolean {
  const encoded = JSON.stringify(view)
  return secretValues(secrets).some((secret) => encoded.includes(secret))
}
