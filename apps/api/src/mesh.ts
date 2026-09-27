import type { MeshBundle, MeshPeerHint } from "@workspace/shared"
import { parseStoredLanAddrs, sanitizeLanPort, PEER_LAN_PORT } from "@workspace/shared"
import { prisma } from "@workspace/db"

import { env, dataPath, iceServersForClient } from "./env.js"
import {
  issueAndRecord,
  loadOrCreateMeshCA,
  revokeDeviceMesh,
  revokedSerials,
  type MeshCA,
} from "./mesh-ca.js"

let cached: MeshCA | null = null

export function meshStateFile(): string {
  return dataPath("mesh-state.json")
}

export function getMeshCA(): MeshCA {
  if (!cached) {
    cached = loadOrCreateMeshCA({
      secret: env.updateSigningSecret,
      dataDir: env.dataDir,
    caPem: env.meshCa,
    caKeyPem: env.meshCaKey,
    })
  }
  return cached
}

export function issueMeshBundle(deviceId: string, haveSerial?: string): MeshBundle {
  const ca = getMeshCA()
  const issued = issueAndRecord(ca, meshStateFile(), deviceId, haveSerial)
  const bundle: MeshBundle = {
    ca: ca.certPem,
    serial: issued.serial,
    notAfter: issued.notAfter,
    revokedSerials: issued.revokedSerials,
  }
  if (!issued.reused) {
    bundle.cert = issued.certPem
    bundle.key = issued.keyPem
  }
  return bundle
}

export function meshRevokedSerials(): string[] {
  return revokedSerials(meshStateFile())
}

export function revokeMeshDevice(deviceId: string): void {
  revokeDeviceMesh(meshStateFile(), deviceId)
}

export async function meshPeerHints(exceptId: string): Promise<MeshPeerHint[]> {
  const rows = await prisma.device.findMany({
    select: { id: true, ip: true, lanAddrs: true, lanPort: true },
    orderBy: { lastSeen: "desc" },
    take: 128,
  })
  const out: MeshPeerHint[] = []
  for (const row of rows) {
    if (row.id === exceptId) continue
    out.push({
      id: row.id,
      lanAddrs: parseStoredLanAddrs(row.lanAddrs),
      ip: row.ip,
      lanPort: sanitizeLanPort(row.lanPort) ?? PEER_LAN_PORT,
    })
  }
  return out
}

export async function meshSessionExtras(exceptId: string, ip: string, includePeers: boolean) {
  const extras: {
    iceServers: ReturnType<typeof iceServersForClient>
    ip: string
    meshPeers?: MeshPeerHint[]
  } = {
    iceServers: iceServersForClient(),
    ip,
  }
  if (includePeers) extras.meshPeers = await meshPeerHints(exceptId)
  return extras
}
