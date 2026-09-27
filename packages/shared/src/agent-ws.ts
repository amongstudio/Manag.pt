import { z } from "zod"

import { commandResultSchema, heartbeatSchema, iceServerSchema } from "./schemas.ts"
import type { MeshBundle, MeshPolicy } from "./mesh.ts"

export const AGENT_WS_PROTOCOL_VERSION = 1
export const AGENT_WS_PING_INTERVAL_MS = 45_000
export const AGENT_WS_STALE_MS = 90_000
export const AGENT_WS_HELLO_TIMEOUT_MS = 10_000
export const AGENT_WS_FALLBACK_AFTER_FAILS = 3

/** Query param carrying the HMAC challenge. Never put deviceKey in the URL. */
export const AGENT_WS_NONCE_QUERY = "nonce"

/**
 * Nonces are server-issued: agents POST /api/v1/agent/ws-challenge (device auth
 * headers) to obtain one, then connect with ?nonce=... and prove
 * HMAC-SHA256(deviceKey, nonce) in hello.keyProof. Nonces are single-use and
 * expire after this many seconds.
 */
export const AGENT_WS_CHALLENGE_TTL_SEC = 60

export type WsChallengeResponse = {
  nonce: string
  expiresInSec: number
}

export const AGENT_WS_TYPE = {
  hello: "hello",
  hello_ok: "hello_ok",
  ping: "ping",
  pong: "pong",
  command: "command",
  command_ack: "command_ack",
  command_result: "command_result",
  heartbeat: "heartbeat",
  agent_config: "agent_config",
  screenshot_bin: "screenshot_bin",
  file_chunk: "file_chunk",
  webrtc_signal: "webrtc_signal",
  mesh_signal: "mesh_signal",
  mesh_relay: "mesh_relay",
  mesh_relay_result: "mesh_relay_result",
  e2e_envelope: "e2e_envelope",
  shell_open: "shell_open",
  shell_data: "shell_data",
  shell_resize: "shell_resize",
  shell_close: "shell_close",
  shell_exec: "shell_exec",
} as const

export type AgentWsType = (typeof AGENT_WS_TYPE)[keyof typeof AGENT_WS_TYPE]

export const AGENT_WS_BIN_TYPE = {
  screenshot_bin: 1,
  file_chunk: 2,
  e2e_envelope: 3,
  shell_data: 4,
} as const

export const SHELL_COLS_MAX = 512
export const SHELL_ROWS_MAX = 512
export const SHELL_DATA_MAX_CHARS = 262_144
export const SHELL_KINDS = ["powershell", "cmd"] as const
export type ShellKind = (typeof SHELL_KINDS)[number]
export const SHELL_EXEC_KINDS = ["powershell", "cmd", "sh"] as const
export type ShellExecKind = (typeof SHELL_EXEC_KINDS)[number]
export const SHELL_EXEC_COMMAND_MAX = 16_384

export const WEBRTC_ERROR = {
  disabled: "webrtc_disabled",
  noInteractiveSession: "no_interactive_session",
  unavailable: "webrtc_unavailable",
  agentOffline: "agent_offline",
  connectTimeout: "connect_timeout",
  noFrame: "no_frame",
} as const

export const SHELL_REASON = {
  unsupported: "unsupported",
  noInteractiveSession: "no_interactive_session",
  exit: "exit",
  replaced: "replaced",
  agentOffline: "agent_offline",
} as const

export type WebrtcErrorCode = (typeof WEBRTC_ERROR)[keyof typeof WEBRTC_ERROR]
export type ShellReason = (typeof SHELL_REASON)[keyof typeof SHELL_REASON]

export function h264FallbackLabel(reason: string): string {
  const key = reason.trim()
  if (key === WEBRTC_ERROR.disabled || key === "webrtc_disabled" || key === "enable_webrtc") {
    return "WebRTC is disabled on this agent (enable_webrtc is off). This is not a codec failure — use a Full remote builder stamp for live video."
  }
  if (key === "mf_class_missing") {
    return "Fell back to JPEG (Windows H.264 encoder is not installed). Install the Media Feature Pack on Windows N/KN."
  }
  if (key === "mf_transform_unavailable") {
    return "Fell back to JPEG (H.264 encoder is present but Media Foundation did not expose IMFTransform on this SKU or policy). JPEG capture stays active."
  }
  if (key === "h264 is Windows-only") {
    return "Fell back to JPEG (H.264 live video is Windows-only on this agent)."
  }
  if (key === "no_interactive_session") {
    return "Fell back to JPEG (no interactive session — the agent cannot capture the logged-on desktop)."
  }
  if (key === "frame_too_large") {
    return "Fell back to JPEG (frame was too large for H.264 encode)."
  }
  if (key === "capture_failed") {
    return "Fell back to JPEG (desktop capture failed while starting H.264)."
  }
  if (!key || key === "unknown") {
    return "Fell back to JPEG"
  }
  return `Fell back to JPEG (${key})`
}

