import { Prisma, prisma } from "@workspace/db"

export type LatestStat = {
  id: string
  deviceId: string
  timestamp: Date
  cpu: number
  ram: number
  disk: number
  gpu: number | null
  temp: number | null
  netUp: number | null
  netDown: number | null
  processes: string
  extras: string | null
}

type RawLatestStat = Omit<LatestStat, "timestamp"> & { timestamp: Date | string }

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

/** Latest Stat row per device via MAX(timestamp) group + join (SQLite-friendly). */
export async function latestStatsByDeviceIds(deviceIds: string[]): Promise<Map<string, LatestStat>> {
  const byDevice = new Map<string, LatestStat>()
  if (deviceIds.length === 0) return byDevice

  const rows = await prisma.$queryRaw<RawLatestStat[]>(Prisma.sql`
    SELECT s.id, s.deviceId, s.timestamp, s.cpu, s.ram, s.disk, s.gpu, s.temp, s.netUp, s.netDown, s.processes, s.extras
    FROM Stat s
    INNER JOIN (
      SELECT deviceId, MAX(timestamp) AS maxTs
      FROM Stat
      WHERE deviceId IN (${Prisma.join(deviceIds)})
      GROUP BY deviceId
    ) latest ON s.deviceId = latest.deviceId AND s.timestamp = latest.maxTs
  `)

  for (const row of rows) {
    if (byDevice.has(row.deviceId)) continue
    byDevice.set(row.deviceId, { ...row, timestamp: asDate(row.timestamp) })
  }
  return byDevice
}
