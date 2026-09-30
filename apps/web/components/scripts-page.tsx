"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { SCRIPT_TEMPLATES, type ScriptTemplate } from "@workspace/shared"

import { api, formatWhen } from "@/lib/api"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card"
import { Input } from "@workspace/ui/components/input"
import { Textarea } from "@workspace/ui/components/textarea"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table"

type ParamDef = { name: string; default?: string; pattern?: string }

type Script = {
  id: string
  name: string
  description: string
  language: string
  content: string
  timeoutSeconds: number
  parameters: string
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

const PARAM_TOKEN = /\{\{([A-Za-z0-9_]+)\}\}/g

function parseParams(raw: string): ParamDef[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as ParamDef[]).filter((p) => p && typeof p.name === "string") : []
  } catch {
    return []
  }
}

/** Parameter names referenced in the content, in first-use order. */
function referencedParams(content: string): string[] {
  return [...new Set([...content.matchAll(PARAM_TOKEN)].map((m) => m[1]!))].slice(0, 20)
}

function patternOk(pattern: string | undefined, value: string): boolean {
  if (!pattern) return !/[\r\n\0]/.test(value)
  try {
    return new RegExp(pattern).test(value)
  } catch {
    return false
  }
}

function ParameterInputs({
  params,
  values,
  onChange,
}: {
  params: ParamDef[]
  values: Record<string, string>
  onChange: (next: Record<string, string>) => void
}) {
  if (!params.length) return null
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {params.map((p) => {
        const value = values[p.name] ?? p.default ?? ""
        const ok = patternOk(p.pattern, value)
        return (
          <label key={p.name} className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">
              {p.name}
              {p.pattern ? <span className="font-mono"> {p.pattern}</span> : null}
            </span>
            <Input
              value={value}
              aria-invalid={!ok}
              onChange={(e) => onChange({ ...values, [p.name]: e.target.value })}
            />
          </label>
        )
      })}
    </div>
  )
}