export type AgentWsBinType = (typeof AGENT_WS_BIN_TYPE)[keyof typeof AGENT_WS_BIN_TYPE]

export const agentWsNonceSchema = z
  .string()
  .regex(/^[0-9a-f]{32,128}$/i, "invalid nonce")

export type Hello = {
  type: "hello"
  deviceId: string
  keyProof: string
  agentVersion?: string
  e2ePub?: string
  lanAddrs?: string[]
  lanPort?: number
  meshSerial?: string
}

export type AgentCaps = {
  zstd: boolean
  webrtc: boolean
  e2e: boolean
}

export type MeshPeerHint = {
  id: string
  lanAddrs: string[]
  ip?: string | null
  lanPort?: number | null
}

export type HelloOK = {
  type: "hello_ok"
  serverTime: string
  protocolVersion: number
  watch: { intervalMs: number } | null
  agentConfig: AgentConfig
  caps?: AgentCaps
  mesh?: MeshBundle
  iceServers?: WebrtcIceServer[]
  ip?: string
  meshPeers?: MeshPeerHint[]
}

export type Ping = {
  type: "ping"
  ts?: number
}

export type Pong = {
  type: "pong"
  ts?: number
}

export type Command = {
  type: "command"
  id: string
  cmdType: string
  payload: unknown
  createdAt: string
}

export type CommandAck = {
  type: "command_ack"
  id: string
}

export type CommandResult = {
  type: "command_result"
  commandId: string
  resultId: string
  status: "success" | "failed" | "cancelled" | "running"
  result?: unknown
  progress?: number
}

export type Heartbeat = {
  type: "heartbeat"
  cpu?: number
  ram?: number
  disk?: number
  gpu?: number
  temp?: number
  netUp?: number
  netDown?: number
  /** null is accepted on the wire (Go nil slice) and normalized to [] server-side. */
  processes?: Array<{ pid: number; name: string; cpu?: number; ram?: number }> | null
  extras?: Record<string, unknown>
  lanAddrs?: string[]
  lanPort?: number
}

export type AgentConfig = {
  heartbeatIntervalSec: number
  pollIntervalSec: number
  screenshotIntervalSec: number
  autoRestartTime: string
  sandboxRoots: string[]
  lightweight: boolean
  idleHeartbeatSec: number
  watchedHeartbeatSec: number
  /** Server-enforced transfer cap (bytes). Agents apply this from hello_ok / agent_config. */
  maxUploadBytes: number
  mesh?: MeshPolicy
}

export type AgentConfigFrame = {
  type: "agent_config"
  serverTime: string
  watch: { intervalMs: number } | null
  agentConfig: AgentConfig
  iceServers?: WebrtcIceServer[]
  ip?: string
  meshPeers?: MeshPeerHint[]
}

export type MeshSignalKind = "offer" | "answer" | "ice" | "hangup"

export type MeshSignalPayload = {
  sessionId: string
  to: string
  from?: string
  kind: MeshSignalKind
  sdp?: string
  sdpType?: "offer" | "answer"
  candidate?: unknown
}

export type MeshSignal = {
  type: "mesh_signal"
  payload: MeshSignalPayload
}

export type MeshRelay = {
  type: "mesh_relay"
  to: string
  from?: string
  cmdType: string
  payload?: unknown
  resultId: string
}

export type MeshRelayResult = {
  type: "mesh_relay_result"
  to: string
  from?: string
  resultId: string
  status: "success" | "failed"
  result?: unknown
}

export type ScreenshotBin = {
  contentType?: string
}

export const FILE_CHUNK_CODEC = {
  none: "none",
  zstd: "zstd",
} as const

export type FileChunkCodec = (typeof FILE_CHUNK_CODEC)[keyof typeof FILE_CHUNK_CODEC]

