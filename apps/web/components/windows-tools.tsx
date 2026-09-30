"use client"

import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  WS_EVENTS,
  eventLogLevelLabel,
  parseAdminCenter,
  parseBitLocker,
  parseCapabilities,
  parseDefender,
  parseEventLog,
  parseTaskList,
  parseWindowsUpdate,
  defenderActionConfirm,
  defenderCancelScanConfirm,
  defenderCommandErrorMessage,
  defenderScanConfirm,
  defenderSettingConfirm,
  isMediaFeaturePack,
  MEDIA_FEATURE_PACK,
  mediaFeaturePackConfirm,
  queuedCommandId,
  quickAssistConfirm,
  resultErrorMessage,
  resultPayloadError,
  taskEnabledConfirm,
  bitLockerActionConfirm,
  type EventLogEntry,
  type ParsedAdminCenter,
  type ParsedDefender,
  type ParsedBitLocker,
  type WindowsCapability,
  type WindowsUpdateItem,
  type BitLockerVolume,
  type ScheduledTask,
  type DefenderThreat,
} from "@workspace/shared"

import { api } from "@/lib/api"
import { pollAdminCommand } from "@/lib/command-poll"
import { useSocket } from "@/components/providers"
import { QueryErrorBanner, QueryErrorState } from "@/components/query-error"
import { SmbExplorer } from "@/components/smb-explorer"
import { type TransferRow } from "@/components/file-explorer"
import { type E2ESession } from "@/lib/e2e"
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
import { Field, FieldGroup, FieldLabel } from "@workspace/ui/components/field"
import { Spinner } from "@workspace/ui/components/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@workspace/ui/components/tabs"
import { UpdateApprovals } from "@/components/update-approvals"
import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Switch } from "@workspace/ui/components/switch"

type CommandSeed = { id: string; type: string; status: string; result?: unknown }

