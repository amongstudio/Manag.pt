import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process"
import { execFile as execFileCallback } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

import type { CompileJobView, CompileRequest } from "@workspace/shared"

import { pathExists, safeUploadFilename } from "./lib.js"

const execFile = promisify(execFileCallback)

export const COMPILE_TIMEOUT_MS = 6 * 60 * 1000
export const COMPILE_LOG_MAX = 256 * 1024

export const GO_MISSING_HINT =
  "Install Go and ensure it is on PATH, or set GO_BIN to the go binary."
export const SOURCE_MISSING_HINT =
  "Set AGENT_SOURCE_DIR to the agent sources (apps/agent with go.mod and cmd/agent)."

export type CompiledArtifact = {
  version: string
  platform: string
  arch: string
  notes: string
  path: string
  size: number
  checksum: string
}

export type CompileStartFailure = {
  ok: false
  status: 400 | 409 | 500
  error: string
  details?: { hint?: string; id?: string }
}

export type CompileStartSuccess = { ok: true; job: CompileJobView }

type InternalJob = {
  id: string
  status: CompileJobView["status"]
  log: string
  error: string | null
  updateId: string | null
  platform: string
  arch: string
  version: string
  lite: boolean
  finished: Promise<CompileJobView>
  resolveFinished: (view: CompileJobView) => void
}

export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => Pick<ChildProcess, "stdout" | "stderr" | "kill"> & {
  on(event: "close", listener: (code: number | null, signal?: NodeJS.Signals | null) => void): unknown
  on(event: "error", listener: (err: Error) => unknown): unknown
}

export type CompileQueueOptions = {
  sourceDir: string
  goBin: string
  updatesDir: string
  timeoutMs?: number
  spawn?: SpawnImpl
  exists?: (target: string) => Promise<boolean>
  probeGo?: (bin: string) => Promise<boolean>
  persist: (artifact: CompiledArtifact) => Promise<{ id: string }>
}

export function goLdflags(
  version: string,
  extra?: { windowsGUI?: boolean; defaultServerURL?: string },
): string {
  const parts = [`-s -w -X main.Version=${version}`]
  const url = extra?.defaultServerURL?.trim()
  if (url) {
    parts.push(`-X github.com/pc-manager/agent/internal/config.DefaultServerURL=${url}`)
  }
  if (extra?.windowsGUI) {
    parts.push("-H windowsgui")
  }
  return parts.join(" ")
}

export function goBuildArgs(opts: {
  lite: boolean
  version: string
  outPath: string
  platform?: string
  defaultServerURL?: string
}): string[] {
  const args = ["build"]
  if (opts.lite) args.push("-tags", "lite")
  args.push(
    "-ldflags",
    goLdflags(opts.version, {
      windowsGUI: opts.platform === "windows",
      defaultServerURL: opts.defaultServerURL,
    }),
    "-o",
    opts.outPath,
    "./cmd/agent",
  )
  return args
}

export function agentBinaryName(platform: string): string {
  return platform === "windows" ? "pc-manager-agent.exe" : "pc-manager-agent"
}

export async function defaultProbeGo(bin: string): Promise<boolean> {
  try {
    await execFile(bin, ["version"], { timeout: 8_000, windowsHide: true })
    return true
  } catch {
    return false
  }
}

export async function checkCompilePrereqs(opts: {
  sourceDir: string
  goBin: string
  exists?: (target: string) => Promise<boolean>
  probeGo?: (bin: string) => Promise<boolean>
}): Promise<{ ok: true } | { ok: false; error: "go_not_found" | "source_not_found"; hint: string }> {
  const exists = opts.exists ?? pathExists
  const probeGo = opts.probeGo ?? defaultProbeGo
  const goMod = path.join(opts.sourceDir, "go.mod")
  const cmdDir = path.join(opts.sourceDir, "cmd", "agent")
  if (!(await exists(goMod)) || !(await exists(cmdDir))) {
    return { ok: false, error: "source_not_found", hint: SOURCE_MISSING_HINT }
  }
  if (!(await probeGo(opts.goBin))) {
    return { ok: false, error: "go_not_found", hint: GO_MISSING_HINT }
  }
  return { ok: true }
}

function appendLog(job: InternalJob, chunk: string): void {
  job.log += chunk
  if (job.log.length > COMPILE_LOG_MAX) {
    job.log = job.log.slice(job.log.length - COMPILE_LOG_MAX)
  }
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256")
    const stream = createReadStream(filePath)
    stream.on("data", (buf) => hash.update(buf))
    stream.on("error", reject)
    stream.on("end", () => resolve(hash.digest("hex")))
  })
}

export class CompileQueue {
  private readonly jobs = new Map<string, InternalJob>()
  private readonly order: string[] = []
  private activeId: string | null = null
  private readonly timeoutMs: number
  private readonly spawnImpl: SpawnImpl
  private readonly exists: (target: string) => Promise<boolean>
  private readonly probeGo: (bin: string) => Promise<boolean>

  constructor(private readonly opts: CompileQueueOptions) {
    this.timeoutMs = opts.timeoutMs ?? COMPILE_TIMEOUT_MS
    this.spawnImpl = opts.spawn ?? (spawn as SpawnImpl)
    this.exists = opts.exists ?? pathExists
    this.probeGo = opts.probeGo ?? defaultProbeGo
  }

  get(id: string): CompileJobView | null {
    const job = this.jobs.get(id)
    return job ? this.view(job) : null
  }

  latest(): CompileJobView | null {
    const id = this.order.at(-1)
    if (!id) return null
    return this.get(id)
  }

