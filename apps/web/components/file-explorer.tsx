"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useVirtualizer } from "@tanstack/react-virtual"
import { FolderIcon } from "lucide-react"
import { toast } from "sonner"
import {
  FILE_CHUNK_SIZE,
  MAX_UPLOAD_BYTES,
  WS_EVENTS,
  inspectLatestListing,
  isListingCommandType,
  latestSuccessfulListing,
  listingFailureMessage,
  parseFileListResult,
  queuedCommandId,
  transferRemainingBytes,
  type FileListEntry,
  type LanPeer,
  type ListingCommandSeed,
} from "@workspace/shared"

import { api, applyOperatorAuth, formatBytes, formatWhen } from "@/lib/api"
import { pollAdminCommand } from "@/lib/command-poll"
import { encodeChunkPlain, encryptBytes, type E2ESession } from "@/lib/e2e"
import { joinPath, parentPath, pathCrumbs } from "@/lib/file-paths"
import { useSocket } from "@/components/providers"
import { QueryErrorBanner } from "@/components/query-error"
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
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { Progress, ProgressLabel, ProgressValue } from "@workspace/ui/components/progress"
import { Spinner } from "@workspace/ui/components/spinner"
import {
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"

type SortKey = "name" | "size" | "mtime"
type DialogKind = "mkdir" | "rename" | "move" | "copy" | "search"
type CtxMenu = { x: number; y: number; entry: FileListEntry }

export type TransferRow = {
  id: string
  direction: string
  remotePath: string
  size: number
  offset?: number
  status: string
  createdAt: string
}

type FilePreviewResult = {
  path?: string
  kind?: "text" | "image" | "unsupported" | string
  mime?: string
  encoding?: string
  truncated?: boolean
  size?: number
  content?: string
  text?: string
  data?: string
}

type FileProgressEvent = {
  deviceId?: string
  id?: string
  offset?: number
  size?: number
  status?: string
  direction?: string
  remotePath?: string
}

type LocalUpload = {
  id: string
  name: string
  offset: number
  size: number
  status: "uploading" | "done" | "error"
}

type DeviceFilesCache = { files: TransferRow[] }

function isDeviceFilesCache(value: unknown): value is DeviceFilesCache {
  return Boolean(value && typeof value === "object" && Array.isArray((value as DeviceFilesCache).files))
}

function entryMtime(entry: FileListEntry): number {
  if (typeof entry.mtime === "number") return entry.mtime
  if (typeof entry.mtime === "string") {
    const n = Date.parse(entry.mtime)
    return Number.isNaN(n) ? 0 : n
  }
  return 0
}

export function patchDeviceFileProgress(client: ReturnType<typeof useQueryClient>, deviceId: string, rec: FileProgressEvent) {
  const transferId = rec.id
  if (!transferId) return
  client.setQueryData(["device", deviceId], (prev: unknown) => {
    if (!isDeviceFilesCache(prev)) return prev
    const idx = prev.files.findIndex((f) => f.id === transferId)
    if (idx === -1) {
      const row: TransferRow = {
        id: transferId,
        direction: rec.direction ?? "",
        remotePath: rec.remotePath ?? "",
        size: rec.size ?? 0,
        offset: rec.offset ?? 0,
        status: rec.status ?? "transferring",
        createdAt: new Date().toISOString(),
      }
      return { ...prev, files: [row, ...prev.files] }
    }
    const files = prev.files.slice()
    const cur = files[idx]!
    files[idx] = {
      ...cur,
      offset: rec.offset ?? cur.offset,
      size: rec.size ?? cur.size,
      status: rec.status ?? cur.status,
      remotePath: rec.remotePath ?? cur.remotePath,
      direction: rec.direction ?? cur.direction,
    }
    return { ...prev, files }
  })
}

/** Patch FILE_PROGRESS into the device query cache. Call from a always-mounted parent. */
export function useDeviceFileProgress(deviceId: string) {
  const client = useQueryClient()
  const socket = useSocket()
  React.useEffect(() => {
    if (!socket) return
    const onProgress = (payload: unknown) => {
      if (!payload || typeof payload !== "object") return
      const rec = payload as FileProgressEvent
      if (rec.deviceId !== deviceId) return
      patchDeviceFileProgress(client, deviceId, rec)
    }
    socket.on(WS_EVENTS.FILE_PROGRESS, onProgress)
    return () => {
      socket.off(WS_EVENTS.FILE_PROGRESS, onProgress)
    }
  }, [socket, deviceId, client])
}

export function FileExplorer({
  deviceId,
  e2e,
  transfers,
  commands,
  lanPeers = [],
}: {
  deviceId: string
  e2e: E2ESession | null
  transfers: TransferRow[]
  commands?: ListingCommandSeed[]
  lanPeers?: LanPeer[]
}) {
  const client = useQueryClient()
  const socket = useSocket()
  const e2eRef = React.useRef(e2e)
  e2eRef.current = e2e
  const pathRef = React.useRef("")
  const uploadInputRef = React.useRef<HTMLInputElement>(null)
  const pendingIdRef = React.useRef<string | null>(null)
  const pollAbortRef = React.useRef<AbortController | null>(null)
  const seededForDevice = React.useRef<string | null>(null)
  const requestListingRef = React.useRef<(nextPath?: string) => Promise<void>>(async () => {})

  const [path, setPath] = React.useState("")
  const [entries, setEntries] = React.useState<FileListEntry[]>([])
  const [roots, setRoots] = React.useState<string[]>([])
  const [truncated, setTruncated] = React.useState(false)
  const [listed, setListed] = React.useState(false)
  const [listPending, setListPending] = React.useState(false)
  const [listError, setListError] = React.useState<string | null>(null)
  const [filter, setFilter] = React.useState("")
  const [sort, setSort] = React.useState<SortKey>("name")
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [dialog, setDialog] = React.useState<{ kind: DialogKind; target?: FileListEntry } | null>(null)
  const [dialogValue, setDialogValue] = React.useState("")
  const [deleteTargets, setDeleteTargets] = React.useState<FileListEntry[]>([])
  const [ctx, setCtx] = React.useState<CtxMenu | null>(null)
  const [dragOver, setDragOver] = React.useState(false)
  const [localUploads, setLocalUploads] = React.useState<LocalUpload[]>([])
  const [preview, setPreview] = React.useState<{ title: string; text?: string; src?: string; truncated?: boolean } | null>(null)
  const previewUrl = React.useRef<string | null>(null)
  const [peerSend, setPeerSend] = React.useState<{ srcPath: string; name: string } | null>(null)
  const [peerDestId, setPeerDestId] = React.useState("")
  const [peerDestPath, setPeerDestPath] = React.useState("")
  const [peerConfirm, setPeerConfirm] = React.useState(false)

  const metaQuery = useQuery({
    queryKey: ["admin-meta"],
    queryFn: () => api<{ maxUploadBytes?: number }>("/api/v1/admin/meta"),
    staleTime: 60_000,
  })
  const cap = metaQuery.data?.maxUploadBytes ?? MAX_UPLOAD_BYTES
  const capRef = React.useRef(cap)
  capRef.current = cap

  pathRef.current = path

  const stopListWatch = React.useCallback(() => {
    pollAbortRef.current?.abort()
    pollAbortRef.current = null
    pendingIdRef.current = null
    setListPending(false)
  }, [])

  React.useEffect(() => {
    stopListWatch()
    seededForDevice.current = null
    setPath("")
    setEntries([])
    setRoots([])
    setTruncated(false)
    setListed(false)
    setListError(null)
    setFilter("")
    setSelected(new Set())
    setDialog(null)
    setDeleteTargets([])
    setCtx(null)
    setLocalUploads([])
    setPreview(null)
    if (previewUrl.current) {
      URL.revokeObjectURL(previewUrl.current)
      previewUrl.current = null
    }
  }, [deviceId, stopListWatch])

  React.useEffect(() => {
    return () => {
      pollAbortRef.current?.abort()
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current)
    }
  }, [])

  function queue(type: string, payload: Record<string, unknown> = {}) {
    return api<{ commands: { id: string }[] }>("/api/v1/admin/commands", {
      method: "POST",
      body: JSON.stringify({ deviceIds: [deviceId], type, payload }),
    })
  }

  function applyListing(result: unknown, fallbackPath?: string) {
    const parsed = parseFileListResult(result)
    setEntries(parsed.entries)
    setTruncated(parsed.truncated)
    if (parsed.roots.length) setRoots(parsed.roots)
    if (parsed.path != null) setPath(parsed.path === "." ? "" : parsed.path)
    else if (fallbackPath != null) setPath(fallbackPath === "." ? "" : fallbackPath)
    setListed(true)
    setListError(null)
    setSelected(new Set())
  }

  const startListWatch = React.useCallback((commandId: string) => {
    pollAbortRef.current?.abort()
    pendingIdRef.current = commandId
    setListError(null)
    setListPending(true)
    const ac = new AbortController()
    pollAbortRef.current = ac
    void (async () => {
      const outcome = await pollAdminCommand(commandId, { signal: ac.signal })
      if (ac.signal.aborted || pendingIdRef.current !== commandId) return
      if (outcome.kind === "timeout") {
        setListError("Listing timed out. The agent did not return a listing in time.")
        pendingIdRef.current = null
        setListPending(false)
        return
      }
      if (outcome.kind === "error") {
        if (outcome.message === "aborted") return
        setListError(outcome.message)
        pendingIdRef.current = null
        setListPending(false)
        return
      }
      const cmd = outcome.command
      if (cmd.status === "success") {
        applyListing(cmd.result)
        pendingIdRef.current = null
        setListPending(false)
        return
      }
      setListError(listingFailureMessage(cmd.result, cmd.status))
      pendingIdRef.current = null
      setListPending(false)
    })()
  }, [])

  async function requestListing(nextPath?: string) {
    const p = nextPath ?? pathRef.current
    const data = await queue("get_files", listPayload(p))
    const id = queuedCommandId(data)
    if (!id) throw new Error("command not queued")
    startListWatch(id)
  }
  requestListingRef.current = requestListing

  React.useEffect(() => {
    if (seededForDevice.current === deviceId) return
    if (!commands) return
    seededForDevice.current = deviceId
    const success = latestSuccessfulListing(commands)
    if (success) applyListing(success.result)
    const inspect = inspectLatestListing(commands)
    if (inspect.kind === "inflight") {
      startListWatch(inspect.command.id)
    } else if (inspect.kind === "failed") {
      setListError(listingFailureMessage(inspect.command.result, inspect.command.status))
    }
  }, [commands, deviceId, startListWatch])

  React.useEffect(() => {
    if (!socket) return
    const onResult = (payload: unknown) => {
      if (!payload || typeof payload !== "object") return
      const rec = payload as { id?: string; deviceId?: string; type?: string; status?: string; result?: unknown }
      if (rec.deviceId !== deviceId) return
      const type = rec.type ?? ""
      if (isListingCommandType(type)) {
        const pendingId = pendingIdRef.current
        const idMatch = Boolean(pendingId && rec.id === pendingId)
        const parsed = rec.result != null ? parseFileListResult(rec.result) : null
        const want = pathRef.current.trim()
        const got = (parsed?.path ?? "").trim()
        const pathMatch = Boolean(
          pendingId &&
            parsed &&
            parsed.path != null &&
            (got === want || ((got === "." || got === "") && (want === "." || want === "")))
        )
        if (rec.status === "success") {
          if (idMatch || (!rec.id && pathMatch)) {
            applyListing(rec.result)
            stopListWatch()
          }
          return
        }
        if (rec.status === "failed" || rec.status === "cancelled") {
          if (idMatch || (!rec.id && pendingId)) {
            setListError(listingFailureMessage(rec.result, rec.status ?? "failed"))
            stopListWatch()
          }
        }
        return
      }
      if (rec.status !== "success") {
        if (["mkdir", "rename_file", "delete_file", "copy_file", "move_file", "preview_file"].includes(type)) {
          toast.error(listingFailureMessage(rec.result, rec.status ?? "failed"))
        }
        return
      }
      if (type === "preview_file") {
        showPreview(rec.result)
        return
      }
      if (["mkdir", "rename_file", "delete_file", "copy_file", "move_file"].includes(type)) {
        void requestListingRef.current(pathRef.current).catch((error) => {
          toast.error(error instanceof Error ? error.message : "List refresh failed")
        })
      }
    }
    socket.on(WS_EVENTS.COMMAND_RESULT, onResult)
    return () => {
      socket.off(WS_EVENTS.COMMAND_RESULT, onResult)
    }
  }, [socket, deviceId, stopListWatch])

  function listPayload(next: string): Record<string, unknown> {
    const trimmed = next.trim()
    if (!trimmed || trimmed === ".") return {}
    return { path: trimmed }
  }

  const listFiles = useMutation({
    mutationFn: (nextPath?: string) => requestListing(nextPath),
    onError: (e) => toast.error(e.message),
  })

  const fileOp = useMutation({
    mutationFn: async (input: { type: string; payload: Record<string, unknown> }) => {
      const data = await queue(input.type, input.payload)
      return { ...input, id: queuedCommandId(data) }
    },
    onSuccess: (res) => {
      toast.success(`${res.type.replaceAll("_", " ")} queued`)
      setDialog(null)
      setDeleteTargets([])
      if (res.type === "search_files" && res.id) startListWatch(res.id)
    },
    onError: (e) => toast.error(e.message),
  })

  const peerCopy = useMutation({
    mutationFn: async (input: { destDeviceId: string; srcPath: string; destPath: string }) => {
      return api<{ copyId: string }>(`/api/v1/admin/devices/${deviceId}/peer-copy`, {
        method: "POST",
        body: JSON.stringify(input),
      })
    },
    onSuccess: () => {
      toast.success("Peer copy queued")
      setPeerSend(null)
      setPeerConfirm(false)
      void client.invalidateQueries({ queryKey: ["device", deviceId] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  async function uploadOne(file: File, destDir: string) {
    if (file.size > capRef.current) {
      toast.error(`${file.name} exceeds the ${formatBytes(capRef.current)} upload cap`)
      return
    }
    const dest = destDir ? joinPath(destDir, file.name) : file.name
    const localId = crypto.randomUUID()
    setLocalUploads((cur) => [...cur, { id: localId, name: file.name, offset: 0, size: file.size, status: "uploading" }])
    const session = e2eRef.current
    const sock = socket
    try {
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
          setLocalUploads((cur) => cur.map((u) => (u.id === localId ? { ...u, offset: end } : u)))
        }
        setLocalUploads((cur) => cur.map((u) => (u.id === localId ? { ...u, offset: file.size, status: "done" } : u)))
        toast.success(`Encrypted chunks sent: ${file.name}`)
        return
      }
      const body = new FormData()
      body.append("file", file)
      body.append("dest", dest)
      const res = await fetch(`/api/v1/admin/devices/${deviceId}/files`, {
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
      setLocalUploads((cur) => cur.map((u) => (u.id === localId ? { ...u, offset: file.size, status: "done" } : u)))
      toast.success(`Staged ${file.name}`)
    } catch (error) {
      setLocalUploads((cur) => cur.map((u) => (u.id === localId ? { ...u, status: "error" } : u)))
      toast.error(error instanceof Error ? error.message : "Upload failed")
    }
  }

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const file of files) await uploadOne(file, path)
    },
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
    const kind = o.kind
    const body = o.content ?? o.text ?? o.data
    if (kind === "unsupported") {
      setPreview({
        title,
        text: "This file is not a text or small-image preview (sandbox cap).",
        truncated: o.truncated,
      })
      return
    }
    if (kind === "text" || o.encoding === "utf8" || o.encoding === "text") {
      setPreview({ title, text: typeof body === "string" ? body : "", truncated: o.truncated })
      return
    }
    const b64 = kind === "image" || o.encoding === "base64" ? (typeof body === "string" ? body : undefined) : undefined
    const mime = o.mime || "application/octet-stream"
    if (b64 && (kind === "image" || mime.startsWith("image/"))) {
      const bin = atob(b64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const url = URL.createObjectURL(new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)], { type: mime }))
      previewUrl.current = url
      setPreview({ title, src: url, truncated: o.truncated })
      return
    }
    if (typeof body === "string") {
      setPreview({ title, text: body.slice(0, 8_000), truncated: true })
      return
    }
    setPreview({ title, text: JSON.stringify(result, null, 2) })
  }

  function go(next: string) {
    setPath(next)
    listFiles.mutate(next)
  }

  function toggleSelect(p: string) {
    setSelected((cur) => {
      const next = new Set(cur)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })
  }

  const selectedEntries = entries.filter((e) => selected.has(e.path))
  const onlinePeers = React.useMemo(
    () => lanPeers.filter((p) => p.status === "online"),
    [lanPeers]
  )
  const selectedPeer = onlinePeers.find((p) => p.id === peerDestId) ?? onlinePeers[0]

  function openPeerSend(entry: FileListEntry) {
    if (entry.dir) return
    setPeerSend({ srcPath: entry.path, name: entry.name })
    const likely = onlinePeers.find((p) => p.likely) ?? onlinePeers[0]
    setPeerDestId(likely?.id ?? "")
    setPeerDestPath(entry.path)
    setPeerConfirm(false)
    setCtx(null)
  }

  const visible = React.useMemo(() => {
    const q = filter.trim().toLowerCase()
    const rows = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries.slice()
    rows.sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1
      if (sort === "size") return (a.size || 0) - (b.size || 0)
      if (sort === "mtime") return entryMtime(a) - entryMtime(b)
      return a.name.localeCompare(b.name)
    })
    return rows
  }, [entries, filter, sort])

  const [fileScroll, setFileScroll] = React.useState<HTMLDivElement | null>(null)
  const fileVirtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => fileScroll,
    estimateSize: () => 44,
    overscan: 16,
  })
  const fileVirtualItems = fileVirtualizer.getVirtualItems()
  const fileRendered =
    fileVirtualItems.length > 0 ? fileVirtualItems : visible.map((_, index) => ({ index }))
  const filePadTop = fileVirtualItems.length > 0 ? fileVirtualItems[0]!.start : 0
  const filePadBottom =
    fileVirtualItems.length > 0
      ? fileVirtualizer.getTotalSize() - fileVirtualItems[fileVirtualItems.length - 1]!.end
      : 0

  function submitDialog() {
    if (!dialog) return
    if (dialog.kind === "mkdir") {
      fileOp.mutate({ type: "mkdir", payload: { path: joinPath(path, dialogValue) } })
      return
    }
    if (dialog.kind === "search") {
      fileOp.mutate({
        type: "search_files",
        payload: { path: path || ".", name: dialogValue, ext: "", content: "" },
      })
      return
    }
    if (dialog.kind === "move" && selectedEntries.length > 1) {
      for (const entry of selectedEntries) {
        fileOp.mutate({ type: "move_file", payload: { from: entry.path, to: joinPath(dialogValue, entry.name) } })
      }
      setSelected(new Set())
      return
    }
    if (!dialog.target) return
    if (dialog.kind === "rename") {
      fileOp.mutate({
        type: "rename_file",
        payload: { from: dialog.target.path, to: joinPath(path, dialogValue) },
      })
      return
    }
    if (dialog.kind === "copy") {
      fileOp.mutate({
        type: "copy_file",
        payload: { from: dialog.target.path, to: joinPath(dialogValue, dialog.target.name) },
      })
      return
    }
    fileOp.mutate({
      type: "move_file",
      payload: { from: dialog.target.path, to: joinPath(dialogValue, dialog.target.name) },
    })
  }

  function openCtx(entry: FileListEntry, ev: React.MouseEvent) {
    ev.preventDefault()
    setCtx({ x: ev.clientX, y: ev.clientY, entry })
  }

  const transferring = transfers.filter((f) => f.status === "transferring" || f.status === "pending")
  const crumbs = pathCrumbs(path)

  return (
    <Card>
      <CardHeader>
        <CardDescription>
          Live listing from get_files / search_files. Sandboxed paths only. Uploads are capped at{" "}
          {formatBytes(cap)}. Chunked transfers resume within that cap.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-1 text-sm">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setPath("")
              listFiles.mutate("")
            }}
          >
            Home
          </Button>
          {crumbs.map((c) => (
            <React.Fragment key={c.path}>
              <span className="text-muted-foreground">/</span>
              <Button size="sm" variant="ghost" className="max-w-[10rem] truncate" title={c.label} onClick={() => go(c.path)}>
                {c.label}
              </Button>
            </React.Fragment>
          ))}
        </div>
        {roots.length ? (
          <div className="flex flex-wrap gap-1">
            {roots.map((root) => (
              <Badge
                key={root}
                variant="outline"
                className="max-w-[12rem] cursor-pointer truncate"
                title={root}
                render={<button type="button" onClick={() => go(root)} />}
              >
                {root}
              </Badge>
            ))}
          </div>
        ) : null}
        <FieldGroup>
          <Field orientation="horizontal">
            <FieldLabel htmlFor="explorer-path">Path</FieldLabel>
            <Input
              id="explorer-path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="Leave empty for sandbox home"
            />
            <Button onClick={() => listFiles.mutate(path)}>List</Button>
            <Button
              variant="outline"
              onClick={() => {
                setDialog({ kind: "mkdir" })
                setDialogValue("")
              }}
            >
              New folder
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setDialog({ kind: "search" })
                setDialogValue("")
              }}
            >
              Search
            </Button>
          </Field>
          <Field>
            <FieldLabel htmlFor="explorer-upload">
              Upload to current folder{e2e ? " (E2E chunked)" : ""}
            </FieldLabel>
            <Input
              id="explorer-upload"
              ref={uploadInputRef}
              type="file"
              multiple
              onChange={(e) => {
                const files = e.target.files ? [...e.target.files] : []
                if (files.length) upload.mutate(files)
              }}
            />
            <FieldDescription>
              Maximum {formatBytes(cap)} per file. Drag and drop onto the listing.
            </FieldDescription>
          </Field>
          <Field orientation="horizontal">
            <FieldLabel htmlFor="explorer-filter">Filter</FieldLabel>
            <Input id="explorer-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Name contains…" />
            <select
              className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
            >
              <option value="name">Name</option>
              <option value="size">Size</option>
              <option value="mtime">Modified</option>
            </select>
          </Field>
        </FieldGroup>
        {selectedEntries.length ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
            <span>{selectedEntries.length} selected</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setDialog({ kind: "move" })
                setDialogValue(path)
              }}
            >
              Move
            </Button>
            {selectedEntries.length === 1 && !selectedEntries[0]?.dir ? (
              <Button size="sm" variant="outline" onClick={() => openPeerSend(selectedEntries[0]!)}>
                Send to device…
              </Button>
            ) : null}
            <Button size="sm" variant="destructive" onClick={() => setDeleteTargets(selectedEntries)}>
              Delete
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        ) : null}
        {listPending && listed ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner />
            Waiting for agent…
          </p>
        ) : null}
        {listError && listed ? (
          <QueryErrorBanner cached error={listError} onRetry={() => listFiles.mutate(path)} />
        ) : null}
        {truncated ? (
          <p className="rounded-lg border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            Listing truncated (agent cap). Narrow the path or search by name.
          </p>
        ) : null}
        <div
          className={dragOver ? "rounded-lg ring-2 ring-primary" : ""}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            const files = [...e.dataTransfer.files]
            if (files.length) upload.mutate(files)
          }}
          onClick={() => setCtx(null)}
        >
          {listPending && !listed ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Spinner />
                </EmptyMedia>
                <EmptyTitle>Waiting for agent…</EmptyTitle>
                <EmptyDescription>File list is queued. Results apply over realtime or HTTP poll.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : listError && !listed ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FolderIcon />
                </EmptyMedia>
                <EmptyTitle>Listing failed</EmptyTitle>
                <EmptyDescription>{listError}</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button variant="outline" onClick={() => listFiles.mutate(path)}>
                  Retry
                </Button>
              </EmptyContent>
            </Empty>
          ) : listed && visible.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FolderIcon />
                </EmptyMedia>
                <EmptyTitle>Empty folder</EmptyTitle>
                <EmptyDescription>No entries in this listing.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : listed || visible.length ? (
            <div ref={setFileScroll} className="relative max-h-[min(70vh,32rem)] overflow-auto rounded-lg border">
              <table className="w-full caption-bottom text-sm">
                <TableHeader>
                  <TableRow>
                    <TableHead className="sticky top-0 z-10 w-8 bg-background" />
                    <TableHead className="sticky top-0 z-10 bg-background">Name</TableHead>
                    <TableHead className="sticky top-0 z-10 bg-background">Size</TableHead>
                    <TableHead className="sticky top-0 z-10 bg-background">Modified</TableHead>
                    <TableHead className="sticky top-0 z-10 w-[1%] whitespace-nowrap bg-background" />
                  </TableRow>
                </TableHeader>
                <tbody>
                  {path ? (
                    <TableRow>
                      <TableCell colSpan={5}>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            const up = parentPath(path)
                            go(up)
                          }}
                        >
                          ..
                        </Button>
                      </TableCell>
                    </TableRow>
                  ) : null}
                  {filePadTop > 0 ? (
                    <tr>
                      <td colSpan={5} style={{ height: filePadTop }} />
                    </tr>
                  ) : null}
                  {fileRendered.map((virtualRow) => {
                    const entry = visible[virtualRow.index]
                    if (!entry) return null
                    return (
                      <TableRow
                        key={entry.path}
                        data-index={virtualRow.index}
                        ref={fileVirtualizer.measureElement}
                        onContextMenu={(e) => openCtx(entry, e)}
                        onDoubleClick={() => {
                          if (entry.dir) go(entry.path)
                          else fileOp.mutate({ type: "preview_file", payload: { path: entry.path } })
                        }}
                      >
                        <TableCell>
                          <Checkbox checked={selected.has(entry.path)} onCheckedChange={() => toggleSelect(entry.path)} />
                        </TableCell>
                        <TableCell className="min-w-0 max-w-[20rem]">
                          {entry.dir ? (
                            <button
                              type="button"
                              className="block max-w-full truncate font-medium underline-offset-4 hover:underline"
                              title={entry.name}
                              onClick={() => go(entry.path)}
                            >
                              {entry.name}/
                            </button>
                          ) : (
                            <span className="block truncate" title={entry.name}>
                              {entry.name}
                            </span>
                          )}
                          {entry.matches?.length ? (
                            <p className="truncate text-xs text-muted-foreground" title={entry.matches[0]}>
                              {entry.matches[0]}
                            </p>
                          ) : null}
                        </TableCell>
                        <TableCell>{entry.dir ? "—" : formatBytes(entry.size)}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {typeof entry.mtime === "string" ? formatWhen(entry.mtime) : entry.mtime ? String(entry.mtime) : "—"}
                        </TableCell>
                        <TableCell className="w-[1%] whitespace-nowrap">
                          <Button size="sm" variant="ghost" onClick={(e) => openCtx(entry, e)}>
                            Open
                          </Button>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                  {filePadBottom > 0 ? (
                    <tr>
                      <td colSpan={5} style={{ height: filePadBottom }} />
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FolderIcon />
                </EmptyMedia>
                <EmptyTitle>No listing yet</EmptyTitle>
                <EmptyDescription>List home or a sandbox root. Results appear after the agent returns get_files.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
        {(localUploads.length > 0 || transferring.length > 0 || transfers.length > 0) && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Transfers</CardTitle>
              <CardDescription>Progress is separate from the directory listing.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {localUploads.map((u) => {
                const remaining = transferRemainingBytes(u.offset, u.size)
                return (
                  <Progress key={u.id} value={u.size ? Math.round((u.offset / u.size) * 100) : 0}>
                    <ProgressLabel>
                      {u.name} · {u.status}
                      {u.status === "uploading"
                        ? ` · ${formatBytes(remaining)} left of ${formatBytes(cap)} cap`
                        : ""}
                    </ProgressLabel>
                    <ProgressValue />
                  </Progress>
                )
              })}
              {transfers.map((f) => {
                const remaining = transferRemainingBytes(f.offset, f.size)
                const active = f.status === "transferring" || f.status === "pending"
                return (
                <div key={f.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <StatusBadge status={f.status} />
                  <span className="min-w-0 max-w-xs truncate" title={f.remotePath || f.direction}>
                    {f.remotePath || f.direction}
                  </span>
                  {f.direction === "peer" ? (
                    <Badge variant="outline">peer</Badge>
                  ) : null}
                  <span className="text-xs text-muted-foreground">
                    {formatBytes(f.offset ?? 0)} / {formatBytes(f.size)}
                    {active ? ` · ${formatBytes(remaining)} left` : ""}
                    {active ? ` · cap ${formatBytes(cap)}` : ""}
                  </span>
                  {f.status !== "transferring" && f.direction === "upload" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      render={<a href={`/api/v1/admin/files/${f.id}/download`} download />}
                      nativeButton={false}
                    >
                      Download
                    </Button>
                  ) : null}
                </div>
                )
              })}
            </CardContent>
          </Card>
        )}
      </CardContent>
      {ctx ? (
        <div
          className="fixed z-50 min-w-40 rounded-lg border bg-popover p-1 text-sm shadow-md"
          style={{ left: ctx.x, top: ctx.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {ctx.entry.dir ? (
            <button
              type="button"
              className="block w-full rounded-md px-2 py-1 text-left hover:bg-accent"
              onClick={() => {
                go(ctx.entry.path)
                setCtx(null)
              }}
            >
              Open
            </button>
          ) : (
            <>
              <button
                type="button"
                className="block w-full rounded-md px-2 py-1 text-left hover:bg-accent"
                onClick={() => {
                  fileOp.mutate({ type: "preview_file", payload: { path: ctx.entry.path } })
                  setCtx(null)
                }}
              >
                Preview
              </button>
              <button
                type="button"
                className="block w-full rounded-md px-2 py-1 text-left hover:bg-accent"
                onClick={() => {
                  fileOp.mutate({ type: "upload_file", payload: { path: ctx.entry.path } })
                  setCtx(null)
                }}
              >
                Download
              </button>
              <button
                type="button"
                className="block w-full rounded-md px-2 py-1 text-left hover:bg-accent"
                onClick={() => openPeerSend(ctx.entry)}
              >
                Send to device…
              </button>
            </>
          )}
          <button
            type="button"
            className="block w-full rounded-md px-2 py-1 text-left hover:bg-accent"
            onClick={() => {
              setDialog({ kind: "rename", target: ctx.entry })
              setDialogValue(ctx.entry.name)
              setCtx(null)
            }}
          >
            Rename
          </button>
          <button
            type="button"
            className="block w-full rounded-md px-2 py-1 text-left hover:bg-accent"
            onClick={() => {
              setDialog({ kind: "copy", target: ctx.entry })
              setDialogValue(path)
              setCtx(null)
            }}
          >
            Copy
          </button>
          <button
            type="button"
            className="block w-full rounded-md px-2 py-1 text-left hover:bg-accent"
            onClick={() => {
              setDialog({ kind: "move", target: ctx.entry })
              setDialogValue(path)
              setCtx(null)
            }}
          >
            Move
          </button>
          <button
            type="button"
            className="block w-full rounded-md px-2 py-1 text-left text-destructive hover:bg-accent"
            onClick={() => {
              setDeleteTargets([ctx.entry])
              setCtx(null)
            }}
          >
            Delete
          </button>
        </div>
      ) : null}
      <Dialog open={!!dialog} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dialog?.kind === "mkdir"
                ? "Create folder"
                : dialog?.kind === "search"
                  ? "Search files"
                  : dialog?.kind === "rename"
                    ? "Rename"
                    : dialog?.kind === "copy"
                      ? "Copy to folder"
                      : "Move to folder"}
            </DialogTitle>
            <DialogDescription>
              {dialog?.kind === "search"
                ? "Match by name under the current path."
                : dialog?.kind === "move" || dialog?.kind === "copy"
                  ? "Destination is a folder; the file name is appended."
                  : "Stays inside the agent sandbox."}
            </DialogDescription>
          </DialogHeader>
          <Input
            value={dialogValue}
            onChange={(e) => setDialogValue(e.target.value)}
            placeholder={
              dialog?.kind === "move" || dialog?.kind === "copy"
                ? "Destination folder"
                : dialog?.kind === "search"
                  ? "Name contains"
                  : "Name"
            }
          />
          <DialogFooter>
            <Button onClick={submitDialog} disabled={fileOp.isPending || !dialogValue}>
              Queue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!preview}
        onOpenChange={(open) => {
          if (!open) {
            setPreview(null)
            if (previewUrl.current) {
              URL.revokeObjectURL(previewUrl.current)
              previewUrl.current = null
            }
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{preview?.title}</DialogTitle>
            <DialogDescription>{preview?.truncated ? "Truncated preview" : "Sandbox preview"}</DialogDescription>
          </DialogHeader>
          {preview?.src ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview.src} alt="" className="max-h-[60vh] w-full object-contain" />
          ) : (
            <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs">{preview?.text}</pre>
          )}
        </DialogContent>
      </Dialog>
      <AlertDialog open={deleteTargets.length > 0} onOpenChange={(open) => !open && setDeleteTargets([])}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {deleteTargets.length === 1 ? deleteTargets[0]?.name : `${deleteTargets.length} items`}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Removes files and folders on the device (sandboxed). Directories are deleted recursively.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                for (const t of deleteTargets) {
                  fileOp.mutate({ type: "delete_file", payload: { path: t.path } })
                }
                setSelected(new Set())
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog
        open={!!peerSend && !peerConfirm}
        onOpenChange={(open) => {
          if (!open) {
            setPeerSend(null)
            setPeerConfirm(false)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send to device…</DialogTitle>
            <DialogDescription>
              Copies {peerSend?.name} over LAN when the hosts share a subnet or public IP. If the dial fails, the
              file is relayed through the API.
            </DialogDescription>
          </DialogHeader>
          {onlinePeers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No other online devices.</p>
          ) : (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="peer-dest">Destination</FieldLabel>
                <select
                  id="peer-dest"
                  className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm"
                  value={peerDestId}
                  onChange={(e) => setPeerDestId(e.target.value)}
                >
                  {onlinePeers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.hostname}
                      {p.likely ? " · likely LAN" : " · server relay"}
                    </option>
                  ))}
                </select>
              </Field>
              <Field>
                <FieldLabel htmlFor="peer-dest-path">Destination path</FieldLabel>
                <Input
                  id="peer-dest-path"
                  value={peerDestPath}
                  onChange={(e) => setPeerDestPath(e.target.value)}
                />
                <FieldDescription>Resolved in the destination agent sandbox.</FieldDescription>
              </Field>
            </FieldGroup>
          )}
          <DialogFooter>
            <Button
              disabled={!peerSend || !peerDestId || !peerDestPath || onlinePeers.length === 0}
              onClick={() => setPeerConfirm(true)}
            >
              Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={peerConfirm} onOpenChange={(open) => !open && setPeerConfirm(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send {peerSend?.name} to {selectedPeer?.hostname}?</AlertDialogTitle>
            <AlertDialogDescription>
              {peerSend?.srcPath} → {peerDestPath} on {selectedPeer?.hostname}.{" "}
              {selectedPeer?.likely
                ? "These hosts look like LAN peers (same /24 or public IP). The source will fall back to the API if the LAN dial fails in about 3 seconds."
                : "No LAN match; the copy will use the existing upload/download path through the API if LAN is unreachable."}{" "}
              Agents only exchange this file. They do not accept commands, plugins, or SCM/registry ops from each
              other.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={peerCopy.isPending || !peerSend || !peerDestId}
              onClick={() => {
                if (!peerSend) return
                peerCopy.mutate({
                  destDeviceId: peerDestId,
                  srcPath: peerSend.srcPath,
                  destPath: peerDestPath || joinPath(path, peerSend.name),
                })
              }}
            >
              Send
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
