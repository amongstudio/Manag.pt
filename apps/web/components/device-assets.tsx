"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { MetricsTable } from "@/components/alerts-page"
import { api, formatWhen } from "@/lib/api"
import { Button } from "@workspace/ui/components/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table"

type Inventory = {
  hardware: { manufacturer: string; model: string; serial: string; chassis: string; collectedAt: string } | null
  os: { name: string; version: string; build: string; arch: string; collectedAt: string } | null
  cpus: Array<{ id: string; name: string; cores: number; threads: number }>
  memory: Array<{ id: string; bank: string; sizeBytes: string; manufacturer: string; serial: string }>
  disks: Array<{ id: string; name: string; model: string; serial: string; sizeBytes: string }>
  volumes: Array<{ id: string; mount: string; fs: string; sizeBytes: string; freeBytes: string }>
  software: Array<{ name: string; version: string; publisher: string; collectedAt: string }>
  users: Array<{ id: string; name: string; sid: string; local: boolean; disabled: boolean }>
  services: Array<{ id: string; name: string; state: string; startType: string }>
}

function useInventory(deviceId: string) {
  return useQuery({
    queryKey: ["inventory", deviceId],
    queryFn: () => api<Inventory>(`/api/v1/admin/devices/${deviceId}/inventory`),
  })
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
          {(data?.volumes ?? []).map((row) => (
            <TableRow key={row.id}>
              <TableCell>{row.mount}</TableCell>
              <TableCell>{row.fs}</TableCell>
              <TableCell>{row.freeBytes}</TableCell>
              <TableCell>{row.sizeBytes}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

export function DeviceSoftware({ deviceId }: { deviceId: string }) {
  const inventory = useInventory(deviceId)
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
        {(inventory.data?.software ?? []).map((row) => (
          <TableRow key={`${row.name}-${row.version}`}>
            <TableCell>{row.name}</TableCell>
            <TableCell>{row.version}</TableCell>
            <TableCell>{row.publisher}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export function DeviceUsers({ deviceId }: { deviceId: string }) {
  const inventory = useInventory(deviceId)
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>SID</TableHead>
          <TableHead>Local</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {(inventory.data?.users ?? []).map((row) => (
          <TableRow key={row.id}>
            <TableCell>{row.name}</TableCell>
            <TableCell>{row.sid}</TableCell>
            <TableCell>{row.local ? "yes" : "no"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
