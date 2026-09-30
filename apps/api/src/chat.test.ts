import assert from "node:assert/strict"
import { test } from "node:test"

import { copilotToolNeedsConfirm, isCopilotCommandType } from "@workspace/shared"

import {
  CHAT_RATE_LIMIT,
  allowThreadMessage,
  openaiChatCompletionsUrl,
  parseStoredToolCalls,
  parseToolArguments,
  resetChatGuards,
  threadTitleFrom,
  truncateToolResult,
  TOOL_RESULT_MAX_CHARS,
} from "./chat.ts"

test("openaiChatCompletionsUrl accepts OpenAI, Azure-style, and /v1 roots", () => {
  assert.equal(openaiChatCompletionsUrl(""), "")
  assert.equal(
    openaiChatCompletionsUrl("https://api.openai.com/v1"),
    "https://api.openai.com/v1/chat/completions"
  )
  assert.equal(
    openaiChatCompletionsUrl("http://127.0.0.1:11434/v1/"),
    "http://127.0.0.1:11434/v1/chat/completions"
  )
  assert.equal(
    openaiChatCompletionsUrl("https://host.example/openai/deployments/x/chat/completions?api-version=2024-02-01"),
    "https://host.example/openai/deployments/x/chat/completions?api-version=2024-02-01"
  )
  assert.equal(
    openaiChatCompletionsUrl("https://llm.internal"),
    "https://llm.internal/v1/chat/completions"
  )
})

test("thread rate limit is per thread", () => {
  resetChatGuards()
  for (let i = 0; i < CHAT_RATE_LIMIT; i++) assert.equal(allowThreadMessage("t1", 1_000), true)
  assert.equal(allowThreadMessage("t1", 1_000), false)
  assert.equal(allowThreadMessage("t2", 1_000), true)
  assert.equal(allowThreadMessage("t1", 1_000 + 60_000), true)
})

test("parseToolArguments and truncateToolResult", () => {
  assert.deepEqual(parseToolArguments('{"path":"C:\\\\Users"}'), { path: "C:\\Users" })
  assert.deepEqual(parseToolArguments("not-json"), {})
  assert.deepEqual(parseToolArguments(""), {})
  const big = "x".repeat(TOOL_RESULT_MAX_CHARS + 10)
  const out = truncateToolResult(big)
  assert.equal(out.endsWith("…"), true)
  assert.equal(out.length, TOOL_RESULT_MAX_CHARS + 1)
  assert.equal(threadTitleFrom("  hello\nworld  "), "hello world")
  assert.equal(threadTitleFrom(""), "New chat")
})

test("stored tool calls and copilot allowlist", () => {
  const calls = parseStoredToolCalls(
    JSON.stringify([{ id: "c1", name: "get_files", arguments: { path: "/" }, status: "queued" }])
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.name, "get_files")
  assert.equal(parseStoredToolCalls("nope").length, 0)
  assert.equal(isCopilotCommandType("preview_file"), true)
  assert.equal(isCopilotCommandType("delete_file"), false)
  assert.equal(copilotToolNeedsConfirm("run_plugin"), false)
  assert.equal(copilotToolNeedsConfirm("search_files"), false)
})
