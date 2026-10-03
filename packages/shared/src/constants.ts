export const APP_NAME = "Mnag.pt"
export const APP_VERSION = "3.4.0"
export const APP_AUTHOR = "Masria Code"
export const APP_EMAIL = "Contact@Mnag.pt.com"
export const APP_SITE = "https://Mnag.pt"
export const APP_DESCRIPTION = "Remote management: dashboard, agent, inventory, scans, and optional public tunnels"
export const API_PREFIX = "/api/v1"
export const WS_PATH = "/ws"
export const AGENT_WS_PATH = "/agent-ws"

export const PROCESS_CAP = 25
export const SERVICE_LIST_CAP = 2000
export const ADAPTER_LIST_CAP = 128
export const PORT_LIST_CAP = 2000
export const FIREWALL_RULE_CAP = 1500
export const TASK_LIST_CAP = 1500
export const CAPABILITY_LIST_CAP = 500
export const REGISTRY_LIST_CAP = 500
export const REGISTRY_VALUE_MAX_BYTES = 8192
export const WINDOWS_AGENT_SERVICE = "PCManagerAgent"
export const WINDOWS_HELPER_SERVICE = "PCManagerHelper"
export const REGISTRY_AGENT_KEY_PATH = "SOFTWARE\\PC Manager\\Agent"
export const SCRIPT_STDOUT_CAP = 65_536
export const SCRIPT_TIMEOUT_MS = 60_000

export const DEFAULT_HEARTBEAT_SEC = 90
export const DEFAULT_IDLE_HEARTBEAT_SEC = 90
export const DEFAULT_WATCHED_HEARTBEAT_SEC = 15
export const DEFAULT_POLL_SEC = 15
export const COMMAND_LONG_POLL_SEC = 25

export const HEARTBEAT_EXTRAS_MAX_BYTES = 32_768
export const COMMAND_RESULT_MAX_BYTES = 256 * 1024
export const MAX_CREATE_COMMAND_DEVICES = 500
export const DEFAULT_COMMAND_TIMEOUT_MIN = 15
export const COMMAND_TIMEOUT_GRACE_MS = 15_000
export const DEFAULT_WATCH_INTERVAL_MS = 1000
export const DEFAULT_WATCH_DURATION_MIN = 60
export const MAX_WATCH_DURATION_MIN = 240
export const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024
export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024
export const MAX_UPDATE_BYTES = 100 * 1024 * 1024

/** HTTP multipart stays for files at or under this size; larger files use agent-ws chunks. */
export const FILE_HTTP_FALLBACK_MAX = 1 * 1024 * 1024
export const FILE_CHUNK_SIZE = 1 * 1024 * 1024
/** zstd is used when the source file (or uncompressed chunk) is larger than this. */
export const FILE_CHUNK_ZSTD_MIN = 1 * 1024 * 1024

/** Dest agent TCP listen port for operator-ticketed LAN file copy. */
export const PEER_LAN_PORT = 17891
/** Source gives up dialing LAN and falls back to API upload/download. */
export const PEER_DIAL_TIMEOUT_MS = 3_000
/** Dest wait for an inbound LAN connect before returning listen_timeout. */
export const PEER_LISTEN_TIMEOUT_MS = 20_000
export const PEER_TICKET_TTL_SEC = 600
export const PEER_LAN_ADDRS_MAX = 16

/** LAN mesh mDNS service type (phase A). */
export const MESH_MDNS_SERVICE = "_mnag._tcp"
/** Device mesh cert lifetime. Stolen-offline identity dies at expiry. */
export const MESH_CERT_TTL_DAYS = 30
/** Re-issue on hello when remaining validity is below this. */
export const MESH_CERT_REFRESH_DAYS = 7
export const MESH_DEVICE_URI_PREFIX = "urn:mnag:device:"
/** UDP discovery beacon (same port as TCP peer files). */
export const MESH_BEACON_PORT = PEER_LAN_PORT
export const MESH_BEACON_MAGIC = "MNAGB1"
/** Operator forward-to-peer confirm; stored on the source command payload. */
export const MESH_FORWARD_KEY = "meshForward"

export const DEFAULT_STUN_URL = "stun:stun.l.google.com:19302"
export const E2E_HKDF_INFO = "pc-manager-e2e-v1"
export const E2E_HKDF_SALT_LEN = 32
export const E2E_SESSION_TIMEOUT_MS = 15_000
export const OPERATOR_SESSION_COOKIE = "pc_operator_session"
export const OPERATOR_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000
/** ICE/E2E signaling metadata TTL in SQLite. Secrets stay on browser + agent. */
export const REMOTE_SESSION_TTL_MS = 8 * 60 * 60 * 1000
