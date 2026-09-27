export type EnrollDevice = {
  id: string
  hostname: string
  platform: string
  enrollmentKeyHash: string
}

export type EnrollDecision =
  | { action: "create" }
  | { action: "update"; deviceId: string; mintKey: boolean }
  | { action: "conflict"; deviceId: string; hostname: string }
  | { action: "forbidden"; error: "device_key_required" }

export function decideEnroll(input: {
  deviceKey?: string
  byId: EnrollDevice | null
  byHost: EnrollDevice | null
  keyMatches: (hash: string, key: string) => boolean
}): EnrollDecision {
  const { deviceKey, byId, byHost, keyMatches } = input

  const bindKnown = (row: EnrollDevice): EnrollDecision => {
    if (!row.enrollmentKeyHash) {
      return { action: "update", deviceId: row.id, mintKey: true }
    }
    if (deviceKey && keyMatches(row.enrollmentKeyHash, deviceKey)) {
      return { action: "update", deviceId: row.id, mintKey: false }
    }
    return { action: "forbidden", error: "device_key_required" }
  }

  if (byId) return bindKnown(byId)
  if (byHost) {
    if (!byHost.enrollmentKeyHash) {
      return { action: "update", deviceId: byHost.id, mintKey: true }
    }
    if (deviceKey && keyMatches(byHost.enrollmentKeyHash, deviceKey)) {
      return { action: "update", deviceId: byHost.id, mintKey: false }
    }
    return { action: "conflict", deviceId: byHost.id, hostname: byHost.hostname }
  }
  return { action: "create" }
}
