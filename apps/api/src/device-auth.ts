import type { FastifyRequest } from "fastify"
import { prisma, type Device } from "@workspace/db"

import { deviceKeyMatches, hashDeviceKey } from "./lib.js"

export async function deviceFromIdAndKey(deviceId: string, key: string): Promise<Device | null> {
  const device = await prisma.device.findUnique({ where: { id: deviceId } })
  if (!device) return null
  if (!deviceKeyMatches(device.enrollmentKeyHash, key)) return null
  const preferred = hashDeviceKey(key)
  if (device.enrollmentKeyHash !== preferred) {
    await prisma.device.update({ where: { id: device.id }, data: { enrollmentKeyHash: preferred } })
    device.enrollmentKeyHash = preferred
  }
  return device
}

export async function deviceFromHeaders(req: FastifyRequest): Promise<Device | null> {
  const deviceId = req.headers["x-device-id"]
  const key = req.headers["x-enrollment-key"]
  if (typeof deviceId !== "string" || typeof key !== "string") return null
  return deviceFromIdAndKey(deviceId, key)
}
