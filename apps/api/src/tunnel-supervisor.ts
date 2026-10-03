/**
 * Starts and stops the tunnel processes this API launched.
 * Stop signals only the tracked pid (or the localtunnel handle). It never
 * searches the process table by name.
 */

import { execFile, spawn } from "node:child_process"
import { mkdtemp, unlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"

import {
  DEFAULT_TUNNEL,
  INSTALL_COMMANDS,
  MAX_TUNNEL_RETRIES,
  buildTunnelPlan,
  cloudflaredRegistered,
  mergeTunnelConfig,
  nextBackoffMs,
  ngrokConfigFileContents,
  normalizeStoredTunnel,
  parseNgrokApiBody,
  parseProviderUrl,
  parseTunnelPatch,
  providerForSpec,
  redactText,
  secretValues,
  toPublicTunnel,
  type StoredTunnel,
  type TunnelProvider,
  type TunnelPublic,
  type TunnelRole,
  type TunnelSpec,
} from "./tunnel-plan.js"

export interface TunnelChild {
  pid?: number
  stdout: NodeJS.EventEmitter | null
  stderr: NodeJS.EventEmitter | null
  kill(signal?: NodeJS.Signals): boolean
  on(event: "exit" | "error", listener: (arg?: unknown) => void): void
}

export type SpawnOpts = {
  env: NodeJS.ProcessEnv
  stdio: ["ignore", "pipe", "pipe"]
  windowsHide: boolean
  shell: false
}

export type LocaltunnelHandle = { url: string; close: () => void }

export type LocaltunnelOpenOpts = {
  port: number
  local_host: "127.0.0.1"
  host: string
  subdomain?: string
}

export type TunnelStore = {
  load: () => Promise<StoredTunnel>
  save: (value: StoredTunnel) => Promise<void>
}

export type TunnelDeps = {
  spawn: (command: string, args: string[], opts: SpawnOpts) => TunnelChild
  which: (bin: string) => Promise<string | null>
  openLocaltunnel: (opts: LocaltunnelOpenOpts) => Promise<LocaltunnelHandle>
  localtunnelAvailable: () => boolean
  killPid: (pid: number, signal: NodeJS.Signals) => void
  writeFile: (file: string, data: string, mode: number) => Promise<void>
  unlink: (file: string) => Promise<void>
  mkdtemp: () => Promise<string>
  fetchText: (url: string) => Promise<string | null>
  backoffMs: (attempt: number) => number
  pollNgrokApi: boolean
  log: (line: string) => void
  now: () => string
}

type Running = {
  role: TunnelRole
  pid?: number
  redactedCommand: string
  stop: () => void
}

const NGROK_WEB: Record<TunnelRole, number> = { dashboard: 44040, api: 44041 }

export function memoryTunnelStore(initial?: StoredTunnel): TunnelStore & { snapshot: () => StoredTunnel } {
  let value = normalizeStoredTunnel(initial ?? DEFAULT_TUNNEL)
  return {
    async load() {
      return normalizeStoredTunnel(value)
    },
    async save(next) {
      value = normalizeStoredTunnel(next)
    },
    snapshot() {
      return normalizeStoredTunnel(value)
    },
  }
}

export async function whichBin(bin: string): Promise<string | null> {
  if (!/^[a-z0-9._-]+$/i.test(bin)) return null
  return new Promise((resolve) => {
    execFile("which", [bin], { timeout: 2000, shell: false }, (err, stdout) => {
      if (err) resolve(null)
      else resolve(stdout.trim().split(/\r?\n/)[0] || null)
    })
  })
}

export function localtunnelPackageAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve("localtunnel")
    return true
  } catch {
    return false
  }
}

export async function openLocaltunnelPackage(opts: LocaltunnelOpenOpts): Promise<LocaltunnelHandle> {
  const loaded = createRequire(import.meta.url)("localtunnel") as
    | ((options: LocaltunnelOpenOpts) => Promise<LocaltunnelHandle>)
    | { default: (options: LocaltunnelOpenOpts) => Promise<LocaltunnelHandle> }
  const fn = typeof loaded === "function" ? loaded : loaded.default
  return fn(opts)
}

export function defaultTunnelDeps(): TunnelDeps {
  return {
    spawn(command, args, opts) {
      return spawn(command, args, opts) as unknown as TunnelChild
    },
    which: whichBin,
    openLocaltunnel: openLocaltunnelPackage,
    localtunnelAvailable: localtunnelPackageAvailable,
    killPid(pid, signal) {
      process.kill(pid, signal)
    },
    async writeFile(file, data, mode) {
      await writeFile(file, data, { mode, flag: "w" })
    },
    async unlink(file) {
      await unlink(file).catch(() => undefined)
    },
    async mkdtemp() {
      return mkdtemp(path.join(os.tmpdir(), "pcmanager-ngrok-"))
    },
    async fetchText(url) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 1500)
      try {
        const res = await fetch(url, { signal: ctrl.signal })
        if (!res.ok) return null
        return await res.text()
      } catch {
        return null
      } finally {
        clearTimeout(timer)
      }
    },
    backoffMs: nextBackoffMs,
    pollNgrokApi: true,
    log(line) {
      console.error(line)
    },
    now() {
      return new Date().toISOString()
    },
  }
}

