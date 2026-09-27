import type { FastifyInstance } from "fastify"
import { prisma, type ChatMessage, type Device } from "@workspace/db"
import {
  WS_EVENTS,
  copilotToolNeedsConfirm,
  isCommandTerminal,
  isCopilotCommandType,
  runPluginPayloadSchema,
  validateCommandPayload,
  type ChatToolCall,
} from "@workspace/shared"

import { dispatchQueuedCommands } from "./agent-ws.js"
import { emitDevice, emitFleet } from "./io-emit.js"
import { errorBody, parseJson } from "./lib.js"
import { filterPluginTargets } from "./plugin-access.js"
import { getSettings } from "./settings.js"

export const CHAT_RATE_LIMIT = 20
export const CHAT_RATE_WINDOW_MS = 60_000
export const CHAT_HISTORY_LIMIT = 40
export const CHAT_MAX_TOOL_ROUNDS = 6
export const TOOL_RESULT_MAX_CHARS = 16_384
export const CHAT_MESSAGE_MAX = 8_000

const busyThreads = new Set<string>()
const rateHits = new Map<string, number[]>()

export function resetChatGuards(): void {
  busyThreads.clear()
  rateHits.clear()
}

export function allowThreadMessage(threadId: string, now = Date.now()): boolean {
  const prev = (rateHits.get(threadId) ?? []).filter((t) => now - t < CHAT_RATE_WINDOW_MS)
  if (prev.length >= CHAT_RATE_LIMIT) {
    rateHits.set(threadId, prev)
    return false
  }
  prev.push(now)
  rateHits.set(threadId, prev)
  return true
}

export function openaiChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim()
  if (!trimmed) return ""
  if (/chat\/completions/i.test(trimmed)) return trimmed.replace(/\/+$/, "")
  const noSlash = trimmed.replace(/\/+$/, "")
  if (/\/v1$/i.test(noSlash)) return `${noSlash}/chat/completions`
  return `${noSlash}/v1/chat/completions`
}

export function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    /* ignore */
  }
  return {}
}

export function truncateToolResult(value: unknown): string {
  let text: string
  try {
    text = typeof value === "string" ? value : JSON.stringify(value)
  } catch {
    text = "{\"error\":\"unserializable\"}"
  }
  if (text.length <= TOOL_RESULT_MAX_CHARS) return text
  return `${text.slice(0, TOOL_RESULT_MAX_CHARS)}…`
}

export function threadTitleFrom(text: string): string {
  const one = text.replace(/\s+/g, " ").trim()
  if (!one) return "New chat"
  return one.length > 72 ? `${one.slice(0, 71)}…` : one
}

export function parseStoredToolCalls(raw: string | null | undefined): ChatToolCall[] {
  const parsed = parseJson<unknown>(raw, [])
  if (!Array.isArray(parsed)) return []
  return parsed.filter((item): item is ChatToolCall => {
    if (!item || typeof item !== "object") return false
    const rec = item as ChatToolCall
    return typeof rec.id === "string" && typeof rec.name === "string"
  })
}

type OpenAiToolAcc = { id: string; name: string; arguments: string }