  settled(id: string): Promise<CompileJobView> {
    const job = this.jobs.get(id)
    if (!job) return Promise.reject(new Error("not_found"))
    return job.finished
  }

  async start(input: CompileRequest): Promise<CompileStartSuccess | CompileStartFailure> {
    if (this.activeId) {
      return {
        ok: false,
        status: 409,
        error: "compile_busy",
        details: { id: this.activeId, hint: "Wait for the current compile to finish." },
      }
    }
    const ready = await checkCompilePrereqs({
      sourceDir: this.opts.sourceDir,
      goBin: this.opts.goBin,
      exists: this.exists,
      probeGo: this.probeGo,
    })
    if (this.activeId) {
      return {
        ok: false,
        status: 409,
        error: "compile_busy",
        details: { id: this.activeId, hint: "Wait for the current compile to finish." },
      }
    }
    if (!ready.ok) {
      return { ok: false, status: 400, error: ready.error, details: { hint: ready.hint } }
    }

    let resolveFinished: (view: CompileJobView) => void = () => undefined
    const finished = new Promise<CompileJobView>((resolve) => {
      resolveFinished = resolve
    })
    const job: InternalJob = {
      id: randomUUID(),
      status: "running",
      log: "",
      error: null,
      updateId: null,
      platform: input.platform,
      arch: input.arch,
      version: input.version,
      lite: input.lite,
      finished,
      resolveFinished,
    }
    this.jobs.set(job.id, job)
    this.order.push(job.id)
    this.activeId = job.id
    while (this.order.length > 8) {
      const drop = this.order[0]
      if (drop && drop !== this.activeId) {
        this.order.shift()
        this.jobs.delete(drop)
      } else {
        break
      }
    }
    void this.run(job).catch((error) => {
      this.finish(job, "failed", error instanceof Error ? error.message : "compile failed")
    })
    return { ok: true, job: this.view(job) }
  }

  private view(job: InternalJob): CompileJobView {
    return {
      id: job.id,
      status: job.status,
      log: job.log,
      error: job.error,
      updateId: job.updateId,
    }
  }

  private finish(job: InternalJob, status: "success" | "failed", error: string | null): void {
    if (job.status === "success" || job.status === "failed") return
    job.status = status
    job.error = error
    if (this.activeId === job.id) this.activeId = null
    job.resolveFinished(this.view(job))
  }

  private async run(job: InternalJob): Promise<void> {
    const outName = agentBinaryName(job.platform)
    const destName = `${safeUploadFilename(job.platform)}-${safeUploadFilename(job.arch)}-${safeUploadFilename(job.version)}-${outName}`
    const dest = path.join(this.opts.updatesDir, destName)
    const args = goBuildArgs({
      lite: job.lite,
      version: job.version,
      outPath: dest,
      platform: job.platform,
      defaultServerURL: process.env.AGENT_DEFAULT_SERVER_URL,
    })
    appendLog(
      job,
      `$ GOOS=${job.platform} GOARCH=${job.arch} CGO_ENABLED=0 ${this.opts.goBin} ${args.join(" ")}\n`
    )
    try {
      await fsp.mkdir(this.opts.updatesDir, { recursive: true })
    } catch (error) {
      this.finish(job, "failed", error instanceof Error ? error.message : "mkdir failed")
      return
    }

    let timedOut = false
    const spawnState: { error: Error | null } = { error: null }
    let child: ReturnType<SpawnImpl>
    try {
      child = this.spawnImpl(this.opts.goBin, args, {
        cwd: this.opts.sourceDir,
        env: { ...process.env, GOOS: job.platform, GOARCH: job.arch, CGO_ENABLED: "0" },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (error) {
      this.finish(job, "failed", error instanceof Error ? error.message : "spawn failed")
      return
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, this.timeoutMs)

    const closed = new Promise<number | null>((resolve) => {
      child.stdout?.on("data", (buf: Buffer | string) => appendLog(job, buf.toString()))
      child.stderr?.on("data", (buf: Buffer | string) => appendLog(job, buf.toString()))
      child.on("error", (err) => {
        spawnState.error = err
      })
      child.on("close", (code) => resolve(code))
    })

    let code: number | null
    try {
      code = await closed
    } finally {
      clearTimeout(timer)
    }

    if (timedOut) {
      this.finish(job, "failed", `compile timed out after ${Math.round(this.timeoutMs / 1000)}s`)
      return
    }
    if (spawnState.error) {
      const err = spawnState.error
      const missing = (err as NodeJS.ErrnoException).code === "ENOENT"
      this.finish(job, "failed", missing ? `go_not_found: ${GO_MISSING_HINT}` : err.message)
      return
    }
    if (code !== 0) {
      this.finish(job, "failed", `go build exited with code ${code ?? "unknown"}`)
      return
    }
    if (!(await this.exists(dest))) {
      this.finish(job, "failed", "build produced no binary")
      return
    }
    try {
      if (job.platform !== "windows") {
        await fsp.chmod(dest, 0o755).catch(() => undefined)
      }
      const size = (await fsp.stat(dest)).size
      const checksum = await hashFile(dest)
      const notes = job.lite ? "compiled via Builder (lite)" : "compiled via Builder"
      const row = await this.opts.persist({
        version: job.version,
        platform: job.platform,
        arch: job.arch,
        notes,
        path: dest,
        size,
        checksum,
      })
      job.updateId = row.id
      appendLog(job, `\ncompiled ${destName} (${size} bytes) updateId=${row.id}\n`)
      this.finish(job, "success", null)
    } catch (error) {
      this.finish(job, "failed", error instanceof Error ? error.message : "persist failed")
    }
  }
}
