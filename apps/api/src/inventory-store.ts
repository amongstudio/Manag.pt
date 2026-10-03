import { Prisma, prisma } from "@workspace/db"

import { normalizeInventory, type InventoryReport } from "./inventory-lib.js"

const HISTORY = 5

function big(value: number): bigint {
  if (!Number.isFinite(value) || value < 0) return 0n
  return BigInt(Math.floor(value))
}

function dateOrNull(value: string): Date | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

async function keepRecent(
  tx: Prisma.TransactionClient,
  table: "OperatingSystem" | "SoftwareInstallation",
  deviceId: string
): Promise<void> {
  await tx.$executeRawUnsafe(
    `DELETE FROM "${table}" WHERE deviceId = ? AND collectedAt NOT IN (
      SELECT collectedAt FROM "${table}" WHERE deviceId = ? GROUP BY collectedAt ORDER BY collectedAt DESC LIMIT ${HISTORY}
    )`,
    deviceId,
    deviceId
  )
}

export async function upsertInventory(deviceId: string, raw: unknown): Promise<boolean> {
  const report = normalizeInventory(raw)
  if (!report) return false
  const collectedAt = new Date()
  await prisma.$transaction(async (tx) => {
    await tx.hardwareAsset.upsert({
      where: { deviceId },
      create: { deviceId, ...report.hardware, collectedAt },
      update: { ...report.hardware, collectedAt },
    })
    if (report.os.name || report.os.version || report.os.hostname) {
      const { bootTime, ...os } = report.os
      await tx.operatingSystem.create({
        data: { deviceId, ...os, uptimeSec: Math.floor(os.uptimeSec), bootTime: dateOrNull(bootTime), collectedAt },
      })
      await keepRecent(tx, "OperatingSystem", deviceId)
    }
    await tx.cpu.deleteMany({ where: { deviceId } })
    if (report.cpus.length) await tx.cpu.createMany({ data: report.cpus.map((row) => ({ deviceId, ...row, collectedAt })) })
    await tx.memoryModule.deleteMany({ where: { deviceId } })
    if (report.memory.length) {
      await tx.memoryModule.createMany({
        data: report.memory.map((row) => ({ deviceId, ...row, sizeBytes: big(row.sizeBytes), collectedAt })),
      })
    }
    await tx.disk.deleteMany({ where: { deviceId } })
    if (report.disks.length) {
      await tx.disk.createMany({
        data: report.disks.map((row) => ({ deviceId, ...row, sizeBytes: big(row.sizeBytes), collectedAt })),
      })
    }
    await tx.volume.deleteMany({ where: { deviceId } })
    if (report.volumes.length) {
      await tx.volume.createMany({
        data: report.volumes.map((row) => ({
          deviceId,
          mount: row.mount,
          fs: row.fs,
          sizeBytes: big(row.sizeBytes),
          freeBytes: big(row.freeBytes),
          collectedAt,
        })),
      })
    }
    await tx.gpu.deleteMany({ where: { deviceId } })
    if (report.gpus.length) {
      await tx.gpu.createMany({
        data: report.gpus.map((row) => ({ deviceId, name: row.name, driver: row.driver, memoryBytes: big(row.memoryBytes), collectedAt })),
      })
    }
    await tx.networkAdapter.deleteMany({ where: { deviceId } })
    if (report.adapters.length) {
      await tx.networkAdapter.createMany({
        data: report.adapters.map((row) => ({ deviceId, name: row.name, mac: row.mac, ips: JSON.stringify(row.ips), collectedAt })),
      })
    }
    await tx.monitor.deleteMany({ where: { deviceId } })
    if (report.monitors.length) await tx.monitor.createMany({ data: report.monitors.map((row) => ({ deviceId, ...row, collectedAt })) })
    await tx.printer.deleteMany({ where: { deviceId } })
    if (report.printers.length) await tx.printer.createMany({ data: report.printers.map((row) => ({ deviceId, ...row, collectedAt })) })
    await tx.usbDevice.deleteMany({ where: { deviceId } })
    if (report.usb.length) await tx.usbDevice.createMany({ data: report.usb.map((row) => ({ deviceId, ...row, collectedAt })) })
    await tx.driver.deleteMany({ where: { deviceId } })
    if (report.drivers.length) await tx.driver.createMany({ data: report.drivers.map((row) => ({ deviceId, ...row, collectedAt })) })
    await tx.certificate.deleteMany({ where: { deviceId } })
    if (report.certificates.length) {
      await tx.certificate.createMany({
        data: report.certificates.map((row) => ({
          deviceId,
          subject: row.subject,
          issuer: row.issuer,
          thumbprint: row.thumbprint,
          store: row.store,
          notAfter: dateOrNull(row.notAfter),
          collectedAt,
        })),
      })
    }
    await tx.service.deleteMany({ where: { deviceId } })
    if (report.services.length) await tx.service.createMany({ data: report.services.map((row) => ({ deviceId, ...row, collectedAt })) })
    await tx.startupItem.deleteMany({ where: { deviceId } })
    if (report.startup.length) await tx.startupItem.createMany({ data: report.startup.map((row) => ({ deviceId, ...row, collectedAt })) })
    await tx.browser.deleteMany({ where: { deviceId } })
    if (report.browsers.length) await tx.browser.createMany({ data: report.browsers.map((row) => ({ deviceId, ...row, collectedAt })) })
    await tx.userProfile.deleteMany({ where: { deviceId } })
    if (report.users.length) await tx.userProfile.createMany({ data: report.users.map((row) => ({ deviceId, ...row, collectedAt })) })
    const snapshot = await tx.processSnapshot.create({
      data: {
        deviceId,
        collectedAt,
        processes: {
          create: report.processes.map((row) => ({
            pid: Math.floor(row.pid),
            name: row.name,
            userName: row.userName,
            cpu: row.cpu,
            ram: row.ram,
            rssBytes: big(row.rssBytes),
          })),
        },
      },
    })
    await tx.processSnapshot.deleteMany({ where: { deviceId, id: { not: snapshot.id } } })
    for (const item of report.software) {
      const software = await tx.software.upsert({
        where: { name_version_publisher: { name: item.name, version: item.version, publisher: item.publisher } },
        create: { name: item.name, version: item.version, publisher: item.publisher },
        update: {},
      })
      await tx.softwareInstallation.create({
        data: {
          deviceId,
          softwareId: software.id,
          source: item.source,
          installDate: item.installDate,
          installPath: item.installPath,
          collectedAt,
        },
      })
    }
    if (report.software.length) await keepRecent(tx, "SoftwareInstallation", deviceId)
    for (const item of report.updates) {
      await tx.windowsUpdate.upsert({
        where: { deviceId_kb_title: { deviceId, kb: item.kb, title: item.title } },
        create: {
          deviceId,
          kb: item.kb,
          title: item.title,
          severity: item.severity,
          sizeBytes: Math.min(Math.floor(item.sizeBytes), 2_000_000_000),
          collectedAt,
        },
        update: {
          severity: item.severity,
          sizeBytes: Math.min(Math.floor(item.sizeBytes), 2_000_000_000),
          collectedAt,
        },
      })
    }
  })
  return true
}

