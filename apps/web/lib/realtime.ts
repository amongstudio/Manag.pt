import { WS_CLIENT_EVENTS, type WsAttachPayload } from "@workspace/shared"

/** Re-export of the shared attach event so the dashboard has one import site. */
export const RT_CLIENT_EVENTS = {
  ATTACH: WS_CLIENT_EVENTS.ATTACH,
  DETACH: WS_CLIENT_EVENTS.DETACH,
} as const

export type AttachPayload = WsAttachPayload & { deviceIds?: string[] }

export type RealtimeStatus = "connecting" | "online" | "reconnecting" | "offline"

export function realtimeStatusLabel(status: RealtimeStatus): string {
  switch (status) {
    case "connecting":
      return "Realtime connecting…"
    case "online":
      return "Live"
    case "reconnecting":
      return "Reconnecting…"
    case "offline":
      return "HTTP only"
  }
}
