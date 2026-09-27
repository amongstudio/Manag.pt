type Waiter = { resolve: () => void }

const waiters = new Map<string, Set<Waiter>>()

export const COMMAND_POLL_MS = 2500

export function notifyCommandsQueued(deviceId: string): void {
  const set = waiters.get(deviceId)
  if (!set || set.size === 0) return
  waiters.delete(deviceId)
  for (const waiter of set) waiter.resolve()
}

export function waitForDeviceCommands(deviceId: string, ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", finish)
      const set = waiters.get(deviceId)
      if (set) {
        set.delete(waiter)
        if (set.size === 0) waiters.delete(deviceId)
      }
      resolve()
    }
    const waiter: Waiter = { resolve: finish }
    const timer = setTimeout(finish, ms)
    signal?.addEventListener("abort", finish, { once: true })
    let set = waiters.get(deviceId)
    if (!set) {
      set = new Set()
      waiters.set(deviceId, set)
    }
    set.add(waiter)
  })
}
