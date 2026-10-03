"use client"

import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  WS_EVENTS,
  credentialBackupConfirm,
  credentialBatchRestoreConfirm,
  credentialDeleteConfirm,
  credentialGenerateConfirm,
  credentialRevealConfirm,
  credentialRestoreConfirm,
  credentialVaultDeleteConfirm,
  credentialWriteConfirm,
  parseCredentials,
  queuedCommandId,
  resultErrorMessage,
  type VaultCredential,
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
  EmptyTitle,
} from "@workspace/ui/components/empty"
import { Field, FieldGroup, FieldLabel } from "@workspace/ui/components/field"
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

type VaultRow = VaultCredential & {
  id?: string
  hasSecret?: boolean
  backedUpAt?: string
  scope?: string
}

const SOURCES = ["all", "windows", "browser", "apps", "generated", "bitlocker"] as const

export function CredentialsManager({
  deviceId,
  platform,
  online = false,
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
  const [agent, setAgent] = React.useState(() => parseCredentials(null))
  const [listed, setListed] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [filter, setFilter] = React.useState("")
  const [source, setSource] = React.useState<(typeof SOURCES)[number]>("all")
  const [confirm, setConfirm] = React.useState<{ title: string; message: string; run: () => Promise<void> } | null>(null)
  const [reveal, setReveal] = React.useState<{ target: string; secret: string } | null>(null)
  const [writeOpen, setWriteOpen] = React.useState(false)
  const [genOpen, setGenOpen] = React.useState(false)
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set())
  const pendingId = React.useRef<string | null>(null)
  const onlineRef = React.useRef(online)
  onlineRef.current = online

  const vaultQuery = useQuery({
    queryKey: ["vault", deviceId],
    queryFn: () => api<{ credentials: VaultRow[] }>(`/api/v1/admin/devices/${deviceId}/credentials`),
    enabled: true,
  })

  const queue = React.useCallback(
    async (type: string, payload: Record<string, unknown>, timeoutMs = 90_000) => {
      setPending(true)
      setError(null)
      try {
        const data = await api<{ commands: { id: string }[] }>("/api/v1/admin/commands", {
          method: "POST",
          body: JSON.stringify({ deviceIds: [deviceId], type, payload }),
        })
        const id = queuedCommandId(data)
        if (!id) throw new Error("command not queued")
        pendingId.current = id
        const ac = new AbortController()
        const outcome = await pollAdminCommand(id, { signal: ac.signal, timeoutMs })
        if (outcome.kind === "timeout") {
          setError(onlineRef.current ? "timeout" : "agent_offline")
          return null
        }
        if (outcome.kind === "error") {
          setError(outcome.message)
          return null
        }
        if (outcome.command.status !== "success") {
          setError(resultErrorMessage(outcome.command.result, outcome.command.status, `${type} failed`))
          if (type === "generate_credential") {
            await client.invalidateQueries({ queryKey: ["vault", deviceId] })
            return outcome.command
          }
          return null
        }
        if (type === "get_credentials" || type === "backup_credentials") {
          setAgent(parseCredentials(outcome.command.result))
          setListed(true)
        }
        await client.invalidateQueries({ queryKey: ["vault", deviceId] })
        await client.invalidateQueries({ queryKey: ["device", deviceId] })
        return outcome.command
      } catch (e) {
        const message = e instanceof Error ? e.message : `${type} failed`
        setError(message)
        toast.error(message)
        return null
      } finally {
        pendingId.current = null
        setPending(false)
      }
    },
    [client, deviceId]
  )

  React.useEffect(() => {
    if (!socket) return
    const onResult = (payload: { deviceId?: string; type?: string; status?: string; result?: unknown }) => {
      if (payload.deviceId !== deviceId) return
      if (payload.type === "get_credentials" && payload.status === "success") {
        setAgent(parseCredentials(payload.result))
        setListed(true)
      }
      if (
        payload.type &&
        ["backup_credentials", "set_credential", "generate_credential", "restore_credentials"].includes(payload.type) &&
        payload.status === "success"
      ) {
        void client.invalidateQueries({ queryKey: ["vault", deviceId] })
      }
    }
    socket.on(WS_EVENTS.COMMAND_RESULT, onResult)
    return () => {
      socket.off(WS_EVENTS.COMMAND_RESULT, onResult)
    }
  }, [client, deviceId, socket])

  const vaultRows = vaultQuery.data?.credentials ?? []
  const vaultByKey = new Map(vaultRows.map((row) => [row.key, row]))
  const merged: VaultRow[] = agent.credentials.map((row) => {
    const vault = vaultByKey.get(row.key)
    return { ...row, id: vault?.id, hasSecret: vault?.hasSecret, backedUpAt: vault?.backedUpAt }
  })
  for (const row of vaultRows) {
    if (!merged.some((item) => item.key === row.key)) merged.push({ ...row, kind: row.kind || "generic" })
  }
  const q = filter.trim().toLowerCase()
  const visible = merged.filter((row) => {
    if (source !== "all" && row.source !== source) return false
    if (!q) return true
    return (
      row.target.toLowerCase().includes(q) ||
      (row.username ?? "").toLowerCase().includes(q) ||
      (row.browser ?? "").toLowerCase().includes(q) ||
      (row.comment ?? "").toLowerCase().includes(q)
    )
  })
  const lastBackup = vaultRows.reduce((latest, row) => {
    if (!row.backedUpAt) return latest
    return !latest || row.backedUpAt > latest ? row.backedUpAt : latest
  }, "")
  const selectedRows = visible.filter((row) => selected.has(row.key))
  const browserSummary = React.useMemo(() => {
    const counts = new Map<string, number>()
    for (const row of agent.credentials) {
      if (row.source !== "browser" || !row.browser) continue
      const label = row.profile ? `${row.browser} (${row.profile})` : row.browser
      counts.set(label, (counts.get(label) ?? 0) + 1)
    }
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [agent.credentials])
  const sessionWarning =
    agent.needsSession ||
    agent.browserLocked ||
    (!agent.sessionOk && (agent.counts.browser > 0 || agent.revealed))
  const restoreable = selectedRows.filter((row) => row.hasSecret && row.id && row.source !== "browser" && row.source !== "bitlocker")
  const unvaultable = selectedRows.filter((row) => row.id)

  function toggleSelect(key: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  async function revealRow(row: VaultRow) {
    if (row.id && row.hasSecret) {
      const data = await api<{ credential: { secret?: string; target: string } }>(
        `/api/v1/admin/devices/${deviceId}/credentials/${row.id}/reveal`,
        { method: "POST", body: JSON.stringify({ scope: row.scope === "fleet" ? "fleet" : "device" }) }
      )
      setReveal({ target: data.credential.target, secret: data.credential.secret || "" })
      return
    }
    toast.message(
      row.source === "browser"
        ? "Not in the vault yet — backing up from the agent (needs a signed-in session for browsers)."
        : "Not in the vault yet — backing up from the agent."
    )
    const cmd = await queue("backup_credentials", { sources: [row.source || "windows"] }, 120_000)
    if (!cmd) return
    const backup = parseCredentials(cmd.result)
    const agentSecret = backup.credentials.find((item) => item.key === row.key)?.secret
    if (agentSecret) {
      setReveal({ target: row.target, secret: agentSecret })
      return
    }
    const refreshed = await api<{ credentials: VaultRow[] }>(`/api/v1/admin/devices/${deviceId}/credentials`)
    const match = refreshed.credentials.find((item) => item.key === row.key)
    if (!match?.id || !match.hasSecret) {
      const hint = backup.needsSession
        ? "Secret was not decrypted. Sign in on the desktop and retry backup."
        : backup.browserLocked
          ? "Browser password could not be decrypted (close the browser or check NSS/DPAPI)."
          : "Secret was not decrypted. Check agent session diagnostics and retry backup."
      toast.error(hint)
      return
    }
    const data = await api<{ credential: { secret?: string; target: string } }>(
      `/api/v1/admin/devices/${deviceId}/credentials/${match.id}/reveal`,
      { method: "POST", body: JSON.stringify({ scope: match.scope === "fleet" ? "fleet" : "device" }) }
    )
    setReveal({ target: data.credential.target, secret: data.credential.secret || "" })
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Windows Credential Manager, app file stores (Git/npm/Docker), and saved logins from Chromium-family
        (Chrome, Edge, Brave, Vivaldi, Opera, etc.) and Firefox-family browsers (all profiles). Secrets are
        AES-256-GCM on the dashboard and stripped from command history and mesh. Writes go to the signed-in
        user store only — never the SYSTEM service store.
      </p>
      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
        <Badge variant="outline">Windows {agent.counts.windows}</Badge>
        <Badge variant="outline">Apps {agent.counts.apps}</Badge>
        <Badge variant="outline">Browser {agent.counts.browser}</Badge>
        <Badge variant="outline">Generated {agent.counts.generated}</Badge>
        {agent.counts.locked ? <Badge variant="secondary">Locked {agent.counts.locked}</Badge> : null}
        <Badge variant="outline">Vault {vaultRows.length}</Badge>
        {vaultRows.some((row) => row.source === "bitlocker") ? (
          <Badge variant="outline">BitLocker keys {vaultRows.filter((row) => row.source === "bitlocker").length}</Badge>
        ) : null}
        {lastBackup ? <span>Last backup {lastBackup}</span> : <span>No vault backup yet</span>}
        {agent.session0 ? <Badge variant="secondary">Session 0</Badge> : null}
        <Badge variant={agent.sessionOk ? "secondary" : "outline"}>
          {agent.sessionOk
            ? agent.sessionUser
              ? `${agent.sessionUser} (session ${agent.sessionId ?? "?"})`
              : "Interactive user"
            : "No signed-in user"}
        </Badge>
        {agent.sessionState ? <Badge variant="outline">{agent.sessionState}</Badge> : null}
        {agent.impersonationOk ? <Badge variant="secondary">Impersonation OK</Badge> : agent.sessionId ? <Badge variant="outline">Impersonation failed</Badge> : null}
        {browserSummary.map(([label, count]) => (
          <Badge key={label} variant="outline" className="max-w-[12rem] truncate" title={label}>
            {label} {count}
          </Badge>
        ))}
      </div>
      {sessionWarning ? (
        <Card>
          <CardContent className="pt-4 text-sm text-muted-foreground">
            {agent.notes.length
              ? agent.notes.join(" ")
              : "No interactive user session. Browser password decryption and user Credential Manager entries need a signed-in desktop. Empty lists here are a session/DPAPI limit, not proof the machine has no secrets."}
          </CardContent>
        </Card>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => void vaultQuery.refetch()}>
          Refresh
        </Button>
        {windows ? (
        <Button
          size="sm"
          variant="outline"
          disabled={!online || pending}
          onClick={() =>
            setConfirm({
              title: "Back up credentials?",
              message: credentialBackupConfirm(),
              run: async () => {
                const cmd = await queue("backup_credentials", { sources: ["windows", "apps"] }, 120_000)
                if (cmd) toast.success("Vault updated")
              },
            })
          }
        >
          Backup to vault
        </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          disabled={!online || pending || vaultRows.every((row) => !row.hasSecret)}
          onClick={() =>
            setConfirm({
              title: "Restore vault to agent?",
              message: credentialRestoreConfirm(vaultRows.filter((row) => row.hasSecret && row.source !== "browser" && row.source !== "bitlocker").length),
              run: async () => {
                const data = await api<{ command: { id: string }; count: number }>(
                  `/api/v1/admin/devices/${deviceId}/credentials/restore`,
                  { method: "POST", body: JSON.stringify({}) }
                )
                const outcome = await pollAdminCommand(data.command.id, {
                  signal: new AbortController().signal,
                  timeoutMs: 120_000,
                })
                if (outcome.kind === "timeout") toast.error("timeout")
                else if (outcome.kind === "error") toast.error(outcome.message)
                else if (outcome.command.status !== "success") {
                  toast.error(resultErrorMessage(outcome.command.result, outcome.command.status, "Restore failed"))
                } else toast.success(`Restored ${data.count}`)
                await client.invalidateQueries({ queryKey: ["vault", deviceId] })
              },
            })
          }
        >
          Restore vault
        </Button>
        <Button size="sm" variant="outline" onClick={() => setWriteOpen(true)}>
          New credential
        </Button>
        {windows ? (
        <Button size="sm" variant="outline" disabled={!online || pending} onClick={() => setGenOpen(true)}>
          Generate
        </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          disabled={!online || pending || restoreable.length === 0}
          onClick={() =>
            setConfirm({
              title: "Restore selected?",
              message: credentialBatchRestoreConfirm(restoreable.length),
              run: async () => {
                const data = await api<{ command: { id: string }; count: number }>(
                  `/api/v1/admin/devices/${deviceId}/credentials/restore`,
                  { method: "POST", body: JSON.stringify({ ids: restoreable.map((row) => row.id) }) }
                )
                const outcome = await pollAdminCommand(data.command.id, {
                  signal: new AbortController().signal,
                  timeoutMs: 120_000,
                })
                if (outcome.kind === "timeout") toast.error("timeout")
                else if (outcome.kind === "error") toast.error(outcome.message)
                else if (outcome.command.status !== "success") {
                  toast.error(resultErrorMessage(outcome.command.result, outcome.command.status, "Restore failed"))
                } else toast.success(`Restored ${data.count}`)
                await client.invalidateQueries({ queryKey: ["vault", deviceId] })
              },
            })
          }
        >
          Restore selected
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending || unvaultable.length === 0}
          onClick={() =>
            setConfirm({
              title: "Unvault selected?",
              message: `Remove ${unvaultable.length} dashboard vault cop${unvaultable.length === 1 ? "y" : "ies"}? Agent stores are left in place.`,
              run: async () => {
                for (const row of unvaultable) {
                  await api(`/api/v1/admin/devices/${deviceId}/credentials/${row.id}`, { method: "DELETE" })
                }
                await client.invalidateQueries({ queryKey: ["vault", deviceId] })
                setSelected(new Set())
                toast.success("Removed from vault")
              },
            })
          }
        >
          Unvault selected
        </Button>
        <Input className="max-w-xs" placeholder="Filter target or user" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="flex flex-wrap gap-1">
        {SOURCES.map((item) => (
          <Button key={item} size="sm" variant={source === item ? "secondary" : "ghost"} onClick={() => setSource(item)}>
            {item}
          </Button>
        ))}
      </div>
      {error && listed ? <QueryErrorBanner cached error={error} onRetry={() => void queue("get_credentials", { sources: ["windows", "browser", "apps"] })} /> : null}
      {error && !listed ? (
        <QueryErrorState title="Credentials failed" error={error} onRetry={() => void queue("get_credentials", { sources: ["windows", "browser", "apps"] })} />
      ) : null}
      {vaultQuery.isError ? (
        <QueryErrorBanner error={vaultQuery.error instanceof Error ? vaultQuery.error.message : "vault"} onRetry={() => void vaultQuery.refetch()} />
      ) : null}
      {!listed && pending ? <p className="text-sm text-muted-foreground">Waiting for agent…</p> : null}
      {!listed && !pending && !error && !vaultRows.length ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No credentials yet</EmptyTitle>
            <EmptyDescription>
              Save a credential in this product vault. The list never includes the secret. Reveal loads it only after you confirm. Fleet credentials stay off this device list unless you mark them fleet and open the fleet view.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {listed || vaultRows.length ? (
        <div className="overflow-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Target</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Vault</TableHead>
                <TableHead className="w-[1%] whitespace-nowrap" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((row) => (
                <TableRow key={row.key}>
                  <TableCell>
                    <Checkbox checked={selected.has(row.key)} onCheckedChange={() => toggleSelect(row.key)} />
                  </TableCell>
                  <TableCell className="min-w-0 max-w-[18rem]">
                    <div className="truncate font-mono text-xs" title={row.target}>
                      {row.target}
                    </div>
                    {row.browser ? (
                      <div
                        className="truncate text-xs text-muted-foreground"
                        title={[row.browser, row.profile, row.locked ? "locked" : ""].filter(Boolean).join(" · ")}
                      >
                        {row.browser}
                        {row.profile ? ` · ${row.profile}` : ""}
                        {row.locked ? " · locked" : ""}
                      </div>
                    ) : null}
                    {row.store === "system" ? (
                      <div className="text-xs text-muted-foreground">SYSTEM store (not written by dashboard restore)</div>
                    ) : null}
                    {row.store === "file" ? <div className="text-xs text-muted-foreground">File store</div> : null}
                    {row.comment ? (
                      <div className="truncate text-xs text-muted-foreground" title={row.comment}>
                        {row.comment}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="max-w-[10rem] truncate" title={row.username || undefined}>
                    {row.username || "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{row.source}</Badge>
                    {row.persist ? <div className="text-xs text-muted-foreground">{row.persist}</div> : null}
                  </TableCell>
                  <TableCell>
                    {row.hasSecret ? <Badge variant="secondary">encrypted</Badge> : <span className="text-muted-foreground">—</span>}
                    {row.backedUpAt ? <div className="text-xs text-muted-foreground">{row.backedUpAt}</div> : null}
                  </TableCell>
                  <TableCell className="w-[1%] space-x-2 whitespace-nowrap">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() =>
                        setConfirm({
                          title: "Reveal secret?",
                          message: credentialRevealConfirm(row.target),
                          run: () => revealRow(row).catch((e) => {
                            toast.error(e instanceof Error ? e.message : "Reveal failed")
                          }),
                        })
                      }
                    >
                      Reveal
                    </Button>
                    {row.id ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending}
                        onClick={() =>
                          setConfirm({
                            title: "Remove vault copy?",
                            message: credentialVaultDeleteConfirm(row.target),
                            run: async () => {
                              await api(`/api/v1/admin/devices/${deviceId}/credentials/${row.id}`, { method: "DELETE" })
                              await client.invalidateQueries({ queryKey: ["vault", deviceId] })
                              toast.success("Removed from vault")
                            },
                          })
                        }
                      >
                        Unvault
                      </Button>
                    ) : null}
                    {row.source !== "browser" && row.source !== "bitlocker" && row.store !== "system" ? (
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={!online || pending}
                        onClick={() =>
                          setConfirm({
                            title: "Delete on agent?",
                            message: credentialDeleteConfirm(row.target),
                            run: async () => {
                              const cmd = await queue("delete_credential", { source: row.source, target: row.target, kind: row.kind })
                              if (cmd) toast.success("Deleted on agent")
                            },
                          })
                        }
                      >
                        Delete
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
      {agent.truncated ? <p className="text-xs text-muted-foreground">List truncated at 400 entries.</p> : null}

      <WriteDialog
        open={writeOpen}
        onOpenChange={setWriteOpen}
        pending={pending}
        onSubmit={(payload) =>
          setConfirm({
            title: "Save credential?",
            message: credentialWriteConfirm(payload.target),
            run: async () => {
              setWriteOpen(false)
              await api(`/api/v1/admin/devices/${deviceId}/credentials`, {
                method: "POST",
                body: JSON.stringify({
                  target: payload.target,
                  username: payload.username,
                  secret: payload.secret,
                  comment: payload.comment,
                  source: "vault",
                  scope: payload.scope,
                }),
              })
              await client.invalidateQueries({ queryKey: ["vault", deviceId] })
              toast.success("Saved in the vault")
            },
          })
        }
      />
      <GenerateDialog
        open={genOpen}
        onOpenChange={setGenOpen}
        pending={pending}
        onSubmit={(payload) =>
          setConfirm({
            title: "Generate password?",
            message: credentialGenerateConfirm(Boolean(payload.save)),
            run: async () => {
              setGenOpen(false)
              const cmd = await queue("generate_credential", payload)
              if (!cmd) return
              if (cmd.status === "success") toast.success("Generated and vaulted")
              else toast.error("Password vaulted; writing to the agent failed (needs a signed-in session)")
              const vaultId = (cmd.result as { vaultId?: string } | null)?.vaultId
              if (vaultId) {
                const data = await api<{ credential: { secret?: string; target: string } }>(
                  `/api/v1/admin/devices/${deviceId}/credentials/${vaultId}/reveal`,
                  { method: "POST", body: "{}" }
                )
                setReveal({ target: data.credential.target, secret: data.credential.secret || "" })
              }
            },
          })
        }
      />

      <AlertDialog open={!!confirm} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirm?.message}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const run = confirm?.run
                setConfirm(null)
                void run?.()
              }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!reveal} onOpenChange={(open) => !open && setReveal(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Secret</DialogTitle>
            <DialogDescription className="truncate" title={reveal?.target}>
              {reveal?.target}. Copied values stay in your clipboard; this dialog is not written to command history.
            </DialogDescription>
          </DialogHeader>
          <Input readOnly value={reveal?.secret ?? ""} onFocus={(e) => e.target.select()} />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                if (reveal?.secret) void navigator.clipboard.writeText(reveal.secret)
                toast.success("Copied")
              }}
            >
              Copy
            </Button>
            <Button onClick={() => setReveal(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function WriteDialog({
  open,
  onOpenChange,
  pending,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  pending: boolean
  onSubmit: (payload: { target: string; username: string; secret: string; source: string; persist: string; comment?: string; scope: "device" | "fleet" }) => void
}) {
  const [target, setTarget] = React.useState("")
  const [username, setUsername] = React.useState("")
  const [secret, setSecret] = React.useState("")
  const [source, setSource] = React.useState("windows")
  const [persist, setPersist] = React.useState("local")
  const [scope, setScope] = React.useState<"device" | "fleet">("device")
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save credential</DialogTitle>
          <DialogDescription>Stores the secret in this product vault with AES-256-GCM. It is not written to Windows Credential Manager, browsers, or Wi-Fi profiles.</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel>Target</FieldLabel>
            <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="Git:https://github.com" />
          </Field>
          <Field>
            <FieldLabel>Username</FieldLabel>
            <Input value={username} onChange={(e) => setUsername(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel>Secret</FieldLabel>
            <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel>Store</FieldLabel>
            <div className="flex gap-2">
              {["windows", "apps", "generated"].map((item) => (
                <Button key={item} size="sm" variant={source === item ? "secondary" : "outline"} type="button" onClick={() => setSource(item)}>
                  {item}
                </Button>
              ))}
            </div>
          </Field>
          <Field>
            <FieldLabel>Persist</FieldLabel>
            <div className="flex gap-2">
              {["local", "session", "enterprise"].map((item) => (
                <Button key={item} size="sm" variant={persist === item ? "secondary" : "outline"} type="button" onClick={() => setPersist(item)}>
                  {item}
                </Button>
              ))}
            </div>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Field>
            <FieldLabel>Scope</FieldLabel>
            <div className="flex gap-2">
              {(["device", "fleet"] as const).map((item) => (
                <Button key={item} size="sm" variant={scope === item ? "secondary" : "outline"} type="button" onClick={() => setScope(item)}>
                  {item}
                </Button>
              ))}
            </div>
          </Field>
          <Button disabled={pending || !target || !secret} onClick={() => onSubmit({ target, username, secret, source, persist, scope })}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function GenerateDialog({
  open,
  onOpenChange,
  pending,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  pending: boolean
  onSubmit: (payload: Record<string, unknown>) => void
}) {
  const [length, setLength] = React.useState("20")
  const [save, setSave] = React.useState(true)
  const [target, setTarget] = React.useState("pcmanager:generated")
  const [username, setUsername] = React.useState("")
  const [upper, setUpper] = React.useState(true)
  const [lower, setLower] = React.useState(true)
  const [digits, setDigits] = React.useState(true)
  const [symbols, setSymbols] = React.useState(true)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Generate password</DialogTitle>
          <DialogDescription>Created on the agent with crypto/rand, then stored encrypted on the dashboard.</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel>Length</FieldLabel>
            <Input value={length} onChange={(e) => setLength(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel>Character classes</FieldLabel>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant={upper ? "secondary" : "outline"} type="button" onClick={() => setUpper((v) => !v)}>
                A-Z
              </Button>
              <Button size="sm" variant={lower ? "secondary" : "outline"} type="button" onClick={() => setLower((v) => !v)}>
                a-z
              </Button>
              <Button size="sm" variant={digits ? "secondary" : "outline"} type="button" onClick={() => setDigits((v) => !v)}>
                2-9
              </Button>
              <Button size="sm" variant={symbols ? "secondary" : "outline"} type="button" onClick={() => setSymbols((v) => !v)}>
                symbols
              </Button>
            </div>
          </Field>
          <Field>
            <FieldLabel>Save to Credential Manager</FieldLabel>
            <Button size="sm" variant={save ? "secondary" : "outline"} type="button" onClick={() => setSave((v) => !v)}>
              {save ? "Yes" : "Vault only"}
            </Button>
          </Field>
          {save ? (
            <>
              <Field>
                <FieldLabel>Target</FieldLabel>
                <Input value={target} onChange={(e) => setTarget(e.target.value)} />
              </Field>
              <Field>
                <FieldLabel>Username</FieldLabel>
                <Input value={username} onChange={(e) => setUsername(e.target.value)} />
              </Field>
            </>
          ) : null}
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={pending || (save && !target) || (!upper && !lower && !digits && !symbols)}
            onClick={() =>
              onSubmit({
                length: Number(length) || 20,
                save,
                target: save ? target : undefined,
                username,
                upper,
                lower,
                digits,
                symbols,
              })
            }
          >
            Generate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
