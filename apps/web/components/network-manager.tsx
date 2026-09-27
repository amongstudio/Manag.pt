"use client"

import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  FIREWALL_ACTIONS,
  FIREWALL_DIRECTIONS,
  FIREWALL_PROTOCOLS,
  PEER_LAN_PORT,
  WS_EVENTS,
  adapterStatusLabel,
  firewallActionLabel,
  firewallDirectionLabel,
  firewallRuleConfirm,
  isEstablishedPort,
  isListenPort,
  isOfficialPeerPort,
  latestSuccessfulAdapters,
  latestSuccessfulFirewall,
  latestSuccessfulPorts,
  parseAdapterList,
  parseFirewall,
  parsePortList,
  portRowKey,
  firewallRuleKey,
  portStateLabel,
  queuedCommandId,
  resultErrorMessage,
  resultPayloadError,
  type AdapterInfo,
  type FirewallAction,
  type FirewallDirection,
  type FirewallProtocol,
  type FirewallRuleInfo,
  type FirewallWriteAction,
  type PortInfo,
} from "@workspace/shared"

import { api } from "@/lib/api"
import { pollAdminCommand } from "@/lib/command-poll"
import { useSocket } from "@/components/providers"
import { QueryErrorBanner, QueryErrorState } from "@/components/query-error"
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
import { Card, CardContent } from "@workspace/ui/components/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@workspace/ui/components/empty"
import { Field, FieldLabel } from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Spinner } from "@workspace/ui/components/spinner"
import { Switch } from "@workspace/ui/components/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@workspace/ui/components/tabs"
import { Textarea } from "@workspace/ui/components/textarea"

type CommandSeed = { id: string; type: string; status: string; result?: unknown }

type RuleForm = {
  name: string
  direction: FirewallDirection
  action: FirewallAction
  enabled: boolean
  protocol: FirewallProtocol
  localPorts: string
  remoteAddresses: string
  application: string
  description: string
  profiles: string
}

const emptyRuleForm = (): RuleForm => ({
  name: "",
  direction: "inbound",
  action: "allow",
  enabled: true,
  protocol: "tcp",
  localPorts: "",
  remoteAddresses: "",
  application: "",
  description: "",
  profiles: "all",
})

function ruleFormFrom(rule: FirewallRuleInfo): RuleForm {
  const protocol = (FIREWALL_PROTOCOLS as readonly string[]).includes(rule.protocol ?? "")
    ? (rule.protocol as FirewallProtocol)
    : "any"
  const direction = (FIREWALL_DIRECTIONS as readonly string[]).includes(rule.direction)
    ? (rule.direction as FirewallDirection)
    : "inbound"
  const action = (FIREWALL_ACTIONS as readonly string[]).includes(rule.action)
    ? (rule.action as FirewallAction)
    : "allow"
  return {
    name: rule.name,
    direction,
    action,
    enabled: rule.enabled,
    protocol,
    localPorts: rule.localPorts ?? "",
    remoteAddresses: rule.remoteAddresses ?? "",
    application: rule.application ?? "",
    description: rule.description ?? "",
    profiles: rule.profiles || "all",
  }
}

