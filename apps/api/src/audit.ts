import { prisma } from "@workspace/db"

import { buildAuditRow, type AuditInput } from "./audit-row.js"

export type { AuditInput }
export { buildAuditRow }

export async function appendAudit(input: AuditInput): Promise<void> {
  const row = buildAuditRow(input)
  await prisma.auditLog.create({ data: row })
}

export async function listAudit(limit = 100): Promise<Array<{ id: string; at: Date; actor: string; action: string; deviceId: string | null; detail: string }>> {
  return prisma.auditLog.findMany({
    orderBy: { at: "desc" },
    take: Math.min(Math.max(limit, 1), 200),
  })
}