export const FILE_CHUNK_ACTION = {
  data: "data",
  ack: "ack",
  request: "request",
  init: "init",
  reset: "reset",
  error: "error",
} as const

export type FileChunkAction = (typeof FILE_CHUNK_ACTION)[keyof typeof FILE_CHUNK_ACTION]

export type FileChunk = {
  type?: "file_chunk"
  transferId: string
  offset: number
  length: number
  totalSize?: number
  final?: boolean
  codec?: FileChunkCodec
  direction?: "upload" | "download"
  action?: FileChunkAction
  remotePath?: string
  fileId?: string
  message?: string
}

export type FileChunkFrame = FileChunk & { type: "file_chunk" }

export type WebrtcSignalKind = "offer" | "answer" | "ice" | "hangup" | "control"

export type WebrtcIceServer = {
  urls: string | string[]
  username?: string
  credential?: string
}

export type WebrtcDesktopCodec = "jpeg" | "h264"

export type WebrtcSignalPayload = {
  kind: WebrtcSignalKind
  sdp?: string
  sdpType?: "offer" | "answer"
  candidate?: unknown
  allowInput?: boolean
  encrypted?: boolean
  iceServers?: WebrtcIceServer[]
  fps?: number
  quality?: number
  display?: number
  maxWidth?: number
  /** Live encode path. Default jpeg (datachannel). h264 is Windows-only. */
  codec?: WebrtcDesktopCodec
  /** Optional WASAPI loopback → Opus. Windows-only; ignored elsewhere. */
  audio?: boolean
  /** Hangup / capture failure reason (e.g. no_interactive_session, webrtc_disabled). */
  reason?: string
  error?: string
}

export type WebrtcSignal = {
  type: "webrtc_signal"
  deviceId?: string
  payload: WebrtcSignalPayload
}

export type E2EKind = "screenshot" | "file_chunk" | "sdp"

export type E2EOffer = {
  action: "offer"
  sessionId: string
  operatorPub: string
}

export type E2EAnswer = {
  action: "answer"
  sessionId: string
  agentPub: string
}

export type E2EClose = {
  action: "close"
  sessionId: string
}

export type E2EData = {
  action: "data"
  sessionId: string
  kind: E2EKind
  nonce: string
  ciphertext: string
  aad?: string
}

export type E2EPayload = E2EOffer | E2EAnswer | E2EClose | E2EData

export type E2EEnvelope = {
  type: "e2e_envelope"
  deviceId?: string
  payload: E2EPayload
}

export type ShellOpen = {
  type: "shell_open"
  deviceId?: string
  cols?: number
  rows?: number
  shell?: ShellKind
}

export type ShellData = {
  type: "shell_data"
  deviceId?: string
  /** UTF-8 PTY bytes as a JSON string (stdin from dashboard, stdout from agent). */
  data: string
}

export type ShellResize = {
  type: "shell_resize"
  deviceId?: string
  cols: number
  rows: number
}

export type ShellClose = {
  type: "shell_close"
  deviceId?: string
  reason?: string
}

export type ShellExec = {
  type: "shell_exec"
  deviceId?: string
  id: string
  command?: string
  shell?: ShellExecKind
  data?: string
  done?: boolean
  exitCode?: number
  error?: string
}

export type AgentWsTextFrame =
  | Hello
  | HelloOK
  | Ping
  | Pong
  | Command
  | CommandAck
  | CommandResult
  | Heartbeat
  | AgentConfigFrame
  | FileChunkFrame
  | WebrtcSignal
  | MeshSignal
  | MeshRelay
  | MeshRelayResult
  | E2EEnvelope
  | ShellOpen
  | ShellData
  | ShellResize
  | ShellClose
  | ShellExec

export const helloSchema = z.object({
  type: z.literal("hello"),
  deviceId: z.string().min(1),
  keyProof: z.string().regex(/^[0-9a-f]{64}$/i),
  agentVersion: z.string().min(1).max(64).optional(),
  e2ePub: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
  lanAddrs: z.array(z.string().min(1).max(64)).max(16).nullable().optional(),
  lanPort: z.number().int().min(1).max(65535).optional(),
  meshSerial: z.string().min(1).max(128).optional(),
})

