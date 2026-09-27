# Mnag.pt

Greenfield rewrite: Next.js dashboard, Fastify API, SQLite, Go agent + helper. **Version 3.3.0.**

**Masria Code** · [Contact@Mnag.pt.com](mailto:Contact@Mnag.pt.com) · [https://Mnag.pt](https://Mnag.pt)

## Local (pnpm)

From this repo (`F:/ServerAdmin` or your clone — not `cd pc-manager`):

```bash
cp .env.example .env
pnpm install
pnpm --filter @workspace/db generate
pnpm --filter @workspace/db exec prisma migrate deploy
pnpm --filter api dev      # :4000
pnpm --filter web dev      # :3000  (proxies /api to the API)
```

On **Windows**, `pnpm --filter web dev` uses webpack (`scripts/dev.mjs`). Turbopack can panic on `F:\` + pnpm (`Next.js package not found`). Use `pnpm --filter web dev:webpack` anywhere, or keep Turbopack on Linux/mac via the same `dev` script.

Agent (run from `apps/agent` so `config.yaml` is found; empty `enrollment_secret` is fatal before enroll):

```bash
cd apps/agent
cp config.example.yaml config.yaml
# set enrollment_secret to match ENROLLMENT_SECRET
make run
# or: go run ./cmd/agent run
```

`go run .\main.go` from `apps/agent/cmd/agent` now walks parent directories for `config.yaml`. Empty YAML `data_dir: ""` keeps `~/.pc-manager`.

Helper (optional watchdog, ~45s loopback probe):

```bash
cd apps/helper
go run ./cmd/helper
```

Open http://localhost:3000

## Docker

```bash
cd deploy
cp .env.example .env
# set ENROLLMENT_SECRET to a unique value (≥16 chars, not change-me-*)
# production should also set OPERATOR_TOKEN, UPDATE_SIGNING_SECRET, TRUST_PROXY=1
docker compose up --build
```

Caddy terminates TLS when `SITE_ADDRESS` is a real DNS name. For localhost it serves HTTP.

The API image runs with `NODE_ENV=production` and **will not start** if `ENROLLMENT_SECRET` is missing, shorter than 16 characters, or still a `change-me-*` placeholder.

## Access model

There is an **optional dashboard login** (SQLite operator password, Settings → Security). Until a password exists, treat the UI as an operator console on a private network (VPN, Caddy, or `IP_ALLOWLIST`). Set **`OPERATOR_TOKEN`** on the API and **`NEXT_PUBLIC_OPERATOR_TOKEN`** on the dashboard before exposing the LAN — production still needs that token (and `TURN_URL` for WAN desktop). If `OPERATOR_TOKEN` is unset and no password is stored, the API logs a warning and allows admin routes (local dev). Socket.io uses the same session cookie or token.

Agents enroll with `ENROLLMENT_SECRET`. The server stores a peppered HMAC of a per-device key (`X-Enrollment-Key`). Re-registering an existing `deviceId` with a matching key updates hostname/platform/version only. Same hostname+platform without a key returns **409 `device_exists`** instead of a second row. On the device page, **Reset enrollment** (or `POST /api/v1/admin/devices/:id/reset-enrollment`) clears the key so the next enroll can reclaim that device.

## Transport

Idle agents keep **one WebSocket** (`/agent-ws`) with ~90s thin heartbeats. HTTP long-poll is used only if the WS is down. GPU/temps/WebRTC collectors default off. Helper probes loopback `/status` about every 45s.

WebRTC across NATs: set **`TURN_URL`** and **`TURN_SECRET`** (coturn `use-auth-secret`). See Settings / admin meta.

## Docs

- [docs/server.md](docs/server.md) — Docker, Caddy, volumes, backup, heartbeat response, mesh CA, TURN warning
- [docs/agent.md](docs/agent.md) — install, WS-first transport, notify pipe, mesh 17891, native Windows commands
- [docs/helper.md](docs/helper.md) — watchdog sidecar
- [docs/operator.md](docs/operator.md) — dashboard tour, mesh policy, Network, toasts, Windows tools, operator login, E2E persist note
