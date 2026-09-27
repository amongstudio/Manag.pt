import assert from "node:assert/strict"
import { test } from "node:test"

import { hashPassword, normalizeUsername, passwordStrongEnough, verifyPassword } from "./operator-password.ts"

test("username must be 3-64 alphanumerics", () => {
  assert.equal(normalizeUsername("Operator"), "operator")
  assert.equal(normalizeUsername("ab"), null)
  assert.equal(normalizeUsername("bad name"), null)
})

test("password length bounds", () => {
  assert.equal(passwordStrongEnough("short"), false)
  assert.equal(passwordStrongEnough("longenough"), true)
})

test("scrypt hash verifies and rejects mismatch", async () => {
  const stored = await hashPassword("correct-horse")
  assert.equal(await verifyPassword(stored, "correct-horse"), true)
  assert.equal(await verifyPassword(stored, "wrong-horse"), false)
  assert.equal(await verifyPassword("not-a-hash", "correct-horse"), false)
})
