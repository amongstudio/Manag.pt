import type { FastifyInstance } from "fastify"
import { WS_FLEET_ROOM, wsDeviceRoom, type WsEvent } from "@workspace/shared"

/** Fleet-scoped events: every attached operator socket. */
export function emitFleet(app: FastifyInstance, event: WsEvent, payload: unknown): void {
  app.io.to(WS_FLEET_ROOM).emit(event, payload)
}

/** Device-scoped events: only sockets that attached this device. */
export function emitDevice(app: FastifyInstance, deviceId: string, event: WsEvent, payload: unknown): void {
  app.io.to(wsDeviceRoom(deviceId)).emit(event, payload)
}

/** Union of fleet + that device's room (status, commands, coalesced stats). */
export function emitFleetAndDevice(
  app: FastifyInstance,
  deviceId: string,
  event: WsEvent,
  payload: unknown
): void {
  app.io.to([WS_FLEET_ROOM, wsDeviceRoom(deviceId)]).emit(event, payload)
}
