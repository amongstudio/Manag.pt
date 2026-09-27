"use client"

import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  REGISTRY_AGENT_KEY_PATH,
  REGISTRY_HIVES,
  REGISTRY_VALUE_TYPES,
  REGISTRY_WELL_KNOWN,
  WS_EVENTS,
  formatRegistryData,
  isDangerousRegistryPath,
  joinRegistryPath,
  latestSuccessfulRegistry,
  normalizeRegistryPath,
  parentRegistryPath,
  parseRegistryKey,
  queuedCommandId,
  registryCrumbs,
  registryDisplayPath,
  resultErrorMessage,
  type RegistryHive,
  type RegistryValue,
  type RegistryValueType,
} from "@workspace/shared"

import { api } from "@/lib/api"
import { pollAdminCommand } from "@/lib/command-poll"
import { useSocket } from "@/components/providers"
import { QueryErrorBanner, QueryErrorState } from "@/components/query-error"
import { NumberInput } from "@/components/number-input"
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
  EmptyTitle,
} from "@workspace/ui/components/empty"
import { Field, FieldGroup, FieldLabel } from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Spinner } from "@workspace/ui/components/spinner"
import { Textarea } from "@workspace/ui/components/textarea"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"

type CommandSeed = { id: string; type: string; status: string; result?: unknown }

const HIVE_ITEMS = REGISTRY_HIVES.map((hive) => ({ value: hive, label: hive }))
const TYPE_ITEMS = REGISTRY_VALUE_TYPES.map((type) => ({ value: type, label: type }))

type EditState = {
  mode: "create-key" | "create-value" | "edit-value"
  name: string
  type: RegistryValueType
  data: string
}

