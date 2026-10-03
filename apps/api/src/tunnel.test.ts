import { EventEmitter } from "node:events"
import { test } from "node:test"
import assert from "node:assert/strict"

import {
  DEFAULT_TUNNEL,
  INSTALL_COMMANDS,
  buildTunnelPlan,
  cleanUrl,
  cloudflaredRegistered,
  mergeTunnelConfig,
  nextBackoffMs,
  ngrokConfigFileContents,
  parseCloudflaredOutput,
  parseNgrokApiBody,
  parseNgrokOutput,
  parsePinggyOutput,
  parseProviderUrl,
  parseTunnelPatch,
  parseZrokOutput,
  publicJsonContainsSecret,
  redactText,
  toPublicTunnel,
  type StoredTunnel,
  type TunnelProvider,
} from "./tunnel-plan.ts"
import {
  TunnelSupervisor,
  memoryTunnelStore,
  type LocaltunnelOpenOpts,
  type SpawnOpts,
  type TunnelChild,
  type TunnelDeps,
} from "./tunnel-supervisor.ts"

const TOKEN = "ngrokTestTokenValue"
const CF_TOKEN = "cfTunnelTokenValue"
const PINGGY_TOKEN = "pinggyTokenValue"
const ZROK_TOKEN = "zrokTokenValue"

const NGROK_LOG =
  't=2024-01-01T00:00:00+0000 lvl=info msg="started tunnel" obj=tunnels name=command_line addr=http://127.0.0.1:3000 url=https://abcd-12-34.ngrok-free.app\n'
const NGROK_JSON = '{"lvl":"info","msg":"started tunnel","url":"https://zzzz.ngrok.app"}\n'
const CLOUDFLARE_LOG = `
2024-01-01T00:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...
2024-01-01T00:00:00Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2024-01-01T00:00:00Z INF |  https://random-words-here.trycloudflare.com                                                    |
`
const PINGGY_LOG = "HTTP  : http://rnd.a.free.pinggy.link\nHTTPS : https://rnd.a.free.pinggy.link\n"
const ZROK_LOG = "Access your zrok share:\n https://abc123.share.zrok.io\n"

const NONE: Record<TunnelProvider, boolean> = {
  ngrok: false,
  cloudflare: false,
  localtunnel: false,
  zrok: false,
  pinggy: false,
}

function withSecrets(secrets: Partial<StoredTunnel["secrets"]>): StoredTunnel {
  return { ...DEFAULT_TUNNEL, secrets: { ...DEFAULT_TUNNEL.secrets, ...secrets } }
}

function fakeProcess(pid: number, hook?: (stdout: EventEmitter, bus: EventEmitter) => void): TunnelChild {
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const bus = new EventEmitter()
  queueMicrotask(() => hook?.(stdout, bus))
  return {
    pid,
    stdout,
    stderr,
    kill() {
      return true
    },
    on(event, listener) {
      bus.on(event, listener)
    },
  }
}

function harness(opts?: {
  bins?: Partial<Record<string, string | null>>
  localtunnel?: boolean
  stdout?: string
  exitCode?: number | null
  error?: Error
  pid?: number
}) {
  const logs: string[] = []
  const killed: Array<{ pid: number; signal: NodeJS.Signals }> = []
  const files: Array<{ file: string; data: string; mode: number }> = []
  const spawned: Array<{ command: string; args: string[]; opts: SpawnOpts }> = []
  const opened: LocaltunnelOpenOpts[] = []
  let closes = 0
  let pid = opts?.pid ?? 4321
  const deps: TunnelDeps = {
    spawn(command, args, spawnOpts) {
      spawned.push({ command, args, opts: spawnOpts })
      const childPid = pid
      pid += 1
      return fakeProcess(childPid, (stdout, bus) => {
        if (opts?.stdout) stdout.emit("data", Buffer.from(opts.stdout))
        if (opts?.error) bus.emit("error", opts.error)
        if (opts?.exitCode !== undefined) bus.emit("exit", opts.exitCode)
      })
    },
    async which(bin) {
      if (opts?.bins && bin in opts.bins) return opts.bins[bin] ?? null
      return `/usr/bin/${bin}`
    },
    async openLocaltunnel(openOpts) {
      opened.push(openOpts)
      return {
        url: "https://demo.loca.lt",
        close() {
          closes += 1
        },
      }
    },
    localtunnelAvailable: () => opts?.localtunnel ?? true,
    killPid(target, signal) {
      killed.push({ pid: target, signal })
    },
    async writeFile(file, data, mode) {
      files.push({ file, data, mode })
    },
    async unlink() {
      return undefined
    },
    async mkdtemp() {
      return "/tmp/pcmanager-ngrok-test"
    },
    async fetchText() {
      return null
    },
    backoffMs: () => 0,
    pollNgrokApi: false,
    log(line) {
      logs.push(line)
    },
    now: () => "2024-01-01T00:00:00.000Z",
  }
  return { deps, logs, killed, files, spawned, opened, closes: () => closes }
}

