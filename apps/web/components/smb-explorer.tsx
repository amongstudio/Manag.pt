"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { FolderIcon, FileIcon } from "lucide-react"
import { toast } from "sonner"
import {
  FILE_CHUNK_SIZE,
  MAX_UPLOAD_BYTES,
  WS_EVENTS,
  parseSmbDir,
  parseSmbShares,
  queuedCommandId,
  resultPayloadError,
  shareBrowsePath,
  smbConnectConfirm,
  smbDisconnectConfirm,
  smbFailureMessage,
  smbJoinPath,
  smbParentPath,
  smbPathCrumbs,
  normalizeShareBrowse,
  transferRemainingBytes,
  type SmbEntry,
  type SmbShare,
} from "@workspace/shared"

import { api, applyOperatorAuth, formatBytes, formatWhen } from "@/lib/api"
import { pollAdminCommand } from "@/lib/command-poll"
import { encodeChunkPlain, encryptBytes, type E2ESession } from "@/lib/e2e"
import { useSocket } from "@/components/providers"
import { QueryErrorBanner, QueryErrorState } from "@/components/query-error"
import { type TransferRow } from "@/components/file-explorer"
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
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

type CommandSeed = { id: string; type: string; status: string; result?: unknown }

type FilePreviewResult = {
  path?: string
  kind?: "text" | "image" | "unsupported" | string
  mime?: string
  encoding?: string
  truncated?: boolean
  content?: string
  text?: string
  data?: string
}

type ConnectForm = { unc: string; username: string; password: string; drive: string; persist: boolean }

const emptyConnect = (): ConnectForm => ({ unc: "", username: "", password: "", drive: "", persist: false })