export class TunnelSupervisor {
  private memory: StoredTunnel | null = null
  private handles = new Map<TunnelRole, Running>()
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private tempFiles: string[] = []
  private stopRequested = false
  private generation = 0
  private retries = new Map<TunnelRole, number>()
  private tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly deps: TunnelDeps,
    private readonly store: TunnelStore
  ) {}

  async view(): Promise<TunnelPublic> {
    return this.enqueue(async () => this.publicView())
  }

  async save(body: unknown): Promise<{ ok: true; tunnel: TunnelPublic } | { ok: false; error: string; http: number }> {
    return this.enqueue(async () => {
      const parsed = parseTunnelPatch(body)
      if (!parsed.ok) return { ok: false as const, error: parsed.error, http: 400 }
      const current = await this.current()
      const merged = mergeTunnelConfig(current, parsed.patch)
      if (!merged.ok) return { ok: false as const, error: merged.error, http: 400 }
      const next: StoredTunnel = {
        ...merged.value,
        enabled: current.enabled,
        status: current.status,
        publicUrl: current.publicUrl,
        apiPublicUrl: current.apiPublicUrl,
        lastError: current.lastError,
        startedAt: current.startedAt,
        retryCount: current.retryCount,
      }
      await this.persist(next)
      return { ok: true as const, tunnel: await this.publicView() }
    })
  }

  async start(body?: unknown): Promise<
    | { ok: true; tunnel: TunnelPublic }
    | { ok: false; error: string; http: number; install?: string; provider?: TunnelProvider }
  > {
    return this.enqueue(() => this.startUnlocked(body))
  }

  async stop(): Promise<{ ok: true; tunnel: TunnelPublic }> {
    return this.enqueue(async () => {
      await this.haltChildren()
      const current = await this.current()
      await this.persist({
        ...current,
        enabled: false,
        status: "stopped",
        lastError: "",
        retryCount: 0,
        publicUrl: "",
        apiPublicUrl: "",
      })
      return { ok: true as const, tunnel: await this.publicView() }
    })
  }

  /** Drop child processes on API shutdown. Leaves `enabled` so the next boot can resume. */
  async release(): Promise<void> {
    return this.enqueue(async () => {
      await this.haltChildren()
    })
  }

  async resumeIfEnabled(): Promise<void> {
    return this.enqueue(async () => {
      const stored = await this.current()
      if (!stored.enabled) return
      await this.startUnlocked(undefined)
    })
  }

  private async startUnlocked(body: unknown): Promise<
    | { ok: true; tunnel: TunnelPublic }
    | { ok: false; error: string; http: number; install?: string; provider?: TunnelProvider }
  > {
    const current = await this.current()
    const parsed = body === undefined ? { ok: true as const, patch: {} } : parseTunnelPatch(body)
    if (!parsed.ok) return { ok: false, error: parsed.error, http: 400 }
    const merged = mergeTunnelConfig(current, parsed.patch)
    if (!merged.ok) return { ok: false, error: merged.error, http: 400 }
    const plan = buildTunnelPlan(merged.value)
    if (!plan.ok) return { ok: false, error: plan.error, http: 400 }
    const missing = await this.firstMissing(plan.specs)
    if (missing) {
      const install = INSTALL_COMMANDS[missing]
      await this.persist({
        ...merged.value,
        enabled: false,
        status: "error",
        lastError: redactText(`provider_unavailable: ${install}`, secretValues(merged.value.secrets)).slice(0, 500),
        publicUrl: "",
        apiPublicUrl: "",
      })
      return { ok: false, error: "provider_unavailable", install, provider: missing, http: 409 }
    }
    if (this.isSameLive(merged.value, plan.specs)) {
      return { ok: true, tunnel: await this.publicView() }
    }
    this.generation += 1
    const generation = this.generation
    this.stopRequested = false
    this.clearTimers()
    this.stopHandles()
    this.retries.clear()
    const next: StoredTunnel = {
      ...merged.value,
      enabled: true,
      status: "starting",
      lastError: "",
      publicUrl: "",
      apiPublicUrl: "",
      startedAt: this.deps.now(),
      retryCount: 0,
    }
    await this.persist(next)
    await this.spawnAll(plan.specs, generation)
    return { ok: true, tunnel: await this.publicView() }
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn)
    this.tail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async current(): Promise<StoredTunnel> {
    if (!this.memory) this.memory = normalizeStoredTunnel(await this.store.load())
    return this.memory
  }

  private async persist(next: StoredTunnel): Promise<void> {
    const clean = normalizeStoredTunnel({
      ...next,
      lastError: redactText(next.lastError, secretValues(next.secrets)),
    })
    this.memory = clean
    await this.store.save(clean)
  }

  private async publicView(): Promise<TunnelPublic> {
    const stored = await this.current()
    return toPublicTunnel(stored, await this.availability())
  }

  private async availability(): Promise<Record<TunnelProvider, boolean>> {
    const [ngrok, cloudflare, zrok, ssh] = await Promise.all([
      this.deps.which("ngrok"),
      this.deps.which("cloudflared"),
      this.deps.which("zrok"),
      this.deps.which("ssh"),
    ])
    return {
      ngrok: Boolean(ngrok),
      cloudflare: Boolean(cloudflare),
      localtunnel: this.deps.localtunnelAvailable(),
      zrok: Boolean(zrok),
      pinggy: Boolean(ssh),
    }
  }

  private async firstMissing(specs: TunnelSpec[]): Promise<TunnelProvider | null> {
    for (const spec of specs) {
      const provider = providerForSpec(spec)
      if (spec.kind === "localtunnel") {
        if (!this.deps.localtunnelAvailable()) return provider
        continue
      }
      const bin = await this.deps.which(spec.bin)
      if (!bin) return provider
    }
    return null
  }

  private isSameLive(next: StoredTunnel, specs: TunnelSpec[]): boolean {
    const current = this.memory
    if (!current || this.stopRequested) return false
    if (current.status !== "up" && current.status !== "starting") return false
    if (current.provider !== next.provider || current.exposeApi !== next.exposeApi) return false
    if (current.webPort !== next.webPort || current.apiPort !== next.apiPort) return false
    if (current.subdomain !== next.subdomain || current.localtunnelHost !== next.localtunnelHost) return false
    if (current.secrets.ngrokAuthtoken !== next.secrets.ngrokAuthtoken) return false
    if (current.secrets.cloudflareToken !== next.secrets.cloudflareToken) return false
    if (current.secrets.pinggyToken !== next.secrets.pinggyToken) return false
    for (const spec of specs) {
      if (!this.handles.has(spec.role)) return false
    }
    return this.handles.size === specs.length
  }

  private async spawnAll(specs: TunnelSpec[], generation: number): Promise<void> {
    for (const spec of specs) {
      if (this.stopRequested || generation !== this.generation) return
      await this.spawnSpec(spec, generation)
    }
  }

  private async spawnSpec(spec: TunnelSpec, generation: number): Promise<void> {
    const stored = await this.current()
    const secrets = secretValues(stored.secrets)
    if (spec.kind === "localtunnel") {
      try {
        const opened = await this.deps.openLocaltunnel({
          port: spec.port,
          local_host: spec.localHost,
          host: spec.host,
          ...(spec.subdomain ? { subdomain: spec.subdomain } : {}),
        })
        if (this.stopRequested || generation !== this.generation) {
          opened.close()
          return
        }
        const url = cleanStoredUrl(opened.url)
        this.handles.set(spec.role, {
          role: spec.role,
          redactedCommand: spec.redactedCommand,
          stop: () => opened.close(),
        })
        this.assignUrl(spec.role, url)
        const latest = await this.current()
        await this.persist({ ...latest, status: url ? "up" : "starting", lastError: url ? "" : latest.lastError })
      } catch (error) {
        const message = error instanceof Error ? error.message : "localtunnel_failed"
        this.deps.log(redactText(message, secrets))
        this.onExit(spec.role, generation, null, message)
      }
      return
    }
    const binPath = await this.deps.which(spec.bin)
    if (!binPath) {
      await this.markUnavailable(providerForSpec(spec))
      return
    }
    let args = spec.args
    if (spec.bin === "ngrok" && spec.env.NGROK_AUTHTOKEN) {
      const dir = await this.deps.mkdtemp()
      const file = path.join(dir, "ngrok.yml")
      await this.deps.writeFile(file, ngrokConfigFileContents(spec.env.NGROK_AUTHTOKEN), 0o600)
      this.tempFiles.push(file)
      args = [...args, "--config", file]
    }
    let child: TunnelChild
    try {
      child = this.deps.spawn(binPath, args, {
        env: { ...process.env, ...spec.env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : "spawn_failed"
      this.deps.log(redactText(message, secrets))
      this.onExit(spec.role, generation, null, message)
      return
    }
    let settled = false
    const finish = (code: number | null, message?: string) => {
      if (settled) return
      settled = true
      this.onExit(spec.role, generation, code, message)
    }
    this.handles.set(spec.role, {
      role: spec.role,
      pid: child.pid,
      redactedCommand: spec.redactedCommand,
      stop: () => {
        if (child.pid) this.deps.killPid(child.pid, "SIGTERM")
        else child.kill("SIGTERM")
      },
    })
    const onData = (chunk: unknown) => {
      if (generation !== this.generation) return
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "")
      const url = parseProviderUrl(stored.provider, text)
      if (url) {
        this.assignUrl(spec.role, url)
        const latest = this.memory
        if (latest) void this.persist({ ...latest, status: "up", lastError: "" })
      } else if (stored.provider === "cloudflare" && cloudflaredRegistered(text)) {
        const latest = this.memory
        if (latest && latest.status !== "up") void this.persist({ ...latest, status: "up" })
      }
    }
    child.stdout?.on("data", onData)
    child.stderr?.on("data", onData)
    child.on("error", (arg) => {
      const message = arg instanceof Error ? arg.message : "spawn_error"
      this.deps.log(redactText(message, secrets))
      finish(null, message)
    })
    child.on("exit", (arg) => {
      finish(typeof arg === "number" ? arg : null)
    })
    if (spec.bin === "ngrok" && this.deps.pollNgrokApi) this.scheduleNgrokPoll(spec.role, generation)
  }

  private scheduleNgrokPoll(role: TunnelRole, generation: number): void {
    const port = NGROK_WEB[role]
    const delays = [400, 1200, 2500]
    for (const delay of delays) {
      this.later(delay, () => {
        if (generation !== this.generation || this.stopRequested) return
        void this.deps.fetchText(`http://127.0.0.1:${port}/api/tunnels`).then((body) => {
          if (!body || generation !== this.generation) return
          const url = parseNgrokApiBody(body)
          if (!url) return
          this.assignUrl(role, url)
          const latest = this.memory
          if (latest) void this.persist({ ...latest, status: "up", lastError: "" })
        })
      })
    }
  }

  private assignUrl(role: TunnelRole, url: string): void {
    if (!this.memory || !url) return
    if (role === "dashboard") this.memory = { ...this.memory, publicUrl: url }
    else this.memory = { ...this.memory, apiPublicUrl: url }
  }

  private onExit(role: TunnelRole, generation: number, code: number | null, message?: string): void {
    if (generation !== this.generation) return
    this.handles.delete(role)
    if (this.stopRequested || !this.memory?.enabled) return
    const attempt = (this.retries.get(role) ?? 0) + 1
    this.retries.set(role, attempt)
    const secrets = secretValues(this.memory.secrets)
    const reason = redactText(message || `process_exit_${code ?? "signal"}`, secrets).slice(0, 300)
    if (attempt > MAX_TUNNEL_RETRIES) {
      void this.persist({ ...this.memory, status: "error", lastError: "retry_cap", retryCount: attempt })
      return
    }
    void this.persist({ ...this.memory, status: "starting", lastError: reason, retryCount: attempt })
    const delay = this.deps.backoffMs(attempt)
    this.later(delay, () => {
      if (this.stopRequested || generation !== this.generation || !this.memory) return
      const plan = buildTunnelPlan(this.memory)
      if (!plan.ok) return
      const spec = plan.specs.find((item) => item.role === role)
      if (spec) void this.spawnSpec(spec, generation)
    })
  }

  private async markUnavailable(provider: TunnelProvider): Promise<void> {
    const current = await this.current()
    await this.persist({
      ...current,
      enabled: false,
      status: "error",
      lastError: `provider_unavailable: ${INSTALL_COMMANDS[provider]}`.slice(0, 500),
    })
  }

  private async haltChildren(): Promise<void> {
    this.generation += 1
    this.stopRequested = true
    this.clearTimers()
    this.stopHandles()
    this.retries.clear()
    const files = this.tempFiles.splice(0)
    await Promise.all(files.map((file) => this.deps.unlink(file)))
  }

  private stopHandles(): void {
    for (const handle of this.handles.values()) {
      try {
        handle.stop()
      } catch (error) {
        const message = error instanceof Error ? error.message : "stop_failed"
        this.deps.log(redactText(message, secretValues(this.memory?.secrets ?? DEFAULT_TUNNEL.secrets)))
      }
    }
    this.handles.clear()
  }

  private later(ms: number, fn: () => void): void {
    const id = setTimeout(() => {
      this.timers.delete(id)
      fn()
    }, ms)
    this.timers.add(id)
  }

  private clearTimers(): void {
    for (const id of this.timers) clearTimeout(id)
    this.timers.clear()
  }
}

function cleanStoredUrl(raw: string): string {
  try {
    const url = new URL(raw)
    if (url.username || url.password) return ""
    if (url.protocol !== "https:" && url.protocol !== "http:") return ""
    const pathName = url.pathname === "/" ? "" : url.pathname
    return `${url.origin}${pathName}`
  } catch {
    return ""
  }
}
