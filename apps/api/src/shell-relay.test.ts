import assert from "node:assert/strict"
import { test } from "node:test"

import {
  closeShellSession,
  closeShellSessionsForSocket,
  openShellSession,
  ownsShellSession,
  shellSessionFor,
} from "./shell-relay.ts"

test("one shell session per device; later open replaces", () => {
  const previous = openShellSession("dev-a", "sock-1")
  assert.equal(previous, undefined)
  assert.equal(shellSessionFor("dev-a")?.socketId, "sock-1")
  const replaced = openShellSession("dev-a", "sock-2")
  assert.equal(replaced?.socketId, "sock-1")
  assert.equal(shellSessionFor("dev-a")?.socketId, "sock-2")
  assert.equal(closeShellSession("dev-a")?.socketId, "sock-2")
  assert.equal(shellSessionFor("dev-a"), undefined)
})

test("disconnecting a socket closes only its owned sessions", () => {
  openShellSession("dev-b", "sock-x")
  openShellSession("dev-c", "sock-y")
  assert.deepEqual(closeShellSessionsForSocket("sock-x"), ["dev-b"])
  assert.equal(shellSessionFor("dev-b"), undefined)
  assert.equal(shellSessionFor("dev-c")?.socketId, "sock-y")
  closeShellSession("dev-c")
})

test("ownsShellSession only matches the owning socket", () => {
  openShellSession("dev-d", "sock-owner")
  assert.equal(ownsShellSession("dev-d", "sock-owner"), true)
  assert.equal(ownsShellSession("dev-d", "sock-other"), false)
  assert.equal(ownsShellSession("missing", "sock-owner"), false)
  closeShellSession("dev-d")
})
