import { readFileSync } from "node:fs"
import assert from "node:assert/strict"
import { test } from "node:test"

test("stamp windows installer copies helper, sets SCM recovery, and keeps existing config.yaml", () => {
  const src = readFileSync(new URL("./routes-builder.ts", import.meta.url), "utf8")
  assert.match(src, /Set-ServiceRecovery "PCManagerHelper"/)
  assert.match(src, /Set-ServiceRecovery "PCManagerAgent"/)
  assert.match(src, /Copy-Item \$helperSrc \$destHelper -Force/)
  assert.match(src, /if \(\(Test-Path \$configSrc\) -and -not \(Test-Path \$configDest\)\)/)
  assert.match(src, /SCM restart on failure is set for both services/)
})
