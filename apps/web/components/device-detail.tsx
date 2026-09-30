"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useVirtualizer } from "@tanstack/react-virtual"
import { ImageIcon, MoreHorizontalIcon } from "lucide-react"
import { toast } from "sonner"
import {
  DESTRUCTIVE_COMMANDS,
  WS_EVENTS,
  isCommandActive,
  type CommandType,
  type LanPeer,
} from "@workspace/shared"

import { api, formatBytes, formatPct, formatWhen, snippet } from "@/lib/api"
import {
  DEFAULT_DEVICE_TAB,
  DEVICE_ADMIN_TABS,
  DEVICE_HISTORY_TABS,
  DEVICE_TAB_GROUPS,
  deviceHashFor,
  isDeviceAdminId,
  isDeviceHistoryId,
  isDevicePrimaryId,
  parseDeviceHash,
  type DeviceTabState,
} from "@/lib/device-sections"
import { CommandComposer } from "@/components/command-composer"
import { CredentialsManager } from "@/components/credentials-manager"
import { DeviceChat } from "@/components/device-chat"
import { DeviceShell } from "@/components/device-shell"
import { FileExplorer, useDeviceFileProgress, type TransferRow } from "@/components/file-explorer"
import { NetworkManager } from "@/components/network-manager"
import { QueryErrorBanner, QueryErrorState } from "@/components/query-error"
import { RegistryEditor } from "@/components/registry-editor"
import { AssistantPanel } from "@/components/assistant-panel"
import { DeviceHardware, DeviceMetrics, DeviceSoftware, DeviceUsers } from "@/components/device-assets"
import { ServiceManager } from "@/components/service-manager"
import { WindowsTools } from "@/components/windows-tools"
import { useDeviceSubscription, useSocket } from "@/components/providers"
import { StatusBadge } from "@/components/status-badge"
import { WebrtcDesktop } from "@/components/webrtc-desktop"
import {
  decryptBytes,
  decodeChunkPlain,
  deriveSessionKey,
  generateOperatorKey,
  type E2ESession,
} from "@/lib/e2e"
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
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@workspace/ui/components/breadcrumb"
import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { Checkbox } from "@workspace/ui/components/checkbox"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { Switch } from "@workspace/ui/components/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@workspace/ui/components/tabs"
import {
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"

type ProcessRow = { pid: number; name: string; cpu?: number; ram?: number }

type Shot = { id: string; createdAt: string; size: number }

type CommandRow = {
  id: string
  type: string
  status: string
  createdAt: string
  payload: Record<string, unknown>
  result: unknown
}

type Detail = {
  device: {
    id: string
    hostname: string
    platform: string
    status: string
    lastSeen: string
    agentVersion: string
    ip: string | null
    lanAddrs?: string[]
    lanPort?: number | null
    watchUntil: string | null
    watching: boolean
    e2ePub?: string | null
    enrollmentOpen?: boolean
  }
  processes?: ProcessRow[]
  screenshots: Shot[]
  commands: CommandRow[]
  files: TransferRow[]
  lanPeers?: LanPeer[]
  latestSuccessful?: {
    get_services: CommandRow | null
    get_registry: CommandRow | null
    get_adapters: CommandRow | null
    get_ports: CommandRow | null
    get_firewall: CommandRow | null
    get_event_log: CommandRow | null
    get_windows_update: CommandRow | null
    get_admin_center: CommandRow | null
    get_tasks: CommandRow | null
    get_defender: CommandRow | null
    get_bitlocker: CommandRow | null
    get_capabilities: CommandRow | null
    get_smb: CommandRow | null
    get_credentials: CommandRow | null
  }
}

function isProcessRow(value: unknown): value is ProcessRow {
  if (!value || typeof value !== "object") return false
  const rec = value as { pid?: unknown; name?: unknown }
  return typeof rec.pid === "number" && Number.isFinite(rec.pid) && typeof rec.name === "string"
}

function parseProcessRows(result: unknown): ProcessRow[] | null {
  if (Array.isArray(result)) {
    const rows = result.filter(isProcessRow)
    return rows.length ? rows : null
  }
  if (!result || typeof result !== "object") return null
  const rec = result as { processes?: unknown; items?: unknown }
  if (Array.isArray(rec.processes)) {
    const rows = rec.processes.filter(isProcessRow)
    return rows.length ? rows : null
  }
  if (Array.isArray(rec.items)) {
    const rows = rec.items.filter(isProcessRow)
    return rows.length ? rows : null
  }
  return null
}

function latestProcessSnapshot(commands: CommandRow[]): ProcessRow[] | null {
  const hits = commands
    .filter((c) => c.type === "get_processes" && c.status === "success")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  for (const row of hits) {
    const parsed = parseProcessRows(row.result)
    if (parsed) return parsed
  }
  return null
}

export function DeviceDetail({ id }: { id: string }) {
  const router = useRouter()
  const client = useQueryClient()
  const socket = useSocket()
  useDeviceSubscription(id)
  const [lightbox, setLightbox] = React.useState<Shot | null>(null)
  const [extraShots, setExtraShots] = React.useState<Shot[]>([])
  const [nextCursor, setNextCursor] = React.useState<string | null>(null)
  const [watchSrc, setWatchSrc] = React.useState<string | null>(null)
  const cursorDeviceId = React.useRef<string | null>(null)
  const [confirmShotDelete, setConfirmShotDelete] = React.useState(false)
  const [selectedShots, setSelectedShots] = React.useState<Set<string>>(() => new Set())
  const [confirmBulkShot, setConfirmBulkShot] = React.useState(false)
  const [selectedCmds, setSelectedCmds] = React.useState<Set<string>>(() => new Set())
  const [confirmCmdClear, setConfirmCmdClear] = React.useState<"selected" | "all" | null>(null)
  const [retryCmdId, setRetryCmdId] = React.useState<CommandRow | null>(null)
  const [confirmRemove, setConfirmRemove] = React.useState(false)
  const [confirmResetEnrollment, setConfirmResetEnrollment] = React.useState(false)
  const [e2e, setE2e] = React.useState<E2ESession | null>(null)
  const e2eRef = React.useRef<E2ESession | null>(null)
  e2eRef.current = e2e
  const incomingFiles = React.useRef(new Map<string, { name: string; chunks: Array<{ offset: number; data: Uint8Array }>; total: number }>())
  const [procSnapshot, setProcSnapshot] = React.useState<ProcessRow[] | null>(null)
  const [selectedPid, setSelectedPid] = React.useState<number | null>(null)
  const [killTarget, setKillTarget] = React.useState<ProcessRow | null>(null)
  const [chatId, setChatId] = React.useState<string | null>(null)
  const [tab, setTab] = React.useState<DeviceTabState>(DEFAULT_DEVICE_TAB)
  const [desktopAlive, setDesktopAlive] = React.useState(false)
  const [shellAlive, setShellAlive] = React.useState(false)
  const query = useQuery({
    queryKey: ["device", id],
    queryFn: () => api<Detail>(`/api/v1/admin/devices/${id}`),
  })
  useDeviceFileProgress(id)
  const shots = React.useMemo(() => {
    const map = new Map<string, Shot>()
    for (const s of [...(query.data?.screenshots ?? []), ...extraShots]) map.set(s.id, s)
    return [...map.values()].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  }, [query.data?.screenshots, extraShots])

  React.useEffect(() => {
    setExtraShots([])
    setNextCursor(null)
    setWatchSrc((prev) => {
      if (prev?.startsWith("blob:")) URL.revokeObjectURL(prev)
      return null
    })
    setLightbox(null)
    setConfirmShotDelete(false)
    setSelectedShots(new Set())
    setConfirmBulkShot(false)
    setSelectedCmds(new Set())
    setConfirmCmdClear(null)
    setRetryCmdId(null)
    setConfirmRemove(false)
    setConfirmResetEnrollment(false)
    setE2e(null)
    setProcSnapshot(null)
    setSelectedPid(null)
    setKillTarget(null)
    setChatId(null)
    setDesktopAlive(false)
    setShellAlive(false)
    incomingFiles.current.clear()
    cursorDeviceId.current = null
    return () => {
      setWatchSrc((prev) => {
        if (prev?.startsWith("blob:")) URL.revokeObjectURL(prev)
        return null
      })
    }
  }, [id])

  const applyTab = React.useCallback((next: DeviceTabState) => {
    setTab(next)
    if (typeof window === "undefined") return
    const hash = deviceHashFor(next)
    if (window.location.hash.slice(1) === hash) return
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}#${hash}`
    )
  }, [])

  React.useEffect(() => {
    const syncFromHash = () => applyTab(parseDeviceHash(window.location.hash.slice(1)))
    syncFromHash()
    window.addEventListener("hashchange", syncFromHash)
    return () => window.removeEventListener("hashchange", syncFromHash)
  }, [id, applyTab])

  React.useEffect(() => {
    if (!socket) return
    const onReady = (payload: unknown) => {
      if (!payload || typeof payload !== "object") return
      const rec = payload as { id?: unknown; deviceId?: unknown }
      if (rec.deviceId !== id || typeof rec.id !== "string") return
      setWatchSrc(`/api/v1/admin/screenshots/${rec.id}/file`)
    }
    socket.on(WS_EVENTS.SCREENSHOT_READY, onReady)
    const onResult = (payload: unknown) => {
      if (!payload || typeof payload !== "object") return
      const rec = payload as { deviceId?: unknown; type?: unknown; status?: unknown; result?: unknown }
      if (rec.deviceId !== id) return
      if (rec.type === "get_processes" && rec.status === "success") {
        const rows = parseProcessRows(rec.result)
        if (rows) setProcSnapshot(rows)
      }
    }
    socket.on(WS_EVENTS.COMMAND_RESULT, onResult)
    const onEnvelope = (payload: unknown) => {
      const session = e2eRef.current
      if (!session || !payload || typeof payload !== "object") return
      const rec = payload as {
        deviceId?: unknown
        payload?: { action?: string; sessionId?: string; kind?: string; nonce?: string; ciphertext?: string; aad?: string }
      }
      if (rec.deviceId !== id || rec.payload?.action !== "data") return
      if (rec.payload.sessionId !== session.sessionId) return
      if (!rec.payload.nonce || !rec.payload.ciphertext) return
      void decryptBytes(session.key, rec.payload.nonce, rec.payload.ciphertext, rec.payload.aad ?? "")
        .then((plain) => {
          if (rec.payload?.kind === "screenshot") {
            const url = URL.createObjectURL(new Blob([plain.slice().buffer as ArrayBuffer], { type: "image/jpeg" }))
            setWatchSrc((prev) => {
              if (prev?.startsWith("blob:")) URL.revokeObjectURL(prev)
              return url
            })
            return
          }
          if (rec.payload?.kind === "file_chunk") {
            const { header, payload: data } = decodeChunkPlain(plain)
            const transferId = String(header.transferId ?? "file")
            const offset = Number(header.offset ?? 0)
            const total = Number(header.totalSize ?? 0)
            const name = String(header.remotePath ?? transferId)
            const entry = incomingFiles.current.get(transferId) ?? { name, chunks: [], total }
            if (incomingFiles.current.size > 8 && !incomingFiles.current.has(transferId)) {
              const oldest = incomingFiles.current.keys().next().value
              if (oldest) incomingFiles.current.delete(oldest)
            }
            if (entry.chunks.length > 256) {
              incomingFiles.current.delete(transferId)
              return
            }
            entry.chunks.push({ offset, data })
            entry.total = total || entry.total
            incomingFiles.current.set(transferId, entry)
            if (header.final) {
              incomingFiles.current.delete(transferId)
              const ordered = entry.chunks.sort((a, b) => a.offset - b.offset)
              const size = ordered.reduce((n, c) => n + c.data.length, 0)
              const buf = new Uint8Array(size)
              let o = 0
              for (const c of ordered) {
                buf.set(c.data, o)
                o += c.data.length
              }
              const blob = new Blob([buf.slice().buffer as ArrayBuffer])
              const a = document.createElement("a")
              const url = URL.createObjectURL(blob)
              a.href = url
              a.download = name.split(/[/\\]/).pop() || "file"
              a.click()
              URL.revokeObjectURL(url)
              toast.success("Decrypted file download started")
            }
          }
        })
        .catch(() => {
          /* ignore decrypt failures from other sessions */
        })
    }
    socket.on(WS_EVENTS.E2E_ENVELOPE, onEnvelope)
    return () => {
      socket.off(WS_EVENTS.SCREENSHOT_READY, onReady)
      socket.off(WS_EVENTS.COMMAND_RESULT, onResult)
      socket.off(WS_EVENTS.E2E_ENVELOPE, onEnvelope)
    }
  }, [socket, id])

  React.useEffect(() => {
    if (!query.data || cursorDeviceId.current === id) return
    cursorDeviceId.current = id
    const first = query.data.screenshots
    setNextCursor(first.length >= 24 ? (first.at(-1)?.createdAt ?? null) : null)
  }, [id, query.data])

  function queue(type: string, payload: Record<string, unknown> = {}) {
    return api("/api/v1/admin/commands", {
      method: "POST",
      body: JSON.stringify({ deviceIds: [id], type, payload }),
    })
  }

  const shot = useMutation({
    mutationFn: () => queue("capture_screenshot"),
    onSuccess: () => {
      toast.success("Screenshot requested")
      void client.invalidateQueries({ queryKey: ["device", id] })
    },
    onError: (e) => toast.error(e.message),
  })
  const watch = useMutation({
    mutationFn: (on: boolean) => queue(on ? "start_watch" : "stop_watch", on ? { durationMin: 60 } : {}),
    onSuccess: (_, on) => {
      toast.success(on ? "Watch started (~1 FPS stills)" : "Watch stopped")
      void client.invalidateQueries({ queryKey: ["device", id] })
    },
    onError: (e) => toast.error(e.message),
  })
  const refreshProcs = useMutation({
    mutationFn: () => queue("get_processes"),
    onSuccess: () => {
      toast.success("Process snapshot requested")
      void client.invalidateQueries({ queryKey: ["device", id] })
    },
    onError: (e) => toast.error(e.message),
  })
  const killProc = useMutation({
    mutationFn: (row: ProcessRow) => queue("kill_process", { pid: row.pid, name: row.name }),
    onSuccess: () => {
      toast.success("Kill queued")
      setKillTarget(null)
      setSelectedPid(null)
      void client.invalidateQueries({ queryKey: ["device", id] })
      void queue("get_processes")
    },
    onError: (e) => toast.error(e.message),
  })
  const removeDevice = useMutation({
    mutationFn: () => api(`/api/v1/admin/devices/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Device removed")
      void client.invalidateQueries({ queryKey: ["devices"] })
      void client.invalidateQueries({ queryKey: ["overview"] })
      router.push("/devices")
    },
    onError: (e) => toast.error(e.message),
  })
  const resetEnrollment = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; hostname: string }>(`/api/v1/admin/devices/${id}/reset-enrollment`, { method: "POST" }),
    onSuccess: (res) => {
      toast.success(
        `Enrollment reset for ${res.hostname}. Clear device_id and device_key on the agent, then enroll again to reclaim this row.`
      )
      setConfirmResetEnrollment(false)
      void client.invalidateQueries({ queryKey: ["device", id] })
      void client.invalidateQueries({ queryKey: ["devices"] })
    },
    onError: (e) => toast.error(e.message),
  })
  const newChat = useMutation({
    mutationFn: () =>
      api<{ thread: { id: string } }>(`/api/v1/admin/devices/${id}/chats`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    onSuccess: (data) => {
      setChatId(data.thread.id)
      void client.invalidateQueries({ queryKey: ["device-chats", id] })
    },
    onError: (e) => toast.error(e.message),
  })
  const deleteShot = useMutation({
    mutationFn: (shotId: string) => api(`/api/v1/admin/screenshots/${shotId}`, { method: "DELETE" }),
    onSuccess: (_, shotId) => {
      toast.success("Screenshot deleted")
      setExtraShots((cur) => cur.filter((s) => s.id !== shotId))
      setSelectedShots((cur) => {
        if (!cur.has(shotId)) return cur
        const next = new Set(cur)
        next.delete(shotId)
        return next
      })
      setLightbox(null)
      void client.invalidateQueries({ queryKey: ["device", id] })
    },
    onError: (e) => toast.error(e.message),
  })
  const deleteShots = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(
        ids.map((shotId) => api(`/api/v1/admin/screenshots/${shotId}`, { method: "DELETE" }))
      )
      return {
        ok: results.filter((row) => row.status === "fulfilled").length,
        failed: results.filter((row) => row.status === "rejected").length,
      }
    },
    onSuccess: ({ ok, failed }, ids) => {
      if (ok) toast.success(ok === 1 ? "Screenshot deleted" : `${ok} screenshots deleted`)
      if (failed) toast.error(`${failed} screenshot${failed === 1 ? "" : "s"} failed to delete`)
      const gone = new Set(ids)
      setExtraShots((cur) => cur.filter((s) => !gone.has(s.id)))
      setSelectedShots(new Set())
      setLightbox((cur) => (cur && gone.has(cur.id) ? null : cur))
      setConfirmBulkShot(false)
      void client.invalidateQueries({ queryKey: ["device", id] })
    },
    onError: (e) => toast.error(e.message),
  })
  const clearCommands = useMutation({
    mutationFn: (body: { ids?: string[]; all?: boolean; includeActive?: boolean }) =>
      api<{ deleted: number; skipped: Array<{ id: string; reason: string }> }>(
        `/api/v1/admin/devices/${id}/commands`,
        { method: "DELETE", body: JSON.stringify(body) }
      ),
    onSuccess: (res) => {
      if (res.deleted === 0) toast.message("No completed commands to clear")
      else toast.success(res.deleted === 1 ? "Command removed" : `${res.deleted} commands cleared`)
      if (res.skipped.some((row) => row.reason === "not_terminal")) {
        toast.message("Pending or running commands were kept")
      }
      setSelectedCmds(new Set())
      setConfirmCmdClear(null)
      void client.invalidateQueries({ queryKey: ["device", id] })
    },
    onError: (e) => toast.error(e.message),
  })
  const cancelCmd = useMutation({
    mutationFn: (commandId: string) => api(`/api/v1/admin/commands/${commandId}/cancel`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Cancelled")
      void client.invalidateQueries({ queryKey: ["device", id] })
    },
    onError: (e) => toast.error(e.message),
  })
  const retryCmd = useMutation({
    mutationFn: (commandId: string) => api(`/api/v1/admin/commands/${commandId}/retry`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Queued retry")
      setRetryCmdId(null)
      void client.invalidateQueries({ queryKey: ["device", id] })
    },
    onError: (e) => toast.error(e.message),
  })
  const startE2e = useMutation({
    mutationFn: async () => {
      const op = await generateOperatorKey()
      const res = await api<{ sessionId: string; agentPub: string }>(`/api/v1/admin/devices/${id}/e2e/session`, {
        method: "POST",
        body: JSON.stringify({ operatorPub: op.publicHex }),
      })
      const key = await deriveSessionKey(op.privateKey, res.agentPub)
      return { sessionId: res.sessionId, key }
    },
    onSuccess: (session) => {
      setE2e(session)
      toast.success("E2E session active — API relays ciphertext only")
    },
    onError: (e) => toast.error(e.message),
  })
  const stopE2e = useMutation({
    mutationFn: () => api(`/api/v1/admin/devices/${id}/e2e/session`, { method: "DELETE" }),
    onSuccess: () => {
      setE2e(null)
      toast.success("E2E session closed")
    },
    onError: (e) => toast.error(e.message),
  })

  async function loadMoreShots() {
    if (!nextCursor) return
    const page = await api<{ screenshots: Shot[]; nextCursor: string | null }>(
      `/api/v1/admin/devices/${id}/screenshots?cursor=${encodeURIComponent(nextCursor)}&limit=24`
    )
    setExtraShots((cur) => [...cur, ...page.screenshots])
    setNextCursor(page.nextCursor)
  }

  if (query.isError && !query.data) {
    return <QueryErrorState title="Device unavailable" error={query.error} onRetry={() => void query.refetch()} />
  }
  if (query.isLoading || !query.data) {
    return <Skeleton className="h-96" />
  }
  const { device, commands, files } = query.data
  const darwinShot = device.platform === "darwin"
  const processes = procSnapshot ?? latestProcessSnapshot(commands) ?? query.data.processes ?? []
  const selectedProc = processes.find((p) => p.pid === selectedPid) ?? null
  const latestShot = shots[0]
  const allShotsSelected = shots.length > 0 && shots.every((s) => selectedShots.has(s.id))
  const selectedCmdRows = commands.filter((c) => selectedCmds.has(c.id))
  const selectedHasActive = selectedCmdRows.some((c) => isCommandActive(c.status))
  const allCmdsSelected = commands.length > 0 && commands.every((c) => selectedCmds.has(c.id))
  const liveSrc = device.watching
    ? (watchSrc ?? (latestShot ? `/api/v1/admin/screenshots/${latestShot.id}/file` : null))
    : null

  return (
    <div className="flex flex-col gap-6">
      {query.isError ? <QueryErrorBanner cached error={query.error} onRetry={() => void query.refetch()} /> : null}
      {device.enrollmentOpen ? (
        <p className="rounded-lg border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          Enrollment key cleared. The next agent enroll for <span className="font-medium text-foreground">{device.hostname}</span>{" "}
          ({device.platform}) without a stored device key will reclaim this device instead of creating a duplicate.
        </p>
      ) : null}
      <div className="flex flex-col gap-3">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink render={<Link href="/devices" />}>Devices</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage className="truncate" title={device.hostname}>
                {device.hostname}
              </BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <p className="min-w-0 text-sm text-muted-foreground">
            {device.platform} · {device.agentVersion} · {device.ip ?? "no ip"} · last seen {formatWhen(device.lastSeen)}
          </p>
          <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
            <StatusBadge status={device.status} />
            {device.enrollmentOpen ? <StatusBadge status="awaiting reclaim" /> : null}
            {e2e ? <StatusBadge status="e2e" /> : null}
            <Button variant="outline" onClick={() => applyTab({ ...tab, primary: "shell" })}>
              Shell
            </Button>
            <CommandComposer deviceIds={[id]} triggerLabel="Command" peers={query.data.lanPeers} />
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" size="icon" />} aria-label="More actions">
                <MoreHorizontalIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  {device.e2ePub ? (
                    e2e ? (
                      <DropdownMenuItem onClick={() => stopE2e.mutate()} disabled={stopE2e.isPending}>
                        End E2E
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem onClick={() => startE2e.mutate()} disabled={startE2e.isPending}>
                        Start E2E
                      </DropdownMenuItem>
                    )
                  ) : (
                    <DropdownMenuItem disabled>Start E2E</DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    onClick={() => setConfirmResetEnrollment(true)}
                    disabled={resetEnrollment.isPending || device.enrollmentOpen}
                  >
                    Reset enrollment
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem variant="destructive" onClick={() => setConfirmRemove(true)}>
                    Remove
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
      <AssistantPanel deviceId={id} />
      <Tabs
        value={tab.primary}
        onValueChange={(value) => {
          if (typeof value !== "string" || !isDevicePrimaryId(value)) return
          applyTab({ ...tab, primary: value })
        }}
      >
        <TabsList variant="line">
          {DEVICE_TAB_GROUPS.map((group) => (
            <TabsTrigger key={group.id} value={group.id}>
              {group.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="desktop" keepMounted={desktopAlive}>
          {darwinShot ? (
            <p className="mb-4 text-sm text-muted-foreground">
              macOS agent builds do not capture the screen. WebRTC may still fail to start.
            </p>
          ) : null}
          <WebrtcDesktop
            key={id}
            deviceId={id}
            e2e={e2e}
            platform={device.platform}
            onSessionActive={setDesktopAlive}
          />
        </TabsContent>
        <TabsContent value="files">
          <FileExplorer deviceId={id} e2e={e2e} transfers={files} commands={commands} lanPeers={query.data.lanPeers} />
        </TabsContent>
        <TabsContent value="admin">
          <Tabs
            value={tab.admin}
            onValueChange={(value) => {
              if (typeof value !== "string" || !isDeviceAdminId(value)) return
              applyTab({ ...tab, primary: "admin", admin: value })
            }}
          >
            <TabsList variant="line">
              {DEVICE_ADMIN_TABS.map((item) => (
                <TabsTrigger key={item.id} value={item.id}>
                  {item.label}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="metrics">
              <DeviceMetrics deviceId={id} />
            </TabsContent>
            <TabsContent value="hardware">
              <DeviceHardware deviceId={id} />
            </TabsContent>
            <TabsContent value="software">
              <DeviceSoftware deviceId={id} />
            </TabsContent>
            <TabsContent value="users">
              <DeviceUsers deviceId={id} />
            </TabsContent>
            <TabsContent value="services">
              <ServiceManager
                deviceId={id}
                platform={device.platform}
                commands={commands}
                online={device.status === "online"}
                latestSuccessful={query.data.latestSuccessful?.get_services ?? null}
              />
            </TabsContent>
            <TabsContent value="registry">
              <RegistryEditor
                deviceId={id}
                platform={device.platform}
                commands={commands}
                online={device.status === "online"}
                latestSuccessful={query.data.latestSuccessful?.get_registry ?? null}
              />
            </TabsContent>
            <TabsContent value="credentials">
              <CredentialsManager
                deviceId={id}
                platform={device.platform}
                commands={commands}
                online={device.status === "online"}
                latestSuccessful={query.data.latestSuccessful?.get_credentials ?? null}
              />
            </TabsContent>
            <TabsContent value="network">
              <div className="flex flex-col gap-6">
                <NetworkManager
                  deviceId={id}
                  platform={device.platform}
                  commands={commands}
                  online={device.status === "online"}
                  latestSuccessful={{
                    get_adapters: query.data.latestSuccessful?.get_adapters ?? null,
                    get_ports: query.data.latestSuccessful?.get_ports ?? null,
                    get_firewall: query.data.latestSuccessful?.get_firewall ?? null,
                  }}
                />
                {query.data.lanPeers?.length ? (
                  <div className="flex flex-col gap-3">
                    <h3 className="text-sm font-medium">Mesh peers</h3>
                    <p className="text-sm text-muted-foreground">
                      Last-seen LAN addresses from hello. Online here is API presence; mesh discovery is separate on
                      17891.
                    </p>
                    <div className="overflow-auto rounded-lg border">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b text-left text-muted-foreground">
                            <th className="px-3 py-2 font-medium">Host</th>
                            <th className="px-3 py-2 font-medium">Status</th>
                            <th className="px-3 py-2 font-medium">Addrs</th>
                          </tr>
                        </thead>
                        <tbody>
                          {query.data.lanPeers.map((peer) => (
                            <tr key={peer.id} className="border-b last:border-0">
                              <td className="max-w-[10rem] truncate px-3 py-2" title={peer.hostname}>
                                {peer.hostname}
                                {peer.likely ? (
                                  <span className="ml-2 text-xs text-muted-foreground">likely LAN</span>
                                ) : null}
                              </td>
                              <td className="px-3 py-2">{peer.status}</td>
                              <td className="max-w-[16rem] truncate px-3 py-2 font-mono text-xs" title={[peer.lanAddrs.join(", "), peer.ip].filter(Boolean).join(" · ")}>
                                {peer.lanAddrs.join(", ") || "—"}
                                {peer.ip ? ` · ${peer.ip}` : ""}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : null}
              </div>
            </TabsContent>
            <TabsContent value="windows">
              <WindowsTools
                deviceId={id}
                platform={device.platform}
                commands={commands}
                online={device.status === "online"}
                transfers={files}
                e2e={e2e}
                latestSuccessful={{
                  get_event_log: query.data.latestSuccessful?.get_event_log ?? null,
                  get_windows_update: query.data.latestSuccessful?.get_windows_update ?? null,
                  get_admin_center: query.data.latestSuccessful?.get_admin_center ?? null,
                  get_tasks: query.data.latestSuccessful?.get_tasks ?? null,
                  get_defender: query.data.latestSuccessful?.get_defender ?? null,
                  get_bitlocker: query.data.latestSuccessful?.get_bitlocker ?? null,
                  get_capabilities: query.data.latestSuccessful?.get_capabilities ?? null,
                  get_smb: query.data.latestSuccessful?.get_smb ?? null,
                }}
              />
            </TabsContent>
          </Tabs>
        </TabsContent>
        <TabsContent value="processes">
          <PanelToolbar description="On-demand snapshot from get_processes.">
            <Button size="sm" variant="outline" onClick={() => refreshProcs.mutate()} disabled={refreshProcs.isPending}>
              Refresh
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => selectedProc && setKillTarget(selectedProc)}
              disabled={!selectedProc || killProc.isPending}
            >
              Kill
            </Button>
          </PanelToolbar>
          <ProcessTable
            rows={processes}
            empty="No process snapshot yet. Refresh to queue get_processes."
            selectedPid={selectedPid}
            onSelect={(row) => setSelectedPid(row.pid)}
          />
        </TabsContent>
        <TabsContent value="shell" keepMounted={shellAlive}>
          <DeviceShell deviceId={id} platform={device.platform} onSessionActive={setShellAlive} />
        </TabsContent>
        <TabsContent value="history">
          <Tabs
            value={tab.history}
            onValueChange={(value) => {
              if (typeof value !== "string" || !isDeviceHistoryId(value)) return
              applyTab({ ...tab, primary: "history", history: value })
            }}
          >
            <TabsList variant="line">
              {DEVICE_HISTORY_TABS.map((item) => (
                <TabsTrigger key={item.id} value={item.id}>
                  {item.label}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="commands">
              <PanelToolbar>
                {commands.length ? (
                  <>
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={allCmdsSelected}
                        onCheckedChange={(checked) =>
                          setSelectedCmds(checked ? new Set(commands.map((c) => c.id)) : new Set())
                        }
                      />
                      Select all
                    </label>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={!selectedCmds.size || clearCommands.isPending}
                      onClick={() => setConfirmCmdClear("selected")}
                    >
                      Delete selected{selectedCmds.size ? ` (${selectedCmds.size})` : ""}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={clearCommands.isPending}
                      onClick={() => setConfirmCmdClear("all")}
                    >
                      Clear history
                    </Button>
                  </>
                ) : null}
              </PanelToolbar>
              <CommandHistoryTable
                commands={commands}
                selectedCmds={selectedCmds}
                setSelectedCmds={setSelectedCmds}
                onCancel={(commandId) => cancelCmd.mutate(commandId)}
                onRetry={(c) =>
                  DESTRUCTIVE_COMMANDS.has(c.type as CommandType) ? setRetryCmdId(c) : retryCmd.mutate(c.id)
                }
              />
            </TabsContent>
            <TabsContent value="screenshots">
              <PanelToolbar description="Stills, watch, lightbox, and delete.">
                {!darwinShot ? (
                  <>
                    <Button size="sm" variant="outline" onClick={() => shot.mutate()} disabled={shot.isPending}>
                      Capture
                    </Button>
                    <div className="flex items-center gap-2">
                      <Switch checked={device.watching} onCheckedChange={(on) => watch.mutate(on)} />
                      <span className="text-sm">Watch screen</span>
                    </div>
                    {device.watchUntil ? (
                      <span className="text-xs text-muted-foreground">until {formatWhen(device.watchUntil)}</span>
                    ) : null}
                  </>
                ) : null}
                {shots.length ? (
                  <>
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={allShotsSelected}
                        onCheckedChange={(checked) =>
                          setSelectedShots(checked ? new Set(shots.map((s) => s.id)) : new Set())
                        }
                      />
                      Select all
                    </label>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={!selectedShots.size || deleteShots.isPending}
                      onClick={() => setConfirmBulkShot(true)}
                    >
                      Delete selected{selectedShots.size ? ` (${selectedShots.size})` : ""}
                    </Button>
                  </>
                ) : null}
              </PanelToolbar>
              {darwinShot ? (
                <p className="mb-4 text-sm text-muted-foreground">
                  Screenshots and live stills are not supported on this macOS agent build.
                </p>
              ) : null}
              {device.watching && liveSrc ? (
                <Card className="mb-4">
                  <CardHeader>
                    <CardTitle className="text-sm">Live still</CardTitle>
                    <CardDescription>{latestShot ? formatWhen(latestShot.createdAt) : "Waiting for frame"}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      key={liveSrc}
                      src={liveSrc}
                      alt="Watch still"
                      className="max-h-[480px] w-full cursor-pointer rounded-lg object-contain"
                      onClick={() => latestShot && setLightbox(latestShot)}
                    />
                  </CardContent>
                </Card>
              ) : null}
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {!shots.length ? (
                  <Empty className="col-span-full border">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <ImageIcon />
                      </EmptyMedia>
                      <EmptyTitle>No screenshots</EmptyTitle>
                      <EmptyDescription>Capture one from the action bar or enable Watch screen.</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  shots.map((s) => (
                    <Card key={s.id} className="relative">
                      <div
                        className="absolute left-3 top-3 z-10"
                        onClick={(event) => event.stopPropagation()}
                        onPointerDown={(event) => event.stopPropagation()}
                      >
                        <Checkbox
                          checked={selectedShots.has(s.id)}
                          onCheckedChange={(checked) => {
                            setSelectedShots((cur) => {
                              const next = new Set(cur)
                              if (checked) next.add(s.id)
                              else next.delete(s.id)
                              return next
                            })
                          }}
                        />
                      </div>
                      <div className="cursor-pointer" onClick={() => setLightbox(s)}>
                        <CardHeader className="pl-10">
                          <CardTitle className="text-sm">{formatWhen(s.createdAt)}</CardTitle>
                          <CardDescription>{formatBytes(s.size)}</CardDescription>
                        </CardHeader>
                        <CardContent>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={`/api/v1/admin/screenshots/${s.id}/file`}
                            alt="Screenshot"
                            loading="lazy"
                            decoding="async"
                            className="h-32 w-full rounded-lg object-cover"
                          />
                        </CardContent>
                      </div>
                    </Card>
                  ))
                )}
              </div>
              {nextCursor ? (
                <Button className="mt-4" variant="outline" onClick={() => void loadMoreShots()}>
                  Load more
                </Button>
              ) : null}
            </TabsContent>
            <TabsContent value="chat">
              <PanelToolbar description="LLM copilot that queues existing commands for this device. Destructive tools confirm first.">
                <Button size="sm" variant="outline" onClick={() => newChat.mutate()} disabled={newChat.isPending}>
                  New chat
                </Button>
              </PanelToolbar>
              <DeviceChat
                deviceId={id}
                hostname={device.hostname}
                platform={device.platform}
                status={device.status}
                activeThreadId={chatId}
                onActiveThreadIdChange={setChatId}
              />
            </TabsContent>
          </Tabs>
        </TabsContent>
      </Tabs>
      <Dialog open={!!lightbox} onOpenChange={(open) => !open && setLightbox(null)}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Screenshot</DialogTitle>
            <DialogDescription>{lightbox ? formatWhen(lightbox.createdAt) : ""}</DialogDescription>
          </DialogHeader>
          {lightbox ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/v1/admin/screenshots/${lightbox.id}/file`}
              alt="Screenshot"
              className="max-h-[70vh] w-full object-contain"
            />
          ) : null}
          <DialogFooter>
            <Button variant="destructive" onClick={() => setConfirmShotDelete(true)}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={confirmBulkShot} onOpenChange={setConfirmBulkShot}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {selectedShots.size} screenshot{selectedShots.size === 1 ? "" : "s"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Removes the selected captures from the server. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => deleteShots.mutate([...selectedShots])}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={confirmCmdClear !== null} onOpenChange={(open) => !open && setConfirmCmdClear(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmCmdClear === "all"
                ? "Clear command history?"
                : `Delete ${selectedCmds.size} command${selectedCmds.size === 1 ? "" : "s"}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmCmdClear === "all"
                ? "Removes completed commands (success, failed, cancelled) for this device. Pending and running commands are kept."
                : selectedHasActive
                  ? "Some selected rows are still pending or running. Confirm to delete those as well as completed history."
                  : "Removes the selected completed commands from history."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (confirmCmdClear === "all") {
                  clearCommands.mutate({ all: true })
                  return
                }
                clearCommands.mutate({
                  ids: [...selectedCmds],
                  includeActive: selectedHasActive,
                })
              }}
            >
              {confirmCmdClear === "all" ? "Clear history" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={confirmShotDelete} onOpenChange={setConfirmShotDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this screenshot?</AlertDialogTitle>
            <AlertDialogDescription>Removes the stored capture from the server.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (lightbox) deleteShot.mutate(lightbox.id)
                setConfirmShotDelete(false)
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={!!retryCmdId} onOpenChange={(open) => !open && setRetryCmdId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Retry {retryCmdId?.type}?</AlertDialogTitle>
            <AlertDialogDescription>This queues the same destructive command on this device again.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => retryCmdId && retryCmd.mutate(retryCmdId.id)}
            >
              Retry
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={!!killTarget} onOpenChange={(open) => !open && setKillTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Kill {killTarget?.name} (PID {killTarget?.pid})?
            </AlertDialogTitle>
            <AlertDialogDescription>Queues kill_process on this device. The process may not exit if it is protected.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => killTarget && killProc.mutate(killTarget)}
            >
              Kill
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={confirmResetEnrollment} onOpenChange={setConfirmResetEnrollment}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset enrollment for {device.hostname}?</AlertDialogTitle>
            <AlertDialogDescription>
              Disconnects the agent and clears its enrollment key. This device row stays. On the PC, remove{" "}
              <code>device_id</code> and <code>device_key</code> from the agent config (or use a fresh stamp), then enroll
              with the same hostname and platform to reclaim this device. A second enroll without a reset would be rejected
              as already enrolled.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={resetEnrollment.isPending}
              onClick={() => resetEnrollment.mutate()}
            >
              Reset enrollment
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {device.hostname}?</AlertDialogTitle>
            <AlertDialogDescription>
              Deletes this device and its stats, logs, commands, screenshots, and plugin grants. The agent will need
              to enroll again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => removeDevice.mutate()}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function PanelToolbar({
  description,
  children,
}: {
  description?: string
  children?: React.ReactNode
}) {
  if (!description && !children) return null
  return (
    <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
      {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      {children ? <div className="flex flex-wrap items-center gap-2 sm:ml-auto">{children}</div> : null}
    </div>
  )
}

function ProcessTable({
  rows,
  empty,
  selectedPid,
  onSelect,
}: {
  rows: ProcessRow[]
  empty: string
  selectedPid: number | null
  onSelect: (row: ProcessRow) => void
}) {
  const [scrollEl, setScrollEl] = React.useState<HTMLDivElement | null>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => 44,
    overscan: 12,
  })
  if (!rows.length) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{empty}</EmptyTitle>
        </EmptyHeader>
      </Empty>
    )
  }
  const virtualItems = virtualizer.getVirtualItems()
  const renderedItems = virtualItems.length > 0 ? virtualItems : rows.map((_, index) => ({ index }))
  const paddingTop = virtualItems.length > 0 ? virtualItems[0]!.start : 0
  const paddingBottom =
    virtualItems.length > 0 ? virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1]!.end : 0
  return (
    <Card>
      <CardContent className="pt-6">
        <div ref={setScrollEl} className="relative max-h-[min(70vh,32rem)] overflow-auto">
          <table className="w-full caption-bottom text-sm">
            <TableHeader>
              <TableRow>
                <TableHead className="sticky top-0 z-10 bg-background">PID</TableHead>
                <TableHead className="sticky top-0 z-10 bg-background">Name</TableHead>
                <TableHead className="sticky top-0 z-10 bg-background">CPU</TableHead>
                <TableHead className="sticky top-0 z-10 bg-background">RAM</TableHead>
              </TableRow>
            </TableHeader>
            <tbody>
              {paddingTop > 0 ? (
                <tr>
                  <td colSpan={4} style={{ height: paddingTop }} />
                </tr>
              ) : null}
              {renderedItems.map((virtualRow) => {
                const p = rows[virtualRow.index]
                if (!p) return null
                return (
                  <TableRow
                    key={`${p.pid}-${p.name}`}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    data-state={selectedPid === p.pid ? "selected" : undefined}
                    className="cursor-pointer"
                    onClick={() => onSelect(p)}
                  >
                    <TableCell>{p.pid}</TableCell>
                    <TableCell className="max-w-[14rem] truncate" title={p.name}>
                      {p.name}
                    </TableCell>
                    <TableCell>{p.cpu !== undefined ? formatPct(p.cpu) : "—"}</TableCell>
                    <TableCell>{p.ram !== undefined ? formatPct(p.ram) : "—"}</TableCell>
                  </TableRow>
                )
              })}
              {paddingBottom > 0 ? (
                <tr>
                  <td colSpan={4} style={{ height: paddingBottom }} />
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  )
}

function CommandHistoryTable({
  commands,
  selectedCmds,
  setSelectedCmds,
  onCancel,
  onRetry,
}: {
  commands: CommandRow[]
  selectedCmds: Set<string>
  setSelectedCmds: React.Dispatch<React.SetStateAction<Set<string>>>
  onCancel: (id: string) => void
  onRetry: (row: CommandRow) => void
}) {
  const [scrollEl, setScrollEl] = React.useState<HTMLDivElement | null>(null)
  const virtualizer = useVirtualizer({
    count: commands.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => 48,
    overscan: 12,
  })
  const virtualItems = virtualizer.getVirtualItems()
  const renderedItems = virtualItems.length > 0 ? virtualItems : commands.map((_, index) => ({ index }))
  const paddingTop = virtualItems.length > 0 ? virtualItems[0]!.start : 0
  const paddingBottom =
    virtualItems.length > 0 ? virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1]!.end : 0
  return (
    <div ref={setScrollEl} className="relative max-h-[min(70vh,32rem)] overflow-auto rounded-lg border">
      <table className="w-full caption-bottom text-sm">
        <TableHeader>
          <TableRow>
            <TableHead className="sticky top-0 z-10 w-10 bg-background" />
            <TableHead className="sticky top-0 z-10 bg-background">Type</TableHead>
            <TableHead className="sticky top-0 z-10 bg-background">Status</TableHead>
            <TableHead className="sticky top-0 z-10 bg-background">Result</TableHead>
            <TableHead className="sticky top-0 z-10 bg-background">When</TableHead>
            <TableHead className="sticky top-0 z-10 bg-background" />
          </TableRow>
        </TableHeader>
        <tbody>
          {paddingTop > 0 ? (
            <tr>
              <td colSpan={6} style={{ height: paddingTop }} />
            </tr>
          ) : null}
          {renderedItems.map((virtualRow) => {
            const c = commands[virtualRow.index]
            if (!c) return null
            return (
              <TableRow key={c.id} data-index={virtualRow.index} ref={virtualizer.measureElement}>
                <TableCell>
                  <Checkbox
                    checked={selectedCmds.has(c.id)}
                    onCheckedChange={(checked) => {
                      setSelectedCmds((cur) => {
                        const next = new Set(cur)
                        if (checked) next.add(c.id)
                        else next.delete(c.id)
                        return next
                      })
                    }}
                  />
                </TableCell>
                <TableCell className="max-w-[10rem] truncate font-mono text-xs" title={c.type}>
                  {c.type}
                </TableCell>
                <TableCell>
                  <StatusBadge status={c.status} />
                </TableCell>
                <TableCell className="max-w-xs truncate text-xs text-muted-foreground" title={c.result != null ? snippet(c.result) : undefined}>
                  {c.result != null ? snippet(c.result) : "—"}
                </TableCell>
                <TableCell className="whitespace-nowrap">{formatWhen(c.createdAt)}</TableCell>
                <TableCell className="w-[1%] whitespace-nowrap">
                  {c.status === "pending" ? (
                    <Button size="sm" variant="outline" onClick={() => onCancel(c.id)}>
                      Cancel
                    </Button>
                  ) : null}
                  {c.status === "failed" || c.status === "cancelled" ? (
                    <Button size="sm" variant="outline" onClick={() => onRetry(c)}>
                      Retry
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            )
          })}
          {paddingBottom > 0 ? (
            <tr>
              <td colSpan={6} style={{ height: paddingBottom }} />
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  )
}
