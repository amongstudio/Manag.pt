import { prisma } from "@workspace/db"

import { normalizeStoredTunnel, type StoredTunnel } from "./tunnel-plan.js"
import { defaultTunnelDeps, TunnelSupervisor, type TunnelStore } from "./tunnel-supervisor.js"

const KEY = "tunnel"

export function prismaTunnelStore(): TunnelStore {
  return {
    async load() {
      const row = await prisma.setting.findUnique({ where: { key: KEY } })
      if (!row) return normalizeStoredTunnel(null)
      try {
        return normalizeStoredTunnel(JSON.parse(row.value) as unknown)
      } catch {
        return normalizeStoredTunnel(null)
      }
    },
    async save(value: StoredTunnel) {
      const json = JSON.stringify(normalizeStoredTunnel(value))
      await prisma.setting.upsert({
        where: { key: KEY },
        create: { key: KEY, value: json },
        update: { value: json },
      })
    },
  }
}

let singleton: TunnelSupervisor | null = null

export function getTunnelSupervisor(): TunnelSupervisor {
  if (!singleton) singleton = new TunnelSupervisor(defaultTunnelDeps(), prismaTunnelStore())
  return singleton
}

export async function resumeTunnelIfEnabled(): Promise<void> {
  await getTunnelSupervisor().resumeIfEnabled()
}

export async function releaseTunnelProcesses(): Promise<void> {
  if (!singleton) return
  await singleton.release()
}
