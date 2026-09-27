import { prisma } from "@workspace/db"
import { REMOTE_SESSION_TTL_MS } from "@workspace/shared"

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

function ttlDate(): Date {
  return new Date(Date.now() + REMOTE_SESSION_TTL_MS)
}

export async function persistE2ESession(session: {
  sessionId: string
  deviceId: string
  operatorPub: string
  agentPub?: string
}): Promise<void> {
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
}

export async function dropE2ESession(sessionId: string): Promise<void> {
  await prisma.remoteSession.deleteMany({ where: { id: sessionId, kind: "e2e" } })
}

export async function touchWebrtcSession(deviceId: string, kind?: string): Promise<void> {
  const meta: WebrtcMeta = { lastKind: kind, updatedAt: Date.now() }
  webrtcByDevice.set(deviceId, meta)
  const id = `webrtc:${deviceId}`
  await prisma.remoteSession.upsert({
    where: { id },
    create: {
      id,
      deviceId,
      kind: "webrtc",
      meta: JSON.stringify({ lastKind: kind }),
      expiresAt: ttlDate(),
    },
    update: {
      meta: JSON.stringify({ lastKind: kind }),
      expiresAt: ttlDate(),
    },
  })
}

export async function dropWebrtcSession(deviceId: string): Promise<void> {
  webrtcByDevice.delete(deviceId)
  await prisma.remoteSession.deleteMany({ where: { id: `webrtc:${deviceId}` } })
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
