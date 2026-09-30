import { z } from "zod"

/** Clipboard kinds on the desktop datachannel (`type: "clip"`) and helper pipe. */
export const CLIPBOARD_KIND = {
  text: "text",
  html: "html",
  image: "image",
  files: "files",
} as const

export type ClipboardKind = (typeof CLIPBOARD_KIND)[keyof typeof CLIPBOARD_KIND]

export const CLIPBOARD_TEXT_MAX = 256 * 1024
export const CLIPBOARD_HTML_MAX = 256 * 1024
export const CLIPBOARD_IMAGE_MAX = 512 * 1024
export const CLIPBOARD_FILES_MAX = 64

export type ClipboardImage = {
  mime: string
  data: string
  width?: number
  height?: number
}

export type ClipboardPayload = {
  type: "clip"
  kind: ClipboardKind
  text?: string
  html?: string
  image?: ClipboardImage
  files?: string[]
  at: number
  ok?: boolean
}

export const clipboardKindSchema = z.enum(["text", "html", "image", "files"])

/** Clip history kept per device in the dashboard (and on the agent ring). */
export const CLIPBOARD_HISTORY_MAX = 50

type ClipLike = {
  kind?: unknown
  text?: unknown
  html?: unknown
  image?: unknown
  files?: unknown
}

function imageFingerprint(image: unknown): string {
  const data =
    typeof image === "string"
      ? image
      : image &&
          typeof image === "object" &&
          typeof (image as { data?: unknown }).data === "string"
        ? (image as { data: string }).data
        : ""
  if (!data) return ""
  return `${data.length}:${data.slice(0, 64)}:${data.slice(-64)}`
}

/**
 * Content identity for a clip, ignoring timestamps and ids. Two polls of an
 * unchanged clipboard produce the same key, so history does not repeat.
 */
export function clipContentKey(clip: ClipLike): string {
  const kind = typeof clip.kind === "string" ? clip.kind : "text"
  const text = typeof clip.text === "string" ? clip.text : ""
  const html = typeof clip.html === "string" ? clip.html : ""
  const files = Array.isArray(clip.files)
    ? clip.files.filter((f) => typeof f === "string").join("\u0000")
    : ""
  return [kind, text, html, files, imageFingerprint(clip.image)].join("\u0001")
}

/**
 * Adds a clip to newest-first history. Unchanged content already at the top is
 * a no-op (same array returned), repeated content elsewhere moves to the top,
 * pinned entries are kept, and unpinned entries are capped at `max`.
 */
export function pushClipHistory<
  T extends ClipLike & { at: number; pinned?: boolean; id?: string },
>(items: T[], entry: T, max = CLIPBOARD_HISTORY_MAX): T[] {
  const key = clipContentKey(entry)
  const index = items.findIndex((item) => clipContentKey(item) === key)
  const firstUnpinned = items.findIndex((item) => !item.pinned)
  if (index !== -1 && (items[index]!.pinned || index === firstUnpinned))
    return items
  const previous = index > 0 ? items[index] : undefined
  const merged: T = previous ? ({ ...entry, id: previous.id } as T) : entry
  const rest = index > 0 ? items.filter((_, i) => i !== index) : items
  const next = [merged, ...rest]
  const pinned = next.filter((item) => item.pinned)
  const unpinned = next.filter((item) => !item.pinned).slice(0, max)
  return [...pinned, ...unpinned]
}

/** Clipboard command results may hold secrets; history/socket views only get a summary. */
export function isClipboardResultCommand(type: string): boolean {
  return type === "get_clipboard"
}

export function summarizeClipboardResult(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result))
    return result
  const row = result as Record<string, unknown>
  const history = Array.isArray(row.history) ? row.history.length : 0
  const summary: Record<string, unknown> = {
    redacted: true,
    history,
    hasCurrent: Boolean(row.current),
  }
  if (typeof row.error === "string") summary.error = row.error
  return summary
}

export const clipboardPayloadSchema = z.object({
  type: z.literal("clip"),
  kind: clipboardKindSchema,
  text: z.string().max(CLIPBOARD_TEXT_MAX).optional(),
  html: z.string().max(CLIPBOARD_HTML_MAX).optional(),
  image: z
    .object({
      mime: z.string().max(64),
      data: z.string().max(Math.ceil(CLIPBOARD_IMAGE_MAX * 1.4)),
      width: z.number().int().nonnegative().optional(),
      height: z.number().int().nonnegative().optional(),
    })
    .optional(),
  files: z.array(z.string().max(2048)).max(CLIPBOARD_FILES_MAX).optional(),
  at: z.number().int(),
  ok: z.boolean().optional(),
})
