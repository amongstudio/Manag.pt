import { api } from "@/lib/api"

export const COMMAND_POLL_MS = 1_500
export const COMMAND_POLL_TIMEOUT_MS = 60_000

export type AdminCommandRow = {
  id: string
  type?: string
  status: string
  result?: unknown
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("aborted", "AbortError"))
      return
    }
    const timer = setTimeout(resolve, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException("aborted", "AbortError"))
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  )
}

export type PollCommandOutcome =
  | { kind: "settled"; command: AdminCommandRow }
  | { kind: "timeout" }
  | { kind: "error"; message: string }

/** Queues one command for one device and returns its id. */
export async function queueDeviceCommand(
  deviceId: string,
  type: string,
  payload: Record<string, unknown> = {}
): Promise<string> {
  const data = await api<{ commands?: { id: string }[] }>("/api/v1/admin/commands", {
    method: "POST",
    body: JSON.stringify({ deviceIds: [deviceId], type, payload }),
  })
  const id = data.commands?.[0]?.id
  if (!id) throw new Error("command not queued")
  return id
}

/** Queue then poll; throws with the agent's error text when the command does not succeed. */
export async function runDeviceCommand(
  deviceId: string,
  type: string,
  payload: Record<string, unknown>,
  opts: { signal: AbortSignal; timeoutMs?: number }
): Promise<AdminCommandRow> {
  const id = await queueDeviceCommand(deviceId, type, payload)
  const outcome = await pollAdminCommand(id, opts)
  if (outcome.kind === "timeout") throw new Error("timeout")
  if (outcome.kind === "error") throw new Error(outcome.message)
  const cmd = outcome.command
  const err = (cmd.result as { error?: unknown } | null | undefined)?.error
  if (cmd.status !== "success" || typeof err === "string") {
    throw new Error(typeof err === "string" ? err : `${type} ${cmd.status}`)
  }
  return cmd
}

/** HTTP poll until the command is terminal, the timeout elapses, or `signal` aborts. */
export async function pollAdminCommand(
  commandId: string,
  opts: { signal: AbortSignal; timeoutMs?: number; intervalMs?: number }
): Promise<PollCommandOutcome> {
  const timeoutMs = opts.timeoutMs ?? COMMAND_POLL_TIMEOUT_MS
  const intervalMs = opts.intervalMs ?? COMMAND_POLL_MS
  const started = Date.now()
  try {
    while (!opts.signal.aborted) {
      if (Date.now() - started >= timeoutMs) return { kind: "timeout" }
      const data = await api<{ command: AdminCommandRow }>(`/api/v1/admin/commands/${commandId}`, {
        signal: opts.signal,
      })
      const cmd = data.command
      if (cmd.status === "success" || cmd.status === "failed" || cmd.status === "cancelled") {
        return { kind: "settled", command: cmd }
      }
      await sleep(intervalMs, opts.signal)
    }
    return { kind: "error", message: "aborted" }
  } catch (error) {
    if (isAbortError(error) || opts.signal.aborted) return { kind: "error", message: "aborted" }
    return { kind: "error", message: error instanceof Error ? error.message : "poll failed" }
  }
}
