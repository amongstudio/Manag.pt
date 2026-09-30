export const FINDING_SOURCES = ["nmap", "nuclei", "trivy", "wua", "posture"] as const
export const FINDING_CATEGORIES = ["port", "service", "cve", "misconfig", "outdated"] as const
export const REMEDIATION_TYPES = ["patch", "config", "uninstall", "upgrade", "manual"] as const

export type FindingDraft = {
  hostIp: string
  hostHostname: string
  hostOs: string
  source: (typeof FINDING_SOURCES)[number]
  category: (typeof FINDING_CATEGORIES)[number]
  severity: string
  title: string
  description: string
  cveId: string
  cvssScore: number | null
  evidence: string
  remediation: string
  remediationType: (typeof REMEDIATION_TYPES)[number]
}

const RISKY_PORTS = new Set([21, 23, 445, 3389, 5900])

export function findingIdentity(row: { hostIp: string; source: string; category: string; title: string; cveId: string }): string {
  return [row.hostIp, row.source, row.category, row.title, row.cveId].join("\u0000")
}

export function nextManualStatus(current: string, action: "acknowledge" | "accept" | "remediate"): string | null {
  if (action === "acknowledge" && current === "open") return "acknowledged"
  if (action === "accept" && (current === "open" || current === "acknowledged")) return "accepted"
  if (action === "remediate" && (current === "open" || current === "acknowledged")) return "remediating"
  return null
}

export function mergeStatus(previous: string | undefined, seen: boolean): string {
  if (!seen) return previous && previous !== "fixed" ? "fixed" : "fixed"
  if (!previous || previous === "fixed") return "open"
  return previous
}

export function cacheFresh(fetchedAt: Date, now = new Date()): boolean {
  return now.getTime() - fetchedAt.getTime() < 30 * 86400_000
}

function draft(partial: Partial<FindingDraft> & Pick<FindingDraft, "hostIp" | "source" | "category" | "severity" | "title">): FindingDraft {
  return {
    hostHostname: "",
    hostOs: "",
    description: "",
    cveId: "",
    cvssScore: null,
    evidence: "",
    remediation: "",
    remediationType: "manual",
    ...partial,
  }
}

export function findingsFromNmap(result: unknown): FindingDraft[] {
  const hosts = hostsOf(result)
  const out: FindingDraft[] = []
  for (const host of hosts) {
    const ip = text(host.ip)
    if (!ip) continue
    for (const port of arrayOf(host.ports)) {
      const number = Number(port.port)
      const protocol = text(port.protocol) || "tcp"
      const state = text(port.state)
      if (state && state !== "open") continue
      const service = text(port.service)
      const product = text(port.product)
      const version = text(port.version)
      out.push(
        draft({
          hostIp: ip,
          hostHostname: text(host.hostname),
          hostOs: text(host.os),
          source: "nmap",
          category: "port",
          severity: RISKY_PORTS.has(number) ? "high" : "info",
          title: `${protocol}/${number} open`,
          description: service ? `${service} is listening` : "Open port",
          evidence: JSON.stringify({ port: number, protocol, service }),
          remediation: RISKY_PORTS.has(number) ? "Restrict this port to authorized management networks." : "",
          remediationType: "config",
        })
      )
      if (service || product) {
        out.push(
          draft({
            hostIp: ip,
            hostHostname: text(host.hostname),
            hostOs: text(host.os),
            source: "nmap",
            category: "service",
            severity: "info",
            title: [service || product, product, version].filter(Boolean).join(" "),
            evidence: JSON.stringify({ port: number, protocol, service, product, version }),
            remediationType: "manual",
          })
        )
      }
      for (const cve of arrayOf(port.cves)) {
        const id = text(cve.id).toUpperCase()
        if (!/^CVE-\d{4}-\d{4,7}$/.test(id)) continue
        const cvss = Number(cve.cvss)
        out.push(
          draft({
            hostIp: ip,
            hostHostname: text(host.hostname),
            hostOs: text(host.os),
            source: "nmap",
            category: "cve",
            severity: cvss >= 9 ? "critical" : cvss >= 7 ? "high" : "medium",
            title: `${id} on ${product || service || protocol + "/" + number}`,
            cveId: id,
            cvssScore: Number.isFinite(cvss) ? cvss : null,
            evidence: JSON.stringify({ port: number, product, version, source: "vulners" }),
            remediation: "Patch or upgrade the service. This record is a version correlation, not an exploit.",
            remediationType: "patch",
          })
        )
      }
    }
  }
  return out
}

export function findingsFromNuclei(result: unknown): FindingDraft[] {
  const rows = Array.isArray(result) ? result : arrayOf((result as { findings?: unknown })?.findings)
  const out: FindingDraft[] = []
  for (const row of rows) {
    const rawTags: unknown[] = Array.isArray(row.tags) ? row.tags : []
    const tags = rawTags.map((tag) => String(tag).toLowerCase())
    if (tags.some((tag) => ["dos", "intrusive", "fuzz", "exploit"].includes(tag))) continue
    const host = text(row.host) || hostFromUrl(text(row.matchedAt))
    if (!host) continue
    const cve = text(row.cve).toUpperCase()
    out.push(
      draft({
        hostIp: host,
        source: "nuclei",
        category: cve ? "cve" : "misconfig",
        severity: text(row.severity) || "medium",
        title: text(row.name) || text(row.templateId) || "nuclei finding",
        description: text(row.description),
        cveId: /^CVE-/.test(cve) ? cve : "",
        cvssScore: Number.isFinite(Number(row.cvss)) ? Number(row.cvss) : null,
        evidence: JSON.stringify({ templateId: text(row.templateId), matchedAt: text(row.matchedAt) }),
        remediation: text(row.remediation),
        remediationType: "config",
      })
    )
  }
  return out
}

export function findingsFromTrivy(hostIp: string, result: unknown): FindingDraft[] {
  const rows = Array.isArray(result) ? result : []
  return rows.flatMap((row) => {
    const rec = row as Record<string, unknown>
    const cve = text(rec.cve).toUpperCase()
    if (!cve) return []
    return [
      draft({
        hostIp,
        source: "trivy",
        category: "cve",
        severity: text(rec.severity) || "medium",
        title: text(rec.title) || cve,
        cveId: cve,
        evidence: JSON.stringify({ package: text(rec.package), version: text(rec.version) }),
        remediation: "Upgrade the package.",
        remediationType: "upgrade",
      }),
    ]
  })
}

function hostsOf(result: unknown): Array<Record<string, unknown>> {
  if (!result || typeof result !== "object") return []
  const hosts = (result as { hosts?: unknown }).hosts
  return arrayOf(hosts)
}

function arrayOf(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function hostFromUrl(raw: string): string {
  try {
    return new URL(raw).hostname
  } catch {
    return raw
  }
}

export function versionLess(installed: string, floor: string): boolean {
  const left = parts(installed)
  const right = parts(floor)
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i++) {
    const a = left[i] ?? 0
    const b = right[i] ?? 0
    if (a < b) return true
    if (a > b) return false
  }
  return false
}

function parts(value: string): number[] {
  return value
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item))
}
