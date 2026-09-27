import { PEER_LAN_PORT } from "./constants.ts"
import { unwrapCommandResult } from "./command-result.ts"

export const NETWORK_COMMAND_TYPES = [
  "get_adapters",
  "get_ports",
  "get_firewall",
  "set_firewall_rule",
  "delete_firewall_rule",
] as const

export type NetworkCommandType = (typeof NETWORK_COMMAND_TYPES)[number]

export const FIREWALL_DIRECTIONS = ["inbound", "outbound"] as const
export type FirewallDirection = (typeof FIREWALL_DIRECTIONS)[number]

export const FIREWALL_ACTIONS = ["allow", "block"] as const
export type FirewallAction = (typeof FIREWALL_ACTIONS)[number]

export const FIREWALL_PROTOCOLS = ["tcp", "udp", "any", "icmp"] as const
export type FirewallProtocol = (typeof FIREWALL_PROTOCOLS)[number]

export const FIREWALL_WRITE_ACTIONS = ["set", "delete"] as const
export type FirewallWriteAction = (typeof FIREWALL_WRITE_ACTIONS)[number]

export type AdapterInfo = {
  name: string
  description?: string
  id?: string
  status: string
  ifType?: string
  mac?: string
  mtu?: number
  dhcp?: boolean
  dhcpServer?: string
  ipv4?: string[]
  ipv6?: string[]
  dns?: string[]
  gateways?: string[]
  dnsSuffix?: string
  index?: number
}

export type ParsedAdapterList = {
  adapters: AdapterInfo[]
  truncated: boolean
}

export type PortInfo = {
  protocol: string
  localAddr: string
  localPort: number
  remoteAddr?: string
  remotePort?: number
  state: string
  pid?: number
  process?: string
  official?: boolean
}

export type ParsedPortList = {
  ports: PortInfo[]
  truncated: boolean
}

export type FirewallProfileInfo = {
  name: string
  enabled: boolean
  defaultInbound?: string
  defaultOutbound?: string
}

export type FirewallRuleInfo = {
  name: string
  description?: string
  direction: string
  action: string
  enabled: boolean
  protocol?: string
  localPorts?: string
  remotePorts?: string
  localAddresses?: string
  remoteAddresses?: string
  application?: string
  serviceName?: string
  profiles?: string
  grouping?: string
}

export type ParsedFirewall = {
  profiles: FirewallProfileInfo[]
  rules: FirewallRuleInfo[]
  truncated: boolean
  modifyState?: string
}

export type NetworkCommandSeed = {
  id: string
  type: string
  status: string
  result?: unknown
}

export function isNetworkCommandType(type: string): type is NetworkCommandType {
  return (NETWORK_COMMAND_TYPES as readonly string[]).includes(type)
}

export function isOfficialPeerPort(port: number): boolean {
  return port === PEER_LAN_PORT
}

export function portRowKey(port: PortInfo, index: number): string {
  return [
    port.protocol,
    port.localAddr,
    String(port.localPort),
    port.remoteAddr ?? "",
    String(port.remotePort ?? ""),
    String(port.pid ?? ""),
    port.state,
    String(index),
  ].join("|")
}

export function firewallRuleKey(rule: FirewallRuleInfo, index: number): string {
  return [rule.name, rule.direction, rule.protocol ?? "", rule.localPorts ?? "", String(index)].join("|")
}

function isAdapterInfo(value: unknown): value is AdapterInfo {
  if (!value || typeof value !== "object") return false
  const rec = value as { name?: unknown; status?: unknown }
  return typeof rec.name === "string" && rec.name.length > 0 && typeof rec.status === "string"
}

function isPortInfo(value: unknown): value is PortInfo {
  if (!value || typeof value !== "object") return false
  const rec = value as { protocol?: unknown; localAddr?: unknown; localPort?: unknown; state?: unknown }
  return (
    typeof rec.protocol === "string" &&
    typeof rec.localAddr === "string" &&
    typeof rec.localPort === "number" &&
    Number.isFinite(rec.localPort) &&
    typeof rec.state === "string"
  )
}

function pickString(rec: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const v = rec[key]
    if (typeof v === "string" && v.length > 0) return v
  }
  return ""
}