export function ScriptsPage() {
  const queryClient = useQueryClient()
  const scripts = useQuery({ queryKey: ["scripts"], queryFn: () => api<{ scripts: Script[] }>("/api/v1/admin/scripts") })
  const runs = useQuery({ queryKey: ["script-runs"], queryFn: () => api<{ runs: Run[] }>("/api/v1/admin/script-runs") })
  const devices = useQuery({ queryKey: ["devices"], queryFn: () => api<{ devices: Device[] }>("/api/v1/admin/devices") })
  const hostnames = new Map((devices.data?.devices ?? []).map((d) => [d.id, d.hostname]))
  const [name, setName] = React.useState("")
  const [description, setDescription] = React.useState("")
  const [language, setLanguage] = React.useState("powershell")
  const [content, setContent] = React.useState("Write-Output 'hello'")
  const [timeoutSeconds, setTimeoutSeconds] = React.useState("60")
  const [paramDefs, setParamDefs] = React.useState<Record<string, ParamDef>>({})
  const [deviceId, setDeviceId] = React.useState("")
  const [selected, setSelected] = React.useState<string>("")
  const [runValues, setRunValues] = React.useState<Record<string, string>>({})
  const [cron, setCron] = React.useState("0 * * * *")
  const [templateValues, setTemplateValues] = React.useState<Record<string, Record<string, string>>>({})
  const schedules = useQuery({
    queryKey: ["script-schedules"],
    queryFn: () => api<{ schedules: Array<{ id: string; cron: string; deviceId: string | null; script: { name: string } }> }>("/api/v1/admin/script-schedules"),
  })

  const editorParams: ParamDef[] = referencedParams(content).map((param) => ({ name: param, ...paramDefs[param] }))
  const selectedScript = (scripts.data?.scripts ?? []).find((s) => s.id === selected)
  const selectedParams = selectedScript ? parseParams(selectedScript.parameters) : []
  const runBlocked = selectedParams.some((p) => !patternOk(p.pattern, runValues[p.name] ?? p.default ?? ""))

  function updateParam(param: string, patch: Partial<ParamDef>) {
    setParamDefs((cur) => ({ ...cur, [param]: { ...cur[param], name: param, ...patch } }))
  }

  function loadTemplate(template: ScriptTemplate) {
    setName(template.name)
    setDescription(template.description)
    setLanguage(template.language)
    setContent(template.content)
    setTimeoutSeconds(String(template.timeoutSeconds))
    setParamDefs(
      Object.fromEntries(template.parameters.map((p) => [p.name, { name: p.name, default: p.default, pattern: p.pattern }]))
    )
    toast.message(`Loaded "${template.name}" into the editor. Review, then save to the library.`)
  }

  const refreshRuns = () => void queryClient.invalidateQueries({ queryKey: ["script-runs"] })

  const save = useMutation({
    mutationFn: () =>
      api("/api/v1/admin/scripts", {
        method: "POST",
        body: JSON.stringify({
          name,
          description,
          language,
          content,
          timeoutSeconds: Number(timeoutSeconds) || 60,
          parameters: editorParams.map((p) => ({
            name: p.name,
            ...(p.default ? { default: p.default } : {}),
            ...(p.pattern ? { pattern: p.pattern } : {}),
          })),
        }),
      }),
    onSuccess: () => {
      toast.success("Script saved")
      void queryClient.invalidateQueries({ queryKey: ["scripts"] })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/admin/scripts/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Script deleted")
      setSelected("")
      void queryClient.invalidateQueries({ queryKey: ["scripts"] })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const run = useMutation({
    mutationFn: () =>
      api(`/api/v1/admin/devices/${deviceId}/scripts/run`, {
        method: "POST",
        body: JSON.stringify({ scriptId: selected, parameters: runValues }),
      }),
    onSuccess: () => {
      toast.success("Script queued")
      refreshRuns()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const runTemplate = useMutation({
    mutationFn: (template: ScriptTemplate) =>
      api(`/api/v1/admin/devices/${deviceId}/scripts/run`, {
        method: "POST",
        body: JSON.stringify({ templateId: template.id, parameters: templateValues[template.id] ?? {} }),
      }),
    onSuccess: () => {
      toast.success("Template queued")
      refreshRuns()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const schedule = useMutation({
    mutationFn: () =>
      api("/api/v1/admin/script-schedules", {
        method: "POST",
        body: JSON.stringify({ scriptId: selected, cron, deviceId: deviceId || null }),
      }),
    onSuccess: () => {
      toast.success("Schedule saved")
      void queryClient.invalidateQueries({ queryKey: ["script-schedules"] })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const deviceSelect = (
    <select className="h-9 rounded-md border bg-background px-2 text-sm" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
      <option value="">Device</option>
      {(devices.data?.devices ?? []).map((device) => (
        <option key={device.id} value={device.id}>
          {device.hostname}
        </option>
      ))}
    </select>
  )

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Templates</CardTitle>
          <CardDescription>
            Reviewed, read-only Windows checks. Content is fixed; parameters must match their pattern, so values cannot add
            commands. Nothing here deletes, installs, or changes settings.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {deviceSelect}
            <span className="text-xs text-muted-foreground">Runs are queued as run_script and audited with the template id.</span>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {SCRIPT_TEMPLATES.map((template) => {
              const values = templateValues[template.id] ?? {}
              const invalid = template.parameters.some((p) => !patternOk(p.pattern, values[p.name] ?? p.default))
              return (
                <div key={template.id} className="flex flex-col gap-2 rounded-lg border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{template.name}</span>
                    <Badge variant="outline">{template.category}</Badge>
                    <Badge variant="secondary">read-only</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">{template.description}</p>
                  <ParameterInputs
                    params={template.parameters}
                    values={values}
                    onChange={(next) => setTemplateValues((cur) => ({ ...cur, [template.id]: next }))}
                  />
                  <div className="mt-auto flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!deviceId || invalid || runTemplate.isPending}
                      onClick={() => runTemplate.mutate(template)}
                    >
                      Run on device
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => loadTemplate(template)}>
                      Copy to editor
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Library</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <select className="h-9 rounded-md border bg-background px-2 text-sm" value={language} onChange={(e) => setLanguage(e.target.value)}>
              <option value="powershell">powershell</option>
              <option value="python">python</option>
              <option value="batch">batch</option>
              <option value="shell">shell</option>
            </select>
            <Input
              className="w-40"
              type="number"
              min={1}
              max={3600}
              value={timeoutSeconds}
              onChange={(e) => setTimeoutSeconds(e.target.value)}
              aria-label="Timeout seconds"
            />
            <span className="self-center text-xs text-muted-foreground">timeout (s)</span>
          </div>
          <Textarea value={content} onChange={(e) => setContent(e.target.value)} rows={8} className="font-mono text-xs" />
          {editorParams.length ? (
            <div className="flex flex-col gap-2 rounded-md border p-2">
              <p className="text-xs text-muted-foreground">
                Parameters found as <span className="font-mono">{"{{name}}"}</span>. Add an anchored pattern (for example{" "}
                <span className="font-mono">^[A-Za-z0-9_]{"{1,40}"}$</span>) so run-time values cannot change the script.
                Line breaks are always rejected.
              </p>
              {editorParams.map((p) => (
                <div key={p.name} className="grid gap-2 sm:grid-cols-[8rem_1fr_1fr]">
                  <span className="self-center font-mono text-xs">{p.name}</span>
                  <Input placeholder="Default" value={p.default ?? ""} onChange={(e) => updateParam(p.name, { default: e.target.value })} />
                  <Input
                    placeholder="Pattern ^…$"
                    value={p.pattern ?? ""}
                    onChange={(e) => updateParam(p.name, { pattern: e.target.value })}
                    className="font-mono text-xs"
                  />
                </div>
              ))}
            </div>
          ) : null}
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
                <TableRow
                  key={script.id}
                  onClick={() => {
                    setSelected(script.id)
                    setRunValues({})
                  }}
                  data-state={selected === script.id ? "selected" : undefined}
                  className="cursor-pointer"
                >
                  <TableCell>
                    <div>{script.name}</div>
                    {script.description ? <div className="text-xs text-muted-foreground">{script.description}</div> : null}
                  </TableCell>
                  <TableCell>{script.language}</TableCell>
                  <TableCell>{formatWhen(script.updatedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {selectedScript ? (
            <div className="flex flex-col gap-2 rounded-md border p-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{selectedScript.name}</span>
                <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(selectedScript.id)}>
                  Delete
                </Button>
              </div>
              <ParameterInputs params={selectedParams} values={runValues} onChange={setRunValues} />
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {deviceSelect}
            <Button variant="outline" disabled={!selected || !deviceId || runBlocked || run.isPending} onClick={() => run.mutate()}>
              Run
            </Button>
            <Input value={cron} onChange={(e) => setCron(e.target.value)} className="max-w-[10rem]" placeholder="0 * * * *" />
            <Button variant="outline" disabled={!selected || schedule.isPending} onClick={() => schedule.mutate()}>
              Schedule
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Cron is UTC. An empty device schedules every enrolled device (cap 200). Scheduled runs use parameter defaults.
          </p>
          {(schedules.data?.schedules ?? []).slice(0, 8).map((row) => (
            <p key={row.id} className="text-xs text-muted-foreground">
              {row.script.name} · {row.cron} · {row.deviceId ? (hostnames.get(row.deviceId) ?? row.deviceId) : "fleet"}
            </p>
          ))}
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
                  {hostnames.get(row.deviceId) ?? row.deviceId} · {row.status} · exit {row.exitCode ?? "—"} · {row.trigger}
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
