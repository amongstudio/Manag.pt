"use client"

import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import { HistoryIcon, MonitorIcon } from "lucide-react"

import { api } from "@/lib/api"
import { readLastDevice } from "@/lib/last-device"
import { APP_NAV } from "@/lib/nav"
import { Button } from "@workspace/ui/components/button"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@workspace/ui/components/command"

type DeviceRow = { id: string; hostname: string; status: string }

export function CommandPalette() {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [lastDevice, setLastDevice] = React.useState<ReturnType<typeof readLastDevice>>(null)
  const devices = useQuery({
    queryKey: ["devices", "", "all"],
    queryFn: () => api<{ devices: DeviceRow[] }>("/api/v1/admin/devices"),
    staleTime: 30_000,
    enabled: open,
  })

  React.useEffect(() => {
    if (open) setLastDevice(readLastDevice())
  }, [open])

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey) || event.altKey) return
      event.preventDefault()
      setOpen((cur) => !cur)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  function go(href: string) {
    setOpen(false)
    router.push(href)
  }

  const rows = devices.data?.devices ?? []

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="text-muted-foreground"
        onClick={() => setOpen(true)}
      >
        Jump to…
        <span className="text-xs tracking-widest text-muted-foreground">Ctrl K</span>
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandInput placeholder="Pages, devices, last device…" />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          {lastDevice ? (
            <CommandGroup heading="Recent">
              <CommandItem value={`last device ${lastDevice.hostname}`} onSelect={() => go(`/devices/${lastDevice.id}`)}>
                <HistoryIcon />
                <span>Open last device</span>
                <span className="truncate text-muted-foreground">{lastDevice.hostname}</span>
              </CommandItem>
            </CommandGroup>
          ) : null}
          <CommandGroup heading="Pages">
            {APP_NAV.map((item) => (
              <CommandItem key={item.href} value={`page ${item.label}`} onSelect={() => go(item.href)}>
                <item.icon />
                <span>{item.label}</span>
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Devices">
            {rows.map((device) => (
              <CommandItem
                key={device.id}
                value={`device ${device.hostname} ${device.id}`}
                onSelect={() => go(`/devices/${device.id}`)}
              >
                <MonitorIcon />
                <span className="truncate">{device.hostname}</span>
                <span className="text-muted-foreground">{device.status}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  )
}
