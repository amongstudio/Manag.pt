export const WS_EVENTS = {
  DEVICE_STATUS: "device_status",
  COMMAND_QUEUED: "command_queued",
  COMMAND_RESULT: "command_result",
  ALERT: "alert",
  SCREENSHOT_READY: "screenshot_ready",
  WEBRTC_SIGNAL: "webrtc_signal",
  E2E_ENVELOPE: "e2e_envelope",
  FILE_PROGRESS: "file_progress",
  SHELL_OPEN: "shell_open",
  SHELL_DATA: "shell_data",
  SHELL_RESIZE: "shell_resize",
  SHELL_CLOSE: "shell_close",
  SHELL_EXEC: "shell_exec",
  CHAT_DELTA: "chat_delta",
} as const

export type WsEvent = (typeof WS_EVENTS)[keyof typeof WS_EVENTS]

/**
 * Client -> server Socket.io events. Dashboard sockets receive nothing until
 * they attach: `attach` with no deviceId / empty `deviceIds` joins the fleet
 * scope (device_status, command_queued, command_result, alert)
 * and leaves any previously joined device rooms; `attach` with a deviceId
 * joins that device's room (screenshot_ready, file_progress, webrtc_signal,
 * e2e_envelope, shell_open, shell_data, shell_resize, shell_close, shell_exec,
 * chat_delta, plus the fleet events for that device). Relaying webrtc_signal, e2e_envelope,
 * or shell_* to an agent requires membership in that device's room. One
 * interactive ConPTY session is allowed per device; shell_data / shell_resize /
 * shell_close are bound to the owning operator socket. shell_exec is line-oriented
 * and does not require an open ConPTY session.
 */
export const WS_CLIENT_EVENTS = {
  ATTACH: "attach",
  DETACH: "detach",
} as const

export type WsAttachPayload = { deviceId?: string | null; deviceIds?: string[] }
export type WsAttachAck = { ok: boolean; error?: string }

export const WS_FLEET_ROOM = "fleet"

export function wsDeviceRoom(deviceId: string): string {
  return `device:${deviceId}`
}
