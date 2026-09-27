import assert from "node:assert/strict"
import { test } from "node:test"

import { APP_VERSION } from "./constants.ts"
import { compileJobViewSchema, compileRequestSchema } from "./compile.ts"

test("compile body requires platform and arch", () => {
  const parsed = compileRequestSchema.parse({ platform: "linux", arch: "amd64" })
  assert.equal(parsed.platform, "linux")
  assert.equal(parsed.arch, "amd64")
  assert.equal(parsed.version, APP_VERSION)
  assert.equal(parsed.lite, false)
})

test("compile body accepts version and lite", () => {
  const parsed = compileRequestSchema.parse({
    platform: "windows",
    arch: "arm64",
    version: "3.2.1-rc1",
    lite: true,
  })
  assert.equal(parsed.version, "3.2.1-rc1")
  assert.equal(parsed.lite, true)
})

test("compile body rejects unknown platform or unsafe version", () => {
  assert.equal(compileRequestSchema.safeParse({ platform: "freebsd", arch: "amd64" }).success, false)
  assert.equal(compileRequestSchema.safeParse({ platform: "linux", arch: "riscv" }).success, false)
  assert.equal(
    compileRequestSchema.safeParse({ platform: "linux", arch: "amd64", version: "1.0;rm" }).success,
    false
  )
})

test("compile job view requires status log error updateId", () => {
  const parsed = compileJobViewSchema.parse({
    id: "job_1",
    status: "running",
    log: "building\n",
    error: null,
    updateId: null,
  })
  assert.equal(parsed.status, "running")
  assert.equal(parsed.updateId, null)
  assert.equal(compileJobViewSchema.safeParse({ status: "running" }).success, false)
})