export function RegistryEditor({
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
  const [hive, setHive] = React.useState<RegistryHive>("HKLM")
  const [path, setPath] = React.useState(REGISTRY_AGENT_KEY_PATH)
  const [keys, setKeys] = React.useState<string[]>([])
  const [values, setValues] = React.useState<RegistryValue[]>([])
  const [truncated, setTruncated] = React.useState(false)
  const [listed, setListed] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [selectedValue, setSelectedValue] = React.useState<string | null>(null)
  const [edit, setEdit] = React.useState<EditState | null>(null)
  const [confirm, setConfirm] = React.useState<{ kind: "value" | "key"; name?: string } | null>(null)
  const [writeConfirm, setWriteConfirm] = React.useState(false)
  const pendingId = React.useRef<string | null>(null)
  const hiveRef = React.useRef(hive)
  const pathRef = React.useRef(path)
  const pollAbort = React.useRef<AbortController | null>(null)
  const seeded = React.useRef<string | null>(null)
  const autoQueued = React.useRef(false)
  const emptyFallbackForPending = React.useRef(false)
  const softwareFallback = React.useRef(false)
  const onlineRef = React.useRef(online)
  const requestKeyRef = React.useRef<(nextHive?: RegistryHive, nextPath?: string, opts?: { emptyFallback?: boolean }) => Promise<void>>(
    async () => {}
  )
  onlineRef.current = online
  hiveRef.current = hive
  pathRef.current = path

  const stopWatch = React.useCallback(() => {
    pollAbort.current?.abort()
    pendingId.current = null
    setPending(false)
  }, [])

  React.useEffect(() => {
    setHive("HKLM")
    setPath(REGISTRY_AGENT_KEY_PATH)
    setKeys([])
    setValues([])
    setTruncated(false)
    setListed(false)
    setPending(false)
    setError(null)
    setSelectedValue(null)
    setEdit(null)
    setConfirm(null)
    setWriteConfirm(false)
    seeded.current = null
    autoQueued.current = false
    emptyFallbackForPending.current = false
    softwareFallback.current = false
    stopWatch()
  }, [deviceId, stopWatch])

  function applyKey(result: unknown) {
    const parsed = parseRegistryKey(result)
    if (!parsed) return
    setHive(parsed.hive as RegistryHive)
    setPath(parsed.path)
    setKeys(parsed.keys)
    setValues(parsed.values)
    setTruncated(parsed.truncated)
    setListed(true)
    setError(null)
    setSelectedValue(null)
  }

  function maybeOpenSoftware(result: unknown) {
    if (softwareFallback.current) return
    const parsed = parseRegistryKey(result)
    if (!parsed) return
    if (parsed.hive !== "HKLM") return
    if (normalizeRegistryPath(parsed.path) !== REGISTRY_AGENT_KEY_PATH) return
    if (parsed.keys.length > 0 || parsed.values.length > 0) return
    softwareFallback.current = true
    void requestKeyRef.current("HKLM", "SOFTWARE").catch((e) => toast.error(e instanceof Error ? e.message : "Refresh failed"))
  }

  const startWatch = React.useCallback((commandId: string, opts?: { emptyFallback?: boolean }) => {
    pollAbort.current?.abort()
    pendingId.current = commandId
    emptyFallbackForPending.current = Boolean(opts?.emptyFallback)
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
        applyKey(cmd.result)
        if (emptyFallbackForPending.current) maybeOpenSoftware(cmd.result)
        pendingId.current = null
        setPending(false)
        return
      }
      setError(resultErrorMessage(cmd.result, cmd.status, "Registry read failed"))
      pendingId.current = null
      setPending(false)
    })()
  }, [])

  async function queue(type: string, payload: Record<string, unknown>) {
    const data = await api<{ commands: { id: string }[] }>("/api/v1/admin/commands", {
      method: "POST",
      body: JSON.stringify({ deviceIds: [deviceId], type, payload }),
    })
    const id = queuedCommandId(data)
    if (!id) throw new Error("command not queued")
    return id
  }

  async function requestKey(nextHive = hiveRef.current, nextPath = pathRef.current, opts?: { emptyFallback?: boolean }) {
    const id = await queue("get_registry", { hive: nextHive, path: nextPath })
    startWatch(id, opts)
  }
  requestKeyRef.current = requestKey

  React.useEffect(() => {
    if (!windows) return
    if (seeded.current === deviceId) {
      if (online && !autoQueued.current && !pendingId.current) {
        autoQueued.current = true
        void requestKeyRef
          .current("HKLM", REGISTRY_AGENT_KEY_PATH, { emptyFallback: true })
          .catch((e) => toast.error(e instanceof Error ? e.message : "Refresh failed"))
      }
      return
    }
    seeded.current = deviceId
    autoQueued.current = false
    const success =
      latestSuccessful?.status === "success" ? latestSuccessful : latestSuccessfulRegistry(commands ?? [])
    if (success) applyKey(success.result)
    const inflight = commands?.find((c) => c.type === "get_registry" && (c.status === "pending" || c.status === "running"))
    if (inflight) {
      startWatch(inflight.id)
      autoQueued.current = true
      return
    }
    if (online) {
      autoQueued.current = true
      void requestKeyRef
        .current("HKLM", REGISTRY_AGENT_KEY_PATH, { emptyFallback: true })
        .catch((e) => toast.error(e instanceof Error ? e.message : "Refresh failed"))
    }
  }, [windows, commands, deviceId, online, latestSuccessful, startWatch])

  React.useEffect(() => {
    if (!socket) return
    const onResult = (payload: unknown) => {
      if (!payload || typeof payload !== "object") return
      const rec = payload as { id?: string; deviceId?: string; type?: string; status?: string; result?: unknown }
      if (rec.deviceId !== deviceId) return
      const type = rec.type ?? ""
      if (type === "get_registry") {
        if (rec.status === "success" && (rec.id === pendingId.current || !pendingId.current)) {
          applyKey(rec.result)
          if (emptyFallbackForPending.current) maybeOpenSoftware(rec.result)
          stopWatch()
        } else if ((rec.status === "failed" || rec.status === "cancelled") && rec.id === pendingId.current) {
          setError(resultErrorMessage(rec.result, rec.status, "Registry read failed"))
          stopWatch()
        }
        return
      }
      if (rec.status === "success" && (type === "set_registry" || type === "delete_registry")) {
        void requestKey().catch((e) => toast.error(e instanceof Error ? e.message : "Refresh failed"))
      } else if ((rec.status === "failed" || rec.status === "cancelled") && (type === "set_registry" || type === "delete_registry")) {
        toast.error(resultErrorMessage(rec.result, rec.status, `${type.replaceAll("_", " ")} failed`))
      }
    }
    socket.on(WS_EVENTS.COMMAND_RESULT, onResult)
    return () => {
      socket.off(WS_EVENTS.COMMAND_RESULT, onResult)
    }
  }, [socket, deviceId, stopWatch])

  const openKey = useMutation({
    mutationFn: (next: { hive: RegistryHive; path: string }) => {
      setHive(next.hive)
      setPath(next.path)
      return requestKey(next.hive, next.path)
    },
    onError: (e) => toast.error(e.message),
  })
  const write = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      await queue("set_registry", payload)
    },
    onSuccess: () => {
      toast.success("Registry write queued")
      setEdit(null)
      void client.invalidateQueries({ queryKey: ["device", deviceId] })
    },
    onError: (e) => toast.error(e.message),
  })
  const remove = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      await queue("delete_registry", payload)
    },
    onSuccess: () => {
      toast.success("Registry delete queued")
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
            The registry editor browses HKLM and HKCU on enrolled Windows devices. Linux and macOS agents return
            unsupported.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const crumbs = registryCrumbs(hive, path)
  const dangerous = isDangerousRegistryPath(hive, path)
  const selectedRow = values.find((v) => (v.name || "") === selectedValue) ?? null

  function submitEdit() {
    if (!edit) return
    if (edit.mode === "create-key") {
      const name = edit.name.trim()
      if (!name) {
        toast.error("Key name required")
        return
      }
      write.mutate({ hive, path: joinRegistryPath(path, name), target: "key" })
      return
    }
    const data =
      edit.type === "REG_MULTI_SZ"
        ? edit.data.split("\n")
        : edit.type === "REG_DWORD"
          ? Number(edit.data)
          : edit.data
    write.mutate({
      hive,
      path,
      target: "value",
      name: edit.name,
      type: edit.type,
      data,
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select items={[...HIVE_ITEMS]} value={hive} onValueChange={(v) => setHive(v as RegistryHive)}>
          <SelectTrigger className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {HIVE_ITEMS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Input
          className="min-w-56 flex-1"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") openKey.mutate({ hive, path })
          }}
        />
        <Button size="sm" variant="outline" onClick={() => openKey.mutate({ hive, path })} disabled={openKey.isPending || pending}>
          {pending ? <Spinner data-icon="inline-start" /> : null}
          Open
        </Button>
      </div>
      <div className="flex flex-wrap gap-1">
        {REGISTRY_WELL_KNOWN.map((item) => (
          <Button
            key={`${item.hive}:${item.path}:${item.label}`}
            size="sm"
            variant="outline"
            onClick={() => openKey.mutate({ hive: item.hive, path: item.path })}
          >
            {item.label}
          </Button>
        ))}
      </div>
      <nav className="flex flex-wrap gap-1 text-sm">
        {crumbs.map((c, i) => (
          <Button
            key={`${c.hive}:${c.path}`}
            size="sm"
            variant={i === crumbs.length - 1 ? "secondary" : "ghost"}
            onClick={() => openKey.mutate({ hive: c.hive as RegistryHive, path: c.path })}
          >
            {c.label}
          </Button>
        ))}
      </nav>
      <p className="text-sm text-muted-foreground">
        Documented hives only (HKLM, HKCU). HKCU is the agent process identity — LocalSystem when the agent runs as a
        service, not the logged-on user. Config lives at{" "}
        <span className="font-mono">{registryDisplayPath("HKLM", REGISTRY_AGENT_KEY_PATH)}</span>. Writes confirm first.
      </p>
      {dangerous ? (
        <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
          This path can affect logon or image launch (Run / Winlogon / Image File Execution Options). Confirm carefully.
          This editor does not add persistence keys on its own.
        </p>
      ) : null}
      {error && listed ? <QueryErrorBanner cached error={error} onRetry={() => openKey.mutate({ hive, path })} /> : null}
      {truncated ? <p className="text-sm text-muted-foreground">Listing truncated at the agent cap.</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => setEdit({ mode: "create-key", name: "", type: "REG_SZ", data: "" })}>
          New key
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setEdit({ mode: "create-value", name: "", type: "REG_SZ", data: "" })}
        >
          New value
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!selectedRow}
          onClick={() =>
            selectedRow &&
            setEdit({
              mode: "edit-value",
              name: selectedRow.name,
              type: (REGISTRY_VALUE_TYPES as readonly string[]).includes(selectedRow.type)
                ? (selectedRow.type as RegistryValueType)
                : "REG_SZ",
              data: valueToEditText(selectedRow),
            })
          }
        >
          Edit
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={!selectedRow}
          onClick={() => selectedRow && setConfirm({ kind: "value", name: selectedRow.name })}
        >
          Delete value
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={!path}
          onClick={() => setConfirm({ kind: "key" })}
        >
          Delete key
        </Button>
        {path ? (
          <Button size="sm" variant="ghost" onClick={() => openKey.mutate({ hive, path: parentRegistryPath(path) })}>
            Up
          </Button>
        ) : null}
      </div>
      {!listed && pending ? (
        <p className="text-sm text-muted-foreground">Waiting for agent…</p>
      ) : error && !listed ? (
        <QueryErrorState title="Registry read failed" error={error} onRetry={() => openKey.mutate({ hive, path })} />
      ) : !listed ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No key loaded</EmptyTitle>
            <EmptyDescription>
              {online
                ? "Open a hive path, or use Agent (HKLM) to browse the documented config key."
                : "Device is offline. A last successful key will show as a skeleton when available."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          <Card>
            <CardContent className="pt-6">
              <p className="mb-2 text-sm font-medium">Subkeys</p>
              {keys.length === 0 ? (
                <p className="text-sm text-muted-foreground">No subkeys.</p>
              ) : (
                <Table>
                  <TableBody>
                    {keys.map((name) => (
                      <TableRow
                        key={name}
                        className="cursor-pointer"
                        onClick={() => openKey.mutate({ hive, path: joinRegistryPath(path, name) })}
                      >
                        <TableCell className="font-mono text-sm">{name}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <p className="mb-2 text-sm font-medium">Values</p>
              {values.length === 0 ? (
                <p className="text-sm text-muted-foreground">No values.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Data</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {values.map((v) => (
                      <TableRow
                        key={`${v.name}:${v.type}`}
                        data-state={selectedValue === (v.name || "") ? "selected" : undefined}
                        className="cursor-pointer"
                        onClick={() => setSelectedValue(v.name || "")}
                      >
                        <TableCell className="font-mono text-sm">
                          {v.name || "(Default)"}
                          {v.truncated ? (
                            <Badge variant="outline" className="ml-2">
                              truncated
                            </Badge>
                          ) : null}
                        </TableCell>
                        <TableCell>{v.type}</TableCell>
                        <TableCell className="max-w-xs truncate font-mono text-xs">{formatRegistryData(v)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      )}
      <Dialog open={!!edit} onOpenChange={(open) => !open && setEdit(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {edit?.mode === "create-key" ? "New key" : edit?.mode === "create-value" ? "New value" : "Edit value"}
            </DialogTitle>
            <DialogDescription>
              Writes go through set_registry and require confirmation on the Commands composer path as well.{" "}
              {dangerous ? "This key is marked dangerous." : null}
            </DialogDescription>
          </DialogHeader>
          {edit ? (
            <FieldGroup>
              {edit.mode === "create-key" ? (
                <Field>
                  <FieldLabel htmlFor="reg-key">Key name</FieldLabel>
                  <Input id="reg-key" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
                </Field>
              ) : (
                <>
                  <Field>
                    <FieldLabel htmlFor="reg-name">Value name</FieldLabel>
                    <Input
                      id="reg-name"
                      value={edit.name}
                      disabled={edit.mode === "edit-value"}
                      onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                    />
                  </Field>
                  <Field>
                    <FieldLabel>Type</FieldLabel>
                    <Select
                      items={[...TYPE_ITEMS]}
                      value={edit.type}
                      onValueChange={(v) => setEdit({ ...edit, type: v as RegistryValueType })}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {TYPE_ITEMS.map((item) => (
                            <SelectItem key={item.value} value={item.value}>
                              {item.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="reg-data">Data</FieldLabel>
                    {edit.type === "REG_DWORD" ? (
                      <NumberInput
                        id="reg-data"
                        min={0}
                        value={Number(edit.data) || 0}
                        onValueChange={(n) => setEdit({ ...edit, data: String(n) })}
                      />
                    ) : (
                      <Textarea
                        id="reg-data"
                        rows={4}
                        value={edit.data}
                        onChange={(e) => setEdit({ ...edit, data: e.target.value })}
                      />
                    )}
                  </Field>
                </>
              )}
            </FieldGroup>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEdit(null)}>
              Cancel
            </Button>
            <Button onClick={() => setWriteConfirm(true)} disabled={write.isPending || !edit}>
              Confirm write
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={writeConfirm} onOpenChange={setWriteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Write registry change?</AlertDialogTitle>
            <AlertDialogDescription>
              {edit?.mode === "create-key"
                ? `Create key ${joinRegistryPath(path, edit.name)} under ${hive}.`
                : `Write ${edit?.type ?? "value"} ${edit?.name || "(Default)"} on ${registryDisplayPath(hive, path)}.`}
              {dangerous ? " This path is marked dangerous." : ""} HKLM writes typically require the agent to run elevated (LocalSystem).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setWriteConfirm(false)
                submitEdit()
              }}
            >
              Write
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={!!confirm} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete registry {confirm?.kind}?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === "key"
                ? `Delete ${registryDisplayPath(hive, path)}? The key must have no subkeys.`
                : `Delete value ${selectedRow?.name || "(Default)"} from ${registryDisplayPath(hive, path)}?`}
              {dangerous ? " This path is marked dangerous." : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (!confirm) return
                if (confirm.kind === "key") {
                  remove.mutate({ hive, path, target: "key" })
                  return
                }
                remove.mutate({ hive, path, target: "value", name: confirm.name ?? "" })
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function valueToEditText(value: RegistryValue): string {
  if (value.data == null) return ""
  if (Array.isArray(value.data)) return value.data.map((v) => String(v)).join("\n")
  return String(value.data)
}