async function drain(turns = 40): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

test("argument builders bind 127.0.0.1 and keep secrets out of redacted commands", () => {
  const ngrok = buildTunnelPlan(withSecrets({ ngrokAuthtoken: TOKEN }))
  assert.equal(ngrok.ok, true)
  if (!ngrok.ok) return
  assert.equal(ngrok.specs.length, 1)
  const spec = ngrok.specs[0]
  assert.ok(spec)
  assert.equal(spec.kind, "process")
  if (spec.kind !== "process") return
  assert.deepEqual(spec.args, [
    "http",
    "http://127.0.0.1:3000",
    "--log=stdout",
    "--log-format=logfmt",
    "--web-addr=127.0.0.1:44040",
  ])
  assert.equal(spec.env.NGROK_AUTHTOKEN, TOKEN)
  assert.equal(spec.redactedCommand.includes(TOKEN), false)
  assert.equal(spec.args.some((arg) => arg.includes(TOKEN)), false)

  const both = buildTunnelPlan({ ...withSecrets({}), exposeApi: true, provider: "pinggy", secrets: { ...DEFAULT_TUNNEL.secrets, pinggyToken: PINGGY_TOKEN } })
  assert.equal(both.ok, true)
  if (!both.ok) return
  assert.equal(both.specs.length, 2)
  const api = both.specs[1]
  assert.ok(api && api.kind === "process")
  if (!api || api.kind !== "process") return
  assert.equal(api.args.at(-1), `${PINGGY_TOKEN}@a.pinggy.io`)
  assert.equal(api.redactedCommand.includes(PINGGY_TOKEN), false)
  assert.ok(api.args.includes("StrictHostKeyChecking=accept-new"))
  assert.ok(api.args.includes("ServerAliveInterval=30"))
  assert.equal(api.args.some((arg) => arg.includes(";") || arg.includes("|") || arg.includes("`")), false)

  const named = buildTunnelPlan({
    ...DEFAULT_TUNNEL,
    provider: "cloudflare",
    exposeApi: true,
    secrets: { ...DEFAULT_TUNNEL.secrets, cloudflareToken: CF_TOKEN },
  })
  assert.equal(named.ok, true)
  if (!named.ok) return
  assert.equal(named.specs.length, 1)
  const cf = named.specs[0]
  assert.ok(cf && cf.kind === "process")
  if (!cf || cf.kind !== "process") return
  assert.deepEqual(cf.args, ["tunnel", "run", "--token", CF_TOKEN, "--no-autoupdate"])
  assert.equal(cf.redactedCommand.includes(CF_TOKEN), false)

  const quick = buildTunnelPlan({ ...DEFAULT_TUNNEL, provider: "cloudflare" })
  assert.equal(quick.ok, true)
  if (!quick.ok) return
  const q = quick.specs[0]
  assert.ok(q && q.kind === "process")
  if (!q || q.kind !== "process") return
  assert.deepEqual(q.args, ["tunnel", "--url", "http://127.0.0.1:3000", "--no-autoupdate"])

  const zrokNamed = buildTunnelPlan({ ...DEFAULT_TUNNEL, provider: "zrok", subdomain: "lab1" })
  assert.equal(zrokNamed.ok, false)
  const zrok = buildTunnelPlan({ ...DEFAULT_TUNNEL, provider: "zrok" })
  assert.equal(zrok.ok, true)
  if (!zrok.ok) return
  const z = zrok.specs[0]
  assert.ok(z && z.kind === "process")
  if (!z || z.kind !== "process") return
  assert.deepEqual(z.args, ["share", "public", "--headless", "http://127.0.0.1:3000"])
  assert.equal(z.args.some((arg) => arg.includes(ZROK_TOKEN)), false)

  const lt = buildTunnelPlan({ ...DEFAULT_TUNNEL, provider: "localtunnel", subdomain: "lab1" })
  assert.equal(lt.ok, true)
  if (!lt.ok) return
  const local = lt.specs[0]
  assert.ok(local && local.kind === "localtunnel")
  if (!local || local.kind !== "localtunnel") return
  assert.equal(local.localHost, "127.0.0.1")
  assert.equal(local.host, "https://localtunnel.me")
  assert.equal(local.subdomain, "lab1")

  for (const plan of [ngrok, both, named, quick, zrok]) {
    if (!plan.ok) continue
    for (const item of plan.specs) {
      const rendered = item.kind === "process" ? item.args.join(" ") : item.redactedCommand
      assert.equal(rendered.includes("0.0.0.0"), false)
      if (item.kind === "process") assert.ok(Array.isArray(item.args))
    }
  }
})

