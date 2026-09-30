"use client"

import * as React from "react"
import { toast } from "sonner"
import { CLIPBOARD_IMAGE_MAX, CLIPBOARD_KIND, WEBRTC_ERROR, WS_EVENTS, clipContentKey, h264FallbackLabel, pushClipHistory, type ClipboardKind, type WebrtcIceServer, type WebrtcSignalPayload } from "@workspace/shared"

import { api, formatBytes } from "@/lib/api"
import { pollAdminCommand, queueDeviceCommand } from "@/lib/command-poll"
import { decryptBytes, encryptBytes, type E2ESession } from "@/lib/e2e"
import { NumberInput } from "@/components/number-input"
import { useRealtime } from "@/components/providers"
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
import { Card, CardContent, CardDescription, CardHeader } from "@workspace/ui/components/card"
import { Checkbox } from "@workspace/ui/components/checkbox"
import { Field, FieldLabel } from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { ToggleGroup, ToggleGroupItem } from "@workspace/ui/components/toggle-group"

const MAGIC = "PCM1"
const DEFAULT_STUN: WebrtcIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }]
const MAX_RECONNECT = 3
const CLIP_MAX = 50
const ANSWER_WATCHDOG_MS = 8_000
const FRAME_WATCHDOG_MS = 15_000
const MAX_PENDING_ICE = 64

type Meta = {
  iceServers?: WebrtcIceServer[]
  turnHint?: string
}

type ViewMode = "fit" | "1:1"
type LiveMode = "jpeg" | "h264" | "h264-audio"

type DesktopDisplay = {
  index?: number
  id?: number
  name?: string
  width?: number
  height?: number
}

type DesktopControl = {
  fps: number
  quality: number
  display: number
  maxWidth: number
}

type ClipKind = ClipboardKind

type ClipEntry = {
  id: string
  kind: ClipKind
  text?: string
  html?: string
  image?: string
  mime?: string
  files?: string[]
  formats?: string[]
  at: number
  pinned?: boolean
  from: "local" | "remote"
}

function clipStoreKey(deviceId: string, version = 2) {
  return `pcm.clipHistory.v${version}:${deviceId}`
}

function asStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const files = value.filter((v): v is string => typeof v === "string" && v.length > 0)
  return files.length ? files : undefined
}

function imageSrc(entry: ClipEntry): string | null {
  if (!entry.image) return null
  if (entry.image.startsWith("data:")) return entry.image
  return `data:${entry.mime || "image/png"};base64,${entry.image}`
}

