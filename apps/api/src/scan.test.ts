import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"

import { authorizeTarget, parseScanScope } from "./scan-scope.ts"
import { cacheFresh, findingsFromNmap, findingsFromNuclei, mergeStatus, versionLess } from "./findings-lib.ts"
import { parseSoftwareRules, postureFindings } from "./posture-lib.ts"

const scopeText = fs.readFileSync(new URL("../../../config/scan-scope.yaml", import.meta.url), "utf8")

test("authorizeTarget refuses public, excluded, and lab LAN", () => {
  const scope = parseScanScope(scopeText)
  assert.equal(scope.labMode, true)
  assert.equal(authorizeTarget("8.8.8.8", scope).ok, false)
  assert.equal(authorizeTarget("192.168.1.10", scope).ok, false)
  assert.equal(authorizeTarget("127.0.0.1", scope).ok, true)
  const excluded = { ...scope, excludedHosts: ["127.0.0.1"] }
  assert.equal(authorizeTarget("127.0.0.1", excluded).ok, false)
  if (!authorizeTarget("127.0.0.1", excluded).ok) {
    assert.equal(authorizeTarget("127.0.0.1", excluded).error, "target_excluded")
  }
  const owned = { ...scope, labMode: false, authorizedNetworks: ["192.168.1.0/24"], excludedHosts: ["192.168.1.10"] }
  assert.equal(authorizeTarget("192.168.1.20", owned).ok, true)
  assert.equal(authorizeTarget("192.168.1.10", owned).ok, false)
  assert.equal(authorizeTarget("1.2.3.4", { ...scope, labMode: false, authorizedNetworks: [] }).ok, false)
})

test("nmap and nuclei fixtures become findings", () => {
  const nmap = findingsFromNmap({
    hosts: [
      {
        ip: "127.0.0.1",
        hostname: "localhost",
        os: "Linux 6.1",
        ports: [
          { protocol: "tcp", port: 3389, state: "open", service: "ms-wbt-server", cves: [{ id: "CVE-2023-38408", cvss: 9.8 }] },
          { protocol: "tcp", port: 80, state: "closed", service: "http" },
        ],
      },
    ],
  })
  assert.equal(nmap.some((row) => row.category === "port" && row.title === "tcp/3389 open" && row.severity === "high"), true)
  assert.equal(nmap.some((row) => row.category === "cve" && row.cveId === "CVE-2023-38408"), true)
  assert.equal(nmap.some((row) => row.title.includes("80")), false)
  const nuclei = findingsFromNuclei({
    findings: [
      { templateId: "tls-version", name: "Weak TLS", severity: "medium", matchedAt: "https://127.0.0.1", host: "127.0.0.1", tags: ["ssl"] },
      { templateId: "boom", name: "DoS", severity: "critical", host: "127.0.0.1", tags: ["dos"] },
    ],
  })
  assert.equal(nuclei.length, 1)
  assert.match(nuclei[0]!.evidence, /tls-version/)
})

test("repeat findings keep acknowledgement and missing ones close", () => {
  assert.equal(mergeStatus("acknowledged", true), "acknowledged")
  assert.equal(mergeStatus("fixed", true), "open")
  assert.equal(mergeStatus("accepted", false), "fixed")
  assert.equal(mergeStatus(undefined, true), "open")
  assert.equal(cacheFresh(new Date(Date.now() - 2 * 86400_000)), true)
  assert.equal(cacheFresh(new Date(Date.now() - 40 * 86400_000)), false)
})

test("posture uses existing signals only", () => {
  const rules = parseSoftwareRules("rules:\n  - name: curl\n    below: '8.0.0'\n    severity: high\n    title: old curl\n")
  const rows = postureFindings({
    hostIp: "10.0.0.5",
    defender: { realtimeProtectionEnabled: false },
    firewall: { profiles: [{ name: "private", enabled: false }] },
    bitlocker: { available: true, volumes: [{ protectionStatus: "off" }] },
    updates: [{ kb: "KB1", title: "Cumulative", severity: "Critical", approval: "pending" }],
    software: [{ name: "curl", version: "7.88.1" }],
    rules,
    hostPosture: { autologon: true, smbv1: false },
  })
  const titles = rows.map((row) => row.title)
  assert.ok(titles.includes("Defender real-time protection disabled"))
  assert.ok(titles.includes("Windows Firewall profile disabled"))
  assert.ok(titles.includes("BitLocker protection off"))
  assert.ok(titles.includes("Cumulative"))
  assert.ok(titles.includes("old curl"))
  assert.ok(titles.includes("Automatic logon configured"))
  assert.equal(titles.includes("SMBv1 enabled"), false)
  assert.equal(versionLess("7.88.1", "8.0.0"), true)
  assert.equal(versionLess("8.5.0", "8.0.0"), false)
})
