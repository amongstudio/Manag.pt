"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, formatWhen } from "@/lib/api"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table"

type Device = { id: string; hostname: string }
type Scan = { id: string; kind: string; target: string; status: string; summary: string; createdAt: string }
type Finding = {
  id: string
  hostIp: string
  source: string
  severity: string
  title: string
  cveId: string
  status: string
  evidence: string
  remediation: string
  scriptId: string | null
}

export function SecurityPage() {
  const queryClient = useQueryClient()
  const devices = useQuery({ queryKey: ["devices"], queryFn: () => api<{ devices: Device[] }>("/api/v1/admin/devices") })
  const scans = useQuery({ queryKey: ["scans"], queryFn: () => api<{ scans: Scan[] }>("/api/v1/admin/scans") })
  const [severity, setSeverity] = React.useState("")
  const [status, setStatus] = React.useState("open")
  const [port, setPort] = React.useState("")
  const [service, setService] = React.useState("")
  const findings = useQuery({
    queryKey: ["findings", severity, status, port, service],
    queryFn: () =>
      api<{ findings: Finding[] }>(
        `/api/v1/admin/findings?severity=${encodeURIComponent(severity)}&status=${encodeURIComponent(status)}&port=${encodeURIComponent(port)}&service=${encodeURIComponent(service)}`
      ),
  })
  const [deviceId, setDeviceId] = React.useState("")
  const [target, setTarget] = React.useState("127.0.0.1")
  const [kind, setKind] = React.useState("network_scan")
  const start = useMutation({
    mutationFn: () =>
      api("/api/v1/admin/scans", { method: "POST", body: JSON.stringify({ deviceId, kind, target: kind === "host_posture" ? "" : target }) }),
    onSuccess: () => {
      toast.success("Scan queued")
      void queryClient.invalidateQueries({ queryKey: ["scans"] })
      void queryClient.invalidateQueries({ queryKey: ["findings"] })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const act = useMutation({
    mutationFn: (input: { id: string; action: string; reason?: string }) =>
      api(`/api/v1/admin/findings/${input.id}/${input.action}`, {
        method: "POST",
        body: JSON.stringify(input.reason ? { reason: input.reason } : {}),
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["findings"] }),
    onError: (error: Error) => toast.error(error.message),
  })

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end gap-2">
        <select className="h-9 rounded-md border bg-background px-2 text-sm" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
          <option value="">Device</option>
          {(devices.data?.devices ?? []).map((device) => (
            <option key={device.id} value={device.id}>
              {device.hostname}
            </option>
          ))}
        </select>
        <select className="h-9 rounded-md border bg-background px-2 text-sm" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="network_scan">Nmap</option>
          <option value="nuclei_scan">Nuclei</option>
          <option value="host_posture">Host posture</option>
        </select>
        <Input value={target} onChange={(e) => setTarget(e.target.value)} className="max-w-xs" placeholder="127.0.0.1" />
        <Button onClick={() => start.mutate()} disabled={!deviceId || start.isPending}>
          Start scan
        </Button>
        <a className="text-sm underline" href="/api/v1/admin/reports/findings.csv">
          Open findings CSV
        </a>
      </div>
      <div>
        <h2 className="mb-2 text-sm font-medium">Scans</h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Summary</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(scans.data?.scans ?? []).map((scan) => (
              <TableRow key={scan.id}>
                <TableCell>{formatWhen(scan.createdAt)}</TableCell>
                <TableCell>{scan.kind}</TableCell>
                <TableCell>{scan.target}</TableCell>
                <TableCell>{scan.status}</TableCell>
                <TableCell>{scan.summary}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex flex-wrap gap-2">
        <Input placeholder="Severity" value={severity} onChange={(e) => setSeverity(e.target.value)} className="max-w-[10rem]" />
        <Input placeholder="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="max-w-[10rem]" />
        <Input placeholder="Port" value={port} onChange={(e) => setPort(e.target.value)} className="max-w-[8rem]" />
        <Input placeholder="Service" value={service} onChange={(e) => setService(e.target.value)} className="max-w-[10rem]" />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Host</TableHead>
            <TableHead>Severity</TableHead>
            <TableHead>Title</TableHead>
            <TableHead>CVE</TableHead>
            <TableHead>Status</TableHead>
            <TableHead></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(findings.data?.findings ?? []).map((row) => (
            <TableRow key={row.id}>
              <TableCell>{row.hostIp}</TableCell>
              <TableCell>{row.severity}</TableCell>
              <TableCell>{row.title}</TableCell>
              <TableCell>{row.cveId}</TableCell>
              <TableCell>{row.status}</TableCell>
              <TableCell className="space-x-2">
                <Button size="sm" variant="outline" onClick={() => act.mutate({ id: row.id, action: "acknowledge" })}>
                  Ack
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const reason = window.prompt("Acceptance reason")
                    if (reason) act.mutate({ id: row.id, action: "accept", reason })
                  }}
                >
                  Accept
                </Button>
                <Button size="sm" variant="outline" disabled={!row.scriptId} onClick={() => act.mutate({ id: row.id, action: "remediate" })}>
                  Remediate
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
