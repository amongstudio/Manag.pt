"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { BoxesIcon, ShieldCheckIcon } from "lucide-react"
import { toast } from "sonner"
import type { ModuleArgumentSpec, ModuleKind } from "@workspace/shared"

import { api, applyOperatorAuth, formatBytes, formatWhen } from "@/lib/api"
import {
  BulkProgressLabel,
  trackBulkCommands,
} from "@/lib/bulk-command-progress"
import { QueryErrorBanner, QueryErrorState } from "@/components/query-error"
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@workspace/ui/components/alert"
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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
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
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@workspace/ui/components/field"
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

type ModuleRow = {
  id: string
  displayName: string
  version: string
  kind: ModuleKind
  platform: string
  arch: string
  sha256: string
  size: number
  signer: string
  signature: string
  signatureValid: boolean
  entrypoint: string
  action: string
  argumentsSchema: ModuleArgumentSpec[]
  timeoutSec: number
  maxOutputBytes: number
  enabled: boolean
  revokedAt: string | null
  createdAt: string
  updatedAt: string
  grants: string[]
  dllHostSupported: boolean
}

type DeviceRow = {
  id: string
  hostname: string
  platform: string
  arch: string
}

const EMPTY_DEVICES: DeviceRow[] = []
const KIND_ITEMS = [
  { label: "Executable (.exe)", value: "exe" },
  { label: "DLL plug-in (.dll, host pending)", value: "dll-plugin" },
]
const ARCH_ITEMS = [
  { label: "x64 (amd64)", value: "amd64" },
  { label: "ARM64", value: "arm64" },
]

