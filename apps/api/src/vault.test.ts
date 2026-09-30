import assert from "node:assert/strict"
import { test } from "node:test"

import { redactCredentialCommand } from "@workspace/shared"

import {
  encryptVaultSecret,
  decryptVaultSecret,
  hydrateCommandPayload,
  sealCommandPayload,
  vaultSecretState,
} from "./vault.ts"

test("vault AES-256-GCM roundtrips and rejects tamper", () => {
  const enc = encryptVaultSecret("s3cret!")
  assert.match(enc, /^v1:/)
  assert.equal(decryptVaultSecret(enc), "s3cret!")
  assert.notEqual(enc, encryptVaultSecret("s3cret!"))
  const buf = Buffer.from(enc.slice(3), "base64")
  buf[20] ^= 0xff
  const tampered = "v1:" + buf.toString("base64")
  assert.throws(() => decryptVaultSecret(tampered))
})

test("seal and hydrate set_credential without leaving plaintext", () => {
  const sealed = sealCommandPayload("set_credential", { target: "Git:https://github.com", username: "a", secret: "pw" })
  assert.equal(sealed.secret, undefined)
  assert.equal(typeof sealed.secretEnc, "string")
  const hyd = hydrateCommandPayload("set_credential", sealed) as { secret?: string; secretEnc?: string }
  assert.equal(hyd.secret, "pw")
  assert.equal(hyd.secretEnc, undefined)
  const shown = redactCredentialCommand("set_credential", sealed, { password: "pw" })
  assert.equal((shown.payload as { secretEnc?: string }).secretEnc, "[redacted]")
  assert.equal((shown.result as { password?: string }).password, "[redacted]")
})

test("restore credentials seal each secret", () => {
  const sealed = sealCommandPayload("restore_credentials", {
    credentials: [{ target: "app:demo", secret: "one" }],
  }) as { credentials: Array<{ secret?: string; secretEnc?: string }> }
  assert.equal(sealed.credentials[0]?.secret, undefined)
  const hyd = hydrateCommandPayload("restore_credentials", sealed) as {
    credentials: Array<{ secret?: string }>
  }
  assert.equal(hyd.credentials[0]?.secret, "one")
})

test("seal and hydrate set_bitlocker secrets without leaving plaintext", () => {
  const sealed = sealCommandPayload("set_bitlocker", {
    action: "unlock",
    mountPoint: "D:",
    password: "pw",
    recoveryPassword: "111111-222222",
  })
  assert.equal(sealed.password, undefined)
  assert.equal(sealed.recoveryPassword, undefined)
  assert.equal(typeof sealed.passwordEnc, "string")
  assert.equal(typeof sealed.recoveryPasswordEnc, "string")
  const hyd = hydrateCommandPayload("set_bitlocker", sealed) as {
    password?: string
    recoveryPassword?: string
    passwordEnc?: string
    recoveryPasswordEnc?: string
  }
  assert.equal(hyd.password, "pw")
  assert.equal(hyd.recoveryPassword, "111111-222222")
  assert.equal(hyd.passwordEnc, undefined)
  assert.equal(hyd.recoveryPasswordEnc, undefined)
  const shown = redactCredentialCommand("set_bitlocker", sealed, { recoveryPassword: "111111-222222" })
  assert.equal((shown.payload as { recoveryPasswordEnc?: string }).recoveryPasswordEnc, "[redacted]")
  assert.equal((shown.result as { recoveryPassword?: string }).recoveryPassword, "[redacted]")
})

test("seal and hydrate smb_connect password without leaving plaintext", () => {
  const sealed = sealCommandPayload("smb_connect", { unc: "\\\\srv\\share", username: "u", password: "pw" })
  assert.equal(sealed.password, undefined)
  assert.equal(typeof sealed.passwordEnc, "string")
  const hyd = hydrateCommandPayload("smb_connect", sealed) as { password?: string; passwordEnc?: string }
  assert.equal(hyd.password, "pw")
  assert.equal(hyd.passwordEnc, undefined)
  const shown = redactCredentialCommand("smb_connect", sealed, { connected: true })
  assert.equal((shown.payload as { passwordEnc?: string }).passwordEnc, "[redacted]")
  const forwarded = sealCommandPayload("smb_connect", {
    unc: "\\\\srv\\share",
    password: "pw",
    meshForward: "dev-b",
  })
  assert.equal(forwarded.password, undefined)
  assert.equal(forwarded.passwordEnc, undefined)
  assert.equal(forwarded.meshForward, "dev-b")
})

test("local_user_action password is sealed at rest and hydrated only for dispatch", () => {
  const sealed = sealCommandPayload("local_user_action", { username: "bob", action: "set_password", password: "N3w-pass!" })
  assert.equal(sealed.password, undefined)
  assert.equal(JSON.stringify(sealed).includes("N3w-pass!"), false)
  const hyd = hydrateCommandPayload("local_user_action", sealed) as { password?: string; passwordEnc?: string }
  assert.equal(hyd.password, "N3w-pass!")
  assert.equal(hyd.passwordEnc, undefined)
  const shown = redactCredentialCommand("local_user_action", sealed, { ok: true })
  assert.equal((shown.payload as { passwordEnc?: string }).passwordEnc, "[redacted]")
})

test("vault secret state distinguishes stored, metadata, decrypt failure, and unsupported", () => {
  assert.equal(vaultSecretState({ source: "windows", kind: "generic", secretEnc: encryptVaultSecret("x") }), "stored")
  assert.equal(vaultSecretState({ source: "windows", kind: "generic", secretEnc: "" }), "metadata_only")
  assert.equal(vaultSecretState({ source: "windows", kind: "domain", secretEnc: "" }), "unsupported_source")
  assert.equal(vaultSecretState({ source: "browser", kind: "password", secretEnc: "" }), "metadata_only")
  assert.equal(vaultSecretState({ source: "windows", kind: "generic", secretEnc: "v1:AAAA" }), "decrypt_failed")
  assert.equal(vaultSecretState({ source: "windows", kind: "generic", secretEnc: "legacy" }), "decrypt_failed")
})
