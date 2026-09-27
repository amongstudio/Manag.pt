"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useVirtualizer } from "@tanstack/react-virtual"
import { MonitorIcon, PanelRightIcon, SearchIcon } from "lucide-react"
import { toast } from "sonner"

import { api, formatWhen } from "@/lib/api"
import { BulkProgressLabel, trackBulkCommands } from "@/lib/bulk-command-progress"
import { DEVICE_TAB_GROUPS } from "@/lib/device-sections"
import { useDebouncedValue } from "@/lib/hooks"
import { CommandComposer } from "@/components/command-composer"
import { QueryErrorBanner, QueryErrorState } from "@/components/query-error"
import { StatusBadge } from "@/components/status-badge"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@workspace/ui/components/alert-dialog"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Checkbox } from "@workspace/ui/components/checkbox"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@workspace/ui/components/input-group"
import { Skeleton } from "@workspace/ui/components/skeleton"
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import { ToggleGroup, ToggleGroupItem } from "@workspace/ui/components/toggle-group"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@workspace/ui/components/sheet"
import { cn } from "@workspace/ui/lib/utils"

type DeviceRow = {
  id: string
  hostname: string
  platform: string
  arch: string
  agentVersion: string
  status: string
  lastSeen: string
  ip: string | null
  watching?: boolean
}

type DeviceStatusFilter = "all" | "online" | "offline"

function parseDeviceStatus(value: string | null | undefined): DeviceStatusFilter {
  if (value === "online" || value === "offline") return value
  return "all"
}

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  )
}