test("rejects shell metacharacters, bad ports, and credentialed hosts", () => {
  assert.equal(parseTunnelPatch({ subdomain: "foo;rm -rf /" }).ok, false)
  assert.equal(parseTunnelPatch({ subdomain: "Foo" }).ok, false)
  assert.equal(parseTunnelPatch({ pinggyToken: "tok;id" }).ok, false)
  assert.equal(parseTunnelPatch({ ngrokAuthtoken: "bad token" }).ok, false)
  assert.equal(parseTunnelPatch({ webPort: 0 }).ok, false)
  assert.equal(parseTunnelPatch({ apiPort: 65536 }).ok, false)
  assert.equal(parseTunnelPatch({ webPort: 3000, apiPort: 3000, exposeApi: true }).ok, false)
  assert.equal(parseTunnelPatch({ localtunnelHost: "https://user:pass@localtunnel.me" }).ok, false)
  assert.equal(parseTunnelPatch({ localtunnelHost: "http://localtunnel.me" }).ok, false)
  assert.equal(parseTunnelPatch({ provider: "ngrok", extra: true }).ok, false)
  assert.equal(parseTunnelPatch({ subdomain: "lab-1" }).ok, true)
  const merged = mergeTunnelConfig(DEFAULT_TUNNEL, { exposeApi: true, webPort: 3000, apiPort: 3000 })
  assert.equal(merged.ok, false)
})

test("url parsers read provider fixtures and ignore junk", () => {
  assert.equal(parseNgrokOutput(NGROK_LOG), "https://abcd-12-34.ngrok-free.app")
  assert.equal(parseNgrokOutput(NGROK_JSON), "https://zzzz.ngrok.app")
  assert.equal(
    parseNgrokApiBody('{"tunnels":[{"public_url":"http://abcd.ngrok-free.app"},{"public_url":"https://abcd.ngrok-free.app"}]}'),
    "https://abcd.ngrok-free.app"
  )
  assert.equal(parseCloudflaredOutput(CLOUDFLARE_LOG), "https://random-words-here.trycloudflare.com")
  assert.equal(cloudflaredRegistered("INF Registered tunnel connection connIndex=0"), true)
  assert.equal(parsePinggyOutput(PINGGY_LOG), "https://rnd.a.free.pinggy.link")
  assert.equal(parseZrokOutput(ZROK_LOG), "https://abc123.share.zrok.io")
  assert.equal(parseProviderUrl("localtunnel", NGROK_LOG), null)
  assert.equal(cleanUrl("https://user:pass@example.com/path"), null)
  assert.equal(parseNgrokOutput("no url here"), null)
})

