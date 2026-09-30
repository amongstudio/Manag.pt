"use client"

import { useQuery } from "@tanstack/react-query"

import { api, formatWhen } from "@/lib/api"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table"

type Alert = { id: string; createdAt: string; type: string; title: string; body: string; deviceId: string | null }
type Sample = { id: string; name: string; value: number; labels: string; sampledAt: string }

export function AlertsPage() {
  const alerts = useQuery({ queryKey: ["alerts"], queryFn: () => api<{ alerts: Alert[] }>("/api/v1/admin/alerts") })
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        <a className="underline" href="/api/v1/admin/reports/alerts.csv">
          CSV
        </a>
        {" · "}
        <a className="underline" href="/api/v1/admin/reports/alerts.html">
          HTML
        </a>
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>When</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Title</TableHead>
            <TableHead>Body</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(alerts.data?.alerts ?? []).map((row) => (
            <TableRow key={row.id}>
              <TableCell>{formatWhen(row.createdAt)}</TableCell>
              <TableCell>{row.type}</TableCell>
              <TableCell>{row.title}</TableCell>
              <TableCell className="max-w-md truncate">{row.body}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

export function MetricsTable({ deviceId }: { deviceId: string }) {
  const metrics = useQuery({
    queryKey: ["metrics", deviceId],
    queryFn: () => api<{ samples: Sample[] }>(`/api/v1/admin/devices/${deviceId}/metrics`),
  })
  const rows = metrics.data?.samples ?? []
  const latest = new Map<string, Sample>()
  for (const row of rows) {
    const key = `${row.name}:${row.labels}`
    if (!latest.has(key)) latest.set(key, row)
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Metric</TableHead>
          <TableHead>Value</TableHead>
          <TableHead>Labels</TableHead>
          <TableHead>Sampled</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {[...latest.values()].map((row) => (
          <TableRow key={row.id}>
            <TableCell>{row.name}</TableCell>
            <TableCell>{Number(row.value).toFixed(1)}</TableCell>
            <TableCell className="font-mono text-xs">{row.labels}</TableCell>
            <TableCell>{formatWhen(row.sampledAt)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
