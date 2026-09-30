export const DEVICE_ADMIN_TABS = [
  { id: "metrics", label: "Metrics" },
  { id: "hardware", label: "Hardware" },
  { id: "software", label: "Software" },
  { id: "users", label: "Users" },
  { id: "services", label: "Services" },
  { id: "registry", label: "Registry" },
  { id: "credentials", label: "Credentials" },
  { id: "network", label: "Network" },
  { id: "windows", label: "Windows" },
] as const

export const DEVICE_HISTORY_TABS = [
  { id: "commands", label: "Commands" },
  { id: "screenshots", label: "Screenshots" },
  { id: "chat", label: "Chat" },
] as const

export const DEVICE_TAB_GROUPS = [
  { id: "desktop", label: "Desktop" },
  { id: "files", label: "Files" },
  { id: "admin", label: "Admin", children: DEVICE_ADMIN_TABS },
  { id: "processes", label: "Processes" },
  { id: "shell", label: "Shell" },
  { id: "history", label: "History", children: DEVICE_HISTORY_TABS },
] as const

export type DevicePrimaryId = (typeof DEVICE_TAB_GROUPS)[number]["id"]
export type DeviceAdminId = (typeof DEVICE_ADMIN_TABS)[number]["id"]
export type DeviceHistoryId = (typeof DEVICE_HISTORY_TABS)[number]["id"]
export type DeviceSectionId = Exclude<DevicePrimaryId, "admin" | "history"> | DeviceAdminId | DeviceHistoryId

/** Leaf hashes used by old `#services` / `#chat` links and the devices peek sheet. */
function leafDeviceSections(): Array<{ id: DeviceSectionId; label: string }> {
  const sections: Array<{ id: DeviceSectionId; label: string }> = []
  for (const group of DEVICE_TAB_GROUPS) {
    if ("children" in group) {
      for (const child of group.children) sections.push({ id: child.id, label: child.label })
    } else {
      sections.push({ id: group.id, label: group.label })
    }
  }
  return sections
}

export const DEVICE_SECTIONS = leafDeviceSections()

export type DeviceTabState = {
  primary: DevicePrimaryId
  admin: DeviceAdminId
  history: DeviceHistoryId
}

export const DEFAULT_DEVICE_TAB: DeviceTabState = {
  primary: "desktop",
  admin: "services",
  history: "commands",
}

const ADMIN_BY_ID = new Map<string, DeviceAdminId>(DEVICE_ADMIN_TABS.map((tab) => [tab.id, tab.id]))
const HISTORY_BY_ID = new Map<string, DeviceHistoryId>(DEVICE_HISTORY_TABS.map((tab) => [tab.id, tab.id]))
const PRIMARY_BY_ID = new Map<string, DevicePrimaryId>(DEVICE_TAB_GROUPS.map((tab) => [tab.id, tab.id]))

export function parseDeviceHash(raw: string): DeviceTabState {
  const hash = raw.replace(/^#/, "").trim().toLowerCase()
  const admin = ADMIN_BY_ID.get(hash)
  if (admin) return { ...DEFAULT_DEVICE_TAB, primary: "admin", admin }
  const history = HISTORY_BY_ID.get(hash)
  if (history) return { ...DEFAULT_DEVICE_TAB, primary: "history", history }
  const primary = PRIMARY_BY_ID.get(hash)
  if (primary) return { ...DEFAULT_DEVICE_TAB, primary }
  return { ...DEFAULT_DEVICE_TAB }
}

/** Nested hashes so `#services` and `#commands` keep working; group ids for `#admin` / `#history`. */
export function deviceHashFor(tab: DeviceTabState): string {
  if (tab.primary === "admin") return tab.admin
  if (tab.primary === "history") return tab.history
  return tab.primary
}

export function isDevicePrimaryId(value: string): value is DevicePrimaryId {
  return PRIMARY_BY_ID.has(value)
}

export function isDeviceAdminId(value: string): value is DeviceAdminId {
  return ADMIN_BY_ID.has(value)
}

export function isDeviceHistoryId(value: string): value is DeviceHistoryId {
  return HISTORY_BY_ID.has(value)
}