export function NetworkManager({
  deviceId,
  platform,
  commands,
  online = false,
  latestSuccessful,
}: {
  deviceId: string
  platform: string
  commands?: CommandSeed[]
  online?: boolean
  latestSuccessful?: {
    get_adapters?: CommandSeed | null
    get_ports?: CommandSeed | null
    get_firewall?: CommandSeed | null
  }
}) {
  const windows = platform.toLowerCase() === "windows"
  const [tab, setTab] = React.useState("adapters")
  const adapters = useNetworkList({
    deviceId,
    type: "get_adapters",
    commands,
    latestSuccessful: latestSuccessful?.get_adapters ?? null,
    online,
    windows,
    active: tab === "adapters",
    seed: latestSuccessfulAdapters,
  })
  const ports = useNetworkList({
    deviceId,
    type: "get_ports",
    commands,
    latestSuccessful: latestSuccessful?.get_ports ?? null,
    online,
    windows,
    active: tab === "ports",
    seed: latestSuccessfulPorts,
  })
  const firewall = useNetworkList({
    deviceId,
    type: "get_firewall",
    commands,
    latestSuccessful: latestSuccessful?.get_firewall ?? null,
    online,
    windows,
    active: tab === "firewall",
    seed: latestSuccessfulFirewall,
  })

  if (!windows) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Windows-only</EmptyTitle>
          <EmptyDescription>
            Network uses IP Helper, GetExtendedTcpTable/UdpTable, and INetFwPolicy2. Linux and macOS agents return
            unsupported.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Native Windows adapters, sockets, and firewall rules. Port {PEER_LAN_PORT} is the official LAN peer port. Rule
        writes confirm first. The firewall is never disabled globally.
      </p>
      <Tabs value={tab} onValueChange={(value) => setTab(String(value))}>
        <TabsList>
          <TabsTrigger value="adapters">Adapters</TabsTrigger>
          <TabsTrigger value="ports">Ports</TabsTrigger>
          <TabsTrigger value="firewall">Firewall</TabsTrigger>
        </TabsList>
        <TabsContent value="adapters">
          <AdaptersPane snapshot={adapters} />
        </TabsContent>
        <TabsContent value="ports">
          <PortsPane snapshot={ports} />
        </TabsContent>
        <TabsContent value="firewall">
          <FirewallPane snapshot={firewall} deviceId={deviceId} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

type Snapshot = {
  result: unknown
  listed: boolean
  truncated: boolean
  pending: boolean
  error: string | null
  refresh: () => void
  refreshing: boolean
}

function AdaptersPane({ snapshot }: { snapshot: Snapshot }) {
  const [filter, setFilter] = React.useState("")
  const parsed = parseAdapterList(snapshot.result)
  const q = filter.trim().toLowerCase()
  const rows = parsed.adapters.filter(
    (a) =>
      !q ||
      a.name.toLowerCase().includes(q) ||
      (a.description ?? "").toLowerCase().includes(q) ||
      (a.ipv4 ?? []).some((ip) => ip.toLowerCase().includes(q)) ||
      (a.mac ?? "").toLowerCase().includes(q)
  )
  return (
    <div className="flex flex-col gap-3 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input className="max-w-xs" placeholder="Filter adapters" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <Button size="sm" variant="outline" onClick={snapshot.refresh} disabled={snapshot.refreshing || snapshot.pending}>
          {snapshot.pending ? <Spinner data-icon="inline-start" /> : null}
          Refresh
        </Button>
      </div>
      <ListBody
        snapshot={snapshot}
        truncated={parsed.truncated || snapshot.truncated}
        emptyTitle="No adapter list yet"
        emptyHint="Refresh to queue get_adapters."
        failTitle="Adapter list failed"
      >
        <Card>
          <CardContent className="overflow-x-auto pt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>IPv4</TableHead>
                  <TableHead>IPv6</TableHead>
                  <TableHead>DNS</TableHead>
                  <TableHead>DHCP</TableHead>
                  <TableHead>MAC</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-muted-foreground">
                      No adapters match the filter.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((a) => <AdapterRow key={`${a.id ?? a.name}-${a.index ?? 0}`} adapter={a} />)
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </ListBody>
    </div>
  )
}

function AdapterRow({ adapter }: { adapter: AdapterInfo }) {
  const desc = adapter.description && adapter.description !== adapter.name ? adapter.description : null
  return (
    <TableRow>
      <TableCell className="min-w-0 max-w-[14rem]">
        <div className="truncate font-medium" title={adapter.name}>
          {adapter.name}
        </div>
        {desc ? (
          <div className="truncate text-xs text-muted-foreground" title={desc}>
            {desc}
          </div>
        ) : null}
      </TableCell>
      <TableCell>{adapterStatusLabel(adapter.status)}</TableCell>
      <TableCell>{adapter.ifType || "—"}</TableCell>
      <TableCell className="max-w-32 truncate font-mono text-xs" title={adapter.ipv4?.join(", ")}>
        {adapter.ipv4?.join(", ") || "—"}
      </TableCell>
      <TableCell className="max-w-32 truncate font-mono text-xs" title={adapter.ipv6?.join(", ")}>
        {adapter.ipv6?.join(", ") || "—"}
      </TableCell>
      <TableCell className="max-w-32 truncate font-mono text-xs" title={adapter.dns?.join(", ")}>
        {adapter.dns?.join(", ") || "—"}
      </TableCell>
      <TableCell>{adapter.dhcp ? adapter.dhcpServer || "DHCP" : "Static"}</TableCell>
      <TableCell className="font-mono text-xs">{adapter.mac || "—"}</TableCell>
    </TableRow>
  )
}

function PortsPane({ snapshot }: { snapshot: Snapshot }) {
  const [filter, setFilter] = React.useState("")
  const [view, setView] = React.useState("listen")
  const parsed = parsePortList(snapshot.result)
  const q = filter.trim().toLowerCase()
  const rows = parsed.ports
    .filter((p) => {
      if (view === "listen") return isListenPort(p)
      if (view === "established") return isEstablishedPort(p)
      return true
    })
    .filter(
      (p) =>
        !q ||
        p.localAddr.toLowerCase().includes(q) ||
        (p.remoteAddr ?? "").toLowerCase().includes(q) ||
        (p.process ?? "").toLowerCase().includes(q) ||
        String(p.localPort).includes(q) ||
        String(p.pid ?? "").includes(q)
    )
    .slice()
    .sort((a, b) => {
      const ao = a.official || isOfficialPeerPort(a.localPort) ? 0 : 1
      const bo = b.official || isOfficialPeerPort(b.localPort) ? 0 : 1
      if (ao !== bo) return ao - bo
      if (a.localPort !== b.localPort) return a.localPort - b.localPort
      return a.protocol.localeCompare(b.protocol)
    })
  return (
    <div className="flex flex-col gap-3 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input className="max-w-xs" placeholder="Filter ports" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <Select
          items={[
            { value: "listen", label: "Listen" },
            { value: "established", label: "Established" },
            { value: "all", label: "All" },
          ]}
          value={view}
          onValueChange={(value) => setView(String(value))}
        >
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="listen">Listen</SelectItem>
              <SelectItem value="established">Established</SelectItem>
              <SelectItem value="all">All</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" onClick={snapshot.refresh} disabled={snapshot.refreshing || snapshot.pending}>
          {snapshot.pending ? <Spinner data-icon="inline-start" /> : null}
          Refresh
        </Button>
      </div>
      <ListBody
        snapshot={snapshot}
        truncated={parsed.truncated || snapshot.truncated}
        emptyTitle="No port list yet"
        emptyHint="Refresh to queue get_ports."
        failTitle="Port list failed"
      >
        <Card>
          <CardContent className="overflow-x-auto pt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Protocol</TableHead>
                  <TableHead>Local</TableHead>
                  <TableHead>Remote</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>PID</TableHead>
                  <TableHead>Process</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-muted-foreground">
                      No ports match the filter.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((p, i) => <PortRow key={portRowKey(p, i)} port={p} />)
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </ListBody>
    </div>
  )
}

function PortRow({ port }: { port: PortInfo }) {
  const official = port.official || isOfficialPeerPort(port.localPort)
  const local = `${port.localAddr}:${port.localPort}`
  const remote = port.remoteAddr ? `${port.remoteAddr}:${port.remotePort ?? 0}` : "—"
  return (
    <TableRow className={official ? "bg-accent/40" : undefined}>
      <TableCell className="uppercase">{port.protocol}</TableCell>
      <TableCell className="min-w-0 max-w-40">
        <div className="flex min-w-0 items-center gap-1">
          <span className="truncate font-mono text-xs" title={local}>
            {local}
          </span>
          {official ? (
            <Badge variant="secondary" className="shrink-0">
              peer {PEER_LAN_PORT}
            </Badge>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="max-w-40 truncate font-mono text-xs" title={remote !== "—" ? remote : undefined}>
        {remote}
      </TableCell>
      <TableCell>{portStateLabel(port.state)}</TableCell>
      <TableCell>{port.pid ? port.pid : "—"}</TableCell>
      <TableCell className="max-w-32 truncate" title={port.process || undefined}>
        {port.process || "—"}
      </TableCell>
    </TableRow>
  )
}

function FirewallPane({ snapshot, deviceId }: { snapshot: Snapshot; deviceId: string }) {
  const client = useQueryClient()
  const socket = useSocket()
  const refreshRef = React.useRef(snapshot.refresh)
  refreshRef.current = snapshot.refresh
  const [filter, setFilter] = React.useState("")
  const [direction, setDirection] = React.useState("all")
  const [enabled, setEnabled] = React.useState("all")
  const [selected, setSelected] = React.useState<string | null>(null)
  const [form, setForm] = React.useState<RuleForm | null>(null)
  const [confirm, setConfirm] = React.useState<{ action: FirewallWriteAction; form: RuleForm } | null>(null)
  const parsed = parseFirewall(snapshot.result)
  const q = filter.trim().toLowerCase()
  const rows = parsed.rules.filter((r) => {
    if (direction !== "all" && r.direction !== direction) return false
    if (enabled === "enabled" && !r.enabled) return false
    if (enabled === "disabled" && r.enabled) return false
    if (!q) return true
    return (
      r.name.toLowerCase().includes(q) ||
      (r.localPorts ?? "").toLowerCase().includes(q) ||
      (r.application ?? "").toLowerCase().includes(q) ||
      (r.description ?? "").toLowerCase().includes(q)
    )
  })
  const selectedRow = rows.find((r) => r.name === selected) ?? null

  async function queue(type: string, payload: Record<string, unknown> = {}) {
    const data = await api<{ commands: { id: string }[] }>("/api/v1/admin/commands", {
      method: "POST",
      body: JSON.stringify({ deviceIds: [deviceId], type, payload }),
    })
    const id = queuedCommandId(data)
    if (!id) throw new Error("command not queued")
    return id
  }

  const write = useMutation({
    mutationFn: async (input: { action: FirewallWriteAction; form: RuleForm }) => {
      if (input.action === "delete") {
        await queue("delete_firewall_rule", { name: input.form.name })
        return input
      }
      await queue("set_firewall_rule", {
        name: input.form.name,
        direction: input.form.direction,
        action: input.form.action,
        enabled: input.form.enabled,
        protocol: input.form.protocol,
        localPorts: input.form.localPorts || undefined,
        remoteAddresses: input.form.remoteAddresses || undefined,
        application: input.form.application || undefined,
        description: input.form.description || undefined,
        profiles: input.form.profiles || undefined,
      })
      return input
    },
    onSuccess: (input) => {
      toast.success(input.action === "delete" ? `Delete queued for ${input.form.name}` : `Rule ${input.form.name} queued`)
      setConfirm(null)
      setForm(null)
      void client.invalidateQueries({ queryKey: ["device", deviceId] })
    },
    onError: (e) => toast.error(e.message),
  })

  React.useEffect(() => {
    if (!socket) return
    const onResult = (payload: unknown) => {
      if (!payload || typeof payload !== "object") return
      const rec = payload as { deviceId?: string; type?: string; status?: string; result?: unknown }
      if (rec.deviceId !== deviceId) return
      if (rec.status === "success" && (rec.type === "set_firewall_rule" || rec.type === "delete_firewall_rule")) {
        refreshRef.current()
      } else if ((rec.status === "failed" || rec.status === "cancelled") && (rec.type === "set_firewall_rule" || rec.type === "delete_firewall_rule")) {
        toast.error(resultErrorMessage(rec.result, rec.status, `${(rec.type ?? "firewall").replaceAll("_", " ")} failed`))
      }
    }
    socket.on(WS_EVENTS.COMMAND_RESULT, onResult)
    return () => {
      socket.off(WS_EVENTS.COMMAND_RESULT, onResult)
    }
  }, [socket, deviceId])

  return (
    <div className="flex flex-col gap-3 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input className="max-w-xs" placeholder="Filter rules" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <Select
          items={[
            { value: "all", label: "All directions" },
            { value: "inbound", label: "Inbound" },
            { value: "outbound", label: "Outbound" },
          ]}
          value={direction}
          onValueChange={(value) => setDirection(String(value))}
        >
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="all">All directions</SelectItem>
              <SelectItem value="inbound">Inbound</SelectItem>
              <SelectItem value="outbound">Outbound</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <Select
          items={[
            { value: "all", label: "All rules" },
            { value: "enabled", label: "Enabled" },
            { value: "disabled", label: "Disabled" },
          ]}
          value={enabled}
          onValueChange={(value) => setEnabled(String(value))}
        >
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="all">All rules</SelectItem>
              <SelectItem value="enabled">Enabled</SelectItem>
              <SelectItem value="disabled">Disabled</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" onClick={snapshot.refresh} disabled={snapshot.refreshing || snapshot.pending}>
          {snapshot.pending ? <Spinner data-icon="inline-start" /> : null}
          Refresh
        </Button>
        <Button size="sm" onClick={() => setForm(emptyRuleForm())} disabled={write.isPending}>
          Add rule
        </Button>
        <Button size="sm" variant="outline" onClick={() => selectedRow && setForm(ruleFormFrom(selectedRow))} disabled={!selectedRow || write.isPending}>
          Edit
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={() => selectedRow && setConfirm({ action: "delete", form: ruleFormFrom(selectedRow) })}
          disabled={!selectedRow || write.isPending}
        >
          Delete
        </Button>
      </div>
      {parsed.profiles.length ? (
        <div className="flex flex-wrap gap-2">
          {parsed.profiles.map((p) => {
            const label = `${p.name}: ${p.enabled ? "on" : "off"} · in ${p.defaultInbound || "—"} · out ${p.defaultOutbound || "—"}`
            return (
              <Badge key={p.name} variant={p.enabled ? "secondary" : "outline"} className="max-w-xs truncate" title={label}>
                {label}
              </Badge>
            )
          })}
          {parsed.modifyState && parsed.modifyState !== "ok" ? (
            <Badge variant="outline">{parsed.modifyState.replaceAll("_", " ")}</Badge>
          ) : null}
        </div>
      ) : null}
      <ListBody
        snapshot={snapshot}
        truncated={parsed.truncated || snapshot.truncated}
        emptyTitle="No firewall list yet"
        emptyHint="Refresh to queue get_firewall."
        failTitle="Firewall list failed"
      >
        <Card>
          <CardContent className="overflow-x-auto pt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Direction</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Enabled</TableHead>
                  <TableHead>Protocol</TableHead>
                  <TableHead>Local ports</TableHead>
                  <TableHead>Program</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-muted-foreground">
                      No rules match the filter.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((r, i) => {
                    const peer = (r.localPorts ?? "").split(/[,-]/).some((p) => p.trim() === String(PEER_LAN_PORT))
                    return (
                      <TableRow
                        key={firewallRuleKey(r, i)}
                        data-state={selected === r.name ? "selected" : undefined}
                        className="cursor-pointer"
                        onClick={() => setSelected(r.name)}
                      >
                        <TableCell className="min-w-0 max-w-[16rem]">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate font-medium" title={r.name}>
                              {r.name}
                            </span>
                            {peer ? (
                              <Badge variant="secondary" className="shrink-0">
                                peer {PEER_LAN_PORT}
                              </Badge>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell>{firewallDirectionLabel(r.direction)}</TableCell>
                        <TableCell>{firewallActionLabel(r.action)}</TableCell>
                        <TableCell>{r.enabled ? "Yes" : "No"}</TableCell>
                        <TableCell className="uppercase">{r.protocol || "—"}</TableCell>
                        <TableCell className="max-w-32 truncate font-mono text-xs" title={r.localPorts || undefined}>
                          {r.localPorts || "—"}
                        </TableCell>
                        <TableCell className="max-w-56 truncate text-xs" title={r.application || undefined}>
                          {r.application || "—"}
                        </TableCell>
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </ListBody>
      <Dialog open={!!form} onOpenChange={(open) => !open && setForm(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{form?.name ? `Firewall rule` : "Add firewall rule"}</DialogTitle>
            <DialogDescription>
              Writes one INetFwPolicy2 rule after confirm. This dialog cannot disable Windows Firewall globally.
            </DialogDescription>
          </DialogHeader>
          {form ? (
            <div className="grid gap-3">
              <Field>
                <FieldLabel htmlFor="fw-name">Name</FieldLabel>
                <Input id="fw-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field>
                  <FieldLabel>Direction</FieldLabel>
                  <Select
                    items={FIREWALL_DIRECTIONS.map((d) => ({ value: d, label: firewallDirectionLabel(d) }))}
                    value={form.direction}
                    onValueChange={(value) => setForm({ ...form, direction: value as FirewallDirection })}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {FIREWALL_DIRECTIONS.map((d) => (
                          <SelectItem key={d} value={d}>
                            {firewallDirectionLabel(d)}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel>Action</FieldLabel>
                  <Select
                    items={FIREWALL_ACTIONS.map((a) => ({ value: a, label: firewallActionLabel(a) }))}
                    value={form.action}
                    onValueChange={(value) => setForm({ ...form, action: value as FirewallAction })}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {FIREWALL_ACTIONS.map((a) => (
                          <SelectItem key={a} value={a}>
                            {firewallActionLabel(a)}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field>
                  <FieldLabel>Protocol</FieldLabel>
                  <Select
                    items={FIREWALL_PROTOCOLS.map((p) => ({ value: p, label: p.toUpperCase() }))}
                    value={form.protocol}
                    onValueChange={(value) => setForm({ ...form, protocol: value as FirewallProtocol })}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {FIREWALL_PROTOCOLS.map((p) => (
                          <SelectItem key={p} value={p}>
                            {p.toUpperCase()}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="fw-ports">Local ports</FieldLabel>
                  <Input
                    id="fw-ports"
                    placeholder="17891"
                    value={form.localPorts}
                    onChange={(e) => setForm({ ...form, localPorts: e.target.value })}
                  />
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="fw-remote">Remote addresses</FieldLabel>
                <Input
                  id="fw-remote"
                  value={form.remoteAddresses}
                  onChange={(e) => setForm({ ...form, remoteAddresses: e.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="fw-app">Application</FieldLabel>
                <Input id="fw-app" value={form.application} onChange={(e) => setForm({ ...form, application: e.target.value })} />
              </Field>
              <Field>
                <FieldLabel htmlFor="fw-desc">Description</FieldLabel>
                <Textarea id="fw-desc" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={form.enabled} onCheckedChange={(on) => setForm({ ...form, enabled: on })} />
                Enabled
              </label>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setForm(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => form && setConfirm({ action: "set", form })}
              disabled={!form?.name.trim()}
            >
              Review
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={!!confirm} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm ? `${confirm.action === "delete" ? "Delete" : "Save"} ${confirm.form.name}` : "Confirm"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm ? firewallRuleConfirm(confirm.action, confirm.form.name) : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={confirm?.action === "delete" ? "destructive" : "default"}
              onClick={() => confirm && write.mutate(confirm)}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function ListBody({
  snapshot,
  truncated,
  emptyTitle,
  emptyHint,
  failTitle,
  children,
}: {
  snapshot: Snapshot
  truncated: boolean
  emptyTitle: string
  emptyHint: string
  failTitle: string
  children: React.ReactNode
}) {
  return (
    <>
      {snapshot.error && snapshot.listed ? <QueryErrorBanner cached error={snapshot.error} onRetry={snapshot.refresh} /> : null}
      {truncated ? <p className="text-sm text-muted-foreground">Listing truncated at the agent cap.</p> : null}
      {snapshot.pending && !snapshot.listed ? (
        <p className="text-sm text-muted-foreground">Waiting for agent…</p>
      ) : snapshot.error && !snapshot.listed ? (
        <QueryErrorState title={failTitle} error={snapshot.error} onRetry={snapshot.refresh} />
      ) : !snapshot.listed ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{emptyTitle}</EmptyTitle>
            <EmptyDescription>{emptyHint}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        children
      )}
    </>
  )
}

function useNetworkList({
  deviceId,
  type,
  commands,
  latestSuccessful,
  online,
  windows,
  active,
  seed,
}: {
  deviceId: string
  type: string
  commands?: CommandSeed[]
  latestSuccessful?: CommandSeed | null
  online: boolean
  windows: boolean
  active: boolean
  seed: (commands: CommandSeed[]) => CommandSeed | undefined
}): Snapshot {
  const [result, setResult] = React.useState<unknown>(null)
  const [listed, setListed] = React.useState(false)
  const [truncated, setTruncated] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [refreshing, setRefreshing] = React.useState(false)
  const pendingId = React.useRef<string | null>(null)
  const pollAbort = React.useRef<AbortController | null>(null)
  const seeded = React.useRef<string | null>(null)
  const autoQueued = React.useRef(false)
  const onlineRef = React.useRef(online)
  const requestRef = React.useRef<() => Promise<void>>(async () => {})
  onlineRef.current = online
  const socket = useSocket()

  const stopWatch = React.useCallback(() => {
    pollAbort.current?.abort()
    pendingId.current = null
    setPending(false)
    setRefreshing(false)
  }, [])

  React.useEffect(() => {
    setResult(null)
    setListed(false)
    setTruncated(false)
    setPending(false)
    setError(null)
    seeded.current = null
    autoQueued.current = false
    stopWatch()
  }, [deviceId, stopWatch])

  const startWatch = React.useCallback(
    (commandId: string) => {
      pollAbort.current?.abort()
      pendingId.current = commandId
      setError(null)
      setPending(true)
      const ac = new AbortController()
      pollAbort.current = ac
      void (async () => {
        const outcome = await pollAdminCommand(commandId, { signal: ac.signal, timeoutMs: 90_000 })
        if (ac.signal.aborted || pendingId.current !== commandId) return
        if (outcome.kind === "timeout") {
          setError(onlineRef.current ? "timeout" : "agent_offline")
          pendingId.current = null
          setPending(false)
          setRefreshing(false)
          return
        }
        if (outcome.kind === "error") {
          if (outcome.message === "aborted") return
          setError(outcome.message)
          pendingId.current = null
          setPending(false)
          setRefreshing(false)
          return
        }
        const cmd = outcome.command
        const payloadErr = resultPayloadError(cmd.result)
        if (cmd.status === "success" && !payloadErr) {
          setResult(cmd.result)
          setListed(true)
          setTruncated(Boolean((cmd.result as { truncated?: unknown } | null)?.truncated))
          setError(null)
          pendingId.current = null
          setPending(false)
          setRefreshing(false)
          return
        }
        setError(payloadErr || resultErrorMessage(cmd.result, cmd.status, `${type} failed`))
        pendingId.current = null
        setPending(false)
        setRefreshing(false)
      })()
    },
    [type]
  )

  async function requestList() {
    setRefreshing(true)
    const data = await api<{ commands: { id: string }[] }>("/api/v1/admin/commands", {
      method: "POST",
      body: JSON.stringify({ deviceIds: [deviceId], type, payload: type === "get_ports" ? { listenOnly: false } : {} }),
    })
    const id = queuedCommandId(data)
    if (!id) throw new Error("command not queued")
    startWatch(id)
  }
  requestRef.current = requestList

  React.useEffect(() => {
    if (!windows || !active) return
    if (seeded.current === deviceId) {
      if (online && !autoQueued.current && !pendingId.current) {
        autoQueued.current = true
        void requestRef.current().catch((e) => toast.error(e instanceof Error ? e.message : "Refresh failed"))
      }
      return
    }
    seeded.current = deviceId
    autoQueued.current = false
    const success = latestSuccessful?.status === "success" ? latestSuccessful : seed(commands ?? [])
    if (success) {
      setResult(success.result)
      setListed(true)
      setTruncated(Boolean((success.result as { truncated?: unknown } | null)?.truncated))
    }
    const inflight = commands?.find((c) => c.type === type && (c.status === "pending" || c.status === "running"))
    if (inflight) {
      startWatch(inflight.id)
      autoQueued.current = true
      return
    }
    if (online) {
      autoQueued.current = true
      void requestRef.current().catch((e) => toast.error(e instanceof Error ? e.message : "Refresh failed"))
    }
  }, [windows, active, commands, deviceId, online, latestSuccessful, startWatch, seed, type])

  React.useEffect(() => {
    if (!socket) return
    const onResult = (payload: unknown) => {
      if (!payload || typeof payload !== "object") return
      const rec = payload as { id?: string; deviceId?: string; type?: string; status?: string; result?: unknown }
      if (rec.deviceId !== deviceId || rec.type !== type) return
      if (rec.status === "success" && (rec.id === pendingId.current || !pendingId.current) && !resultPayloadError(rec.result)) {
        setResult(rec.result)
        setListed(true)
        setTruncated(Boolean((rec.result as { truncated?: unknown } | null)?.truncated))
        setError(null)
        stopWatch()
      } else if ((rec.status === "failed" || rec.status === "cancelled") && rec.id === pendingId.current) {
        setError(resultErrorMessage(rec.result, rec.status, `${type} failed`))
        stopWatch()
      }
    }
    socket.on(WS_EVENTS.COMMAND_RESULT, onResult)
    return () => {
      socket.off(WS_EVENTS.COMMAND_RESULT, onResult)
    }
  }, [socket, deviceId, type, stopWatch])

  return {
    result,
    listed,
    truncated,
    pending,
    error,
    refreshing,
    refresh: () => {
      void requestList().catch((e) => toast.error(e instanceof Error ? e.message : "Refresh failed"))
    },
  }
}
