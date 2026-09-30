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

export async function touchWebrtcSession(deviceId: string, kind?: string): Promise<void> {
  const live: WebrtcMeta = { lastKind: kind, updatedAt: Date.now() }
  webrtcByDevice.set(deviceId, live)
  const id = `webrtc:${deviceId}`
  const existing = await prisma.remoteSession.findUnique({ where: { id } })
  const previous = existing?.meta ? safeMeta(existing.meta) : {}
  const stored = { ...previous, lastKind: kind }
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
      expiresAt: ttlDate(),
    },
  })
  if (!existing) {
    await appendAudit({
      actor: "operator",
      action: "remote_session_start",
      deviceId,
      detail: { kind: "webrtc" },
    })
  }
}

export async function dropWebrtcSession(deviceId: string): Promise<void> {
  webrtcByDevice.delete(deviceId)
  const existing = await prisma.remoteSession.findUnique({ where: { id: `webrtc:${deviceId}` } })
  await prisma.remoteSession.deleteMany({ where: { id: `webrtc:${deviceId}` } })
  if (existing) {
    await appendAudit({
      actor: "operator",
      action: "remote_session_end",
      deviceId,
      detail: { kind: "webrtc" },
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

export async function expireRemoteSessions(): Promise<void> {
  await prisma.remoteSession.deleteMany({ where: { expiresAt: { lte: new Date() } } })
  await prisma.operatorSession.deleteMany({ where: { expiresAt: { lte: new Date() } } })
}
