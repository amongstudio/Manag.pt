"use client"

import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  WINDOWS_AGENT_SERVICE,
  WINDOWS_HELPER_SERVICE,
  WS_EVENTS,
  isOfficialService,
  latestSuccessfulServiceList,
  parseServiceList,
  queuedCommandId,
  resultErrorMessage,
  serviceControlConfirm,
  serviceStartTypeLabel,
  serviceStatusLabel,
  type ServiceControlAction,
  type ServiceInfo,
} from "@workspace/shared"

import { api } from "@/lib/api"
import { pollAdminCommand } from "@/lib/command-poll"
import { useSocket } from "@/components/providers"
import { QueryErrorBanner, QueryErrorState } from "@/components/query-error"
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
import { Card, CardContent } from "@workspace/ui/components/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@workspace/ui/components/empty"
import { Input } from "@workspace/ui/components/input"
import { Spinner } from "@workspace/ui/components/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"

type CommandSeed = { id: string; type: string; status: string; result?: unknown }

export function ServiceManager({
  deviceId,
  platform,
  commands,
  online = false,
  latestSuccessful,
}: {
  deviceId: string
  platform: string
  commands?: CommandSeed[]
  online?: boolean
  latestSuccessful?: CommandSeed | null
}) {
  const client = useQueryClient()
  const socket = useSocket()
  const windows = platform.toLowerCase() === "windows"
  const [services, setServices] = React.useState<ServiceInfo[]>([])
  const [truncated, setTruncated] = React.useState(false)
  const [listed, setListed] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [filter, setFilter] = React.useState("")
  const [selected, setSelected] = React.useState<string | null>(null)
  const [confirm, setConfirm] = React.useState<{ action: ServiceControlAction; name: string } | null>(null)
  const pendingId = React.useRef<string | null>(null)
  const pollAbort = React.useRef<AbortController | null>(null)
  const seeded = React.useRef<string | null>(null)
  const autoQueued = React.useRef(false)
  const onlineRef = React.useRef(online)
  const requestListRef = React.useRef<() => Promise<void>>(async () => {})
  onlineRef.current = online

  const stopWatch = React.useCallback(() => {
    pollAbort.current?.abort()
    pendingId.current = null
    setPending(false)
  }, [])

  React.useEffect(() => {
    setServices([])
    setTruncated(false)
    setListed(false)
    setPending(false)
    setError(null)
    setFilter("")
    setSelected(null)
    setConfirm(null)
    seeded.current = null
    autoQueued.current = false
    stopWatch()
  }, [deviceId, stopWatch])

  function applyList(result: unknown) {
    const parsed = parseServiceList(result)
    setServices(parsed.services)
    setTruncated(parsed.truncated)
    setListed(true)
    setError(null)
  }

  const startWatch = React.useCallback((commandId: string) => {
    pollAbort.current?.abort()
    pendingId.current = commandId
    setError(null)
    setPending(true)
    const ac = new AbortController()
    pollAbort.current = ac
    void (async () => {
      const outcome = await pollAdminCommand(commandId, { signal: ac.signal, timeoutMs: 90_000 })
      if (ac.signal.aborted || pendingId.current !== commandId) return
      if (outcome.kind === "timeout") {
        setError(onlineRef.current ? "timeout" : "agent_offline")
        pendingId.current = null
        setPending(false)
        return
      }
      if (outcome.kind === "error") {
        if (outcome.message === "aborted") return
        setError(outcome.message)
        pendingId.current = null
        setPending(false)
        return
      }
      const cmd = outcome.command
      if (cmd.status === "success") {
        applyList(cmd.result)
        pendingId.current = null
        setPending(false)
        return
      }
      setError(resultErrorMessage(cmd.result, cmd.status, "Service list failed"))
      pendingId.current = null
      setPending(false)
    })()
  }, [])

  async function queue(type: string, payload: Record<string, unknown> = {}) {
    const data = await api<{ commands: { id: string }[] }>("/api/v1/admin/commands", {
      method: "POST",
      body: JSON.stringify({ deviceIds: [deviceId], type, payload }),
    })
    const id = queuedCommandId(data)
    if (!id) throw new Error("command not queued")
    return id
  }

  async function requestList() {
    const id = await queue("get_services")
    startWatch(id)
  }
  requestListRef.current = requestList

  React.useEffect(() => {
    if (!windows) return
    if (seeded.current === deviceId) {
      if (online && !autoQueued.current && !pendingId.current) {
        autoQueued.current = true
        void requestListRef.current().catch((e) => toast.error(e instanceof Error ? e.message : "List refresh failed"))
      }
      return
    }
    seeded.current = deviceId
    autoQueued.current = false
    const success =
      latestSuccessful?.status === "success" ? latestSuccessful : latestSuccessfulServiceList(commands ?? [])
    if (success) applyList(success.result)
    const inflight = commands?.find((c) => c.type === "get_services" && (c.status === "pending" || c.status === "running"))
    if (inflight) {
      startWatch(inflight.id)
      autoQueued.current = true
      return
    }
    if (online) {
      autoQueued.current = true
      void requestListRef.current().catch((e) => toast.error(e instanceof Error ? e.message : "List refresh failed"))
    }
  }, [windows, commands, deviceId, online, latestSuccessful, startWatch])

  React.useEffect(() => {
    if (!socket) return
    const onResult = (payload: unknown) => {
      if (!payload || typeof payload !== "object") return
      const rec = payload as { id?: string; deviceId?: string; type?: string; status?: string; result?: unknown }
      if (rec.deviceId !== deviceId) return
      const type = rec.type ?? ""
      if (type === "get_services") {
        if (rec.status === "success" && (rec.id === pendingId.current || !pendingId.current)) {
          applyList(rec.result)
          stopWatch()
        } else if ((rec.status === "failed" || rec.status === "cancelled") && rec.id === pendingId.current) {
          setError(resultErrorMessage(rec.result, rec.status, "Service list failed"))
          stopWatch()
        }
        return
      }
      if (rec.status === "success" && (type === "start_service" || type === "stop_service" || type === "restart_service")) {
        void requestList().catch((e) => toast.error(e instanceof Error ? e.message : "List refresh failed"))
      } else if ((rec.status === "failed" || rec.status === "cancelled") && (type === "start_service" || type === "stop_service" || type === "restart_service")) {
        toast.error(resultErrorMessage(rec.result, rec.status, `${type.replaceAll("_", " ")} failed`))
      }
    }
    socket.on(WS_EVENTS.COMMAND_RESULT, onResult)
    return () => {
      socket.off(WS_EVENTS.COMMAND_RESULT, onResult)
    }
  }, [socket, deviceId, stopWatch])

  const refresh = useMutation({
    mutationFn: () => requestList(),
    onError: (e) => toast.error(e.message),
  })
  const control = useMutation({
    mutationFn: async (input: { action: ServiceControlAction; name: string }) => {
      const type = input.action === "start" ? "start_service" : input.action === "stop" ? "stop_service" : "restart_service"
      await queue(type, { name: input.name })
      return input
    },
    onSuccess: (input) => {
      toast.success(`${input.action} queued for ${input.name}`)
      setConfirm(null)
      void client.invalidateQueries({ queryKey: ["device", deviceId] })
    },
    onError: (e) => toast.error(e.message),
  })

  if (!windows) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Windows-only</EmptyTitle>
          <EmptyDescription>
            Service Manager talks to the Windows Service Control Manager (OpenSCManager). Linux and macOS agents return
            unsupported.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const q = filter.trim().toLowerCase()
  const rows = services
    .filter((s) => !q || s.name.toLowerCase().includes(q) || (s.displayName ?? "").toLowerCase().includes(q))
    .slice()
    .sort((a, b) => {
      const ao = isOfficialService(a.name) ? 0 : 1
      const bo = isOfficialService(b.name) ? 0 : 1
      if (ao !== bo) return ao - bo
      return a.name.localeCompare(b.name)
    })
  const selectedRow = rows.find((s) => s.name === selected) ?? null

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="max-w-xs"
          placeholder="Filter services"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <Button size="sm" variant="outline" onClick={() => refresh.mutate()} disabled={refresh.isPending || pending}>
          {pending ? <Spinner data-icon="inline-start" /> : null}
          Refresh
        </Button>
        <Button
          size="sm"
          onClick={() => selectedRow && setConfirm({ action: "start", name: selectedRow.name })}
          disabled={!selectedRow || control.isPending}
        >
          Start
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={() => selectedRow && setConfirm({ action: "stop", name: selectedRow.name })}
          disabled={!selectedRow || control.isPending}
        >
          Stop
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => selectedRow && setConfirm({ action: "restart", name: selectedRow.name })}
          disabled={!selectedRow || control.isPending}
        >
          Restart
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Live SCM list (not the <code>builtin:win_services</code> plugin snapshot). Includes {WINDOWS_AGENT_SERVICE} and{" "}
        {WINDOWS_HELPER_SERVICE}. Start, stop, and restart confirm first.
      </p>
      {error && listed ? <QueryErrorBanner cached error={error} onRetry={() => refresh.mutate()} /> : null}
      {truncated ? <p className="text-sm text-muted-foreground">Listing truncated at the agent cap.</p> : null}
      {pending && !listed ? (
        <p className="text-sm text-muted-foreground">Waiting for agent…</p>
      ) : error && !listed ? (
        <QueryErrorState title="Service list failed" error={error} onRetry={() => refresh.mutate()} />
      ) : !listed ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No service list yet</EmptyTitle>
            <EmptyDescription>
              {online ? "Refresh to queue get_services." : "Device is offline. A last successful list will show as a skeleton when available."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Card>
          <CardContent className="overflow-x-auto pt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Display name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Start type</TableHead>
                  <TableHead>PID</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-muted-foreground">
                      No services match the filter.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((s) => (
                    <TableRow
                      key={s.name}
                      data-state={selected === s.name ? "selected" : undefined}
                      className="cursor-pointer"
                      onClick={() => setSelected(s.name)}
                    >
                      <TableCell className="min-w-0 max-w-[14rem]">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-mono text-sm" title={s.name}>
                            {s.name}
                          </span>
                          {isOfficialService(s.name) || s.official ? (
                            <Badge variant="secondary" className="shrink-0">
                              official
                            </Badge>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="max-w-[16rem] truncate" title={s.displayName || undefined}>
                        {s.displayName || "—"}
                      </TableCell>
                      <TableCell>{serviceStatusLabel(s.status)}</TableCell>
                      <TableCell>{serviceStartTypeLabel(s.startType)}</TableCell>
                      <TableCell>{s.pid ? s.pid : "—"}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      <AlertDialog open={!!confirm} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm ? `${confirm.action} ${confirm.name}` : "Confirm"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm ? serviceControlConfirm(confirm.action, confirm.name) : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={confirm?.action === "start" ? "default" : "destructive"}
              onClick={() => confirm && control.mutate(confirm)}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
