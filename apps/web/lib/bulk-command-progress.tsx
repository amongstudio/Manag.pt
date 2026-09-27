"use client"

import * as React from "react"

const TERMINAL = new Set(["success", "failed", "cancelled"])
/** How long a finished batch keeps showing "n/n done" before it clears. */
const DONE_LINGER_MS = 8_000
/** Batches with no progress for this long are dropped so the label can't stick forever. */
const STALE_AFTER_MS = 10 * 60_000
const SWEEP_INTERVAL_MS = 5_000
/** Terminal results remembered to close the "result arrived before track()" race. */
const RECENT_TERMINAL_CAP = 500

type Batch = {
  ids: Set<string>
  done: Set<string>
  updatedAt: number
  doneAt: number | null
}

type Snapshot = {
  done: number
  total: number
  active: boolean
  label: string | null
}

const EMPTY: Snapshot = { done: 0, total: 0, active: false, label: null }

let nextBatchId = 0
const batches = new Map<number, Batch>()
/** Insertion-ordered set of recently seen terminal command ids. */
const recentTerminal = new Set<string>()
let snapshot: Snapshot = EMPTY
let sweepTimer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<() => void>()

function recompute() {
  let total = 0
  let done = 0
  for (const batch of batches.values()) {
    total += batch.ids.size
    done += batch.done.size
  }
  snapshot = total > 0 ? { done, total, active: true, label: `${done}/${total} done` } : EMPTY
  for (const listener of listeners) listener()
}

function sweep() {
  const now = Date.now()
  let changed = false
  for (const [key, batch] of batches) {
    const finished = batch.doneAt != null && now - batch.doneAt >= DONE_LINGER_MS
    const stale = now - batch.updatedAt >= STALE_AFTER_MS
    if (finished || stale) {
      batches.delete(key)
      changed = true
    }
  }
  if (batches.size === 0 && sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
  if (changed) recompute()
}

function ensureSweep() {
  if (!sweepTimer) sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS)
}

function rememberTerminal(id: string) {
  recentTerminal.delete(id)
  recentTerminal.add(id)
  if (recentTerminal.size > RECENT_TERMINAL_CAP) {
    const oldest = recentTerminal.values().next().value
    if (oldest !== undefined) recentTerminal.delete(oldest)
  }
}

/** Start tracking a new bulk batch. Concurrent batches aggregate instead of replacing each other. */
export function trackBulkCommands(ids: string[]) {
  const unique = [...new Set(ids.filter(Boolean))]
  if (!unique.length) return
  const now = Date.now()
  const batch: Batch = { ids: new Set(unique), done: new Set(), updatedAt: now, doneAt: null }
  // Results can arrive over the socket before the POST response registers the batch.
  for (const id of unique) {
    if (recentTerminal.has(id)) batch.done.add(id)
  }
  if (batch.done.size === batch.ids.size) batch.doneAt = now
  batches.set(nextBatchId++, batch)
  ensureSweep()
  recompute()
}

export function applyBulkCommandResult(payload: unknown) {
  if (!payload || typeof payload !== "object") return
  const rec = payload as { id?: unknown; status?: unknown }
  if (typeof rec.id !== "string" || typeof rec.status !== "string") return
  if (!TERMINAL.has(rec.status)) return
  rememberTerminal(rec.id)
  let changed = false
  const now = Date.now()
  for (const batch of batches.values()) {
    if (!batch.ids.has(rec.id) || batch.done.has(rec.id)) continue
    batch.done.add(rec.id)
    batch.updatedAt = now
    if (batch.done.size === batch.ids.size) batch.doneAt = now
    changed = true
  }
  if (changed) recompute()
}

const PENDING_POLL_CAP = 40

/** Incomplete tracked command ids for HTTP fallback while Socket.io is down. */
export function pendingBulkCommandIds(limit = PENDING_POLL_CAP): string[] {
  const out: string[] = []
  for (const batch of batches.values()) {
    for (const id of batch.ids) {
      if (batch.done.has(id)) continue
      out.push(id)
      if (out.length >= limit) return out
    }
  }
  return out
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): Snapshot {
  return snapshot
}

function getServerSnapshot(): Snapshot {
  return EMPTY
}

export function useBulkCommandProgress(): Snapshot {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

export function BulkProgressLabel({ className }: { className?: string }) {
  const { label } = useBulkCommandProgress()
  if (!label) return null
  return <span className={className ?? "text-sm tabular-nums text-muted-foreground"}>{label}</span>
}