export function ModulesPage() {
  const client = useQueryClient()
  const modules = useQuery({
    queryKey: ["modules"],
    queryFn: () => api<{ modules: ModuleRow[] }>("/api/v1/admin/modules"),
    staleTime: 15_000,
  })
  const devices = useQuery({
    queryKey: ["devices"],
    queryFn: () => api<{ devices: DeviceRow[] }>("/api/v1/admin/devices"),
    staleTime: 30_000,
  })
  const [grantsFor, setGrantsFor] = React.useState<ModuleRow | null>(null)
  const [runFor, setRunFor] = React.useState<ModuleRow | null>(null)
  const [approveFor, setApproveFor] = React.useState<ModuleRow | null>(null)
  const [revokeFor, setRevokeFor] = React.useState<ModuleRow | null>(null)

  const patch = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api(`/api/v1/admin/modules/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: (_data, variables) => {
      toast.success(
        variables.enabled ? "Module approved and enabled" : "Module disabled"
      )
      void client.invalidateQueries({ queryKey: ["modules"] })
    },
    onError: (error) => toast.error(error.message),
  })
  const revoke = useMutation({
    mutationFn: (id: string) =>
      api(`/api/v1/admin/modules/${id}/revoke`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Module permanently revoked")
      void client.invalidateQueries({ queryKey: ["modules"] })
    },
    onError: (error) => toast.error(error.message),
  })
  const rows = modules.data?.modules ?? []

  return (
    <div className="flex flex-col gap-6">
      <Alert>
        <ShieldCheckIcon />
        <AlertTitle>Approved child processes only</AlertTitle>
        <AlertDescription>
          Executables run as bounded agent child processes after signature and
          SHA-256 verification. DLLs stay cataloged but cannot run until a
          dedicated module host exists. This library never injects into another
          process or loads code into the main agent.
        </AlertDescription>
      </Alert>
      <RegisterModuleCard />
      {modules.isError && modules.data ? (
        <QueryErrorBanner
          cached
          error={modules.error}
          onRetry={() => void modules.refetch()}
        />
      ) : null}
      {modules.isError && !modules.data ? (
        <QueryErrorState
          title="Module library unavailable"
          error={modules.error}
          onRetry={() => void modules.refetch()}
        />
      ) : modules.isLoading && !rows.length ? (
        <p className="text-sm text-muted-foreground">Loading modules…</p>
      ) : !rows.length ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BoxesIcon />
            </EmptyMedia>
            <EmptyTitle>No approved artifacts</EmptyTitle>
            <EmptyDescription>
              Register a Windows PE artifact. New modules are disabled and
              ungranted by default.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <div>
              <CardTitle>Module catalog</CardTitle>
              <CardDescription>
                Approval, device grants, immutable signatures, and revocation
                status.
              </CardDescription>
            </div>
            <BulkProgressLabel />
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Module</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Grants</TableHead>
                  <TableHead>SHA-256</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const runnable =
                    row.enabled &&
                    !row.revokedAt &&
                    row.signatureValid &&
                    row.kind === "exe"
                  return (
                    <TableRow key={row.id}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-medium">{row.displayName}</span>
                          <span className="text-xs text-muted-foreground">
                            {row.id} · v{row.version} · {formatBytes(row.size)}{" "}
                            · {formatWhen(row.createdAt)}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{row.kind}</Badge>
                      </TableCell>
                      <TableCell>
                        {row.revokedAt ? (
                          <Badge variant="destructive">revoked</Badge>
                        ) : !row.signatureValid ? (
                          <Badge variant="destructive">invalid signature</Badge>
                        ) : row.enabled ? (
                          <Badge>enabled</Badge>
                        ) : (
                          <Badge variant="outline">disabled</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {row.platform}/{row.arch}
                      </TableCell>
                      <TableCell className="text-sm">
                        {row.grants.includes("*")
                          ? "all devices"
                          : `${row.grants.length} device(s)`}
                      </TableCell>
                      <TableCell className="max-w-36 truncate font-mono text-xs">
                        {row.sha256}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={Boolean(row.revokedAt)}
                            onClick={() => setGrantsFor(row)}
                          >
                            Grants
                          </Button>
                          {row.enabled ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={
                                Boolean(row.revokedAt) || patch.isPending
                              }
                              onClick={() =>
                                patch.mutate({ id: row.id, enabled: false })
                              }
                            >
                              Disable
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={
                                Boolean(row.revokedAt) || !row.signatureValid
                              }
                              onClick={() => setApproveFor(row)}
                            >
                              Approve
                            </Button>
                          )}
                          <Button
                            size="sm"
                            disabled={!runnable}
                            title={
                              row.kind === "dll-plugin"
                                ? "Dedicated DLL module host is pending"
                                : undefined
                            }
                            onClick={() => setRunFor(row)}
                          >
                            Run
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={Boolean(row.revokedAt)}
                            onClick={() => setRevokeFor(row)}
                          >
                            Revoke
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      {grantsFor ? (
        <GrantsDialog
          key={grantsFor.id}
          module={grantsFor}
          devices={devices.data?.devices}
          onClose={() => setGrantsFor(null)}
        />
      ) : null}
      {runFor ? (
        <RunDialog
          key={`${runFor.id}:${devices.data?.devices.length ?? 0}`}
          module={runFor}
          devices={devices.data?.devices}
          onClose={() => setRunFor(null)}
        />
      ) : null}
      <AlertDialog
        open={Boolean(approveFor)}
        onOpenChange={(open) => !open && setApproveFor(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Approve {approveFor?.displayName}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Enabling makes this exact signed manifest eligible to run on
              explicitly granted devices. Review its hash, target, arguments,
              and limits first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (approveFor)
                  patch.mutate({ id: approveFor.id, enabled: true })
                setApproveFor(null)
              }}
            >
              Approve module
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={Boolean(revokeFor)}
        onOpenChange={(open) => !open && setRevokeFor(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Permanently revoke {revokeFor?.displayName}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Revocation disables the module, clears its grants, and makes
              queued or retried runs fail closed. It cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (revokeFor) revoke.mutate(revokeFor.id)
                setRevokeFor(null)
              }}
            >
              Revoke module
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function RegisterModuleCard() {
  const client = useQueryClient()
  const [id, setId] = React.useState("")
  const [displayName, setDisplayName] = React.useState("")
  const [version, setVersion] = React.useState("1.0.0")
  const [kind, setKind] = React.useState<ModuleKind>("exe")
  const [arch, setArch] = React.useState("amd64")
  const [action, setAction] = React.useState("run")
  const [timeoutSec, setTimeoutSec] = React.useState("60")
  const [maxOutputBytes, setMaxOutputBytes] = React.useState("65536")
  const [argumentsSchema, setArgumentsSchema] = React.useState("[]")
  const [artifact, setArtifact] = React.useState<File | null>(null)
  const register = useMutation({
    mutationFn: async () => {
      if (!artifact) throw new Error("Choose an artifact")
      let parsedArguments: unknown
      try {
        parsedArguments = JSON.parse(argumentsSchema)
      } catch {
        throw new Error("Arguments schema must be valid JSON")
      }
      if (!Array.isArray(parsedArguments))
        throw new Error("Arguments schema must be a JSON array")
      const body = new FormData()
      body.append("id", id.trim())
      body.append("displayName", displayName.trim())
      body.append("version", version.trim())
      body.append("kind", kind)
      body.append("platform", "windows")
      body.append("arch", arch)
      body.append(
        "entrypoint",
        `${id.trim()}.${kind === "exe" ? "exe" : "dll"}`
      )
      body.append("action", action.trim())
      body.append("argumentsSchema", JSON.stringify(parsedArguments))
      body.append("timeoutSec", timeoutSec)
      body.append("maxOutputBytes", maxOutputBytes)
      body.append("file", artifact)
      const headers = new Headers()
      applyOperatorAuth(headers)
      const response = await fetch("/api/v1/admin/modules", {
        method: "POST",
        body,
        credentials: "include",
        headers,
      })
      if (!response.ok) {
        const result = (await response.json().catch(() => ({}))) as {
          error?: string
        }
        throw new Error(result.error || "module registration failed")
      }
    },
    onSuccess: () => {
      toast.success(
        "Module registered disabled. Review and approve it before use."
      )
      setArtifact(null)
      void client.invalidateQueries({ queryKey: ["modules"] })
    },
    onError: (error) => toast.error(error.message),
  })
  return (
    <Card>
      <CardHeader>
        <CardTitle>Register signed module artifact</CardTitle>
        <CardDescription>
          Windows PE files only. Registration signs the execution manifest;
          approval and device grants are separate.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="module-id">Stable ID</FieldLabel>
            <Input
              id="module-id"
              value={id}
              onChange={(event) => setId(event.target.value.toLowerCase())}
              placeholder="vendor-diagnostic-tool"
            />
            <FieldDescription>
              Lowercase letters, numbers, dots, underscores, and hyphens.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="module-name">Display name</FieldLabel>
            <Input
              id="module-name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="module-version">Version</FieldLabel>
            <Input
              id="module-version"
              value={version}
              onChange={(event) => setVersion(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel>Kind</FieldLabel>
            <Select
              items={KIND_ITEMS}
              value={kind}
              onValueChange={(value) => value && setKind(value as ModuleKind)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {KIND_ITEMS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel>Architecture</FieldLabel>
            <Select
              items={ARCH_ITEMS}
              value={arch}
              onValueChange={(value) => value && setArch(value)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {ARCH_ITEMS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="module-action">Action name</FieldLabel>
            <Input
              id="module-action"
              value={action}
              onChange={(event) => setAction(event.target.value)}
            />
            <FieldDescription>
              Auditable action metadata exposed to the child as
              PC_MODULE_ACTION.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="module-timeout">Timeout (seconds)</FieldLabel>
            <Input
              id="module-timeout"
              type="number"
              min={1}
              max={900}
              value={timeoutSec}
              onChange={(event) => setTimeoutSec(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="module-output">
              Maximum combined output (bytes)
            </FieldLabel>
            <Input
              id="module-output"
              type="number"
              min={1024}
              max={1_048_576}
              value={maxOutputBytes}
              onChange={(event) => setMaxOutputBytes(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="module-args-schema">
              Positional arguments schema
            </FieldLabel>
            <Textarea
              id="module-args-schema"
              rows={5}
              value={argumentsSchema}
              onChange={(event) => setArgumentsSchema(event.target.value)}
            />
            <FieldDescription>
              JSON array of name, type (string/integer/boolean), required,
              maxLength, and optional choices. No shell interpolation is used.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="module-artifact">Artifact</FieldLabel>
            <Input
              id="module-artifact"
              type="file"
              accept={kind === "exe" ? ".exe" : ".dll"}
              onChange={(event) => setArtifact(event.target.files?.[0] ?? null)}
            />
          </Field>
          <Button
            onClick={() => register.mutate()}
            disabled={
              register.isPending ||
              !id.trim() ||
              !displayName.trim() ||
              !artifact
            }
          >
            {register.isPending ? <Spinner data-icon="inline-start" /> : null}
            Register disabled module
          </Button>
        </FieldGroup>
      </CardContent>
    </Card>
  )
}

function GrantsDialog({
  module,
  devices,
  onClose,
}: {
  module: ModuleRow
  devices?: DeviceRow[]
  onClose: () => void
}) {
  const client = useQueryClient()
  const [all, setAll] = React.useState(module.grants.includes("*"))
  const [selected, setSelected] = React.useState<string[]>(
    module.grants.includes("*") ? [] : module.grants
  )
  const deviceList = devices ?? EMPTY_DEVICES
  const save = useMutation({
    mutationFn: () =>
      api(`/api/v1/admin/modules/${module.id}/grants`, {
        method: "PUT",
        body: JSON.stringify({ deviceIds: all ? ["*"] : selected }),
      }),
    onSuccess: () => {
      toast.success("Module grants updated")
      void client.invalidateQueries({ queryKey: ["modules"] })
      onClose()
    },
    onError: (error) => toast.error(error.message),
  })
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Device grants · {module.displayName}</DialogTitle>
          <DialogDescription>
            Empty means no device can fetch or run this module.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field orientation="horizontal">
            <Switch
              id="module-all-devices"
              checked={all}
              onCheckedChange={setAll}
            />
            <FieldLabel htmlFor="module-all-devices">
              Grant all devices
            </FieldLabel>
          </Field>
          {!all ? (
            <div className="max-h-64 overflow-auto rounded-lg border p-2">
              {deviceList.map((device) => (
                <label
                  key={device.id}
                  className="flex items-center gap-2 py-1 text-sm"
                >
                  <Checkbox
                    checked={selected.includes(device.id)}
                    onCheckedChange={(checked) =>
                      setSelected((current) =>
                        checked
                          ? [...current, device.id]
                          : current.filter((id) => id !== device.id)
                      )
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
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? <Spinner data-icon="inline-start" /> : null}
            Save grants
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RunDialog({
  module,
  devices,
  onClose,
}: {
  module: ModuleRow
  devices?: DeviceRow[]
  onClose: () => void
}) {
  const client = useQueryClient()
  const deviceList = devices ?? EMPTY_DEVICES
  const compatible = deviceList.filter(
    (device) =>
      device.platform === module.platform &&
      device.arch === module.arch &&
      (module.grants.includes("*") || module.grants.includes(device.id))
  )
  const [selected, setSelected] = React.useState<string[]>(
    compatible.map((device) => device.id)
  )
  const [args, setArgs] = React.useState<string[]>(
    module.argumentsSchema.map(() => "")
  )
  const [confirm, setConfirm] = React.useState(false)
  const run = useMutation({
    mutationFn: () => {
      let last = args.length - 1
      while (last >= 0 && !args[last]) last -= 1
      return api<{
        commands: Array<{ id: string }>
        skipped: Array<{ deviceId: string; reason: string }>
      }>(`/api/v1/admin/modules/${module.id}/runs`, {
        method: "POST",
        body: JSON.stringify({
          deviceIds: selected,
          args: args.slice(0, last + 1),
        }),
      })
    },
    onSuccess: (data) => {
      trackBulkCommands(data.commands.map((command) => command.id))
      toast.success(
        data.skipped.length
          ? `Queued ${data.commands.length}, skipped ${data.skipped.length}`
          : "Module queued"
      )
      void client.invalidateQueries({ queryKey: ["commands"] })
      onClose()
    },
    onError: (error) => toast.error(error.message),
  })
  return (
    <>
      <Dialog open={!confirm} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Run {module.displayName}</DialogTitle>
            <DialogDescription>
              Runs the exact catalog signature as an agent-owned child process.
              No process selection or injection is available.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel>Compatible granted devices</FieldLabel>
              <div className="max-h-48 overflow-auto rounded-lg border p-2">
                {compatible.map((device) => (
                  <label
                    key={device.id}
                    className="flex items-center gap-2 py-1 text-sm"
                  >
                    <Checkbox
                      checked={selected.includes(device.id)}
                      onCheckedChange={(checked) =>
                        setSelected((current) =>
                          checked
                            ? [...current, device.id]
                            : current.filter((id) => id !== device.id)
                        )
                      }
                    />
                    <span>{device.hostname}</span>
                  </label>
                ))}
              </div>
            </Field>
            {module.argumentsSchema.map((spec, index) => (
              <Field key={spec.name}>
                <FieldLabel htmlFor={`module-arg-${spec.name}`}>
                  {spec.name}
                  {spec.required ? " (required)" : ""}
                </FieldLabel>
                <Input
                  id={`module-arg-${spec.name}`}
                  value={args[index] ?? ""}
                  maxLength={spec.maxLength}
                  onChange={(event) =>
                    setArgs((current) =>
                      current.map((value, item) =>
                        item === index ? event.target.value : value
                      )
                    )
                  }
                />
                <FieldDescription>
                  {spec.type}
                  {spec.choices?.length
                    ? ` · allowed: ${spec.choices.join(", ")}`
                    : ""}
                </FieldDescription>
              </Field>
            ))}
          </FieldGroup>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={() => setConfirm(true)}
              disabled={!selected.length}
            >
              Review run
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm module execution</AlertDialogTitle>
            <AlertDialogDescription>
              Queue {module.displayName} v{module.version} on {selected.length}{" "}
              device(s)? The agent re-verifies the signature, hash, target,
              argument schema, timeout, and output bound before execution.
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
              Run approved module
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
