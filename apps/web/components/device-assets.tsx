"use client"

import * as React from "react"
import Link from "next/link"
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  LOCAL_PASSWORD_MAX,
  LOCAL_PASSWORD_MIN,
  localUserActionConfirm,
  parseLocalUsersResult,
  softwareInstallConfirm,
  softwareUninstallConfirm,
  validateCommandPayload,
  type CommandType,
  type LocalUserAction,
} from "@workspace/shared"

import { MetricsTable } from "@/components/alerts-page"
import { api, formatBytes, formatWhen } from "@/lib/api"
import { runDeviceCommand } from "@/lib/command-poll"
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
import { Input } from "@workspace/ui/components/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@workspace/ui/components/select"
import { Spinner } from "@workspace/ui/components/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table"

type Inventory = {
  hardware: { manufacturer: string; model: string; serial: string; chassis: string; collectedAt: string } | null
  os: { name: string; version: string; build: string; arch: string; collectedAt: string } | null
  cpus: Array<{ id: string; name: string; cores: number; threads: number }>
  memory: Array<{ id: string; bank: string; sizeBytes: string; manufacturer: string; serial: string }>
  disks: Array<{ id: string; name: string; model: string; serial: string; sizeBytes: string }>
  volumes: Array<{ id: string; mount: string; fs: string; sizeBytes: string; freeBytes: string }>
  software: Array<{ id: string; name: string; version: string; publisher: string; collectedAt: string }>
  users: Array<{ id: string; name: string; sid: string; local: boolean; disabled: boolean; collectedAt: string }>
  services: Array<{ id: string; name: string; state: string; startType: string }>
}

function useInventory(deviceId: string) {
  return useQuery({
    queryKey: ["inventory", deviceId],
    queryFn: () => api<Inventory>(`/api/v1/admin/devices/${deviceId}/inventory`),
  })
}

function StatusRow({ query, colSpan, empty }: { query: UseQueryResult<Inventory>; colSpan: number; empty: string }) {
  const text = query.isPending ? "Loading…" : query.isError ? `Could not load inventory: ${query.error.message}` : empty
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="text-muted-foreground">
        {text}
      </TableCell>
    </TableRow>
  )
}

export function DeviceMetrics({ deviceId }: { deviceId: string }) {
  return <MetricsTable deviceId={deviceId} />
}