function clipSearchText(entry: ClipEntry): string {
  return [entry.text, entry.html, entry.files?.join(" "), entry.kind, ...(entry.formats ?? [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
}

function normalizeStoredClip(raw: unknown): ClipEntry | null {
  if (!raw || typeof raw !== "object") return null
  const rec = raw as Partial<ClipEntry> & { text?: string }
  const files = asStringList(rec.files)
  const text = typeof rec.text === "string" ? rec.text : files?.join("\n")
  const html = typeof rec.html === "string" ? rec.html : undefined
  const image = typeof rec.image === "string" ? rec.image : undefined
  if (!text && !html && !image && !files?.length) return null
  const kind: ClipKind =
    rec.kind === "html" || rec.kind === "image" || rec.kind === "files" || rec.kind === "text"
      ? rec.kind
      : image
        ? "image"
        : files?.length
          ? "files"
          : html && !text
            ? "html"
            : "text"
  return {
    id: typeof rec.id === "string" ? rec.id : `${rec.at ?? Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    text,
    html,
    image,
    mime: typeof rec.mime === "string" ? rec.mime : undefined,
    files,
    formats: asStringList(rec.formats),
    at: typeof rec.at === "number" ? rec.at : Date.now(),
    pinned: Boolean(rec.pinned),
    from: rec.from === "local" ? "local" : "remote",
  }
}

function clipFromAgent(msg: Record<string, unknown>, from: ClipEntry["from"]): Omit<ClipEntry, "id"> | null {
  const files = asStringList(msg.files) ?? asStringList(msg.paths) ?? asStringList(msg.hdrop)
  const html = typeof msg.html === "string" ? msg.html : undefined
  let mime = typeof msg.mime === "string" ? msg.mime : undefined
  let image: string | undefined
  if (msg.image && typeof msg.image === "object") {
    const rec = msg.image as { data?: unknown; mime?: unknown }
    if (typeof rec.data === "string") image = rec.data
    if (typeof rec.mime === "string") mime = rec.mime
  } else if (typeof msg.image === "string") {
    image = msg.image
  } else if (typeof msg.png === "string") {
    image = msg.png
  } else if (typeof msg.data === "string" && (msg.kind === CLIPBOARD_KIND.image || (mime ?? "").startsWith("image/"))) {
    image = msg.data
  }
  const text =
    typeof msg.text === "string" ? msg.text : typeof msg.unicode === "string" ? msg.unicode : files?.join("\n")
  const formats = asStringList(msg.formats) ?? asStringList(msg.types)
  const kind: ClipKind =
    msg.kind === CLIPBOARD_KIND.html ||
    msg.kind === CLIPBOARD_KIND.image ||
    msg.kind === CLIPBOARD_KIND.files ||
    msg.kind === CLIPBOARD_KIND.text
      ? msg.kind
      : image
        ? CLIPBOARD_KIND.image
        : files?.length
          ? CLIPBOARD_KIND.files
          : html && !text
            ? CLIPBOARD_KIND.html
            : CLIPBOARD_KIND.text
  if (!text && !html && !image && !files?.length) return null
  return {
    kind,
    text,
    html,
    image,
    mime,
    files,
    formats,
    at: typeof msg.at === "number" ? msg.at : Date.now(),
    from,
  }
}

function loadClips(deviceId: string): ClipEntry[] {
  try {
    const raw = localStorage.getItem(clipStoreKey(deviceId)) ?? localStorage.getItem(clipStoreKey(deviceId, 1))
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.map(normalizeStoredClip).filter((c): c is ClipEntry => Boolean(c)).slice(0, CLIP_MAX * 2)
  } catch {
    return []
  }
}

function saveClips(deviceId: string, items: ClipEntry[]) {
  try {
    const slim = items.slice(0, CLIP_MAX * 2).map((c) => {
      if (c.image && c.image.length > 400_000) {
        const { image: _image, ...rest } = c
        return rest
      }
      return c
    })
    localStorage.setItem(clipStoreKey(deviceId), JSON.stringify(slim))
  } catch {
    /* ignore quota */
  }
}

function pushClip(items: ClipEntry[], entry: Omit<ClipEntry, "id">): ClipEntry[] {
  return pushClipHistory(items, { ...entry, id: `${entry.at}-${Math.random().toString(36).slice(2, 8)}` }, CLIP_MAX)
}

/** Agent history lists arrive oldest-first; only content not already shown is added. */
function mergeRemoteClips(items: ClipEntry[], remote: Omit<ClipEntry, "id">[]): ClipEntry[] {
  const known = new Set(items.map(clipContentKey))
  let next = items
  for (const entry of remote) {
    const key = clipContentKey(entry)
    if (known.has(key)) continue
    known.add(key)
    next = pushClip(next, entry)
  }
  return next
}

type ClipSyncStatus = "idle" | "waiting_input" | "syncing" | "ready" | "unsupported" | "error"

function parseClipListItem(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>
    } catch {
      return null
    }
    return null
  }
  if (typeof raw === "object" && raw !== null) return raw as Record<string, unknown>
  return null
}

function clipErrorLabel(code: string): string {
  if (code === "no_interactive_session") return "Clipboard unavailable (no logged-on user)."
  if (code === "clipboard empty") return "Remote clipboard is empty."
  if (code === "clipboard_unavailable") return "Clipboard sync is unavailable on this agent."
  return "Could not read remote clipboard."
}

function captureErrorLabel(code: string): string {
  const key = code.trim()
  if (key === WEBRTC_ERROR.noInteractiveSession || key === "no_interactive_session") {
    return "No interactive session — the agent cannot capture the logged-on desktop (Session 0)."
  }
  if (key === WEBRTC_ERROR.disabled || key === "webrtc_disabled" || key === "enable_webrtc") {
    return "WebRTC is disabled on this agent (enable_webrtc is off). This is not a codec failure — use a Full remote builder stamp for live video."
  }
  if (key === WEBRTC_ERROR.unavailable) {
    return "WebRTC is unavailable on this agent."
  }
  if (key === WEBRTC_ERROR.agentOffline || key === "agent_offline") {
    return "Agent is offline — desktop signaling did not reach the device."
  }
  if (key === WEBRTC_ERROR.connectTimeout || key === "connect_timeout") {
    return "WebRTC did not connect. Check enable_webrtc on the agent, ICE/TURN, and that the offer was answered."
  }
  if (key === WEBRTC_ERROR.noFrame || key === "no_frame") {
    return "Connected but no desktop frame arrived. Capture helper or DXGI may have failed."
  }
  if (key === "autoplay_blocked") {
    return "Browser blocked media playback. Click Unmute or the viewer to start the video."
  }
  if (key === "capture_failed" || key === "capture_timeout") {
    return "Desktop capture failed on the agent."
  }
  if (key === "session_replaced") return "Another operator session took over this device's desktop."
  if (key === "session_expired" || key === "agent:session_expired") {
    return "The desktop session reached its maximum duration. Start a new session to continue."
  }
  if (key === "session_not_owned") return "This desktop session belongs to another operator tab."
  if (key === "signal_rate_limited") return "Too many signaling messages; the session was stopped. Try again shortly."
  if (key === "input_throttled") return "Remote input is being sent too fast; some events were dropped."
  if (key === "clipboard_rate_limited") return "Clipboard requests are rate-limited; try again in a moment."
  return key
}

function jpegFallbackHud(reason: string): string {
  return h264FallbackLabel(reason)
}

function codecHudLabel(codec: "jpeg" | "h264"): string {
  return codec === "h264" ? "H.264" : "JPEG"
}

async function blobToClipImage(blob: Blob): Promise<{ image: string; mime: string }> {
  const buf = await blob.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return { image: btoa(bin), mime: blob.type || "image/png" }
}

function concatFrags(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

function contentBox(canvasW: number, canvasH: number, imgW: number, imgH: number) {
  if (imgW <= 0 || imgH <= 0 || canvasW <= 0 || canvasH <= 0) {
    return { x: 0, y: 0, w: canvasW, h: canvasH }
  }
  const scale = Math.min(canvasW / imgW, canvasH / imgH)
  const w = imgW * scale
  const h = imgH * scale
  return { x: (canvasW - w) / 2, y: (canvasH - h) / 2, w, h }
}

function mapPointer(
  rect: DOMRect,
  clientX: number,
  clientY: number,
  imgW: number,
  imgH: number,
  letterbox: boolean,
  bufferW?: number,
  bufferH?: number
): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0) return null
  const cssX = clientX - rect.left
  const cssY = clientY - rect.top
  if (!letterbox) {
    const x = cssX / rect.width
    const y = cssY / rect.height
    if (x < 0 || x > 1 || y < 0 || y > 1) return null
    return { x, y }
  }
  const boxW = bufferW ?? rect.width
  const boxH = bufferH ?? rect.height
  const cx = (cssX / rect.width) * boxW
  const cy = (cssY / rect.height) * boxH
  const box = contentBox(boxW, boxH, imgW, imgH)
  if (box.w <= 0 || box.h <= 0) return null
  const x = (cx - box.x) / box.w
  const y = (cy - box.y) / box.h
  if (x < 0 || x > 1 || y < 0 || y > 1) return null
  return { x, y }
}

function displayIndex(d: DesktopDisplay, fallback: number): number {
  if (typeof d.index === "number") return d.index
  if (typeof d.id === "number") return d.id
  return fallback
}

export function WebrtcDesktop({
  deviceId,
  e2e,
  platform: platformProp,
  onSessionActive,
}: {
  deviceId: string
  e2e: E2ESession | null
  platform?: string
  onSessionActive?: (active: boolean) => void
}) {
  const { socket, status: realtimeStatus, attachedIds } = useRealtime()
  const pcRef = React.useRef<RTCPeerConnection | null>(null)
  const inputRef = React.useRef<RTCDataChannel | null>(null)
  const desktopRef = React.useRef<RTCDataChannel | null>(null)
  const pending = React.useRef(new Map<number, { count: number; parts: Array<Uint8Array | undefined> }>())
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
  const videoRef = React.useRef<HTMLVideoElement | null>(null)
  const wrapRef = React.useRef<HTMLDivElement | null>(null)
  const frameSize = React.useRef({ w: 0, h: 0 })
  const drawGen = React.useRef(0)
  const lastBitmap = React.useRef<ImageBitmap | null>(null)
  const reconnects = React.useRef(0)
  const reconnectTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnecting = React.useRef(false)
  const ignoreHangupUntil = React.useRef(0)
  const sessionGen = React.useRef(0)
  const autoplayBlockedRef = React.useRef(false)
  const wantInput = React.useRef(false)
  const sessionOnRef = React.useRef(false)
  const bytesWindow = React.useRef({ t: 0, n: 0 })
  const localFps = React.useRef({ t: 0, n: 0, fps: 0 })
  const statsTimer = React.useRef<ReturnType<typeof setInterval> | null>(null)
  const inboundBytes = React.useRef({ t: 0, n: 0 })
  const liveModeRef = React.useRef<LiveMode>("jpeg")
  const hasFrameRef = React.useRef(false)
  const gotAnswerRef = React.useRef(false)
  const remoteReadyRef = React.useRef(false)
  const pendingIceRef = React.useRef<RTCIceCandidateInit[]>([])
  const answerWatchdog = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const frameWatchdog = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const [sessionOn, setSessionOn] = React.useState(false)
  const [connected, setConnected] = React.useState(false)
  const [hasFrame, setHasFrame] = React.useState(false)
  const [info, setInfo] = React.useState("JPEG frames over a WebRTC data channel. Audio is off.")
  const [confirmOpen, setConfirmOpen] = React.useState(false)
  const [allowInput, setAllowInput] = React.useState(false)
  const [kbCapture, setKbCapture] = React.useState(false)
  const [hint, setHint] = React.useState("")
  const [iceServers, setIceServers] = React.useState<WebrtcIceServer[]>(DEFAULT_STUN)
  const [fps, setFps] = React.useState(5)
  const [quality, setQuality] = React.useState(50)
  const [display, setDisplay] = React.useState(0)
  const [maxWidth, setMaxWidth] = React.useState(1920)
  const [displays, setDisplays] = React.useState<DesktopDisplay[]>([])
  const [viewMode, setViewMode] = React.useState<ViewMode>("fit")
  const [hud, setHud] = React.useState({ fps: 0, bitrate: 0, rtt: 0 })
  const [inputUnsupported, setInputUnsupported] = React.useState(false)
  const [clipText, setClipText] = React.useState("")
  const [platform, setPlatform] = React.useState(platformProp ?? "")
  const [liveMode, setLiveMode] = React.useState<LiveMode>("jpeg")
  const [negotiatedCodec, setNegotiatedCodec] = React.useState<"jpeg" | "h264">("jpeg")
  const [negotiatedAudio, setNegotiatedAudio] = React.useState(false)
  const [clipSearch, setClipSearch] = React.useState("")
  const [clips, setClips] = React.useState<ClipEntry[]>([])
  const [clipboardSupported, setClipboardSupported] = React.useState(true)
  const [clipboardNote, setClipboardNote] = React.useState<string | null>(null)
  const [clipSyncStatus, setClipSyncStatus] = React.useState<ClipSyncStatus>("idle")
  const [clipSyncError, setClipSyncError] = React.useState<string | null>(null)
  const clipPollRef = React.useRef<ReturnType<typeof setInterval> | null>(null)
  const [fetchingClip, setFetchingClip] = React.useState(false)
  const clipFetchAbort = React.useRef<AbortController | null>(null)
  React.useEffect(() => () => clipFetchAbort.current?.abort(), [])
  const lastRemoteClipAt = React.useRef(0)
  const clipboardSupportedRef = React.useRef(true)
  const [captureError, setCaptureError] = React.useState<string | null>(null)
  const [jpegFallbackReason, setJpegFallbackReason] = React.useState<string | null>(null)
  const jpegToastRef = React.useRef<string | null>(null)
  const [inputOpen, setInputOpen] = React.useState(false)
  const [videoMuted, setVideoMuted] = React.useState(true)
  const imageInputRef = React.useRef<HTMLInputElement | null>(null)

  const e2eRef = React.useRef(e2e)
  e2eRef.current = e2e
  const iceRef = React.useRef(iceServers)
  iceRef.current = iceServers
  const controlRef = React.useRef<DesktopControl>({ fps, quality, display, maxWidth })
  controlRef.current = { fps, quality, display, maxWidth }
  sessionOnRef.current = sessionOn
  wantInput.current = allowInput
  liveModeRef.current = liveMode

  const windowsLive = platform === "windows"
  const showVideo = negotiatedCodec === "h264"

  React.useLayoutEffect(() => {
    onSessionActive?.(sessionOn)
    return () => onSessionActive?.(false)
  }, [sessionOn, onSessionActive])

  React.useEffect(() => {
    setClips(loadClips(deviceId))
  }, [deviceId])

  React.useEffect(() => {
    saveClips(deviceId, clips)
  }, [clips, deviceId])

  React.useEffect(() => {
    clipboardSupportedRef.current = clipboardSupported
  }, [clipboardSupported])

  React.useEffect(() => {
    if (!sessionOn) {
      stopClipPoll()
      setClipSyncStatus("idle")
      setClipSyncError(null)
      return
    }
    if (!clipboardSupported) {
      stopClipPoll()
      setClipSyncStatus("unsupported")
      return
    }
    if (!inputOpen) {
      stopClipPoll()
      setClipSyncStatus("waiting_input")
      return
    }
    requestClipList()
    startClipPoll()
    return () => stopClipPoll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionOn, inputOpen, clipboardSupported])

  React.useEffect(() => {
    if (platformProp) {
      setPlatform(platformProp)
      return
    }
    void api<{ device?: { platform?: string } }>(`/api/v1/admin/devices/${deviceId}`)
      .then((d) => {
        if (d.device?.platform) setPlatform(d.device.platform)
      })
      .catch(() => {
        /* keep jpeg-only until known */
      })
  }, [deviceId, platformProp])

  React.useEffect(() => {
    if (!windowsLive && liveMode !== "jpeg") setLiveMode("jpeg")
  }, [windowsLive, liveMode])

  React.useEffect(() => {
    void api<Meta>("/api/v1/admin/meta").then((m) => {
      if (m.iceServers?.length) setIceServers(m.iceServers)
      if (m.turnHint) setHint(m.turnHint)
    })
  }, [])

  const hangupRef = React.useRef<(notify?: boolean, resetReconnects?: boolean) => void>(() => {})

  const emitSignal = React.useCallback(
    async (payload: WebrtcSignalPayload) => {
      if (!socket) return
      const session = e2eRef.current
      if (session) {
        const { nonce, ciphertext } = await encryptBytes(session.key, new TextEncoder().encode(JSON.stringify(payload)))
        socket.emit(WS_EVENTS.E2E_ENVELOPE, {
          deviceId,
          payload: { action: "data", sessionId: session.sessionId, kind: "sdp", nonce, ciphertext },
        })
        return
      }
      socket.emit(WS_EVENTS.WEBRTC_SIGNAL, { deviceId, payload })
    },
    [socket, deviceId]
  )

  function sendControl() {
    if (!sessionOnRef.current) return
    const c = controlRef.current
    const body = { t: "ctrl" as const, fps: c.fps, quality: c.quality, display: c.display, maxWidth: c.maxWidth }
    const input = inputRef.current
    if (input?.readyState === "open") {
      input.send(JSON.stringify(body))
      return
    }
    void emitSignal({
      kind: "control",
      fps: c.fps,
      quality: c.quality,
      display: c.display,
      maxWidth: c.maxWidth,
    })
  }

  function sendInputJson(payload: Record<string, unknown>): boolean {
    const ch = inputRef.current
    if (!ch || ch.readyState !== "open") return false
    const clipCmd = payload.t === "clip" || payload.t === "clipget" || payload.t === "cliplist"
    if (!clipCmd && !wantInput.current) return false
    ch.send(JSON.stringify(payload))
    return true
  }

  function requestClipList() {
    if (!clipboardSupportedRef.current) return false
    if (!sendInputJson({ t: "cliplist" })) {
      setClipSyncStatus("waiting_input")
      return false
    }
    setClipSyncStatus("syncing")
    return true
  }

  function requestClipGet() {
    if (!clipboardSupportedRef.current) return false
    if (!sendInputJson({ t: "clipget" })) {
      setClipSyncStatus("waiting_input")
      return false
    }
    lastRemoteClipAt.current = Date.now()
    setClipSyncStatus("syncing")
    return true
  }

  function stopClipPoll() {
    if (clipPollRef.current) {
      clearInterval(clipPollRef.current)
      clipPollRef.current = null
    }
  }

  function startClipPoll() {
    stopClipPoll()
    if (!clipboardSupportedRef.current) return
    const tick = () => {
      if (!sessionOnRef.current || !inputRef.current || inputRef.current.readyState !== "open") return
      const idle = Date.now() - lastRemoteClipAt.current
      if (idle < 4000) return
      requestClipGet()
    }
    clipPollRef.current = setInterval(tick, 2000)
  }

  function rememberClip(entry: Omit<ClipEntry, "id">) {
    setClips((cur) => pushClip(cur, entry))
  }

  function rememberText(text: string, from: ClipEntry["from"], at?: number) {
    if (!text) return
    rememberClip({ kind: CLIPBOARD_KIND.text, text, at: at ?? Date.now(), from })
  }

  /** On-demand get_clipboard over the audited command path; no desktop session needed. */
  async function fetchDeviceClipboard() {
    if (fetchingClip) return
    setFetchingClip(true)
    clipFetchAbort.current?.abort()
    const ac = new AbortController()
    clipFetchAbort.current = ac
    try {
      const id = await queueDeviceCommand(deviceId, "get_clipboard")
      const outcome = await pollAdminCommand(id, { signal: ac.signal })
      if (outcome.kind === "timeout") throw new Error("timeout")
      if (outcome.kind === "error") throw new Error(outcome.message)
      const result = (outcome.command.result ?? {}) as { current?: unknown; history?: unknown; error?: unknown }
      const history = Array.isArray(result.history) ? result.history : []
      const remote: Omit<ClipEntry, "id">[] = []
      for (const raw of [...history].reverse()) {
        const rec = parseClipListItem(raw)
        const entry = rec ? clipFromAgent(rec, "remote") : null
        if (entry) remote.push(entry)
      }
      if (remote.length) setClips((cur) => mergeRemoteClips(cur, remote))
      if (typeof result.error === "string") {
        setClipSyncError(clipErrorLabel(result.error))
      } else {
        setClipSyncError(null)
        toast.success(remote.length ? `Fetched ${remote.length} clipboard item${remote.length === 1 ? "" : "s"}` : "Device clipboard is empty")
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "get_clipboard failed"
      if (message !== "aborted") toast.error(`Clipboard fetch failed: ${message}`)
    } finally {
      setFetchingClip(false)
    }
  }

  function handleAgentJson(raw: string) {
    try {
      const msg = JSON.parse(raw) as Record<string, unknown>
      const type = typeof msg.type === "string" ? msg.type : ""
      const errorCode =
        typeof msg.error === "string"
          ? msg.error
          : typeof msg.reason === "string" && (type === "error" || type === "capture_error" || type === "hangup")
            ? msg.reason
            : undefined
      if (errorCode || type === "error" || type === "capture_error") {
        const code = errorCode || type
        setCaptureError(code)
        setInfo(captureErrorLabel(code))
        reconnects.current = MAX_RECONNECT
        hangupRef.current(false)
      }
      if (type === "hello") {
        if (Array.isArray(msg.displays) && msg.displays.length) setDisplays(msg.displays as DesktopDisplay[])
        const w = typeof msg.width === "number" ? msg.width : frameSize.current.w
        const h = typeof msg.height === "number" ? msg.height : frameSize.current.h
        const codec = msg.codec === "h264" ? "h264" : "jpeg"
        const audio = Boolean(msg.audio)
        setNegotiatedCodec(codec)
        setNegotiatedAudio(audio)
        setInfo(`${w}×${h} · ${codecHudLabel(codec)}${audio ? " + audio" : " · audio off"}`)
        if (codec === "jpeg" && liveModeRef.current !== "jpeg") {
          const reason = typeof msg.reason === "string" && msg.reason.trim() ? msg.reason.trim() : "unknown"
          setJpegFallbackReason(reason)
          if (jpegToastRef.current !== reason) {
            jpegToastRef.current = reason
            toast.warning(jpegFallbackHud(reason))
          }
        }
        if (msg.inputSupported === false) setInputUnsupported(true)
        if (msg.clipboardSupported === false) {
          setClipboardSupported(false)
          setClipSyncStatus("unsupported")
          setClipboardNote("Clipboard sync is unavailable on this agent (no interactive session).")
        } else {
          setClipboardSupported(true)
          const watch = typeof msg.clipboardWatch === "string" ? msg.clipboardWatch : "listener"
          if (watch === "helper") {
            setClipboardNote("History is agent-side only (Windows service session). Real-time sync uses the capture helper.")
          } else if (watch === "off") {
            setClipboardNote("Clipboard sync is off on this platform.")
          } else {
            setClipboardNote(null)
          }
          if (inputRef.current?.readyState === "open") {
            setClipSyncStatus("ready")
          } else {
            setClipSyncStatus("waiting_input")
          }
        }
        sendControl()
      }
      if (type === "codec") {
        const codec = msg.codec === "h264" ? "h264" : "jpeg"
        setNegotiatedCodec(codec)
        if (typeof msg.audio === "boolean") setNegotiatedAudio(msg.audio)
        if (codec === "jpeg" && liveModeRef.current !== "jpeg") {
          const reason = typeof msg.reason === "string" && msg.reason.trim() ? msg.reason.trim() : "unknown"
          setJpegFallbackReason(reason)
          if (jpegToastRef.current !== reason) {
            jpegToastRef.current = reason
            toast.warning(jpegFallbackHud(reason))
          }
        }
        setInfo((prev) => prev.replace(/JPEG|H\.264|H264/i, codecHudLabel(codec)))
      }
      if (type === "stats") {
        setHud((h) => ({
          fps: typeof msg.fps === "number" ? msg.fps : h.fps || localFps.current.fps,
          bitrate: typeof msg.bytes === "number" ? msg.bytes : h.bitrate,
          rtt: typeof msg.rtt === "number" ? msg.rtt : h.rtt,
        }))
      }
      if (type === "input_unsupported") {
        setInputUnsupported(true)
      }
      if (type === "clip") {
        const entry = clipFromAgent(msg, "remote")
        if (entry) {
          lastRemoteClipAt.current = Date.now()
          rememberClip(entry)
          setClipSyncError(null)
          setClipSyncStatus("ready")
          if (msg.ok === true || msg.ok === false) {
            if (msg.ok === false) {
              const err = typeof msg.error === "string" ? msg.error : "clipboard_unavailable"
              const label = clipErrorLabel(err)
              setClipSyncError(label)
              setClipSyncStatus("error")
              toast.error(label)
            } else if (entry.text) {
              void navigator.clipboard.writeText(entry.text).then(
                () => {
                  toast.success("Remote clipboard copied")
                },
                () => setClipText(entry.text ?? "")
              )
            }
          }
        } else if (msg.ok === false) {
          const err = typeof msg.error === "string" ? msg.error : "clipboard_unavailable"
          const label = clipErrorLabel(err)
          setClipSyncError(label)
          setClipSyncStatus("error")
          toast.error(label)
        }
      }
      if (type === "cliplist" && msg.ok === true && Array.isArray(msg.items)) {
        const remote: Omit<ClipEntry, "id">[] = []
        for (const raw of msg.items) {
          const rec = parseClipListItem(raw)
          if (!rec) continue
          const entry = clipFromAgent(rec, "remote")
          if (entry) remote.push(entry)
        }
        if (remote.length) {
          setClips((cur) => mergeRemoteClips(cur, remote))
          setClipSyncError(null)
        }
        setClipSyncStatus("ready")
      }
    } catch {
      /* ignore */
    }
  }

  function paint(bmp: ImageBitmap) {
    const canvas = canvasRef.current
    if (!canvas) return
    const wrap = wrapRef.current
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    frameSize.current = { w: bmp.width, h: bmp.height }
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1
    if (viewMode === "1:1") {
      canvas.width = bmp.width
      canvas.height = bmp.height
      canvas.style.width = `${bmp.width}px`
      canvas.style.height = `${bmp.height}px`
      ctx.drawImage(bmp, 0, 0)
      return
    }
    const cssW = wrap?.clientWidth || canvas.clientWidth || bmp.width
    const cssH = wrap?.clientHeight || 480
    canvas.width = Math.max(1, Math.round(cssW * dpr))
    canvas.height = Math.max(1, Math.round(cssH * dpr))
    canvas.style.width = "100%"
    canvas.style.height = "100%"
    ctx.fillStyle = "#000"
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    const box = contentBox(canvas.width, canvas.height, bmp.width, bmp.height)
    ctx.drawImage(bmp, box.x, box.y, box.w, box.h)
  }

  async function drawJpeg(jpeg: Uint8Array) {
    const gen = ++drawGen.current
    try {
      const copy = jpeg.slice()
      const ab = copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength)
      const blob = new Blob([ab], { type: "image/jpeg" })
      const bmp = await createImageBitmap(blob)
      if (gen !== drawGen.current) {
        bmp.close()
        return
      }
      lastBitmap.current?.close()
      lastBitmap.current = bmp
      paint(bmp)
      hasFrameRef.current = true
      setHasFrame(true)
      if (frameWatchdog.current) {
        clearTimeout(frameWatchdog.current)
        frameWatchdog.current = null
      }
      const now = performance.now()
      if (localFps.current.t === 0) localFps.current.t = now
      localFps.current.n += 1
      if (now - localFps.current.t >= 1000) {
        localFps.current.fps = localFps.current.n
        localFps.current.n = 0
        localFps.current.t = now
        setHud((h) => ({ ...h, fps: h.fps || localFps.current.fps }))
      }
      bytesWindow.current.n += jpeg.length
      if (bytesWindow.current.t === 0) bytesWindow.current.t = now
      if (now - bytesWindow.current.t >= 1000) {
        const bps = (bytesWindow.current.n * 1000) / Math.max(1, now - bytesWindow.current.t)
        bytesWindow.current = { t: now, n: 0 }
        setHud((h) => ({ ...h, bitrate: bps, fps: h.fps || localFps.current.fps }))
      }
    } catch {
      /* ignore decode failures */
    }
  }

  function onDesktopMessage(ev: MessageEvent) {
    if (typeof ev.data === "string") {
      handleAgentJson(ev.data)
      return
    }
    const applyBytes = (buf: Uint8Array) => {
      if (buf.length < 12) return
      const magic = String.fromCharCode(buf[0]!, buf[1]!, buf[2]!, buf[3]!)
      if (magic !== MAGIC) return
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
      const id = view.getUint32(4)
      const index = view.getUint16(8)
      const count = view.getUint16(10)
      const chunk = buf.subarray(12)
      let entry = pending.current.get(id)
      if (!entry) {
        if (pending.current.size > 8) {
          const oldest = pending.current.keys().next().value
          if (oldest != null) pending.current.delete(oldest)
        }
        entry = { count, parts: Array.from({ length: count }) }
        pending.current.set(id, entry)
      }
      entry.parts[index] = chunk
      if (entry.parts.every(Boolean)) {
        const jpeg = concatFrags(entry.parts as Uint8Array[])
        pending.current.delete(id)
        void drawJpeg(jpeg)
      }
    }
    if (ev.data instanceof Blob) {
      void ev.data.arrayBuffer().then((ab) => applyBytes(new Uint8Array(ab)))
      return
    }
    if (ev.data instanceof ArrayBuffer) {
      applyBytes(new Uint8Array(ev.data))
      return
    }
    if (ArrayBuffer.isView(ev.data)) {
      const view = ev.data as ArrayBufferView
      applyBytes(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
    }
  }

  function hangup(notifyAgent = true, resetReconnects = true) {
    if (resetReconnects) {
      reconnects.current = 0
      reconnecting.current = false
    }
    drawGen.current += 1
    autoplayBlockedRef.current = false
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current)
      reconnectTimer.current = null
    }
    if (statsTimer.current) {
      clearInterval(statsTimer.current)
      statsTimer.current = null
    }
    if (answerWatchdog.current) {
      clearTimeout(answerWatchdog.current)
      answerWatchdog.current = null
    }
    if (frameWatchdog.current) {
      clearTimeout(frameWatchdog.current)
      frameWatchdog.current = null
    }
    inputRef.current = null
    desktopRef.current = null
    stopClipPoll()
    const pc = pcRef.current
    pcRef.current = null
    pc?.close()
    lastBitmap.current?.close()
    lastBitmap.current = null
    pending.current.clear()
    pendingIceRef.current = []
    hasFrameRef.current = false
    gotAnswerRef.current = false
    remoteReadyRef.current = false
    const video = videoRef.current
    if (video) {
      const stream = video.srcObject as MediaStream | null
      stream?.getTracks().forEach((t) => t.stop())
      video.srcObject = null
    }
    setConnected(false)
    setHasFrame(false)
    setSessionOn(false)
    setKbCapture(false)
    setInputOpen(false)
    setVideoMuted(true)
    setNegotiatedCodec("jpeg")
    setNegotiatedAudio(false)
    sessionOnRef.current = false
    setClipSyncStatus("idle")
    setClipSyncError(null)
    if (notifyAgent && socket) {
      ignoreHangupUntil.current = Date.now() + 2000
      void emitSignal({ kind: "hangup" })
    }
  }
  hangupRef.current = hangup

  const start = React.useCallback(
    async (withInput: boolean, isRetry = false) => {
      if (realtimeStatus !== "online" || !socket?.connected) {
        toast.error("Realtime is required for desktop. The dashboard is in HTTP-only mode.")
        return
      }
      if (!attachedIds.includes(deviceId)) {
        toast.error("Still joining this device’s realtime room")
        return
      }
      const hadSession = sessionOnRef.current || Boolean(pcRef.current)
      const gen = ++sessionGen.current
      hangupRef.current(hadSession, !isRetry)
      if (!isRetry) reconnects.current = 0
      reconnecting.current = false
      if (hadSession) ignoreHangupUntil.current = Date.now() + 2000
      wantInput.current = withInput
      setAllowInput(withInput)
      setInputUnsupported(false)
      setInputOpen(false)
      setVideoMuted(true)
      setHasFrame(false)
      setCaptureError(null)
      setJpegFallbackReason(null)
      jpegToastRef.current = null
      autoplayBlockedRef.current = false
      const mode = liveModeRef.current
      const wantH264 = mode !== "jpeg"
      const wantAudio = mode === "h264-audio"
      setNegotiatedCodec("jpeg")
      setNegotiatedAudio(false)
      setInfo(wantH264 ? "Connecting · requesting H.264" : "Connecting · JPEG")
      const pc = new RTCPeerConnection({ iceServers: iceRef.current, iceCandidatePoolSize: 2 })
      if (gen !== sessionGen.current) {
        pc.close()
        return
      }
      pcRef.current = pc
      setSessionOn(true)
      sessionOnRef.current = true
      setConnected(false)
      const stillThis = () => gen === sessionGen.current && pcRef.current === pc
      const scheduleReconnect = () => {
        if (!stillThis()) return
        if (reconnecting.current || reconnects.current >= MAX_RECONNECT || !sessionOnRef.current) return
        reconnecting.current = true
        reconnects.current += 1
        setInfo("WebRTC failed. Retrying…")
        reconnectTimer.current = setTimeout(() => {
          reconnecting.current = false
          if (gen !== sessionGen.current) return
          void start(wantInput.current, true)
        }, 800)
      }
      pc.onconnectionstatechange = () => {
        if (!stillThis()) return
        setConnected(pc.connectionState === "connected")
        if (pc.connectionState === "connected") {
          reconnects.current = 0
          reconnecting.current = false
        }
        if (pc.connectionState === "failed") {
          if (reconnects.current >= MAX_RECONNECT) {
            reconnects.current = MAX_RECONNECT
            setCaptureError(WEBRTC_ERROR.connectTimeout)
            setInfo(captureErrorLabel(WEBRTC_ERROR.connectTimeout))
            hangupRef.current(true)
            return
          }
          scheduleReconnect()
        }
      }
      pc.oniceconnectionstatechange = () => {
        if (!stillThis()) return
        if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
          setConnected(true)
        }
        if (pc.iceConnectionState === "failed") scheduleReconnect()
      }
      pc.onicecandidate = (ev) => {
        if (!stillThis() || !ev.candidate) return
        void emitSignal({ kind: "ice", candidate: ev.candidate.toJSON() })
      }
      pc.ontrack = (ev) => {
        if (!stillThis()) return
        const el = videoRef.current
        if (!el) return
        let stream = el.srcObject as MediaStream | null
        if (!stream) {
          stream = new MediaStream()
          el.srcObject = stream
        }
        if (!stream.getTracks().some((t) => t.id === ev.track.id)) stream.addTrack(ev.track)
        el.muted = true
        void el.play().catch(() => {
          if (!stillThis()) return
          autoplayBlockedRef.current = true
          setCaptureError("autoplay_blocked")
          setInfo(captureErrorLabel("autoplay_blocked"))
        })
      }
      if (wantH264) {
        pc.addTransceiver("video", { direction: "recvonly" })
        if (wantAudio) pc.addTransceiver("audio", { direction: "recvonly" })
      }
      const desktop = pc.createDataChannel("desktop", { ordered: true })
      desktop.binaryType = "arraybuffer"
      desktop.onmessage = (ev) => {
        if (!stillThis()) return
        onDesktopMessage(ev)
      }
      desktop.onopen = () => {
        if (!stillThis()) return
        setConnected(true)
        sendControl()
        toast.success(withInput ? "Desktop started with remote input" : "Desktop started (view only · clipboard sync on)")
      }
      desktopRef.current = desktop
      const input = pc.createDataChannel("input", { ordered: true })
      input.onopen = () => {
        if (!stillThis()) return
        setInputOpen(true)
        sendControl()
      }
      input.onmessage = (ev) => {
        if (!stillThis()) return
        if (typeof ev.data === "string") handleAgentJson(ev.data)
      }
      inputRef.current = input
      if (withInput) {
        wantInput.current = true
      }
      const offer = await pc.createOffer()
      if (!stillThis()) return
      await pc.setLocalDescription(offer)
      if (!stillThis()) return
      const c = controlRef.current
      const payload: WebrtcSignalPayload = {
        kind: "offer",
        sdp: offer.sdp,
        sdpType: "offer",
        allowInput: withInput,
        iceServers: iceRef.current,
        fps: c.fps,
        quality: c.quality,
        display: c.display,
        maxWidth: c.maxWidth,
        codec: wantH264 ? "h264" : "jpeg",
        audio: wantAudio,
      }
      await emitSignal(payload)
      if (!stillThis()) return
      if (statsTimer.current) clearInterval(statsTimer.current)
      inboundBytes.current = { t: 0, n: 0 }
      gotAnswerRef.current = false
      hasFrameRef.current = false
      if (answerWatchdog.current) clearTimeout(answerWatchdog.current)
      if (frameWatchdog.current) clearTimeout(frameWatchdog.current)
      answerWatchdog.current = setTimeout(() => {
        if (!stillThis() || !sessionOnRef.current || gotAnswerRef.current || hasFrameRef.current) return
        reconnects.current = MAX_RECONNECT
        setCaptureError(WEBRTC_ERROR.connectTimeout)
        setInfo(captureErrorLabel(WEBRTC_ERROR.connectTimeout))
        hangupRef.current(true)
      }, ANSWER_WATCHDOG_MS)
      frameWatchdog.current = setTimeout(() => {
        if (!stillThis() || !sessionOnRef.current || hasFrameRef.current) return
        if (autoplayBlockedRef.current) return
        const video = videoRef.current
        if (video && video.readyState >= 2) {
          autoplayBlockedRef.current = true
          setCaptureError("autoplay_blocked")
          setInfo(captureErrorLabel("autoplay_blocked"))
          return
        }
        reconnects.current = MAX_RECONNECT
        const reason = gotAnswerRef.current ? WEBRTC_ERROR.noFrame : WEBRTC_ERROR.connectTimeout
        setCaptureError(reason)
        setInfo(captureErrorLabel(reason))
        hangupRef.current(true)
      }, FRAME_WATCHDOG_MS)
      statsTimer.current = setInterval(() => {
        if (!stillThis()) return
        const cur = pcRef.current
        if (!cur) return
        void cur.getStats().then((report) => {
          if (!stillThis()) return
          let bytes = 0
          let fpsVal = 0
          report.forEach((row) => {
            const rec = row as RTCInboundRtpStreamStats & { bytesReceived?: number; framesPerSecond?: number }
            if (rec.type === "inbound-rtp" && rec.kind === "video") {
              bytes = rec.bytesReceived ?? bytes
              fpsVal = rec.framesPerSecond ?? fpsVal
            }
          })
          const now = performance.now()
          let bps = 0
          if (inboundBytes.current.t && bytes >= inboundBytes.current.n) {
            const dt = (now - inboundBytes.current.t) / 1000
            if (dt > 0) bps = (bytes - inboundBytes.current.n) / dt
          }
          inboundBytes.current = { t: now, n: bytes }
          if (bps || fpsVal) {
            setHud((h) => ({
              ...h,
              bitrate: bps || h.bitrate,
              fps: fpsVal || h.fps,
            }))
          }
        })
      }, 1000)
    },
    // hangup / onDesktopMessage / sendControl read refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [socket, emitSignal, realtimeStatus, attachedIds, deviceId]
  )

  async function flushPendingIce(gen: number) {
    const pc = pcRef.current
    if (!pc || !remoteReadyRef.current || gen !== sessionGen.current) return
    const queued = pendingIceRef.current.splice(0)
    for (const candidate of queued) {
      if (gen !== sessionGen.current || pcRef.current !== pc) return
      try {
        await pc.addIceCandidate(candidate)
      } catch {
        /* stale or duplicate */
      }
    }
  }

  function enqueueIce(candidate: RTCIceCandidateInit, gen: number) {
    if (gen !== sessionGen.current) return
    const q = pendingIceRef.current
    if (q.length >= MAX_PENDING_ICE) q.shift()
    q.push(candidate)
    void flushPendingIce(gen)
  }

  async function applySignal(payload: WebrtcSignalPayload, gen: number) {
    if (gen !== sessionGen.current) return
    if (payload.kind === "hangup" || (payload.kind as string) === "error") {
      if (Date.now() < ignoreHangupUntil.current) return
      const reason = payload.reason || payload.error
      if (reason) {
        reconnects.current = MAX_RECONNECT
        setCaptureError(reason)
        setInfo(captureErrorLabel(reason))
      }
      hangup(false)
      return
    }
    if (payload.kind === "ice" && payload.candidate) {
      enqueueIce(payload.candidate as RTCIceCandidateInit, gen)
      return
    }
    const pc = pcRef.current
    if (!pc) return
    if (payload.kind === "answer" && payload.sdp) {
      if (pc.signalingState !== "have-local-offer") return
      if (pc.connectionState === "closed") return
      try {
        await pc.setRemoteDescription({ type: "answer", sdp: payload.sdp })
      } catch {
        return
      }
      if (pcRef.current !== pc || gen !== sessionGen.current) return
      gotAnswerRef.current = true
      if (answerWatchdog.current) {
        clearTimeout(answerWatchdog.current)
        answerWatchdog.current = null
      }
      remoteReadyRef.current = true
      await flushPendingIce(gen)
    }
  }

  React.useEffect(() => {
    return () => {
      hangupRef.current(true)
    }
  }, [deviceId])

  React.useEffect(() => {
    if (!socket) return
    const onSignal = (raw: unknown) => {
      if (!raw || typeof raw !== "object") return
      const rec = raw as { deviceId?: string; payload?: WebrtcSignalPayload }
      if (rec.deviceId !== deviceId || !rec.payload) return
      const gen = sessionGen.current
      void applySignal(rec.payload, gen)
    }
    socket.on(WS_EVENTS.WEBRTC_SIGNAL, onSignal)
    return () => {
      socket.off(WS_EVENTS.WEBRTC_SIGNAL, onSignal)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, deviceId])

  React.useEffect(() => {
    if (!socket || !e2e) return
    const onEnv = (raw: unknown) => {
      if (!raw || typeof raw !== "object") return
      const rec = raw as {
        deviceId?: string
        payload?: { action?: string; kind?: string; nonce?: string; ciphertext?: string; aad?: string; sessionId?: string }
      }
      if (rec.deviceId !== deviceId || rec.payload?.action !== "data" || rec.payload.kind !== "sdp") return
      if (rec.payload.sessionId !== e2e.sessionId) return
      if (!rec.payload.nonce || !rec.payload.ciphertext) return
      const gen = sessionGen.current
      void decryptBytes(e2e.key, rec.payload.nonce, rec.payload.ciphertext, rec.payload.aad ?? "")
        .then((plain) => {
          if (gen !== sessionGen.current) return
          const payload = JSON.parse(new TextDecoder().decode(plain)) as WebrtcSignalPayload
          void applySignal(payload, gen)
        })
        .catch(() => {
          /* ignore */
        })
    }
    socket.on(WS_EVENTS.E2E_ENVELOPE, onEnv)
    return () => {
      socket.off(WS_EVENTS.E2E_ENVELOPE, onEnv)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, deviceId, e2e])

  React.useEffect(() => {
    if (connected) sendControl()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fps, quality, display, maxWidth, connected])

  React.useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(() => {
      const bmp = lastBitmap.current
      if (bmp && !showVideo) paint(bmp)
    })
    ro.observe(wrap)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, showVideo])

  const moveRaf = React.useRef<number | null>(null)
  const pendingMove = React.useRef<{ x: number; y: number } | null>(null)

  function pointerToNorm(ev: React.PointerEvent<Element>) {
    if (showVideo) {
      const video = videoRef.current
      const w = video?.videoWidth || frameSize.current.w
      const h = video?.videoHeight || frameSize.current.h
      if (!video || !w || !h) return null
      frameSize.current = { w, h }
      return mapPointer(video.getBoundingClientRect(), ev.clientX, ev.clientY, w, h, viewMode === "fit")
    }
    const canvas = canvasRef.current
    const { w, h } = frameSize.current
    if (!canvas || !w || !h) return null
    return mapPointer(canvas.getBoundingClientRect(), ev.clientX, ev.clientY, w, h, viewMode === "fit", canvas.width, canvas.height)
  }

  function onPointerMove(ev: React.PointerEvent<Element>) {
    if (!allowInput) return
    const xy = pointerToNorm(ev)
    if (!xy) return
    pendingMove.current = xy
    if (moveRaf.current == null) {
      moveRaf.current = requestAnimationFrame(() => {
        moveRaf.current = null
        const next = pendingMove.current
        pendingMove.current = null
        if (next) sendInputJson({ t: "move", x: next.x, y: next.y })
      })
    }
  }

  function onPointerDown(ev: React.PointerEvent<Element>) {
    ev.preventDefault()
    try {
      ev.currentTarget.setPointerCapture(ev.pointerId)
    } catch {
      /* ignore */
    }
    if (allowInput) {
      setKbCapture(true)
      wrapRef.current?.focus()
    }
    const xy = pointerToNorm(ev)
    if (xy) sendInputJson({ t: "down", x: xy.x, y: xy.y, b: ev.button })
  }

  function onPointerUp(ev: React.PointerEvent<Element>) {
    ev.preventDefault()
    const xy = pointerToNorm(ev)
    if (xy) sendInputJson({ t: "up", x: xy.x, y: xy.y, b: ev.button })
  }

  function onWheel(ev: React.WheelEvent<Element>) {
    if (!allowInput) return
    ev.preventDefault()
    const xy = pointerToNorm(ev as unknown as React.PointerEvent<Element>)
    if (xy) sendInputJson({ t: "wheel", x: xy.x, y: xy.y, dy: ev.deltaY })
  }

  function onKey(ev: React.KeyboardEvent<Element>) {
    if (!allowInput || !kbCapture) return
    if (ev.key === "Escape") {
      setKbCapture(false)
      wrapRef.current?.blur()
      return
    }
    ev.preventDefault()
    ev.stopPropagation()
    sendInputJson({ t: "key", down: ev.type === "keydown", key: ev.key, code: ev.code })
  }

  async function sendClipboard(text?: string) {
    try {
      const value = text || clipText || (await navigator.clipboard.readText())
      if (!value) {
        toast.error("Clipboard is empty")
        return
      }
      if (!sendInputJson({ t: "clip", type: "clip", kind: CLIPBOARD_KIND.text, text: value, at: Date.now() })) {
        toast.error("Clipboard channel not ready yet — wait for input channel")
        return
      }
      rememberText(value, "local")
      toast.success("Clipboard sent to device")
    } catch {
      toast.error("Could not read clipboard")
    }
  }

  async function sendClipboardImage(file?: File | Blob) {
    try {
      let blob = file
      if (!blob && navigator.clipboard.read) {
        const items = await navigator.clipboard.read()
        for (const item of items) {
          const type = item.types.find((t) => t.startsWith("image/"))
          if (type) {
            blob = await item.getType(type)
            break
          }
        }
      }
      if (!blob) {
        imageInputRef.current?.click()
        return
      }
      const { image, mime } = await blobToClipImage(blob)
      if (blob.size > CLIPBOARD_IMAGE_MAX) {
        toast.error("Image is too large for the clipboard cap")
        return
      }
      if (!sendInputJson({
        t: "clip",
        type: "clip",
        kind: CLIPBOARD_KIND.image,
        image: { mime, data: image },
        mime,
        data: image,
        at: Date.now(),
      })) {
        toast.error("Clipboard channel not ready yet — wait for input channel")
        return
      }
      rememberClip({ kind: CLIPBOARD_KIND.image, image, mime, at: Date.now(), from: "local" })
      toast.success("Image sent to device clipboard")
    } catch {
      toast.error("Could not send image")
    }
  }

  async function copyLocal(entry: ClipEntry) {
    try {
      if (entry.kind === CLIPBOARD_KIND.image && entry.image) {
        const src = imageSrc(entry)
        if (src) {
          const res = await fetch(src)
          const blob = await res.blob()
          await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })])
          toast.success("Copied image")
          return
        }
      }
      if (entry.kind === CLIPBOARD_KIND.html && entry.html && typeof ClipboardItem !== "undefined") {
        const items: Record<string, Blob> = { "text/html": new Blob([entry.html], { type: "text/html" }) }
        if (entry.text) items["text/plain"] = new Blob([entry.text], { type: "text/plain" })
        await navigator.clipboard.write([new ClipboardItem(items)])
        toast.success("Copied HTML")
        return
      }
      const text = entry.text || entry.files?.join("\n") || entry.html || ""
      await navigator.clipboard.writeText(text)
      toast.success("Copied")
    } catch {
      const text = entry.text || entry.files?.join("\n") || entry.html || ""
      setClipText(text)
      toast.error("Could not copy — text is in the field")
    }
  }

  function sendClipEntry(entry: ClipEntry) {
    const at = Date.now()
    if (entry.kind === CLIPBOARD_KIND.image && entry.image) {
      sendInputJson({
        t: "clip",
        type: "clip",
        kind: CLIPBOARD_KIND.image,
        image: { mime: entry.mime || "image/png", data: entry.image },
        mime: entry.mime,
        data: entry.image,
        at,
      })
      rememberClip({ ...entry, from: "local", at, pinned: false })
      toast.success("Image sent to device clipboard")
      return
    }
    if (entry.html) {
      sendInputJson({
        t: "clip",
        type: "clip",
        kind: CLIPBOARD_KIND.html,
        html: entry.html,
        text: entry.text,
        at,
      })
      rememberClip({ ...entry, from: "local", at, pinned: false })
      toast.success("HTML sent to device clipboard")
      return
    }
    void sendClipboard(entry.text || entry.files?.join("\n") || "")
  }

  async function toggleFullscreen() {
    const el = wrapRef.current
    if (!el) return
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await el.requestFullscreen()
    } catch {
      toast.error("Fullscreen failed")
    }
  }

  const displayItems = displays.length
    ? displays.map((d, i) => {
        const idx = displayIndex(d, i)
        return { value: String(idx), label: d.name || `Display ${idx}${d.width && d.height ? ` (${d.width}×${d.height})` : ""}` }
      })
    : [{ value: "0", label: "Display 0" }]

  const bitrateLabel = hud.bitrate > 0 ? `${formatBytes(hud.bitrate)}/s` : "—"
  const fpsLabel = hud.fps > 0 ? `${Math.round(hud.fps)} fps` : "—"
  const codecLabel = negotiatedCodec === "h264" ? "H.264" : "JPEG"
  const filteredClips = clips.filter((c) => !clipSearch || clipSearchText(c).includes(clipSearch.toLowerCase()))
  const clipChannelReady = sessionOn && connected && inputOpen && clipboardSupported
  const clipStatusLabel = (() => {
    if (!sessionOn) {
      return clipSyncError ?? "Not connected. Fetch from device reads the clipboard and recent history once (audited)."
    }
    if (!clipboardSupported || clipSyncStatus === "unsupported") {
      return "Clipboard sync unavailable — agent has no interactive user session."
    }
    if (!inputOpen) return "Waiting for clipboard input channel…"
    if (clipSyncStatus === "syncing") return "Syncing clipboard with agent…"
    if (clipSyncError) return clipSyncError
    if (clipSyncStatus === "ready" && filteredClips.length === 0) {
      return "Listening for clipboard changes. Use Get to pull the current remote clipboard."
    }
    return null
  })()
  const errorLabel = captureError ? captureErrorLabel(captureError) : null
  const fallbackLabel =
    jpegFallbackReason && negotiatedCodec === "jpeg" ? jpegFallbackHud(jpegFallbackReason) : null
  const signalingReady = realtimeStatus === "online" && attachedIds.includes(deviceId)
  const captureLabel = allowInput
    ? `Input mapped to display ${display}${kbCapture ? " · keyboard captured" : " · click viewer to capture keyboard"}`
    : "View only"

  const pointerProps = {
    onPointerMove,
    onPointerDown,
    onPointerUp,
    onWheel,
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  }

  return (
    <Card>
      <CardHeader>
        <CardDescription>{info}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() => (allowInput ? setConfirmOpen(true) : void start(false))}
            disabled={connected || !signalingReady}
          >
            Connect
          </Button>
          <Button size="sm" variant="outline" onClick={() => hangup(true)} disabled={!sessionOn}>
            Hang up
          </Button>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={allowInput}
              disabled={sessionOn}
              onCheckedChange={(v) => setAllowInput(Boolean(v))}
            />
            Remote input
          </label>
          <ToggleGroup
            value={[liveMode]}
            onValueChange={(v) => {
              if (sessionOn) return
              const next = (v[0] as LiveMode) || "jpeg"
              if (!windowsLive && next !== "jpeg") return
              setLiveMode(next)
            }}
            spacing={1}
          >
            <ToggleGroupItem value="jpeg" disabled={sessionOn}>
              JPEG
            </ToggleGroupItem>
            <ToggleGroupItem value="h264" disabled={!windowsLive || sessionOn}>
              Video
            </ToggleGroupItem>
            <ToggleGroupItem value="h264-audio" disabled={!windowsLive || sessionOn}>
              Video+audio
            </ToggleGroupItem>
          </ToggleGroup>
          {negotiatedAudio && showVideo ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const next = !videoMuted
                setVideoMuted(next)
                const el = videoRef.current
                if (el) {
                  el.muted = next
                  void el.play().catch(() => {
                    autoplayBlockedRef.current = true
                    setCaptureError("autoplay_blocked")
                    setInfo(captureErrorLabel("autoplay_blocked"))
                  })
                }
              }}
            >
              {videoMuted ? "Unmute" : "Mute"}
            </Button>
          ) : null}
          <span className="text-xs text-muted-foreground">
            {connected ? "connected" : sessionOn ? "connecting…" : "idle"}
            {connected
              ? ` · ${codecLabel}${fallbackLabel ? ` · ${fallbackLabel}` : ""} · ${bitrateLabel} · ${fpsLabel}${hud.rtt ? ` · ${hud.rtt} ms` : ""}${negotiatedAudio ? " · audio" : ""}`
              : ""}
          </span>
        </div>
        {sessionOn ? (
          <p className="text-xs text-muted-foreground">Hang up, then Connect to change codec or remote input.</p>
        ) : !signalingReady ? (
          <p className="text-xs text-muted-foreground">
            {realtimeStatus === "online" ? "Joining this device’s realtime room…" : "Connect needs a live dashboard socket (not HTTP-only)."}
          </p>
        ) : null}
        {errorLabel ? <p className="text-sm text-destructive">{errorLabel}</p> : null}
        {fallbackLabel && fallbackLabel !== errorLabel ? (
          <p className="text-sm text-amber-700 dark:text-amber-400">
            {fallbackLabel}
            {jpegFallbackReason === "mf_class_missing"
              ? " Install it from Admin → Windows → Capabilities (Media Feature Pack)."
              : null}
          </p>
        ) : null}
        {!windowsLive ? (
          <p className="text-xs text-muted-foreground">H.264 and loopback audio are Windows-only. This device stays on JPEG.</p>
        ) : null}
        <div className="flex flex-wrap items-end gap-3">
          <Field className="w-28">
            <FieldLabel>Quality</FieldLabel>
            <NumberInput value={quality} min={10} max={90} onValueChange={setQuality} />
          </Field>
          <Field className="w-24">
            <FieldLabel>FPS</FieldLabel>
            <NumberInput value={fps} min={1} max={15} onValueChange={setFps} />
          </Field>
          <Field className="w-28">
            <FieldLabel>Max width</FieldLabel>
            <NumberInput value={maxWidth} min={640} max={3840} onValueChange={setMaxWidth} />
          </Field>
          <Field className="w-44">
            <FieldLabel>Display</FieldLabel>
            <Select items={displayItems} value={String(display)} onValueChange={(v) => setDisplay(Number(v))}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {displayItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <ToggleGroup value={[viewMode]} onValueChange={(v) => setViewMode((v[0] as ViewMode) || "fit")} spacing={1}>
            <ToggleGroupItem value="fit">Fit</ToggleGroupItem>
            <ToggleGroupItem value="1:1">1:1</ToggleGroupItem>
          </ToggleGroup>
          <Button size="sm" variant="outline" onClick={() => void toggleFullscreen()}>
            Fullscreen
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{captureLabel}</p>
        {inputUnsupported ? (
          <p className="text-xs text-muted-foreground">This agent does not inject keyboard or mouse (Linux/macOS).</p>
        ) : null}
        {!connected && hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
        <div
          ref={wrapRef}
          tabIndex={0}
          className={
            viewMode === "1:1"
              ? "relative max-h-[70vh] overflow-auto rounded-lg bg-black outline-none"
              : "relative h-[min(70vh,560px)] w-full overflow-hidden rounded-lg bg-black outline-none"
          }
          onKeyDown={onKey}
          onKeyUp={onKey}
        >
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted={videoMuted}
            className={showVideo ? (allowInput ? "h-full w-full cursor-crosshair object-contain" : "h-full w-full object-contain") : "hidden"}
            onLoadedData={() => {
              hasFrameRef.current = true
              setHasFrame(true)
              if (frameWatchdog.current) {
                clearTimeout(frameWatchdog.current)
                frameWatchdog.current = null
              }
            }}
            {...pointerProps}
          />
          <canvas
            ref={canvasRef}
            className={showVideo ? "hidden" : allowInput ? "cursor-crosshair outline-none" : "outline-none"}
            {...pointerProps}
          />
          {allowInput && hasFrame && !kbCapture && inputOpen ? (
            <button
              type="button"
              className="absolute inset-0 flex items-center justify-center bg-black/40 text-sm text-white"
              onClick={() => {
                setKbCapture(true)
                wrapRef.current?.focus()
              }}
            >
              Click to capture keyboard
            </button>
          ) : null}
          {errorLabel ? (
            <p className="absolute inset-0 z-10 flex items-center justify-center p-4 text-center text-sm text-red-300">
              {errorLabel}
            </p>
          ) : sessionOn && !hasFrame ? (
            <p className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-muted-foreground">
              Waiting for first frame…
            </p>
          ) : null}
          {!sessionOn && !errorLabel ? (
            <p className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-muted-foreground">
              Connect to start offer/answer. JPEG is the default; Video uses Windows H.264.
            </p>
          ) : null}
          {sessionOn && hasFrame ? (
            <div className="pointer-events-none absolute top-2 left-2 rounded bg-black/60 px-2 py-1 text-[11px] text-white">
              {codecLabel}
              {negotiatedAudio ? " + Opus" : ""} · {fpsLabel} · {bitrateLabel}
            </div>
          ) : null}
        </div>
        <div className="rounded-lg border p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">Clipboard history</span>
            {!sessionOn ? (
              <Badge variant="outline">offline</Badge>
            ) : clipChannelReady ? (
              <Badge variant="outline">sync on</Badge>
            ) : clipSyncStatus === "unsupported" ? (
              <Badge variant="destructive">unavailable</Badge>
            ) : (
              <Badge variant="secondary">connecting…</Badge>
            )}
            <Button size="sm" variant="outline" onClick={() => void sendClipboard()} disabled={!clipChannelReady}>
              Send text
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void sendClipboardImage()}
              disabled={!clipChannelReady}
            >
              Send image
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (!requestClipGet()) toast.error("Clipboard channel not ready yet")
              }}
              disabled={!clipChannelReady}
            >
              Get
            </Button>
            <Button size="sm" variant="outline" onClick={() => void fetchDeviceClipboard()} disabled={fetchingClip}>
              {fetchingClip ? "Fetching…" : "Fetch from device"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setClips((cur) => cur.filter((c) => c.pinned))}
              disabled={!clips.some((c) => !c.pinned)}
            >
              Clear
            </Button>
            <Input
              className="h-8 max-w-xs"
              placeholder="Search clips"
              value={clipSearch}
              onChange={(e) => setClipSearch(e.target.value)}
            />
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ""
                if (file) void sendClipboardImage(file)
              }}
            />
          </div>
          <Input
            className="mb-2"
            placeholder="Text to send (or leave empty to use the local clipboard)"
            value={clipText}
            onChange={(e) => setClipText(e.target.value)}
            disabled={!clipChannelReady}
          />
          {clipStatusLabel ? (
            <p className={`mb-2 text-xs ${clipSyncError ? "text-destructive" : "text-muted-foreground"}`}>{clipStatusLabel}</p>
          ) : null}
          {clipboardNote ? (
            <p className="mb-2 text-xs text-muted-foreground">{clipboardNote}</p>
          ) : null}
          <ul className="max-h-48 space-y-1 overflow-auto text-sm">
            {filteredClips.length === 0 ? (
              <li className="rounded-md border border-dashed px-2 py-3 text-xs text-muted-foreground">
                {!sessionOn
                  ? "No clips yet. Use Fetch from device, or start a remote desktop session for live sync."
                  : !clipboardSupported
                    ? "Clipboard history unavailable on this agent."
                    : !inputOpen
                      ? "Input channel opening — history will populate automatically."
                      : "No clips yet. Copy on the remote device, click Get, or send from this dashboard."}
              </li>
            ) : (
              filteredClips.map((c) => {
                const thumb = imageSrc(c)
                const preview = c.text || c.files?.join(", ") || c.html || (c.kind === "image" ? "image" : "")
                return (
                  <li key={c.id} className="flex items-start gap-2 rounded-md border px-2 py-1">
                    {thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={thumb} alt="" className="mt-1 h-10 w-10 shrink-0 rounded object-cover" />
                    ) : null}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge variant="outline">{c.kind}</Badge>
                        {(c.formats ?? []).filter((f) => f !== c.kind).map((f) => (
                          <Badge key={f} variant="outline">
                            {f}
                          </Badge>
                        ))}
                        {c.pinned ? <Badge variant="secondary">pinned</Badge> : null}
                        <Badge variant="outline">{c.from}</Badge>
                        <span className="text-[11px] text-muted-foreground">{new Date(c.at).toLocaleTimeString()}</span>
                      </div>
                      <p className="truncate font-mono text-xs" title={preview}>
                        {preview || "—"}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setClips((cur) => cur.map((x) => (x.id === c.id ? { ...x, pinned: !x.pinned } : x)))
                        }
                      >
                        {c.pinned ? "Unpin" : "Pin"}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void copyLocal(c)}>
                        Copy
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!clipChannelReady}
                        onClick={() => sendClipEntry(c)}
                      >
                        Send
                      </Button>
                    </div>
                  </li>
                )
              })
            )}
          </ul>
        </div>
      </CardContent>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Enable remote mouse and keyboard?</AlertDialogTitle>
            <AlertDialogDescription>
              Input events are sent to this device over the WebRTC data channel. This is in addition to view-only desktop.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmOpen(false)
                void start(true)
              }}
              disabled={!signalingReady}
            >
              Allow input and connect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
