import fsp from "node:fs/promises"
import path from "node:path"

import type { FastifyInstance } from "fastify"
import { prisma } from "@workspace/db"
import {
  FILE_CHUNK_SIZE,
  WS_EVENTS,
  type FileChunk,
} from "@workspace/shared"

import { env, dataPath } from "./env.js"
import { emitDevice } from "./io-emit.js"
import { pathExists, randomToken } from "./lib.js"
import { hasE2ESession } from "./e2e-relay.js"
import { planUploadInit } from "./command-policy.js"
import { zstdCompress, zstdDecompress } from "./zstd.js"

function emitProgress(
  app: FastifyInstance,
  deviceId: string,
  row: { id: string; offset: number; size: number; status: string; direction?: string; remotePath?: string }
): void {
  emitDevice(app, deviceId, WS_EVENTS.FILE_PROGRESS, {
    deviceId,
    id: row.id,
    offset: row.offset,
    size: row.size,
    status: row.status,
    direction: row.direction,
    remotePath: row.remotePath,
  })
}

export function emitFileProgress(
  app: FastifyInstance,
  deviceId: string,
  row: { id: string; offset: number; size: number; status: string; direction?: string; remotePath?: string }
): void {
  emitProgress(app, deviceId, row)
}

export async function initUploadTransfer(deviceId: string, remotePath: string, size: number) {
  if (!Number.isFinite(size) || size < 0 || size > env.maxUploadBytes) {
    throw new Error("too_large")
  }
  const existing = await prisma.fileInfo.findFirst({
    where: { deviceId, direction: "upload", remotePath, status: "transferring" },
    orderBy: { createdAt: "desc" },
  })
  if (existing) {
    if (planUploadInit(existing.size, size) === "resume") return existing
    await fsp.truncate(existing.localPath, 0).catch(() => undefined)
    return prisma.fileInfo.update({
      where: { id: existing.id },
      data: { size, offset: 0, status: "transferring" },
    })
  }
  const destDir = dataPath("files", deviceId)
  await fsp.mkdir(destDir, { recursive: true })
  const dest = path.join(destDir, `${randomToken(16)}-${path.basename(remotePath)}`)
  await fsp.writeFile(dest, Buffer.alloc(0))
  return prisma.fileInfo.create({
    data: {
      deviceId,
      direction: "upload",
      localPath: dest,
      remotePath,
      size,
      offset: 0,
      status: "transferring",
    },
  })
}

export async function getTransfer(deviceId: string, id: string) {
  return prisma.fileInfo.findFirst({ where: { id, deviceId } })
}

