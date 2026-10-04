"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { MetricsTable } from "@/components/alerts-page"
import { api, formatWhen } from "@/lib/api"
import { Button } from "@workspace/ui/components/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table"

type Inventory = {
  hardware: {
    manufacturer: string
    model: string
    serial: string
    chassis: string
    biosVendor: string
    biosVersion: string
    collectedAt: string
  } | null
  os: {
    name: string
    version: string
    build: string
    arch: string
    hostname: string
    fqdn: string
    kernel: string
    bootTime: string | null
    timezone: string
    domain: string
    gateway: string
    dnsServers: string
    agentVersion: string
    helperVersion: string
    roles: string
    primaryIps: string
    uptimeSec: number
    collectedAt: string
  } | null
  cpus: Array<{ id: string; name: string; cores: number; threads: number; mhz: number }>
  memory: Array<{ id: string; bank: string; sizeBytes: string; speedMhz: number; manufacturer: string }>
  disks: Array<{ id: string; name: string; model: string; serial: string; sizeBytes: string }>
  volumes: Array<{ id: string; mount: string; fs: string; sizeBytes: string; freeBytes: string }>
  adapters: Array<{ id: string; name: string; mac: string; ips: string }>
  software: Array<{ name: string; version: string; publisher: string; source: string; installDate: string; installPath: string; collectedAt: string }>
  users: Array<{ id: string; name: string; sid: string; local: boolean; disabled: boolean }>
  services: Array<{
    id: string
    name: string
    displayName: string
    state: string
    startType: string
    account: string
    binaryPath: string
    listenPorts: string
    configNote: string
  }>
  processes: Array<{ id: string; pid: number; name: string; userName: string; cpu: number; rssBytes: string }>
}

function useInventory(deviceId: string, initial?: Inventory | null) {
  return useQuery({
    queryKey: ["inventory", deviceId],
    queryFn: () => api<Inventory>(`/api/v1/admin/devices/${deviceId}/inventory`),
    initialData: initial ?? undefined,
  })
}

export function DeviceMetrics({ deviceId }: { deviceId: string }) {
  return <MetricsTable deviceId={deviceId} />
}

export function DeviceHardware({ deviceId, initial }: { deviceId: string; initial?: Inventory | null }) {
  const queryClient = useQueryClient()
  const inventory = useInventory(deviceId, initial)
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
        {data?.hardware?.biosVendor || data?.hardware?.biosVersion
          ? `BIOS ${data.hardware.biosVendor} ${data.hardware.biosVersion}`.trim()
          : "No BIOS identity collected."}{" "}
        {data?.hardware?.chassis ? `Chassis ${data.hardware.chassis}.` : ""}
      </p>
      <ServerFacts os={data?.os ?? null} />
      <p className="text-sm text-muted-foreground">
        {(data?.cpus ?? []).map((row) => `${row.name} · ${row.cores} cores · ${row.threads} threads · ${row.mhz} MHz`).join("; ") || "No CPU row."}
      </p>
      <p className="text-sm text-muted-foreground">
        {(data?.memory ?? []).map((row) => `${row.bank || "module"} ${row.sizeBytes} bytes ${row.speedMhz ? `${row.speedMhz} MHz` : ""}`.trim()).join("; ") ||
          "No memory row."}
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
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Adapter</TableHead>
            <TableHead>MAC</TableHead>
            <TableHead>Addresses</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(data?.adapters ?? []).map((row) => (
            <TableRow key={row.id}>
              <TableCell>{row.name}</TableCell>
              <TableCell>{row.mac}</TableCell>
              <TableCell className="max-w-md truncate">{row.ips}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function ServerFacts({ os }: { os: Inventory["os"] }) {
  if (!os) return <p className="text-sm text-muted-foreground">No server snapshot yet.</p>
  const rows = [
    ["Hostname", os.hostname],
    ["FQDN", os.fqdn],
    ["OS", `${os.name} ${os.version} ${os.build} ${os.arch}`.trim()],
    ["Kernel", os.kernel],
    ["Boot", os.bootTime ? formatWhen(os.bootTime) : ""],
    ["Uptime seconds", String(os.uptimeSec || "")],
    ["Timezone", os.timezone],
    ["Domain", os.domain],
    ["Gateway", os.gateway],
    ["DNS", os.dnsServers],
    ["Primary IPs", os.primaryIps],
    ["Roles", os.roles],
    ["Agent", os.agentVersion],
    ["Helper", os.helperVersion],
  ]
  return (
    <div className="flex flex-col gap-1 text-sm">
      <p className="font-medium">Server</p>
      {rows.map(([label, value]) => (
        <p key={label}>
          <span className="text-muted-foreground">{label}: </span>
          {value || "—"}
        </p>
      ))}
    </div>
  )
}

export function DeviceSoftware({ deviceId, initial }: { deviceId: string; initial?: Inventory | null }) {
  const inventory = useInventory(deviceId, initial)
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Version</TableHead>
          <TableHead>Publisher</TableHead>
          <TableHead>Source</TableHead>
          <TableHead>Install path</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {(inventory.data?.software ?? []).slice(0, 200).map((row) => (
          <TableRow key={`${row.name}-${row.version}-${row.source}`}>
            <TableCell>{row.name}</TableCell>
            <TableCell>{row.version}</TableCell>
            <TableCell>{row.publisher}</TableCell>
            <TableCell>{row.source}</TableCell>
            <TableCell className="max-w-xs truncate">{row.installPath || row.installDate}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export function DeviceServiceSnapshot({ deviceId, initial }: { deviceId: string; initial?: Inventory | null }) {
  const inventory = useInventory(deviceId, initial)
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium">Installed services</p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>State</TableHead>
            <TableHead>Start</TableHead>
            <TableHead>Account</TableHead>
            <TableHead>Ports</TableHead>
            <TableHead>Path</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(inventory.data?.services ?? []).slice(0, 200).map((row) => (
            <TableRow key={row.id}>
              <TableCell>{row.displayName || row.name}</TableCell>
              <TableCell>{row.state}</TableCell>
              <TableCell>{row.startType}</TableCell>
              <TableCell>{row.account}</TableCell>
              <TableCell>{row.listenPorts}</TableCell>
              <TableCell className="max-w-xs truncate" title={row.configNote}>
                {row.binaryPath}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="text-sm font-medium">Running processes</p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>PID</TableHead>
            <TableHead>Name</TableHead>
            <TableHead>User</TableHead>
            <TableHead>RSS</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(inventory.data?.processes ?? []).map((row) => (
            <TableRow key={row.id}>
              <TableCell>{row.pid}</TableCell>
              <TableCell>{row.name}</TableCell>
              <TableCell>{row.userName}</TableCell>
              <TableCell>{row.rssBytes}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
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