export function WindowsTools({
  deviceId,
  platform,
  commands,
  online = false,
  latestSuccessful,
  transfers = [],
  e2e = null,
}: {
  deviceId: string
  platform: string
  commands?: CommandSeed[]
  online?: boolean
  latestSuccessful?: {
    get_event_log?: CommandSeed | null
    get_windows_update?: CommandSeed | null
    get_admin_center?: CommandSeed | null
    get_tasks?: CommandSeed | null
    get_defender?: CommandSeed | null
    get_bitlocker?: CommandSeed | null
    get_capabilities?: CommandSeed | null
    get_smb?: CommandSeed | null
  }
  transfers?: TransferRow[]
  e2e?: E2ESession | null
}) {
  const windows = platform.toLowerCase() === "windows"
  const [tab, setTab] = React.useState("events")
  const [eventLogName, setEventLogName] = React.useState("System")
  const [eventLevel, setEventLevel] = React.useState("all")
  const [eventChannel, setEventChannel] = React.useState("")
  const [eventId, setEventId] = React.useState("")
  const [eventSource, setEventSource] = React.useState("")
  const [eventSince, setEventSince] = React.useState("")
  const [eventUntil, setEventUntil] = React.useState("")
  const [updateOnline, setUpdateOnline] = React.useState(false)
  const events = useNativeList({
    deviceId,
    type: "get_event_log",
    payload: {
      log: eventChannel.trim() || eventLogName,
      newest: 50,
      level: eventLevel,
      ...(eventId.trim() && Number.isFinite(Number(eventId)) ? { eventId: Number(eventId) } : {}),
      ...(eventSource.trim() ? { source: eventSource.trim() } : {}),
      ...(eventSince ? { since: new Date(eventSince).toISOString() } : {}),
      ...(eventUntil ? { until: new Date(eventUntil).toISOString() } : {}),
    },
    commands,
    latestSuccessful: latestSuccessful?.get_event_log ?? null,
    online,
    windows,
    active: tab === "events",
    timeoutMs: 90_000,
  })
  const updates = useNativeList({
    deviceId,
    type: "get_windows_update",
    payload: { online: updateOnline },
    commands,
    latestSuccessful: latestSuccessful?.get_windows_update ?? null,
    online,
    windows,
    active: tab === "updates",
    timeoutMs: 120_000,
  })
  const wac = useNativeList({
    deviceId,
    type: "get_admin_center",
    payload: {},
    commands,
    latestSuccessful: latestSuccessful?.get_admin_center ?? null,
    online,
    windows,
    active: tab === "wac",
    timeoutMs: 90_000,
  })
  const tasks = useNativeList({
    deviceId,
    type: "get_tasks",
    payload: {},
    commands,
    latestSuccessful: latestSuccessful?.get_tasks ?? null,
    online,
    windows,
    active: tab === "tasks",
    timeoutMs: 90_000,
  })
  const defender = useNativeList({
    deviceId,
    type: "get_defender",
    payload: {},
    commands,
    latestSuccessful: latestSuccessful?.get_defender ?? null,
    online,
    windows,
    active: tab === "defender",
    timeoutMs: 90_000,
  })
  const bitlocker = useNativeList({
    deviceId,
    type: "get_bitlocker",
    payload: {},
    commands,
    latestSuccessful: latestSuccessful?.get_bitlocker ?? null,
    online,
    windows,
    active: tab === "bitlocker",
    timeoutMs: 90_000,
  })
  const caps = useNativeList({
    deviceId,
    type: "get_capabilities",
    payload: {},
    commands,
    latestSuccessful: latestSuccessful?.get_capabilities ?? null,
    online,
    windows,
    active: tab === "caps",
    timeoutMs: 120_000,
  })
  const assist = useQuickAssist({ deviceId, online, windows })
  const taskWrite = useTaskEnabled({ deviceId, online, windows, onDone: () => tasks.refresh() })
  const capInstall = useCapabilityInstall({ deviceId, online, windows, onDone: () => caps.refresh() })

  if (!windows) {
    return <p className="text-sm text-muted-foreground">Native Event Log, Windows Update, Quick Assist, Admin Center, Task Scheduler, Defender, BitLocker, capabilities, and SMB shares are Windows-only.</p>
  }

  const eventLog = parseEventLog(events.result)
  const wu = parseWindowsUpdate(updates.result)
  const gateway = parseAdminCenter(wac.result)
  const taskList = parseTaskList(tasks.result)
  const mp = parseDefender(defender.result)
  const bl = parseBitLocker(bitlocker.result)
  const features = parseCapabilities(caps.result)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          EvtQuery, WUAPI, Task Scheduler, Defender, BitLocker, and DISM are native APIs. SMB uses NetShareEnum / WNet.
          Writes confirm. Nothing launches MMC from Session 0. Capability installs are limited to the Media Feature Pack.
        </p>
        <Button size="sm" variant="outline" onClick={() => assist.confirm()} disabled={!online || assist.pending}>
          {assist.pending ? <Spinner className="size-4" /> : null}
          Open Quick Assist
        </Button>
      </div>
      {assist.error ? <QueryErrorBanner error={assist.error} onRetry={() => assist.confirm()} /> : null}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="events">Event log</TabsTrigger>
          <TabsTrigger value="updates">Updates</TabsTrigger>
          <TabsTrigger value="wac">Admin Center</TabsTrigger>
          <TabsTrigger value="tasks">Tasks</TabsTrigger>
          <TabsTrigger value="defender">Defender</TabsTrigger>
          <TabsTrigger value="bitlocker">BitLocker</TabsTrigger>
          <TabsTrigger value="caps">Capabilities</TabsTrigger>
          <TabsTrigger value="smb">SMB</TabsTrigger>
        </TabsList>
        <TabsContent value="events" className="mt-4">
          <NativePanel
            pending={events.pending}
            listed={events.listed}
            error={events.error}
            online={online}
            emptyHint="Refresh to queue get_event_log."
            truncated={eventLog.truncated}
            onRefresh={() => events.refresh()}
          >
            <div className="mb-3 flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Channel</p>
                <Select
                  items={[
                    { value: "System", label: "System" },
                    { value: "Application", label: "Application" },
                    { value: "Security", label: "Security" },
                  ]}
                  value={eventLogName}
                  onValueChange={(v) => setEventLogName(String(v))}
                >
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="System">System</SelectItem>
                      <SelectItem value="Application">Application</SelectItem>
                      <SelectItem value="Security">Security</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Level</p>
                <Select
                  items={[
                    { value: "all", label: "All" },
                    { value: "critical", label: "Critical" },
                    { value: "error", label: "Error" },
                    { value: "warning", label: "Warning" },
                    { value: "information", label: "Information" },
                  ]}
                  value={eventLevel}
                  onValueChange={(v) => setEventLevel(String(v))}
                >
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="all">All</SelectItem>
                      <SelectItem value="critical">Critical</SelectItem>
                      <SelectItem value="error">Error</SelectItem>
                      <SelectItem value="warning">Warning</SelectItem>
                      <SelectItem value="information">Information</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Other channel</p>
                <Input value={eventChannel} onChange={(e) => setEventChannel(e.target.value)} placeholder="Microsoft-Windows-..." className="w-52" />
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Event ID</p>
                <Input value={eventId} onChange={(e) => setEventId(e.target.value)} className="w-24" />
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Source</p>
                <Input value={eventSource} onChange={(e) => setEventSource(e.target.value)} className="w-40" />
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">From</p>
                <Input type="datetime-local" value={eventSince} onChange={(e) => setEventSince(e.target.value)} className="w-52" />
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">To</p>
                <Input type="datetime-local" value={eventUntil} onChange={(e) => setEventUntil(e.target.value)} className="w-52" />
              </div>
              <p className="text-xs text-muted-foreground">Refresh to apply.</p>
            </div>
            <EventTable rows={eventLog.entries} />
          </NativePanel>
        </TabsContent>
        <TabsContent value="updates" className="mt-4">
          <NativePanel
            pending={updates.pending}
            listed={updates.listed}
            error={updates.error}
            online={online}
            emptyHint="Refresh to queue get_windows_update."
            truncated={wu.truncated}
            onRefresh={() => updates.refresh()}
          >
            <label className="mb-3 flex items-center gap-2 text-sm">
              <Switch checked={updateOnline} onCheckedChange={setUpdateOnline} />
              Online search (slower). Refresh to apply.
            </label>
            <UpdateTables pending={wu.pending} installed={wu.installed} />
            <UpdateApprovals deviceId={deviceId} />
          </NativePanel>
        </TabsContent>
        <TabsContent value="wac" className="mt-4">
          <NativePanel
            pending={wac.pending}
            listed={wac.listed}
            error={wac.error}
            online={online}
            emptyHint="Refresh to queue get_admin_center."
            onRefresh={() => wac.refresh()}
          >
            <WacCard gateway={gateway} listed={wac.listed} />
          </NativePanel>
        </TabsContent>
        <TabsContent value="tasks" className="mt-4">
          <NativePanel
            pending={tasks.pending}
            listed={tasks.listed}
            error={tasks.error}
            online={online}
            emptyHint="Refresh to queue get_tasks."
            truncated={taskList.truncated}
            onRefresh={() => tasks.refresh()}
          >
            <TaskTable rows={taskList.tasks} onToggle={(row, enabled) => taskWrite.confirm(row.path, enabled)} pending={taskWrite.pending} />
          </NativePanel>
        </TabsContent>
        <TabsContent value="defender" className="mt-4">
          <NativePanel
            pending={defender.pending}
            listed={defender.listed}
            error={defender.error}
            online={online}
            emptyHint="Refresh to queue get_defender."
            onRefresh={() => defender.refresh()}
          >
            <DefenderPanel
              status={mp}
              listed={defender.listed}
              deviceId={deviceId}
              online={online}
              onRefresh={() => defender.refresh()}
            />
          </NativePanel>
        </TabsContent>
        <TabsContent value="bitlocker" className="mt-4">
          <NativePanel
            pending={bitlocker.pending}
            listed={bitlocker.listed}
            error={bitlocker.error}
            online={online}
            emptyHint="Refresh to queue get_bitlocker."
            truncated={bl.truncated}
            onRefresh={() => bitlocker.refresh()}
          >
            <BitLockerPanel
              snapshot={bl}
              listed={bitlocker.listed}
              deviceId={deviceId}
              online={online}
              onRefresh={() => bitlocker.refresh()}
            />
          </NativePanel>
        </TabsContent>
        <TabsContent value="caps" className="mt-4">
          <NativePanel
            pending={caps.pending}
            listed={caps.listed}
            error={caps.error}
            online={online}
            emptyHint="Refresh to queue get_capabilities."
            truncated={features.truncated}
            onRefresh={() => caps.refresh()}
          >
            <CapabilityTable
              rows={features.capabilities}
              online={online}
              pending={capInstall.pending}
              onInstall={() => capInstall.confirm()}
            />
          </NativePanel>
        </TabsContent>
        <TabsContent value="smb" className="mt-4">
          <SmbExplorer
            deviceId={deviceId}
            commands={commands}
            online={online}
            latestSuccessful={latestSuccessful?.get_smb ?? null}
            transfers={transfers}
            e2e={e2e}
          />
        </TabsContent>
      </Tabs>
      <AlertDialog open={assist.open} onOpenChange={(open) => !open && assist.cancel()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Open Quick Assist?</AlertDialogTitle>
            <AlertDialogDescription>{quickAssistConfirm("quickassist")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => assist.run()}>Confirm</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={!!taskWrite.target} onOpenChange={(open) => !open && taskWrite.cancel()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{taskWrite.target?.enabled ? "Enable task?" : "Disable task?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {taskWrite.target ? taskEnabledConfirm(taskWrite.target.path, taskWrite.target.enabled) : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => taskWrite.run()}>Confirm</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={capInstall.open} onOpenChange={(open) => !open && capInstall.cancel()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Install Media Feature Pack?</AlertDialogTitle>
            <AlertDialogDescription>{mediaFeaturePackConfirm()}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => capInstall.run()}>Confirm</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function NativePanel({
  pending,
  listed,
  error,
  online,
  emptyHint,
  truncated,
  onRefresh,
  children,
}: {
  pending: boolean
  listed: boolean
  error: string | null
  online: boolean
  emptyHint: string
  truncated?: boolean
  onRefresh: () => void
  children: React.ReactNode
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => void onRefresh()} disabled={!online || pending}>
          {pending ? <Spinner className="size-4" /> : null}
          Refresh
        </Button>
        {truncated ? <Badge variant="secondary">Truncated</Badge> : null}
      </div>
      {error && listed ? <QueryErrorBanner cached error={error} onRetry={() => void onRefresh()} /> : null}
      {error && !listed ? <QueryErrorState title="Windows tool failed" error={error} onRetry={() => void onRefresh()} /> : null}
      {!listed && pending ? <p className="text-sm text-muted-foreground">Waiting for agent…</p> : null}
      {!listed && !pending && !error ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No snapshot yet</EmptyTitle>
            <EmptyDescription>{emptyHint}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {listed ? children : null}
    </div>
  )
}

function EventTable({ rows }: { rows: EventLogEntry[] }) {
  if (!rows.length) {
    return <p className="text-sm text-muted-foreground">No events in this query.</p>
  }
  return (
    <div className="overflow-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Time</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>ID</TableHead>
            <TableHead>Message</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => (
            <TableRow key={`${row.id}-${row.time}-${i}`}>
              <TableCell className="whitespace-nowrap font-mono text-xs">{row.time}</TableCell>
              <TableCell>
                <Badge variant={row.type === "Error" || row.type === "Critical" ? "destructive" : "secondary"}>
                  {eventLogLevelLabel(row.type)}
                </Badge>
              </TableCell>
              <TableCell className="max-w-40 truncate" title={row.source}>
                {row.source}
              </TableCell>
              <TableCell className="font-mono text-xs">{row.id}</TableCell>
              <TableCell className="max-w-[28rem] truncate text-muted-foreground" title={row.message}>
                {row.message}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function UpdateTables({ pending, installed }: { pending: WindowsUpdateItem[]; installed: WindowsUpdateItem[] }) {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="mb-2 text-sm font-medium">Pending</h3>
        <UpdateTable rows={pending} empty="No pending updates in the local cache." />
      </div>
      <div>
        <h3 className="mb-2 text-sm font-medium">Recently installed</h3>
        <UpdateTable rows={installed} empty="No update history." history />
      </div>
    </div>
  )
}

function UpdateTable({ rows, empty, history }: { rows: WindowsUpdateItem[]; empty: string; history?: boolean }) {
  if (!rows.length) {
    return <p className="text-sm text-muted-foreground">{empty}</p>
  }
  return (
    <div className="overflow-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>KB</TableHead>
            {history ? <TableHead>Result</TableHead> : <TableHead>Severity</TableHead>}
            {history ? <TableHead>Date</TableHead> : <TableHead>Flags</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => (
            <TableRow key={`${row.title}-${i}`}>
              <TableCell className="max-w-md truncate" title={row.title}>
                {row.title}
              </TableCell>
              <TableCell className="font-mono text-xs">{row.kb?.join(", ") || "—"}</TableCell>
              <TableCell>{history ? row.result || "—" : row.severity || "—"}</TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {history
                  ? row.date || "—"
                  : [row.rebootRequired ? "reboot" : null, row.isDownloaded ? "downloaded" : null].filter(Boolean).join(", ") ||
                    "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function WacCard({ gateway, listed }: { gateway: ParsedAdminCenter | null; listed: boolean }) {
  if (!listed || !gateway) {
    return null
  }
  return (
    <div className="space-y-2 text-sm">
      <p>
        <span className="text-muted-foreground">Service </span>
        <span className="font-mono">{gateway.name}</span>
      </p>
      <p>
        {gateway.installed ? (
          <Badge>{gateway.running ? "Running" : "Installed, not running"}</Badge>
        ) : (
          <Badge variant="secondary">Not installed</Badge>
        )}
        {gateway.startType ? <span className="ml-2 text-muted-foreground">{gateway.startType}</span> : null}
      </p>
      {gateway.url ? (
        <p className="truncate font-mono text-xs" title={gateway.url}>
          {gateway.url}
        </p>
      ) : gateway.installed ? (
        <p className="text-muted-foreground">Gateway URL not published in the registry.</p>
      ) : null}
    </div>
  )
}

function TaskTable({
  rows,
  onToggle,
  pending,
}: {
  rows: ScheduledTask[]
  onToggle: (row: ScheduledTask, enabled: boolean) => void
  pending: boolean
}) {
  const [filter, setFilter] = React.useState("")
  const q = filter.trim().toLowerCase()
  const visible = rows.filter(
    (row) => !q || row.name.toLowerCase().includes(q) || row.path.toLowerCase().includes(q)
  )
  if (!rows.length) {
    return <p className="text-sm text-muted-foreground">No scheduled tasks in this snapshot.</p>
  }
  return (
    <div className="space-y-3">
      <Input className="max-w-xs" placeholder="Filter tasks" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <div className="overflow-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Enabled</TableHead>
              <TableHead>Last run</TableHead>
              <TableHead className="w-[1%] whitespace-nowrap" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((row) => (
              <TableRow key={row.path || row.name}>
                <TableCell className="min-w-0 max-w-[18rem]">
                  <div className="truncate" title={row.name}>
                    {row.name}
                  </div>
                  <div className="truncate font-mono text-xs text-muted-foreground" title={row.path}>
                    {row.path}
                  </div>
                </TableCell>
                <TableCell>{row.state || "—"}</TableCell>
                <TableCell>{row.enabled ? "Yes" : "No"}</TableCell>
                <TableCell className="whitespace-nowrap font-mono text-xs">{row.lastRunTime || "—"}</TableCell>
                <TableCell className="w-[1%] whitespace-nowrap">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => onToggle(row, !row.enabled)}
                  >
                    {row.enabled ? "Disable" : "Enable"}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function DefenderPanel({
  status,
  listed,
  deviceId,
  online,
  onRefresh,
}: {
  status: ParsedDefender | null
  listed: boolean
  deviceId: string
  online: boolean
  onRefresh: () => void
}) {
  const write = useDefenderWrite({ deviceId, online, onDone: onRefresh })
  if (!listed) return null
  if (!status) {
    return (
      <p className="text-sm text-muted-foreground">
        Defender returned no usable status (unavailable or error). This is not the same as all protections off.
      </p>
    )
  }
  if (status.available === false) {
    return (
      <p className="text-sm text-muted-foreground">
        Microsoft Defender is not available on this device (missing WMI class or PowerShell module).
      </p>
    )
  }
  const pref = status.preferences
  const threatCount = status.threatCount ?? status.threats?.length ?? 0
  const active = status.activeThreatCount ?? 0
  const tamper = Boolean(status.tamperProtected)
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={!online || write.pending} onClick={() => write.scan("quick")}>
          Quick scan
        </Button>
        <Button size="sm" variant="outline" disabled={!online || write.pending} onClick={() => write.scan("full")}>
          Full scan
        </Button>
        <Button size="sm" variant="outline" disabled={!online || write.pending} onClick={() => write.scan("offline")}>
          Offline scan
        </Button>
        <Button size="sm" variant="outline" disabled={!online || write.pending || !status.scanInProgress} onClick={() => write.cancelScan()}>
          Cancel scan
        </Button>
        <Button size="sm" variant="outline" disabled={!online || write.pending} onClick={() => write.update()}>
          Update signatures
        </Button>
        {status.scanInProgress ? <Badge variant="secondary">Scan in progress {status.scanType || ""}</Badge> : null}
      </div>
      <div className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <Stat label="Antivirus" on={status.antivirusEnabled} />
        <Stat label="Real-time" on={status.realtimeProtectionEnabled} />
        <Stat label="Antispyware" on={status.antispywareEnabled} />
        <Stat label="Behavior" on={status.behaviorMonitorEnabled} />
        <Stat label="On-access" on={status.onAccessProtectionEnabled} />
        <Stat label="IOAV" on={status.ioavProtectionEnabled} />
        <Stat label="NIS" on={status.nisEnabled} />
        <Stat label="Tamper" on={status.tamperProtected} />
        {status.computerState ? <p className="text-muted-foreground">State {status.computerState}</p> : null}
        {status.rebootRequired ? <Badge variant="destructive">Reboot required</Badge> : null}
        {status.defenderSignaturesOutOfDate ? <Badge variant="destructive">Signatures stale</Badge> : null}
        {status.quickScanOverdue ? <Badge variant="destructive">Quick scan overdue</Badge> : null}
        {status.fullScanOverdue ? <Badge variant="destructive">Full scan overdue</Badge> : null}
        {status.antivirusSignatureVersion ? (
          <p className="font-mono text-xs">AV sig {status.antivirusSignatureVersion}</p>
        ) : null}
        {status.antivirusSignatureUpdated ? (
          <p className="text-muted-foreground">Signatures {status.antivirusSignatureUpdated}</p>
        ) : null}
        {status.amEngineVersion ? <p className="font-mono text-xs">Engine {status.amEngineVersion}</p> : null}
        {status.productVersion ? <p className="font-mono text-xs">Product {status.productVersion}</p> : null}
        {status.serviceVersion ? <p className="font-mono text-xs">Service {status.serviceVersion}</p> : null}
        {status.antivirusSignatureAge != null ? (
          <p className="text-muted-foreground">Signature age {status.antivirusSignatureAge}d</p>
        ) : null}
        {status.quickScanAge != null ? <p className="text-muted-foreground">Quick scan age {status.quickScanAge}d</p> : null}
        {status.fullScanAge != null ? <p className="text-muted-foreground">Full scan age {status.fullScanAge}d</p> : null}
        {status.lastQuickScan ? <p className="text-muted-foreground">Quick scan {status.lastQuickScan}</p> : null}
        {status.lastFullScan ? <p className="text-muted-foreground">Full scan {status.lastFullScan}</p> : null}
        {status.lastQuickScanStart ? <p className="text-muted-foreground">Quick start {status.lastQuickScanStart}</p> : null}
        {status.lastFullScanStart ? <p className="text-muted-foreground">Full start {status.lastFullScanStart}</p> : null}
        <p className="text-muted-foreground">
          Threats {threatCount}
          {active ? ` (${active} active)` : ""}
        </p>
        {status.source ? <p className="text-xs text-muted-foreground">Source {status.source}</p> : null}
      </div>
      {tamper ? (
        <p className="text-sm text-muted-foreground">
          Tamper Protection is on. Set-MpPreference toggles are disabled here until it is turned off in Windows Security.
          Scans, signature updates, and threat actions still work.
        </p>
      ) : null}
      {pref ? (
        <div className="space-y-3">
          <h3 className="text-sm font-medium">Settings</h3>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={!online || write.pending || tamper} onClick={() => write.setting({ realtime: !pref.realtimeMonitoring }, "realtime")}>
              Real-time {pref.realtimeMonitoring ? "on" : "off"}
            </Button>
            <Button size="sm" variant="outline" disabled={!online || write.pending || tamper} onClick={() => write.setting({ behavior: !pref.behaviorMonitoring }, "behavior")}>
              Behavior {pref.behaviorMonitoring ? "on" : "off"}
            </Button>
            <Button size="sm" variant="outline" disabled={!online || write.pending || tamper} onClick={() => write.setting({ ioav: !pref.ioavProtection }, "ioav")}>
              IOAV {pref.ioavProtection ? "on" : "off"}
            </Button>
            <Button size="sm" variant="outline" disabled={!online || write.pending || tamper} onClick={() => write.setting({ scriptScanning: !pref.scriptScanning }, "scriptScanning")}>
              Script {pref.scriptScanning ? "on" : "off"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!online || write.pending || tamper}
              onClick={() =>
                write.setting(
                  { cloudProtection: pref.cloudProtection === "advanced" ? "disabled" : pref.cloudProtection === "basic" ? "advanced" : "basic" },
                  "cloud"
                )
              }
            >
              Cloud {pref.cloudProtection || "—"}
            </Button>
            <Button size="sm" variant="outline" disabled={!online || write.pending || tamper} onClick={() => write.setting({ pua: pref.puaProtection !== "enabled" }, "pua")}>
              PUA {pref.puaProtection || "—"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!online || write.pending || tamper}
              onClick={() => write.setting({ networkProtection: pref.networkProtection === "enabled" ? "disabled" : "enabled" }, "network")}
            >
              Network {pref.networkProtection || "—"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!online || write.pending || tamper}
              onClick={() =>
                write.setting(
                  { controlledFolderAccess: pref.controlledFolderAccess === "enabled" ? "disabled" : "enabled" },
                  "controlledFolderAccess"
                )
              }
            >
              Folder access {pref.controlledFolderAccess || "—"}
            </Button>
          </div>
          {pref.cloudBlockLevel ? <p className="text-xs text-muted-foreground">Cloud block {pref.cloudBlockLevel}</p> : null}
          {pref.submitSamples ? <p className="text-xs text-muted-foreground">Sample submission {pref.submitSamples}</p> : null}
          {pref.asrRules?.length ? (
            <p className="truncate text-xs text-muted-foreground" title={pref.asrRules.map((rule) => `${rule.name || rule.id} ${rule.action || ""}`.trim()).join(" · ")}>
              ASR (read-only): {pref.asrRules.slice(0, 8).map((rule) => `${rule.name || rule.id} ${rule.action || ""}`.trim()).join(" · ")}
            </p>
          ) : null}
          {pref.exclusionPaths?.length ? (
            <p className="truncate text-xs text-muted-foreground" title={pref.exclusionPaths.join(", ")}>
              Path exclusions: {pref.exclusionPaths.slice(0, 8).join(", ")}
            </p>
          ) : null}
          {pref.exclusionExtensions?.length ? (
            <p className="truncate text-xs text-muted-foreground" title={pref.exclusionExtensions.join(", ")}>
              Extension exclusions: {pref.exclusionExtensions.slice(0, 8).join(", ")}
            </p>
          ) : null}
          {pref.exclusionProcesses?.length ? (
            <p className="truncate text-xs text-muted-foreground" title={pref.exclusionProcesses.join(", ")}>
              Process exclusions: {pref.exclusionProcesses.slice(0, 8).join(", ")}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Protection history</h3>
        <ThreatTable rows={status.threats ?? []} onAction={(id, action) => write.threat(id, action)} pending={write.pending} />
        {status.threatsTruncated ? <p className="text-xs text-muted-foreground">History truncated.</p> : null}
      </div>
      <AlertDialog open={!!write.confirm} onOpenChange={(open) => !open && write.cancel()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Defender change</AlertDialogTitle>
            <AlertDialogDescription>{write.confirm?.message}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => write.run()}>Confirm</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function Stat({ label, on }: { label: string; on?: boolean }) {
  return (
    <p>
      {label} <Badge variant={on ? "secondary" : "outline"}>{on ? "on" : "off"}</Badge>
    </p>
  )
}

function ThreatTable({
  rows,
  onAction,
  pending,
}: {
  rows: DefenderThreat[]
  onAction: (id: string, action: "remove" | "restore" | "allow") => void
  pending: boolean
}) {
  if (!rows.length) {
    return <p className="text-sm text-muted-foreground">No recent threat detections in this snapshot.</p>
  }
  return (
    <div className="overflow-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Threat</TableHead>
            <TableHead>Severity</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>When</TableHead>
            <TableHead className="w-[1%] whitespace-nowrap" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, index) => (
            <TableRow key={row.instanceId || `${row.id}-${row.detectionTime ?? "na"}-${index}`}>
              <TableCell className="min-w-0 max-w-[16rem]">
                <div className="truncate" title={row.name}>
                  {row.name}
                </div>
                <div className="truncate font-mono text-xs text-muted-foreground" title={row.id}>
                  {row.id}
                </div>
                {row.process ? (
                  <div className="truncate text-xs text-muted-foreground" title={row.process}>
                    {row.process}
                  </div>
                ) : null}
                {row.user ? (
                  <div className="truncate text-xs text-muted-foreground" title={row.user}>
                    {row.user}
                  </div>
                ) : null}
              </TableCell>
              <TableCell>{row.severity || "—"}</TableCell>
              <TableCell>{row.status || row.action || "—"}</TableCell>
              <TableCell className="whitespace-nowrap font-mono text-xs">{row.detectionTime || "—"}</TableCell>
              <TableCell className="w-[1%] space-x-2 whitespace-nowrap">
                <Button size="sm" variant="destructive" disabled={pending} onClick={() => onAction(row.id, "remove")}>
                  Remediate
                </Button>
                <Button size="sm" variant="outline" disabled={pending} onClick={() => onAction(row.id, "allow")}>
                  Allow
                </Button>
                <Button size="sm" variant="outline" disabled={pending} onClick={() => onAction(row.id, "restore")}>
                  Restore
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function useDefenderWrite({
  deviceId,
  online,
  onDone,
}: {
  deviceId: string
  online: boolean
  onDone: () => void
}) {
  const [confirm, setConfirm] = React.useState<{ message: string; run: () => Promise<void> } | null>(null)
  const [pending, setPending] = React.useState(false)

  async function queue(type: string, payload: Record<string, unknown>, ok: string) {
    setConfirm(null)
    if (!online) return
    setPending(true)
    const pollMs = type === "update_defender" ? 12 * 60_000 : type === "start_defender_scan" ? 3 * 60_000 : 120_000
    try {
      const data = await api<{ commands: { id: string }[] }>("/api/v1/admin/commands", {
        method: "POST",
        body: JSON.stringify({ deviceIds: [deviceId], type, payload }),
      })
      const id = queuedCommandId(data)
      if (!id) throw new Error("command not queued")
      const ac = new AbortController()
      const outcome = await pollAdminCommand(id, { signal: ac.signal, timeoutMs: pollMs })
      if (outcome.kind === "timeout") toast.error(online ? "Command timed out" : "Agent offline")
      else if (outcome.kind === "error") toast.error(outcome.message)
      else if (outcome.command.status !== "success") {
        toast.error(defenderCommandErrorMessage(resultErrorMessage(outcome.command.result, outcome.command.status, "Defender command failed")))
      } else {
        const payloadErr = resultPayloadError(outcome.command.result)
        if (payloadErr) {
          toast.error(defenderCommandErrorMessage(payloadErr))
        } else {
          toast.success(ok)
          onDone()
        }
      }
    } catch (e) {
      toast.error(defenderCommandErrorMessage(e instanceof Error ? e.message : "Defender command failed"))
    } finally {
      setPending(false)
    }
  }

  return {
    pending,
    confirm,
    cancel: () => setConfirm(null),
    run: () => confirm?.run(),
    scan: (type: "quick" | "full" | "offline") =>
      setConfirm({
        message: defenderScanConfirm(type),
        run: () => queue("start_defender_scan", { type }, `${type} scan started`),
      }),
    update: () =>
      setConfirm({
        message: "Update Microsoft Defender signatures on this device?",
        run: () => queue("update_defender", {}, "Signatures updated"),
      }),
    setting: (payload: Record<string, unknown>, kind: string) => {
      setConfirm({
        message: defenderSettingConfirm(kind),
        run: () => queue("set_defender", payload, "Defender setting applied"),
      })
    },
    threat: (threatId: string, action: "remove" | "restore" | "allow") =>
      setConfirm({
        message: defenderActionConfirm(action, threatId),
        run: () => queue("defender_action", { threatId, action }, "Threat action completed"),
      }),
    cancelScan: () =>
      setConfirm({
        message: defenderCancelScanConfirm(),
        run: () => queue("cancel_defender_scan", {}, "Scan cancelled"),
      }),
  }
}

function bitLockerUnavailableReason(reason?: string): string {
  switch (reason) {
    case "home_sku_or_no_wmi":
      return "BitLocker WMI is not available on this SKU (Windows Home or missing MicrosoftVolumeEncryption). This is not an empty disk list."
    case "bitlocker_query_failed":
      return "BitLocker query failed on this device. The agent could not read WMI or manage-bde."
    default:
      return reason
        ? `BitLocker is unavailable (${reason}).`
        : "BitLocker is unavailable on this device. The agent did not return a volume list."
  }
}

function BitLockerPanel({
  snapshot,
  listed,
  deviceId,
  online,
  onRefresh,
}: {
  snapshot: ParsedBitLocker
  listed: boolean
  deviceId: string
  online: boolean
  onRefresh: () => void
}) {
  const write = useBitLockerWrite({ deviceId, online, onDone: onRefresh })
  const [form, setForm] = React.useState<BitLockerForm | null>(null)
  if (!listed) return null
  if (!snapshot.available) {
    return <p className="text-sm text-muted-foreground">{bitLockerUnavailableReason(snapshot.reason)}</p>
  }
  if (!snapshot.volumes.length) {
    return <p className="text-sm text-muted-foreground">No encryptable volumes reported.</p>
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Protect, unlock, and key-protector changes use Enable/Disable/Lock/Unlock-BitLocker or manage-bde. Recovery
        passwords from Protect / Backup key are AES-256-GCM in the credential vault and stripped from history. PIN
        protectors are not written from this dashboard.
      </p>
      <div className="overflow-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Volume</TableHead>
              <TableHead>Protection</TableHead>
              <TableHead>Lock</TableHead>
              <TableHead>Method</TableHead>
              <TableHead>%</TableHead>
              <TableHead>Protectors</TableHead>
              <TableHead className="w-[1%] whitespace-nowrap" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {snapshot.volumes.map((row, i) => {
              const mount = row.mountPoint || row.deviceId || ""
              const protectors = row.keyProtectors ?? []
              return (
                <TableRow key={row.deviceId || row.mountPoint || i}>
                  <TableCell className="min-w-0 max-w-[12rem] font-mono text-xs">
                    <div className="truncate" title={row.mountPoint || undefined}>
                      {row.mountPoint || "—"}
                    </div>
                    {row.deviceId && row.deviceId !== row.mountPoint ? (
                      <div className="truncate text-muted-foreground" title={row.deviceId}>
                        {row.deviceId}
                      </div>
                    ) : null}
                    {row.volumeType ? <div className="text-muted-foreground">{row.volumeType}</div> : null}
                  </TableCell>
                  <TableCell>
                    <Badge variant={row.protectionStatus === "on" ? "secondary" : "outline"}>{row.protectionStatus}</Badge>
                    <div className="text-xs text-muted-foreground">{row.conversionStatus || "—"}</div>
                    {row.encryptionFlags ? (
                      <div className="text-xs text-muted-foreground">
                        {row.encryptionFlags === "used_space" ? "used space only" : row.encryptionFlags === "full" ? "full disk" : row.encryptionFlags}
                      </div>
                    ) : null}
                    {row.autoUnlock != null ? (
                      <div className="text-xs text-muted-foreground">auto-unlock {row.autoUnlock ? "on" : "off"}</div>
                    ) : null}
                  </TableCell>
                  <TableCell>{row.lockStatus || "—"}</TableCell>
                  <TableCell>{row.encryptionMethod || "—"}</TableCell>
                  <TableCell>{row.encryptionPercent != null ? `${row.encryptionPercent}%` : "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {protectors.length ? protectors.map((p) => p.type).join(", ") : "—"}
                  </TableCell>
                  <TableCell className="w-[1%] space-y-1">
                    <div className="flex flex-wrap gap-1">
                      <Button size="sm" variant="outline" disabled={!online || write.pending || !mount} onClick={() => setForm({ kind: "protect", mount })}>
                        Protect
                      </Button>
                      <Button size="sm" variant="outline" disabled={!online || write.pending || !mount} onClick={() => write.act("unprotect", mount)}>
                        Unprotect
                      </Button>
                      <Button size="sm" variant="outline" disabled={!online || write.pending || !mount} onClick={() => write.act("lock", mount)}>
                        Lock
                      </Button>
                      <Button size="sm" variant="outline" disabled={!online || write.pending || !mount} onClick={() => setForm({ kind: "unlock", mount })}>
                        Unlock
                      </Button>
                      <Button size="sm" variant="outline" disabled={!online || write.pending || !mount} onClick={() => write.act("suspend", mount)}>
                        Suspend
                      </Button>
                      <Button size="sm" variant="outline" disabled={!online || write.pending || !mount} onClick={() => write.act("resume", mount)}>
                        Resume
                      </Button>
                      <Button size="sm" variant="outline" disabled={!online || write.pending || !mount} onClick={() => setForm({ kind: "add", mount })}>
                        Add protector
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!online || write.pending || !mount || !protectors.length}
                        onClick={() => setForm({ kind: "remove", mount, protectors })}
                      >
                        Remove protector
                      </Button>
                      <Button size="sm" variant="outline" disabled={!online || write.pending || !mount} onClick={() => write.act("backup_key", mount)}>
                        Backup key
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
      <BitLockerFormDialog
        form={form}
        pending={write.pending}
        onClose={() => setForm(null)}
        onSubmit={(payload) => {
          const action = String(payload.action ?? "")
          const mount = String(payload.mountPoint ?? "")
          setForm(null)
          write.act(action, mount, payload)
        }}
      />
      <AlertDialog open={!!write.confirm} onOpenChange={(open) => !open && write.cancel()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm BitLocker change</AlertDialogTitle>
            <AlertDialogDescription>{write.confirm?.message}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => write.run()}>Confirm</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

type BitLockerForm =
  | { kind: "unlock"; mount: string }
  | { kind: "protect"; mount: string }
  | { kind: "add"; mount: string }
  | { kind: "remove"; mount: string; protectors: NonNullable<BitLockerVolume["keyProtectors"]> }

function BitLockerFormDialog({
  form,
  pending,
  onClose,
  onSubmit,
}: {
  form: BitLockerForm | null
  pending: boolean
  onClose: () => void
  onSubmit: (payload: Record<string, unknown>) => void
}) {
  const [password, setPassword] = React.useState("")
  const [recovery, setRecovery] = React.useState("")
  const [useRecovery, setUseRecovery] = React.useState(false)
  const [method, setMethod] = React.useState("xts_aes128")
  const [usedSpaceOnly, setUsedSpaceOnly] = React.useState(true)
  const [protectorType, setProtectorType] = React.useState("recovery")
  const [protectorId, setProtectorId] = React.useState("")
  React.useEffect(() => {
    setPassword("")
    setRecovery("")
    setUseRecovery(false)
    setMethod("xts_aes128")
    setUsedSpaceOnly(true)
    setProtectorType("recovery")
    setProtectorId(form?.kind === "remove" ? form.protectors.find((p) => p.id)?.id || "" : "")
  }, [form])
  if (!form) return null
  const mount = form.mount
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {form.kind === "unlock"
              ? `Unlock ${mount}`
              : form.kind === "protect"
                ? `Protect ${mount}`
                : form.kind === "add"
                  ? `Add protector on ${mount}`
                  : `Remove protector on ${mount}`}
          </DialogTitle>
          <DialogDescription>
            {form.kind === "unlock"
              ? "Password or 48-digit recovery password. The secret is encrypted in transit and stripped from command history."
              : form.kind === "protect"
                ? "Turns BitLocker on with a recovery-password protector. The recovery password is stored in the dashboard vault."
                : form.kind === "add"
                  ? "TPM, password, or recovery-password protector. PIN is not written from this dashboard."
                  : "Removing the last protector can make the volume unrecoverable."}
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          {form.kind === "unlock" ? (
            <>
              <div className="flex gap-2">
                <Button size="sm" variant={!useRecovery ? "secondary" : "outline"} type="button" onClick={() => setUseRecovery(false)}>
                  Password
                </Button>
                <Button size="sm" variant={useRecovery ? "secondary" : "outline"} type="button" onClick={() => setUseRecovery(true)}>
                  Recovery password
                </Button>
              </div>
              <Field>
                <FieldLabel>{useRecovery ? "Recovery password" : "Password"}</FieldLabel>
                <Input
                  type="password"
                  autoComplete="off"
                  value={useRecovery ? recovery : password}
                  onChange={(e) => (useRecovery ? setRecovery(e.target.value) : setPassword(e.target.value))}
                />
              </Field>
            </>
          ) : null}
          {form.kind === "protect" ? (
            <>
              <Field>
                <FieldLabel>Encryption method</FieldLabel>
                <Select items={BITLOCKER_METHODS} value={method} onValueChange={(v) => v && setMethod(String(v))}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {BITLOCKER_METHODS.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={usedSpaceOnly} onCheckedChange={setUsedSpaceOnly} />
                Used space only
              </label>
            </>
          ) : null}
          {form.kind === "add" ? (
            <>
              <Field>
                <FieldLabel>Protector type</FieldLabel>
                <Select
                  items={BITLOCKER_PROTECTORS}
                  value={protectorType}
                  onValueChange={(v) => v && setProtectorType(String(v))}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {BITLOCKER_PROTECTORS.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              {protectorType === "password" ? (
                <Field>
                  <FieldLabel>Password</FieldLabel>
                  <Input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
                </Field>
              ) : null}
            </>
          ) : null}
          {form.kind === "remove" ? (
            <Field>
              <FieldLabel>Protector ID</FieldLabel>
              {form.protectors.some((p) => p.id) ? (
                <Select
                  items={form.protectors.filter((p) => p.id).map((p) => ({ value: p.id as string, label: `${p.type} ${p.id}` }))}
                  value={protectorId}
                  onValueChange={(v) => v && setProtectorId(String(v))}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {form.protectors
                        .filter((p) => p.id)
                        .map((p) => (
                          <SelectItem key={p.id} value={p.id as string}>
                            {p.type} {p.id}
                          </SelectItem>
                        ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              ) : (
                <Input value={protectorId} onChange={(e) => setProtectorId(e.target.value)} placeholder="Key protector GUID" />
              )}
            </Field>
          ) : null}
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={
              pending ||
              (form.kind === "unlock" && !(useRecovery ? recovery : password)) ||
              (form.kind === "add" && protectorType === "password" && !password) ||
              (form.kind === "remove" && !protectorId.trim())
            }
            onClick={() => {
              if (form.kind === "unlock") {
                onSubmit({
                  action: "unlock",
                  mountPoint: mount,
                  ...(useRecovery ? { recoveryPassword: recovery } : { password }),
                })
                return
              }
              if (form.kind === "protect") {
                onSubmit({ action: "protect", mountPoint: mount, encryptionMethod: method, usedSpaceOnly })
                return
              }
              if (form.kind === "add") {
                onSubmit({
                  action: "add_protector",
                  mountPoint: mount,
                  protectorType,
                  ...(protectorType === "password" ? { password } : {}),
                })
                return
              }
              onSubmit({ action: "remove_protector", mountPoint: mount, protectorId: protectorId.trim() })
            }}
          >
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const BITLOCKER_METHODS = [
  { value: "xts_aes128", label: "XTS-AES 128" },
  { value: "xts_aes256", label: "XTS-AES 256" },
  { value: "aes128", label: "AES 128" },
  { value: "aes256", label: "AES 256" },
]

const BITLOCKER_PROTECTORS = [
  { value: "tpm", label: "TPM" },
  { value: "password", label: "Password" },
  { value: "recovery", label: "Recovery password" },
]

function useBitLockerWrite({
  deviceId,
  online,
  onDone,
}: {
  deviceId: string
  online: boolean
  onDone: () => void
}) {
  const [confirm, setConfirm] = React.useState<{ message: string; run: () => Promise<void> } | null>(null)
  const [pending, setPending] = React.useState(false)

  async function queue(payload: Record<string, unknown>, ok: string, timeoutMs: number) {
    setConfirm(null)
    if (!online) return
    setPending(true)
    try {
      const data = await api<{ commands: { id: string }[] }>("/api/v1/admin/commands", {
        method: "POST",
        body: JSON.stringify({ deviceIds: [deviceId], type: "set_bitlocker", payload }),
      })
      const id = queuedCommandId(data)
      if (!id) throw new Error("command not queued")
      const ac = new AbortController()
      const outcome = await pollAdminCommand(id, { signal: ac.signal, timeoutMs })
      if (outcome.kind === "timeout") toast.error(online ? "timeout" : "agent_offline")
      else if (outcome.kind === "error") toast.error(outcome.message)
      else if (outcome.command.status !== "success") {
        toast.error(resultErrorMessage(outcome.command.result, outcome.command.status, "BitLocker command failed"))
      } else {
        toast.success(ok)
        onDone()
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "BitLocker command failed")
    } finally {
      setPending(false)
    }
  }

  return {
    pending,
    confirm,
    cancel: () => setConfirm(null),
    run: () => confirm?.run(),
    act: (action: string, mountPoint: string, extra: Record<string, unknown> = {}) => {
      const timeoutMs = action === "protect" || action === "unprotect" ? 180_000 : 120_000
      const payload = { action, mountPoint, ...extra }
      setConfirm({
        message: bitLockerActionConfirm(action, mountPoint),
        run: () => queue(payload, `BitLocker ${action} queued`, timeoutMs),
      })
    },
  }
}

function CapabilityTable({
  rows,
  online,
  pending,
  onInstall,
}: {
  rows: WindowsCapability[]
  online: boolean
  pending: boolean
  onInstall: () => void
}) {
  const [filter, setFilter] = React.useState("")
  const q = filter.trim().toLowerCase()
  const visible = rows.filter((row) => !q || row.name.toLowerCase().includes(q) || (row.kind ?? "").includes(q))
  const pack = rows.find((row) => isMediaFeaturePack(row.name))
  const installed = pack ? pack.state === "installed" || pack.state === "permanent" : false
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input className="max-w-xs" placeholder="Filter RSAT / optional features" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <Button size="sm" onClick={onInstall} disabled={!online || pending || installed}>
          {pending ? <Spinner className="size-4" /> : null}
          {installed ? "Media Feature Pack installed" : "Install Media Feature Pack"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        DISM list is read-only except Media Feature Pack ({MEDIA_FEATURE_PACK}), which H.264 live desktop needs on Windows N.
      </p>
      {!rows.length ? (
        <p className="text-sm text-muted-foreground">No capabilities in this snapshot.</p>
      ) : (
        <div className="overflow-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Kind</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((row) => (
                <TableRow key={row.name}>
                  <TableCell className="max-w-md truncate font-mono text-xs" title={row.name}>
                    {row.name}
                  </TableCell>
                  <TableCell>{row.state}</TableCell>
                  <TableCell>{row.kind || "optional"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

function useTaskEnabled({
  deviceId,
  online,
  windows,
  onDone,
}: {
  deviceId: string
  online: boolean
  windows: boolean
  onDone: () => void
}) {
  const [target, setTarget] = React.useState<{ path: string; enabled: boolean } | null>(null)
  const [pending, setPending] = React.useState(false)

  async function run() {
    const next = target
    setTarget(null)
    if (!next || !windows || !online) return
    setPending(true)
    try {
      const data = await api<{ commands: { id: string }[] }>("/api/v1/admin/commands", {
        method: "POST",
        body: JSON.stringify({
          deviceIds: [deviceId],
          type: "set_task_enabled",
          payload: { path: next.path, enabled: next.enabled },
        }),
      })
      const id = queuedCommandId(data)
      if (!id) throw new Error("command not queued")
      const ac = new AbortController()
      const outcome = await pollAdminCommand(id, { signal: ac.signal, timeoutMs: 90_000 })
      if (outcome.kind === "timeout") {
        toast.error(online ? "timeout" : "agent_offline")
      } else if (outcome.kind === "error") {
        toast.error(outcome.message)
      } else if (outcome.command.status !== "success") {
        toast.error(resultErrorMessage(outcome.command.result, outcome.command.status, "Task update failed"))
      } else {
        toast.success(next.enabled ? "Task enabled" : "Task disabled")
        onDone()
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Task update failed")
    } finally {
      setPending(false)
    }
  }

  return {
    target,
    pending,
    confirm: (path: string, enabled: boolean) => setTarget({ path, enabled }),
    cancel: () => setTarget(null),
    run,
  }
}

function useCapabilityInstall({
  deviceId,
  online,
  windows,
  onDone,
}: {
  deviceId: string
  online: boolean
  windows: boolean
  onDone: () => void
}) {
  const [open, setOpen] = React.useState(false)
  const [pending, setPending] = React.useState(false)

  async function run() {
    setOpen(false)
    if (!windows || !online) return
    setPending(true)
    try {
      const data = await api<{ commands: { id: string }[] }>("/api/v1/admin/commands", {
        method: "POST",
        body: JSON.stringify({
          deviceIds: [deviceId],
          type: "install_capability",
          payload: { name: MEDIA_FEATURE_PACK },
        }),
      })
      const id = queuedCommandId(data)
      if (!id) throw new Error("command not queued")
      const ac = new AbortController()
      const outcome = await pollAdminCommand(id, { signal: ac.signal, timeoutMs: 10 * 60_000 })
      if (outcome.kind === "timeout") {
        toast.error(online ? "timeout" : "agent_offline")
      } else if (outcome.kind === "error") {
        toast.error(outcome.message)
      } else if (outcome.command.status !== "success") {
        toast.error(resultErrorMessage(outcome.command.result, outcome.command.status, "Capability install failed"))
      } else {
        toast.success("Media Feature Pack install started")
        onDone()
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Capability install failed")
    } finally {
      setPending(false)
    }
  }

  return {
    open,
    pending,
    confirm: () => setOpen(true),
    cancel: () => setOpen(false),
    run,
  }
}

function useNativeList({
  deviceId,
  type,
  payload,
  commands,
  latestSuccessful,
  online,
  windows,
  active,
  timeoutMs,
}: {
  deviceId: string
  type: string
  payload: Record<string, unknown>
  commands?: CommandSeed[]
  latestSuccessful: CommandSeed | null
  online: boolean
  windows: boolean
  active: boolean
  timeoutMs: number
}) {
  const client = useQueryClient()
  const socket = useSocket()
  const [result, setResult] = React.useState<unknown>(null)
  const [listed, setListed] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const pendingId = React.useRef<string | null>(null)
  const pollAbort = React.useRef<AbortController | null>(null)
  const seeded = React.useRef<string | null>(null)
  const autoQueued = React.useRef(false)
  const onlineRef = React.useRef(online)
  onlineRef.current = online
  const requestRef = React.useRef<() => Promise<void>>(async () => {})

  const stopWatch = React.useCallback(() => {
    pollAbort.current?.abort()
    pollAbort.current = null
    pendingId.current = null
    setPending(false)
  }, [])

  React.useEffect(() => {
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
        const outcome = await pollAdminCommand(commandId, { signal: ac.signal, timeoutMs })
        if (ac.signal.aborted || pendingId.current !== commandId) return
        if (outcome.kind === "timeout") {
          setError(onlineRef.current ? "timeout" : "agent_offline")
          pendingId.current = null
          setPending(false)
          return
        }
        if (outcome.kind === "error") {
          if (outcome.message === "aborted") return
          setError(outcome.message)
          pendingId.current = null
          setPending(false)
          return
        }
        const cmd = outcome.command
        const payloadErr = resultPayloadError(cmd.result)
        if (cmd.status === "success" && !payloadErr) {
          setResult(cmd.result)
          setListed(true)
          setError(null)
        } else {
          setError(payloadErr || resultErrorMessage(cmd.result, cmd.status, `${type} failed`))
        }
        pendingId.current = null
        setPending(false)
      })()
    },
    [timeoutMs, type]
  )

  async function requestList() {
    const data = await api<{ commands: { id: string }[] }>("/api/v1/admin/commands", {
      method: "POST",
      body: JSON.stringify({ deviceIds: [deviceId], type, payload }),
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
    const success = latestSuccessful?.status === "success" ? latestSuccessful : commands?.find((c) => c.type === type && c.status === "success")
    if (success) {
      setResult(success.result)
      setListed(true)
    }
    if (online) {
      autoQueued.current = true
      void requestRef.current().catch((e) => toast.error(e instanceof Error ? e.message : "Refresh failed"))
    }
  }, [active, commands, deviceId, latestSuccessful, online, type, windows])

  React.useEffect(() => {
    if (!socket) return
    const onResult = (payload: unknown) => {
      if (!payload || typeof payload !== "object") return
      const rec = payload as { id?: string; deviceId?: string; type?: string; status?: string; result?: unknown }
      if (rec.deviceId !== deviceId || rec.type !== type) return
      if (rec.status === "success" && (rec.id === pendingId.current || !pendingId.current) && !resultPayloadError(rec.result)) {
        setResult(rec.result)
        setListed(true)
        setError(null)
        stopWatch()
        void client.invalidateQueries({ queryKey: ["device", deviceId] })
      } else if ((rec.status === "failed" || rec.status === "cancelled") && rec.id === pendingId.current) {
        setError(resultErrorMessage(rec.result, rec.status, `${type} failed`))
        stopWatch()
      }
    }
    socket.on(WS_EVENTS.COMMAND_RESULT, onResult)
    return () => {
      socket.off(WS_EVENTS.COMMAND_RESULT, onResult)
    }
  }, [client, deviceId, socket, stopWatch, type])

  return {
    result,
    listed,
    pending,
    error,
    refresh: () => requestRef.current().catch((e) => toast.error(e instanceof Error ? e.message : "Refresh failed")),
  }
}

function useQuickAssist({ deviceId, online, windows }: { deviceId: string; online: boolean; windows: boolean }) {
  const [open, setOpen] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function run() {
    setOpen(false)
    if (!windows || !online) return
    setPending(true)
    setError(null)
    try {
      const data = await api<{ commands: { id: string }[] }>("/api/v1/admin/commands", {
        method: "POST",
        body: JSON.stringify({ deviceIds: [deviceId], type: "start_quick_assist", payload: { app: "quickassist" } }),
      })
      const id = queuedCommandId(data)
      if (!id) throw new Error("command not queued")
      const ac = new AbortController()
      const outcome = await pollAdminCommand(id, { signal: ac.signal, timeoutMs: 90_000 })
      if (outcome.kind === "timeout") {
        setError(online ? "timeout" : "agent_offline")
      } else if (outcome.kind === "error") {
        setError(outcome.message)
      } else if (outcome.command.status !== "success") {
        const msg = resultErrorMessage(outcome.command.result, outcome.command.status, "Quick Assist failed")
        setError(msg)
        toast.error(msg)
      } else {
        toast.success("Quick Assist opened on the desktop")
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Quick Assist failed"
      setError(msg)
      toast.error(msg)
    } finally {
      setPending(false)
    }
  }

  return {
    open,
    pending,
    error,
    confirm: () => setOpen(true),
    cancel: () => setOpen(false),
    run,
  }
}