export function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item))) as T
}

export async function deviceInventory(deviceId: string) {
  const [hardware, os, cpus, memory, disks, volumes, gpus, adapters, monitors, printers, usb, drivers, certificates, services, startup, browsers, users, processes, software] =
    await Promise.all([
      prisma.hardwareAsset.findUnique({ where: { deviceId } }),
      prisma.operatingSystem.findFirst({ where: { deviceId }, orderBy: { collectedAt: "desc" } }),
      prisma.cpu.findMany({ where: { deviceId } }),
      prisma.memoryModule.findMany({ where: { deviceId } }),
      prisma.disk.findMany({ where: { deviceId } }),
      prisma.volume.findMany({ where: { deviceId } }),
      prisma.gpu.findMany({ where: { deviceId } }),
      prisma.networkAdapter.findMany({ where: { deviceId } }),
      prisma.monitor.findMany({ where: { deviceId } }),
      prisma.printer.findMany({ where: { deviceId } }),
      prisma.usbDevice.findMany({ where: { deviceId } }),
      prisma.driver.findMany({ where: { deviceId } }),
      prisma.certificate.findMany({ where: { deviceId } }),
      prisma.service.findMany({ where: { deviceId }, orderBy: { name: "asc" }, take: 300 }),
      prisma.startupItem.findMany({ where: { deviceId } }),
      prisma.browser.findMany({ where: { deviceId } }),
      prisma.userProfile.findMany({ where: { deviceId }, orderBy: { name: "asc" } }),
      prisma.processSnapshot.findFirst({ where: { deviceId }, orderBy: { collectedAt: "desc" }, include: { processes: true } }),
      prisma.softwareInstallation.findMany({
        where: { deviceId },
        orderBy: { collectedAt: "desc" },
        take: 400,
        include: { software: true },
      }),
    ])
  const latestSoftwareAt = software[0]?.collectedAt.getTime()
  return jsonSafe({
    hardware,
    os,
    cpus,
    memory,
    disks,
    volumes,
    gpus,
    adapters,
    monitors,
    printers,
    usb,
    drivers,
    certificates,
    services,
    startup,
    browsers,
    users,
    processes: processes?.processes ?? [],
    processSnapshotId: processes?.id ?? null,
    software: software
      .filter((row) => !latestSoftwareAt || row.collectedAt.getTime() === latestSoftwareAt)
      .map((row) => ({
        ...row.software,
        source: row.source,
        installDate: row.installDate,
        installPath: row.installPath,
        collectedAt: row.collectedAt,
      })),
  })
}

export type { InventoryReport }
