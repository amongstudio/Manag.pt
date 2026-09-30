import { prisma } from "@workspace/db"

export const METRIC_NAMES = [
  "cpu_pct",
  "ram_pct",
  "disk_free_pct",
  "agent_uptime_sec",
  "boot_time_unix",
  "session_count",
  "service_up",
  "defender_realtime",
] as const

const ALLOWED = new Set<string>(METRIC_NAMES)

export type MetricInput = { name: string; value: number; labels: Record<string, string> }

export function normalizeMetrics(body: unknown): MetricInput[] | null {
  const raw = body && typeof body === "object" ? (body as Record<string, unknown>).samples : body
  if (!Array.isArray(raw)) return null
  const out: MetricInput[] = []
  for (const item of raw.slice(0, 64)) {
    if (!item || typeof item !== "object") continue
    const row = item as Record<string, unknown>
    const name = typeof row.name === "string" ? row.name : ""
    const value = typeof row.value === "number" ? row.value : Number(row.value)
    if (!ALLOWED.has(name) || !Number.isFinite(value)) continue
    const labels: Record<string, string> = {}
    if (row.labels && typeof row.labels === "object" && !Array.isArray(row.labels)) {
      for (const [key, label] of Object.entries(row.labels).slice(0, 6)) {
        if (typeof label === "string" && key.length <= 32) labels[key] = label.slice(0, 64)
      }
    }
    const encoded = JSON.stringify(labels)
    if (encoded.length > 512) continue
    out.push({ name, value, labels })
  }
  return out
}

export async function storeMetrics(deviceId: string, samples: MetricInput[]): Promise<number> {
  if (samples.length === 0) return 0
  const sampledAt = new Date()
  await prisma.metricSample.createMany({
    data: samples.map((sample) => ({
      deviceId,
      name: sample.name,
      value: sample.value,
      labels: JSON.stringify(sample.labels),
      sampledAt,
    })),
  })
  return samples.length
}

export async function pruneMetricSamples(): Promise<void> {
  const cutoff = new Date(Date.now() - 30 * 86400_000)
  await prisma.metricSample.deleteMany({ where: { sampledAt: { lt: cutoff } } })
}
