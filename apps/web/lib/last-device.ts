const LAST_DEVICE_KEY = "pc_last_device"

export type LastDevice = { id: string; hostname: string }

export function readLastDevice(): LastDevice | null {
  if (typeof window === "undefined") return null
  try {
    const raw = localStorage.getItem(LAST_DEVICE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<LastDevice>
    if (typeof parsed.id !== "string" || !parsed.id) return null
    return { id: parsed.id, hostname: typeof parsed.hostname === "string" ? parsed.hostname : parsed.id }
  } catch {
    return null
  }
}

export function writeLastDevice(device: LastDevice): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(LAST_DEVICE_KEY, JSON.stringify(device))
  } catch {
    /* ignore quota / private mode */
  }
}
