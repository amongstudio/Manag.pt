"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { COMMAND_TEMPLATES, COMMAND_TYPES, DESTRUCTIVE_COMMANDS, DEFAULT_SETTINGS, groupedBuiltinCommandTemplates, isComposerCommandType, isCredentialCommandType, MEDIA_FEATURE_PACK, meshCommandAllowed, type AppSettings, type CommandType, type LanPeer, validateCommandPayload } from "@workspace/shared"

import { api } from "@/lib/api"
import { BulkProgressLabel, trackBulkCommands } from "@/lib/bulk-command-progress"
import { NumberInput } from "@/components/number-input"
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
import { Field, FieldGroup, FieldLabel } from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Textarea } from "@workspace/ui/components/textarea"
import { Spinner } from "@workspace/ui/components/spinner"
import { Switch } from "@workspace/ui/components/switch"

const TYPE_ITEMS = COMMAND_TYPES.filter(isComposerCommandType).map((type) => ({
  label: type.replaceAll("_", " "),
  value: type,
}))

type SavedCommandTemplate = {
  id: string
  name: string
  description: string | null
  type: string
  payload?: Record<string, unknown>
  createdAt: string
}

function payloadError(error: { issues: Array<{ message: string }> }): string {
  return error.issues.map((i) => i.message).join("; ") || "invalid payload"
}

function isCommandType(value: string): value is CommandType {
  return (COMMAND_TYPES as readonly string[]).includes(value)
}