function pickBool(rec: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const v = rec[key]
    if (typeof v === "boolean") return v
    if (v === 1 || v === "1" || v === "true" || v === "True" || v === "Yes") return true
    if (v === 0 || v === "0" || v === "false" || v === "False" || v === "No") return false
  }
  return undefined
}

function mapFirewallDirection(value: string): string {
  const s = value.toLowerCase()
  if (s === "out" || s === "outbound" || s === "2") return "outbound"
  if (s === "in" || s === "inbound" || s === "1") return "inbound"
  return s
}

function mapFirewallAction(value: string): string {
  const s = value.toLowerCase()
  if (s === "block" || s === "deny" || s === "4" || s === "0") return "block"
  if (s === "allow" || s === "2" || s === "1") return "allow"
  return s
}

function pickDirection(rec: Record<string, unknown>): string {
  const raw = pickString(rec, "direction", "Direction")
  if (raw) return mapFirewallDirection(raw)
  const n = rec.direction ?? rec.Direction
  if (n === 2 || n === "2") return "outbound"
  if (n === 1 || n === "1") return "inbound"
  return ""
}

function pickAction(rec: Record<string, unknown>): string {
  const raw = pickString(rec, "action", "Action")
  if (raw) return mapFirewallAction(raw)
  const n = rec.action ?? rec.Action
  if (n === 0 || n === "0") return "block"
  if (n === 1 || n === "1") return "allow"
  return ""
}

function asFirewallRule(value: unknown): FirewallRuleInfo | null {
  if (!value || typeof value !== "object") return null
  const rec = value as Record<string, unknown>
  const name = pickString(rec, "name", "Name", "DisplayName")
  if (!name) return null
  const enabled = pickBool(rec, "enabled", "Enabled") ?? true
  return {
    name,
    description: pickString(rec, "description", "Description") || undefined,
    direction: pickDirection(rec) || "inbound",
    action: pickAction(rec) || "allow",
    enabled,
    protocol: pickString(rec, "protocol", "Protocol") || undefined,
    localPorts: pickString(rec, "localPorts", "LocalPorts", "LocalPort") || undefined,
    remotePorts: pickString(rec, "remotePorts", "RemotePorts") || undefined,
    localAddresses: pickString(rec, "localAddresses", "LocalAddresses") || undefined,
    remoteAddresses: pickString(rec, "remoteAddresses", "RemoteAddresses") || undefined,
    application: pickString(rec, "application", "Application", "ApplicationName") || undefined,
    serviceName: pickString(rec, "serviceName", "ServiceName") || undefined,
    profiles: pickString(rec, "profiles", "Profiles", "Profile") || undefined,
    grouping: pickString(rec, "grouping", "Grouping") || undefined,
  }
}

function asFirewallProfile(value: unknown): FirewallProfileInfo | null {
  if (!value || typeof value !== "object") return null
  const rec = value as Record<string, unknown>
  const name = pickString(rec, "name", "Name")
  const enabled = pickBool(rec, "enabled", "Enabled")
  if (!name || enabled == null) return null
  return {
    name,
    enabled,
    defaultInbound: pickString(rec, "defaultInbound", "DefaultInbound") || undefined,
    defaultOutbound: pickString(rec, "defaultOutbound", "DefaultOutbound") || undefined,
  }
}

export function parseAdapterList(result: unknown): ParsedAdapterList {
  if (Array.isArray(result)) {
    return { adapters: result.filter(isAdapterInfo), truncated: false }
  }
  if (!result || typeof result !== "object") {
    return { adapters: [], truncated: false }
  }
  const rec = result as { adapters?: unknown; items?: unknown; truncated?: unknown }
  const raw = Array.isArray(rec.adapters) ? rec.adapters : Array.isArray(rec.items) ? rec.items : []
  return { adapters: raw.filter(isAdapterInfo), truncated: Boolean(rec.truncated) }
}

export function parsePortList(result: unknown): ParsedPortList {
  if (Array.isArray(result)) {
    return { ports: result.filter(isPortInfo), truncated: false }
  }
  if (!result || typeof result !== "object") {
    return { ports: [], truncated: false }
  }
  const rec = result as { ports?: unknown; items?: unknown; truncated?: unknown }
  const raw = Array.isArray(rec.ports) ? rec.ports : Array.isArray(rec.items) ? rec.items : []
  return { ports: raw.filter(isPortInfo), truncated: Boolean(rec.truncated) }
}

