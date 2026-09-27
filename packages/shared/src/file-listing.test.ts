import assert from "node:assert/strict"
import { test } from "node:test"

import {
  inspectLatestListing,
  latestSuccessfulListing,
  listingFailureMessage,
  parseFileListResult,
  queuedCommandId,
  transferRemainingBytes,
} from "./file-listing.ts"

test("parseFileListResult applies get_files object", () => {
  const parsed = parseFileListResult({
    path: "C:\\Users",
    roots: ["C:\\"],
    truncated: true,
    entries: [{ name: "a", path: "C:\\Users\\a", dir: true, size: 0 }],
  })
  assert.equal(parsed.path, "C:\\Users")
  assert.deepEqual(parsed.roots, ["C:\\"])
  assert.equal(parsed.truncated, true)
  assert.equal(parsed.entries[0]?.name, "a")
})

test("parseFileListResult uses search_files hits", () => {
  const parsed = parseFileListResult({
    path: ".",
    hits: [{ name: "readme.md", path: "readme.md", dir: false, size: 12 }],
  })
  assert.equal(parsed.entries.length, 1)
  assert.equal(parsed.entries[0]?.name, "readme.md")
})

test("latestSuccessfulListing skips newer failed rows", () => {
  const seed = latestSuccessfulListing([
    { id: "3", type: "get_files", status: "failed", result: { error: "sandbox" } },
    { id: "2", type: "get_files", status: "success", result: { entries: [] } },
    { id: "1", type: "mkdir", status: "success" },
  ])
  assert.equal(seed?.id, "2")
})

test("inspectLatestListing prefers inflight over older success", () => {
  const inspect = inspectLatestListing([
    { id: "4", type: "get_files", status: "pending" },
    { id: "2", type: "get_files", status: "success", result: { entries: [] } },
  ])
  assert.equal(inspect.kind, "inflight")
  if (inspect.kind === "inflight") assert.equal(inspect.command.id, "4")
})

test("queuedCommandId reads POST /commands body", () => {
  assert.equal(queuedCommandId({ commands: [{ id: "cmd-1" }] }), "cmd-1")
  assert.equal(queuedCommandId({ commands: [] }), undefined)
})

test("listingFailureMessage and remaining bytes", () => {
  assert.equal(listingFailureMessage({ error: "sandbox_denied" }, "failed"), "sandbox_denied")
  assert.equal(listingFailureMessage({ result: { error: "sandbox_denied" } }, "failed"), "sandbox_denied")
  assert.equal(listingFailureMessage(null, "cancelled"), "Cancelled")
  assert.equal(transferRemainingBytes(10, 40), 30)
  assert.equal(transferRemainingBytes(undefined, 40), 40)
})
