"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { PuzzleIcon } from "lucide-react"
import { toast } from "sonner"
import { PLUGIN_RUNTIMES, type PluginRuntime } from "@workspace/shared"

import { api, applyOperatorAuth, formatBytes, formatWhen } from "@/lib/api"
import { BulkProgressLabel, trackBulkCommands } from "@/lib/bulk-command-progress"
import { NumberInput } from "@/components/number-input"
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card"
import { Checkbox } from "@workspace/ui/components/checkbox"
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@workspace/ui/components/field"
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
import { Switch } from "@workspace/ui/components/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import { Textarea } from "@workspace/ui/components/textarea"

type PluginRow = {
  id: string
  name: string
  version: string
  runtime: string
  platform: string | null
  arch: string | null
  sha256: string
  timeoutSec: number
  networkAllowed: boolean
  createdAt: string
  size: number
  grants: string[]
}

type DeviceRow = { id: string; hostname: string; platform: string; arch: string }

type PluginStarterRuntime = "python" | "go_source"

type PluginStarter = {
  id: string
  name: string
  description: string
  defaultRuntime: PluginStarterRuntime
  runtimes: PluginStarterRuntime[]
  files?: Partial<Record<PluginStarterRuntime, string>>
  networkAllowed: boolean
  timeoutSec: number
  suggestedArgs: string[]
}

const EMPTY_DEVICES: DeviceRow[] = []

const RUNTIME_ITEMS = PLUGIN_RUNTIMES.filter((value) => value !== "js_goja").map((value) => ({
  label: value.replaceAll("_", " "),
  value,
}))

