import assert from "node:assert/strict"
import { test } from "node:test"

import {
  WINDOWS_AGENT_SERVICE,
  WINDOWS_HELPER_SERVICE,
  firewallRuleConfirm,
  formatRegistryData,
  isDangerousRegistryPath,
  isOfficialPeerPort,
  isOfficialService,
  joinRegistryPath,
  normalizeRegistryPath,
  parentRegistryPath,
  parseAdapterList,
  parseFirewall,
  parsePortList,
  portRowKey,
  firewallRuleKey,
  parseRegistryKey,
  parseServiceList,
  registryCrumbs,
  registryDisplayPath,
  resultErrorMessage,
  serviceControlConfirm,
  serviceStatusLabel,
} from "./index.ts"

test("parseServiceList and official names", () => {
  const parsed = parseServiceList({
    truncated: true,
    services: [
      { name: "Spooler", displayName: "Print Spooler", status: "running", startType: "automatic", pid: 100 },
      { name: WINDOWS_AGENT_SERVICE, displayName: "Mnag.pt Agent", status: "running", official: true },
      { name: 1 },
    ],
  })
  assert.equal(parsed.services.length, 2)
  assert.equal(parsed.truncated, true)
  assert.equal(isOfficialService(WINDOWS_AGENT_SERVICE), true)
  assert.equal(isOfficialService(WINDOWS_HELPER_SERVICE), true)
  assert.equal(isOfficialService("spooler"), false)
  assert.equal(serviceStatusLabel("stop_pending"), "Stopping")
  assert.match(serviceControlConfirm("stop", WINDOWS_HELPER_SERVICE), /helper/i)
})

test("registry path helpers and documented agent key", () => {
  assert.equal(normalizeRegistryPath("SOFTWARE/PC Manager/Agent"), "SOFTWARE\\PC Manager\\Agent")
  assert.equal(registryDisplayPath("HKLM", "SOFTWARE\\PC Manager\\Agent"), "HKLM\\SOFTWARE\\PC Manager\\Agent")
  assert.equal(joinRegistryPath("SOFTWARE", "PC Manager"), "SOFTWARE\\PC Manager")
  assert.equal(parentRegistryPath("SOFTWARE\\PC Manager\\Agent"), "SOFTWARE\\PC Manager")
  const crumbs = registryCrumbs("HKLM", "SOFTWARE\\PC Manager\\Agent")
  assert.equal(crumbs[0]?.label, "HKLM")
  assert.equal(crumbs.at(-1)?.path, "SOFTWARE\\PC Manager\\Agent")
  assert.equal(isDangerousRegistryPath("HKLM", "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run"), true)
  assert.equal(isDangerousRegistryPath("HKLM", "SOFTWARE\\PC Manager\\Agent"), false)
  const parsed = parseRegistryKey({
    hive: "HKLM",
    path: "SOFTWARE\\PC Manager\\Agent",
    keys: ["sub"],
    values: [{ name: "server_url", type: "REG_SZ", data: "http://localhost:4000" }],
  })
  assert.equal(parsed?.values[0]?.name, "server_url")
  assert.equal(formatRegistryData({ name: "x", type: "REG_DWORD", data: 16 }), "16 (0x10)")
  assert.equal(resultErrorMessage({ error: "unsupported" }, "failed"), "unsupported")
  assert.equal(parseRegistryKey({ hive: "HKU" }), null)
})

test("network parsers and official peer port", () => {
  const adapters = parseAdapterList({
    truncated: true,
    adapters: [
      { name: "Ethernet", status: "up", ipv4: ["10.0.0.8/24"], dhcp: true },
      { name: 1 },
    ],
  })
  assert.equal(adapters.adapters.length, 1)
  assert.equal(adapters.truncated, true)
  const ports = parsePortList({
    ports: [
      { protocol: "tcp", localAddr: "0.0.0.0", localPort: 17891, state: "listen", official: true },
      { protocol: "tcp", localAddr: "10.0.0.8", localPort: "nope", state: "listen" },
    ],
  })
  assert.equal(ports.ports.length, 1)
  assert.equal(isOfficialPeerPort(17891), true)
  assert.equal(isOfficialPeerPort(80), false)
  const dup = [
    { protocol: "udp", localAddr: "0.0.0.0", localPort: 5353, state: "open", pid: 3952 },
    { protocol: "udp", localAddr: "0.0.0.0", localPort: 5353, state: "open", pid: 3952 },
  ]
  assert.notEqual(portRowKey(dup[0], 0), portRowKey(dup[1], 1))
  assert.notEqual(
    firewallRuleKey({ name: "Core Networking", direction: "inbound", action: "allow", enabled: true }, 0),
    firewallRuleKey({ name: "Core Networking", direction: "inbound", action: "allow", enabled: true }, 1)
  )
  const fw = parseFirewall({
    profiles: [{ name: "private", enabled: true, defaultInbound: "block" }],
    rules: [{ name: "Peer LAN", direction: "inbound", action: "allow", enabled: true, localPorts: "17891" }],
  })
  assert.equal(fw.rules[0]?.name, "Peer LAN")
  const pascal = parseFirewall({
    Rules: [{ Name: "Core Networking", Direction: "In", Action: "Allow", Enabled: true, LocalPort: "68" }],
  })
  assert.equal(pascal.rules[0]?.name, "Core Networking")
  assert.equal(pascal.rules[0]?.direction, "inbound")
  assert.equal(pascal.rules[0]?.localPorts, "68")
  const numeric = parseFirewall({
    rules: [{ name: "Block SMB", Direction: 2, Action: 0, Enabled: 0, Protocol: "TCP", LocalPorts: "445" }],
  })
  assert.equal(numeric.rules.length, 1)
  assert.equal(numeric.rules[0]?.direction, "outbound")
  assert.equal(numeric.rules[0]?.action, "block")
  assert.equal(numeric.rules[0]?.enabled, false)
  const namedOnly = parseFirewall({ rules: [{ Name: "Allow ping" }] })
  assert.equal(namedOnly.rules[0]?.name, "Allow ping")
  assert.equal(namedOnly.rules[0]?.direction, "inbound")
  assert.equal(namedOnly.rules[0]?.enabled, true)
  const comStrings = parseFirewall({
    rules: [{ name: "Block SMB", Direction: "2", Action: "0", Enabled: "0", LocalPorts: "445" }],
  })
  assert.equal(comStrings.rules[0]?.direction, "outbound")
  assert.equal(comStrings.rules[0]?.action, "block")
  assert.equal(comStrings.rules[0]?.enabled, false)
  const enveloped = parseFirewall({
    result: { rules: [{ name: "Peer LAN", direction: "inbound", action: "allow", enabled: true, localPorts: "17891" }] },
  })
  assert.equal(enveloped.rules[0]?.name, "Peer LAN")
  assert.equal(resultErrorMessage({ result: { error: "firewall_com_timeout" } }, "failed"), "firewall_com_timeout")
  assert.equal(resultErrorMessage({ error: "timeout", result: { rules: [] } }, "failed"), "timeout")
  assert.match(firewallRuleConfirm("delete", "Peer LAN"), /17891/)
  assert.match(firewallRuleConfirm("set", "Peer LAN"), /INetFwPolicy2/)
})