const COPILOT_OPENAI_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_processes",
      description: "Queue get_processes on this device and return the snapshot.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_files",
      description: "List files in a sandbox path on this device.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Directory path" } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_services",
      description: "List Windows services (no-op detail on non-Windows).",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_registry",
      description: "Read a Windows registry key. Hive is HKLM or HKCU.",
      parameters: {
        type: "object",
        properties: {
          hive: { type: "string", enum: ["HKLM", "HKCU"] },
          path: { type: "string" },
        },
        required: ["hive"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_adapters",
      description: "List Windows network adapters (IP Helper). Unsupported on non-Windows.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_ports",
      description: "List TCP/UDP sockets with owning PID. Optional listenOnly. Port 17891 is the official peer port.",
      parameters: {
        type: "object",
        properties: { listenOnly: { type: "boolean" } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_firewall",
      description: "List Windows Firewall profiles and rules (INetFwPolicy2). Does not disable the firewall.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_event_log",
      description: "Read recent Windows Event Log entries via EvtQuery. Default System, newest 50.",
      parameters: {
        type: "object",
        properties: {
          log: { type: "string" },
          newest: { type: "integer" },
          level: { type: "string", enum: ["all", "critical", "error", "warning", "information", "verbose"] },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_windows_update",
      description: "Read-only Windows Update pending and history via WUAPI IUpdateSearcher. Optional online search.",
      parameters: {
        type: "object",
        properties: { online: { type: "boolean" } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_admin_center",
      description: "Detect Windows Admin Center gateway (ServerManagementGateway). Read-only.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_tasks",
      description: "List Windows scheduled tasks via ITaskService. Read-only. Optional query filter.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_defender",
      description: "Read-only Microsoft Defender health (MSFT_MpComputerStatus).",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_bitlocker",
      description: "Read-only BitLocker volume protection status.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_capabilities",
      description: "List Windows optional features and RSAT capabilities via DISM. Does not install.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_smb",
      description: "List hosted and mapped SMB shares visible to the Windows agent.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "smb_list",
      description: "List files in a UNC path or mapped SMB drive on the Windows agent.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "UNC path or mapped drive path" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_script",
      description: "Run a short script on the agent. Subject to sandbox and command policy.",
      parameters: {
        type: "object",
        properties: { script: { type: "string" } },
        required: ["script"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_plugin",
      description:
        "Run a plugin already granted to this device. Destructive: the operator must confirm before it queues.",
      parameters: {
        type: "object",
        properties: {
          pluginId: { type: "string" },
          args: { type: "array", items: { type: "string" } },
        },
        required: ["pluginId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "preview_file",
      description: "Preview a text or small file in the sandbox.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search files under a sandbox path.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          name: { type: "string" },
          ext: { type: "string" },
          content: { type: "string" },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
]

function emitDelta(
  app: FastifyInstance,
  deviceId: string,
  payload: {
    threadId: string
    messageId?: string
    delta?: string
    done?: boolean
    error?: string
    tool?: ChatToolCall
  }
): void {
  emitDevice(app, deviceId, WS_EVENTS.CHAT_DELTA, { deviceId, ...payload })
}

export async function queueCopilotCommand(
  app: FastifyInstance,
  deviceId: string,
  type: string,
  payload: Record<string, unknown>
): Promise<{ ok: true; commandId: string } | { ok: false; error: string }> {
  if (!isCopilotCommandType(type)) return { ok: false, error: "tool_not_allowed" }
  const checked = validateCommandPayload(type, payload)
  if (!checked.ok) return { ok: false, error: "invalid_payload" }
  let body = checked.payload
  if (type === "run_plugin") {
    const plug = runPluginPayloadSchema.safeParse(body)
    if (!plug.success) return { ok: false, error: "invalid_plugin_payload" }
    body = { pluginId: plug.data.pluginId, args: plug.data.args }
    const filtered = await filterPluginTargets(plug.data.pluginId, [deviceId])
    if (!filtered.ok) return { ok: false, error: filtered.error }
    if (!filtered.deviceIds.length) {
      return { ok: false, error: filtered.skipped[0]?.reason ?? "grant_denied" }
    }
  }
  const row = await prisma.command.create({
    data: {
      deviceId,
      type,
      payload: JSON.stringify(body),
      createdBy: "copilot",
    },
  })
  await dispatchQueuedCommands(app, deviceId)
  emitFleet(app, WS_EVENTS.COMMAND_QUEUED, {
    id: row.id,
    deviceId,
    type,
    status: row.status,
  })
  return { ok: true, commandId: row.id }
}

async function waitForCommand(
  commandId: string,
  timeoutMs: number
): Promise<{ status: string; result: unknown }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const row = await prisma.command.findUnique({ where: { id: commandId } })
    if (!row) return { status: "failed", result: { error: "not_found" } }
    if (isCommandTerminal(row.status)) {
      return { status: row.status, result: parseJson(row.result, null) }
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  const row = await prisma.command.findUnique({ where: { id: commandId } })
  return {
    status: row?.status ?? "timeout",
    result: parseJson(row?.result, { error: "timeout" }),
  }
}

async function grantedPlugins(deviceId: string) {
  return prisma.plugin.findMany({
    where: { OR: [{ allDevices: true }, { grants: { some: { deviceId } } }] },
    select: { id: true, name: true, version: true },
    orderBy: { name: "asc" },
    take: 50,
  })
}

function systemPrompt(
  device: Device,
  plugins: Array<{ id: string; name: string; version: string }>
): string {
  const pluginLines = plugins.length
    ? plugins.map((p) => `- ${p.name} (${p.id}) v${p.version}`).join("\n")
    : "None granted."
  return `You are the Mnag.pt fleet operations copilot for one enrolled device.
You help the operator inspect and manage that device by calling tools that queue existing agent commands.
You cannot persist hidden state. You cannot invent command types, bypass the file sandbox, skip plugin grants, or run unlisted tools.
Destructive tools (run_plugin) wait for the operator to confirm in the dashboard before they queue.
Stay on fleet operations for this device. Do not assist with attacks, malware, or anything outside administering this operator-owned device.

Device:
- hostname: ${device.hostname}
- platform: ${device.platform}
- arch: ${device.arch}
- status: ${device.status}
- agentVersion: ${device.agentVersion}

Granted plugins (run_plugin pluginId must be one of these):
${pluginLines}

Prefer get_processes, get_files, get_services, get_registry, get_adapters, get_ports, get_firewall, get_event_log, get_windows_update, get_admin_center, get_tasks, get_defender, get_bitlocker, get_capabilities, get_smb, smb_list, search_files, and preview_file for inspection.
Use run_script only when the operator asked for a script and keep it short.
Summarize command results; do not dump huge JSON unless asked.`
}

type OpenAiMsg = {
  role: string
  content?: string | null
  tool_calls?: Array<{
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

function historyToOpenAi(rows: ChatMessage[]): OpenAiMsg[] {
  const out: OpenAiMsg[] = []
  for (const row of rows) {
    if (row.role === "user") {
      out.push({ role: "user", content: row.content })
      continue
    }
    if (row.role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: row.toolCallId || "tool",
        content: row.content || "",
      })
      continue
    }
    if (row.role === "assistant") {
      const calls = parseStoredToolCalls(row.toolCalls)
      const msg: OpenAiMsg = { role: "assistant", content: row.content || null }
      if (calls.length) {
        msg.tool_calls = calls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
        }))
      }
      out.push(msg)
    }
  }
  return out
}

async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const parts = buf.split("\n")
    buf = parts.pop() ?? ""
    for (const line of parts) {
      const trimmed = line.trim()
      if (!trimmed.startsWith("data:")) continue
      const data = trimmed.slice(5).trim()
      if (data && data !== "[DONE]") yield data
    }
  }
}

async function completeChat(input: {
  url: string
  apiKey: string
  model: string
  messages: OpenAiMsg[]
  onDelta?: (text: string) => void
}): Promise<{ content: string; toolCalls: OpenAiToolAcc[] }> {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (input.apiKey) headers.authorization = `Bearer ${input.apiKey}`
  const res = await fetch(input.url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: input.model,
      messages: input.messages,
      tools: COPILOT_OPENAI_TOOLS,
      stream: true,
    }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(text.slice(0, 400) || `llm_http_${res.status}`)
  }
  const ctype = res.headers.get("content-type") ?? ""
  const toolCalls: OpenAiToolAcc[] = []
  let content = ""

  type Choice = {
    delta?: {
      content?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    message?: {
      content?: string | null
      tool_calls?: Array<{
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
  }

  const applyDelta = (choice: Choice) => {
    const delta = choice.delta
    if (typeof delta?.content === "string" && delta.content) {
      content += delta.content
      input.onDelta?.(delta.content)
    }
    if (delta?.tool_calls) {
      for (const part of delta.tool_calls) {
        const idx = part.index ?? toolCalls.length
        while (toolCalls.length <= idx) toolCalls.push({ id: "", name: "", arguments: "" })
        const acc = toolCalls[idx]!
        if (part.id) acc.id = part.id
        if (part.function?.name) acc.name += part.function.name
        if (part.function?.arguments) acc.arguments += part.function.arguments
      }
    }
  }

  const applyMessage = (choice: Choice) => {
    const message = choice.message
    if (typeof message?.content === "string" && message.content) {
      content += message.content
      input.onDelta?.(message.content)
    }
    if (message?.tool_calls) {
      for (const call of message.tool_calls) {
        toolCalls.push({
          id: call.id ?? `call_${toolCalls.length}`,
          name: call.function?.name ?? "",
          arguments: call.function?.arguments ?? "",
        })
      }
    }
  }

  if (res.body && (ctype.includes("text/event-stream") || ctype.includes("text/plain"))) {
    for await (const data of readSseData(res.body)) {
      let parsed: unknown
      try {
        parsed = JSON.parse(data)
      } catch {
        continue
      }
      if (!parsed || typeof parsed !== "object") continue
      const rec = parsed as { error?: { message?: string }; choices?: unknown }
      if (rec.error?.message) throw new Error(rec.error.message)
      if (!Array.isArray(rec.choices)) continue
      for (const choice of rec.choices) {
        if (choice && typeof choice === "object") applyDelta(choice as Choice)
      }
    }
    return { content, toolCalls: toolCalls.filter((c) => c.name) }
  }

  const json = (await res.json()) as { error?: { message?: string }; choices?: Choice[] }
  if (json.error?.message) throw new Error(json.error.message)
  for (const choice of json.choices ?? []) {
    if (choice.delta) applyDelta(choice)
    else applyMessage(choice)
  }
  return { content, toolCalls: toolCalls.filter((c) => c.name) }
}

function toStoredCalls(acc: OpenAiToolAcc[], status: ChatToolCall["status"]): ChatToolCall[] {
  return acc.map((c, i) => ({
    id: c.id || `call_${i}`,
    name: c.name,
    arguments: parseToolArguments(c.arguments),
    status,
  }))
}

async function executeToolBatch(
  app: FastifyInstance,
  device: Device,
  threadId: string,
  assistantId: string,
  calls: ChatToolCall[],
  timeoutMs: number
): Promise<ChatToolCall[]> {
  const executed: ChatToolCall[] = []
  for (const call of calls) {
    if (!isCopilotCommandType(call.name)) {
      const failed: ChatToolCall = { ...call, status: "failed", error: "tool_not_allowed" }
      executed.push(failed)
      await prisma.chatMessage.create({
        data: {
          threadId,
          role: "tool",
          content: truncateToolResult({ error: "tool_not_allowed" }),
          toolName: call.name,
          toolCallId: call.id,
        },
      })
      emitDelta(app, device.id, { threadId, messageId: assistantId, tool: failed })
      continue
    }
    emitDelta(app, device.id, { threadId, messageId: assistantId, tool: { ...call, status: "queued" } })
    const queued = await queueCopilotCommand(app, device.id, call.name, call.arguments ?? {})
    if (!queued.ok) {
      const failed: ChatToolCall = { ...call, status: "failed", error: queued.error }
      executed.push(failed)
      await prisma.chatMessage.create({
        data: {
          threadId,
          role: "tool",
          content: truncateToolResult({ error: queued.error }),
          toolName: call.name,
          toolCallId: call.id,
        },
      })
      emitDelta(app, device.id, { threadId, messageId: assistantId, tool: failed })
      continue
    }
    const running: ChatToolCall = { ...call, status: "running", commandId: queued.commandId }
    emitDelta(app, device.id, { threadId, messageId: assistantId, tool: running })
    const outcome = await waitForCommand(queued.commandId, timeoutMs)
    const status: ChatToolCall["status"] =
      outcome.status === "success" ? "success" : outcome.status === "cancelled" ? "failed" : "failed"
    const done: ChatToolCall = { ...running, status, commandId: queued.commandId }
    executed.push(done)
    await prisma.chatMessage.create({
      data: {
        threadId,
        role: "tool",
        content: truncateToolResult({ status: outcome.status, result: outcome.result }),
        toolName: call.name,
        toolCallId: call.id,
        commandId: queued.commandId,
      },
    })
    emitDelta(app, device.id, { threadId, messageId: assistantId, tool: done })
  }
  return executed
}

async function loadThreadMessages(threadId: string): Promise<ChatMessage[]> {
  return prisma.chatMessage.findMany({
    where: { threadId },
    orderBy: { createdAt: "asc" },
    take: 200,
  })
}

function hasPendingConfirm(messages: ChatMessage[]): ChatMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const row = messages[i]
    if (!row || row.role !== "assistant") continue
    const calls = parseStoredToolCalls(row.toolCalls)
    if (calls.some((c) => c.status === "pending_confirm")) return row
  }
  return null
}

async function runModelLoop(
  app: FastifyInstance,
  device: Device,
  threadId: string,
  llm: { url: string; apiKey: string; model: string },
  timeoutMs: number
): Promise<{ pendingConfirm: boolean; assistantId: string | null; error?: string }> {
  const plugins = await grantedPlugins(device.id)
  let assistantId: string | null = null
  for (let round = 0; round < CHAT_MAX_TOOL_ROUNDS; round++) {
    const rows = await loadThreadMessages(threadId)
    const recent = rows.slice(-CHAT_HISTORY_LIMIT)
    const assistant = await prisma.chatMessage.create({
      data: { threadId, role: "assistant", content: "" },
    })
    assistantId = assistant.id
    let content = ""
    let toolAcc: OpenAiToolAcc[] = []
    try {
      const result = await completeChat({
        url: llm.url,
        apiKey: llm.apiKey,
        model: llm.model,
        messages: [{ role: "system", content: systemPrompt(device, plugins) }, ...historyToOpenAi(recent)],
        onDelta: (text) => {
          content += text
          emitDelta(app, device.id, { threadId, messageId: assistant.id, delta: text })
        },
      })
      if (!content && result.content) content = result.content
      toolAcc = result.toolCalls
    } catch (error) {
      const message = error instanceof Error ? error.message : "llm_failed"
      await prisma.chatMessage.update({
        where: { id: assistant.id },
        data: { content: content || `Model error: ${message}` },
      })
      emitDelta(app, device.id, { threadId, messageId: assistant.id, error: message, done: true })
      return { pendingConfirm: false, assistantId, error: message }
    }

    if (!toolAcc.length) {
      await prisma.chatMessage.update({
        where: { id: assistant.id },
        data: { content: content || "The model returned an empty reply." },
      })
      emitDelta(app, device.id, { threadId, messageId: assistant.id, done: true })
      return { pendingConfirm: false, assistantId }
    }

    const stored = toStoredCalls(toolAcc, "queued")
    const needsConfirm = stored.some((c) => copilotToolNeedsConfirm(c.name))
    if (needsConfirm) {
      const pending = stored.map((c) => ({ ...c, status: "pending_confirm" as const }))
      await prisma.chatMessage.update({
        where: { id: assistant.id },
        data: { content, toolCalls: JSON.stringify(pending) },
      })
      for (const tool of pending) {
        emitDelta(app, device.id, { threadId, messageId: assistant.id, tool })
      }
      emitDelta(app, device.id, { threadId, messageId: assistant.id, done: true })
      return { pendingConfirm: true, assistantId }
    }

    const invalid = stored.find((c) => !isCopilotCommandType(c.name))
    if (invalid) {
      await prisma.chatMessage.update({
        where: { id: assistant.id },
        data: {
          content: content || "The model requested a tool that is not allowed.",
          toolCalls: JSON.stringify([{ ...invalid, status: "failed", error: "tool_not_allowed" }]),
        },
      })
      await prisma.chatMessage.create({
        data: {
          threadId,
          role: "tool",
          content: truncateToolResult({ error: "tool_not_allowed" }),
          toolName: invalid.name,
          toolCallId: invalid.id,
        },
      })
      emitDelta(app, device.id, { threadId, messageId: assistant.id, done: true })
      continue
    }

    await prisma.chatMessage.update({
      where: { id: assistant.id },
      data: { content, toolCalls: JSON.stringify(stored) },
    })
    const executed = await executeToolBatch(app, device, threadId, assistant.id, stored, timeoutMs)
    await prisma.chatMessage.update({
      where: { id: assistant.id },
      data: { toolCalls: JSON.stringify(executed) },
    })
  }
  emitDelta(app, device.id, { threadId, done: true })
  return { pendingConfirm: false, assistantId }
}

export async function runCopilotTurn(
  app: FastifyInstance,
  device: Device,
  threadId: string,
  content: string
): Promise<{ status: number; body: unknown }> {
  if (busyThreads.has(threadId)) return { status: 409, body: errorBody("busy") }
  if (!allowThreadMessage(threadId)) return { status: 429, body: errorBody("rate_limited") }
  const settings = await getSettings()
  const url = openaiChatCompletionsUrl(settings.llm.baseUrl)
  if (!url || !settings.llm.model.trim()) {
    return { status: 400, body: errorBody("llm_not_configured") }
  }
  const existing = await loadThreadMessages(threadId)
  if (hasPendingConfirm(existing)) return { status: 409, body: errorBody("pending_confirm") }

  busyThreads.add(threadId)
  try {
    const userCount = existing.filter((m) => m.role === "user").length
    await prisma.chatMessage.create({
      data: { threadId, role: "user", content },
    })
    if (userCount === 0) {
      await prisma.chatThread.update({
        where: { id: threadId },
        data: { title: threadTitleFrom(content) },
      })
    } else {
      await prisma.chatThread.update({
        where: { id: threadId },
        data: { updatedAt: new Date() },
      })
    }
    const timeoutMs = Math.min(Math.max(1, settings.agent.commandTimeoutMin) * 60_000, 120_000)
    const result = await runModelLoop(app, device, threadId, {
      url,
      apiKey: settings.llm.apiKey,
      model: settings.llm.model.trim(),
    }, timeoutMs)
    const messages = await loadThreadMessages(threadId)
    return {
      status: 200,
      body: {
        pendingConfirm: result.pendingConfirm,
        error: result.error,
        messages: messages.map(serializeChatMessage),
      },
    }
  } finally {
    busyThreads.delete(threadId)
  }
}

export async function confirmCopilotTool(
  app: FastifyInstance,
  device: Device,
  threadId: string,
  toolCallId: string,
  confirmed: boolean
): Promise<{ status: number; body: unknown }> {
  if (busyThreads.has(threadId)) return { status: 409, body: errorBody("busy") }
  const settings = await getSettings()
  const url = openaiChatCompletionsUrl(settings.llm.baseUrl)
  if (!url || !settings.llm.model.trim()) {
    return { status: 400, body: errorBody("llm_not_configured") }
  }
  const rows = await loadThreadMessages(threadId)
  const assistant = hasPendingConfirm(rows)
  if (!assistant) return { status: 404, body: errorBody("nothing_to_confirm") }
  const calls = parseStoredToolCalls(assistant.toolCalls)
  if (!calls.some((c) => c.id === toolCallId && c.status === "pending_confirm")) {
    return { status: 404, body: errorBody("tool_call_not_found") }
  }

  busyThreads.add(threadId)
  try {
    const timeoutMs = Math.min(Math.max(1, settings.agent.commandTimeoutMin) * 60_000, 120_000)
    if (!confirmed) {
      const declined = calls.map((c) => ({ ...c, status: "declined" as const }))
      await prisma.chatMessage.update({
        where: { id: assistant.id },
        data: { toolCalls: JSON.stringify(declined) },
      })
      for (const call of declined) {
        await prisma.chatMessage.create({
          data: {
            threadId,
            role: "tool",
            content: truncateToolResult({ error: "operator_declined" }),
            toolName: call.name,
            toolCallId: call.id,
          },
        })
        emitDelta(app, device.id, { threadId, messageId: assistant.id, tool: call })
      }
    } else {
      const queued = calls.map((c) => ({ ...c, status: "queued" as const }))
      await prisma.chatMessage.update({
        where: { id: assistant.id },
        data: { toolCalls: JSON.stringify(queued) },
      })
      const executed = await executeToolBatch(app, device, threadId, assistant.id, queued, timeoutMs)
      await prisma.chatMessage.update({
        where: { id: assistant.id },
        data: { toolCalls: JSON.stringify(executed) },
      })
    }
    const result = await runModelLoop(app, device, threadId, {
      url,
      apiKey: settings.llm.apiKey,
      model: settings.llm.model.trim(),
    }, timeoutMs)
    const messages = await loadThreadMessages(threadId)
    return {
      status: 200,
      body: {
        pendingConfirm: result.pendingConfirm,
        error: result.error,
        messages: messages.map(serializeChatMessage),
      },
    }
  } finally {
    busyThreads.delete(threadId)
  }
}

export function serializeChatMessage(row: ChatMessage) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    toolName: row.toolName,
    toolCallId: row.toolCallId,
    toolCalls: parseStoredToolCalls(row.toolCalls),
    commandId: row.commandId,
    createdAt: row.createdAt,
  }
}

export function serializeChatThread(row: { id: string; title: string; createdAt: Date; updatedAt: Date }) {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