export function DevicesPage({ initial }: { initial?: { devices: DeviceRow[] } | null }) {
  const client = useQueryClient()
  const router = useRouter()
  const searchParams = useSearchParams()
  const status = parseDeviceStatus(searchParams.get("status"))
  const [search, setSearch] = React.useState("")
  const debouncedSearch = useDebouncedValue(search, 300)
  const [selected, setSelected] = React.useState<string[]>([])
  const [peek, setPeek] = React.useState<DeviceRow | null>(null)
  const [confirmRestart, setConfirmRestart] = React.useState(false)
  const [scrollEl, setScrollEl] = React.useState<HTMLDivElement | null>(null)
  const [focusedIndex, setFocusedIndex] = React.useState(0)
  const isDefaultView = debouncedSearch === "" && status === "all"
  const query = useQuery({
    queryKey: ["devices", debouncedSearch, status],
    queryFn: () => {
      const params = new URLSearchParams()
      if (debouncedSearch) params.set("search", debouncedSearch)
      if (status !== "all") params.set("status", status)
      const q = params.toString()
      return api<{ devices: DeviceRow[] }>(`/api/v1/admin/devices${q ? `?${q}` : ""}`)
    },
    initialData: isDefaultView ? (initial ?? undefined) : undefined,
    initialDataUpdatedAt: 0,
    staleTime: 30_000,
  })
  const devices = query.data?.devices ?? []
  const virtualizer = useVirtualizer({
    count: devices.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => 56,
    overscan: 12,
  })
  const bulk = useMutation({
    mutationFn: (type: "restart" | "capture_screenshot") =>
      api<{ commands: { id: string }[] }>("/api/v1/admin/commands", {
        method: "POST",
        body: JSON.stringify({ deviceIds: selected, type, payload: {} }),
      }),
    onSuccess: (data, type) => {
      trackBulkCommands(data.commands.map((c) => c.id))
      toast.success(type === "restart" ? "Restart queued" : "Screenshot queued")
      void client.invalidateQueries({ queryKey: ["commands"] })
      void client.invalidateQueries({ queryKey: ["overview"] })
    },
    onError: (e) => toast.error(e.message),
  })

  React.useEffect(() => {
    scrollEl?.scrollTo({ top: 0 })
  }, [debouncedSearch, status, scrollEl])

  React.useEffect(() => {
    setFocusedIndex(0)
  }, [debouncedSearch, status, devices.length])

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === "/" && !isTypingTarget(event.target)) {
        event.preventDefault()
        document.getElementById("device-search")?.focus()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  function setStatusFilter(next: string) {
    const params = new URLSearchParams(searchParams.toString())
    const value = parseDeviceStatus(next)
    if (value === "all") params.delete("status")
    else params.set("status", value)
    const q = params.toString()
    router.replace(q ? `/devices?${q}` : "/devices", { scroll: false })
  }

  function openDevice(index: number) {
    const device = devices[index]
    if (!device) return
    router.push(`/devices/${device.id}`)
  }

  function onSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setFocusedIndex((cur) => Math.min(devices.length - 1, cur + 1))
      return
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      setFocusedIndex((cur) => Math.max(0, cur - 1))
      return
    }
    if (event.key === "Enter" && devices[focusedIndex]) {
      event.preventDefault()
      openDevice(focusedIndex)
    }
  }

  const virtualItems = virtualizer.getVirtualItems()
  const renderedItems =
    virtualItems.length > 0 ? virtualItems : devices.map((_, index) => ({ index }))
  const paddingTop = virtualItems.length > 0 ? virtualItems[0]!.start : 0
  const paddingBottom =
    virtualItems.length > 0 ? virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1]!.end : 0
  const command = (
    <CommandComposer
      deviceIds={selected}
      triggerLabel={selected.length ? `Command (${selected.length})` : "Command"}
      showProgress={false}
    />
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <InputGroup className="md:max-w-sm">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            id="device-search"
            placeholder="Search hostname, IP, id"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={onSearchKeyDown}
          />
        </InputGroup>
        <ToggleGroup
          value={[status]}
          onValueChange={(value) => setStatusFilter(value[0] ?? "all")}
          spacing={2}
        >
          <ToggleGroupItem value="all">All</ToggleGroupItem>
          <ToggleGroupItem value="online">Online</ToggleGroupItem>
          <ToggleGroupItem value="offline">Offline</ToggleGroupItem>
        </ToggleGroup>
        <div className="flex items-center gap-2 md:ml-auto">
          {!selected.length ? command : null}
          {!selected.length ? <BulkProgressLabel /> : null}
        </div>
      </div>
      {selected.length ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
          <span className="text-sm">{selected.length} selected</span>
          <BulkProgressLabel />
          <Button size="sm" variant="outline" onClick={() => setConfirmRestart(true)} disabled={bulk.isPending}>
            Restart
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => bulk.mutate("capture_screenshot")}
            disabled={bulk.isPending}
          >
            Screenshot
          </Button>
          {command}
          <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
            Clear
          </Button>
        </div>
      ) : null}
      {query.isError && query.data ? (
        <QueryErrorBanner cached error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      {query.isError && !query.data ? (
        <QueryErrorState title="Devices unavailable" error={query.error} onRetry={() => void query.refetch()} />
      ) : query.isLoading && !devices.length ? (
        <Skeleton className="h-64" />
      ) : !devices.length ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <MonitorIcon />
            </EmptyMedia>
            <EmptyTitle>No devices match</EmptyTitle>
            <EmptyDescription>Enroll an agent or clear the search filter.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button render={<Link href="/settings" />} nativeButton={false} variant="outline">
              Open settings
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div
          ref={setScrollEl}
          className="relative min-h-24 max-h-[min(70vh,40rem)] overflow-auto rounded-lg border"
        >
          <table className="w-full caption-bottom text-sm">
            <TableHeader>
              <TableRow>
                <TableHead className="sticky top-0 z-10 w-10 bg-background">
                  <Checkbox
                    checked={selected.length === devices.length && devices.length > 0}
                    onCheckedChange={(checked) => setSelected(checked ? devices.map((d) => d.id) : [])}
                  />
                </TableHead>
                <TableHead className="sticky top-0 z-10 bg-background">Host</TableHead>
                <TableHead className="sticky top-0 z-10 bg-background">Status</TableHead>
                <TableHead className="sticky top-0 z-10 bg-background">Last seen</TableHead>
                <TableHead className="sticky top-0 z-10 w-12 bg-background">
                  <span className="sr-only">Peek</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paddingTop > 0 ? (
                <tr>
                  <td colSpan={5} style={{ height: paddingTop }} />
                </tr>
              ) : null}
              {renderedItems.map((virtualRow) => {
                const device = devices[virtualRow.index]
                if (!device) return null
                return (
                  <TableRow
                    key={device.id}
                    data-index={virtualRow.index}
                    data-state={focusedIndex === virtualRow.index ? "selected" : undefined}
                    ref={virtualizer.measureElement}
                    className={cn("cursor-pointer")}
                    onClick={() => openDevice(virtualRow.index)}
                    onMouseEnter={() => setFocusedIndex(virtualRow.index)}
                  >
                    <TableCell
                      onClick={(event) => event.stopPropagation()}
                      onPointerDown={(event) => event.stopPropagation()}
                    >
                      <Checkbox
                        checked={selected.includes(device.id)}
                        onCheckedChange={(checked) =>
                          setSelected((cur) => (checked ? [...cur, device.id] : cur.filter((id) => id !== device.id)))
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col">
                        <Link
                          href={`/devices/${device.id}`}
                          className="font-medium underline-offset-4 hover:underline"
                          onClick={(event) => event.stopPropagation()}
                        >
                          {device.hostname}
                        </Link>
                        <span className="text-xs text-muted-foreground">
                          {device.platform}/{device.arch} · {device.agentVersion}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={device.status} />
                    </TableCell>
                    <TableCell>{formatWhen(device.lastSeen)}</TableCell>
                    <TableCell onClick={(event) => event.stopPropagation()}>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        title="Peek"
                        onClick={() => setPeek(device)}
                      >
                        <PanelRightIcon />
                        <span className="sr-only">Peek {device.hostname}</span>
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
              {paddingBottom > 0 ? (
                <tr>
                  <td colSpan={5} style={{ height: paddingBottom }} />
                </tr>
              ) : null}
            </TableBody>
          </table>
        </div>
      )}
      <Sheet open={!!peek} onOpenChange={(open) => !open && setPeek(null)}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{peek?.hostname}</SheetTitle>
            <SheetDescription>{peek?.id}</SheetDescription>
          </SheetHeader>
          {peek ? (
            <div className="flex flex-col gap-3 p-4">
              <div className="flex items-center gap-2">
                <StatusBadge status={peek.status} />
                <Badge variant="outline">{peek.platform}</Badge>
                {peek.watching ? <Badge>watching</Badge> : null}
              </div>
              <p className="text-sm text-muted-foreground">IP {peek.ip ?? "unknown"}</p>
              <div className="flex flex-wrap gap-1">
                {DEVICE_TAB_GROUPS.map((section) => (
                  <Button
                    key={section.id}
                    size="sm"
                    variant="outline"
                    render={<Link href={`/devices/${peek.id}#${section.id}`} />}
                    nativeButton={false}
                  >
                    {section.label}
                  </Button>
                ))}
              </div>
              <Button render={<Link href={`/devices/${peek.id}`} />} nativeButton={false}>
                Open device
              </Button>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
      <AlertDialog open={confirmRestart} onOpenChange={setConfirmRestart}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restart {selected.length} device(s)?</AlertDialogTitle>
            <AlertDialogDescription>Selected machines will reboot after the agent picks up the command.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmRestart(false)
                bulk.mutate("restart")
              }}
            >
              Restart
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
