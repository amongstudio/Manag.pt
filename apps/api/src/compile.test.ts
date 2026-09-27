import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"
import { test } from "node:test"

import {
  COMPILE_TIMEOUT_MS,
  CompileQueue,
  checkCompilePrereqs,
  goBuildArgs,
  goLdflags,
  SOURCE_MISSING_HINT,
  GO_MISSING_HINT,
  type SpawnImpl,
} from "./compile.ts"

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pc-compile-"))
  try {
    return await fn(dir)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
}

function fakeSpawn(opts: {
  writeOut?: boolean
  hang?: boolean
  exitCode?: number
  stdout?: string
  stderr?: string
}): SpawnImpl {
  return (_command, args) => {
    const ee = new EventEmitter()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const outIdx = args.indexOf("-o")
    const dest = outIdx >= 0 ? String(args[outIdx + 1]) : ""
    const child = Object.assign(ee, {
      stdout,
      stderr,
      kill() {
        queueMicrotask(() => ee.emit("close", 1, "SIGKILL"))
        return true
      },
    })
    if (!opts.hang) {
      void (async () => {
        if (opts.stdout) stdout.write(opts.stdout)
        if (opts.stderr) stderr.write(opts.stderr)
        stdout.end()
        stderr.end()
        if (opts.writeOut && dest) {
          await fsp.mkdir(path.dirname(dest), { recursive: true })
          await fsp.writeFile(dest, "fake-agent")
        }
        ee.emit("close", opts.exitCode ?? 0)
      })()
    }
    return child
  }
}

test("ldflags match Makefile -s -w -X main.Version", () => {
  assert.equal(goLdflags("3.2.1"), "-s -w -X main.Version=3.2.1")
  const args = goBuildArgs({ lite: true, version: "3.2.1", outPath: "out.exe" })
  assert.deepEqual(args, [
    "build",
    "-tags",
    "lite",
    "-ldflags",
    "-s -w -X main.Version=3.2.1",
    "-o",
    "out.exe",
    "./cmd/agent",
  ])
})

test("windows builds add windowsgui and optional DefaultServerURL", () => {
  assert.equal(
    goLdflags("3.2.1", { windowsGUI: true, defaultServerURL: "https://pc.example.com" }),
    "-s -w -X main.Version=3.2.1 -X github.com/pc-manager/agent/internal/config.DefaultServerURL=https://pc.example.com -H windowsgui",
  )
  const args = goBuildArgs({
    lite: false,
    version: "3.2.1",
    outPath: "out.exe",
    platform: "windows",
    defaultServerURL: "https://pc.example.com",
  })
  assert.deepEqual(args, [
    "build",
    "-ldflags",
    "-s -w -X main.Version=3.2.1 -X github.com/pc-manager/agent/internal/config.DefaultServerURL=https://pc.example.com -H windowsgui",
    "-o",
    "out.exe",
    "./cmd/agent",
  ])
})

test("checkCompilePrereqs rejects missing source", async () => {
  const result = await checkCompilePrereqs({
    sourceDir: path.join(os.tmpdir(), "missing-agent-src"),
    goBin: "go",
    exists: async () => false,
    probeGo: async () => true,
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error, "source_not_found")
    assert.equal(result.hint, SOURCE_MISSING_HINT)
  }
})

test("checkCompilePrereqs rejects missing go", async () => {
  const result = await checkCompilePrereqs({
    sourceDir: "/agent",
    goBin: "/no/such/go",
    exists: async () => true,
    probeGo: async () => false,
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error, "go_not_found")
    assert.equal(result.hint, GO_MISSING_HINT)
  }
})

