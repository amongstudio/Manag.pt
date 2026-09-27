import { createWriteStream } from "node:fs"
import fsp from "node:fs/promises"
import type { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

export function isFileTooLargeError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const err = error as { message?: string; code?: string }
  return err.message === "file_too_large" || err.code === "FST_REQ_FILE_TOO_LARGE"
}

export async function readMultipartFile<T>(getFile: () => Promise<T | undefined>): Promise<
  { ok: true; file: T | undefined } | { ok: false; tooLarge: true }
> {
  try {
    return { ok: true, file: await getFile() }
  } catch (error) {
    if (isFileTooLargeError(error)) return { ok: false, tooLarge: true }
    throw error
  }
}

export async function writeUploadStream(
  source: Readable,
  dest: string,
  options?: { maxBytes?: number; onChunk?: (chunk: Buffer) => void }
): Promise<number> {
  let size = 0
  try {
    await pipeline(
      source,
      async function* (chunks) {
        for await (const chunk of chunks) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
          size += buf.length
          if (options?.maxBytes != null && size > options.maxBytes) {
            throw new Error("file_too_large")
          }
          options?.onChunk?.(buf)
          yield buf
        }
      },
      createWriteStream(dest)
    )
    return size
  } catch (error) {
    await fsp.unlink(dest).catch(() => undefined)
    throw error
  }
}
