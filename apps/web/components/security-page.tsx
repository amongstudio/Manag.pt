"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { parseScanToolsResult, scanToolInstallConfirm, type ScanTool } from "@workspace/shared"

import { api, formatWhen } from "@/lib/api"
import { runDeviceCommand } from "@/lib/command-poll"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@workspace/ui/components/alert-dialog"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Spinner } from "@workspace/ui/components/spinner"
import { Switch } from "@workspace/ui/components/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table"
import { Tabs, TabsList, TabsTrigger } from "@workspace/ui/components/tabs"

type Device = { id: string; hostname: string }
type Scan = { id: string; deviceId: string; kind: string; target: string; status: string; summary: string; createdAt: string }
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

const HISTORY_FILTERS = [
  { value: "all", label: "All tools" },
  { value: "nmap", label: "Nmap" },
  { value: "nuclei", label: "Nuclei" },
  { value: "trivy", label: "Trivy (host posture)" },
] as const

const KIND_LABEL: Record<string, string> = {
  network_scan: "Nmap",
  nuclei_scan: "Nuclei",
  host_posture: "Host posture / Trivy",
}

function scanSummaryHint(summary: string): string | null {
  const missing = /\b(nmap|nuclei|trivy)_unavailable\b/.exec(summary)
  if (missing) return `${missing[1]} is not installed on the device. Use Scanner tools to install the pinned release.`
  if (summary.includes("trivy_db_missing")) return "Trivy has no vulnerability database. Reinstall Trivy from Scanner tools."
  return null
}