export const fileChunkHeaderSchema = z.object({
  type: z.literal("file_chunk").optional(),
  transferId: z.string().min(1),
  offset: z.number().int().nonnegative(),
  length: z.number().int().nonnegative().optional(),
  totalSize: z.number().int().nonnegative().optional(),
  final: z.boolean().optional(),
  codec: z.enum(["none", "zstd"]).optional(),
  direction: z.enum(["upload", "download"]).optional(),
  action: z.enum(["data", "ack", "request", "init", "reset", "error"]).optional(),
  remotePath: z.string().max(2048).optional(),
  fileId: z.string().min(1).optional(),
  message: z.string().max(500).optional(),
})

export const webrtcSignalPayloadSchema = z.object({
  kind: z.enum(["offer", "answer", "ice", "hangup", "control"]),
  sdp: z.string().max(100_000).optional(),
  sdpType: z.enum(["offer", "answer"]).optional(),
  candidate: z.unknown().optional(),
  allowInput: z.boolean().optional(),
  encrypted: z.boolean().optional(),
  iceServers: z.array(iceServerSchema).max(16).optional(),
  fps: z.number().min(1).max(30).optional(),
  quality: z.number().int().min(1).max(100).optional(),
  display: z.number().int().min(0).max(32).optional(),
  maxWidth: z.number().int().min(0).max(7680).optional(),
  codec: z.enum(["jpeg", "h264"]).optional(),
  audio: z.boolean().optional(),
  reason: z.string().max(500).optional(),
  error: z.string().max(200).optional(),
})

export const webrtcSignalFrameSchema = z.object({
  type: z.literal("webrtc_signal"),
  deviceId: z.string().min(1).optional(),
  payload: webrtcSignalPayloadSchema,
})

export const meshPeerHintSchema = z.object({
  id: z.string().min(1).max(128),
  lanAddrs: z.array(z.string().min(1).max(64)).max(16),
  ip: z.string().max(64).nullable().optional(),
  lanPort: z.number().int().min(1).max(65535).nullable().optional(),
})

export const meshSignalPayloadSchema = z.object({
  sessionId: z.string().min(1).max(128),
  to: z.string().min(1).max(128),
  from: z.string().min(1).max(128).optional(),
  kind: z.enum(["offer", "answer", "ice", "hangup"]),
  sdp: z.string().max(100_000).optional(),
  sdpType: z.enum(["offer", "answer"]).optional(),
  candidate: z.unknown().optional(),
})

export const meshSignalFrameSchema = z.object({
  type: z.literal("mesh_signal"),
  payload: meshSignalPayloadSchema,
})

export const meshRelayFrameSchema = z.object({
  type: z.literal("mesh_relay"),
  to: z.string().min(1).max(128),
  from: z.string().min(1).max(128).optional(),
  cmdType: z.string().min(1).max(64),
  payload: z.unknown().optional(),
  resultId: z.string().uuid(),
})

export const meshRelayResultFrameSchema = z.object({
  type: z.literal("mesh_relay_result"),
  to: z.string().min(1).max(128),
  from: z.string().min(1).max(128).optional(),
  resultId: z.string().uuid(),
  status: z.enum(["success", "failed"]),
  result: z.unknown().optional(),
})

export const e2ePayloadSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("offer"),
    sessionId: z.string().min(1),
    operatorPub: z.string().regex(/^[0-9a-f]{64}$/i),
  }),
  z.object({
    action: z.literal("answer"),
    sessionId: z.string().min(1),
    agentPub: z.string().regex(/^[0-9a-f]{64}$/i),
  }),
  z.object({
    action: z.literal("close"),
    sessionId: z.string().min(1),
  }),
  z.object({
    action: z.literal("data"),
    sessionId: z.string().min(1),
    kind: z.enum(["screenshot", "file_chunk", "sdp"]),
    nonce: z.string().min(1),
    ciphertext: z.string().min(1),
    aad: z.string().max(4096).optional(),
  }),
])

export const e2eEnvelopeFrameSchema = z.object({
  type: z.literal("e2e_envelope"),
  deviceId: z.string().min(1).optional(),
  payload: e2ePayloadSchema,
})

export const e2eBinHeaderSchema = z.object({
  sessionId: z.string().min(1),
  kind: z.enum(["screenshot", "file_chunk", "sdp"]),
  nonce: z.string().min(1),
  aad: z.string().max(4096).optional(),
})

export const pingSchema = z.object({
  type: z.literal("ping"),
  ts: z.number().optional(),
})

export const pongSchema = z.object({
  type: z.literal("pong"),
  ts: z.number().optional(),
})