export function DeviceHardware({ deviceId }: { deviceId: string }) {
  const queryClient = useQueryClient()
  const inventory = useInventory(deviceId)
  const refresh = useMutation({
    mutationFn: () => api(`/api/v1/admin/devices/${deviceId}/inventory/refresh`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Inventory refresh queued")
      void queryClient.invalidateQueries({ queryKey: ["inventory", deviceId] })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const data = inventory.data
  const volumes = data?.volumes ?? []
  return (
    <div className="flex flex-col gap-4">
      <Button size="sm" variant="outline" className="w-fit" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
        Refresh inventory
      </Button>
      <p className="text-sm">
        {data?.hardware
          ? `${data.hardware.manufacturer} ${data.hardware.model} ${data.hardware.serial}`.trim() || "No chassis identity collected."
          : "No hardware row yet."}
      </p>
      <p className="text-sm text-muted-foreground">
        {data?.os ? `${data.os.name} ${data.os.version} ${data.os.arch} · ${formatWhen(data.os.collectedAt)}` : "No operating system snapshot."}
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Volume</TableHead>
            <TableHead>FS</TableHead>
            <TableHead>Free</TableHead>
            <TableHead>Size</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {volumes.length === 0 ? (
            <StatusRow query={inventory} colSpan={4} empty="No volumes reported." />
          ) : (
            volumes.map((row) => (
              <TableRow key={row.id}>
                <TableCell>{row.mount}</TableCell>
                <TableCell>{row.fs}</TableCell>
                <TableCell>{formatBytes(Number(row.freeBytes))}</TableCell>
                <TableCell>{formatBytes(Number(row.sizeBytes))}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  )
}

const LONG_COMMAND_MS = 30 * 60_000

type SoftwareConfirm =
  | { kind: "install"; id: string; version?: string; scope?: "machine" | "user" }
  | { kind: "uninstall"; name: string; version?: string }

function commandPayloadError(type: CommandType, payload: Record<string, unknown>): string | null {
  const checked = validateCommandPayload(type, payload)
  return checked.ok ? null : (checked.error.issues[0]?.message ?? "invalid payload")
}

export function DeviceSoftware({ deviceId, online = false }: { deviceId: string; online?: boolean }) {
  const queryClient = useQueryClient()
  const inventory = useInventory(deviceId)
  const software = inventory.data?.software ?? []
  const [filter, setFilter] = React.useState("")
  const [wingetId, setWingetId] = React.useState("")
  const [version, setVersion] = React.useState("")
  const [scope, setScope] = React.useState<"default" | "machine" | "user">("default")
  const [confirm, setConfirm] = React.useState<SoftwareConfirm | null>(null)
  const abort = React.useRef<AbortController | null>(null)
  React.useEffect(() => () => abort.current?.abort(), [deviceId])

  const run = useMutation({
    mutationFn: async (input: SoftwareConfirm) => {
      const type = input.kind === "install" ? "install_app" : "uninstall_app"
      const payload =
        input.kind === "install"
          ? { id: input.id, ...(input.version ? { version: input.version } : {}), ...(input.scope ? { scope: input.scope } : {}) }
          : { name: input.name, ...(input.version ? { version: input.version } : {}) }
      const invalid = commandPayloadError(type, payload)
      if (invalid) throw new Error(invalid)
      toast.info(input.kind === "install" ? `Installing ${input.id}…` : `Uninstalling ${input.name}…`)
      const ac = new AbortController()
      abort.current = ac
      await runDeviceCommand(deviceId, type, payload, { signal: ac.signal, timeoutMs: LONG_COMMAND_MS })
      return input
    },
    onSuccess: (input) => {
      toast.success(input.kind === "install" ? `${input.id} installed` : `${input.name} uninstalled`)
      void api(`/api/v1/admin/devices/${deviceId}/inventory/refresh`, { method: "POST" })
        .then(() => queryClient.invalidateQueries({ queryKey: ["inventory", deviceId] }))
        .catch(() => undefined)
    },
    onError: (error: Error) => {
      if (error.message !== "aborted") toast.error(error.message)
    },
  })

  const installPayload = {
    id: wingetId.trim(),
    ...(version.trim() ? { version: version.trim() } : {}),
    ...(scope !== "default" ? { scope } : {}),
  }
  const installError = wingetId.trim() ? commandPayloadError("install_app", installPayload) : null
  const q = filter.trim().toLowerCase()
  const rows = software.filter((row) => !q || row.name.toLowerCase().includes(q) || row.publisher.toLowerCase().includes(q))

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 rounded-lg border p-3">
        <p className="text-sm font-medium">Install from winget</p>
        <div className="flex flex-wrap items-end gap-2">
          <Input
            className="max-w-xs"
            placeholder="Package id, e.g. Git.Git"
            value={wingetId}
            onChange={(e) => setWingetId(e.target.value)}
            aria-invalid={Boolean(installError)}
          />
          <Input className="w-36" placeholder="Version (optional)" value={version} onChange={(e) => setVersion(e.target.value)} />
          <Select
            items={[
              { value: "default", label: "Default scope" },
              { value: "machine", label: "Machine" },
              { value: "user", label: "User" },
            ]}
            value={scope}
            onValueChange={(value) => setScope(value as "default" | "machine" | "user")}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="default">Default scope</SelectItem>
                <SelectItem value="machine">Machine</SelectItem>
                <SelectItem value="user">User</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button
            size="sm"
            disabled={!online || !wingetId.trim() || Boolean(installError) || run.isPending}
            onClick={() =>
              setConfirm({
                kind: "install",
                id: installPayload.id,
                version: installPayload.version,
                scope: scope === "default" ? undefined : scope,
              })
            }
          >
            Install
          </Button>
        </div>
        {installError ? <p className="text-xs text-destructive">{installError}</p> : null}
        <p className="text-xs text-muted-foreground">
          Runs <span className="font-mono">winget install --id … --exact --silent</span> from the winget source with an
          argument list, no shell. To run your own installer or tool, register it in the{" "}
          <Link href="/modules" className="underline">
            signed module catalog
          </Link>
          ; uploaded code only runs after signature verification and approval there.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input className="max-w-xs" placeholder="Filter software" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {!online ? <span className="text-xs text-muted-foreground">Device offline: install and uninstall are disabled.</span> : null}
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Version</TableHead>
            <TableHead>Publisher</TableHead>
            <TableHead className="w-28" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <StatusRow query={inventory} colSpan={4} empty={software.length ? "No software matches the filter." : "No installed software reported."} />
          ) : (
            rows.map((row, index) => (
              <TableRow key={`${row.name}-${row.version}-${row.publisher}-${index}`}>
                <TableCell>{row.name}</TableCell>
                <TableCell>{row.version}</TableCell>
                <TableCell>{row.publisher}</TableCell>
                <TableCell>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!online || run.isPending}
                    onClick={() => setConfirm({ kind: "uninstall", name: row.name, version: row.version || undefined })}
                  >
                    Uninstall
                  </Button>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      <AlertDialog open={!!confirm} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.kind === "install" ? "Install package" : "Uninstall software"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === "install"
                ? softwareInstallConfirm(confirm.id)
                : confirm
                  ? softwareUninstallConfirm(confirm.name)
                  : ""}{" "}
              The action is written to the audit log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={confirm?.kind === "uninstall" ? "destructive" : "default"}
              onClick={() => {
                if (confirm) run.mutate(confirm)
                setConfirm(null)
              }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

type UserConfirm = { username: string; action: LocalUserAction }

function yesNo(value: boolean) {
  return value ? "yes" : "no"
}

export function DeviceUsers({
  deviceId,
  platform = "",
  online = false,
}: {
  deviceId: string
  platform?: string
  online?: boolean
}) {
  const inventory = useInventory(deviceId)
  const users = inventory.data?.users ?? []
  const windows = platform.toLowerCase() === "windows"
  const [local, setLocal] = React.useState<ReturnType<typeof parseLocalUsersResult>>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [confirm, setConfirm] = React.useState<UserConfirm | null>(null)
  const [password, setPassword] = React.useState("")
  const [passwordAgain, setPasswordAgain] = React.useState("")
  const abort = React.useRef<AbortController | null>(null)
  React.useEffect(() => () => abort.current?.abort(), [deviceId])

  const load = useMutation({
    mutationFn: async () => {
      const ac = new AbortController()
      abort.current = ac
      const cmd = await runDeviceCommand(deviceId, "get_local_users", {}, { signal: ac.signal, timeoutMs: 120_000 })
      const parsed = parseLocalUsersResult(cmd.result)
      if (!parsed) throw new Error("unexpected result")
      return parsed
    },
    onSuccess: (parsed) => {
      setLocal(parsed)
      setLoadError(null)
    },
    onError: (error: Error) => {
      if (error.message !== "aborted") setLoadError(error.message)
    },
  })

  const act = useMutation({
    mutationFn: async (input: UserConfirm & { password?: string }) => {
      const payload = {
        username: input.username,
        action: input.action,
        ...(input.action === "set_password" ? { password: input.password } : {}),
      }
      const invalid = commandPayloadError("local_user_action", payload)
      if (invalid) throw new Error(invalid)
      const ac = new AbortController()
      abort.current = ac
      await runDeviceCommand(deviceId, "local_user_action", payload, { signal: ac.signal, timeoutMs: 120_000 })
      return input
    },
    onSuccess: (input) => {
      toast.success(
        input.action === "set_password"
          ? `Password changed for ${input.username}`
          : `${input.username} ${input.action === "enable" ? "enabled" : "disabled"}`
      )
      load.mutate()
    },
    onError: (error: Error) => {
      if (error.message !== "aborted") toast.error(error.message)
    },
  })

  function closeConfirm() {
    setConfirm(null)
    setPassword("")
    setPasswordAgain("")
  }

  const passwordProblem =
    confirm?.action !== "set_password"
      ? null
      : password.length < LOCAL_PASSWORD_MIN
        ? `At least ${LOCAL_PASSWORD_MIN} characters.`
        : password.length > LOCAL_PASSWORD_MAX
          ? `At most ${LOCAL_PASSWORD_MAX} characters.`
          : password !== passwordAgain
            ? "Passwords do not match."
            : null

  return (
    <div className="flex flex-col gap-6">
      {windows ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">Local accounts</h3>
            <Button size="sm" variant="outline" onClick={() => load.mutate()} disabled={!online || load.isPending}>
              {load.isPending ? <Spinner data-icon="inline-start" /> : null}
              {local ? "Refresh" : "Load local accounts"}
            </Button>
            {local?.computer ? <span className="text-xs text-muted-foreground">{local.computer}</span> : null}
          </div>
          <p className="text-xs text-muted-foreground">
            Local SAM accounts only; domain accounts and domain controllers are refused. Passwords are never read or shown.
            Enable, disable, and password changes are confirmed and audited, and the last enabled administrator cannot be
            disabled.
          </p>
          {loadError ? <p className="text-sm text-destructive">Could not load local accounts: {loadError}</p> : null}
          {local ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Full name</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Admin</TableHead>
                    <TableHead>Password</TableHead>
                    <TableHead>Last logon</TableHead>
                    <TableHead>Logons</TableHead>
                    <TableHead className="w-64" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {local.users.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="text-muted-foreground">
                        No local accounts returned.
                      </TableCell>
                    </TableRow>
                  ) : (
                    local.users.map((user) => (
                      <TableRow key={user.sid ?? user.name}>
                        <TableCell>
                          <div className="font-medium">{user.name}</div>
                          {user.comment ? (
                            <div className="max-w-48 truncate text-xs text-muted-foreground" title={user.comment}>
                              {user.comment}
                            </div>
                          ) : null}
                        </TableCell>
                        <TableCell>{user.fullName || "—"}</TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            <Badge variant={user.enabled ? "secondary" : "outline"}>{user.enabled ? "Enabled" : "Disabled"}</Badge>
                            {user.lockedOut ? <Badge variant="destructive">Locked out</Badge> : null}
                          </div>
                        </TableCell>
                        <TableCell>{yesNo(user.admin)}</TableCell>
                        <TableCell className="text-xs">
                          {user.passwordExpired
                            ? "Expired"
                            : `${user.passwordAgeDays} d old${user.passwordExpires ? "" : " · never expires"}`}
                          {!user.passwordRequired ? " · not required" : ""}
                        </TableCell>
                        <TableCell className="text-xs">{user.lastLogon ? formatWhen(user.lastLogon) : "Never"}</TableCell>
                        <TableCell>{user.logonCount}</TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!online || act.isPending}
                              onClick={() => setConfirm({ username: user.name, action: user.enabled ? "disable" : "enable" })}
                            >
                              {user.enabled ? "Disable" : "Enable"}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!online || act.isPending}
                              onClick={() => setConfirm({ username: user.name, action: "set_password" })}
                            >
                              Set password
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">Inventory snapshot</h3>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>SID</TableHead>
              <TableHead>Local</TableHead>
              <TableHead>Disabled</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.length === 0 ? (
              <StatusRow query={inventory} colSpan={4} empty="No user accounts reported. Refresh inventory from the Hardware tab." />
            ) : (
              users.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>{row.name}</TableCell>
                  <TableCell className="font-mono text-xs">{row.sid || "—"}</TableCell>
                  <TableCell>{yesNo(row.local)}</TableCell>
                  <TableCell>{yesNo(row.disabled)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <AlertDialog open={!!confirm} onOpenChange={(open) => !open && closeConfirm()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.action === "set_password" ? "Set local password" : confirm?.action === "enable" ? "Enable account" : "Disable account"}
            </AlertDialogTitle>
            <AlertDialogDescription>{confirm ? localUserActionConfirm(confirm.action, confirm.username) : ""}</AlertDialogDescription>
          </AlertDialogHeader>
          {confirm?.action === "set_password" ? (
            <div className="flex flex-col gap-2">
              <Input
                type="password"
                autoComplete="new-password"
                placeholder="New password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <Input
                type="password"
                autoComplete="new-password"
                placeholder="Repeat new password"
                value={passwordAgain}
                onChange={(e) => setPasswordAgain(e.target.value)}
              />
              {password && passwordProblem ? <p className="text-xs text-destructive">{passwordProblem}</p> : null}
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={confirm?.action === "enable" ? "default" : "destructive"}
              disabled={Boolean(passwordProblem)}
              onClick={() => {
                if (!confirm) return
                act.mutate(confirm.action === "set_password" ? { ...confirm, password } : confirm)
                closeConfirm()
              }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
