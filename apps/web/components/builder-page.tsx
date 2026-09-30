"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { PackageIcon } from "lucide-react"
import { toast } from "sonner"

import {
  APP_VERSION,
  STAMP_ARCHES,
  STAMP_PLATFORMS,
  stampConfigYaml,
  stampPackSchema,
  type CompileJobView,
  type StampPackInput,
} from "@workspace/shared"

import { api, formatBytes, formatWhen } from "@/lib/api"
import { QueryErrorBanner, QueryErrorState } from "@/components/query-error"
import { NumberInput } from "@/components/number-input"
import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@workspace/ui/components/card"
import { Checkbox } from "@workspace/ui/components/checkbox"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
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
import { Textarea } from "@workspace/ui/components/textarea"

type PackRow = {
  id: string
  platform: string
  arch: string
  createdAt: string
  notes: string | null
  size: number
  hasHelper?: boolean
  downloadUrl: string
  downloadUrlAbsolute?: string
  expiresAt?: number | string
}

type HelperAvailable = { id: string; platform: string; arch: string; version: string }

type AgentUpdateRow = {
  id: string
  version: string
  platform: string
  arch: string
  checksum: string
  createdAt: string
  notes?: string | null
  path?: string
}

type StampPlatform = (typeof STAMP_PLATFORMS)[number]
type StampArch = (typeof STAMP_ARCHES)[number]

type Preset = "lightweight" | "watched" | "full"

function InstallCommandCard({ initial }: { initial: string }) {
  const command = useQuery({
    queryKey: ["install-command"],
    queryFn: () => api<{ command: string; serverUrl: string; secretIncluded: boolean }>("/api/v1/admin/config/install-command"),
    initialData: initial ? { command: initial, serverUrl: "", secretIncluded: false } : undefined,
  })
  return (
    <Card>
      <CardHeader>
        <CardTitle>Silent install command</CardTitle>
        <CardDescription>Generated from the API public URL. The enrollment secret is not included.</CardDescription>
      </CardHeader>
      <CardContent>
        <pre className="overflow-auto rounded-md border p-3 text-xs">{command.data?.command ?? "Loading…"}</pre>
      </CardContent>
    </Card>
  )
}

const STAMP_TOAST: Record<string, string> = {
  invalid_body: "Stamp request was rejected. Check the server URL, intervals, and sandbox roots.",
  not_found: "That pack is gone. Refresh the list.",
  missing_params: "Download link is missing its signature.",
  invalid_signature: "Download link expired or was altered. Stamp the pack again.",
}

const COMPILE_TOAST: Record<string, string> = {
  go_not_found: "Go not found. Install Go or set GO_BIN.",
  source_not_found: "Agent sources not found. Set AGENT_SOURCE_DIR to apps/agent.",
  compile_busy: "A compile is already running.",
  compile_disabled: "Compile is disabled. Set ENABLE_AGENT_COMPILE=1.",
  invalid_body: "Invalid compile request.",
}

const SELECT_CLASS =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"

function isHelperUpdate(row: AgentUpdateRow): boolean {
  return `${row.path ?? ""} ${row.notes ?? ""} ${row.version ?? ""}`.toLowerCase().includes("helper")
}

function matchingAgentBinary(updates: AgentUpdateRow[], platform: string, arch: string): AgentUpdateRow | undefined {
  return updates.find((u) => u.platform === platform && u.arch === arch && !isHelperUpdate(u))
}

function triggerDownload(href: string, filename: string) {
  const a = document.createElement("a")
  a.href = href
  a.download = filename
  a.rel = "noopener"
  document.body.appendChild(a)
  a.click()
  a.remove()
}

