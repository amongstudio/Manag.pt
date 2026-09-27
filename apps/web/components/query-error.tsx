"use client"

import * as React from "react"
import { TriangleAlertIcon } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty"
import { cn } from "@workspace/ui/lib/utils"

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return "request failed"
}

/** Full-size error state for pages with no cached data to show. */
export function QueryErrorState({
  title = "Couldn't load data",
  error,
  onRetry,
  className,
}: {
  title?: string
  error?: unknown
  onRetry?: () => void
  className?: string
}) {
  return (
    <Empty className={cn("border", className)}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <TriangleAlertIcon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>
          The API request failed{error ? `: ${errorMessage(error)}` : "."} The data shown may be missing or stale.
        </EmptyDescription>
      </EmptyHeader>
      {onRetry ? (
        <EmptyContent>
          <Button variant="outline" onClick={onRetry}>
            Retry
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  )
}

export function queryErrorBannerMessage(error: unknown, cached: boolean): string {
  const detail = error ? ` (${errorMessage(error)})` : ""
  if (cached) return `Live data unavailable${detail} — showing the last known state.`
  return `Live data unavailable${detail}.`
}

/** Inline banner. Pass `cached` when prior data is still on screen. */
export function QueryErrorBanner({
  error,
  onRetry,
  className,
  cached = false,
}: {
  error?: unknown
  onRetry?: () => void
  className?: string
  cached?: boolean
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm",
        className
      )}
    >
      <TriangleAlertIcon className="size-4 shrink-0 text-destructive" />
      <span>{queryErrorBannerMessage(error, cached)}</span>
      {onRetry ? (
        <Button size="sm" variant="outline" className="ml-auto" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  )
}