export function parseFirewall(result: unknown): ParsedFirewall {
  const value = unwrapCommandResult(result)
  if (Array.isArray(value)) {
    return { profiles: [], rules: value.map(asFirewallRule).filter((v): v is FirewallRuleInfo => v != null), truncated: false }
  }
  if (!value || typeof value !== "object") {
    return { profiles: [], rules: [], truncated: false }
  }
  const rec = value as {
    profiles?: unknown
    Profiles?: unknown
    rules?: unknown
    Rules?: unknown
    items?: unknown
    truncated?: unknown
    modifyState?: unknown
  }
  const rawRules = Array.isArray(rec.rules) ? rec.rules : Array.isArray(rec.Rules) ? rec.Rules : Array.isArray(rec.items) ? rec.items : []
  const rawProfiles = Array.isArray(rec.profiles) ? rec.profiles : Array.isArray(rec.Profiles) ? rec.Profiles : []
  return {
    profiles: rawProfiles.map(asFirewallProfile).filter((v): v is FirewallProfileInfo => v != null),
    rules: rawRules.map(asFirewallRule).filter((v): v is FirewallRuleInfo => v != null),
    truncated: Boolean(rec.truncated),
    modifyState: typeof rec.modifyState === "string" ? rec.modifyState : undefined,
  }
}

export function latestSuccessfulAdapters(commands: NetworkCommandSeed[]): NetworkCommandSeed | undefined {
  return commands.find((c) => c.type === "get_adapters" && c.status === "success")
}

export function latestSuccessfulPorts(commands: NetworkCommandSeed[]): NetworkCommandSeed | undefined {
  return commands.find((c) => c.type === "get_ports" && c.status === "success")
}

export function latestSuccessfulFirewall(commands: NetworkCommandSeed[]): NetworkCommandSeed | undefined {
  return commands.find((c) => c.type === "get_firewall" && c.status === "success")
}

export function adapterStatusLabel(status: string): string {
  switch (status) {
    case "up":
      return "Up"
    case "down":
      return "Down"
    case "testing":
      return "Testing"
    case "dormant":
      return "Dormant"
    case "not_present":
      return "Not present"
    case "lower_layer_down":
      return "Lower layer down"
    default:
      return status || "Unknown"
  }
}

export function portStateLabel(state: string): string {
  switch (state) {
    case "listen":
      return "Listen"
    case "established":
      return "Established"
    case "open":
      return "Open"
    case "time_wait":
      return "Time wait"
    case "close_wait":
      return "Close wait"
    case "syn_sent":
      return "SYN sent"
    case "syn_received":
      return "SYN received"
    case "fin_wait1":
      return "FIN wait 1"
    case "fin_wait2":
      return "FIN wait 2"
    case "closing":
      return "Closing"
    case "last_ack":
      return "Last ACK"
    case "closed":
      return "Closed"
    default:
      return state || "Unknown"
  }
}

export function firewallDirectionLabel(direction: string): string {
  switch (direction) {
    case "inbound":
      return "Inbound"
    case "outbound":
      return "Outbound"
    default:
      return direction || "—"
  }
}

export function firewallActionLabel(action: string): string {
  switch (action) {
    case "allow":
      return "Allow"
    case "block":
      return "Block"
    default:
      return action || "—"
  }
}

export function isListenPort(port: PortInfo): boolean {
  return port.state === "listen" || port.state === "open" || port.protocol === "udp"
}

export function isEstablishedPort(port: PortInfo): boolean {
  return port.state === "established"
}

export function firewallRuleConfirm(action: FirewallWriteAction, name: string): string {
  if (action === "delete") {
    return `Delete firewall rule ${name}? Remote access can break if this rule allows the agent or peer port ${PEER_LAN_PORT}. The Windows Firewall itself is not disabled.`
  }
  return `Add or update firewall rule ${name}? This writes one INetFwPolicy2 rule. The Windows Firewall itself is not disabled.`
}