function packExpiry(row: PackRow): Date | null {
  if (typeof row.expiresAt === "number") {
    const ms = row.expiresAt < 1e12 ? row.expiresAt * 1000 : row.expiresAt
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? null : d
  }
  if (typeof row.expiresAt === "string" && row.expiresAt) {
    const asNum = Number(row.expiresAt)
    if (Number.isFinite(asNum) && asNum > 0) {
      const ms = asNum < 1e12 ? asNum * 1000 : asNum
      const d = new Date(ms)
      return Number.isNaN(d.getTime()) ? null : d
    }
    const d = new Date(row.expiresAt)
    return Number.isNaN(d.getTime()) ? null : d
  }
  try {
    const u = new URL(row.downloadUrl, "http://local.invalid")
    const exp = u.searchParams.get("exp")
    if (!exp) return null
    const d = new Date(Number(exp) * 1000)
    return Number.isNaN(d.getTime()) ? null : d
  } catch {
    return null
  }
}

function applyPreset(kind: Preset): Partial<StampPackInput> {
  if (kind === "lightweight") {
    return {
      heartbeatIntervalSec: 90,
      idleHeartbeatSec: 90,
      watchedHeartbeatSec: 15,
      pollIntervalSec: 15,
      screenshotIntervalSec: 0,
      enableGpu: false,
      enableTemps: false,
      enablePlugins: false,
      enableScreenshot: false,
      enableWebrtc: false,
    }
  }
  if (kind === "watched") {
    return {
      heartbeatIntervalSec: 15,
      idleHeartbeatSec: 90,
      watchedHeartbeatSec: 15,
      pollIntervalSec: 15,
      screenshotIntervalSec: 0,
      enableGpu: false,
      enableTemps: false,
      enablePlugins: false,
      enableScreenshot: true,
      enableWebrtc: false,
    }
  }
  return {
    heartbeatIntervalSec: 15,
    idleHeartbeatSec: 90,
    watchedHeartbeatSec: 15,
    pollIntervalSec: 15,
    screenshotIntervalSec: 0,
    enableGpu: true,
    enableTemps: true,
    enablePlugins: true,
    enableScreenshot: true,
    enableWebrtc: true,
  }
}

