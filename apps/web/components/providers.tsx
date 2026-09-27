"use client"

import * as React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { io, type Socket } from "socket.io-client"
import { TriangleAlertIcon } from "lucide-react"
import { toast } from "sonner"
import { WS_EVENTS, WS_PATH } from "@workspace/shared"

import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "@workspace/ui/components/sonner"
import { TooltipProvider } from "@workspace/ui/components/tooltip"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import { applyBulkCommandResult, pendingBulkCommandIds } from "@/lib/bulk-command-progress"
import { api, operatorToken, syncOperatorCookie, wsUrl } from "@/lib/api"
import { RT_CLIENT_EVENTS, type AttachPayload, type RealtimeStatus } from "@/lib/realtime"

type RealtimeContextValue = {
  socket: Socket | null
  status: RealtimeStatus
  lastError: string | null
  reconnect: () => void
  /** Device ids from the last successful attach ack. */
  attachedIds: readonly string[]
  /** Ref-counted per-device room subscription; returns the matching unsubscribe. */
  subscribeDevice: (deviceId: string) => () => void
}

const RealtimeContext = React.createContext<RealtimeContextValue>({
  socket: null,
  status: "connecting",
  lastError: null,
  reconnect: () => {},
  attachedIds: [],
  subscribeDevice: () => () => {},
})

export function useSocket(): Socket | null {
  return React.useContext(RealtimeContext).socket
}

export function useRealtime(): RealtimeContextValue {
  return React.useContext(RealtimeContext)
}

/** Joins the per-device room while the calling component is mounted. */
export function useDeviceSubscription(deviceId: string | null | undefined) {
  const { subscribeDevice } = React.useContext(RealtimeContext)
  React.useEffect(() => {
    if (!deviceId) return
    return subscribeDevice(deviceId)
  }, [deviceId, subscribeDevice])
}

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { refetchOnWindowFocus: true, staleTime: 10_000 },
    },
  })
}

/** Query keys the dashboard polls while the socket is down, so a dead socket never freezes the console. */
const FALLBACK_POLL_KEYS: Array<unknown[]> = [["overview"], ["devices"], ["device"], ["commands"], ["logs"]]
const FALLBACK_POLL_MS = 15_000
/** Socket events are bursty (bulk commands emit hundreds); invalidations are coalesced into this window. */
const INVALIDATE_COALESCE_MS = 400

function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((id) => set.has(id))
}

function payloadDeviceId(payload: unknown, alsoId = false): string | undefined {
  if (!payload || typeof payload !== "object") return undefined
  const rec = payload as { deviceId?: unknown; id?: unknown }
  if (typeof rec.deviceId === "string" && rec.deviceId) return rec.deviceId
  if (alsoId && typeof rec.id === "string" && rec.id) return rec.id
  return undefined
}

type LiveAlert = { type: string; title: string; body: string; deviceId?: string }

function parseLiveAlert(payload: unknown): LiveAlert | null {
  if (!payload || typeof payload !== "object") return null
  const rec = payload as { type?: unknown; title?: unknown; body?: unknown; deviceId?: unknown }
  const type = typeof rec.type === "string" && rec.type ? rec.type : "alert"
  const title =
    typeof rec.title === "string" && rec.title.trim() ? rec.title : type.replaceAll("_", " ")
  const body = typeof rec.body === "string" ? rec.body : ""
  const deviceId = typeof rec.deviceId === "string" && rec.deviceId ? rec.deviceId : undefined
  return { type, title, body, deviceId }
}