export const commandAckSchema = z.object({
  type: z.literal("command_ack"),
  id: z.string().min(1),
})

export const commandResultFrameSchema = commandResultSchema.extend({
  type: z.literal("command_result"),
})

export const heartbeatFrameSchema = heartbeatSchema.extend({
  type: z.literal("heartbeat"),
})

const shellColsSchema = z.number().int().min(1).max(SHELL_COLS_MAX)
const shellRowsSchema = z.number().int().min(1).max(SHELL_ROWS_MAX)

export const shellOpenFrameSchema = z.object({
  type: z.literal("shell_open"),
  deviceId: z.string().min(1).optional(),
  cols: shellColsSchema.optional(),
  rows: shellRowsSchema.optional(),
  shell: z.enum(SHELL_KINDS).optional(),
})

export const shellDataFrameSchema = z.object({
  type: z.literal("shell_data"),
  deviceId: z.string().min(1).optional(),
  data: z.string().max(SHELL_DATA_MAX_CHARS),
})

export const shellResizeFrameSchema = z.object({
  type: z.literal("shell_resize"),
  deviceId: z.string().min(1).optional(),
  cols: shellColsSchema,
  rows: shellRowsSchema,
})

export const shellCloseFrameSchema = z.object({
  type: z.literal("shell_close"),
  deviceId: z.string().min(1).optional(),
  reason: z.string().max(500).optional(),
})

/** Socket.io dashboard → API (type may be omitted; deviceId is required). */
export const shellOpenClientSchema = shellOpenFrameSchema.extend({
  type: z.literal("shell_open").optional(),
  deviceId: z.string().min(1),
})

export const shellDataClientSchema = shellDataFrameSchema.extend({
  type: z.literal("shell_data").optional(),
  deviceId: z.string().min(1),
})

export const shellResizeClientSchema = shellResizeFrameSchema.extend({
  type: z.literal("shell_resize").optional(),
  deviceId: z.string().min(1),
})

export const shellCloseClientSchema = shellCloseFrameSchema.extend({
  type: z.literal("shell_close").optional(),
  deviceId: z.string().min(1),
})

export const shellExecFrameSchema = z.object({
  type: z.literal("shell_exec"),
  deviceId: z.string().min(1).optional(),
  id: z.string().min(1).max(128),
  command: z.string().max(SHELL_EXEC_COMMAND_MAX).optional(),
  shell: z.enum(SHELL_EXEC_KINDS).optional(),
  data: z.string().max(SHELL_DATA_MAX_CHARS).optional(),
  done: z.boolean().optional(),
  exitCode: z.number().int().optional(),
  error: z.string().max(500).optional(),
})

/** Socket.io dashboard → API: one-shot line (Browser shell). */
export const shellExecClientSchema = shellExecFrameSchema.extend({
  type: z.literal("shell_exec").optional(),
  deviceId: z.string().min(1),
  command: z.string().min(1).max(SHELL_EXEC_COMMAND_MAX),
})

/**
 * Binary frame: 1-byte type + uint16 BE JSON header length + header + payload.
 * Used for screenshot_bin, file_chunk, and optional shell_data (PTY bytes).
 */
export function encodeAgentWsBinary(
  binType: number,
  header: unknown,
  payload: Uint8Array
): Uint8Array {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header ?? {}))
  if (headerBytes.length > 0xffff) throw new Error("agent-ws header too large")
  const out = new Uint8Array(3 + headerBytes.length + payload.length)
  out[0] = binType & 0xff
  out[1] = (headerBytes.length >> 8) & 0xff
  out[2] = headerBytes.length & 0xff
  out.set(headerBytes, 3)
  out.set(payload, 3 + headerBytes.length)
  return out
}

export function decodeAgentWsBinary(data: Uint8Array): {
  binType: number
  header: unknown
  payload: Uint8Array
} {
  if (data.length < 3) throw new Error("agent-ws binary frame too short")
  const binType = data[0]!
  const headerLen = (data[1]! << 8) | data[2]!
  if (3 + headerLen > data.length) throw new Error("agent-ws binary header truncated")
  const headerJson = new TextDecoder().decode(data.subarray(3, 3 + headerLen))
  const header = headerJson ? (JSON.parse(headerJson) as unknown) : {}
  return { binType, header, payload: data.subarray(3 + headerLen) }
}
