"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { DEFAULT_SETTINGS, meshExtraCommandChoices, type AppSettings } from "@workspace/shared"

import { api, applyOperatorAuth, formatWhen, storeSessionToken } from "@/lib/api"
import { NumberInput } from "@/components/number-input"
import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@workspace/ui/components/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { Checkbox } from "@workspace/ui/components/checkbox"
import { Switch } from "@workspace/ui/components/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@workspace/ui/components/tabs"
import { Textarea } from "@workspace/ui/components/textarea"
import { Spinner } from "@workspace/ui/components/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"

export function SettingsPage() {
  const client = useQueryClient()
  const meta = useQuery({
    queryKey: ["meta"],
    queryFn: () => api<{ turnConfigured: boolean }>("/api/v1/admin/meta"),
    staleTime: 5 * 60_000,
  })
  const security = useQuery({
    queryKey: ["security"],
    queryFn: () => api<{ rateLimitPerMinute: number; ipAllowlist: string[] }>("/api/v1/admin/security"),
    staleTime: 5 * 60_000,
  })
  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: () => api<{ settings: AppSettings }>("/api/v1/admin/settings"),
    staleTime: 5 * 60_000,
  })
  const updates = useQuery({
    queryKey: ["updates"],
    queryFn: () =>
      api<{ updates: Array<{ id: string; version: string; platform: string; arch: string; checksum: string; createdAt: string }> }>(
        "/api/v1/admin/updates"
      ),
    staleTime: 5 * 60_000,
  })
  const [form, setForm] = React.useState<AppSettings | null>(null)
  const [emailsText, setEmailsText] = React.useState("")
  const [rootsText, setRootsText] = React.useState("")
  const dirty = React.useRef(false)
  const hydrated = React.useRef(false)
  React.useEffect(() => {
    if (!settingsQuery.data) return
    if (dirty.current && hydrated.current) return
    const next = {
      ...DEFAULT_SETTINGS,
      ...settingsQuery.data.settings,
      agent: { ...DEFAULT_SETTINGS.agent, ...settingsQuery.data.settings.agent },
      telegram: { ...DEFAULT_SETTINGS.telegram, ...settingsQuery.data.settings.telegram },
      discord: { ...DEFAULT_SETTINGS.discord, ...settingsQuery.data.settings.discord },
      smtp: { ...DEFAULT_SETTINGS.smtp, ...settingsQuery.data.settings.smtp },
      thresholds: { ...DEFAULT_SETTINGS.thresholds, ...settingsQuery.data.settings.thresholds },
      retention: { ...DEFAULT_SETTINGS.retention, ...settingsQuery.data.settings.retention },
      llm: { ...DEFAULT_SETTINGS.llm, ...settingsQuery.data.settings.llm },
      mesh: { ...DEFAULT_SETTINGS.mesh, ...settingsQuery.data.settings.mesh },
    }
    setForm(next)
    setEmailsText(next.smtp.adminEmails.join(", "))
    setRootsText(next.agent.sandboxRoots.join("\n"))
    hydrated.current = true
  }, [settingsQuery.data])
  const updateForm = (next: AppSettings) => {
    dirty.current = true
    setForm(next)
  }

  const save = useMutation({
    mutationFn: () =>
      api("/api/v1/admin/settings", { method: "PUT", body: JSON.stringify(form) }),
    onSuccess: () => {
      dirty.current = false
      toast.success("Settings saved")
      void client.invalidateQueries({ queryKey: ["settings"] })
    },
    onError: (e) => toast.error(e.message),
  })
  const backup = useMutation({
    mutationFn: () => api("/api/v1/admin/backup", { method: "POST" }),
    onSuccess: () => toast.success("SQLite backup created"),
    onError: (e) => toast.error(e.message),
  })

  if (!form) {
    if (settingsQuery.isError) {
      return (
        <Alert>
          <AlertTitle>Couldn’t load settings</AlertTitle>
          <AlertDescription>{settingsQuery.error.message}. Check the API and retry.</AlertDescription>
        </Alert>
      )
    }
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner data-icon="inline-start" />
        Loading settings…
      </div>
    )
  }

  return (
    <Tabs defaultValue="alerts">
      <TabsList>
        <TabsTrigger value="alerts">Alerts</TabsTrigger>
        <TabsTrigger value="copilot">Copilot</TabsTrigger>
        <TabsTrigger value="retention">Retention</TabsTrigger>
        <TabsTrigger value="updates">Agent binaries</TabsTrigger>
        <TabsTrigger value="agent">Agent defaults</TabsTrigger>
        <TabsTrigger value="security">Security</TabsTrigger>
      </TabsList>
      <TabsContent value="alerts">
        <Card>
          <CardHeader>
            <CardTitle>Notification channels</CardTitle>
            <CardDescription>Tokens stay in SQLite settings, not in git.</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field orientation="horizontal">
                <FieldLabel>Telegram</FieldLabel>
                <Switch
                  checked={form.telegram.enabled}
                  onCheckedChange={(checked) =>
                    updateForm({ ...form, telegram: { ...form.telegram, enabled: checked } })
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="tg-token">Bot token</FieldLabel>
                <Input
                  id="tg-token"
                  value={form.telegram.botToken}
                  onChange={(e) => updateForm({ ...form, telegram: { ...form.telegram, botToken: e.target.value } })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="tg-chat">Chat ID</FieldLabel>
                <Input
                  id="tg-chat"
                  value={form.telegram.chatId}
                  onChange={(e) => updateForm({ ...form, telegram: { ...form.telegram, chatId: e.target.value } })}
                />
              </Field>
              <Field orientation="horizontal">
                <FieldLabel>Notify online</FieldLabel>
                <Switch
                  checked={form.telegram.notifyOnline}
                  onCheckedChange={(checked) =>
                    updateForm({ ...form, telegram: { ...form.telegram, notifyOnline: checked } })
                  }
                />
              </Field>
              <Field orientation="horizontal">
                <FieldLabel>Notify offline</FieldLabel>
                <Switch
                  checked={form.telegram.notifyOffline}
                  onCheckedChange={(checked) =>
                    updateForm({ ...form, telegram: { ...form.telegram, notifyOffline: checked } })
                  }
                />
              </Field>
              <Field orientation="horizontal">
                <FieldLabel>Notify command failure</FieldLabel>
                <Switch
                  checked={form.telegram.notifyCommandFailure}
                  onCheckedChange={(checked) =>
                    updateForm({ ...form, telegram: { ...form.telegram, notifyCommandFailure: checked } })
                  }
                />
              </Field>
              <Field orientation="horizontal">
                <FieldLabel>Notify kill switch</FieldLabel>
                <Switch
                  checked={form.telegram.notifyKillSwitch}
                  onCheckedChange={(checked) =>
                    updateForm({ ...form, telegram: { ...form.telegram, notifyKillSwitch: checked } })
                  }
                />
              </Field>
              <Field orientation="horizontal">
                <FieldLabel>Notify heartbeat missed</FieldLabel>
                <Switch
                  checked={form.telegram.notifyHeartbeatMissed}
                  onCheckedChange={(checked) =>
                    updateForm({ ...form, telegram: { ...form.telegram, notifyHeartbeatMissed: checked } })
                  }
                />
              </Field>
              <Field orientation="horizontal">
                <FieldLabel>Discord</FieldLabel>
                <Switch
                  checked={form.discord.enabled}
                  onCheckedChange={(checked) =>
                    updateForm({ ...form, discord: { ...form.discord, enabled: checked } })
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="discord">Webhook URL</FieldLabel>
                <Input
                  id="discord"
                  value={form.discord.webhookUrl}
                  onChange={(e) => updateForm({ ...form, discord: { ...form.discord, webhookUrl: e.target.value } })}
                />
              </Field>
              <Field orientation="horizontal">
                <FieldLabel>SMTP</FieldLabel>
                <Switch
                  checked={form.smtp.enabled}
                  onCheckedChange={(checked) => updateForm({ ...form, smtp: { ...form.smtp, enabled: checked } })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="smtp-host">SMTP host</FieldLabel>
                <Input
                  id="smtp-host"
                  value={form.smtp.host}
                  onChange={(e) => updateForm({ ...form, smtp: { ...form.smtp, host: e.target.value } })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="smtp-user">SMTP username</FieldLabel>
                <Input
                  id="smtp-user"
                  value={form.smtp.username}
                  onChange={(e) => updateForm({ ...form, smtp: { ...form.smtp, username: e.target.value } })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="smtp-pass">SMTP password</FieldLabel>
                <Input
                  id="smtp-pass"
                  type="password"
                  value={form.smtp.password}
                  onChange={(e) => updateForm({ ...form, smtp: { ...form.smtp, password: e.target.value } })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="smtp-from">From email</FieldLabel>
                <Input
                  id="smtp-from"
                  value={form.smtp.fromEmail}
                  onChange={(e) => updateForm({ ...form, smtp: { ...form.smtp, fromEmail: e.target.value } })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="smtp-to">Admin emails (comma separated)</FieldLabel>
                <Input
                  id="smtp-to"
                  value={emailsText}
                  onChange={(e) => {
                    const raw = e.target.value
                    setEmailsText(raw)
                    updateForm({
                      ...form,
                      smtp: {
                        ...form.smtp,
                        adminEmails: raw.split(",").map((s) => s.trim()).filter(Boolean),
                      },
                    })
                  }}
                />
              </Field>
              <p className="text-sm text-muted-foreground">
                CPU, RAM, and disk alert toggles and thresholds are hidden. Heartbeats are presence-only
                (lastSeen); those keys stay in saved JSON for compatibility.
              </p>
              <Field>
                <FieldLabel htmlFor="offline-sec">Offline threshold (sec)</FieldLabel>
                <NumberInput
                  id="offline-sec"
                  value={form.thresholds.offlineThresholdSec}
                  min={1}
                  onValueChange={(offlineThresholdSec) =>
                    updateForm({ ...form, thresholds: { ...form.thresholds, offlineThresholdSec } })
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="heartbeat-sec">Heartbeat timeout (sec)</FieldLabel>
                <NumberInput
                  id="heartbeat-sec"
                  value={form.thresholds.heartbeatTimeoutSec}
                  min={1}
                  onValueChange={(heartbeatTimeoutSec) =>
                    updateForm({ ...form, thresholds: { ...form.thresholds, heartbeatTimeoutSec } })
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="cooldown-sec">Alert cooldown (sec)</FieldLabel>
                <NumberInput
                  id="cooldown-sec"
                  value={form.thresholds.alertCooldownSec}
                  min={0}
                  onValueChange={(alertCooldownSec) =>
                    updateForm({ ...form, thresholds: { ...form.thresholds, alertCooldownSec } })
                  }
                />
              </Field>
            </FieldGroup>
          </CardContent>
          <CardFooter>
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? <Spinner data-icon="inline-start" /> : null}
              Save
            </Button>
          </CardFooter>
        </Card>
      </TabsContent>
      <TabsContent value="copilot">
        <Card>
          <CardHeader>
            <CardTitle>LLM copilot</CardTitle>
            <CardDescription>
              OpenAI-compatible Chat Completions (OpenAI, Azure, or a local server such as Ollama). Used only by
              the device Chat section to queue existing commands.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="llm-url">Base URL</FieldLabel>
                <Input
                  id="llm-url"
                  value={form.llm.baseUrl}
                  onChange={(e) => updateForm({ ...form, llm: { ...form.llm, baseUrl: e.target.value } })}
                  placeholder="https://api.openai.com/v1"
                />
                <FieldDescription>
                  Root ending in /v1, or a full …/chat/completions URL (Azure). Empty disables copilot.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="llm-key">API key</FieldLabel>
                <Input
                  id="llm-key"
                  type="password"
                  autoComplete="off"
                  value={form.llm.apiKey}
                  onChange={(e) => updateForm({ ...form, llm: { ...form.llm, apiKey: e.target.value } })}
                />
                <FieldDescription>Optional for local servers that do not require a key.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="llm-model">Model</FieldLabel>
                <Input
                  id="llm-model"
                  value={form.llm.model}
                  onChange={(e) => updateForm({ ...form, llm: { ...form.llm, model: e.target.value } })}
                  placeholder="gpt-4o-mini"
                />
              </Field>
            </FieldGroup>
          </CardContent>
          <CardFooter>
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? <Spinner data-icon="inline-start" /> : null}
              Save
            </Button>
          </CardFooter>
        </Card>
      </TabsContent>
      <TabsContent value="retention">
        <Card>
          <CardHeader>
            <CardTitle>Retention and backup</CardTitle>
            <CardDescription>Nightly cron prunes stats and copies SQLite to /data/backups.</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field orientation="horizontal">
                <FieldLabel htmlFor="statsDays">Stats days</FieldLabel>
                <NumberInput
                  id="statsDays"
                  value={form.retention.statsDays}
                  min={1}
                  onValueChange={(statsDays) => updateForm({ ...form, retention: { ...form.retention, statsDays } })}
                />
              </Field>
              <Field orientation="horizontal">
                <FieldLabel htmlFor="logsDays">Log days</FieldLabel>
                <NumberInput
                  id="logsDays"
                  value={form.retention.logsDays}
                  min={1}
                  onValueChange={(logsDays) => updateForm({ ...form, retention: { ...form.retention, logsDays } })}
                />
              </Field>
              <Field orientation="horizontal">
                <FieldLabel htmlFor="cmdDays">Command history days</FieldLabel>
                <NumberInput
                  id="cmdDays"
                  value={form.retention.commandsDays}
                  min={1}
                  onValueChange={(commandsDays) =>
                    updateForm({ ...form, retention: { ...form.retention, commandsDays } })
                  }
                />
              </Field>
            </FieldGroup>
          </CardContent>
          <CardFooter className="flex gap-2">
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              Save
            </Button>
            <Button variant="outline" onClick={() => backup.mutate()} disabled={backup.isPending}>
              Backup now
            </Button>
          </CardFooter>
        </Card>
      </TabsContent>
      <TabsContent value="updates">
        <UpdateCatalog rows={updates.data?.updates ?? []} />
      </TabsContent>
      <TabsContent value="agent">
        <Card>
          <CardHeader>
            <CardTitle>Agent config defaults</CardTitle>
            <CardDescription>
              Returned on every heartbeat as agentConfig. Agents write matching fields to config.yaml.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field orientation="horizontal">
                <FieldLabel>Lightweight idle snapshots</FieldLabel>
                <Switch
                  checked={form.agent.lightweight}
                  onCheckedChange={(lightweight) =>
                    updateForm({ ...form, agent: { ...form.agent, lightweight } })
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="idle-hb">Idle heartbeat (sec)</FieldLabel>
                <NumberInput
                  id="idle-hb"
                  value={form.agent.idleHeartbeatSec}
                  min={5}
                  onValueChange={(idleHeartbeatSec) =>
                    updateForm({ ...form, agent: { ...form.agent, idleHeartbeatSec, heartbeatIntervalSec: idleHeartbeatSec } })
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="watched-hb">Watched heartbeat (sec)</FieldLabel>
                <NumberInput
                  id="watched-hb"
                  value={form.agent.watchedHeartbeatSec}
                  min={5}
                  onValueChange={(watchedHeartbeatSec) =>
                    updateForm({ ...form, agent: { ...form.agent, watchedHeartbeatSec } })
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="hb">Heartbeat interval (sec, legacy)</FieldLabel>
                <NumberInput
                  id="hb"
                  value={form.agent.heartbeatIntervalSec}
                  min={5}
                  onValueChange={(heartbeatIntervalSec) =>
                    updateForm({ ...form, agent: { ...form.agent, heartbeatIntervalSec } })
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="poll">Poll interval (sec)</FieldLabel>
                <NumberInput
                  id="poll"
                  value={form.agent.pollIntervalSec}
                  min={1}
                  onValueChange={(pollIntervalSec) =>
                    updateForm({ ...form, agent: { ...form.agent, pollIntervalSec } })
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="shot-int">Screenshot interval (sec, 0 = off)</FieldLabel>
                <NumberInput
                  id="shot-int"
                  value={form.agent.screenshotIntervalSec}
                  min={0}
                  onValueChange={(screenshotIntervalSec) =>
                    updateForm({ ...form, agent: { ...form.agent, screenshotIntervalSec } })
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="restart-at">Scheduled restart (HH:MM local, empty = off)</FieldLabel>
                <Input
                  id="restart-at"
                  value={form.agent.autoRestartTime}
                  onChange={(e) => updateForm({ ...form, agent: { ...form.agent, autoRestartTime: e.target.value } })}
                  placeholder="03:30"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="timeout">Stuck command timeout (minutes)</FieldLabel>
                <NumberInput
                  id="timeout"
                  value={form.agent.commandTimeoutMin}
                  min={1}
                  onValueChange={(commandTimeoutMin) =>
                    updateForm({ ...form, agent: { ...form.agent, commandTimeoutMin } })
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="roots">Extra sandbox roots (one per line)</FieldLabel>
                <Textarea
                  id="roots"
                  value={rootsText}
                  onChange={(e) => {
                    const raw = e.target.value
                    setRootsText(raw)
                    updateForm({
                      ...form,
                      agent: {
                        ...form.agent,
                        sandboxRoots: raw.split("\n").map((s) => s.trim()).filter(Boolean),
                      },
                    })
                  }}
                />
              </Field>
              <Field orientation="horizontal">
                <FieldLabel>Agent mesh</FieldLabel>
                <Switch
                  checked={form.mesh?.enabled ?? false}
                  onCheckedChange={(enabled) =>
                    updateForm({ ...form, mesh: { ...DEFAULT_SETTINGS.mesh, ...form.mesh, enabled } })
                  }
                />
              </Field>
              <Field orientation="horizontal">
                <FieldLabel>WAN (ICE / TURN)</FieldLabel>
                <Switch
                  checked={form.mesh?.wan ?? false}
                  onCheckedChange={(wan) =>
                    updateForm({ ...form, mesh: { ...DEFAULT_SETTINGS.mesh, ...form.mesh, wan } })
                  }
                />
              </Field>
              {form.mesh?.wan && !meta.data?.turnConfigured ? (
                <Alert>
                  <AlertTitle>TURN_URL is unset</AlertTitle>
                  <AlertDescription>
                    WAN mesh and remote desktop across NAT fail closed without TURN. Set TURN_URL (and TURN_SECRET)
                    on the API. LAN mTLS on port 17891 still works.
                  </AlertDescription>
                </Alert>
              ) : null}
              <p className="text-sm text-muted-foreground">
                When on, enrolled agents keep a persistent mTLS listener on port 17891. Files always work. Commands
                default to get_* only. kill_switch, set_registry, and run_plugin stay off unless you allow them —
                plugin blobs from peers are never accepted. Last-known policy applies if the server is down.
              </p>
              <Field>
                <FieldLabel>Extra mesh commands</FieldLabel>
                <FieldDescription>
                  Defaults (always on): get_files, get_processes, get_services, get_registry, get_adapters, get_ports,
                  get_firewall, get_event_log, get_windows_update, get_admin_center, get_tasks, get_defender,
                  get_bitlocker, get_capabilities, get_smb. run_plugin, peer copy, and
                  update_agent cannot be allowed from peers.
                </FieldDescription>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {meshExtraCommandChoices().map((type) => {
                    const checked = (form.mesh?.allowCommands ?? []).includes(type)
                    return (
                      <label key={type} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(on) => {
                            const current = form.mesh?.allowCommands ?? []
                            const allowCommands = on
                              ? [...current, type]
                              : current.filter((item) => item !== type)
                            updateForm({
                              ...form,
                              mesh: { ...DEFAULT_SETTINGS.mesh, ...form.mesh, allowCommands },
                            })
                          }}
                        />
                        <span className="font-mono text-xs">{type.replaceAll("_", " ")}</span>
                      </label>
                    )
                  })}
                </div>
              </Field>
            </FieldGroup>
          </CardContent>
          <CardFooter>
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? <Spinner data-icon="inline-start" /> : null}
              Save
            </Button>
          </CardFooter>
        </Card>
      </TabsContent>
      <TabsContent value="security">
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Operator access</CardTitle>
              <CardDescription>
                Optional SQLite login for the dashboard. OPERATOR_TOKEN still works for API clients. Production still
                needs OPERATOR_TOKEN (and TURN_URL for WAN desktop).
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <OperatorLoginCard />
              <p className="text-sm text-muted-foreground">
                Rate limit: {security.data?.rateLimitPerMinute ?? "—"} requests / minute
              </p>
              <p className="text-sm text-muted-foreground">
                IP allowlist:{" "}
                {security.data?.ipAllowlist?.length ? security.data.ipAllowlist.join(", ") : "none (all addresses)"}
              </p>
            </CardContent>
          </Card>
        </div>
      </TabsContent>
    </Tabs>
  )
}

function OperatorLoginCard() {
  const client = useQueryClient()
  const status = useQuery({
    queryKey: ["auth-status"],
    queryFn: () => api<{ mode: string; needsSetup: boolean }>("/api/v1/admin/auth/status"),
  })
  const me = useQuery({
    queryKey: ["auth-me"],
    queryFn: () => api<{ username: string; method: string }>("/api/v1/admin/auth/me"),
    retry: false,
  })
  const [username, setUsername] = React.useState("operator")
  const [password, setPassword] = React.useState("")
  const setup = useMutation({
    mutationFn: () =>
      api<{ token?: string }>("/api/v1/admin/auth/setup", { method: "POST", body: JSON.stringify({ username, password }) }),
    onSuccess: (res) => {
      if (res.token) storeSessionToken(res.token)
      toast.success("Operator password saved")
      void client.invalidateQueries({ queryKey: ["auth-status"] })
      void client.invalidateQueries({ queryKey: ["auth-me"] })
    },
    onError: (e) => toast.error(e.message),
  })
  const logout = useMutation({
    mutationFn: () => api("/api/v1/admin/auth/logout", { method: "POST" }),
    onSuccess: () => {
      storeSessionToken(null)
      window.location.href = "/login"
    },
    onError: (e) => toast.error(e.message),
  })
  const mode = status.data?.mode ?? "open"
  return (
    <div className="space-y-3">
      {mode === "password" ? (
        <Alert>
          <AlertTitle>Dashboard login is on</AlertTitle>
          <AlertDescription>
            Signed in as {me.data?.username ?? "operator"} ({me.data?.method ?? "session"}). Socket.io uses the same
            cookie. OPERATOR_TOKEN still authenticates API clients.
          </AlertDescription>
        </Alert>
      ) : (
        <Alert>
          <AlertTitle>{mode === "token" ? "Shared OPERATOR_TOKEN" : "Open console"}</AlertTitle>
          <AlertDescription>
            {mode === "token"
              ? "Admin HTTP and Socket.io require OPERATOR_TOKEN. Create a password to add a dashboard login; the token still works."
              : "Anyone who can reach this UI can send commands. Create a password to require login. Agents still enroll with ENROLLMENT_SECRET."}
          </AlertDescription>
        </Alert>
      )}
      {mode !== "password" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="op-user">Username</FieldLabel>
            <Input id="op-user" value={username} onChange={(e) => setUsername(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="op-pass">Password</FieldLabel>
            <Input id="op-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Button
            type="button"
            onClick={() => setup.mutate()}
            disabled={setup.isPending || password.length < 8}
          >
            {setup.isPending ? <Spinner data-icon="inline-start" /> : null}
            Create operator login
          </Button>
        </div>
      ) : (
        <Button type="button" variant="outline" onClick={() => logout.mutate()} disabled={logout.isPending}>
          Sign out
        </Button>
      )}
    </div>
  )
}

function UpdateCatalog({
  rows,
}: {
  rows: Array<{ id: string; version: string; platform: string; arch: string; checksum: string; createdAt: string }>
}) {
  const client = useQueryClient()
  const [version, setVersion] = React.useState("")
  const [platform, setPlatform] = React.useState("windows")
  const [arch, setArch] = React.useState("amd64")
  const [notes, setNotes] = React.useState("")
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const body = new FormData()
      body.append("file", file)
      body.append("version", version)
      body.append("platform", platform)
      body.append("arch", arch)
      body.append("notes", notes)
      const res = await fetch("/api/v1/admin/updates", {
        method: "POST",
        body,
        credentials: "include",
        headers: (() => {
          const headers = new Headers()
          applyOperatorAuth(headers)
          return headers
        })(),
      })
      if (!res.ok) throw new Error("upload failed")
    },
    onSuccess: () => {
      toast.success("Binary cataloged")
      void client.invalidateQueries({ queryKey: ["updates"] })
    },
    onError: (e) => toast.error(e.message),
  })
  return (
    <Card>
      <CardHeader>
        <CardTitle>Agent update catalog</CardTitle>
        <CardDescription>Upload platform-specific binaries. Agents verify SHA-256 before replace.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="ver">Version</FieldLabel>
            <Input id="ver" value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1.0.1" />
          </Field>
          <Field>
            <FieldLabel htmlFor="plat">Platform</FieldLabel>
            <Input id="plat" value={platform} onChange={(e) => setPlatform(e.target.value)} />
            <FieldDescription>windows, linux, or darwin</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="arch">Arch</FieldLabel>
            <Input id="arch" value={arch} onChange={(e) => setArch(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="notes">Notes</FieldLabel>
            <Textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="bin">Binary</FieldLabel>
            <Input
              id="bin"
              type="file"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) upload.mutate(file)
              }}
            />
          </Field>
        </FieldGroup>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Version</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>SHA-256</TableHead>
              <TableHead>Uploaded</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>{row.version}</TableCell>
                <TableCell>
                  {row.platform}/{row.arch}
                </TableCell>
                <TableCell className="max-w-xs truncate font-mono text-xs">{row.checksum}</TableCell>
                <TableCell>{formatWhen(row.createdAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

