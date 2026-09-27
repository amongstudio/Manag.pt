import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { prisma } from "@workspace/db"
import { API_PREFIX } from "@workspace/shared"

import {
  CHAT_MESSAGE_MAX,
  confirmCopilotTool,
  runCopilotTurn,
  serializeChatMessage,
  serializeChatThread,
} from "./chat.js"
import { errorBody } from "./lib.js"

const createThreadSchema = z.object({
  title: z.string().min(1).max(120).optional(),
})

const postMessageSchema = z.object({
  content: z.string().min(1).max(CHAT_MESSAGE_MAX),
})

const confirmSchema = z.object({
  toolCallId: z.string().min(1).max(128),
  confirmed: z.boolean(),
})

async function loadDeviceThread(deviceId: string, threadId: string) {
  const device = await prisma.device.findUnique({ where: { id: deviceId } })
  if (!device) return { error: "not_found" as const, status: 404 as const }
  const thread = await prisma.chatThread.findFirst({
    where: { id: threadId, deviceId },
  })
  if (!thread) return { error: "not_found" as const, status: 404 as const, device }
  return { device, thread }
}

export async function registerChatRoutes(app: FastifyInstance): Promise<void> {
  app.get(`${API_PREFIX}/admin/devices/:id/chats`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const device = await prisma.device.findUnique({ where: { id }, select: { id: true } })
    if (!device) return reply.code(404).send(errorBody("not_found"))
    const threads = await prisma.chatThread.findMany({
      where: { deviceId: id },
      orderBy: { updatedAt: "desc" },
      take: 50,
    })
    return { threads: threads.map(serializeChatThread) }
  })

  app.post(`${API_PREFIX}/admin/devices/:id/chats`, async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = createThreadSchema.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send(errorBody("invalid_body", parsed.error.flatten()))
    const device = await prisma.device.findUnique({ where: { id }, select: { id: true } })
    if (!device) return reply.code(404).send(errorBody("not_found"))
    const thread = await prisma.chatThread.create({
      data: { deviceId: id, title: parsed.data.title ?? "New chat" },
    })
    return { thread: serializeChatThread(thread), messages: [] }
  })

  app.get(`${API_PREFIX}/admin/devices/:id/chats/:threadId`, async (req, reply) => {
    const { id, threadId } = req.params as { id: string; threadId: string }
    const loaded = await loadDeviceThread(id, threadId)
    if ("error" in loaded && !("thread" in loaded)) {
      return reply.code(loaded.status).send(errorBody(loaded.error))
    }
    if (!("thread" in loaded) || !loaded.thread) {
      return reply.code(404).send(errorBody("not_found"))
    }
    const messages = await prisma.chatMessage.findMany({
      where: { threadId },
      orderBy: { createdAt: "asc" },
      take: 200,
    })
    return {
      thread: serializeChatThread(loaded.thread),
      messages: messages.map(serializeChatMessage),
    }
  })

  app.post(`${API_PREFIX}/admin/devices/:id/chats/:threadId/messages`, async (req, reply) => {
    const { id, threadId } = req.params as { id: string; threadId: string }
    const parsed = postMessageSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send(errorBody("invalid_body", parsed.error.flatten()))
    const loaded = await loadDeviceThread(id, threadId)
    if (!("thread" in loaded) || !loaded.thread) {
      return reply.code(loaded.status ?? 404).send(errorBody(loaded.error ?? "not_found"))
    }
    const result = await runCopilotTurn(app, loaded.device, threadId, parsed.data.content)
    return reply.code(result.status).send(result.body)
  })

  app.post(`${API_PREFIX}/admin/devices/:id/chats/:threadId/confirm`, async (req, reply) => {
    const { id, threadId } = req.params as { id: string; threadId: string }
    const parsed = confirmSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send(errorBody("invalid_body", parsed.error.flatten()))
    const loaded = await loadDeviceThread(id, threadId)
    if (!("thread" in loaded) || !loaded.thread) {
      return reply.code(loaded.status ?? 404).send(errorBody(loaded.error ?? "not_found"))
    }
    const result = await confirmCopilotTool(
      app,
      loaded.device,
      threadId,
      parsed.data.toolCallId,
      parsed.data.confirmed
    )
    return reply.code(result.status).send(result.body)
  })
}
