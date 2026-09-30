import fs from "node:fs"

import { prisma } from "@workspace/db"

import { appendAudit } from "./audit.js"
import { findingIdentity, findingsFromNmap, findingsFromNuclei, mergeStatus, type FindingDraft } from "./findings-lib.js"
import { parseSoftwareRules, postureFindings, type SoftwareRule } from "./posture-lib.js"

export async function upsertFindings(input: {
  scanId: string
  deviceId?: string | null
  drafts: FindingDraft[]
  scriptId?: string | null
}): Promise<number> {
  const seen = new Set<string>()
  for (const draft of input.drafts) {
    const key = findingIdentity(draft)
    if (seen.has(key)) continue
    seen.add(key)
    const existing = await prisma.finding.findUnique({
      where: {
        hostIp_source_category_title_cveId: {
          hostIp: draft.hostIp,
          source: draft.source,
          category: draft.category,
          title: draft.title,
          cveId: draft.cveId,
        },
      },
    })
    const status = mergeStatus(existing?.status, true)
    const data = {
      scanId: input.scanId,
      deviceId: input.deviceId ?? existing?.deviceId ?? null,
      hostHostname: draft.hostHostname,
      hostOs: draft.hostOs,
      severity: draft.severity,
      description: draft.description,
      cvssScore: draft.cvssScore,
      evidence: draft.evidence,
      remediation: draft.remediation,
      remediationType: draft.remediationType,
      scriptId: input.scriptId ?? existing?.scriptId ?? null,
      status,
      lastSeen: new Date(),
    }
    if (!existing) {
      await prisma.finding.create({
        data: {
          ...data,
          hostIp: draft.hostIp,
          source: draft.source,
          category: draft.category,
          title: draft.title,
          cveId: draft.cveId,
        },
      })
    } else {
      await prisma.finding.update({ where: { id: existing.id }, data })
    }
    if (draft.category === "cve" && draft.cveId) {
      const evidence = parseEvidence(draft.evidence)
      const product = typeof evidence.product === "string" ? evidence.product : typeof evidence.package === "string" ? evidence.package : ""
      const version = typeof evidence.version === "string" ? evidence.version : ""
      if (product && version) {
        await prisma.cveCache.upsert({
          where: { product_version: { product, version } },
          create: { product, version, payload: JSON.stringify({ cveId: draft.cveId, cvss: draft.cvssScore }) },
          update: { payload: JSON.stringify({ cveId: draft.cveId, cvss: draft.cvssScore }), fetchedAt: new Date() },
        })
      }
    }
  }
  const hostIps = [...new Set(input.drafts.map((draft) => draft.hostIp))]
  const sources = [...new Set(input.drafts.map((draft) => draft.source))]
  if (hostIps.length && sources.length) {
    const current = await prisma.finding.findMany({
      where: { hostIp: { in: hostIps }, source: { in: sources }, status: { not: "fixed" } },
    })
    for (const row of current) {
      if (seen.has(findingIdentity(row))) continue
      await prisma.finding.update({ where: { id: row.id }, data: { status: mergeStatus(row.status, false), scanId: input.scanId } })
    }
  }
  return seen.size
}

export async function finishScan(input: {
  scanId: string
  deviceId?: string | null
  status: string
  result: unknown
  kind: string
  scriptId?: string | null
  rules?: SoftwareRule[]
}): Promise<void> {
  const record = input.result && typeof input.result === "object" ? (input.result as Record<string, unknown>) : {}
  let drafts: FindingDraft[] = []
  let summary = ""
  if (typeof record.error === "string") {
    summary = record.error
  } else if (input.kind === "network_scan") {
    drafts = findingsFromNmap(record)
    summary = `${drafts.length} findings`
  } else if (input.kind === "nuclei_scan") {
    drafts = findingsFromNuclei(record)
    summary = `${drafts.length} findings`
  } else if (input.kind === "host_posture") {
    const stored = await storedPosture(input.deviceId ?? null)
    drafts = postureFindings({
      hostIp: input.deviceId || "device",
      ...stored,
      rules: input.rules ?? stored.rules,
      hostPosture: record as { autologon?: boolean; smbv1?: boolean; trivy?: string; findings?: unknown },
    })
    summary = record.trivy === "unavailable" ? `trivy_unavailable; ${drafts.length} findings` : `${drafts.length} findings`
    if (typeof record.error === "string" && drafts.length) summary = `${record.error}; ${summary}`
  }
  if (input.status === "success") {
    await upsertFindings({ scanId: input.scanId, deviceId: input.deviceId, drafts, scriptId: input.scriptId })
  }
  await prisma.scan.update({
    where: { id: input.scanId },
    data: { status: input.status === "success" ? "success" : "failed", summary, finishedAt: new Date() },
  })
  await appendAudit({
    actor: "operator",
    action: "scan_end",
    deviceId: input.deviceId,
    detail: { scanId: input.scanId, kind: input.kind, status: input.status, summary },
  })
}

export async function storedPosture(deviceId: string | null): Promise<{
  defender?: unknown
  firewall?: unknown
  bitlocker?: unknown
  updates: Array<{ kb?: string; title?: string; severity?: string; approval?: string }>
  software: Array<{ name: string; version: string }>
  rules: SoftwareRule[]
}> {
  const empty = { updates: [], software: [], rules: [] as SoftwareRule[] }
  if (!deviceId) return empty
  const commands = await prisma.command.findMany({
    where: { deviceId, status: "success", type: { in: ["get_defender", "get_firewall", "get_bitlocker"] } },
    orderBy: { createdAt: "desc" },
    take: 40,
  })
  const latest = (type: string) => {
    const row = commands.find((command) => command.type === type)
    if (!row?.result) return undefined
    try {
      return JSON.parse(row.result) as unknown
    } catch {
      return undefined
    }
  }
  const updates = await prisma.windowsUpdate.findMany({ where: { deviceId, approval: "pending" }, take: 200 })
  const installs = await prisma.softwareInstallation.findMany({
    where: { deviceId },
    orderBy: { collectedAt: "desc" },
    take: 400,
    include: { software: true },
  })
  const newest = installs[0]?.collectedAt.getTime()
  return {
    defender: latest("get_defender"),
    firewall: latest("get_firewall"),
    bitlocker: latest("get_bitlocker"),
    updates: updates.map((row) => ({ kb: row.kb, title: row.title, severity: row.severity, approval: row.approval })),
    software: installs
      .filter((row) => !newest || row.collectedAt.getTime() === newest)
      .map((row) => ({ name: row.software.name, version: row.software.version })),
    rules: softwareRules(),
  }
}

let softwareRulesOverride: string | null = null

export function setSoftwareRulesOverride(text: string | null): void {
  softwareRulesOverride = text
}

function softwareRules(): SoftwareRule[] {
  if (softwareRulesOverride != null) return parseSoftwareRules(softwareRulesOverride)
  for (const candidate of ["config/software-rules.yaml", "../../config/software-rules.yaml"]) {
    try {
      return parseSoftwareRules(fs.readFileSync(candidate, "utf8"))
    } catch {
      /* next */
    }
  }
  return []
}

function parseEvidence(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
