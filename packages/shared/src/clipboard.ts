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