function toastLiveAlert(alert: LiveAlert) {
  const description = alert.body || undefined
  if (alert.type === "device_online") {
    toast.success(alert.title, { description })
    return
  }
  if (alert.type === "kill_switch" || alert.type === "command_failure" || alert.type === "device_offline") {
    toast.error(alert.title, { description })
    return
  }
  toast.warning(alert.title, { description })
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(makeClient)
  const [socket, setSocket] = React.useState<Socket | null>(null)
  const [status, setStatus] = React.useState<RealtimeStatus>("connecting")
  const [lastError, setLastError] = React.useState<string | null>(null)
  const [attachedIds, setAttachedIds] = React.useState<string[]>([])
  const [alertBanner, setAlertBanner] = React.useState<LiveAlert | null>(null)
  const socketRef = React.useRef<Socket | null>(null)
  const subscriptionsRef = React.useRef(new Map<string, number>())
  const lastAttachSentRef = React.useRef<string[]>([])
  const attachedIdsRef = React.useRef<string[]>([])
  attachedIdsRef.current = attachedIds

  React.useEffect(() => {
    syncOperatorCookie()
  }, [])

  const clearAttached = React.useCallback(() => {
    lastAttachSentRef.current = []
    attachedIdsRef.current = []
    setAttachedIds([])
  }, [])

  const syncAttach = React.useCallback(() => {
    const instance = socketRef.current
    if (!instance?.connected) return
    const next = [...subscriptionsRef.current.keys()]
    const prev = [...new Set([...lastAttachSentRef.current, ...attachedIdsRef.current])]
    if (next.length === 0) {
      if (prev.length) instance.emit(RT_CLIENT_EVENTS.DETACH, { deviceIds: prev })
      lastAttachSentRef.current = []
      attachedIdsRef.current = []
      setAttachedIds([])
      return
    }
    lastAttachSentRef.current = next
    const payload: AttachPayload = { deviceIds: next }
    instance.emit(RT_CLIENT_EVENTS.ATTACH, payload, (raw: unknown) => {
      if (!sameIdSet(lastAttachSentRef.current, next)) return
      const rec = raw && typeof raw === "object" ? (raw as { ok?: unknown }) : null
      if (rec && rec.ok === false) {
        attachedIdsRef.current = []
        setAttachedIds([])
        return
      }
      attachedIdsRef.current = next
      setAttachedIds(next)
    })
  }, [])

  const subscribeDevice = React.useCallback(
    (deviceId: string) => {
      const current = subscriptionsRef.current.get(deviceId) ?? 0
      subscriptionsRef.current.set(deviceId, current + 1)
      if (current === 0) syncAttach()
      return () => {
        const count = subscriptionsRef.current.get(deviceId) ?? 0
        if (count <= 1) {
          subscriptionsRef.current.delete(deviceId)
          syncAttach()
        } else {
          subscriptionsRef.current.set(deviceId, count - 1)
        }
      }
    },
    [syncAttach]
  )

  const reconnect = React.useCallback(() => {
    const instance = socketRef.current
    if (!instance || instance.connected) return
    setStatus((prev) => (prev === "offline" ? "reconnecting" : prev))
    instance.connect()
  }, [])

  React.useEffect(() => {
    const instance = io(wsUrl() || undefined, {
      path: WS_PATH,
      withCredentials: true,
      transports: ["websocket", "polling"],
      reconnectionAttempts: 30,
      reconnectionDelayMax: 15_000,
      auth: operatorToken() ? { token: operatorToken() } : undefined,
    })
    socketRef.current = instance

    // --- coalesced invalidation ---------------------------------------------
    const pendingKeys = new Map<string, unknown[]>()
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleInvalidate = (...keys: Array<unknown[]>) => {
      for (const key of keys) pendingKeys.set(JSON.stringify(key), key)
      if (flushTimer) return
      flushTimer = setTimeout(() => {
        flushTimer = null
        const toFlush = [...pendingKeys.values()]
        pendingKeys.clear()
        for (const queryKey of toFlush) void client.invalidateQueries({ queryKey })
      }, INVALIDATE_COALESCE_MS)
    }

    // --- event handlers ------------------------------------------------------
    const onDeviceStatus = (payload: unknown) => {
      const deviceId = payloadDeviceId(payload, true)
      scheduleInvalidate(["overview"], ["devices"], ...(deviceId ? [["device", deviceId]] : []))
    }
    const onCommand = (payload: unknown) => {
      const deviceId = payloadDeviceId(payload)
      scheduleInvalidate(["commands"], ["overview"], ...(deviceId ? [["device", deviceId]] : []))
    }
    const onCommandResult = (payload: unknown) => {
      applyBulkCommandResult(payload)
      const rec = payload && typeof payload === "object" ? (payload as { status?: unknown }) : null
      if (rec?.status === "running") return
      onCommand(payload)
    }
    const onScreenshot = (payload: unknown) => {
      const deviceId = payloadDeviceId(payload)
      if (deviceId) scheduleInvalidate(["device", deviceId])
    }
    const onAlert = (payload: unknown) => {
      const alert = parseLiveAlert(payload)
      if (alert) {
        toastLiveAlert(alert)
        setAlertBanner(alert)
      }
      scheduleInvalidate(["overview"])
    }

    // --- connection lifecycle ------------------------------------------------
    let reportedFailure = false
    const onConnect = () => {
      setStatus("online")
      setLastError(null)
      reportedFailure = false
      syncAttach()
    }
    const onDisconnect = (reason: string) => {
      clearAttached()
      if (reason === "io client disconnect") return
      setStatus("reconnecting")
    }
    const onConnectError = (error: Error) => {
      setLastError(error.message || "connection error")
      setStatus((prev) => (prev === "online" ? "reconnecting" : prev))
    }
    const onReconnectFailed = () => {
      clearAttached()
      setStatus("offline")
      if (!reportedFailure) {
        reportedFailure = true
        toast.error("Realtime connection lost — dashboard is polling until it reconnects.")
      }
    }
    instance.on("connect", onConnect)
    instance.on("disconnect", onDisconnect)
    instance.on("connect_error", onConnectError)
    instance.io.on("reconnect_failed", onReconnectFailed)

    const resume = () => {
      if (socketRef.current && !socketRef.current.connected) {
        setStatus((prev) => (prev === "offline" ? "reconnecting" : prev))
        socketRef.current.connect()
      }
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") resume()
    }
    window.addEventListener("online", resume)
    document.addEventListener("visibilitychange", onVisible)

    instance.on(WS_EVENTS.DEVICE_STATUS, onDeviceStatus)
    instance.on(WS_EVENTS.COMMAND_QUEUED, onCommand)
    instance.on(WS_EVENTS.COMMAND_RESULT, onCommandResult)
    instance.on(WS_EVENTS.SCREENSHOT_READY, onScreenshot)
    instance.on(WS_EVENTS.ALERT, onAlert)
    setSocket(instance)
    return () => {
      window.removeEventListener("online", resume)
      document.removeEventListener("visibilitychange", onVisible)
      if (flushTimer) clearTimeout(flushTimer)
      instance.off(WS_EVENTS.DEVICE_STATUS, onDeviceStatus)
      instance.off(WS_EVENTS.COMMAND_QUEUED, onCommand)
      instance.off(WS_EVENTS.COMMAND_RESULT, onCommandResult)
      instance.off(WS_EVENTS.SCREENSHOT_READY, onScreenshot)
      instance.off(WS_EVENTS.ALERT, onAlert)
      instance.off("connect", onConnect)
      instance.off("disconnect", onDisconnect)
      instance.off("connect_error", onConnectError)
      instance.io.off("reconnect_failed", onReconnectFailed)
      socketRef.current = null
      instance.close()
    }
  }, [client, syncAttach, clearAttached])

  // Polling fallback: while the socket is down, keep mounted queries fresh.
  React.useEffect(() => {
    if (status === "online") return
    const timer = setInterval(() => {
      for (const queryKey of FALLBACK_POLL_KEYS) {
        void client.invalidateQueries({ queryKey, refetchType: "active" })
      }
    }, FALLBACK_POLL_MS)
    return () => clearInterval(timer)
  }, [status, client])

  React.useEffect(() => {
    if (status === "online") return
    let cancelled = false
    const tick = async () => {
      const ids = pendingBulkCommandIds()
      for (const id of ids) {
        if (cancelled) return
        try {
          const data = await api<{ command: { id: string; status: string } }>(`/api/v1/admin/commands/${id}`)
          applyBulkCommandResult(data.command)
        } catch {
          /* ignore missing/transient */
        }
      }
    }
    const timer = setInterval(() => void tick(), 2_000)
    void tick()
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [status])

  const realtime = React.useMemo<RealtimeContextValue>(
    () => ({ socket, status, lastError, reconnect, attachedIds, subscribeDevice }),
    [socket, status, lastError, reconnect, attachedIds, subscribeDevice]
  )

  return (
    <ThemeProvider>
      <TooltipProvider>
        <QueryClientProvider client={client}>
          <RealtimeContext.Provider value={realtime}>
            {alertBanner ? (
              <Alert
                variant={
                  alertBanner.type === "kill_switch" ||
                  alertBanner.type === "command_failure" ||
                  alertBanner.type === "device_offline"
                    ? "destructive"
                    : "default"
                }
                className="rounded-none border-x-0 border-t-0"
              >
                <TriangleAlertIcon />
                <AlertTitle>{alertBanner.title}</AlertTitle>
                {alertBanner.body ? <AlertDescription>{alertBanner.body}</AlertDescription> : null}
                <AlertAction>
                  <Button size="sm" variant="ghost" onClick={() => setAlertBanner(null)}>
                    Dismiss
                  </Button>
                </AlertAction>
              </Alert>
            ) : null}
            {children}
          </RealtimeContext.Provider>
          <Toaster />
        </QueryClientProvider>
      </TooltipProvider>
    </ThemeProvider>
  )
}