test("secrets are write-only in the public view and redacted in text", () => {
  const stored = withSecrets({
    ngrokAuthtoken: TOKEN,
    cloudflareToken: CF_TOKEN,
    pinggyToken: PINGGY_TOKEN,
    zrokToken: ZROK_TOKEN,
  })
  const kept = mergeTunnelConfig(stored, {
    ngrokAuthtoken: "••••••••",
    cloudflareToken: "",
    pinggyToken: "••••",
    zrokToken: undefined,
  })
  assert.equal(kept.ok, true)
  if (!kept.ok) return
  assert.equal(kept.value.secrets.ngrokAuthtoken, TOKEN)
  assert.equal(kept.value.secrets.cloudflareToken, CF_TOKEN)
  assert.equal(kept.value.secrets.pinggyToken, PINGGY_TOKEN)
  assert.equal(kept.value.secrets.zrokToken, ZROK_TOKEN)
  const view = toPublicTunnel({ ...kept.value, lastError: `failed ${TOKEN}` }, NONE)
  assert.equal(view.secretsSet.ngrokAuthtoken, true)
  assert.equal(view.secretsSet.zrokToken, true)
  assert.equal(publicJsonContainsSecret(view, kept.value.secrets), false)
  assert.equal(view.lastError.includes(TOKEN), false)
  assert.equal(redactText(`see ${CF_TOKEN} now`, [CF_TOKEN]).includes(CF_TOKEN), false)
  assert.match(ngrokConfigFileContents(TOKEN), new RegExp(TOKEN))
  assert.equal(INSTALL_COMMANDS.ngrok.includes(TOKEN), false)
})

test("backoff grows and then caps", () => {
  assert.equal(nextBackoffMs(1), 1000)
  assert.equal(nextBackoffMs(2), 2000)
  assert.equal(nextBackoffMs(3), 4000)
  assert.equal(nextBackoffMs(5), 16_000)
  assert.equal(nextBackoffMs(9), 16_000)
})

test("stop signals only the tracked pid", async () => {
  const h = harness({ bins: { ngrok: "/usr/bin/ngrok" }, stdout: NGROK_LOG })
  const sup = new TunnelSupervisor(h.deps, memoryTunnelStore())
  const started = await sup.start({ provider: "ngrok" })
  assert.equal(started.ok, true)
  if (!started.ok) return
  assert.equal(started.tunnel.publicUrl, "https://abcd-12-34.ngrok-free.app")
  assert.equal(started.tunnel.status, "up")
  await sup.stop()
  assert.deepEqual(h.killed, [{ pid: 4321, signal: "SIGTERM" }])
  assert.equal(h.spawned.length, 1)
  assert.equal(h.spawned[0]?.opts.shell, false)
  const view = await sup.view()
  assert.equal(view.status, "stopped")
  assert.equal(view.enabled, false)
})

test("start is idempotent while the same tunnel is up", async () => {
  const h = harness({ stdout: NGROK_LOG })
  const sup = new TunnelSupervisor(h.deps, memoryTunnelStore())
  await sup.start({ provider: "ngrok", webPort: 3000 })
  await sup.start({ provider: "ngrok", webPort: 3000 })
  assert.equal(h.spawned.length, 1)
  await sup.stop()
})

test("a dead process restarts with backoff until the retry cap", async () => {
  const h = harness({ exitCode: 1 })
  const sup = new TunnelSupervisor(h.deps, memoryTunnelStore())
  await sup.start({ provider: "zrok" })
  await drain()
  assert.equal(h.spawned.length, 6)
  const view = await sup.view()
  assert.equal(view.lastError, "retry_cap")
  assert.equal(view.status, "error")
  assert.equal(view.enabled, true)
  const before = h.spawned.length
  await drain(10)
  assert.equal(h.spawned.length, before)
})

test("missing binaries do not spawn and return the install command", async () => {
  const h = harness({ bins: { ngrok: null, cloudflared: null, zrok: null, ssh: null }, localtunnel: false })
  const sup = new TunnelSupervisor(h.deps, memoryTunnelStore())
  const started = await sup.start({ provider: "cloudflare" })
  assert.equal(started.ok, false)
  if (started.ok) return
  assert.equal(started.error, "provider_unavailable")
  assert.equal(started.install, INSTALL_COMMANDS.cloudflare)
  assert.equal(h.spawned.length, 0)
  assert.equal(h.opened.length, 0)
})

