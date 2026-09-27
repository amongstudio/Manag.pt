/** In-memory interactive shell: one session per device. */
export type ShellRelaySession = {
  deviceId: string
  socketId: string
  openedAt: number
}

const byDevice = new Map<string, ShellRelaySession>()

export function shellSessionFor(deviceId: string): ShellRelaySession | undefined {
  return byDevice.get(deviceId)
}

/** Replace any existing session for this device. Returns the previous session if any. */
export function openShellSession(deviceId: string, socketId: string): ShellRelaySession | undefined {
  const previous = byDevice.get(deviceId)
  byDevice.set(deviceId, { deviceId, socketId, openedAt: Date.now() })
  return previous
}

export function closeShellSession(deviceId: string): ShellRelaySession | undefined {
  const session = byDevice.get(deviceId)
  if (!session) return undefined
  byDevice.delete(deviceId)
  return session
}

export function closeShellSessionsForSocket(socketId: string): string[] {
  const ids: string[] = []
  for (const [deviceId, session] of byDevice) {
    if (session.socketId !== socketId) continue
    byDevice.delete(deviceId)
    ids.push(deviceId)
  }
  return ids
}

export function ownsShellSession(deviceId: string, socketId: string): boolean {
  const session = byDevice.get(deviceId)
  return Boolean(session && session.socketId === socketId)
}