function defaultPayload(type: CommandType): Record<string, unknown> {
  switch (type) {
    case "install_app":
      return { name: "" }
    case "uninstall_app":
      return { name: "" }
    case "run_script":
      return { script: "" }
    case "kill_process":
      return { name: "" }
    case "get_files":
      return {}
    case "mkdir":
    case "upload_file":
    case "delete_file":
    case "preview_file":
      return { path: "" }
    case "rename_file":
    case "move_file":
    case "copy_file":
      return { from: "", to: "" }
    case "search_files":
      return { path: ".", name: "" }
    case "download_file":
      return { fileId: "", dest: "" }
    case "start_watch":
      return { durationMin: 60 }
    case "run_plugin":
      return { pluginId: "", args: [] as string[] }
    case "get_services":
      return {}
    case "start_service":
    case "stop_service":
    case "restart_service":
      return { name: "" }
    case "get_registry":
      return { hive: "HKLM", path: "SOFTWARE\\PC Manager\\Agent" }
    case "set_registry":
      return { hive: "HKLM", path: "SOFTWARE\\PC Manager\\Agent", name: "", type: "REG_SZ", data: "" }
    case "delete_registry":
      return { hive: "HKLM", path: "SOFTWARE\\PC Manager\\Agent", name: "" }
    case "get_adapters":
    case "get_firewall":
    case "get_admin_center":
    case "get_defender":
    case "get_bitlocker":
    case "get_smb":
      return {}
    case "get_tasks":
    case "get_capabilities":
      return { query: "" }
    case "install_capability":
      return { name: MEDIA_FEATURE_PACK }
    case "set_task_enabled":
      return { path: "", enabled: true }
    case "get_ports":
      return { listenOnly: true }
    case "get_event_log":
      return { log: "System", newest: 50, level: "all" }
    case "get_windows_update":
      return { online: false }
    case "start_quick_assist":
      return { app: "quickassist" }
    case "set_firewall_rule":
      return {
        name: "",
        direction: "inbound",
        action: "allow",
        enabled: true,
        protocol: "tcp",
        localPorts: "",
      }
    case "delete_firewall_rule":
      return { name: "" }
    case "smb_list":
      return { path: "\\\\server\\share" }
    case "smb_connect":
      return { unc: "\\\\server\\share", persist: false }
    case "smb_disconnect":
      return { unc: "\\\\server\\share" }
    case "get_credentials":
    case "backup_credentials":
      return { sources: ["windows", "browser", "apps"] }
    case "generate_credential":
      return { length: 20, save: false }
    case "set_credential":
      return { source: "windows", target: "", secret: "", persist: "local" }
    case "delete_credential":
      return { source: "windows", target: "" }
    case "set_defender":
      return { realtime: true }
    case "start_defender_scan":
      return { type: "quick" }
    case "update_defender":
    case "cancel_defender_scan":
      return {}
    case "defender_action":
      return { threatId: "", action: "remove" }
    case "set_bitlocker":
      return { action: "suspend", mountPoint: "C:" }
    case "peer_listen":
    case "peer_offer":
      return {}
    default:
      return {}
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value)
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function CommandComposer({
  deviceIds,
  triggerLabel = "Queue command",
  showProgress = true,
  allowFleet = false,
  peers,
}: {
  deviceIds: string[]
  triggerLabel?: string
  showProgress?: boolean
  /** When true, an empty selection queues to the entire fleet (`deviceIds: ["*"]`). */
  allowFleet?: boolean
  /** Optional LAN/mesh peers for forward-to-peer (device page only). */
  peers?: LanPeer[]
}) {
  const client = useQueryClient()
  const [open, setOpen] = React.useState(false)
  const [confirm, setConfirm] = React.useState(false)
  const [type, setType] = React.useState<CommandType>("get_processes")
  const [payload, setPayload] = React.useState<Record<string, unknown>>({})
  const [payloadText, setPayloadText] = React.useState("{}")
  const [advanced, setAdvanced] = React.useState(false)
  const [saveOpen, setSaveOpen] = React.useState(false)
  const [saveName, setSaveName] = React.useState("")
  const [saveDescription, setSaveDescription] = React.useState("")
  const [forwardTo, setForwardTo] = React.useState("")
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api<{ settings: AppSettings }>("/api/v1/admin/settings"),
    staleTime: 30_000,
    enabled: Boolean(peers?.length),
  })
  const devices = useQuery({
    queryKey: ["devices"],
    queryFn: () => api<{ devices: { id: string; hostname: string }[] }>("/api/v1/admin/devices"),
    staleTime: 30_000,
  })
  const saved = useQuery({
    queryKey: ["command-templates"],
    queryFn: () => api<{ templates: SavedCommandTemplate[] }>("/api/v1/admin/command-templates"),
    staleTime: 30_000,
    retry: false,
  })

  function applyPayload(next: Record<string, unknown>) {
    setPayload(next)
    setPayloadText(JSON.stringify(next, null, 2))
  }

  function setTypeAndPayload(next: CommandType, nextPayload?: Record<string, unknown>) {
    setType(next)
    applyPayload(nextPayload ?? defaultPayload(next))
  }

  const canQueue = deviceIds.length > 0 || allowFleet

  const mutation = useMutation({
    mutationFn: async () => {
      if (!deviceIds.length && !allowFleet) throw new Error("Select at least one device")
      let body: Record<string, unknown>
      try {
        body = JSON.parse(payloadText || "{}") as Record<string, unknown>
      } catch {
        throw new Error("Payload must be valid JSON")
      }
      const checked = validateCommandPayload(type, body)
      if (!checked.ok) throw new Error(payloadError(checked.error))
      if (forwardTo && deviceIds.length === 1) {
        const data = await api<{ command: { id: string } }>(`/api/v1/admin/devices/${deviceIds[0]}/mesh-forward`, {
          method: "POST",
          body: JSON.stringify({ destDeviceId: forwardTo, type, payload: checked.payload }),
        })
        return { commands: [{ id: data.command.id }] }
      }
      return api<{ commands: { id: string }[] }>("/api/v1/admin/commands", {
        method: "POST",
        body: JSON.stringify({
          deviceIds: deviceIds.length ? deviceIds : ["*"],
          type,
          payload: checked.payload,
        }),
      })
    },
    onSuccess: (data) => {
      trackBulkCommands(data.commands.map((c) => c.id))
      toast.success("Command queued")
      void client.invalidateQueries({ queryKey: ["commands"] })
      void client.invalidateQueries({ queryKey: ["overview"] })
      setOpen(false)
    },
    onError: (error) => toast.error(error.message),
  })

  const saveTpl = useMutation({
    mutationFn: () => {
      let body: Record<string, unknown>
      try {
        body = JSON.parse(payloadText || "{}") as Record<string, unknown>
      } catch {
        throw new Error("Payload must be valid JSON")
      }
      const checked = validateCommandPayload(type, body)
      if (!checked.ok) throw new Error(payloadError(checked.error))
      return api("/api/v1/admin/command-templates", {
        method: "POST",
        body: JSON.stringify({
          name: saveName.trim(),
          description: saveDescription.trim() || undefined,
          type,
          payload: checked.payload,
        }),
      })
    },
    onSuccess: () => {
      toast.success("Template saved")
      setSaveOpen(false)
      setSaveName("")
      setSaveDescription("")
      void client.invalidateQueries({ queryKey: ["command-templates"] })
    },
    onError: (e) => toast.error(e.message),
  })

  const deleteTpl = useMutation({
    mutationFn: (id: string) => api(`/api/v1/admin/command-templates/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Template deleted")
      void client.invalidateQueries({ queryKey: ["command-templates"] })
    },
    onError: (e) => toast.error(e.message),
  })

  function applySaved(tpl: SavedCommandTemplate) {
    if (!isCommandType(tpl.type)) {
      toast.error(`Unknown command type ${tpl.type}`)
      return
    }
    setTypeAndPayload(tpl.type, tpl.payload && typeof tpl.payload === "object" ? { ...tpl.payload } : {})
  }

  function submit() {
    if (DESTRUCTIVE_COMMANDS.has(type) || forwardTo) {
      setConfirm(true)
      return
    }
    mutation.mutate()
  }

  const meshPolicy = { ...DEFAULT_SETTINGS.mesh, ...settings.data?.settings.mesh }
  const canForward =
    Boolean(peers?.length) &&
    deviceIds.length === 1 &&
    meshPolicy.enabled &&
    meshCommandAllowed(type, meshPolicy.allowCommands)
  const forwardPeer = peers?.find((p) => p.id === forwardTo)

  const savedRows = saved.data?.templates ?? []
  const builtinGroups = groupedBuiltinCommandTemplates()

  function templateButton(tpl: (typeof COMMAND_TEMPLATES)[number]) {
    return (
      <Button
        key={tpl.id}
        size="sm"
        variant="outline"
        onClick={() => setTypeAndPayload(tpl.type, { ...tpl.payload })}
      >
        {tpl.name}
        <Badge variant="secondary" className="ml-1">
          built-in
        </Badge>
      </Button>
    )
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <Button onClick={() => setOpen(true)} disabled={!canQueue}>
          {triggerLabel}
        </Button>
        <Dialog
          open={open}
          onOpenChange={(next) => {
            if (!next && confirm) return
            setOpen(next)
            if (!next) setForwardTo("")
          }}
        >
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Queue command</DialogTitle>
              <DialogDescription>
                {deviceIds.length
                  ? `${deviceIds.length} device(s) selected`
                  : allowFleet
                    ? "All devices will receive this command"
                    : "Select at least one device"}
              </DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field>
                <FieldLabel>Templates</FieldLabel>
                <div className="flex max-h-48 flex-col gap-2 overflow-auto rounded-lg border p-2">
                  {builtinGroups.map((group) => (
                    <div key={group.category} className="flex flex-col gap-1">
                      <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                        {group.label}
                      </p>
                      <div className="flex flex-wrap gap-1">{group.templates.map(templateButton)}</div>
                    </div>
                  ))}
                  {savedRows.length ? (
                    <div className="flex flex-col gap-1">
                      <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Saved</p>
                      <div className="flex flex-wrap gap-1">
                        {savedRows.map((tpl) => (
                          <span key={tpl.id} className="inline-flex items-center gap-1">
                            <Button size="sm" variant="outline" onClick={() => applySaved(tpl)}>
                              {tpl.name}
                            </Button>
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={() => deleteTpl.mutate(tpl.id)}
                              aria-label={`Delete ${tpl.name}`}
                            >
                              ×
                            </Button>
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              </Field>
              <Field>
                <FieldLabel>Type</FieldLabel>
                <Select
                  items={TYPE_ITEMS}
                  value={type}
                  onValueChange={(value) => setTypeAndPayload(value as CommandType)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {TYPE_ITEMS.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              {deviceIds.length === 0 && allowFleet ? (
                <Field>
                  <FieldLabel>Targets</FieldLabel>
                  <p className="text-sm text-muted-foreground">
                    {devices.data?.devices.length ?? 0} devices in fleet (bulk)
                  </p>
                </Field>
              ) : null}
              {canForward ? (
                <Field>
                  <FieldLabel>Forward to peer</FieldLabel>
                  <Select
                    items={[
                      { label: "This device", value: "_self" },
                      ...peers!
                        .filter((p) => p.id !== deviceIds[0])
                        .map((p) => ({
                          label: `${p.hostname}${p.likely ? " (LAN)" : ""}`,
                          value: p.id,
                        })),
                    ]}
                    value={forwardTo || "_self"}
                    onValueChange={(value) => setForwardTo(!value || value === "_self" ? "" : value)}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="This device" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="_self">This device</SelectItem>
                        {peers
                          ?.filter((p) => p.id !== deviceIds[0])
                          .map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.hostname}
                              {p.likely ? " (LAN)" : ""}
                            </SelectItem>
                          ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Gated by the mesh allowlist. Confirm before sending to another enrolled agent.
                  </p>
                </Field>
              ) : null}
              <TypedFields type={type} payload={payload} onChange={applyPayload} />
              <div>
                <button
                  type="button"
                  className="text-xs text-muted-foreground underline-offset-4 hover:underline"
                  onClick={() => setAdvanced((v) => !v)}
                >
                  {advanced ? "Hide advanced JSON" : "Advanced JSON"}
                </button>
                {advanced ? (
                  <Textarea
                    className="mt-2"
                    id="payload"
                    value={payloadText}
                    onChange={(e) => {
                      setPayloadText(e.target.value)
                      try {
                        setPayload(JSON.parse(e.target.value || "{}") as Record<string, unknown>)
                      } catch {
                        /* keep last good object */
                      }
                    }}
                    rows={6}
                  />
                ) : null}
              </div>
            </FieldGroup>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setSaveName("")
                  setSaveDescription("")
                  setSaveOpen(true)
                }}
              >
                Save as template
              </Button>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button onClick={submit} disabled={mutation.isPending || !canQueue}>
                {mutation.isPending ? <Spinner data-icon="inline-start" /> : null}
                Queue
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        {showProgress ? <BulkProgressLabel /> : null}
      </div>
      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save command template</DialogTitle>
            <DialogDescription>Stored on the server with the same payload validation as live commands.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="tpl-name">Name</FieldLabel>
              <Input id="tpl-name" value={saveName} onChange={(e) => setSaveName(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="tpl-desc">Description</FieldLabel>
              <Input id="tpl-desc" value={saveDescription} onChange={(e) => setSaveDescription(e.target.value)} />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => saveTpl.mutate()} disabled={saveTpl.isPending || !saveName.trim()}>
              {saveTpl.isPending ? <Spinner data-icon="inline-start" /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {forwardTo ? "Forward to peer" : `Confirm ${type.replaceAll("_", " ")}`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {forwardTo
                ? `Send ${type.replaceAll("_", " ")} to ${forwardPeer?.hostname ?? "the selected peer"} over the mesh allowlist?`
                : "This command can disrupt the target machine. Continue?"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirm(false)
                mutation.mutate()
              }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function TypedFields({
  type,
  payload,
  onChange,
}: {
  type: CommandType
  payload: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
}) {
  function set(key: string, value: unknown) {
    onChange({ ...payload, [key]: value })
  }

  if (
    type === "restart" ||
    type === "shutdown" ||
    type === "kill_switch" ||
    type === "get_processes" ||
    type === "capture_screenshot" ||
    type === "stop_watch" ||
    type === "update_agent" ||
    type === "get_services" ||
    type === "get_adapters" ||
    type === "get_firewall" ||
    type === "get_admin_center" ||
    type === "get_defender" ||
    type === "get_bitlocker" ||
    type === "get_smb"
  ) {
    return <p className="text-sm text-muted-foreground">No payload for this command.</p>
  }

  if (isCredentialCommandType(type)) {
    return (
      <p className="text-sm text-muted-foreground">
        Prefer the device Credentials tab for backup, generate, restore, and reveal. Secrets are AES-256-GCM in the
        dashboard vault and are stripped from command history.
      </p>
    )
  }

  if (
    type === "set_defender" ||
    type === "start_defender_scan" ||
    type === "update_defender" ||
    type === "defender_action" ||
    type === "cancel_defender_scan" ||
    type === "set_bitlocker"
  ) {
    return (
      <p className="text-sm text-muted-foreground">
        Prefer the device Windows tools tab for Defender and BitLocker. Dashboard controls queue these commands with
        confirms; BitLocker recovery passwords are vaulted and stripped from history. Mesh never carries credential or
        BitLocker write commands.
      </p>
    )
  }

  if (type === "run_script") {
    return (
      <Field>
        <FieldLabel htmlFor="f-script">Script</FieldLabel>
        <Textarea id="f-script" rows={6} value={asString(payload.script)} onChange={(e) => set("script", e.target.value)} />
      </Field>
    )
  }

  if (type === "install_app") {
    return (
      <>
        <Field>
          <FieldLabel htmlFor="f-name">Name</FieldLabel>
          <Input id="f-name" value={asString(payload.name)} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="f-id">Id (optional)</FieldLabel>
          <Input id="f-id" value={asString(payload.id)} onChange={(e) => set("id", e.target.value || undefined)} />
        </Field>
      </>
    )
  }

  if (type === "uninstall_app") {
    return (
      <Field>
        <FieldLabel htmlFor="f-uname">Name</FieldLabel>
        <Input id="f-uname" value={asString(payload.name)} onChange={(e) => set("name", e.target.value)} />
      </Field>
    )
  }

  if (type === "kill_process") {
    return (
      <>
        <Field>
          <FieldLabel htmlFor="f-pid">PID</FieldLabel>
          <NumberInput
            id="f-pid"
            min={1}
            value={asNumber(payload.pid) ?? 0}
            onValueChange={(pid) => set("pid", pid > 0 ? pid : undefined)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="f-pname">Name</FieldLabel>
          <Input id="f-pname" value={asString(payload.name)} onChange={(e) => set("name", e.target.value)} />
        </Field>
      </>
    )
  }

  if (type === "get_files") {
    return (
      <Field>
        <FieldLabel htmlFor="f-path">Path (empty = home)</FieldLabel>
        <Input
          id="f-path"
          value={asString(payload.path)}
          onChange={(e) => {
            const v = e.target.value
            if (!v) {
              const next = { ...payload }
              delete next.path
              onChange(next)
              return
            }
            set("path", v)
          }}
        />
      </Field>
    )
  }

  if (type === "mkdir" || type === "upload_file" || type === "delete_file" || type === "preview_file") {
    return (
      <Field>
        <FieldLabel htmlFor="f-path">Path</FieldLabel>
        <Input id="f-path" value={asString(payload.path)} onChange={(e) => set("path", e.target.value)} />
      </Field>
    )
  }

  if (type === "rename_file" || type === "move_file" || type === "copy_file") {
    return (
      <>
        <Field>
          <FieldLabel htmlFor="f-from">From</FieldLabel>
          <Input id="f-from" value={asString(payload.from)} onChange={(e) => set("from", e.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="f-to">To</FieldLabel>
          <Input id="f-to" value={asString(payload.to)} onChange={(e) => set("to", e.target.value)} />
        </Field>
      </>
    )
  }

  if (type === "search_files") {
    return (
      <>
        <Field>
          <FieldLabel htmlFor="f-spath">Path</FieldLabel>
          <Input id="f-spath" value={asString(payload.path)} onChange={(e) => set("path", e.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="f-sname">Name</FieldLabel>
          <Input id="f-sname" value={asString(payload.name)} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="f-sext">Extension</FieldLabel>
          <Input id="f-sext" value={asString(payload.ext)} onChange={(e) => set("ext", e.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="f-scontent">Content</FieldLabel>
          <Input id="f-scontent" value={asString(payload.content)} onChange={(e) => set("content", e.target.value)} />
        </Field>
      </>
    )
  }

  if (type === "download_file") {
    return (
      <>
        <Field>
          <FieldLabel htmlFor="f-fid">File id</FieldLabel>
          <Input id="f-fid" value={asString(payload.fileId)} onChange={(e) => set("fileId", e.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="f-dest">Dest</FieldLabel>
          <Input id="f-dest" value={asString(payload.dest)} onChange={(e) => set("dest", e.target.value)} />
        </Field>
      </>
    )
  }

  if (type === "start_watch") {
    return (
      <Field>
        <FieldLabel htmlFor="f-dur">Duration (minutes)</FieldLabel>
        <NumberInput
          id="f-dur"
          min={1}
          max={240}
          value={asNumber(payload.durationMin) ?? 60}
          onValueChange={(durationMin) => set("durationMin", durationMin)}
        />
      </Field>
    )
  }

  if (type === "run_plugin") {
    const args = Array.isArray(payload.args) ? (payload.args as string[]).join("\n") : asString(payload.args)
    return (
      <>
        <Field>
          <FieldLabel htmlFor="f-plug">Plugin id</FieldLabel>
          <Input id="f-plug" value={asString(payload.pluginId)} onChange={(e) => set("pluginId", e.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="f-args">Args (one per line)</FieldLabel>
          <Textarea
            id="f-args"
            rows={4}
            value={args}
            onChange={(e) =>
              set(
                "args",
                e.target.value
                  .split("\n")
                  .map((s) => s.trim())
                  .filter(Boolean)
              )
            }
          />
        </Field>
      </>
    )
  }

  if (type === "start_service" || type === "stop_service" || type === "restart_service") {
    return (
      <Field>
        <FieldLabel htmlFor="f-svc">Service name</FieldLabel>
        <Input id="f-svc" value={asString(payload.name)} onChange={(e) => set("name", e.target.value)} />
      </Field>
    )
  }

  if (type === "get_ports") {
    return (
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={payload.listenOnly === true} onCheckedChange={(on) => set("listenOnly", on)} />
        Listen only
      </label>
    )
  }

  if (type === "get_event_log") {
    return (
      <>
        <Field>
          <FieldLabel htmlFor="f-evtlog">Channel</FieldLabel>
          <Input id="f-evtlog" value={asString(payload.log) || "System"} onChange={(e) => set("log", e.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="f-newest">Newest</FieldLabel>
          <NumberInput
            id="f-newest"
            min={1}
            max={200}
            value={asNumber(payload.newest) ?? 50}
            onValueChange={(newest) => set("newest", newest)}
          />
        </Field>
        <Field>
          <FieldLabel>Level</FieldLabel>
          <Select
            items={[
              { value: "all", label: "All" },
              { value: "critical", label: "Critical" },
              { value: "error", label: "Error" },
              { value: "warning", label: "Warning" },
              { value: "information", label: "Information" },
            ]}
            value={asString(payload.level) || "all"}
            onValueChange={(level) => set("level", level)}
          >
            <SelectTrigger className="w-full">
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
        </Field>
      </>
    )
  }

  if (type === "get_windows_update") {
    return (
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={payload.online === true} onCheckedChange={(on) => set("online", on)} />
        Online search (slower)
      </label>
    )
  }

  if (type === "get_tasks" || type === "get_capabilities") {
    return (
      <Field>
        <FieldLabel htmlFor="f-query">Filter (optional)</FieldLabel>
        <Input id="f-query" value={asString(payload.query)} onChange={(e) => set("query", e.target.value)} />
      </Field>
    )
  }

  if (type === "install_capability") {
    return (
      <Field>
        <FieldLabel htmlFor="f-capname">Capability</FieldLabel>
        <Input id="f-capname" value={asString(payload.name) || MEDIA_FEATURE_PACK} onChange={(e) => set("name", e.target.value)} />
        <p className="text-xs text-muted-foreground">Agent only accepts Media Feature Pack. Prefer the device Capabilities tab.</p>
      </Field>
    )
  }

  if (type === "set_task_enabled") {
    return (
      <>
        <Field>
          <FieldLabel htmlFor="f-taskpath">Task path</FieldLabel>
          <Input id="f-taskpath" value={asString(payload.path)} onChange={(e) => set("path", e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={payload.enabled !== false} onCheckedChange={(on) => set("enabled", on)} />
          Enabled
        </label>
      </>
    )
  }

  if (type === "start_quick_assist") {
    return (
      <Field>
        <FieldLabel>App</FieldLabel>
        <Select
          items={[
            { value: "quickassist", label: "Quick Assist" },
            { value: "msra", label: "Remote Assistance (msra)" },
          ]}
          value={asString(payload.app) || "quickassist"}
          onValueChange={(app) => set("app", app)}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="quickassist">Quick Assist</SelectItem>
              <SelectItem value="msra">Remote Assistance (msra)</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
    )
  }

  if (type === "set_firewall_rule") {
    return (
      <>
        <Field>
          <FieldLabel htmlFor="f-fwname">Rule name</FieldLabel>
          <Input id="f-fwname" value={asString(payload.name)} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field>
          <FieldLabel>Direction</FieldLabel>
          <Select
            items={[
              { value: "inbound", label: "Inbound" },
              { value: "outbound", label: "Outbound" },
            ]}
            value={asString(payload.direction) || "inbound"}
            onValueChange={(direction) => set("direction", direction)}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="inbound">Inbound</SelectItem>
                <SelectItem value="outbound">Outbound</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel>Action</FieldLabel>
          <Select
            items={[
              { value: "allow", label: "Allow" },
              { value: "block", label: "Block" },
            ]}
            value={asString(payload.action) || "allow"}
            onValueChange={(action) => set("action", action)}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="allow">Allow</SelectItem>
                <SelectItem value="block">Block</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel>Protocol</FieldLabel>
          <Select
            items={[
              { value: "tcp", label: "TCP" },
              { value: "udp", label: "UDP" },
              { value: "any", label: "Any" },
              { value: "icmp", label: "ICMP" },
            ]}
            value={asString(payload.protocol) || "tcp"}
            onValueChange={(protocol) => set("protocol", protocol)}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="tcp">TCP</SelectItem>
                <SelectItem value="udp">UDP</SelectItem>
                <SelectItem value="any">Any</SelectItem>
                <SelectItem value="icmp">ICMP</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="f-fwports">Local ports</FieldLabel>
          <Input id="f-fwports" value={asString(payload.localPorts)} onChange={(e) => set("localPorts", e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={payload.enabled !== false} onCheckedChange={(on) => set("enabled", on)} />
          Enabled
        </label>
        <Field>
          <FieldLabel htmlFor="f-fwapp">Application</FieldLabel>
          <Input id="f-fwapp" value={asString(payload.application)} onChange={(e) => set("application", e.target.value)} />
        </Field>
      </>
    )
  }

  if (type === "delete_firewall_rule") {
    return (
      <Field>
        <FieldLabel htmlFor="f-fwdell">Rule name</FieldLabel>
        <Input id="f-fwdell" value={asString(payload.name)} onChange={(e) => set("name", e.target.value)} />
      </Field>
    )
  }

  if (type === "smb_list") {
    return (
      <Field>
        <FieldLabel htmlFor="f-smbpath">Path</FieldLabel>
        <Input id="f-smbpath" value={asString(payload.path)} onChange={(e) => set("path", e.target.value)} />
      </Field>
    )
  }

  if (type === "smb_connect") {
    return (
      <>
        <Field>
          <FieldLabel htmlFor="f-smbunc">UNC</FieldLabel>
          <Input id="f-smbunc" value={asString(payload.unc)} onChange={(e) => set("unc", e.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="f-smbuser">Username</FieldLabel>
          <Input id="f-smbuser" value={asString(payload.username)} onChange={(e) => set("username", e.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="f-smbpass">Password</FieldLabel>
          <Input id="f-smbpass" type="password" value={asString(payload.password)} onChange={(e) => set("password", e.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="f-smbdrive">Drive</FieldLabel>
          <Input id="f-smbdrive" value={asString(payload.drive)} onChange={(e) => set("drive", e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={payload.persist === true} onCheckedChange={(on) => set("persist", on)} />
          Persist mapping
        </label>
      </>
    )
  }

  if (type === "smb_disconnect") {
    return (
      <>
        <Field>
          <FieldLabel htmlFor="f-smbdisc">UNC or path</FieldLabel>
          <Input
            id="f-smbdisc"
            value={asString(payload.unc) || asString(payload.path)}
            onChange={(e) => set("unc", e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="f-smbdiscdrive">Drive</FieldLabel>
          <Input id="f-smbdiscdrive" value={asString(payload.drive)} onChange={(e) => set("drive", e.target.value)} />
        </Field>
      </>
    )
  }

  if (type === "get_registry" || type === "set_registry" || type === "delete_registry") {
    return (
      <>
        <Field>
          <FieldLabel>Hive</FieldLabel>
          <Select
            items={[
              { value: "HKLM", label: "HKLM" },
              { value: "HKCU", label: "HKCU" },
            ]}
            value={asString(payload.hive) || "HKLM"}
            onValueChange={(hive) => set("hive", hive)}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="HKLM">HKLM</SelectItem>
                <SelectItem value="HKCU">HKCU</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="f-regpath">Path</FieldLabel>
          <Input id="f-regpath" value={asString(payload.path)} onChange={(e) => set("path", e.target.value)} />
        </Field>
        {type === "set_registry" || type === "delete_registry" ? (
          <Field>
            <FieldLabel htmlFor="f-regname">Value name</FieldLabel>
            <Input id="f-regname" value={asString(payload.name)} onChange={(e) => set("name", e.target.value)} />
          </Field>
        ) : null}
        {type === "set_registry" ? (
          <>
            <Field>
              <FieldLabel htmlFor="f-regtype">Type</FieldLabel>
              <Input id="f-regtype" value={asString(payload.type)} onChange={(e) => set("type", e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="f-regdata">Data</FieldLabel>
              <Textarea id="f-regdata" rows={3} value={asString(payload.data)} onChange={(e) => set("data", e.target.value)} />
            </Field>
          </>
        ) : null}
      </>
    )
  }

  return null
}
