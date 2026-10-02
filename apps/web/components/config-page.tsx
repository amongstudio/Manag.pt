"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { PublicAccess, type TunnelView } from "@/components/public-access"
import Link from "next/link"
import { Button } from "@workspace/ui/components/button"
import { Card, CardContent, CardHeader, CardTitle } from "@workspace/ui/components/card"
import { Input } from "@workspace/ui/components/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@workspace/ui/components/tabs"
import { Textarea } from "@workspace/ui/components/textarea"

type Helper = {
  agentServiceName: string
  statusPort: number
  backoffSec: number
  probeIntervalSec: number
  failThreshold: number
  maxBackoffSec: number
  startupGraceSec: number
}

type ConfigResponse = {
  rules: string
  automations: string
  scanScopeText: string
  softwareRules: string
  helper: Helper
  installCommand: string
  publicUrl: string
  fileOnly: string[]
}

export function ConfigPage({
  initial,
  agent,
  tunnel,
}: {
  initial: ConfigResponse | null
  agent: { pollIntervalSec: number; idleHeartbeatSec: number } | null
  tunnel?: TunnelView | null
}) {
  const client = useQueryClient()
  const config = useQuery({
    queryKey: ["operator-config"],
    queryFn: () => api<ConfigResponse>("/api/v1/admin/config"),
    initialData: initial ?? undefined,
  })
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api<{ settings: { agent: { pollIntervalSec: number; idleHeartbeatSec: number } } }>("/api/v1/admin/settings"),
  })
  const [rules, setRules] = React.useState(initial?.rules ?? "")
  const [automations, setAutomations] = React.useState(initial?.automations ?? "")
  const [scope, setScope] = React.useState(initial?.scanScopeText ?? "")
  const [software, setSoftware] = React.useState(initial?.softwareRules ?? "")
  const [helper, setHelper] = React.useState<Helper | null>(initial?.helper ?? null)
  const [poll, setPoll] = React.useState(String(agent?.pollIntervalSec ?? 15))
  const [idle, setIdle] = React.useState(String(agent?.idleHeartbeatSec ?? 90))
  React.useEffect(() => {
    if (!config.data) return
    setRules(config.data.rules)
    setAutomations(config.data.automations)
    setScope(config.data.scanScopeText)
    setSoftware(config.data.softwareRules)
    setHelper(config.data.helper)
  }, [config.data])
  React.useEffect(() => {
    const agent = settings.data?.settings.agent
    if (!agent) return
    setPoll(String(agent.pollIntervalSec))
    setIdle(String(agent.idleHeartbeatSec))
  }, [settings.data])
  const save = useMutation({
    mutationFn: (input: { section: string; body: unknown }) =>
      api(`/api/v1/admin/config/${input.section}`, { method: "PUT", body: JSON.stringify(input.body) }),
    onSuccess: () => {
      toast.success("Saved")
      void client.invalidateQueries({ queryKey: ["operator-config"] })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  if (!helper) return <p className="text-sm text-muted-foreground">Loading configuration…</p>
  return (
    <Tabs defaultValue="api">
      <TabsList>
        <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
        <TabsTrigger value="api">API</TabsTrigger>
        <TabsTrigger value="agent">Agent</TabsTrigger>
        <TabsTrigger value="helper">Helper</TabsTrigger>
        <TabsTrigger value="public">Public access</TabsTrigger>
      </TabsList>
      <TabsContent value="dashboard" className="mt-4 flex flex-col gap-3">
        <Card>
          <CardHeader>
            <CardTitle>Environment only</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            These are read at process start and are not stored in SQLite: {config.data?.fileOnly.join(", ")}. Public URL for installers is {config.data?.publicUrl}. Notification targets, metric retention, thresholds, and mesh policy stay on{" "}
            <Link href="/settings" className="underline">
              Settings
            </Link>
            . Saving them there still updates the same settings row and the in-memory cache.
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Windows install command</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="overflow-auto rounded-md border p-3 text-xs">{config.data?.installCommand}</pre>
            <p className="mt-2 text-xs text-muted-foreground">The enrollment secret is masked. Put the real secret only in your secret store or the stamped pack.</p>
          </CardContent>
        </Card>
      </TabsContent>
      <TabsContent value="api" className="mt-4 flex flex-col gap-4">
        <YamlCard title="Alert rules" value={rules} onChange={setRules} onSave={() => save.mutate({ section: "rules", body: { text: rules } })} />
        <YamlCard title="Automations" value={automations} onChange={setAutomations} onSave={() => save.mutate({ section: "automations", body: { text: automations } })} />
        <YamlCard title="Scan scope" value={scope} onChange={setScope} onSave={() => save.mutate({ section: "scan-scope", body: { text: scope } })} />
        <YamlCard title="Software version rules" value={software} onChange={setSoftware} onSave={() => save.mutate({ section: "software-rules", body: { text: software } })} />
      </TabsContent>
      <TabsContent value="agent" className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle>Intervals</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">Saved into the settings row and pushed on the next heartbeat as agentConfig. An offline agent picks this up when it reconnects.</p>
            <label className="text-sm">Idle heartbeat seconds<Input value={idle} onChange={(e) => setIdle(e.target.value)} /></label>
            <label className="text-sm">Poll seconds<Input value={poll} onChange={(e) => setPoll(e.target.value)} /></label>
            <Button
              className="w-fit"
              onClick={() =>
                save.mutate({
                  section: "agent",
                  body: { agent: { idleHeartbeatSec: Number(idle), pollIntervalSec: Number(poll), heartbeatIntervalSec: Number(idle) } },
                })
              }
            >
              Save agent intervals
            </Button>
          </CardContent>
        </Card>
      </TabsContent>
      <TabsContent value="public" className="mt-4">
        <PublicAccess initial={tunnel} />
      </TabsContent>
      <TabsContent value="helper" className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle>Watchdog</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 sm:grid-cols-2">
            <label className="text-sm">Service name<Input value={helper.agentServiceName} onChange={(e) => setHelper({ ...helper, agentServiceName: e.target.value })} /></label>
            <label className="text-sm">Status port<Input value={helper.statusPort} onChange={(e) => setHelper({ ...helper, statusPort: Number(e.target.value) })} /></label>
            <label className="text-sm">Probe seconds<Input value={helper.probeIntervalSec} onChange={(e) => setHelper({ ...helper, probeIntervalSec: Number(e.target.value) })} /></label>
            <label className="text-sm">Backoff seconds<Input value={helper.backoffSec} onChange={(e) => setHelper({ ...helper, backoffSec: Number(e.target.value) })} /></label>
            <label className="text-sm">Max backoff<Input value={helper.maxBackoffSec} onChange={(e) => setHelper({ ...helper, maxBackoffSec: Number(e.target.value) })} /></label>
            <label className="text-sm">Fail threshold<Input value={helper.failThreshold} onChange={(e) => setHelper({ ...helper, failThreshold: Number(e.target.value) })} /></label>
            <label className="text-sm">Startup grace<Input value={helper.startupGraceSec} onChange={(e) => setHelper({ ...helper, startupGraceSec: Number(e.target.value) })} /></label>
            <Button className="w-fit" onClick={() => save.mutate({ section: "helper", body: helper })}>
              Save helper
            </Button>
            <p className="text-xs text-muted-foreground sm:col-span-2">Online agents write helper.yaml. The helper process reads that file the next time it starts. The probe ticker interval is fixed until that restart.</p>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  )
}

function YamlCard({ title, value, onChange, onSave }: { title: string; value: string; onChange: (value: string) => void; onSave: () => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <Textarea value={value} onChange={(e) => onChange(e.target.value)} rows={10} className="font-mono text-xs" />
        <Button className="w-fit" onClick={onSave}>
          Save
        </Button>
      </CardContent>
    </Card>
  )
}
