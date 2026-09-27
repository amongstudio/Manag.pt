import { prisma } from "@workspace/db"

import { deviceHasPluginGrant } from "./command-policy.js"

export type PluginSkip = { deviceId: string; reason: string }

export async function pluginGrantedToDevice(pluginId: string, deviceId: string): Promise<boolean> {
  const n = await prisma.plugin.count({
    where: {
      id: pluginId,
      OR: [{ allDevices: true }, { grants: { some: { deviceId } } }],
    },
  })
  return n > 0
}

export async function filterPluginTargets(
  pluginId: string,
  deviceIds: string[]
): Promise<
  | { ok: true; deviceIds: string[]; skipped: PluginSkip[] }
  | { ok: false; status: number; error: string }
> {
  const plugin = await prisma.plugin.findUnique({
    where: { id: pluginId },
    include: { grants: true },
  })
  if (!plugin) return { ok: false, status: 404, error: "plugin_not_found" }
  const devices = await prisma.device.findMany({
    where: { id: { in: deviceIds } },
    select: { id: true, platform: true, arch: true },
  })
  const byId = new Map(devices.map((d) => [d.id, d]))
  const out: string[] = []
  const skipped: PluginSkip[] = []
  for (const id of deviceIds) {
    if (!deviceHasPluginGrant(plugin, id)) {
      skipped.push({ deviceId: id, reason: "grant_denied" })
      continue
    }
    const device = byId.get(id)
    if (!device) {
      skipped.push({ deviceId: id, reason: "not_found" })
      continue
    }
    if (plugin.platform && plugin.platform !== device.platform) {
      skipped.push({ deviceId: id, reason: "platform_mismatch" })
      continue
    }
    if (plugin.arch && plugin.arch !== device.arch) {
      skipped.push({ deviceId: id, reason: "arch_mismatch" })
      continue
    }
    out.push(id)
  }
  return { ok: true, deviceIds: out, skipped }
}
