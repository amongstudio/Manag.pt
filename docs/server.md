# Server deploy

Mnag.pt **3.3.0** by Masria Code. Contact: [Contact@Mnag.pt.com](mailto:Contact@Mnag.pt.com) · [https://Mnag.pt](https://Mnag.pt). Apply Prisma migrations through `0015_device_credentials` when upgrading (`0014_operator_sessions`, then `0015_device_credentials`).

From the repo root:

```
pnpm --filter @workspace/db exec prisma migrate deploy
```

That applies every pending folder under `packages/db/prisma/migrations` to `DATABASE_URL` (local SQLite is `file:../../data/pcmanager.db` from `packages/db`). Restart the API after migrate so chat, mesh CA, operator sessions, and persisted remote-session rows load.

## Docker Compose

From `deploy/`:

1. Copy `.env.example` to `.env` and set `ENROLLMENT_SECRET`, `UPDATE_SIGNING_SECRET`, and `PUBLIC_URL`.
2. **Production must set `OPERATOR_TOKEN`** (and the same value as `NEXT_PUBLIC_OPERATOR_TOKEN` for the dashboard, or use the SQLite operator login). If unset and no operator password exists, admin HTTP and Socket.io stay open and the API logs a warning.
3. `ENROLLMENT_SECRET` must be at least 16 characters and must not start with `change-me-`. The API container uses `NODE_ENV=production` and exits on a placeholder secret.
4. Point `SITE_ADDRESS` at your DNS name (Caddy issues TLS) or `localhost` for HTTP.
5. Keep `CORS_ORIGIN` explicit (not `*`).
6. `TRUST_PROXY=1` means **one** reverse-proxy hop (Caddy), not “trust all X-Forwarded-For”.
7. Optional: `IP_ALLOWLIST` (exact IPs or CIDRs), `DEVICE_KEY_PEPPER` (else `UPDATE_SIGNING_SECRET` peppers device keys; old SHA-256 hashes still verify), `TURN_URL` + `TURN_SECRET`, `MESH_CA` / `MESH_CA_KEY` (else the mesh CA is derived from `UPDATE_SIGNING_SECRET`).
8. `docker compose up --build -d`
9. Data lives in the `pcmanager_data` volume at `/data` (`pcmanager.db`, `files/`, `screenshots/`, `updates/`, `backups/`). SQLite runs in WAL mode.

Reverse proxy map:

- `/` → Next.js web
- `/api/*` and `/ws` → Fastify API

Single API replica (SQLite). Do not scale the API horizontally without moving off SQLite. Operator login, E2E/WebRTC signaling metadata, and chat threads all live in that one file — this is not multi-replica HA.

Healthchecks: API `GET /healthz` on 4000; web HTTP on 3000. Agents skip `/healthz` while the WebSocket is connected.

Caddy sends `X-Frame-Options DENY`, `X-Content-Type-Options nosniff`, `Referrer-Policy`, and `Permissions-Policy`.

The dashboard can use an optional SQLite operator password (`POST /api/v1/admin/auth/setup` then `/login`). Until a password exists, put the UI behind VPN, Caddy, `OPERATOR_TOKEN`, or `IP_ALLOWLIST`. Agent enrollment (`ENROLLMENT_SECRET` + hashed device keys) stays required. Mesh stays **off** until you opt in. WAN desktop still needs `TURN_URL`.

## Heartbeat response

Heartbeats are **presence only**. The API updates `Device.lastSeen` and `status`; it does **not** insert `Stat` rows. `cpu` / `ram` / `disk` / `extras` / `processes` on the body are ignored (older agents may still send them). An empty JSON object is a valid HTTP heartbeat. HTTP `POST /api/v1/agent/heartbeat` is the fallback when WS is down. Ack:

```json
{
  "ok": true,
  "serverTime": "2026-08-26T01:00:00.000Z",
  "watch": { "intervalMs": 1000 },
  "agentConfig": {
    "heartbeatIntervalSec": 90,
    "pollIntervalSec": 15,
    "screenshotIntervalSec": 0,
    "autoRestartTime": "",
    "sandboxRoots": [],
    "lightweight": true,
    "idleHeartbeatSec": 90,
    "watchedHeartbeatSec": 15,
    "maxUploadBytes": 536870912
  }
}
```

`watch` is `null` unless `Device.watchUntil` is in the future (`start_watch` / `stop_watch`). `agentConfig` comes from Settings → Agent defaults.

`GET /api/v1/admin/overview` returns fleet counts (`devices`, `online`, `offline`), `pendingAlerts` (outbound Telegram/Discord/SMTP still `pending`), recent `activity` (commands), and recent `alerts` (last 20 `channel=socket` rows). It does not return `avgCpu` / `avgRam` / `avgDisk` / `series`.

Errors on agent and admin routes use `{ "error": "...", "details": ... }`. Command failures are logged with `deviceId` (no secrets).

## Queue

- `GET /api/v1/admin/commands` — list (`deviceId`, `status`, cursor)
- `GET /api/v1/admin/commands/:id` — one command (file explorer HTTP poll)
- `POST /api/v1/admin/commands/:id/cancel` — pending only
- `POST /api/v1/admin/commands/:id/retry` — clone failed/cancelled as pending
- Running commands older than `agent.commandTimeoutMin` (default 15) are marked `failed` with `{ "error": "timeout" }`
- `POST /api/v1/admin/devices/:id/reset-enrollment` — clear the device key so the next enroll without a key reclaims this hostname
- Screenshots: `DELETE /api/v1/admin/screenshots/:id`; `GET /api/v1/admin/devices/:id/screenshots?cursor&limit`
- `GET /api/v1/admin/devices/:id` — device plus last 40 commands/files, `lanAddrs` (parsed array) / `lanPort`, `lanPeers` (same /24 or matching public `ip`, labeled `likely`), and **`latestSuccessful`** `{ get_services, get_registry, get_adapters, get_ports, get_firewall, get_event_log, get_windows_update, get_admin_center, get_tasks, get_defender, get_bitlocker, get_capabilities, get_smb, get_credentials }` from dedicated success queries (not “hope it is in the last 40”)
- Credentials vault (operator auth): `GET /api/v1/admin/devices/:id/credentials` (metadata only), `GET .../credentials/:credId?reveal=1` (one AES-256-GCM secret), `POST .../credentials/backup` (`backup_credentials`), `POST .../credentials/generate` (`generate_credential`), `POST .../credentials/restore` (`restore_credentials`; skips browser NSS), `DELETE .../credentials/:credId` (vault copy only). Secrets are stripped from command history.

The `Stat` table is kept for leftover rows: older than 24 hours are downsampled; retention still deletes beyond `statsDays`. New heartbeats do not write stats.

## Alerts

`enqueueAlert` always persists a `channel=socket` row (status `sent`) and, when an app instance is passed, **emits** `WS_EVENTS.ALERT` `{ type, title, body, deviceId }` to every attached console. Outbound Telegram/Discord/SMTP rows are created separately when those channels are enabled. Cooldown still suppresses duplicate types.

## Copilot chat

OpenAI-compatible settings live in the app Settings JSON: `llm.baseUrl`, `llm.apiKey` (redacted on GET), `llm.model`. Empty `baseUrl` disables copilot. `PUT /api/v1/admin/settings` patches the `llm` section like other secrets (a `•` placeholder keeps the stored key).

- `GET /api/v1/admin/devices/:id/chats` — last 50 threads
- `POST /api/v1/admin/devices/:id/chats` — `{ title? }` (default `"New chat"`)
- `GET /api/v1/admin/devices/:id/chats/:threadId` — thread + messages (user / assistant / tool; `commandId` when a command was queued)
- `POST /api/v1/admin/devices/:id/chats/:threadId/messages` — `{ content }` (max 8000). Streams tokens on Socket.io `chat_delta`. Tools are existing inspection types plus `run_script`, `preview_file`, and `search_files`; module execution is excluded. Errors: `llm_not_configured`, `busy` (409), `rate_limited` (429), `pending_confirm` (409)
- `POST /api/v1/admin/devices/:id/chats/:threadId/confirm` — `{ toolCallId, confirmed }`

Migrations: **`0012_chat_threads`** (`ChatThread`, `ChatMessage`).

## Peer copy (LAN files)

Hello/heartbeat `lanAddrs` + `lanPort` are stored on **Device** (`lanAddrs` JSON text, `lanPort` int). Migration **`0013_lan_addrs`**.

`POST /api/v1/admin/devices/:id/peer-copy` `{ destDeviceId, srcPath, destPath }` requires both devices online. When `settings.mesh.enabled` is false, the API signs an HMAC-SHA256 ticket (`UPDATE_SIGNING_SECRET`) over `peer-copy-v1` + copyId + device ids + paths + exp (600s) + maxBytes + port + sorted addrs, then queues `peer_listen` (dest) and `peer_offer` (source). When mesh is on, those commands skip live tickets and use enrollment mesh certs on the dest persistent listener; source still falls back to API relay (`via: "relay"`) if the LAN dial fails. Sandbox `Resolve` still runs on the agents. Errors: `same_device`, `dest_not_found`, `src_offline`, `dest_offline`. Plugin blobs are never accepted from peers. Allowlisted `cmd` on the mesh uses the same executor as operator commands.

Enroll (`POST /api/v1/agent/register`) and `hello_ok` include a **mesh** bundle: PEM leaf cert (deviceId DNS + `urn:mnag:device:{id}` SAN), PKCS8 key, mesh CA, serial, `notAfter` (~30 days), and `revokedSerials`. The CA is `MESH_CA` / `MESH_CA_KEY` (PEM) or an ECDSA P-256 CA **derived from `UPDATE_SIGNING_SECRET`** when those env vars are empty. Keep `UPDATE_SIGNING_SECRET` stable or persist `MESH_CA` / `MESH_CA_KEY`; rotating the derived CA invalidates every agent mesh cert until the next hello. Reset enrollment revokes the device serial. `hello_ok` / `agentConfig.mesh` also pushes `enabled`, `wan`, and `allowCommands` (last-known policy on the agent while the API is down).

Allowlisted mesh `cmd` and WAN ICE between agents require `settings.mesh.enabled` (and `mesh.wan` + TURN for WAN). Unsigned LAN JSON and plugin blob push are refused.

## Interactive shell relay

Dashboard Socket.io events `shell_open`, `shell_data`, `shell_resize`, and `shell_close` (same names as agent-ws frames) are relayed to `/agent-ws` after the operator attaches to the device room (same `attach` as WebRTC). The agent sends the same frame types back into that room (`deviceId` added). One session per device: a new `shell_open` closes the previous PTY; operator disconnect/detach or agent drop emits `shell_close`. Payloads:

- `shell_open` `{ deviceId, cols?, rows?, shell?: "powershell"|"cmd" }`
- `shell_data` `{ deviceId, data }` (UTF-8 string, cap 262144 chars)
- `shell_resize` `{ deviceId, cols, rows }`
- `shell_close` `{ deviceId, reason? }`

## Operator login

`GET /api/v1/admin/auth/status` is public and returns `{ mode: "open"|"token"|"password", needsSetup }`. `POST /api/v1/admin/auth/setup` creates the first SQLite operator (scrypt hash). If `OPERATOR_TOKEN` is set, setup still requires that token. `POST /api/v1/admin/auth/login` sets HttpOnly `pc_operator_session` and returns the same token for Socket.io handshake (needed when the dashboard talks to the API on another origin/port). `GET /api/v1/admin/auth/me` and `POST /api/v1/admin/auth/logout` use that session. After a password exists, admin HTTP and Socket.io require a valid session **or** `OPERATOR_TOKEN`. Migration **`0014_operator_sessions`**.

## E2E / WebRTC signaling metadata

Operator↔agent E2E handshake **metadata** (session id, device id, public keys, last WebRTC signal kind) is persisted in SQLite `RemoteSession` with an 8-hour TTL so an API restart can keep relaying. Session secrets and ciphertext stay on the operator browser and the agent. This is not multi-replica HA — one SQLite file, one API process.

`GET /api/v1/admin/devices/:id/e2e/session` includes `webrtc: { active, lastKind, updatedAt }`.

## TURN

Set `TURN_URL` and `TURN_SECRET` (coturn `use-auth-secret`). The API mints time-limited credentials for the dashboard; the long-lived secret is never returned.

`GET /api/v1/admin/meta` includes `turnConfigured`. Settings shows a warning when **WAN mesh** is on and `TURN_URL` is empty: WAN mesh and remote desktop across NAT **fail closed** without TURN. LAN mTLS on 17891 still works. WebRTC desktop on the same LAN can use STUN alone.

## Backup / restore

Nightly API cron copies SQLite to `/data/backups`. Manual: Settings → Retention → Backup now, or `POST /api/v1/admin/backup`.

```bash
sqlite3 /data/pcmanager.db ".backup /data/backups/manual.db"
```

Restore: stop the API, replace `/data/pcmanager.db` (and `-wal` / `-shm` if present) with a backup file, start the API.

## Agent compile (Builder)

In-request `go build` on the API host. Off by default (`ENABLE_AGENT_COMPILE=0`). This is not Docker-in-Docker.

Local (from repo root, API cwd `apps/api`):

```
ENABLE_AGENT_COMPILE=1
# AGENT_SOURCE_DIR defaults to apps/agent (../agent from apps/api, or apps/agent from repo root)
# GO_BIN defaults to `go` on PATH
```

`POST /api/v1/admin/builder/compile` with `{ "platform", "arch", "version?", "lite?" }` starts one job (409 if another compile is running). Poll `GET /api/v1/admin/builder/compile` (latest) or `GET /api/v1/admin/builder/compile/:id`. The job view is `{ id, status, log, error, updateId }`. Success writes the binary into `/data/updates` and upserts `AgentUpdate` (same catalog as Settings → Agent binaries). Missing Go or sources return **400** with a hint, not 501. 501 means the feature flag is off.

Docker: bind-mount `apps/agent` into the API container and use a **Go-equipped** API image (`WITH_GO`). Example extras on the `api` service (do not add a Docker socket):

```
build:
  args:
    WITH_GO: "1"
environment:
  ENABLE_AGENT_COMPILE: "1"
  AGENT_SOURCE_DIR: /repo/apps/agent
volumes:
  - ../apps/agent:/repo/apps/agent:ro
```

The default `apps/api/Dockerfile` is Node-only. `WITH_GO=1` means installing a Go toolchain in that image (or using an image that already has `go`). Cross-compile uses `GOOS`/`GOARCH` with `CGO_ENABLED=0`.

## Volumes

| Path | Contents |
|---|---|
| `/data/pcmanager.db` | Prisma SQLite (WAL) |
| `/data/files` | Agent uploads |
| `/data/screenshots` | JPEG captures and watch stills |
| `/data/updates` | Agent binaries |
| `/data/backups` | Nightly DB copies (14-day retention) |
