import { resultErrorMessage } from "./command-result.ts"

export const LISTING_COMMAND_TYPES = ["get_files", "search_files"] as const

export type ListingCommandType = (typeof LISTING_COMMAND_TYPES)[number]

export type FileListEntry = {
  name: string
  path: string
  dir: boolean
  size: number
  mode?: string
  mtime?: string | number
  matches?: string[]
}

export type ParsedFileList = {
  path: string | undefined
  roots: string[]
  truncated: boolean
  entries: FileListEntry[]
}

export type ListingCommandSeed = {
  id: string
  type: string
  status: string
  result?: unknown
}

export type ListingInspect =
  | { kind: "inflight"; command: ListingCommandSeed }
  | { kind: "success"; command: ListingCommandSeed }
  | { kind: "failed"; command: ListingCommandSeed }
  | { kind: "none" }

export function isListingCommandType(type: string): type is ListingCommandType {
  return type === "get_files" || type === "search_files"
}

export function parseFileListResult(result: unknown): ParsedFileList {
  if (Array.isArray(result)) {
    return { path: undefined, roots: [], truncated: false, entries: result as FileListEntry[] }
  }
  if (!result || typeof result !== "object") {
    return { path: undefined, roots: [], truncated: false, entries: [] }
  }
  const o = result as {
    path?: unknown
    roots?: unknown
    truncated?: unknown
    entries?: unknown
    hits?: unknown
  }
  const entries = Array.isArray(o.entries)
    ? (o.entries as FileListEntry[])
    : Array.isArray(o.hits)
      ? (o.hits as FileListEntry[])
      : []
  const roots = Array.isArray(o.roots) ? o.roots.filter((r): r is string => typeof r === "string") : []
  return {
    path: typeof o.path === "string" ? o.path : undefined,
    roots,
    truncated: Boolean(o.truncated),
    entries,
  }
}

/** First matching row; callers should pass commands newest-first. */
export function inspectLatestListing(commands: ListingCommandSeed[]): ListingInspect {
  for (const command of commands) {
    if (!isListingCommandType(command.type)) continue
    if (command.status === "pending" || command.status === "running") {
      return { kind: "inflight", command }
    }
    if (command.status === "success") return { kind: "success", command }
    if (command.status === "failed" || command.status === "cancelled") {
      return { kind: "failed", command }
    }
  }
  return { kind: "none" }
}

export function latestSuccessfulListing(commands: ListingCommandSeed[]): ListingCommandSeed | undefined {
  return commands.find((c) => isListingCommandType(c.type) && c.status === "success")
}

export function queuedCommandId(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined
  const commands = (body as { commands?: unknown }).commands
  if (!Array.isArray(commands) || commands.length === 0) return undefined
  const id = (commands[0] as { id?: unknown } | undefined)?.id
  return typeof id === "string" && id ? id : undefined
}

export function listingFailureMessage(result: unknown, status: string): string {
  return resultErrorMessage(result, status, "Listing failed")
}

export function transferRemainingBytes(offset: number | undefined, size: number): number {
  if (!Number.isFinite(size) || size <= 0) return 0
  const used = typeof offset === "number" && Number.isFinite(offset) ? offset : 0
  return Math.max(0, size - used)
}