export async function ingestUploadChunk(
  app: FastifyInstance,
  deviceId: string,
  header: FileChunk,
  payload: Uint8Array
): Promise<FileChunk> {
  if (hasE2ESession(deviceId)) {
    return {
      type: "file_chunk",
      transferId: header.transferId,
      offset: header.offset,
      length: 0,
      action: "error",
      message: "e2e_active",
    }
  }
  const row = await prisma.fileInfo.findFirst({
    where: { id: header.transferId, deviceId, direction: "upload" },
  })
  if (row && header.action === "reset") {
    await fsp.truncate(row.localPath, 0).catch(() => undefined)
    const updated = await prisma.fileInfo.update({
      where: { id: row.id },
      data: { offset: 0, status: "transferring" },
    })
    emitProgress(app, deviceId, updated)
    return {
      type: "file_chunk",
      transferId: updated.id,
      offset: 0,
      length: 0,
      totalSize: updated.size,
      action: "ack",
      direction: "upload",
    }
  }
  if (!row) {
    return {
      type: "file_chunk",
      transferId: header.transferId,
      offset: header.offset,
      length: 0,
      action: "error",
      message: "not_found",
    }
  }
  let data = Buffer.from(payload)
  if (header.codec === "zstd") {
    try {
      data = Buffer.from(zstdDecompress(data))
    } catch {
      return {
        type: "file_chunk",
        transferId: row.id,
        offset: row.offset,
        length: 0,
        action: "error",
        message: "zstd_decode_failed",
      }
    }
  }
  if (header.offset < row.offset) {
    return {
      type: "file_chunk",
      transferId: row.id,
      offset: row.offset,
      length: 0,
      totalSize: row.size,
      action: "ack",
      final: row.status === "complete",
    }
  }
  if (header.offset > row.offset) {
    return {
      type: "file_chunk",
      transferId: row.id,
      offset: row.offset,
      length: 0,
      action: "error",
      message: "offset_mismatch",
    }
  }
  const next = header.offset + data.length
  if (next > env.maxUploadBytes) {
    return {
      type: "file_chunk",
      transferId: row.id,
      offset: row.offset,
      length: 0,
      action: "error",
      message: "too_large",
    }
  }
  const fh = await fsp.open(row.localPath, "r+")
  try {
    await fh.write(data, 0, data.length, header.offset)
  } finally {
    await fh.close()
  }
  const total = Math.max(row.size, header.totalSize ?? 0, next)
  const done = Boolean(header.final) || (total > 0 && next >= total)
  const updated = await prisma.fileInfo.update({
    where: { id: row.id },
    data: {
      offset: next,
      size: total,
      status: done ? "complete" : "transferring",
    },
  })
  emitProgress(app, deviceId, updated)
  return {
    type: "file_chunk",
    transferId: updated.id,
    offset: updated.offset,
    length: data.length,
    totalSize: updated.size,
    action: "ack",
    final: done,
    direction: "upload",
  }
}

export async function readDownloadChunk(
  app: FastifyInstance,
  deviceId: string,
  header: FileChunk
): Promise<{ header: FileChunk; payload: Uint8Array } | { error: FileChunk }> {
  if (hasE2ESession(deviceId)) {
    return {
      error: {
        type: "file_chunk",
        transferId: header.transferId,
        offset: header.offset,
        length: 0,
        action: "error",
        message: "e2e_active",
      },
    }
  }
  const id = header.fileId || header.transferId
  const row = await prisma.fileInfo.findFirst({
    where: { id, deviceId, direction: "download" },
  })
  if (!row || !(await pathExists(row.localPath))) {
    return {
      error: {
        type: "file_chunk",
        transferId: header.transferId,
        offset: header.offset,
        length: 0,
        action: "error",
        message: "not_found",
      },
    }
  }
  const offset = header.offset
  if (offset < 0 || offset > row.size) {
    return {
      error: {
        type: "file_chunk",
        transferId: row.id,
        offset: row.offset,
        length: 0,
        action: "error",
        message: "offset_mismatch",
      },
    }
  }
  const rawLen = header.length && header.length > 0 ? header.length : FILE_CHUNK_SIZE
  const want = Math.min(Math.max(0, rawLen), FILE_CHUNK_SIZE, Math.max(0, row.size - offset))
  const buf = Buffer.alloc(want)
  const fh = await fsp.open(row.localPath, "r")
  let n = 0
  try {
    const result = await fh.read(buf, 0, want, offset)
    n = result.bytesRead
  } finally {
    await fh.close()
  }
  const slice = buf.subarray(0, n)
  const next = offset + n
  const done = next >= row.size || n === 0
  const updated = await prisma.fileInfo.update({
    where: { id: row.id },
    data: {
      offset: next,
      status: done ? "complete" : "transferring",
    },
  })
  emitProgress(app, deviceId, updated)
  let payload: Uint8Array = slice
  let codec: FileChunk["codec"] = "none"
  if (row.size > FILE_CHUNK_SIZE) {
    const compressed = zstdCompress(slice)
    if (compressed) {
      payload = compressed
      codec = "zstd"
    }
  }
  return {
    header: {
      type: "file_chunk",
      transferId: row.id,
      fileId: row.id,
      offset,
      length: n,
      totalSize: row.size,
      final: done,
      codec,
      direction: "download",
      action: "data",
    },
    payload,
  }
}
