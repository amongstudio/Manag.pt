import nodemailer from "nodemailer"
import type { FastifyInstance } from "fastify"

import { prisma } from "@workspace/db"
import { APP_NAME, WS_EVENTS, type AppSettings } from "@workspace/shared"

import { emitFleet } from "./io-emit.js"
import { getSettings } from "./settings.js"

export type AlertType =
  | "device_online"
  | "device_offline"
  | "high_cpu"
  | "high_memory"
  | "disk_space_low"
  | "command_failure"
  | "kill_switch"
  | "heartbeat_missed"

const NOTIFY_FLAGS: Record<AlertType, keyof AppSettings["telegram"]> = {
  device_online: "notifyOnline",
  device_offline: "notifyOffline",
  high_cpu: "notifyHighCpu",
  high_memory: "notifyHighMemory",
  disk_space_low: "notifyDiskLow",
  command_failure: "notifyCommandFailure",
  kill_switch: "notifyKillSwitch",
  heartbeat_missed: "notifyHeartbeatMissed",
}

export function shouldNotify(settings: AppSettings, type: AlertType): boolean {
  return Boolean(settings.telegram[NOTIFY_FLAGS[type]])
}

export function escapeTelegramHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

async function sendTelegram(settings: AppSettings, text: string): Promise<void> {
  if (!settings.telegram.enabled || !settings.telegram.botToken || !settings.telegram.chatId) {
    throw new Error("telegram disabled")
  }
  const url = `https://api.telegram.org/bot${settings.telegram.botToken}/sendMessage`
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ chat_id: settings.telegram.chatId, text, parse_mode: "HTML" }),
  })
  if (!res.ok) throw new Error(`telegram ${res.status}`)
}

async function sendDiscord(settings: AppSettings, title: string, body: string): Promise<void> {
  if (!settings.discord.enabled || !settings.discord.webhookUrl) {
    throw new Error("discord disabled")
  }
  const res = await fetch(settings.discord.webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      username: settings.discord.username || APP_NAME,
      embeds: [{ title, description: body, timestamp: new Date().toISOString() }],
    }),
  })
  if (!res.ok) throw new Error(`discord ${res.status}`)
}

let smtpTransport: nodemailer.Transporter | null = null
let smtpKey = ""

function smtpTransportFor(settings: AppSettings) {
  const key = JSON.stringify({
    host: settings.smtp.host,
    port: settings.smtp.port,
    user: settings.smtp.username,
    pass: settings.smtp.password,
  })
  if (smtpTransport && smtpKey === key) return smtpTransport
  smtpTransport?.close()
  smtpTransport = nodemailer.createTransport({
    host: settings.smtp.host,
    port: settings.smtp.port,
    secure: settings.smtp.port === 465,
    auth:
      settings.smtp.username && settings.smtp.password
        ? { user: settings.smtp.username, pass: settings.smtp.password }
        : undefined,
  })
  smtpKey = key
  return smtpTransport
}

async function sendSmtp(settings: AppSettings, title: string, body: string): Promise<void> {
  if (!settings.smtp.enabled || !settings.smtp.host || settings.smtp.adminEmails.length === 0) {
    throw new Error("smtp disabled")
  }
  const transport = smtpTransportFor(settings)
  await transport.sendMail({
    from: `"${settings.smtp.fromName}" <${settings.smtp.fromEmail || settings.smtp.username}>`,
    to: settings.smtp.adminEmails.join(","),
    subject: title,
    text: body,
  })
}

export async function enqueueAlert(
  app: FastifyInstance | undefined,
  input: {
    type: AlertType
    title: string
    body: string
    deviceId?: string
  }
): Promise<boolean> {
  const settings = await getSettings()
  if (!shouldNotify(settings, input.type)) return false
  const cooldownSec = Number.isFinite(settings.thresholds.alertCooldownSec)
    ? settings.thresholds.alertCooldownSec
    : 1800
  const since = new Date(Date.now() - cooldownSec * 1000)
  const recent = await prisma.notification.findFirst({
    where: {
      deviceId: input.deviceId ?? null,
      type: input.type,
      createdAt: { gte: since },
    },
  })
  if (recent) return false

  const channels: Array<"telegram" | "discord" | "smtp"> = []
  if (settings.telegram.enabled) channels.push("telegram")
  if (settings.discord.enabled) channels.push("discord")
  if (settings.smtp.enabled) channels.push("smtp")
  // Always persist a socket row so the dashboard alert fires even with no
  // outbound channel configured.
  await prisma.notification.createMany({
    data: [
      {
        deviceId: input.deviceId,
        channel: "socket",
        type: input.type,
        title: input.title,
        body: input.body,
        status: "sent",
        sentAt: new Date(),
      },
      ...channels.map((channel) => ({
        deviceId: input.deviceId,
        channel,
        type: input.type,
        title: input.title,
        body: input.body,
      })),
    ],
  })
  if (app) {
    emitFleet(app, WS_EVENTS.ALERT, {
      type: input.type,
      title: input.title,
      body: input.body,
      deviceId: input.deviceId,
    })
  }
  return true
}

const LEASE_MS = 90_000

export async function flushNotifications(): Promise<void> {
  const settings = await getSettings()
  const stale = new Date(Date.now() - LEASE_MS)
  // A slow send used to leave rows pending with an expired lease, so the next
  // tick claimed them again and delivered the same alert twice.
  await prisma.notification.updateMany({
    where: { status: "sending", leasedAt: { lt: stale } },
    data: { status: "pending", leasedAt: null },
  })
  const claimed = await prisma.$transaction(async (tx) => {
    const pending = await tx.notification.findMany({
      where: {
        status: "pending",
        channel: { not: "socket" },
      },
      take: 20,
      orderBy: { createdAt: "asc" },
    })
    if (pending.length === 0) return []
    const now = new Date()
    const owned: typeof pending = []
    for (const row of pending) {
      const updated = await tx.notification.updateMany({
        where: { id: row.id, status: "pending" },
        data: { status: "sending", leasedAt: now },
      })
      if (updated.count === 1) owned.push(row)
    }
    return owned
  })

  for (const row of claimed) {
    try {
      if (row.channel === "telegram") {
        await sendTelegram(settings, `<b>${escapeTelegramHtml(row.title)}</b>\n${escapeTelegramHtml(row.body)}`)
      } else if (row.channel === "discord") {
        await sendDiscord(settings, row.title, row.body)
      } else if (row.channel === "smtp") {
        await sendSmtp(settings, row.title, row.body)
      } else {
        await prisma.notification.updateMany({
          where: { id: row.id, status: "sending" },
          data: { status: "failed", lastError: "unsupported channel", leasedAt: null, attempts: { increment: 1 } },
        })
        continue
      }
      await prisma.notification.updateMany({
        where: { id: row.id, status: "sending" },
        data: { status: "sent", sentAt: new Date(), attempts: { increment: 1 }, leasedAt: null },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : "send failed"
      const attempts = row.attempts + 1
      await prisma.notification.updateMany({
        where: { id: row.id, status: "sending" },
        data: {
          attempts,
          lastError: message,
          leasedAt: null,
          status: attempts >= 5 ? "failed" : "pending",
        },
      })
    }
  }
}
