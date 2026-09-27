import { test } from "node:test"
import assert from "node:assert/strict"

import { decideEnroll } from "./enroll.ts"

const keyMatches = (hash: string, key: string) => hash === `h:${key}`

test("reclaim 409 when hostname+platform exists without deviceKey", () => {
  const decision = decideEnroll({
    byId: null,
    byHost: { id: "existing", hostname: "box", platform: "windows", enrollmentKeyHash: "h:old" },
    keyMatches,
  })
  assert.deepEqual(decision, { action: "conflict", deviceId: "existing", hostname: "box" })
})

test("matching deviceKey updates the existing hostname row", () => {
  const decision = decideEnroll({
    deviceKey: "old",
    byId: null,
    byHost: { id: "existing", hostname: "box", platform: "windows", enrollmentKeyHash: "h:old" },
    keyMatches,
  })
  assert.deepEqual(decision, { action: "update", deviceId: "existing", mintKey: false })
})

test("reset hash allows reclaim without key", () => {
  const decision = decideEnroll({
    byId: null,
    byHost: { id: "existing", hostname: "box", platform: "linux", enrollmentKeyHash: "" },
    keyMatches,
  })
  assert.deepEqual(decision, { action: "update", deviceId: "existing", mintKey: true })
})

test("create when no existing device", () => {
  const decision = decideEnroll({
    byId: null,
    byHost: null,
    keyMatches,
  })
  assert.equal(decision.action, "create")
})
