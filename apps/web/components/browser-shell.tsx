"use client"

import * as React from "react"
import { toast } from "sonner"
import { WS_EVENTS, type ShellKind } from "@workspace/shared"

import { api } from "@/lib/api"
import { pollAdminCommand } from "@/lib/command-poll"
import { useSocket } from "@/components/providers"
import { Button } from "@workspace/ui/components/button"
import { Card, CardContent } from "@workspace/ui/components/card"
import { Input } from "@workspace/ui/components/input"

const EXEC_FALLBACK_MS = 4_000
const MAX_LINES = 2_000

type Line = { id: string; kind: "in" | "out" | "meta"; text: string }

function newId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID()
  return `e-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function promptPrefix(platform: string, shell: ShellKind): string {
  if (platform.toLowerCase() !== "windows") return "$ "
  return shell === "cmd" ? "C> " : "PS> "
}

function scriptOutput(result: unknown): string {
  if (result == null) return ""
  if (typeof result === "string") return result
  if (typeof result !== "object") return String(result)
  const rec = result as { stdout?: unknown; stderr?: unknown; error?: unknown; output?: unknown }
  const parts: string[] = []
  if (typeof rec.stdout === "string" && rec.stdout) parts.push(rec.stdout)
  if (typeof rec.stderr === "string" && rec.stderr) parts.push(rec.stderr)
  if (typeof rec.output === "string" && rec.output) parts.push(rec.output)
  if (typeof rec.error === "string" && rec.error) parts.push(rec.error)
  if (parts.length) return parts.join("")
  try {
    return JSON.stringify(result)
  } catch {
    return ""
  }
}

export function BrowserShell({
  deviceId,
  platform,
  shell,
}: {
  deviceId: string
  platform: string
  shell: ShellKind
}) {
  const socket = useSocket()
  const outRef = React.useRef<HTMLPreElement | null>(null)
  const [lines, setLines] = React.useState<Line[]>([])
  const [input, setInput] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [status, setStatus] = React.useState("idle")
  const historyRef = React.useRef<string[]>([])
  const histIdxRef = React.useRef(-1)
  const pollAbortRef = React.useRef<AbortController | null>(null)
  const pendingRef = React.useRef<{
    execId: string
    command: string
    commandId?: string
    fallback?: ReturnType<typeof setTimeout>
    usedScript?: boolean
    sawExec?: boolean
  } | null>(null)

  const append = React.useCallback((kind: Line["kind"], text: string) => {
    if (!text) return
    const id = newId()
    setLines((cur) => {
      const next = [...cur, { id, kind, text }]
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next
    })
  }, [])

  React.useEffect(() => {
    const el = outRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  const finish = React.useCallback(
    (execId: string, text?: string, meta?: string) => {
      const pending = pendingRef.current
      if (!pending || pending.execId !== execId) return
      if (pending.fallback) clearTimeout(pending.fallback)
      pollAbortRef.current?.abort()
      pollAbortRef.current = null
      if (text) append("out", text)
      if (meta) append("meta", meta)
      pendingRef.current = null
      setBusy(false)
      setStatus("idle")
    },
    [append]
  )

  const watchRunScript = React.useCallback(
    (commandId: string, execId: string) => {
      pollAbortRef.current?.abort()
      const ac = new AbortController()
      pollAbortRef.current = ac
      void (async () => {
        const outcome = await pollAdminCommand(commandId, { signal: ac.signal })
        if (ac.signal.aborted) return
        const pending = pendingRef.current
        if (!pending || pending.execId !== execId) return
        if (outcome.kind === "timeout") {
          finish(execId, undefined, "timed out waiting for command result")
          return
        }
        if (outcome.kind === "error") {
          if (outcome.message === "aborted") return
          finish(execId, undefined, outcome.message)
          return
        }
        const text = scriptOutput(outcome.command.result)
        const status = outcome.command.status
        finish(execId, text, status && status !== "success" ? status : undefined)
      })()
    },
    [finish]
  )

  const queueRunScript = React.useCallback(
    async (command: string, execId: string) => {
      const pending = pendingRef.current
      if (!pending || pending.execId !== execId) return
      pending.usedScript = true
      setStatus("queued")
      const script =
        platform.toLowerCase() === "windows" && shell === "cmd" ? `cmd /c ${command}` : command
      try {
        const res = await api<{ commands: Array<{ id: string }> }>("/api/v1/admin/commands", {
          method: "POST",
          body: JSON.stringify({ deviceIds: [deviceId], type: "run_script", payload: { script } }),
        })
        const commandId = res.commands[0]?.id
        if (!commandId) {
          append("meta", "failed to queue run_script")
          pendingRef.current = null
          setBusy(false)
          setStatus("error")
          return
        }
        if (pendingRef.current?.execId === execId) pendingRef.current.commandId = commandId
        setStatus("running")
        watchRunScript(commandId, execId)
      } catch (error) {
        append("meta", error instanceof Error ? error.message : "run_script failed")
        pendingRef.current = null
        setBusy(false)
        setStatus("error")
        toast.error(error instanceof Error ? error.message : "run_script failed")
      }
    },
    [append, deviceId, platform, shell, watchRunScript]
  )

  React.useEffect(() => {
    if (!socket) return
    const onExec = (raw: unknown) => {
      if (!raw || typeof raw !== "object") return
      const rec = raw as {
        deviceId?: unknown
        id?: unknown
        data?: unknown
        done?: unknown
        exitCode?: unknown
        error?: unknown
      }
      if (rec.deviceId && rec.deviceId !== deviceId) return
      const pending = pendingRef.current
      if (!pending || rec.id !== pending.execId || pending.usedScript) return
      if (pending.fallback) {
        clearTimeout(pending.fallback)
        pending.fallback = undefined
      }
      pending.sawExec = true
      if (typeof rec.data === "string" && rec.data) append("out", rec.data)
      if (rec.done) {
        const err = typeof rec.error === "string" ? rec.error : ""
        if (err === "agent_offline") {
          pending.sawExec = false
          void queueRunScript(pending.command, pending.execId)
          return
        }
        const code = typeof rec.exitCode === "number" ? rec.exitCode : undefined
        const bits: string[] = []
        if (err) bits.push(err)
        if (code !== undefined && code !== 0) bits.push(`exit ${code}`)
        finish(pending.execId, undefined, bits.length ? bits.join(" · ") : undefined)
      }
    }
    const onResult = (raw: unknown) => {
      if (!raw || typeof raw !== "object") return
      const rec = raw as {
        deviceId?: unknown
        id?: unknown
        type?: unknown
        status?: unknown
        result?: unknown
      }
      const pending = pendingRef.current
      if (!pending?.commandId) return
      if (rec.deviceId && rec.deviceId !== deviceId) return
      if (rec.id !== pending.commandId) return
      if (rec.type && rec.type !== "run_script") return
      const text = scriptOutput(rec.result)
      const status = typeof rec.status === "string" ? rec.status : ""
      finish(pending.execId, text, status && status !== "success" ? status : undefined)
    }
    socket.on(WS_EVENTS.SHELL_EXEC, onExec)
    socket.on(WS_EVENTS.COMMAND_RESULT, onResult)
    return () => {
      socket.off(WS_EVENTS.SHELL_EXEC, onExec)
      socket.off(WS_EVENTS.COMMAND_RESULT, onResult)
    }
  }, [socket, deviceId, append, finish, queueRunScript])

  React.useEffect(() => {
    setLines([])
    setInput("")
    setBusy(false)
    setStatus("idle")
    historyRef.current = []
    histIdxRef.current = -1
    return () => {
      pollAbortRef.current?.abort()
      pollAbortRef.current = null
      const pending = pendingRef.current
      if (pending?.fallback) clearTimeout(pending.fallback)
      pendingRef.current = null
    }
  }, [deviceId])

  function runLine(raw: string) {
    const command = raw.replace(/\s+$/, "")
    if (!command || busy) return
    const prefix = promptPrefix(platform, shell)
    append("in", `${prefix}${command}`)
    historyRef.current = [...historyRef.current.filter((h) => h !== command), command]
    histIdxRef.current = -1
    setInput("")
    setBusy(true)
    setStatus("running")
    const execId = newId()
    const fallback = setTimeout(() => {
      const pending = pendingRef.current
      if (!pending || pending.execId !== execId || pending.usedScript || pending.sawExec) return
      void queueRunScript(command, execId)
    }, EXEC_FALLBACK_MS)
    pendingRef.current = { execId, command, fallback }
    if (!socket) {
      void queueRunScript(command, execId)
      return
    }
    const execShell = platform.toLowerCase() === "windows" ? shell : "sh"
    socket.emit(WS_EVENTS.SHELL_EXEC, {
      type: "shell_exec",
      deviceId,
      id: execId,
      command,
      shell: execShell,
    })
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault()
      runLine(input)
      return
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      const hist = historyRef.current
      if (!hist.length) return
      const next = histIdxRef.current < 0 ? hist.length - 1 : Math.max(0, histIdxRef.current - 1)
      histIdxRef.current = next
      setInput(hist[next] ?? "")
      return
    }
    if (event.key === "ArrowDown") {
      event.preventDefault()
      const hist = historyRef.current
      if (histIdxRef.current < 0) return
      const next = histIdxRef.current + 1
      if (next >= hist.length) {
        histIdxRef.current = -1
        setInput("")
        return
      }
      histIdxRef.current = next
      setInput(hist[next] ?? "")
    }
  }

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => setLines([])} disabled={busy}>
          Clear
        </Button>
        <span className="text-xs text-muted-foreground">
          Browser shell · {status}
          {busy ? " · running" : ""}
        </span>
      </div>
      <Card>
        <CardContent className="p-0">
          <pre
            ref={outRef}
            className="h-[min(70vh,420px)] overflow-auto rounded-t-xl bg-black p-3 font-mono text-xs leading-5 text-zinc-200"
          >
            {lines.length ? (
              lines.map((line) => (
                <span
                  key={line.id}
                  className={
                    line.kind === "in"
                      ? "text-zinc-100"
                      : line.kind === "meta"
                        ? "text-amber-400"
                        : "text-zinc-300"
                  }
                >
                  {line.text}
                  {line.text.endsWith("\n") ? "" : "\n"}
                </span>
              ))
            ) : (
              <span className="text-zinc-500">
                Line-oriented shell. Commands run one-shot (no ConPTY). Enter to send.
              </span>
            )}
          </pre>
          <form
            className="flex items-center gap-2 border-t p-2"
            onSubmit={(event) => {
              event.preventDefault()
              runLine(input)
            }}
          >
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {promptPrefix(platform, shell)}
            </span>
            <Input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={onKeyDown}
              disabled={busy}
              placeholder={busy ? "Waiting for output…" : "Type a command"}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
            <Button type="submit" size="sm" disabled={busy || !input.trim()}>
              Run
            </Button>
          </form>
        </CardContent>
      </Card>
    </>
  )
}
