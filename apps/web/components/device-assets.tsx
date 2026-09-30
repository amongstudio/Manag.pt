"use client"

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query"
import { toast } from "sonner"

import { MetricsTable } from "@/components/alerts-page"
import { api, formatBytes, formatWhen } from "@/lib/api"
import { Button } from "@workspace/ui/components/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table"

type Inventory = {
  hardware: { manufacturer: string; model: string; serial: string; chassis: string; collectedAt: string } | null
  os: { name: string; version: string; build: string; arch: string; collectedAt: string } | null
  cpus: Array<{ id: string; name: string; cores: number; threads: number }>
  memory: Array<{ id: string; bank: string; sizeBytes: string; manufacturer: string; serial: string }>
  disks: Array<{ id: string; name: string; model: string; serial: string; sizeBytes: string }>
  volumes: Array<{ id: string; mount: string; fs: string; sizeBytes: string; freeBytes: string }>
  software: Array<{ id: string; name: string; version: string; publisher: string; collectedAt: string }>
  users: Array<{ id: string; name: string; sid: string; local: boolean; disabled: boolean; collectedAt: string }>
  services: Array<{ id: string; name: string; state: string; startType: string }>
}

function useInventory(deviceId: string) {
  return useQuery({
    queryKey: ["inventory", deviceId],
    queryFn: () => api<Inventory>(`/api/v1/admin/devices/${deviceId}/inventory`),
  })
}

function StatusRow({ query, colSpan, empty }: { query: UseQueryResult<Inventory>; colSpan: number; empty: string }) {
  const text = query.isPending ? "Loading…" : query.isError ? `Could not load inventory: ${query.error.message}` : empty
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="text-muted-foreground">
        {text}
      </TableCell>
    </TableRow>
  )
}

export function DeviceMetrics({ deviceId }: { deviceId: string }) {
  return <MetricsTable deviceId={deviceId} />
}

export function DeviceHardware({ deviceId }: { deviceId: string }) {
  const queryClient = useQueryClient()
  const inventory = useInventory(deviceId)
  const refresh = useMutation({
    mutationFn: () => api(`/api/v1/admin/devices/${deviceId}/inventory/refresh`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Inventory refresh queued")
      void queryClient.invalidateQueries({ queryKey: ["inventory", deviceId] })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const data = inventory.data
  const volumes = data?.volumes ?? []
  return (
    <div className="flex flex-col gap-4">
      <Button size="sm" variant="outline" className="w-fit" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
        Refresh inventory
      </Button>
      <p className="text-sm">
        {data?.hardware
          ? `${data.hardware.manufacturer} ${data.hardware.model} ${data.hardware.serial}`.trim() || "No chassis identity collected."
          : "No hardware row yet."}
      </p>
      <p className="text-sm text-muted-foreground">
        {data?.os ? `${data.os.name} ${data.os.version} ${data.os.arch} · ${formatWhen(data.os.collectedAt)}` : "No operating system snapshot."}
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Volume</TableHead>
            <TableHead>FS</TableHead>
            <TableHead>Free</TableHead>
            <TableHead>Size</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {volumes.length === 0 ? (
            <StatusRow query={inventory} colSpan={4} empty="No volumes reported." />
          ) : (
            volumes.map((row) => (
              <TableRow key={row.id}>
                <TableCell>{row.mount}</TableCell>
                <TableCell>{row.fs}</TableCell>
                <TableCell>{formatBytes(Number(row.freeBytes))}</TableCell>
                <TableCell>{formatBytes(Number(row.sizeBytes))}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  )
}

export function DeviceSoftware({ deviceId }: { deviceId: string }) {
  const inventory = useInventory(deviceId)
  const software = inventory.data?.software ?? []
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Version</TableHead>
          <TableHead>Publisher</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {software.length === 0 ? (
          <StatusRow query={inventory} colSpan={3} empty="No installed software reported." />
        ) : (
          software.map((row, index) => (
            <TableRow key={`${row.name}-${row.version}-${row.publisher}-${index}`}>
              <TableCell>{row.name}</TableCell>
              <TableCell>{row.version}</TableCell>
              <TableCell>{row.publisher}</TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  )
}

export function DeviceUsers({ deviceId }: { deviceId: string }) {
  const inventory = useInventory(deviceId)
  const users = inventory.data?.users ?? []
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>SID</TableHead>
          <TableHead>Local</TableHead>
          <TableHead>Disabled</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {users.length === 0 ? (
          <StatusRow query={inventory} colSpan={4} empty="No user accounts reported. Refresh inventory from the Hardware tab." />
        ) : (
          users.map((row) => (
            <TableRow key={row.id}>
              <TableCell>{row.name}</TableCell>
              <TableCell className="font-mono text-xs">{row.sid || "—"}</TableCell>
              <TableCell>{row.local ? "yes" : "no"}</TableCell>
              <TableCell>{row.disabled ? "yes" : "no"}</TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  )
}
