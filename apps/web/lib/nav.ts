import {
  BellIcon,
  BoxesIcon,
  ComputerIcon,
  FileTextIcon,
  LayoutDashboardIcon,
  MonitorIcon,
  ShieldIcon,
  PackageIcon,
  PuzzleIcon,
  ScrollTextIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  BookOpenIcon,
  type LucideIcon,
} from "lucide-react"

export const APP_NAV: Array<{ href: string; label: string; icon: LucideIcon }> = [
  { href: "/", label: "Overview", icon: LayoutDashboardIcon },
  { href: "/devices", label: "Devices", icon: MonitorIcon },
  { href: "/commands", label: "Commands", icon: ComputerIcon },
  { href: "/scripts", label: "Scripts", icon: ScrollTextIcon },
  { href: "/alerts", label: "Alerts", icon: BellIcon },
  { href: "/inventory", label: "Inventory", icon: BoxesIcon },
  { href: "/security", label: "Security", icon: ShieldIcon },
  { href: "/modules", label: "Modules", icon: PuzzleIcon },
  { href: "/builder", label: "Builder", icon: PackageIcon },
  { href: "/logs", label: "Logs", icon: FileTextIcon },
  { href: "/settings", label: "Settings", icon: SettingsIcon },
  { href: "/configuration", label: "Configuration", icon: SlidersHorizontalIcon },
  { href: "/docs", label: "Docs", icon: BookOpenIcon },
]

export function navLabelForPath(pathname: string): string {
  if (pathname === "/") return "Overview"
  const exact = APP_NAV.find((item) => item.href !== "/" && pathname === item.href)
  if (exact) return exact.label
  const nested = APP_NAV.filter((item) => item.href !== "/" && pathname.startsWith(`${item.href}/`)).sort(
    (a, b) => b.href.length - a.href.length
  )[0]
  return nested?.label ?? "Fleet"
}
