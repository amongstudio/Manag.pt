"use client"

import * as React from "react"
import { toast } from "sonner"
import { SHELL_REASON, WS_EVENTS, type ShellKind } from "@workspace/shared"

import { BrowserShell } from "@/components/browser-shell"
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
import { Button } from "@workspace/ui/components/button"
import { Card, CardContent } from "@workspace/ui/components/card"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { ToggleGroup, ToggleGroupItem } from "@workspace/ui/components/toggle-group"

import "@xterm/xterm/css/xterm.css"

const SHELL_ITEMS = [
  { value: "powershell", label: "PowerShell" },
  { value: "cmd", label: "Command Prompt" },
]

function b64ToBytes(value: string): Uint8Array | null {
  try {
    const bin = atob(value)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

function envelopeDeviceId(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const rec = raw as { deviceId?: unknown }
  return typeof rec.deviceId === "string" ? rec.deviceId : undefined
}

function shellReasonLabel(code: string): string {
  switch (code) {
    case SHELL_REASON.unsupported:
      return "Windows-only"
    case SHELL_REASON.noInteractiveSession:
      return "No interactive session"
    case SHELL_REASON.exit:
      return "Process exited"
    case SHELL_REASON.replaced:
      return "Replaced by a new session"
    case SHELL_REASON.agentOffline:
      return "Agent offline"
    default:
      return code
  }
}

function shellReasonCode(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const rec = raw as { error?: unknown; reason?: unknown; ok?: unknown; message?: unknown; data?: unknown }
  if (rec.ok === false) {
    if (typeof rec.error === "string") return rec.error
    if (typeof rec.reason === "string") return rec.reason
    if (typeof rec.message === "string") return rec.message
    return "shell failed"
  }
  if (typeof rec.error === "string" && rec.data == null) return rec.error
  if (typeof rec.reason === "string" && rec.data == null && rec.ok !== true) return rec.reason
  return undefined
}

function shellError(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const code = shellReasonCode(raw)
  return code ? shellReasonLabel(code) : undefined
}

const CONPTY_FALLBACK = new Set<string>([SHELL_REASON.unsupported, SHELL_REASON.noInteractiveSession])

export type ShellMode = "conpty" | "browser"

function shellOutput(raw: unknown): string | Uint8Array | null {
  if (typeof raw === "string") return raw
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw)
  if (ArrayBuffer.isView(raw)) {
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  }
  if (!raw || typeof raw !== "object") return null
  const rec = raw as {
    data?: unknown
    chunk?: unknown
    payload?: unknown
    encoding?: unknown
    b64?: unknown
  }
  const inner = rec.data ?? rec.chunk ?? rec.payload
  if (typeof inner === "string") {
    if (rec.encoding === "base64" || rec.b64 === true) return b64ToBytes(inner)
    return inner
  }
  if (inner instanceof ArrayBuffer) return new Uint8Array(inner)
  if (ArrayBuffer.isView(inner)) {
    return new Uint8Array(inner.buffer, inner.byteOffset, inner.byteLength)
  }
  return null
}

export function DeviceShell({
  deviceId,
  platform,
  onSessionActive,
}: {
  deviceId: string
  platform: string
  onSessionActive?: (active: boolean) => void
}) {
  const { socket, status: realtimeStatus, attachedIds } = useRealtime()
  const socketRef = React.useRef(socket)
  socketRef.current = socket
  const wrapRef = React.useRef<HTMLDivElement | null>(null)
  const termRef = React.useRef<{
    write: (data: string | Uint8Array) => void
    clear: () => void
    focus: () => void
    dispose: () => void
    cols: number
    rows: number
    fit: () => void
  } | null>(null)
  const sessionOnRef = React.useRef(false)
  const wantedSessionRef = React.useRef(false)

  const [shell, setShell] = React.useState<ShellKind>("powershell")
  const [sessionOn, setSessionOn] = React.useState(false)
  const [confirmOpen, setConfirmOpen] = React.useState(false)
  const [status, setStatus] = React.useState("idle")
  const windows = platform.toLowerCase() === "windows"
  const [mode, setMode] = React.useState<ShellMode>(windows ? "conpty" : "browser")
  sessionOnRef.current = sessionOn
  const signalingReady = realtimeStatus === "online" && attachedIds.includes(deviceId)

  React.useEffect(() => {
    setMode(windows ? "conpty" : "browser")
    setSessionOn(false)
    sessionOnRef.current = false
    wantedSessionRef.current = false
    setStatus("idle")
    setConfirmOpen(false)
  }, [deviceId, windows])

  const useConpty = windows && mode === "conpty"
  const conptyOpen = useConpty && sessionOn

  React.useLayoutEffect(() => {
    onSessionActive?.(conptyOpen)
    return () => onSessionActive?.(false)
  }, [conptyOpen, onSessionActive])

  const switchToBrowser = React.useCallback(
    (reason?: string) => {
      if (sessionOnRef.current && socketRef.current) {
        socketRef.current.emit(WS_EVENTS.SHELL_CLOSE, { type: "shell_close", deviceId })
      }
      setSessionOn(false)
      sessionOnRef.current = false
      wantedSessionRef.current = false
      setMode("browser")
      if (reason) {
        setStatus(reason)
        toast.message(`${reason} — switched to Browser shell`)
      }
    },
    [deviceId]
  )

  const emitOpen = React.useCallback(() => {
    const term = termRef.current
    if (realtimeStatus !== "online" || !socket?.connected) {
      toast.error("Realtime is required for ConPTY. Use Browser shell while HTTP-only.")
      return
    }
    if (!attachedIds.includes(deviceId)) {
      toast.error("Still joining this device’s realtime room")
      return
    }
    const cols = term?.cols || 80
    const rows = term?.rows || 24
    wantedSessionRef.current = true
    socket.emit(WS_EVENTS.SHELL_OPEN, { type: "shell_open", deviceId, shell, cols, rows })
    setSessionOn(true)
    sessionOnRef.current = true
    setStatus("connecting")
    term?.focus()
  }, [socket, deviceId, shell, realtimeStatus, attachedIds])

  const emitClose = React.useCallback(() => {
    wantedSessionRef.current = false
    if (socket) socket.emit(WS_EVENTS.SHELL_CLOSE, { type: "shell_close", deviceId })
    setSessionOn(false)
    sessionOnRef.current = false
    setStatus("closed")
  }, [socket, deviceId])

  React.useEffect(() => {
    const el = wrapRef.current
    if (!el || !useConpty) return
    let disposed = false
    let resizeObserver: ResizeObserver | undefined
    const dataDisposers: Array<{ dispose: () => void }> = []

    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]).then(([{ Terminal }, { FitAddon }]) => {
            if (disposed || !wrapRef.current) return
            const term = new Terminal({
              convertEol: true,
              cursorBlink: true,
              fontSize: 13,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
              theme: {
                background: "#0a0a0a",
                foreground: "#e4e4e7",
                cursor: "#e4e4e7",
                selectionBackground: "#3f3f46",
              },
            })
            const fit = new FitAddon()
            term.loadAddon(fit)
            term.open(wrapRef.current)
            if (disposed) {
              term.dispose()
              return
            }
      fit.fit()
      dataDisposers.push(
        term.onData((data) => {
          const sock = socketRef.current
          if (!sessionOnRef.current || !sock?.connected) return
          sock.emit(WS_EVENTS.SHELL_DATA, { type: "shell_data", deviceId, data })
        })
      )
      dataDisposers.push(
        term.onResize(({ cols, rows }) => {
          const sock = socketRef.current
          if (!sessionOnRef.current || !sock?.connected) return
          sock.emit(WS_EVENTS.SHELL_RESIZE, { type: "shell_resize", deviceId, cols, rows })
        })
      )
      termRef.current = {
        write: (data) => {
          term.write(data)
        },
        clear: () => term.clear(),
        focus: () => term.focus(),
        dispose: () => term.dispose(),
        get cols() {
          return term.cols
        },
        get rows() {
          return term.rows
        },
        fit: () => fit.fit(),
      }
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => {
          try {
            fit.fit()
          } catch {
            /* ignore fit before attach */
          }
        })
        resizeObserver.observe(wrapRef.current)
      }
    })

    return () => {
      disposed = true
      resizeObserver?.disconnect()
      for (const d of dataDisposers) d.dispose()
      if (sessionOnRef.current && socketRef.current) {
        socketRef.current.emit(WS_EVENTS.SHELL_CLOSE, { type: "shell_close", deviceId })
      }
      termRef.current?.dispose()
      termRef.current = null
      wantedSessionRef.current = false
      setSessionOn(false)
      sessionOnRef.current = false
    }
  }, [deviceId, useConpty])

  React.useEffect(() => {
    if (!socket || !useConpty) return
    const forDevice = (raw: unknown) => {
      const id = envelopeDeviceId(raw)
      return !id || id === deviceId
    }
    const onOpen = (raw: unknown) => {
      if (!forDevice(raw)) return
      const err = shellError(raw)
      const code = shellReasonCode(raw)
      if (err) {
        wantedSessionRef.current = false
        setSessionOn(false)
        sessionOnRef.current = false
        setStatus(err)
        termRef.current?.write(`\r\n[${err}]\r\n`)
        if (code && CONPTY_FALLBACK.has(code)) switchToBrowser(err)
        else toast.error(err)
        return
      }
      setSessionOn(true)
      sessionOnRef.current = true
      setStatus("connected")
      termRef.current?.focus()
    }
    const onData = (raw: unknown) => {
      if (!forDevice(raw)) return
      const err = shellError(raw)
      if (err) {
        setStatus(err)
        termRef.current?.write(`\r\n[${err}]\r\n`)
        return
      }
      const out = shellOutput(raw)
      if (out != null) {
        setStatus("connected")
        termRef.current?.write(out)
      }
    }
    const onClose = (raw: unknown) => {
      if (!forDevice(raw)) return
      const err = shellError(raw)
      const code = shellReasonCode(raw)
      wantedSessionRef.current = false
      setSessionOn(false)
      sessionOnRef.current = false
      setStatus(err || "closed")
      termRef.current?.write(err ? `\r\n[${err}]\r\n` : "\r\n[session closed]\r\n")
      if (code && CONPTY_FALLBACK.has(code)) switchToBrowser(err || code)
    }
    socket.on(WS_EVENTS.SHELL_OPEN, onOpen)
    socket.on(WS_EVENTS.SHELL_DATA, onData)
    socket.on(WS_EVENTS.SHELL_CLOSE, onClose)
    return () => {
      socket.off(WS_EVENTS.SHELL_OPEN, onOpen)
      socket.off(WS_EVENTS.SHELL_DATA, onData)
      socket.off(WS_EVENTS.SHELL_CLOSE, onClose)
    }
  }, [socket, deviceId, useConpty, switchToBrowser])

  React.useEffect(() => {
    if (!useConpty) return
    if (realtimeStatus !== "online") {
      if (sessionOnRef.current) {
        wantedSessionRef.current = true
        setSessionOn(false)
        sessionOnRef.current = false
        setStatus("disconnected")
        termRef.current?.write("\r\n[dashboard socket disconnected]\r\n")
      }
      return
    }
    if (wantedSessionRef.current && attachedIds.includes(deviceId) && !sessionOn) {
      emitOpen()
    }
  }, [realtimeStatus, attachedIds, deviceId, useConpty, sessionOn, emitOpen])

  return (
    <>
      {windows ? (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <ToggleGroup
            value={[mode]}
            onValueChange={(value) => {
              const next = (value[0] as ShellMode | undefined) ?? mode
              if (next === "browser" && sessionOn) emitClose()
              setMode(next)
            }}
            spacing={1}
          >
            <ToggleGroupItem value="conpty">ConPTY</ToggleGroupItem>
            <ToggleGroupItem value="browser">Browser</ToggleGroupItem>
          </ToggleGroup>
          <Select items={SHELL_ITEMS} value={shell} onValueChange={(v) => setShell(v as ShellKind)}>
            <SelectTrigger className="w-44" disabled={useConpty && sessionOn}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {SHELL_ITEMS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {useConpty ? (
            sessionOn ? (
              <>
                <Button size="sm" variant="outline" onClick={emitClose}>
                  Close
                </Button>
                <Button size="sm" variant="outline" onClick={() => termRef.current?.clear()}>
                  Clear
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" onClick={() => setConfirmOpen(true)} disabled={!signalingReady}>
                  {status === "closed" || status === "idle" ? "Open" : "Reconnect"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => termRef.current?.clear()}>
                  Clear
                </Button>
              </>
            )
          ) : null}
          {useConpty ? <span className="text-xs text-muted-foreground">{status}</span> : null}
        </div>
      ) : null}
      {useConpty ? (
        <Card>
          <CardContent className="p-0">
            <div ref={wrapRef} className="h-[min(70vh,420px)] w-full overflow-hidden rounded-xl bg-black p-2" />
          </CardContent>
        </Card>
      ) : (
        <BrowserShell deviceId={deviceId} platform={platform} shell={shell} />
      )}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Open an interactive {shell === "cmd" ? "cmd" : "PowerShell"} session?</AlertDialogTitle>
            <AlertDialogDescription>
              This starts a ConPTY shell on the device. If the agent runs as a service it may attach as the logged-on
              user. UTF-8 stdin, resize, and close travel on the dashboard socket.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmOpen(false)
                emitOpen()
              }}
              disabled={!signalingReady}
            >
              Open shell
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
