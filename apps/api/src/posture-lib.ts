import yaml from "js-yaml"

import { findingsFromTrivy, versionLess, type FindingDraft } from "./findings-lib.js"

export type SoftwareRule = {
  name: string
  below: string
  severity: string
  title: string
  remediation: string
  remediationType: FindingDraft["remediationType"]
}

export function parseSoftwareRules(text: string): SoftwareRule[] {
  let parsed: unknown
  try {
    parsed = yaml.load(text)
  } catch {
    return []
  }
  const rules = parsed && typeof parsed === "object" ? (parsed as { rules?: unknown }).rules : null
  if (!Array.isArray(rules)) return []
  const out: SoftwareRule[] = []
  for (const item of rules) {
    if (!item || typeof item !== "object") continue
    const row = item as Record<string, unknown>
    const name = typeof row.name === "string" ? row.name.trim() : ""
    const below = typeof row.below === "string" ? row.below.trim() : ""
    if (!name || !below) continue
    const remediationType = row.remediationType
    out.push({
      name,
      below,
      severity: typeof row.severity === "string" ? row.severity : "medium",
      title: typeof row.title === "string" ? row.title : `${name} older than ${below}`,
      remediation: typeof row.remediation === "string" ? row.remediation : "Upgrade the package.",
      remediationType:
        remediationType === "patch" || remediationType === "config" || remediationType === "uninstall" || remediationType === "upgrade"
          ? remediationType
          : "upgrade",
    })
  }
  return out
}

export function postureFindings(input: {
  hostIp: string
  defender?: unknown
  firewall?: unknown
  bitlocker?: unknown
  updates?: Array<{ kb?: string; title?: string; severity?: string; approval?: string }>
  software?: Array<{ name: string; version: string }>
  rules?: SoftwareRule[]
  hostPosture?: { autologon?: boolean; smbv1?: boolean; trivy?: string; findings?: unknown }
}): FindingDraft[] {
  const hostIp = input.hostIp || "device"
  const out: FindingDraft[] = []
  const defender = record(input.defender)
  if (defender && defender.realtimeProtectionEnabled === false) {
    out.push(misconfig(hostIp, "high", "Defender real-time protection disabled", "Turn real-time protection back on.", "config"))
  }
  const firewall = record(input.firewall)
  const profiles = Array.isArray(firewall?.profiles) ? firewall.profiles : []
  if (profiles.some((profile) => record(profile)?.enabled === false)) {
    out.push(misconfig(hostIp, "high", "Windows Firewall profile disabled", "Enable the firewall profile.", "config"))
  }
  const bitlocker = record(input.bitlocker)
  const volumes = Array.isArray(bitlocker?.volumes) ? bitlocker.volumes : []
  if (bitlocker?.available !== false && volumes.some((volume) => record(volume)?.protectionStatus === "off")) {
    out.push(misconfig(hostIp, "high", "BitLocker protection off", "Enable BitLocker on the volume.", "config"))
  }
  for (const update of input.updates ?? []) {
    const severity = (update.severity ?? "").toLowerCase()
    if (update.approval !== "pending") continue
    if (severity !== "high" && severity !== "critical") continue
    out.push({
      hostIp,
      hostHostname: "",
      hostOs: "",
      source: "wua",
      category: "outdated",
      severity,
      title: update.title || update.kb || "Pending Windows update",
      description: "Pending high or critical Windows update.",
      cveId: "",
      cvssScore: null,
      evidence: JSON.stringify({ kb: update.kb ?? "", approval: "pending" }),
      remediation: "Approve the update and install it in a maintenance window.",
      remediationType: "patch",
    })
  }
  for (const rule of input.rules ?? []) {
    for (const item of input.software ?? []) {
      if (item.name.toLowerCase() !== rule.name.toLowerCase()) continue
      if (!versionLess(item.version, rule.below)) continue
      out.push({
        hostIp,
        hostHostname: "",
        hostOs: "",
        source: "posture",
        category: "outdated",
        severity: rule.severity,
        title: rule.title,
        description: `${item.name} ${item.version} is below ${rule.below}`,
        cveId: "",
        cvssScore: null,
        evidence: JSON.stringify({ name: item.name, version: item.version, below: rule.below }),
        remediation: rule.remediation,
        remediationType: rule.remediationType,
      })
    }
  }
  if (input.hostPosture?.autologon === true) {
    out.push(misconfig(hostIp, "high", "Automatic logon configured", "Clear AutoAdminLogon in Winlogon.", "config"))
  }
  if (input.hostPosture?.smbv1 === true) {
    out.push(misconfig(hostIp, "high", "SMBv1 enabled", "Disable the SMB1 LanmanServer parameter.", "config"))
  }
  out.push(...findingsFromTrivy(hostIp, input.hostPosture?.findings))
  return out
}

function misconfig(hostIp: string, severity: string, title: string, remediation: string, remediationType: FindingDraft["remediationType"]): FindingDraft {
  return {
    hostIp,
    hostHostname: "",
    hostOs: "",
    source: "posture",
    category: "misconfig",
    severity,
    title,
    description: title,
    cveId: "",
    cvssScore: null,
    evidence: "{}",
    remediation,
    remediationType,
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}
