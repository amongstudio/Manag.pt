import type { FastifyInstance } from "fastify"
import { prisma } from "@workspace/db"
import { validateCommandPayload, WS_EVENTS, type CommandType } from "@workspace/shared"

import { dispatchQueuedCommands } from "./agent-ws.js"
import { emitFleet } from "./io-emit.js"

export async function queueDeviceCommand(
  app: FastifyInstance,
  deviceId: string,
  type: CommandType,
  payload: Record<string, unknown>,
  actor: string
): Promise<{ id: string; type: string; status: string; deviceId: string }> {
  const checked = validateCommandPayload(type, payload)
  if (!checked.ok) {
    throw new Error("invalid_payload")
  }
  const command = await prisma.command.create({
    data: {
      deviceId,
      type,
      payload: JSON.stringify(checked.payload),
      createdBy: actor.slice(0, 128),
    },
  })
  await dispatchQueuedCommands(app, deviceId)
  emitFleet(app, WS_EVENTS.COMMAND_QUEUED, {
    id: command.id,
    deviceId,
    type,
    status: command.status,
  })
  return command
}