test("start installs a missing client and resume does not download", async () => {
  const h = harness({ bins: { ngrok: null }, stdout: NGROK_LOG })
  let installs = 0
  let ngrok: string | null = null
  h.deps.installProvider = async (provider) => {
    installs += 1
    assert.equal(provider, "ngrok")
    ngrok = "/data/tools/ngrok"
    return { ok: true, bin: ngrok }
  }
  h.deps.which = async (bin) => (bin === "ngrok" ? ngrok : `/usr/bin/${bin}`)
  const sup = new TunnelSupervisor(h.deps, memoryTunnelStore())
  const started = await sup.start({ provider: "ngrok" })
  assert.equal(started.ok, true)
  assert.equal(installs, 1)
  assert.equal(h.spawned[0]?.command, "/data/tools/ngrok")
  assert.equal(h.spawned[0]?.opts.shell, false)
  assert.equal(h.spawned[0]?.args.some((arg) => arg.includes("127.0.0.1")), true)
  await sup.stop()

  const resume = harness({ bins: { ngrok: null } })
  let resumeInstalls = 0
  resume.deps.installProvider = async () => {
    resumeInstalls += 1
    return { ok: false, error: "should_not_run" }
  }
  const resumeSup = new TunnelSupervisor(
    resume.deps,
    memoryTunnelStore({ ...DEFAULT_TUNNEL, enabled: true, provider: "ngrok" })
  )
  await resumeSup.resumeIfEnabled()
  assert.equal(resumeInstalls, 0)
  assert.equal(resume.spawned.length, 0)
})

test("a failed checksum install does not spawn", async () => {
  const h = harness({ bins: { cloudflared: null } })
  h.deps.installProvider = async () => ({ ok: false, error: "checksum_mismatch" })
  const sup = new TunnelSupervisor(h.deps, memoryTunnelStore())
  const started = await sup.start({ provider: "cloudflare" })
  assert.equal(started.ok, false)
  if (started.ok) return
  assert.equal(started.error, "checksum_mismatch")
  assert.equal(h.spawned.length, 0)
})

test("localtunnel stop closes the handle and does not kill a pid", async () => {
  const h = harness({ localtunnel: true })
  const sup = new TunnelSupervisor(h.deps, memoryTunnelStore())
  const started = await sup.start({ provider: "localtunnel", subdomain: "lab1" })
  assert.equal(started.ok, true)
  if (!started.ok) return
  assert.equal(started.tunnel.publicUrl, "https://demo.loca.lt")
  assert.equal(h.opened[0]?.local_host, "127.0.0.1")
  assert.equal(h.opened[0]?.port, 3000)
  assert.equal(h.spawned.length, 0)
  await sup.stop()
  assert.equal(h.closes(), 1)
  assert.deepEqual(h.killed, [])
})

test("ngrok authtoken is written to a 0600 config and never logged", async () => {
  const h = harness({ stdout: NGROK_LOG, error: new Error(`agent failed ${TOKEN}`) })
  const leaked: string[] = []
  const store = memoryTunnelStore()
  const wrapped = {
    load: () => store.load(),
    save: async (value: StoredTunnel) => {
      if (value.lastError.includes(TOKEN)) leaked.push(value.lastError)
      await store.save(value)
    },
  }
  const sup = new TunnelSupervisor(h.deps, wrapped)
  const started = await sup.start({ provider: "ngrok", ngrokAuthtoken: TOKEN })
  await drain()
  assert.equal(started.ok, true)
  assert.equal(JSON.stringify(started).includes(TOKEN), false)
  const view = await sup.view()
  assert.equal(JSON.stringify(view).includes(TOKEN), false)
  assert.equal(h.logs.some((line) => line.includes(TOKEN)), false)
  assert.equal(h.spawned.some((call) => call.args.some((arg) => arg.includes(TOKEN))), false)
  assert.equal(h.files[0]?.mode, 0o600)
  assert.match(h.files[0]?.data ?? "", new RegExp(TOKEN))
  assert.equal(h.files[0]?.file.includes(TOKEN), false)
  assert.equal(leaked.length, 0)
  await sup.stop()
})

test("resume stays idle unless enabled was saved", async () => {
  const idle = harness()
  const idleSup = new TunnelSupervisor(idle.deps, memoryTunnelStore({ ...DEFAULT_TUNNEL, enabled: false }))
  await idleSup.resumeIfEnabled()
  assert.equal(idle.spawned.length, 0)
  assert.equal(idle.opened.length, 0)

  const live = harness({ localtunnel: true })
  const liveSup = new TunnelSupervisor(
    live.deps,
    memoryTunnelStore({ ...DEFAULT_TUNNEL, enabled: true, provider: "localtunnel" })
  )
  await liveSup.resumeIfEnabled()
  assert.equal(live.opened.length, 1)
  assert.equal(live.spawned.length, 0)
  await liveSup.stop()
})