export function SmbExplorer({
  deviceId,
  commands,
  online = false,
  latestSuccessful,
  transfers = [],
  e2e = null,
}: {
  deviceId: string
  commands?: CommandSeed[]
  online?: boolean
  latestSuccessful?: CommandSeed | null
  transfers?: TransferRow[]
  e2e?: E2ESession | null
}) {
  const client = useQueryClient()
  const socket = useSocket()
  const e2eRef = React.useRef(e2e)
  e2eRef.current = e2e
  const uploadInputRef = React.useRef<HTMLInputElement>(null)
  const pathRef = React.useRef("")
  const pendingShareId = React.useRef<string | null>(null)
  const pendingListId = React.useRef<string | null>(null)
  const sharePoll = React.useRef<AbortController | null>(null)
  const listPoll = React.useRef<AbortController | null>(null)

  const [shares, setShares] = React.useState<SmbShare[]>([])
  const [shareTruncated, setShareTruncated] = React.useState(false)
  const [sharesListed, setSharesListed] = React.useState(false)
  const [sharePending, setSharePending] = React.useState(false)
  const [shareError, setShareError] = React.useState<string | null>(null)

  const [path, setPath] = React.useState("")
  const [pathDraft, setPathDraft] = React.useState("")
  const [entries, setEntries] = React.useState<SmbEntry[]>([])
  const [dirTruncated, setDirTruncated] = React.useState(false)
  const [listed, setListed] = React.useState(false)
  const [listPending, setListPending] = React.useState(false)
  const [listError, setListError] = React.useState<string | null>(null)
  const [filter, setFilter] = React.useState("")

  const [connectOpen, setConnectOpen] = React.useState(false)
  const [connectForm, setConnectForm] = React.useState<ConnectForm>(emptyConnect)
  const [connectConfirm, setConnectConfirm] = React.useState(false)
  const [writePending, setWritePending] = React.useState(false)
  const [disconnectTarget, setDisconnectTarget] = React.useState<string | null>(null)
  const [preview, setPreview] = React.useState<{ title: string; text?: string; src?: string; truncated?: boolean } | null>(null)
  const previewUrl = React.useRef<string | null>(null)

  const metaQuery = useQuery({
    queryKey: ["admin-meta"],
    queryFn: () => api<{ maxUploadBytes?: number }>("/api/v1/admin/meta"),
    staleTime: 60_000,
  })
  const cap = metaQuery.data?.maxUploadBytes ?? MAX_UPLOAD_BYTES
  pathRef.current = path

  async function queue(type: string, payload: Record<string, unknown>) {
    return api<{ commands: { id: string }[] }>("/api/v1/admin/commands", {
      method: "POST",
      body: JSON.stringify({ deviceIds: [deviceId], type, payload }),
    })
  }

  const stopShareWatch = React.useCallback(() => {
    sharePoll.current?.abort()
    sharePoll.current = null
    pendingShareId.current = null
    setSharePending(false)
  }, [])

  const stopListWatch = React.useCallback(() => {
    listPoll.current?.abort()
    listPoll.current = null
    pendingListId.current = null
    setListPending(false)
  }, [])

  function applyShares(result: unknown) {
    const parsed = parseSmbShares(result)
    setShares(parsed.shares)
    setShareTruncated(parsed.truncated)
    setSharesListed(true)
    setShareError(null)
  }

  function applyDir(result: unknown) {
    const parsed = parseSmbDir(result)
    setPath(parsed.path || pathRef.current)
    setPathDraft(parsed.path || pathRef.current)
    setEntries(parsed.entries)
    setDirTruncated(parsed.truncated)
    setListed(true)
    setListError(null)
  }

  const startShareWatch = React.useCallback(
    (commandId: string) => {
      sharePoll.current?.abort()
      pendingShareId.current = commandId
      setShareError(null)
      setSharePending(true)
      const ac = new AbortController()
      sharePoll.current = ac
      void (async () => {
        const outcome = await pollAdminCommand(commandId, { signal: ac.signal, timeoutMs: 90_000 })
        if (ac.signal.aborted || pendingShareId.current !== commandId) return
        if (outcome.kind === "timeout") {
          setShareError(online ? "Timed out waiting for get_smb." : "agent_offline")
          pendingShareId.current = null
          setSharePending(false)
          return
        }
        if (outcome.kind === "error") {
          if (outcome.message === "aborted") return
          setShareError(outcome.message)
          pendingShareId.current = null
          setSharePending(false)
          return
        }
        const cmd = outcome.command
        const payloadErr = resultPayloadError(cmd.result)
        if (cmd.status === "success" && !payloadErr) {
          applyShares(cmd.result)
        } else {
          setShareError(smbFailureMessage(cmd.result, cmd.status, "Could not list SMB shares"))
        }
        pendingShareId.current = null
        setSharePending(false)
      })()
    },
    [online]
  )

  const startListWatch = React.useCallback((commandId: string) => {
    listPoll.current?.abort()
    pendingListId.current = commandId
    setListError(null)
    setListPending(true)
    const ac = new AbortController()
    listPoll.current = ac
    void (async () => {
      const outcome = await pollAdminCommand(commandId, { signal: ac.signal, timeoutMs: 90_000 })
      if (ac.signal.aborted || pendingListId.current !== commandId) return
      if (outcome.kind === "timeout") {
        setListError("Listing timed out. The agent did not return smb_list in time.")
        pendingListId.current = null
        setListPending(false)
        return
      }
      if (outcome.kind === "error") {
        if (outcome.message === "aborted") return
        setListError(outcome.message)
        pendingListId.current = null
        setListPending(false)
        return
      }
      const cmd = outcome.command
      const payloadErr = resultPayloadError(cmd.result)
      if (cmd.status === "success" && !payloadErr) {
        applyDir(cmd.result)
      } else {
        setListError(smbFailureMessage(cmd.result, cmd.status, "Could not list this share"))
      }
      pendingListId.current = null
      setListPending(false)
    })()
  }, [])

  async function requestShares() {
    const data = await queue("get_smb", {})
    const id = queuedCommandId(data)
    if (!id) throw new Error("command not queued")
    startShareWatch(id)
  }

  async function requestList(nextPath: string) {
    const trimmed = normalizeShareBrowse(nextPath)
    if (!trimmed) throw new Error("Enter a UNC path or mapped drive")
    setPath(trimmed)
    setPathDraft(trimmed)
    const data = await queue("smb_list", { path: trimmed })
    const id = queuedCommandId(data)
    if (!id) throw new Error("command not queued")
    startListWatch(id)
  }

  const seeded = React.useRef<string | null>(null)
  const autoQueued = React.useRef(false)
  const requestSharesRef = React.useRef(requestShares)
  requestSharesRef.current = requestShares

  React.useEffect(() => {
    seeded.current = null
    autoQueued.current = false
    stopShareWatch()
    stopListWatch()
    setPath("")
    setPathDraft("")
    setEntries([])
    setListed(false)
    setSharesListed(false)
  }, [deviceId, stopListWatch, stopShareWatch])

  React.useEffect(() => {
    if (seeded.current === deviceId) {
      if (online && !autoQueued.current && !pendingShareId.current) {
        autoQueued.current = true
        void requestSharesRef.current().catch((e) => toast.error(e instanceof Error ? e.message : "Refresh failed"))
      }
      return
    }
    seeded.current = deviceId
    autoQueued.current = false
    const success =
      latestSuccessful?.status === "success"
        ? latestSuccessful
        : commands?.find((c) => c.type === "get_smb" && c.status === "success")
    if (success) applyShares(success.result)
    if (online) {
      autoQueued.current = true
      void requestSharesRef.current().catch((e) => toast.error(e instanceof Error ? e.message : "Refresh failed"))
    }
  }, [commands, deviceId, latestSuccessful, online])

  React.useEffect(() => {
    if (!socket) return
    const onResult = (payload: unknown) => {
      if (!payload || typeof payload !== "object") return
      const rec = payload as { id?: string; deviceId?: string; type?: string; status?: string; result?: unknown }
      if (rec.deviceId !== deviceId) return
      if (rec.type === "get_smb") {
        if (rec.status === "success" && (rec.id === pendingShareId.current || !pendingShareId.current) && !resultPayloadError(rec.result)) {
          applyShares(rec.result)
          stopShareWatch()
          void client.invalidateQueries({ queryKey: ["device", deviceId] })
        } else if ((rec.status === "failed" || rec.status === "cancelled") && rec.id === pendingShareId.current) {
          setShareError(smbFailureMessage(rec.result, rec.status, "Could not list SMB shares"))
          stopShareWatch()
        }
        return
      }
      if (rec.type === "smb_list") {
        if (rec.status === "success" && rec.id === pendingListId.current && !resultPayloadError(rec.result)) {
          applyDir(rec.result)
          stopListWatch()
        } else if ((rec.status === "failed" || rec.status === "cancelled") && rec.id === pendingListId.current) {
          setListError(smbFailureMessage(rec.result, rec.status, "Could not list this share"))
          stopListWatch()
        }
        return
      }
      if (rec.status !== "success") {
        if (
          (rec.type === "smb_connect" ||
            rec.type === "smb_disconnect" ||
            rec.type === "preview_file" ||
            rec.type === "upload_file" ||
            rec.type === "download_file") &&
          rec.id
        ) {
          toast.error(smbFailureMessage(rec.result, rec.status))
        }
        return
      }
      if (rec.type === "preview_file") {
        showPreview(rec.result)
      }
    }
    socket.on(WS_EVENTS.COMMAND_RESULT, onResult)
    return () => {
      socket.off(WS_EVENTS.COMMAND_RESULT, onResult)
    }
  }, [client, deviceId, socket, stopListWatch, stopShareWatch])

  const fileOp = useMutation({
    mutationFn: async (input: { type: string; payload: Record<string, unknown> }) => {
      const data = await queue(input.type, input.payload)
      return { ...input, id: queuedCommandId(data) }
    },
    onSuccess: (res) => {
      toast.success(`${res.type.replaceAll("_", " ")} queued`)
    },
    onError: (e) => toast.error(e.message),
  })

  async function runConnect() {
    const unc = connectForm.unc.trim()
    setConnectConfirm(false)
    setConnectOpen(false)
    if (!unc || !online) return
    setWritePending(true)
    try {
      const payload: Record<string, unknown> = { unc, persist: connectForm.persist }
      if (connectForm.username.trim()) payload.username = connectForm.username.trim()
      if (connectForm.password) payload.password = connectForm.password
      if (connectForm.drive.trim()) payload.drive = connectForm.drive.trim()
      const data = await queue("smb_connect", payload)
      const id = queuedCommandId(data)
      if (!id) throw new Error("command not queued")
      const ac = new AbortController()
      const outcome = await pollAdminCommand(id, { signal: ac.signal, timeoutMs: 90_000 })
      if (outcome.kind === "timeout") {
        toast.error(online ? "timeout" : "agent_offline")
      } else if (outcome.kind === "error") {
        toast.error(outcome.message)
      } else if (outcome.command.status !== "success") {
        toast.error(smbFailureMessage(outcome.command.result, outcome.command.status, "Connect failed"))
      } else {
        toast.success("Share connected")
        setConnectForm(emptyConnect())
        await requestShares()
        await requestList(unc)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Connect failed")
    } finally {
      setWritePending(false)
    }
  }

  async function runDisconnect() {
    const target = disconnectTarget
    setDisconnectTarget(null)
    if (!target || !online) return
    setWritePending(true)
    try {
      const payload = /^[A-Za-z]:?$/.test(target.replace(":", "")) ? { drive: target.replace(":", "") } : { unc: target }
      const data = await queue("smb_disconnect", payload)
      const id = queuedCommandId(data)
      if (!id) throw new Error("command not queued")
      const ac = new AbortController()
      const outcome = await pollAdminCommand(id, { signal: ac.signal, timeoutMs: 90_000 })
      if (outcome.kind === "timeout") {
        toast.error(online ? "timeout" : "agent_offline")
      } else if (outcome.kind === "error") {
        toast.error(outcome.message)
      } else if (outcome.command.status !== "success") {
        toast.error(smbFailureMessage(outcome.command.result, outcome.command.status, "Disconnect failed"))
      } else {
        toast.success("Share disconnected")
        if (path.toLowerCase().startsWith(target.toLowerCase().replace(/\\+$/, ""))) {
          setListed(false)
          setEntries([])
          setPath("")
          setPathDraft("")
        }
        await requestShares()
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Disconnect failed")
    } finally {
      setWritePending(false)
    }
  }

  async function uploadOne(file: File, destDir: string) {
    if (file.size > cap) {
      toast.error(`${file.name} exceeds the ${formatBytes(cap)} upload cap`)
      return
    }
    const dest = smbJoinPath(destDir, file.name)
    const session = e2eRef.current
    const sock = socket
    if (session && sock) {
      const chunkSize = FILE_CHUNK_SIZE
      const transferId = crypto.randomUUID()
      for (let offset = 0; offset < file.size; offset += chunkSize) {
        const end = Math.min(file.size, offset + chunkSize)
        const slice = new Uint8Array(await file.slice(offset, end).arrayBuffer())
        const header = {
          transferId,
          offset,
          length: slice.length,
          totalSize: file.size,
          final: end >= file.size,
          direction: "download",
          action: "data",
          remotePath: dest,
        }
        const plain = encodeChunkPlain(header, slice)
        const { nonce, ciphertext } = await encryptBytes(session.key, plain)
        sock.emit(WS_EVENTS.E2E_ENVELOPE, {
          deviceId,
          payload: { action: "data", sessionId: session.sessionId, kind: "file_chunk", nonce, ciphertext },
        })
      }
      toast.success(`Encrypted chunks sent: ${file.name}`)
      return
    }
    const body = new FormData()
    body.append("file", file)
    body.append("dest", dest)
    const headers = new Headers()
    applyOperatorAuth(headers)
    const res = await fetch(`/api/v1/admin/devices/${deviceId}/files`, { method: "POST", body, credentials: "include", headers })
    if (!res.ok) {
      let message = `upload failed (${res.status})`
      try {
        const parsed = (await res.json()) as { error?: string }
        if (parsed.error) message = parsed.error
      } catch {
        /* ignore */
      }
      throw new Error(message)
    }
    const staged = (await res.json()) as { file: { id: string } }
    await queue("download_file", { fileId: staged.file.id, dest })
    toast.success(`Staged ${file.name}`)
  }

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      if (!path) throw new Error("Open a share folder first")
      for (const file of files) await uploadOne(file, path)
    },
    onError: (e) => toast.error(e.message),
    onSettled: () => {
      if (uploadInputRef.current) uploadInputRef.current.value = ""
    },
  })

  function showPreview(result: unknown) {
    if (previewUrl.current) {
      URL.revokeObjectURL(previewUrl.current)
      previewUrl.current = null
    }
    if (!result || typeof result !== "object") {
      toast.error("Empty preview")
      return
    }
    const o = result as FilePreviewResult
    const title = o.path || "Preview"
    const body = o.content ?? o.text ?? o.data
    if (o.kind === "unsupported") {
      setPreview({ title, text: "This file is not a text or small-image preview.", truncated: o.truncated })
      return
    }
    if (o.kind === "text" || o.encoding === "utf8" || o.encoding === "text") {
      setPreview({ title, text: typeof body === "string" ? body : "", truncated: o.truncated })
      return
    }
    const b64 = o.kind === "image" || o.encoding === "base64" ? (typeof body === "string" ? body : undefined) : undefined
    const mime = o.mime || "application/octet-stream"
    if (b64 && (o.kind === "image" || mime.startsWith("image/"))) {
      const bin = atob(b64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }))
      previewUrl.current = url
      setPreview({ title, src: url, truncated: o.truncated })
      return
    }
    setPreview({ title, text: typeof body === "string" ? body.slice(0, 8_000) : JSON.stringify(result, null, 2) })
  }

  function go(next: string) {
    void requestList(next).catch((e) => toast.error(e instanceof Error ? e.message : "List failed"))
  }

  const crumbs = smbPathCrumbs(path)
  const parent = smbParentPath(path)
  const visible = React.useMemo(() => {
    const q = filter.trim().toLowerCase()
    const rows = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries.slice()
    rows.sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return rows
  }, [entries, filter])
  const smbTransfers = transfers.filter(
    (f) => f.remotePath.startsWith("\\\\") || /^[A-Za-z]:\\/.test(f.remotePath) || (path && f.remotePath.startsWith(path))
  )

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Hosted shares, mapped drives, and connected sessions on this agent. Browse with smb_list. Connect uses
        WNetAddConnection2. Downloads and uploads use the same file transfer path as Files.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => void requestShares().catch((e) => toast.error(e.message))} disabled={!online || sharePending}>
          {sharePending ? <Spinner className="size-4" /> : null}
          Refresh shares
        </Button>
        <Button size="sm" onClick={() => setConnectOpen(true)} disabled={!online || writePending}>
          Connect UNC
        </Button>
        {shareTruncated ? <Badge variant="secondary">Truncated</Badge> : null}
      </div>
      {shareError && sharesListed ? <QueryErrorBanner cached error={shareError} onRetry={() => void requestShares()} /> : null}
      {shareError && !sharesListed ? <QueryErrorState title="Could not list SMB shares" error={shareError} onRetry={() => void requestShares()} /> : null}
      {!sharesListed && sharePending ? <p className="text-sm text-muted-foreground">Waiting for agent…</p> : null}
      {!sharesListed && !sharePending && !shareError ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No snapshot yet</EmptyTitle>
            <EmptyDescription>Refresh to queue get_smb.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {sharesListed ? (
        shares.length === 0 ? (
          <p className="text-sm text-muted-foreground">No hosted or mapped shares. Connect a UNC path to browse.</p>
        ) : (
          <div className="overflow-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Path</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {shares.map((share, i) => {
                  const browse = shareBrowsePath(share)
                  const disconnectKey = share.drive || share.remote || share.path
                  return (
                    <TableRow key={`${share.kind}-${share.path}-${share.drive}-${i}`}>
                      <TableCell className="min-w-0 max-w-[10rem] truncate font-medium" title={share.name || browse}>
                        {share.name || browse}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{share.kind}</Badge>
                      </TableCell>
                      <TableCell className="max-w-[24rem] truncate font-mono text-xs" title={browse}>
                        {browse}
                        {share.username ? <span className="ml-2 text-muted-foreground">{share.username}</span> : null}
                      </TableCell>
                      <TableCell>
                        {share.connected ? <Badge>Connected</Badge> : <Badge variant="outline">{share.status || "offline"}</Badge>}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="ghost" disabled={!online || !browse} onClick={() => go(browse)}>
                            Browse
                          </Button>
                          {share.kind !== "hosted" && disconnectKey ? (
                            <Button size="sm" variant="ghost" disabled={!online || writePending} onClick={() => setDisconnectTarget(disconnectKey)}>
                              Disconnect
                            </Button>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )
      ) : null}

      <div className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <Field className="min-w-[16rem] flex-1">
            <FieldLabel htmlFor="smb-path">Path</FieldLabel>
            <Input
              id="smb-path"
              value={pathDraft}
              placeholder="\\server\share or Z:\"
              onChange={(e) => setPathDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") go(pathDraft)
              }}
            />
          </Field>
          <Button size="sm" onClick={() => go(pathDraft)} disabled={!online || listPending || !pathDraft.trim()}>
            {listPending ? <Spinner className="size-4" /> : null}
            Go
          </Button>
          <Button size="sm" variant="outline" onClick={() => go(parent)} disabled={!online || !parent}>
            Up
          </Button>
          <Button size="sm" variant="outline" disabled={!online || !path || upload.isPending} onClick={() => uploadInputRef.current?.click()}>
            Upload
          </Button>
          <input
            ref={uploadInputRef}
            type="file"
            className="hidden"
            multiple
            onChange={(e) => {
              const files = [...(e.target.files ?? [])]
              if (files.length) upload.mutate(files)
            }}
          />
        </div>
        {crumbs.length ? (
          <div className="flex flex-wrap items-center gap-1 text-sm">
            <button type="button" className="text-muted-foreground hover:underline" onClick={() => { setListed(false); setPath(""); setPathDraft(""); setEntries([]) }}>
              Shares
            </button>
            {crumbs.map((c) => (
              <React.Fragment key={c.path}>
                <span className="text-muted-foreground">/</span>
                <button type="button" className="max-w-[10rem] truncate hover:underline" title={c.label} onClick={() => go(c.path)}>
                  {c.label}
                </button>
              </React.Fragment>
            ))}
          </div>
        ) : null}
        {listed ? (
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter this folder" className="max-w-sm" />
        ) : null}
        {dirTruncated ? <Badge variant="secondary">Truncated</Badge> : null}
        {listError && listed ? <QueryErrorBanner cached error={listError} onRetry={() => go(path)} /> : null}
        {listError && !listed ? <QueryErrorState title="Share listing failed" error={listError} onRetry={() => go(pathDraft || path)} /> : null}
        {listPending && !listed ? <p className="text-sm text-muted-foreground">Waiting for agent…</p> : null}
        {listed && visible.length === 0 && !listPending ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FolderIcon />
              </EmptyMedia>
              <EmptyTitle>Empty folder</EmptyTitle>
              <EmptyDescription>No entries in this listing.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
        {listed && visible.length ? (
          <div className="overflow-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Modified</TableHead>
                  <TableHead className="w-[1%] whitespace-nowrap" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((entry) => (
                  <TableRow key={entry.path}>
                    <TableCell className="min-w-0 max-w-[20rem]">
                      <button
                        type="button"
                        className="inline-flex min-w-0 max-w-full items-center gap-2 text-left hover:underline"
                        title={entry.name}
                        onClick={() => (entry.dir ? go(entry.path) : fileOp.mutate({ type: "preview_file", payload: { path: entry.path } }))}
                      >
                        {entry.dir ? <FolderIcon className="size-4 shrink-0" /> : <FileIcon className="size-4 shrink-0" />}
                        <span className="truncate">{entry.name}</span>
                      </button>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{entry.dir ? "—" : formatBytes(entry.size ?? 0)}</TableCell>
                    <TableCell className="text-muted-foreground">{entry.mtime ? formatWhen(entry.mtime) : "—"}</TableCell>
                    <TableCell className="w-[1%] whitespace-nowrap text-right">
                      {entry.dir ? (
                        <Button size="sm" variant="ghost" onClick={() => go(entry.path)}>
                          Open
                        </Button>
                      ) : (
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="ghost" onClick={() => fileOp.mutate({ type: "preview_file", payload: { path: entry.path } })}>
                            Preview
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => fileOp.mutate({ type: "upload_file", payload: { path: entry.path } })}>
                            Download
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}
        {!listed && !listPending && !listError ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Open a share</EmptyTitle>
              <EmptyDescription>Browse a hosted or mapped share, or Go to a UNC path. Connect first if the agent needs credentials.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" disabled={!online} onClick={() => setConnectOpen(true)}>
                Connect UNC
              </Button>
            </EmptyContent>
          </Empty>
        ) : null}
      </div>

      {smbTransfers.length ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">Transfers</p>
          {smbTransfers.slice(0, 8).map((f) => {
            const remaining = transferRemainingBytes(f.offset, f.size)
            return (
              <div key={f.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={f.remotePath}>
                  {f.remotePath}
                </span>
                <span className="text-xs text-muted-foreground">
                  {f.status} · {formatBytes(f.offset ?? 0)} / {formatBytes(f.size)}
                  {remaining ? ` · ${formatBytes(remaining)} left` : ""}
                </span>
                {f.status !== "transferring" && f.direction === "upload" ? (
                  <Button size="sm" variant="outline" render={<a href={`/api/v1/admin/files/${f.id}/download`} download />} nativeButton={false}>
                    Download
                  </Button>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}

      <Dialog open={connectOpen} onOpenChange={(open) => { setConnectOpen(open); if (!open) setConnectConfirm(false) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect UNC</DialogTitle>
            <DialogDescription>Optional credentials are passed to WNetAddConnection2 on the agent. Drive letter is optional.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="smb-unc">UNC</FieldLabel>
              <Input id="smb-unc" value={connectForm.unc} placeholder="\\server\share" onChange={(e) => setConnectForm((c) => ({ ...c, unc: e.target.value }))} />
            </Field>
            <Field>
              <FieldLabel htmlFor="smb-user">Username</FieldLabel>
              <Input id="smb-user" value={connectForm.username} onChange={(e) => setConnectForm((c) => ({ ...c, username: e.target.value }))} />
            </Field>
            <Field>
              <FieldLabel htmlFor="smb-pass">Password</FieldLabel>
              <Input id="smb-pass" type="password" value={connectForm.password} onChange={(e) => setConnectForm((c) => ({ ...c, password: e.target.value }))} />
              <FieldDescription>Used only for this connect command on the device.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="smb-drive">Drive letter</FieldLabel>
              <Input id="smb-drive" maxLength={2} value={connectForm.drive} placeholder="Z" onChange={(e) => setConnectForm((c) => ({ ...c, drive: e.target.value }))} />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={connectForm.persist} onCheckedChange={(on) => setConnectForm((c) => ({ ...c, persist: on }))} />
              Persist mapping
            </label>
          </FieldGroup>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConnectOpen(false)}>
              Cancel
            </Button>
            <Button disabled={!connectForm.unc.trim() || !online} onClick={() => setConnectConfirm(true)}>
              Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={connectConfirm} onOpenChange={(open) => !open && setConnectConfirm(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Connect this share?</AlertDialogTitle>
            <AlertDialogDescription>{smbConnectConfirm(connectForm.unc.trim() || "this UNC")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void runConnect()}>Confirm</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!disconnectTarget} onOpenChange={(open) => !open && setDisconnectTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect mapping?</AlertDialogTitle>
            <AlertDialogDescription>{disconnectTarget ? smbDisconnectConfirm(disconnectTarget) : ""}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void runDisconnect()}>Confirm</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!preview} onOpenChange={(open) => { if (!open) setPreview(null) }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{preview?.title}</DialogTitle>
            {preview?.truncated ? <DialogDescription>Truncated preview.</DialogDescription> : null}
          </DialogHeader>
          {preview?.src ? <img src={preview.src} alt="" className="max-h-[70vh] w-full object-contain" /> : null}
          {preview?.text != null ? <pre className="max-h-[70vh] overflow-auto rounded-md bg-muted p-3 text-xs">{preview.text}</pre> : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}
