"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, formatWhen } from "@/lib/api"
import { Button } from "@workspace/ui/components/button"
import { Card, CardContent, CardHeader, CardTitle } from "@workspace/ui/components/card"
import { Input } from "@workspace/ui/components/input"
import { Textarea } from "@workspace/ui/components/textarea"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table"

type Script = {
  id: string
  name: string
  description: string
  language: string
  content: string
  timeoutSeconds: number
  updatedAt: string
}

type Run = {
  id: string
  deviceId: string
  language: string
  status: string
  exitCode: number | null
  stdout: string
  stderr: string
  trigger: string
  createdAt: string
}

type Device = { id: string; hostname: string }

export function ScriptsPage() {
  const queryClient = useQueryClient()
  const scripts = useQuery({ queryKey: ["scripts"], queryFn: () => api<{ scripts: Script[] }>("/api/v1/admin/scripts") })
  const runs = useQuery({ queryKey: ["script-runs"], queryFn: () => api<{ runs: Run[] }>("/api/v1/admin/script-runs") })
  const devices = useQuery({ queryKey: ["devices"], queryFn: () => api<{ devices: Device[] }>("/api/v1/admin/devices") })
  const [name, setName] = React.useState("")
  const [language, setLanguage] = React.useState("shell")
  const [content, setContent] = React.useState("echo hello")
  const [deviceId, setDeviceId] = React.useState("")
  const [selected, setSelected] = React.useState<string>("")

  const save = useMutation({
    mutationFn: () =>
      api("/api/v1/admin/scripts", {
        method: "POST",
        body: JSON.stringify({ name, language, content, timeoutSeconds: 60, parameters: [] }),
      }),
    onSuccess: () => {
      toast.success("Script saved")
      void queryClient.invalidateQueries({ queryKey: ["scripts"] })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const run = useMutation({
    mutationFn: () =>
      api(`/api/v1/admin/devices/${deviceId}/scripts/run`, {
        method: "POST",
        body: JSON.stringify({ scriptId: selected }),
      }),
    onSuccess: () => {
      toast.success("Script queued")
      void queryClient.invalidateQueries({ queryKey: ["script-runs"] })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Library</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <select className="h-9 rounded-md border bg-background px-2 text-sm" value={language} onChange={(e) => setLanguage(e.target.value)}>
            <option value="powershell">powershell</option>
            <option value="python">python</option>
            <option value="batch">batch</option>
            <option value="shell">shell</option>
          </select>
          <Textarea value={content} onChange={(e) => setContent(e.target.value)} rows={8} />
          <Button onClick={() => save.mutate()} disabled={save.isPending || !name || !content}>
            Save script
          </Button>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Language</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(scripts.data?.scripts ?? []).map((script) => (
                <TableRow key={script.id} onClick={() => setSelected(script.id)} data-state={selected === script.id ? "selected" : undefined}>
                  <TableCell>{script.name}</TableCell>
                  <TableCell>{script.language}</TableCell>
                  <TableCell>{formatWhen(script.updatedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex flex-wrap gap-2">
            <select className="h-9 rounded-md border bg-background px-2 text-sm" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
              <option value="">Device</option>
              {(devices.data?.devices ?? []).map((device) => (
                <option key={device.id} value={device.id}>
                  {device.hostname}
                </option>
              ))}
            </select>
            <Button variant="outline" disabled={!selected || !deviceId || run.isPending} onClick={() => run.mutate()}>
              Run
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Recent runs</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {(runs.data?.runs ?? []).slice(0, 20).map((row) => (
            <div key={row.id} className="rounded-md border p-3 text-sm">
              <div className="flex justify-between gap-2">
                <span>
                  {row.status} · exit {row.exitCode ?? "—"} · {row.trigger}
                </span>
                <span className="text-muted-foreground">{formatWhen(row.createdAt)}</span>
              </div>
              {row.stdout ? <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs">{row.stdout}</pre> : null}
              {row.stderr ? <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap text-xs text-destructive">{row.stderr}</pre> : null}
            </div>
          ))}
          {!runs.data?.runs.length ? <p className="text-sm text-muted-foreground">No runs yet.</p> : null}
        </CardContent>
      </Card>
    </div>
  )
}