export function BuilderPage({ installCommand = "" }: { installCommand?: string }) {
  const client = useQueryClient()
  const meta = useQuery({
    queryKey: ["admin-meta"],
    queryFn: () => api<{ publicUrl: string }>("/api/v1/admin/meta"),
    staleTime: 5 * 60_000,
  })
  const packs = useQuery({
    queryKey: ["builder-packs"],
    queryFn: () =>
      api<{
        packs: PackRow[]
        compileEnabled: boolean
        helperAvailable: HelperAvailable[]
      }>("/api/v1/admin/builder/packs"),
    staleTime: 15_000,
  })
  const updates = useQuery({
    queryKey: ["updates"],
    queryFn: () => api<{ updates: AgentUpdateRow[] }>("/api/v1/admin/updates"),
    staleTime: 60_000,
  })
  const [platform, setPlatform] = React.useState<StampPlatform>("windows")
  const [arch, setArch] = React.useState<StampArch>("amd64")
  const [serverUrl, setServerUrl] = React.useState("")
  const [fallbackUrls, setFallbackUrls] = React.useState("")
  const [enrollmentSecret, setEnrollmentSecret] = React.useState("")
  const [heartbeat, setHeartbeat] = React.useState(90)
  const [idleHeartbeat, setIdleHeartbeat] = React.useState(90)
  const [watchedHeartbeat, setWatchedHeartbeat] = React.useState(15)
  const [poll, setPoll] = React.useState(15)
  const [screenshot, setScreenshot] = React.useState(0)
  const [autoRestart, setAutoRestart] = React.useState("")
  const [sandboxRoots, setSandboxRoots] = React.useState("")
  const [enableGpu, setEnableGpu] = React.useState(false)
  const [enableTemps, setEnableTemps] = React.useState(false)
  const [enablePlugins, setEnablePlugins] = React.useState(true)
  const [enableScreenshot, setEnableScreenshot] = React.useState(true)
  const [enableWebrtc, setEnableWebrtc] = React.useState(false)
  const [includeHelper, setIncludeHelper] = React.useState(false)
  const [notes, setNotes] = React.useState("")
  const [preset, setPreset] = React.useState<Preset>("lightweight")
  const [compileVersion, setCompileVersion] = React.useState(APP_VERSION)
  const [lite, setLite] = React.useState(false)
  const [compileId, setCompileId] = React.useState<string | null>(null)
  const compileEnabled = packs.data?.compileEnabled === true

  React.useEffect(() => {
    if (meta.data?.publicUrl && !serverUrl) setServerUrl(meta.data.publicUrl)
  }, [meta.data, serverUrl])

  const updateRows = updates.data?.updates ?? []
  const agentBin = matchingAgentBinary(updateRows, platform, arch)
  const helpers = packs.data?.helperAvailable ?? []
  const matchingHelper = helpers.find((h) => h.platform === platform && h.arch === arch)
  const helperExists = Boolean(matchingHelper)

  React.useEffect(() => {
    if (!helperExists) setIncludeHelper(false)
  }, [helperExists])

  const packInput: StampPackInput = {
    platform,
    arch,
    serverUrl,
    fallbackUrls: fallbackUrls
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
    enrollmentSecret,
    heartbeatIntervalSec: heartbeat,
    pollIntervalSec: poll,
    screenshotIntervalSec: screenshot,
    enableGpu,
    enableTemps,
    enablePlugins,
    enableScreenshot,
    enableWebrtc,
    notes: notes.trim() || undefined,
    sandboxRoots: sandboxRoots
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
    autoRestartTime: autoRestart.trim(),
    idleHeartbeatSec: idleHeartbeat,
    watchedHeartbeatSec: watchedHeartbeat,
    includeHelper: helperExists && includeHelper,
  }

  const yaml = stampConfigYaml(packInput)

  function choosePreset(kind: Preset) {
    setPreset(kind)
    const next = applyPreset(kind)
    if (next.heartbeatIntervalSec != null) setHeartbeat(next.heartbeatIntervalSec)
    if (next.idleHeartbeatSec != null) setIdleHeartbeat(next.idleHeartbeatSec)
    if (next.watchedHeartbeatSec != null) setWatchedHeartbeat(next.watchedHeartbeatSec)
    if (next.pollIntervalSec != null) setPoll(next.pollIntervalSec)
    if (next.screenshotIntervalSec != null) setScreenshot(next.screenshotIntervalSec)
    if (next.enableGpu != null) setEnableGpu(next.enableGpu)
    if (next.enableTemps != null) setEnableTemps(next.enableTemps)
    if (next.enablePlugins != null) setEnablePlugins(next.enablePlugins)
    if (next.enableScreenshot != null) setEnableScreenshot(next.enableScreenshot)
    if (next.enableWebrtc != null) setEnableWebrtc(next.enableWebrtc)
  }

  const create = useMutation({
    mutationFn: () => {
      const parsed = stampPackSchema.safeParse(packInput)
      if (!parsed.success) {
        const msg = parsed.error.issues.map((i) => i.message).join("; ") || "invalid stamp pack"
        throw new Error(msg)
      }
      return api<{ downloadUrl: string; downloadUrlAbsolute?: string; build: { hasBinary: boolean; id?: string } }>(
        "/api/v1/admin/builder/packs",
        {
          method: "POST",
          body: JSON.stringify(parsed.data),
        }
      )
    },
    onSuccess: (data) => {
      toast.success(data.build.hasBinary ? "Stamp pack ready (includes binary)" : "Stamp pack ready (config + installer)")
      void client.invalidateQueries({ queryKey: ["builder-packs"] })
      const href = data.downloadUrlAbsolute || data.downloadUrl
      triggerDownload(href, `pc-manager-${platform}-${arch}.zip`)
    },
    onError: (e) => toast.error(STAMP_TOAST[e.message] ?? e.message),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/admin/builder/packs/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Pack deleted")
      void client.invalidateQueries({ queryKey: ["builder-packs"] })
    },
    onError: (e) => toast.error(e.message),
  })

  const compileJob = useQuery({
    queryKey: ["builder-compile", compileId],
    queryFn: () => api<CompileJobView>(`/api/v1/admin/builder/compile/${compileId}`),
    enabled: Boolean(compileId),
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return status === "running" || status === "queued" ? 1000 : false
    },
  })

  const seenCompile = React.useRef<string | null>(null)
  React.useEffect(() => {
    const job = compileJob.data
    if (!job || (job.status !== "success" && job.status !== "failed")) return
    const key = `${job.id}:${job.status}`
    if (seenCompile.current === key) return
    seenCompile.current = key
    if (job.status === "success") {
      toast.success(`Compiled ${platform}/${arch}`)
      void client.invalidateQueries({ queryKey: ["updates"] })
      void client.invalidateQueries({ queryKey: ["builder-packs"] })
    } else {
      toast.error(job.error || "Compile failed")
    }
  }, [arch, client, compileJob.data, platform])

  const compile = useMutation({
    mutationFn: () =>
      api<CompileJobView>("/api/v1/admin/builder/compile", {
        method: "POST",
        body: JSON.stringify({
          platform,
          arch,
          version: compileVersion.trim() || APP_VERSION,
          lite,
        }),
      }),
    onSuccess: (job) => {
      setCompileId(job.id)
      client.setQueryData(["builder-compile", job.id], job)
    },
    onError: (e) => {
      const mapped = COMPILE_TOAST[e.message] ?? e.message
      if (e.message === "compile_busy") {
        void api<CompileJobView>("/api/v1/admin/builder/compile")
          .then((latest) => setCompileId(latest.id))
          .catch(() => undefined)
      }
      toast.error(mapped)
    },
  })

  const compileRunning =
    compile.isPending || compileJob.data?.status === "running" || compileJob.data?.status === "queued"

  const rows = packs.data?.packs ?? []

  return (
    <div className="flex flex-col gap-6">
      <Alert>
        <AlertTitle>Stamp pack</AlertTitle>
        <AlertDescription>
          {compileEnabled
            ? "Writes config.yaml, copies the latest matching agent binary from Settings (or a compile you just ran), and zips an installer. Pack download links expire after 10 minutes. Stamp pack does not compile — use Compile for the selected platform/arch first if you need a new binary."
            : "Writes config.yaml, copies the latest matching agent binary from Settings if one exists, and zips an installer. Pack download links expire after 10 minutes."}
        </AlertDescription>
      </Alert>
      <InstallCommandCard initial={installCommand} />
      {packs.isSuccess && !compileEnabled ? (
        <Alert>
          <AlertTitle>Compile is off</AlertTitle>
          <AlertDescription>
            There is no in-host compile on this API. Upload a prebuilt agent under Settings → Agent binaries, or set
            ENABLE_AGENT_COMPILE=1 (and install Go) on the API host.
          </AlertDescription>
        </Alert>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>New pack</CardTitle>
          <CardDescription>Enrollment secret is stored only in the generated zip, not in git.</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel>Preset</FieldLabel>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant={preset === "lightweight" ? "default" : "outline"} onClick={() => choosePreset("lightweight")}>
                  Lightweight
                </Button>
                <Button size="sm" variant={preset === "watched" ? "default" : "outline"} onClick={() => choosePreset("watched")}>
                  Watched
                </Button>
                <Button size="sm" variant={preset === "full" ? "default" : "outline"} onClick={() => choosePreset("full")}>
                  Full remote
                </Button>
              </div>
              <FieldDescription>Lightweight idle, watched/screen, or full remote (WebRTC + screenshot + plugins).</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="b-platform">Platform</FieldLabel>
              <select
                id="b-platform"
                className={SELECT_CLASS}
                value={platform}
                onChange={(e) => {
                  const v = e.target.value
                  if ((STAMP_PLATFORMS as readonly string[]).includes(v)) setPlatform(v as StampPlatform)
                }}
              >
                {STAMP_PLATFORMS.map((value) => (
                  <option key={value} value={value}>
                    {value === "darwin" ? "macOS" : value === "windows" ? "Windows" : "Linux"}
                  </option>
                ))}
              </select>
            </Field>
            <Field>
              <FieldLabel htmlFor="b-arch">Arch</FieldLabel>
              <select
                id="b-arch"
                className={SELECT_CLASS}
                value={arch}
                onChange={(e) => {
                  const v = e.target.value
                  if ((STAMP_ARCHES as readonly string[]).includes(v)) setArch(v as StampArch)
                }}
              >
                {STAMP_ARCHES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </Field>
            {compileEnabled ? (
              <>
                <Field>
                  <FieldLabel htmlFor="b-cver">Compile version</FieldLabel>
                  <Input id="b-cver" value={compileVersion} onChange={(e) => setCompileVersion(e.target.value)} />
                  <FieldDescription>Embedded as main.Version ldflags; also the updates catalog version.</FieldDescription>
                </Field>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={lite} onCheckedChange={(v) => setLite(Boolean(v))} />
                  Lite build (omit WebRTC)
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <Button onClick={() => compile.mutate()} disabled={compileRunning}>
                    {compileRunning ? <Spinner data-icon="inline-start" /> : null}
                    Compile {platform}/{arch}
                  </Button>
                  {compileJob.data ? (
                    <Badge variant={compileJob.data.status === "success" ? "secondary" : compileJob.data.status === "failed" ? "outline" : "secondary"}>
                      {compileJob.data.status}
                    </Badge>
                  ) : null}
                </div>
                {compileJob.data ? (
                  <Field>
                    <FieldLabel>Compile log</FieldLabel>
                    <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap">
                      {compileJob.data.log || "(waiting for output)"}
                    </pre>
                    {compileJob.data.error ? (
                      <p className="text-sm text-destructive">{compileJob.data.error}</p>
                    ) : null}
                  </Field>
                ) : null}
              </>
            ) : null}
            {!agentBin ? (
              <Alert>
                <AlertTitle>No matching agent binary</AlertTitle>
                <AlertDescription>
                  Settings has no {platform}/{arch} agent in the catalog. This pack will be config + installer only until
                  you {compileEnabled ? "compile or upload" : "upload"} one.
                </AlertDescription>
              </Alert>
            ) : (
              <p className="text-sm text-muted-foreground">
                Matching binary: {agentBin.version} ({agentBin.platform}/{agentBin.arch})
              </p>
            )}
            <Field>
              <FieldLabel htmlFor="b-url">Server URL</FieldLabel>
              <Input id="b-url" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="b-fall">Fallback URLs (one per line)</FieldLabel>
              <Textarea id="b-fall" rows={3} value={fallbackUrls} onChange={(e) => setFallbackUrls(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="b-secret">Enrollment secret</FieldLabel>
              <Input
                id="b-secret"
                type="password"
                value={enrollmentSecret}
                onChange={(e) => setEnrollmentSecret(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="b-roots">Sandbox roots (one per line)</FieldLabel>
              <Textarea id="b-roots" rows={3} value={sandboxRoots} onChange={(e) => setSandboxRoots(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="b-hb">Heartbeat interval (sec)</FieldLabel>
              <NumberInput id="b-hb" min={5} max={3600} value={heartbeat} onValueChange={setHeartbeat} />
            </Field>
            <Field>
              <FieldLabel htmlFor="b-idle">Idle heartbeat (sec)</FieldLabel>
              <NumberInput id="b-idle" min={5} max={3600} value={idleHeartbeat} onValueChange={setIdleHeartbeat} />
            </Field>
            <Field>
              <FieldLabel htmlFor="b-watched">Watched heartbeat (sec)</FieldLabel>
              <NumberInput id="b-watched" min={5} max={3600} value={watchedHeartbeat} onValueChange={setWatchedHeartbeat} />
            </Field>
            <Field>
              <FieldLabel htmlFor="b-poll">Poll interval (sec)</FieldLabel>
              <NumberInput id="b-poll" min={1} max={3600} value={poll} onValueChange={setPoll} />
            </Field>
            <Field>
              <FieldLabel htmlFor="b-shot">Screenshot interval (sec, 0 = off)</FieldLabel>
              <NumberInput id="b-shot" min={0} max={3600} value={screenshot} onValueChange={setScreenshot} />
            </Field>
            <Field>
              <FieldLabel htmlFor="b-restart">Auto-restart (HH:MM, empty = off)</FieldLabel>
              <Input
                id="b-restart"
                value={autoRestart}
                onChange={(e) => setAutoRestart(e.target.value)}
                placeholder="03:30"
              />
            </Field>
            <Field orientation="horizontal">
              <FieldLabel>Enable GPU collector</FieldLabel>
              <Switch checked={enableGpu} onCheckedChange={setEnableGpu} />
            </Field>
            <Field orientation="horizontal">
              <FieldLabel>Enable temps</FieldLabel>
              <Switch checked={enableTemps} onCheckedChange={setEnableTemps} />
            </Field>
            <Field orientation="horizontal">
              <FieldLabel>Enable plugins</FieldLabel>
              <Switch checked={enablePlugins} onCheckedChange={setEnablePlugins} />
            </Field>
            <Field orientation="horizontal">
              <FieldLabel>Enable screenshot</FieldLabel>
              <Switch checked={enableScreenshot} onCheckedChange={setEnableScreenshot} />
            </Field>
            <Field orientation="horizontal">
              <FieldLabel>Enable WebRTC</FieldLabel>
              <Switch checked={enableWebrtc} onCheckedChange={setEnableWebrtc} />
            </Field>
            {helperExists ? (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={includeHelper} onCheckedChange={(v) => setIncludeHelper(Boolean(v))} />
                Include helper binary ({matchingHelper?.version})
              </label>
            ) : null}
            <Field>
              <FieldLabel htmlFor="b-notes">Notes</FieldLabel>
              <Textarea id="b-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel>config.yaml preview</FieldLabel>
              <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs">{yaml}</pre>
            </Field>
          </FieldGroup>
        </CardContent>
        <CardFooter className="flex gap-2">
          <Button onClick={() => create.mutate()} disabled={create.isPending || !serverUrl || !enrollmentSecret}>
            {create.isPending ? <Spinner data-icon="inline-start" /> : null}
            Build stamp pack
          </Button>
          {!agentBin ? (
            <Badge variant="outline">binary not included</Badge>
          ) : (
            <Badge variant="secondary">will include agent binary</Badge>
          )}
        </CardFooter>
      </Card>
      {packs.isError && packs.data ? (
        <QueryErrorBanner cached error={packs.error} onRetry={() => void packs.refetch()} />
      ) : null}
      {packs.isError && !packs.data ? (
        <QueryErrorState title="Packs unavailable" error={packs.error} onRetry={() => void packs.refetch()} />
      ) : !rows.length ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PackageIcon />
            </EmptyMedia>
            <EmptyTitle>No packs yet</EmptyTitle>
            <EmptyDescription>
              {compileEnabled
                ? "Compile an agent for a platform, or upload a binary under Settings, then stamp a pack."
                : "Upload an agent binary under Settings, then stamp a pack for each platform."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Generated packs</CardTitle>
            <CardDescription>Signed download links expire after 10 minutes; refresh the list for a new URL.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Target</TableHead>
                  <TableHead>Notes</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const exp = packExpiry(row)
                  const href = row.downloadUrlAbsolute || row.downloadUrl
                  return (
                    <TableRow key={row.id}>
                      <TableCell>
                        {row.platform}/{row.arch}
                        {row.hasHelper ? (
                          <Badge variant="outline" className="ml-2">
                            helper
                          </Badge>
                        ) : null}
                      </TableCell>
                      <TableCell className="max-w-xs truncate text-sm text-muted-foreground">{row.notes}</TableCell>
                      <TableCell>{formatBytes(row.size)}</TableCell>
                      <TableCell>{formatWhen(row.createdAt)}</TableCell>
                      <TableCell>{exp ? formatWhen(exp.toISOString()) : "—"}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            render={<a href={href} download={`pc-manager-${row.platform}-${row.arch}.zip`} />}
                            nativeButton={false}
                          >
                            Download
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              const abs =
                                row.downloadUrlAbsolute ||
                                (typeof window !== "undefined" ? new URL(row.downloadUrl, window.location.origin).href : row.downloadUrl)
                              void navigator.clipboard.writeText(abs).then(
                                () => toast.success("URL copied"),
                                () => toast.error("Copy failed")
                              )
                            }}
                          >
                            Copy URL
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => remove.mutate(row.id)}>
                            Delete
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
