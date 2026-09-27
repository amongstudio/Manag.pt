import assert from "node:assert/strict"
import { test } from "node:test"

import {
  parseSmbConnect,
  parseSmbDir,
  parseSmbShares,
  shareBrowsePath,
  smbConnectConfirm,
  smbDisconnectConfirm,
  smbFailureMessage,
  smbJoinPath,
  smbParentPath,
  smbPathCrumbs,
} from "./win-smb.ts"

test("parseSmbShares and parseSmbDir skip bad rows", () => {
  const shares = parseSmbShares({
    truncated: true,
    shares: [
      { name: "data", path: "\\\\srv\\data", kind: "hosted", connected: true, hosted: true },
      { name: "Z:", path: "Z:\\", kind: "mapped", drive: "Z:", remote: "\\\\srv\\data", connected: true },
      { name: 1 },
    ],
  })
  assert.equal(shares.shares.length, 2)
  assert.equal(shares.truncated, true)
  assert.equal(shares.shares[0]?.hosted, true)
  const dir = parseSmbDir({
    path: "\\\\srv\\data",
    truncated: false,
    entries: [
      { name: "a.txt", path: "\\\\srv\\data\\a.txt", dir: false, size: 12 },
      { name: "docs", path: "\\\\srv\\data\\docs", dir: true },
      {},
    ],
  })
  assert.equal(dir.entries.length, 2)
  assert.equal(dir.entries[1]?.dir, true)
  const conn = parseSmbConnect({ unc: "\\\\srv\\data", connected: true, action: "connect", drive: "Z:" })
  assert.equal(conn?.drive, "Z:")
})

test("SMB path crumbs keep the share root", () => {
  const crumbs = smbPathCrumbs("\\\\files\\share\\dir\\a.txt")
  assert.equal(crumbs[0]?.path, "\\\\files\\share")
  assert.equal(crumbs.at(-1)?.path, "\\\\files\\share\\dir\\a.txt")
  assert.equal(smbParentPath("\\\\files\\share\\dir"), "\\\\files\\share")
  assert.equal(smbParentPath("\\\\files\\share"), "")
  assert.equal(smbJoinPath("\\\\files\\share", "dir"), "\\\\files\\share\\dir")
  assert.equal(smbJoinPath("\\\\files\\share", ".env"), "\\\\files\\share\\.env")
  assert.equal(shareBrowsePath({ path: "", remote: "\\\\srv\\data", drive: "Z:" }), "\\\\srv\\data")
  assert.equal(shareBrowsePath({ path: "Z:", remote: "", drive: "Z:" }), "Z:\\")
  const driveCrumbs = smbPathCrumbs("Z:\\docs")
  assert.equal(driveCrumbs[0]?.path, "Z:\\")
  assert.equal(smbParentPath("Z:\\docs"), "Z:\\")
})

test("smbFailureMessage maps access denied", () => {
  assert.match(smbFailureMessage({ error: "smb_access_denied" }, "failed"), /Access denied/)
  assert.match(smbFailureMessage({ error: "smb_not_connected" }, "failed"), /Connect/)
  assert.equal(smbFailureMessage({ error: "other" }, "failed"), "other")
  assert.match(smbFailureMessage({ error: "no_interactive_session" }, "failed"), /signed-in/)
  assert.equal(smbFailureMessage({ result: { error: "smb_access_denied" } }, "failed").includes("Access denied"), true)
  assert.match(smbConnectConfirm("\\\\srv\\data"), /WNetAddConnection2/)
  assert.match(smbDisconnectConfirm("Z:"), /Disconnect/)
})
