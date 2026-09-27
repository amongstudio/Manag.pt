import zlib from "node:zlib"

import { FILE_CHUNK_ZSTD_MIN } from "@workspace/shared"
import { decompress as fzstdDecompress } from "fzstd"

type ZlibZstd = typeof zlib & {
  zstdCompressSync?: (buf: Uint8Array) => Buffer
  zstdDecompressSync?: (buf: Uint8Array) => Buffer
}

const z = zlib as ZlibZstd

export function zstdDecodeAvailable(): boolean {
  return typeof z.zstdDecompressSync === "function" || typeof fzstdDecompress === "function"
}

export function zstdEncodeAvailable(): boolean {
  return typeof z.zstdCompressSync === "function"
}

export function zstdDecompress(data: Uint8Array): Uint8Array {
  try {
    if (typeof z.zstdDecompressSync === "function") {
      return z.zstdDecompressSync(data)
    }
    return fzstdDecompress(data)
  } catch (error) {
    const err = new Error("zstd_decode_failed")
    err.cause = error
    throw err
  }
}

export function zstdCompress(data: Uint8Array): Uint8Array | null {
  const compress = z.zstdCompressSync
  if (typeof compress !== "function") return null
  if (data.length < FILE_CHUNK_ZSTD_MIN) return null
  const out = compress(data)
  if (out.length >= data.length) return null
  return out
}