test("compile queue rejects when source is missing", async () => {
  await withTempDir(async (dir) => {
    const queue = new CompileQueue({
      sourceDir: path.join(dir, "agent"),
      goBin: "go",
      updatesDir: path.join(dir, "updates"),
      probeGo: async () => true,
      persist: async () => ({ id: "u1" }),
    })
    const started = await queue.start({ platform: "linux", arch: "amd64", version: "3.2.1", lite: false })
    assert.equal(started.ok, false)
    if (!started.ok) {
      assert.equal(started.status, 400)
      assert.equal(started.error, "source_not_found")
      assert.equal(started.details?.hint, SOURCE_MISSING_HINT)
    }
  })
})

test("compile queue rejects when go is missing", async () => {
  await withTempDir(async (dir) => {
    const src = path.join(dir, "agent")
    await fsp.mkdir(path.join(src, "cmd", "agent"), { recursive: true })
    await fsp.writeFile(path.join(src, "go.mod"), "module agent\n")
    const queue = new CompileQueue({
      sourceDir: src,
      goBin: path.join(dir, "no-go"),
      updatesDir: path.join(dir, "updates"),
      probeGo: async () => false,
      persist: async () => ({ id: "u1" }),
    })
    const started = await queue.start({ platform: "windows", arch: "amd64", version: "3.2.1", lite: false })
    assert.equal(started.ok, false)
    if (!started.ok) {
      assert.equal(started.status, 400)
      assert.equal(started.error, "go_not_found")
    }
  })
})

test("compile queue runs one job and persists the binary", async () => {
  await withTempDir(async (dir) => {
    const src = path.join(dir, "agent")
    await fsp.mkdir(path.join(src, "cmd", "agent"), { recursive: true })
    await fsp.writeFile(path.join(src, "go.mod"), "module agent\n")
    const persisted: string[] = []
    const queue = new CompileQueue({
      sourceDir: src,
      goBin: "go",
      updatesDir: path.join(dir, "updates"),
      probeGo: async () => true,
      spawn: fakeSpawn({ writeOut: true, stdout: "ok\n" }),
      persist: async (artifact) => {
        persisted.push(artifact.path)
        assert.equal(artifact.platform, "linux")
        assert.equal(artifact.arch, "amd64")
        assert.equal(artifact.notes, "compiled via Builder")
        assert.ok(artifact.checksum.length === 64)
        return { id: "upd_1" }
      },
    })
    const started = await queue.start({ platform: "linux", arch: "amd64", version: "3.2.1", lite: false })
    assert.equal(started.ok, true)
    if (!started.ok) return
    const done = await queue.settled(started.job.id)
    assert.equal(done.status, "success")
    assert.equal(done.updateId, "upd_1")
    assert.match(done.log, /GOOS=linux GOARCH=amd64 CGO_ENABLED=0/)
    assert.equal(persisted.length, 1)
  })
})

test("compile queue is one job at a time", async () => {
  await withTempDir(async (dir) => {
    const src = path.join(dir, "agent")
    await fsp.mkdir(path.join(src, "cmd", "agent"), { recursive: true })
    await fsp.writeFile(path.join(src, "go.mod"), "module agent\n")
    const queue = new CompileQueue({
      sourceDir: src,
      goBin: "go",
      updatesDir: path.join(dir, "updates"),
      timeoutMs: 200,
      probeGo: async () => true,
      spawn: fakeSpawn({ hang: true }),
      persist: async () => ({ id: "u1" }),
    })
    const first = await queue.start({ platform: "linux", arch: "amd64", version: "3.2.1", lite: false })
    assert.equal(first.ok, true)
    const second = await queue.start({ platform: "windows", arch: "amd64", version: "3.2.1", lite: false })
    assert.equal(second.ok, false)
    if (!second.ok) {
      assert.equal(second.status, 409)
      assert.equal(second.error, "compile_busy")
    }
    if (first.ok) {
      assert.equal(queue.get(first.job.id)?.status, "running")
      const done = await queue.settled(first.job.id)
      assert.equal(done.status, "failed")
    }
  })
})

test("compile timeout is six minutes by default", () => {
  assert.equal(COMPILE_TIMEOUT_MS, 6 * 60 * 1000)
})
