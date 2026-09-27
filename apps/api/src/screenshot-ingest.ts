import fsp from "node:fs/promises"
import path from "node:path"

import type { FastifyInstance } from "fastify"
import { prisma, type Device } from "@workspace/db"
import { WS_EVENTS } from "@workspace/shared"

import { env, dataPath } from "./env.js"
import { emitDevice } from "./io-emit.js"
import { randomToken } from "./lib.js"
import { hasE2ESession } from "./e2e-relay.js"

export async function ingestScreenshotBytes(
  app: FastifyInstance,
  device: Device,
  bytes: Uint8Array
): Promise<{ id: string; size: number } | { skipped: "e2e" } | { error: "too_large" }> {
  if (bytes.byteLength > env.maxScreenshotBytes) return { error: "too_large" }
  if (hasE2ESession(device.id)) {
    app.log.warn({ deviceId: device.id }, "dropping plaintext screenshot while e2e session is active")
    return { skipped: "e2e" }
  }
  const destDir = dataPath("screenshots", device.id)
  await fsp.mkdir(destDir, { recursive: true })
  const id = randomToken(16)
  const dest = path.join(destDir, `${id}.jpg`)
  await fsp.writeFile(dest, bytes)
  const shot = await prisma.screenshot.create({
    data: { deviceId: device.id, path: dest, size: bytes.byteLength },
  })
  emitDevice(app, device.id, WS_EVENTS.SCREENSHOT_READY, { id: shot.id, deviceId: device.id, createdAt: shot.createdAt })
  return { id: shot.id, size: shot.size }
}
