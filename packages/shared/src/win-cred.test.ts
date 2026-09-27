import assert from "node:assert/strict"
import { test } from "node:test"

import {
  credentialBackupConfirm,
  credentialVaultDeleteConfirm,
  isCredentialCommandType,
  needsSecretRedaction,
  parseCredentials,
  redactCredentialCommand,
  stripCredentialSecrets,
  stripMeshCommandSecrets,
} from "./win-cred.ts"

test("parseCredentials reads session lock notes", () => {
  const parsed = parseCredentials({
    revealed: false,
    sessionOk: false,
    needsSession: true,
    browserLocked: true,
    session0: true,
    counts: { windows: 2, browser: 1, apps: 1, generated: 0, locked: 1, total: 4 },
    notes: ["no_interactive_session"],
    credentials: [
      { key: "browser|https://ex|a", source: "browser", kind: "password", target: "https://ex", username: "a", locked: true },
      { target: "" },
    ],
  })
  assert.equal(parsed.credentials.length, 1)
  assert.equal(parsed.sessionOk, false)
  assert.equal(parsed.browserLocked, true)
  assert.equal(parsed.session0, true)
  assert.equal(parsed.counts.windows, 2)
  assert.equal(parsed.counts.browser, 1)
  assert.equal(parsed.credentials[0]?.locked, true)
})

test("stripCredentialSecrets redacts secret and password", () => {
  const stripped = stripCredentialSecrets({
    credentials: [{ target: "x", secret: "hunter2", username: "a" }],
    password: "hunter2",
  }) as { credentials: Array<{ secret?: string; username?: string }>; password?: string }
  assert.equal(stripped.password, "[redacted]")
  assert.equal(stripped.credentials[0]?.secret, "[redacted]")
  assert.equal(stripped.credentials[0]?.username, "a")
  assert.equal(isCredentialCommandType("backup_credentials"), true)
  const redacted = redactCredentialCommand("set_credential", { target: "x", secret: "s" }, { password: "p" })
  assert.equal((redacted.payload as { secret: string }).secret, "[redacted]")
  assert.match(credentialBackupConfirm(), /AES-256-GCM/)
  assert.match(credentialVaultDeleteConfirm("app:demo"), /vault copy/)
})

test("smb_connect passwords are redacted in history and dropped for mesh", () => {
  assert.equal(needsSecretRedaction("smb_connect"), true)
  assert.equal(needsSecretRedaction("get_smb"), false)
  const redacted = redactCredentialCommand(
    "smb_connect",
    { unc: "\\\\srv\\share", username: "u", password: "hunter2" },
    { connected: true, password: "hunter2" }
  )
  assert.equal((redacted.payload as { password?: string; username?: string }).password, "[redacted]")
  assert.equal((redacted.payload as { username?: string }).username, "u")
  assert.equal((redacted.result as { password?: string; connected?: boolean }).password, "[redacted]")
  assert.equal((redacted.result as { connected?: boolean }).connected, true)
  const dropped = stripMeshCommandSecrets("smb_connect", {
    unc: "\\\\srv\\share",
    password: "hunter2",
    passwordEnc: "v1:abc",
    meshForward: "dev-b",
  })
  assert.equal(dropped.password, undefined)
  assert.equal(dropped.passwordEnc, undefined)
  assert.equal(dropped.meshForward, "dev-b")
  assert.equal(dropped.unc, "\\\\srv\\share")
})

test("set_bitlocker recovery passwords are redacted and dropped on mesh", () => {
  assert.equal(needsSecretRedaction("set_bitlocker"), true)
  const redacted = redactCredentialCommand(
    "set_bitlocker",
    { action: "unlock", mountPoint: "D:", recoveryPassword: "111111-222222" },
    { recoveryPassword: "111111-222222", applied: true }
  )
  assert.equal((redacted.payload as { recoveryPassword?: string }).recoveryPassword, "[redacted]")
  assert.equal((redacted.result as { recoveryPassword?: string }).recoveryPassword, "[redacted]")
  assert.equal((redacted.result as { applied?: boolean }).applied, true)
  const dropped = stripMeshCommandSecrets("set_bitlocker", {
    action: "unlock",
    mountPoint: "D:",
    password: "pw",
    recoveryPassword: "111111-222222",
    recoveryPasswordEnc: "v1:abc",
    meshForward: "dev-b",
  })
  assert.equal(dropped.password, undefined)
  assert.equal(dropped.recoveryPassword, undefined)
  assert.equal(dropped.recoveryPasswordEnc, undefined)
  assert.equal(dropped.mountPoint, "D:")
})
