"use client"

import * as React from "react"

import { useRealtime } from "@/components/providers"
import { realtimeStatusLabel } from "@/lib/realtime"
import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"

const DOT_CLASS = {
  connecting: "bg-muted-foreground animate-pulse",
  online: "bg-primary",
  reconnecting: "bg-muted-foreground animate-pulse",
  offline: "bg-destructive",
} as const

export function ConnectionIndicator({ className }: { className?: string }) {
  const { status, lastError, reconnect } = useRealtime()
  const label = realtimeStatusLabel(status)
  return (
    <span
      className={cn("flex items-center gap-2 text-xs text-muted-foreground", className)}
      title={lastError ? `Realtime: ${label} (${lastError})` : `Realtime: ${label}`}
    >
      <span aria-hidden className={cn("size-2 rounded-full", DOT_CLASS[status])} />
      <span>{label}</span>
      {status === "offline" && lastError ? (
        <span className="max-w-40 truncate">{lastError}</span>
      ) : null}
      {status === "offline" ? (
        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={reconnect}>
          Reconnect
        </Button>
      ) : null}
    </span>
  )
}
