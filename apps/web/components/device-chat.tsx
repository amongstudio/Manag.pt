"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  DEFAULT_SETTINGS,
  WS_EVENTS,
  type AppSettings,
  type ChatDeltaPayload,
  type ChatToolCall,
} from "@workspace/shared"

import { api, formatWhen, snippet } from "@/lib/api"
import { useSocket } from "@/components/providers"
import { StatusBadge } from "@/components/status-badge"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@workspace/ui/components/alert-dialog"
import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Card, CardContent } from "@workspace/ui/components/card"
import { Spinner } from "@workspace/ui/components/spinner"
import { Textarea } from "@workspace/ui/components/textarea"

type ChatThread = { id: string; title: string; createdAt: string; updatedAt: string }

type ChatMessage = {
  id: string
  role: string
  content: string
  toolName: string | null
  toolCallId: string | null
  toolCalls: ChatToolCall[]
  commandId: string | null
  createdAt: string
}

type MessagesResponse = { messages: ChatMessage[]; pendingConfirm?: boolean; error?: string }
type ThreadResponse = { thread: ChatThread; messages: ChatMessage[] }

export function DeviceChat({
  deviceId,
  hostname,
  platform,
  status,
  activeThreadId,
  onActiveThreadIdChange,
}: {
  deviceId: string
  hostname: string
  platform: string
  status: string
  activeThreadId: string | null
  onActiveThreadIdChange: (id: string | null) => void
}) {
  const client = useQueryClient()
  const socket = useSocket()
  const [draft, setDraft] = React.useState("")
  const [streamById, setStreamById] = React.useState<Record<string, string>>({})
  const [pendingTool, setPendingTool] = React.useState<ChatToolCall | null>(null)
  const bottomRef = React.useRef<HTMLDivElement>(null)

  const threadsQuery = useQuery({
    queryKey: ["device-chats", deviceId],
    queryFn: () => api<{ threads: ChatThread[] }>(`/api/v1/admin/devices/${deviceId}/chats`),
  })
  const threads = threadsQuery.data?.threads
  const threadId = activeThreadId ?? threads?.[0]?.id ?? null

  React.useEffect(() => {
    const first = threads?.[0]?.id
    if (!activeThreadId && first) onActiveThreadIdChange(first)
  }, [activeThreadId, threads, onActiveThreadIdChange])

  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: () => api<{ settings: AppSettings }>("/api/v1/admin/settings"),
    staleTime: 5 * 60_000,
  })
  const llm = { ...DEFAULT_SETTINGS.llm, ...settingsQuery.data?.settings.llm }
  const llmReady = Boolean(llm.baseUrl.trim() && llm.model.trim())

  const messagesQuery = useQuery({
    queryKey: ["device-chat", deviceId, threadId],
    queryFn: () => api<ThreadResponse>(`/api/v1/admin/devices/${deviceId}/chats/${threadId}`),
    enabled: Boolean(threadId),
  })
  const messages = messagesQuery.data?.messages ?? []

  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" })
  }, [messages, streamById, threadId])

  React.useEffect(() => {
    if (!socket) return
    const onDelta = (payload: unknown) => {
      if (!payload || typeof payload !== "object") return
      const rec = payload as ChatDeltaPayload
      if (rec.deviceId !== deviceId) return
      if (threadId && rec.threadId !== threadId) return
      if (rec.delta && rec.messageId) {
        setStreamById((cur) => ({
          ...cur,
          [rec.messageId!]: `${cur[rec.messageId!] ?? ""}${rec.delta}`,
        }))
      }
      if (rec.done || rec.error || rec.tool) {
        void client.invalidateQueries({ queryKey: ["device-chat", deviceId, rec.threadId] })
        void client.invalidateQueries({ queryKey: ["device-chats", deviceId] })
        void client.invalidateQueries({ queryKey: ["device", deviceId] })
      }
      if (rec.done && rec.messageId) {
        setStreamById((cur) => {
          const next = { ...cur }
          delete next[rec.messageId!]
          return next
        })
      }
      if (rec.error) toast.error(rec.error)
    }
    socket.on(WS_EVENTS.CHAT_DELTA, onDelta)
    return () => {
      socket.off(WS_EVENTS.CHAT_DELTA, onDelta)
    }
  }, [socket, deviceId, threadId, client])

  const send = useMutation({
    mutationFn: (content: string) => {
      if (!threadId) throw new Error("Create a chat first")
      return api<MessagesResponse>(`/api/v1/admin/devices/${deviceId}/chats/${threadId}/messages`, {
        method: "POST",
        body: JSON.stringify({ content }),
      })
    },
    onSuccess: (data) => {
      setDraft("")
      void client.invalidateQueries({ queryKey: ["device-chat", deviceId, threadId] })
      void client.invalidateQueries({ queryKey: ["device-chats", deviceId] })
      void client.invalidateQueries({ queryKey: ["device", deviceId] })
      if (data.error) toast.error(data.error)
    },
    onError: (e) => toast.error(e.message),
  })

  const confirm = useMutation({
    mutationFn: ({ toolCallId, confirmed }: { toolCallId: string; confirmed: boolean }) => {
      if (!threadId) throw new Error("No chat")
      return api<MessagesResponse>(`/api/v1/admin/devices/${deviceId}/chats/${threadId}/confirm`, {
        method: "POST",
        body: JSON.stringify({ toolCallId, confirmed }),
      })
    },
    onSuccess: (data) => {
      setPendingTool(null)
      void client.invalidateQueries({ queryKey: ["device-chat", deviceId, threadId] })
      void client.invalidateQueries({ queryKey: ["device", deviceId] })
      if (data.error) toast.error(data.error)
    },
    onError: (e) => toast.error(e.message),
  })

  const busy = send.isPending || confirm.isPending

  return (
    <div className="grid gap-4 md:grid-cols-[14rem_1fr]">
      <Card>
        <CardContent className="flex flex-col gap-1 pt-4">
          <p className="mb-2 text-xs text-muted-foreground">
            {hostname} · {platform} · {status}
          </p>
          {!(threads ?? []).length ? (
            <p className="text-sm text-muted-foreground">No threads yet. Use New chat.</p>
          ) : (
            (threads ?? []).map((thread) => (
              <button
                key={thread.id}
                type="button"
                className={`rounded-md px-2 py-1.5 text-left text-sm ${
                  thread.id === threadId ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60"
                }`}
                onClick={() => onActiveThreadIdChange(thread.id)}
              >
                <span className="line-clamp-2">{thread.title}</span>
                <span className="block text-[11px] opacity-70">{formatWhen(thread.updatedAt)}</span>
              </button>
            ))
          )}
        </CardContent>
      </Card>
      <Card>
        <CardContent className="flex flex-col gap-3 pt-4">
          {!llmReady ? (
            <Alert>
              <AlertTitle>Copilot is not configured</AlertTitle>
              <AlertDescription>
                Set an OpenAI-compatible base URL and model under Settings → Copilot. Local servers can leave the API
                key empty.
              </AlertDescription>
            </Alert>
          ) : null}
          {!threadId ? (
            <Alert>
              <AlertTitle>Start a chat</AlertTitle>
              <AlertDescription>
                New chat opens a copilot thread for this device. Configure an OpenAI-compatible model under Settings
                → Copilot.
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <div className="flex max-h-[min(60vh,32rem)] flex-col gap-3 overflow-auto rounded-lg border p-3">
                {!messages.length && !Object.keys(streamById).length ? (
                  <p className="text-sm text-muted-foreground">
                    Ask for a process list, files, services, registry, or a granted plugin. Destructive tools ask for
                    confirm before they queue.
                  </p>
                ) : null}
                {messages.map((msg) => (
                  <ChatBubble
                    key={msg.id}
                    message={msg}
                    stream={streamById[msg.id]}
                    onConfirm={(tool) => setPendingTool(tool)}
                    confirming={confirm.isPending}
                  />
                ))}
                <div ref={bottomRef} />
              </div>
              <div className="flex flex-col gap-2">
                <Textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Message the copilot…"
                  rows={3}
                  disabled={busy || !llmReady}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && draft.trim() && !busy) {
                      send.mutate(draft.trim())
                    }
                  }}
                />
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">Ctrl+Enter to send</p>
                  <Button
                    size="sm"
                    disabled={busy || !draft.trim() || !llmReady}
                    onClick={() => send.mutate(draft.trim())}
                  >
                    {send.isPending ? <Spinner data-icon="inline-start" /> : null}
                    Send
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
      <AlertDialog open={!!pendingTool} onOpenChange={(open) => !open && setPendingTool(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Queue {pendingTool?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This tool is destructive. Confirming queues the existing command type on {hostname} through the normal
              policy and sandbox. Payload: {pendingTool ? snippet(pendingTool.arguments, 240) : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={confirm.isPending}
              onClick={() => pendingTool && confirm.mutate({ toolCallId: pendingTool.id, confirmed: false })}
            >
              Decline
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={confirm.isPending}
              onClick={() => pendingTool && confirm.mutate({ toolCallId: pendingTool.id, confirmed: true })}
            >
              Confirm and queue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function ChatBubble({
  message,
  stream,
  onConfirm,
  confirming,
}: {
  message: ChatMessage
  stream?: string
  onConfirm: (tool: ChatToolCall) => void
  confirming: boolean
}) {
  if (message.role === "tool") {
    return (
      <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <Badge variant="outline">{message.toolName ?? "tool"}</Badge>
          {message.commandId ? (
            <a href="#commands" className="font-mono text-muted-foreground underline-offset-2 hover:underline">
              command {message.commandId.slice(0, 8)}
            </a>
          ) : null}
        </div>
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all text-[11px] text-muted-foreground">
          {snippet(message.content, 800)}
        </pre>
      </div>
    )
  }
  const text = `${message.content}${stream ?? ""}`
  const isUser = message.role === "user"
  return (
    <div className={`flex flex-col gap-2 ${isUser ? "items-end" : "items-start"}`}>
      <div
        className={`max-w-[90%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
          isUser ? "bg-primary text-primary-foreground" : "bg-muted"
        }`}
      >
        {text || (stream != null ? "…" : "")}
      </div>
      {message.toolCalls?.length ? (
        <div className="flex w-full max-w-[90%] flex-col gap-2">
          {message.toolCalls.map((tool) => (
            <ToolCard key={tool.id} tool={tool} onConfirm={onConfirm} confirming={confirming} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function ToolCard({
  tool,
  onConfirm,
  confirming,
}: {
  tool: ChatToolCall
  onConfirm: (tool: ChatToolCall) => void
  confirming: boolean
}) {
  return (
    <div className="rounded-lg border px-3 py-2 text-xs">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <Badge variant="outline">{tool.name}</Badge>
        <StatusBadge status={tool.status} />
        {tool.commandId ? (
          <a href="#commands" className="font-mono text-muted-foreground underline-offset-2 hover:underline">
            command {tool.commandId.slice(0, 8)}
          </a>
        ) : null}
        {tool.status === "pending_confirm" ? (
          <Button size="sm" variant="destructive" disabled={confirming} onClick={() => onConfirm(tool)}>
            Confirm
          </Button>
        ) : null}
      </div>
      <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-all text-[11px] text-muted-foreground">
        {snippet(tool.arguments, 400)}
        {tool.error ? `\n${tool.error}` : ""}
      </pre>
    </div>
  )
}