function ScannerTools({ deviceId }: { deviceId: string }) {
  const [status, setStatus] = React.useState<ReturnType<typeof parseScanToolsResult>>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [confirm, setConfirm] = React.useState<ScanTool | null>(null)
  const abort = React.useRef<AbortController | null>(null)
  React.useEffect(() => () => abort.current?.abort(), [])

  const check = useMutation({
    mutationFn: async () => {
      const ac = new AbortController()
      abort.current = ac
      const cmd = await runDeviceCommand(deviceId, "get_scan_tools", {}, { signal: ac.signal, timeoutMs: 120_000 })
      const parsed = parseScanToolsResult(cmd.result)
      if (!parsed) throw new Error("unexpected result")
      return parsed
    },
    onSuccess: (parsed) => {
      setStatus(parsed)
      setError(null)
    },
    onError: (e: Error) => {
      if (e.message !== "aborted") setError(e.message)
    },
  })

  const install = useMutation({
    mutationFn: async (tool: ScanTool) => {
      toast.info(`Installing ${tool}… this can take several minutes.`)
      const ac = new AbortController()
      abort.current = ac
      const cmd = await runDeviceCommand(deviceId, "install_scan_tool", { tool }, { signal: ac.signal, timeoutMs: 30 * 60_000 })
      return { tool, result: (cmd.result ?? {}) as { version?: string; note?: string; dbError?: string; runtimeError?: string } }
    },
    onSuccess: ({ tool, result }) => {
      toast.success(`${tool} ${result.version ?? ""} installed`.trim())
      if (result.dbError) toast.error(`Trivy database download failed: ${result.dbError}`)
      if (result.runtimeError) toast.error(`Visual C++ runtime install failed: ${result.runtimeError}`)
      if (result.note) toast.message(result.note)
      check.mutate()
    },
    onError: (e: Error) => {
      if (e.message !== "aborted") toast.error(e.message === "install_in_flight" ? "An install is already running on this device." : e.message)
    },
  })

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium">Scanner tools</h2>
        <Button size="sm" variant="outline" onClick={() => check.mutate()} disabled={check.isPending}>
          {check.isPending ? <Spinner data-icon="inline-start" /> : null}
          Check tools
        </Button>
        {status ? (
          <Badge variant="outline">{status.rawScan ? "Npcap present: SYN scans and OS detection" : "No Npcap: TCP connect scans"}</Badge>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        The agent looks in its own tools directory, then the service and machine PATH, then Program Files. Install downloads
        the pinned official release, verifies its SHA-256, and records the action in the audit log.
      </p>
      {error ? <p className="text-sm text-destructive">Tool check failed: {error}</p> : null}
      {status ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tool</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Notes</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {status.tools.map((t) => (
              <TableRow key={t.tool}>
                <TableCell className="font-medium">{t.tool}</TableCell>
                <TableCell>
                  <Badge variant={t.available ? "secondary" : "destructive"}>{t.available ? "Available" : "Missing"}</Badge>
                </TableCell>
                <TableCell className="text-xs">
                  {t.version || "—"}
                  {t.pinned ? <span className="text-muted-foreground"> · pinned {t.pinned}</span> : null}
                </TableCell>
                <TableCell className="max-w-56 truncate text-xs" title={t.path}>
                  {t.source || "—"}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{[t.error, ...t.notes].filter(Boolean).join(" · ") || "—"}</TableCell>
                <TableCell>
                  {t.canInstall ? (
                    <Button size="sm" variant="outline" disabled={install.isPending} onClick={() => setConfirm(t.tool)}>
                      {t.available ? "Reinstall pinned" : "Install pinned"}
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
      <AlertDialog open={!!confirm} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Install {confirm}</AlertDialogTitle>
            <AlertDialogDescription>{confirm ? scanToolInstallConfirm(confirm) : ""}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirm) install.mutate(confirm)
                setConfirm(null)
              }}
            >
              Install
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export function SecurityPage() {
  const queryClient = useQueryClient()
  const devices = useQuery({ queryKey: ["devices"], queryFn: () => api<{ devices: Device[] }>("/api/v1/admin/devices") })
  const [historyTool, setHistoryTool] = React.useState<(typeof HISTORY_FILTERS)[number]["value"]>("all")
  const [historyDeviceOnly, setHistoryDeviceOnly] = React.useState(false)
  const [deviceId, setDeviceId] = React.useState("")
  const historyDevice = historyDeviceOnly ? deviceId : ""
  const scans = useQuery({
    queryKey: ["scans", historyTool, historyDevice],
    queryFn: () => {
      const params = new URLSearchParams()
      if (historyTool !== "all") params.set("tool", historyTool)
      if (historyDevice) params.set("deviceId", historyDevice)
      const qs = params.toString()
      return api<{ scans: Scan[] }>(`/api/v1/admin/scans${qs ? `?${qs}` : ""}`)
    },
  })
  const hostnames = new Map((devices.data?.devices ?? []).map((d) => [d.id, d.hostname]))
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
  const [target, setTarget] = React.useState("127.0.0.1")
  const [kind, setKind] = React.useState("network_scan")
  const [scriptId, setScriptId] = React.useState("")
  const scripts = useQuery({ queryKey: ["scripts"], queryFn: () => api<{ scripts: Array<{ id: string; name: string }> }>("/api/v1/admin/scripts") })
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
      {deviceId ? <ScannerTools key={deviceId} deviceId={deviceId} /> : null}
      <div>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-medium">Scan history</h2>
          <Tabs value={historyTool} onValueChange={(value) => setHistoryTool(value as typeof historyTool)}>
            <TabsList>
              {HISTORY_FILTERS.map((f) => (
                <TabsTrigger key={f.value} value={f.value}>
                  {f.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={historyDeviceOnly} onCheckedChange={setHistoryDeviceOnly} disabled={!deviceId} />
            Selected device only
          </label>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Device</TableHead>
              <TableHead>Tool</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Summary</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(scans.data?.scans ?? []).length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground">
                  {scans.isPending ? "Loading…" : scans.isError ? `Could not load scans: ${scans.error.message}` : "No scans for this filter."}
                </TableCell>
              </TableRow>
            ) : (
              (scans.data?.scans ?? []).map((scan) => {
                const hint = scanSummaryHint(scan.summary ?? "")
                return (
                  <TableRow key={scan.id}>
                    <TableCell>{formatWhen(scan.createdAt)}</TableCell>
                    <TableCell>{hostnames.get(scan.deviceId) ?? scan.deviceId}</TableCell>
                    <TableCell>{KIND_LABEL[scan.kind] ?? scan.kind}</TableCell>
                    <TableCell>{scan.target}</TableCell>
                    <TableCell>{scan.status}</TableCell>
                    <TableCell>
                      <div className="max-w-md truncate" title={scan.summary}>
                        {scan.summary}
                      </div>
                      {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex flex-wrap gap-2">
        <Input placeholder="Severity" value={severity} onChange={(e) => setSeverity(e.target.value)} className="max-w-[10rem]" />
        <Input placeholder="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="max-w-[10rem]" />
        <Input placeholder="Port" value={port} onChange={(e) => setPort(e.target.value)} className="max-w-[8rem]" />
        <Input placeholder="Service" value={service} onChange={(e) => setService(e.target.value)} className="max-w-[10rem]" />
        <select className="h-9 rounded-md border bg-background px-2 text-sm" value={scriptId} onChange={(e) => setScriptId(e.target.value)}>
          <option value="">Remediation script</option>
          {(scripts.data?.scripts ?? []).map((script) => (
            <option key={script.id} value={script.id}>
              {script.name}
            </option>
          ))}
        </select>
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
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!scriptId}
                  onClick={() =>
                    api(`/api/v1/admin/findings/${row.id}/link`, { method: "POST", body: JSON.stringify({ scriptId }) }).then(() => {
                      toast.success("Script linked")
                      void queryClient.invalidateQueries({ queryKey: ["findings"] })
                    }).catch((error: Error) => toast.error(error.message))
                  }
                >
                  Link script
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
