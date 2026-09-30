import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import Fastify from "fastify"
import type { ModuleManifestInput } from "@workspace/shared"

import { inspectPeArtifact } from "./module-artifact.ts"
import {
  moduleManifestFromRow,
  signModuleManifest,
  verifyStoredModule,
} from "./module-signing.ts"
import { registerAgentRoutes } from "./routes-agent.ts"
import { registerModuleRoutes } from "./routes-modules.ts"

function manifest(): ModuleManifestInput {
  return {
    id: "approved-tool",
    displayName: "Approved tool",
    version: "1.0.0",
    kind: "exe",
    platform: "windows",
    arch: "amd64",
    sha256: "ab".repeat(32),
    size: 512,
    entrypoint: "approved-tool.exe",
    action: "inspect",
    argumentsSchema: [
      { name: "count", type: "integer", required: true, maxLength: 3 },
      {
        name: "mode",
        type: "string",
        required: false,
        maxLength: 8,
        choices: ["safe", "audit"],
      },
    ],
    timeoutSec: 30,
    maxOutputBytes: 65_536,
    networkAllowed: false,
  }
}

function rowFrom(input: ModuleManifestInput) {
  const signed = signModuleManifest(input)
  return {
    ...input,
    argumentsSchema: JSON.stringify(input.argumentsSchema),
    ...signed,
  }
}

function peArtifact(dll: boolean): Buffer {
  const data = Buffer.alloc(512)
  data.write("MZ", 0, "binary")
  data.writeUInt32LE(0x80, 0x3c)
  data.write("PE\0\0", 0x80, "binary")
  data.writeUInt16LE(0x8664, 0x84)
  data.writeUInt16LE(1, 0x86)
  data.writeUInt16LE(0xf0, 0x94)
  data.writeUInt16LE(dll ? 0x2002 : 0x0002, 0x96)
  data.writeUInt16LE(0x20b, 0x98)
  return data
}

test("module manifest signatures fail closed after metadata tampering", () => {
  const row = rowFrom(manifest())
  assert.equal(verifyStoredModule(row), true)
  assert.deepEqual(
    moduleManifestFromRow(row).argumentsSchema,
    manifest().argumentsSchema
  )
  assert.equal(
    verifyStoredModule({ ...row, timeoutSec: row.timeoutSec + 1 }),
    false
  )
  assert.equal(verifyStoredModule({ ...row, sha256: "cd".repeat(32) }), false)
  assert.equal(
    verifyStoredModule({ ...row, signer: "ed25519:" + "00".repeat(32) }),
    false
  )
})

test("PE inspection distinguishes executables, DLLs, and architecture", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pc-module-test-"))
  try {
    const exe = path.join(dir, "tool.exe")
    const dll = path.join(dir, "plugin.dll")
    await writeFile(exe, peArtifact(false))
    await writeFile(dll, peArtifact(true))
    assert.deepEqual(await inspectPeArtifact(exe), {
      kind: "exe",
      arch: "amd64",
    })
    assert.deepEqual(await inspectPeArtifact(dll), {
      kind: "dll-plugin",
      arch: "amd64",
    })
    await assert.rejects(() => inspectPeArtifact(path.join(dir, "missing.exe")))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("module admin and agent lifecycle routes are registered", async () => {
  const app = Fastify()
  await registerModuleRoutes(app)
  await registerAgentRoutes(app)
  for (const route of [
    { method: "GET", url: "/api/v1/admin/modules" },
    { method: "POST", url: "/api/v1/admin/modules" },
    { method: "PATCH", url: "/api/v1/admin/modules/:id" },
    { method: "PUT", url: "/api/v1/admin/modules/:id/grants" },
    { method: "POST", url: "/api/v1/admin/modules/:id/runs" },
    { method: "POST", url: "/api/v1/admin/modules/:id/revoke" },
    { method: "GET", url: "/api/v1/agent/modules/:id" },
    { method: "GET", url: "/api/v1/agent/download-module" },
  ] as const) {
    assert.equal(app.hasRoute(route), true, `${route.method} ${route.url}`)
  }
  await app.close()
})