export function PluginsPage() {
  const client = useQueryClient()
  const plugins = useQuery({
    queryKey: ["plugins"],
    queryFn: () => api<{ plugins: PluginRow[] }>("/api/v1/admin/plugins"),
    staleTime: 15_000,
  })
  const starters = useQuery({
    queryKey: ["plugin-templates"],
    queryFn: () => api<{ templates: PluginStarter[] }>("/api/v1/admin/plugins/templates"),
    staleTime: 60_000,
  })
  const [fromTpl, setFromTpl] = React.useState<PluginStarter | null>(null)
  const devices = useQuery({
    queryKey: ["devices"],
    queryFn: () => api<{ devices: DeviceRow[] }>("/api/v1/admin/devices"),
    staleTime: 30_000,
  })
  const [name, setName] = React.useState("")
  const [version, setVersion] = React.useState("1.0.0")
  const [runtime, setRuntime] = React.useState<PluginRuntime>("python")
  const [platform, setPlatform] = React.useState("")
  const [arch, setArch] = React.useState("")
  const [timeoutSec, setTimeoutSec] = React.useState("60")
  const [networkAllowed, setNetworkAllowed] = React.useState(false)
  const [grantsFor, setGrantsFor] = React.useState<PluginRow | null>(null)
  const [runFor, setRunFor] = React.useState<PluginRow | null>(null)
  const [deleteFor, setDeleteFor] = React.useState<PluginRow | null>(null)

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const body = new FormData()
      body.append("file", file)
      body.append("name", name)
      body.append("version", version)
      body.append("runtime", runtime)
      body.append("platform", platform)
      body.append("arch", arch)
      body.append("timeoutSec", timeoutSec)
      body.append("networkAllowed", networkAllowed ? "true" : "false")
      const res = await fetch("/api/v1/admin/plugins", {
        method: "POST",
        body,
        credentials: "include",
        headers: (() => {
          const headers = new Headers()
          applyOperatorAuth(headers)
          return headers
        })(),
      })
      if (!res.ok) {
        let message = "upload failed"
        try {
          const json = (await res.json()) as { error?: string }
          if (json.error) message = json.error
        } catch {
          /* ignore */
        }
        throw new Error(message)
      }
    },
    onSuccess: () => {
      toast.success("Plugin uploaded")
      void client.invalidateQueries({ queryKey: ["plugins"] })
    },
    onError: (e) => toast.error(e.message),
  })
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/admin/plugins/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Plugin deleted")
      void client.invalidateQueries({ queryKey: ["plugins"] })
    },
    onError: (e) => toast.error(e.message),
  })

  const rows = plugins.data?.plugins ?? []

  const starterRows = starters.data?.templates ?? []

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Starter templates</CardTitle>
          <CardDescription>
            Catalog entries from GET /api/v1/admin/plugins/templates. Network stays off unless you enable it. js_goja is
            not offered.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {starters.isPending ? (
            <p className="text-sm text-muted-foreground">Loading starters…</p>
          ) : starters.isError ? (
            <p className="text-sm text-muted-foreground">Starter catalog is not available yet. Custom file upload still works.</p>
          ) : !starterRows.length ? (
            <p className="text-sm text-muted-foreground">No starters returned. Upload a custom file below.</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {starterRows.map((tpl) => (
                <Card key={tpl.id}>
                  <CardHeader>
                    <CardTitle className="text-sm">{tpl.name}</CardTitle>
                    <CardDescription>{tpl.description}</CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">{tpl.defaultRuntime}</Badge>
                    {tpl.runtimes.length > 1 ? (
                      <Badge variant="outline">{tpl.runtimes.join(" · ")}</Badge>
                    ) : null}
                    {tpl.networkAllowed ? <Badge variant="outline">network</Badge> : <Badge variant="outline">offline</Badge>}
                    <Button size="sm" className="ml-auto" onClick={() => setFromTpl(tpl)}>
                      Create
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      <FromTemplateDialog
        template={fromTpl}
        onClose={() => setFromTpl(null)}
      />
      <Card>
        <CardHeader>
          <CardTitle>Upload custom plugin</CardTitle>
          <CardDescription>
            Hash-pinned subprocess. Grant devices before run. The js_goja runtime is not offered here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="plug-name">Name</FieldLabel>
              <Input id="plug-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="inventory" />
            </Field>
            <Field>
              <FieldLabel htmlFor="plug-ver">Version</FieldLabel>
              <Input id="plug-ver" value={version} onChange={(e) => setVersion(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel>Runtime</FieldLabel>
              <Select
                items={RUNTIME_ITEMS}
                value={runtime}
                onValueChange={(value) => setRuntime(value as PluginRuntime)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {RUNTIME_ITEMS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="plug-plat">Platform (optional)</FieldLabel>
              <Input
                id="plug-plat"
                value={platform}
                onChange={(e) => setPlatform(e.target.value)}
                placeholder="windows, linux, darwin"
              />
              <FieldDescription>Leave empty for scripts that run everywhere.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="plug-arch">Arch (optional)</FieldLabel>
              <Input id="plug-arch" value={arch} onChange={(e) => setArch(e.target.value)} placeholder="amd64" />
            </Field>
            <Field>
              <FieldLabel htmlFor="plug-timeout">Timeout (sec)</FieldLabel>
              <Input
                id="plug-timeout"
                type="number"
                value={timeoutSec}
                onChange={(e) => setTimeoutSec(e.target.value)}
              />
            </Field>
            <Field orientation="horizontal">
              <FieldLabel>Allow network</FieldLabel>
              <Switch checked={networkAllowed} onCheckedChange={setNetworkAllowed} />
            </Field>
            <Field>
              <FieldLabel htmlFor="plug-file">Plugin file</FieldLabel>
              <Input
                id="plug-file"
                type="file"
                disabled={!name || upload.isPending}
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) upload.mutate(file)
                  e.target.value = ""
                }}
              />
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>
      {plugins.isError && plugins.data ? (
        <QueryErrorBanner cached error={plugins.error} onRetry={() => void plugins.refetch()} />
      ) : null}
      {plugins.isError && !plugins.data ? (
        <QueryErrorState title="Plugins unavailable" error={plugins.error} onRetry={() => void plugins.refetch()} />
      ) : plugins.isLoading && !rows.length ? (
        <p className="text-sm text-muted-foreground">Loading plugins…</p>
      ) : !rows.length ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PuzzleIcon />
            </EmptyMedia>
            <EmptyTitle>No plugins yet</EmptyTitle>
            <EmptyDescription>Upload a Python script, Go source, or binary template.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <div>
              <CardTitle>Catalog</CardTitle>
              <CardDescription>Run is treated as destructive and requires a device grant.</CardDescription>
            </div>
            <BulkProgressLabel />
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Plugin</TableHead>
                  <TableHead>Runtime</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Grants</TableHead>
                  <TableHead>SHA-256</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="font-medium">{row.name}</span>
                        <span className="text-xs text-muted-foreground">
                          v{row.version} · {formatBytes(row.size)} · {formatWhen(row.createdAt)}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{row.runtime}</Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {row.platform || row.arch ? `${row.platform || "*"}/${row.arch || "*"}` : "any"}
                    </TableCell>
                    <TableCell className="text-sm">
                      {row.grants.includes("*") ? "all devices" : `${row.grants.length} device(s)`}
                    </TableCell>
                    <TableCell className="max-w-[10rem] truncate font-mono text-xs">{row.sha256}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={() => setGrantsFor(row)}>
                          Grants
                        </Button>
                        <Button size="sm" onClick={() => setRunFor(row)}>
                          Run
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setDeleteFor(row)}>
                          Delete
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      <GrantsDialog
        plugin={grantsFor}
        devices={devices.data?.devices}
        onClose={() => setGrantsFor(null)}
      />
      <RunDialog
        plugin={runFor}
        devices={devices.data?.devices}
        starters={starterRows}
        onClose={() => setRunFor(null)}
      />
      <AlertDialog open={Boolean(deleteFor)} onOpenChange={(open) => !open && setDeleteFor(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteFor?.name}?</AlertDialogTitle>
            <AlertDialogDescription>Removes the blob and all device grants.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleteFor) remove.mutate(deleteFor.id)
                setDeleteFor(null)
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

function FromTemplateDialog({
  template,
  onClose,
}: {
  template: PluginStarter | null
  onClose: () => void
}) {
  const client = useQueryClient()
  const [name, setName] = React.useState("")
  const [version, setVersion] = React.useState("1.0.0")
  const [timeoutSec, setTimeoutSec] = React.useState("60")
  const [networkAllowed, setNetworkAllowed] = React.useState(false)
  const [runtime, setRuntime] = React.useState<PluginStarterRuntime>("python")
  const [platform, setPlatform] = React.useState("")
  const [arch, setArch] = React.useState("")
  React.useEffect(() => {
    if (!template) return
    setName(template.name)
    setVersion("1.0.0")
    setTimeoutSec(String(template.timeoutSec ?? 60))
    setNetworkAllowed(Boolean(template.networkAllowed))
    setRuntime(template.defaultRuntime)
    setPlatform("")
    setArch("")
  }, [template])
  const runtimeItems = (template?.runtimes ?? ["python", "go_source"]).map((value) => ({
    label: value.replaceAll("_", " "),
    value,
  }))
  const create = useMutation({
    mutationFn: () =>
      api<{ plugin: PluginRow }>("/api/v1/admin/plugins/from-template", {
        method: "POST",
        body: JSON.stringify({
          templateId: template!.id,
          runtime,
          name: name.trim() || undefined,
          version: version.trim() || undefined,
          timeoutSec: Number(timeoutSec),
          networkAllowed,
          platform: platform.trim() || undefined,
          arch: arch.trim() || undefined,
        }),
      }),
    onSuccess: () => {
      toast.success("Plugin created from template. Set grants on the catalog row before running.")
      void client.invalidateQueries({ queryKey: ["plugins"] })
      onClose()
    },
    onError: (e) => toast.error(e.message),
  })
  return (
    <Dialog open={Boolean(template)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create {template?.name}</DialogTitle>
          <DialogDescription>
            Writes the starter blob into the plugin catalog. Device grants stay on the Grants dialog after create.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="ft-name">Name</FieldLabel>
            <Input id="ft-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="ft-ver">Version</FieldLabel>
            <Input id="ft-ver" value={version} onChange={(e) => setVersion(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel>Runtime</FieldLabel>
            <Select
              items={runtimeItems}
              value={runtime}
              onValueChange={(value) => value && setRuntime(value as PluginStarterRuntime)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {runtimeItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="ft-timeout">Timeout (sec)</FieldLabel>
            <Input id="ft-timeout" type="number" value={timeoutSec} onChange={(e) => setTimeoutSec(e.target.value)} />
          </Field>
          <Field orientation="horizontal">
            <FieldLabel>Allow network</FieldLabel>
            <Switch checked={networkAllowed} onCheckedChange={setNetworkAllowed} />
          </Field>
          <Field>
            <FieldLabel htmlFor="ft-plat">Platform (optional)</FieldLabel>
            <Input
              id="ft-plat"
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              placeholder="windows, linux, darwin"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="ft-arch">Arch (optional)</FieldLabel>
            <Input id="ft-arch" value={arch} onChange={(e) => setArch(e.target.value)} placeholder="amd64" />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => create.mutate()} disabled={create.isPending || !name.trim()}>
            {create.isPending ? <Spinner data-icon="inline-start" /> : null}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function GrantsDialog({
  plugin,
  devices,
  onClose,
}: {
  plugin: PluginRow | null
  devices?: DeviceRow[]
  onClose: () => void
}) {
  const client = useQueryClient()
  const [all, setAll] = React.useState(false)
  const [selected, setSelected] = React.useState<string[]>([])
  const deviceList = devices ?? EMPTY_DEVICES
  React.useEffect(() => {
    if (!plugin) return
    const star = plugin.grants.includes("*")
    setAll(star)
    setSelected(star ? [] : plugin.grants)
  }, [plugin])
  const save = useMutation({
    mutationFn: () =>
      api(`/api/v1/admin/plugins/${plugin!.id}/grants`, {
        method: "PUT",
        body: JSON.stringify({ deviceIds: all ? ["*"] : selected }),
      }),
    onSuccess: () => {
      toast.success("Grants updated")
      void client.invalidateQueries({ queryKey: ["plugins"] })
      onClose()
    },
    onError: (e) => toast.error(e.message),
  })
  return (
    <Dialog open={Boolean(plugin)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Grants · {plugin?.name}</DialogTitle>
          <DialogDescription>Explicit allow. Empty means nobody can run this plugin.</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field orientation="horizontal">
            <FieldLabel>All devices (*)</FieldLabel>
            <Switch checked={all} onCheckedChange={setAll} />
          </Field>
          {!all ? (
            <div className="max-h-64 overflow-auto rounded-lg border p-2">
              {deviceList.map((device) => (
                <label key={device.id} className="flex items-center gap-2 py-1 text-sm">
                  <Checkbox
                    checked={selected.includes(device.id)}
                    onCheckedChange={(checked) =>
                      setSelected((cur) => (checked ? [...cur, device.id] : cur.filter((id) => id !== device.id)))
                    }
                  />
                  <span>
                    {device.hostname}{" "}
                    <span className="text-muted-foreground">
                      {device.platform}/{device.arch}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          ) : null}
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !plugin}>
            {save.isPending ? <Spinner data-icon="inline-start" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RunDialog({
  plugin,
  devices,
  starters,
  onClose,
}: {
  plugin: PluginRow | null
  devices?: DeviceRow[]
  starters: PluginStarter[]
  onClose: () => void
}) {
  const client = useQueryClient()
  const [selected, setSelected] = React.useState<string[]>([])
  const [argsText, setArgsText] = React.useState("")
  const [confirm, setConfirm] = React.useState(false)
  const deviceList = devices ?? EMPTY_DEVICES
  React.useEffect(() => {
    if (!plugin) return
    setArgsText("")
    setConfirm(false)
    if (plugin.grants.includes("*")) {
      setSelected(deviceList.map((d) => d.id))
      return
    }
    setSelected(plugin.grants.filter((id) => deviceList.some((d) => d.id === id)))
    // deviceList is only used to filter grants; plugin identity is the reset trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugin])
  const run = useMutation({
    mutationFn: () =>
      api<{ commands: { id: string }[]; skipped?: Array<{ deviceId: string; reason: string }> }>(
        "/api/v1/admin/commands",
        {
          method: "POST",
          body: JSON.stringify({
            deviceIds: selected,
            type: "run_plugin",
            payload: {
              pluginId: plugin!.id,
              args: argsText
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean),
            },
          }),
        }
      ),
    onSuccess: (data) => {
      trackBulkCommands(data.commands.map((c) => c.id))
      const skipped = data.skipped?.length ?? 0
      toast.success(skipped ? `Queued ${data.commands.length}, skipped ${skipped}` : "Plugin queued")
      void client.invalidateQueries({ queryKey: ["commands"] })
      void client.invalidateQueries({ queryKey: ["overview"] })
      onClose()
    },
    onError: (e) => toast.error(e.message),
  })
  return (
    <>
      <Dialog open={Boolean(plugin) && !confirm} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Run {plugin?.name}</DialogTitle>
            <DialogDescription>Queues run_plugin on granted devices. Confirm before send.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <div className="max-h-48 overflow-auto rounded-lg border p-2">
              {deviceList.map((device) => (
                <label key={device.id} className="flex items-center gap-2 py-1 text-sm">
                  <Checkbox
                    checked={selected.includes(device.id)}
                    onCheckedChange={(checked) =>
                      setSelected((cur) => (checked ? [...cur, device.id] : cur.filter((id) => id !== device.id)))
                    }
                  />
                  <span>
                    {device.hostname}{" "}
                    <span className="text-muted-foreground">
                      {device.platform}/{device.arch}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            <Field>
              <FieldLabel htmlFor="plug-args">Args (one per line)</FieldLabel>
              {(() => {
                const match = starters.find(
                  (s) => s.name.toLowerCase() === (plugin?.name ?? "").toLowerCase() || s.id === plugin?.name
                )
                const suggested = match?.suggestedArgs ?? []
                if (!suggested.length) return null
                return (
                  <div className="mb-2 flex flex-wrap gap-1">
                    <Button size="sm" variant="outline" onClick={() => setArgsText(suggested.join("\n"))}>
                      Suggested args
                    </Button>
                  </div>
                )
              })()}
              <Textarea id="plug-args" rows={4} value={argsText} onChange={(e) => setArgsText(e.target.value)} />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => setConfirm(true)} disabled={!selected.length}>
              Queue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm run plugin</AlertDialogTitle>
            <AlertDialogDescription>
              Plugins run as a subprocess on {selected.length} device(s) and can change the machine. Continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirm(false)
                run.mutate()
              }}
            >
              {run.isPending ? <Spinner data-icon="inline-start" /> : null}
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
