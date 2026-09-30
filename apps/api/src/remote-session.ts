import { prisma } from "@workspace/db"
import { REMOTE_SESSION_TTL_MS } from "@workspace/shared"

import { appendAudit } from "./audit.js"

export type PersistedE2E = {
  sessionId: string
  deviceId: string
  operatorPub: string
  agentPub?: string
  createdAt: number
}

export type WebrtcMeta = {
  lastKind?: string
  updatedAt: number
}

const webrtcByDevice = new Map<string, WebrtcMeta>()

function safeMeta(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function ttlDate(): Date {
  return new Date(Date.now() + REMOTE_SESSION_TTL_MS)
}

export async function persistE2ESession(session: {
  sessionId: string
  deviceId: string
  operatorPub: string
  agentPub?: string
}): Promise<void> {
  const existing = await prisma.remoteSession.findUnique({ where: { id: session.sessionId }, select: { id: true } })
  await prisma.remoteSession.upsert({
    where: { id: session.sessionId },
    create: {
      id: session.sessionId,
      deviceId: session.deviceId,
      kind: "e2e",
      operatorPub: session.operatorPub,
      agentPub: session.agentPub ?? null,
      expiresAt: ttlDate(),
    },
    update: {
      deviceId: session.deviceId,
      operatorPub: session.operatorPub,
      agentPub: session.agentPub ?? null,
      expiresAt: ttlDate(),
    },
  })
  if (!existing) {
    await appendAudit({
      actor: "operator",
      action: "remote_session_start",
      deviceId: session.deviceId,
      detail: { kind: "e2e", sessionId: session.sessionId },
    })
  }
}

export async function dropE2ESession(sessionId: string): Promise<void> {
  const existing = await prisma.remoteSession.findFirst({ where: { id: sessionId, kind: "e2e" } })
  await prisma.remoteSession.deleteMany({ where: { id: sessionId, kind: "e2e" } })
  if (existing) {
    await appendAudit({
      actor: "operator",
      action: "remote_session_end",
      deviceId: existing.deviceId,
      detail: { kind: "e2e", sessionId },
    })
  }
}

const webrtcWrites = new Map<string, Promise<void>>()

/** Start/end rows for one device must not interleave, or audits double up. */
function serialWebrtc(deviceId: string, work: () => Promise<void>): Promise<void> {
  const next = (webrtcWrites.get(deviceId) ?? Promise.resolve()).catch(() => undefined).then(work)
  webrtcWrites.set(deviceId, next)
  void next.finally(() => {
    if (webrtcWrites.get(deviceId) === next) webrtcWrites.delete(deviceId)
  }).catch(() => undefined)
  return next
}

/** Session rows keep the expiry set at start; signaling does not extend it. */
export function touchWebrtcSession(
  deviceId: string,
  kind?: string,
  opts: { actor?: string; allowInput?: boolean } = {}
): Promise<void> {
  webrtcByDevice.set(deviceId, { lastKind: kind, updatedAt: Date.now() })
  return serialWebrtc(deviceId, () => writeWebrtcTouch(deviceId, kind, opts))
}

async function writeWebrtcTouch(
  deviceId: string,
  kind: string | undefined,
  opts: { actor?: string; allowInput?: boolean }
): Promise<void> {
  const id = `webrtc:${deviceId}`
  const existing = await prisma.remoteSession.findUnique({ where: { id } })
  const previous = existing?.meta ? safeMeta(existing.meta) : {}
  const stored: Record<string, unknown> = { ...previous, lastKind: kind }
  if (opts.actor && !existing) stored.actor = opts.actor
  if (opts.allowInput !== undefined) stored.allowInput = opts.allowInput
  await prisma.remoteSession.upsert({
    where: { id },
    create: {
      id,
      deviceId,
      kind: "webrtc",
      meta: JSON.stringify(stored),
      expiresAt: ttlDate(),
    },
    update: {
      meta: JSON.stringify(stored),
    },
  })
  if (!existing) {
    await appendAudit({
      actor: opts.actor || "operator",
      action: "remote_session_start",
      deviceId,
      detail: { kind: "webrtc", allowInput: opts.allowInput === true },
    })
  } else if (kind === "control" && opts.allowInput !== undefined && previous.allowInput !== opts.allowInput) {
    await appendAudit({
      actor: opts.actor || "operator",
      action: "remote_session_input",
      deviceId,
      detail: { kind: "webrtc", allowInput: opts.allowInput },
    })
  }
}

export function dropWebrtcSession(deviceId: string, opts: { actor?: string; reason?: string } = {}): Promise<void> {
  webrtcByDevice.delete(deviceId)
  return serialWebrtc(deviceId, () => writeWebrtcDrop(deviceId, opts))
}

async function writeWebrtcDrop(deviceId: string, opts: { actor?: string; reason?: string }): Promise<void> {
  const existing = await prisma.remoteSession.findUnique({ where: { id: `webrtc:${deviceId}` } })
  await prisma.remoteSession.deleteMany({ where: { id: `webrtc:${deviceId}` } })
  if (existing) {
    const meta = existing.meta ? safeMeta(existing.meta) : {}
    await appendAudit({
      actor: opts.actor || (typeof meta.actor === "string" ? meta.actor : "operator"),
      action: "remote_session_end",
      deviceId,
      detail: {
        kind: "webrtc",
        reason: opts.reason ?? "hangup",
        durationSec: Math.round((Date.now() - existing.createdAt.getTime()) / 1000),
      },
    })
  }
}

export function webrtcMetaFor(deviceId: string): WebrtcMeta | undefined {
  return webrtcByDevice.get(deviceId)
}

export async function hydrateRemoteSessions(): Promise<PersistedE2E[]> {
  const now = new Date()
  await prisma.remoteSession.deleteMany({ where: { expiresAt: { lte: now } } })
  const rows = await prisma.remoteSession.findMany({ where: { expiresAt: { gt: now } } })
  const e2e: PersistedE2E[] = []
  for (const row of rows) {
    if (row.kind === "e2e") {
      e2e.push({
        sessionId: row.id,
        deviceId: row.deviceId,
        operatorPub: row.operatorPub ?? "",
        agentPub: row.agentPub ?? undefined,
        createdAt: row.createdAt.getTime(),
      })
    }
    if (row.kind === "webrtc") {
      let lastKind: string | undefined
      try {
        const parsed = row.meta ? (JSON.parse(row.meta) as { lastKind?: unknown }) : null
        if (parsed && typeof parsed.lastKind === "string") lastKind = parsed.lastKind
      } catch {
        /* ignore */
      }
      webrtcByDevice.set(row.deviceId, { lastKind, updatedAt: row.updatedAt.getTime() })
    }
  }
  return e2e
}

/** Deletes expired rows; `onWebrtcExpired` lets the caller hang up the agent side. */
export async function expireRemoteSessions(onWebrtcExpired?: (deviceId: string) => void): Promise<void> {
  const now = new Date()
  const webrtc = await prisma.remoteSession.findMany({
    where: { kind: "webrtc", expiresAt: { lte: now } },
    select: { deviceId: true },
  })
  for (const row of webrtc) {
    onWebrtcExpired?.(row.deviceId)
    await dropWebrtcSession(row.deviceId, { reason: "session_expired" })
  }
  await prisma.remoteSession.deleteMany({ where: { expiresAt: { lte: now } } })
  await prisma.operatorSession.deleteMany({ where: { expiresAt: { lte: now } } })
}
