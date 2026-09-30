# Getting started

## What you are running

Three processes:

- Dashboard (Next.js) on port **3000**
- API (Fastify) on port **4000**
- Optional Go agent on a device, plus an optional helper watchdog

The API stores state in SQLite at `data/pcmanager.db`.

## First run

From the repository root:

```bash
cp .env.example .env
pnpm install
pnpm --filter @workspace/db generate
pnpm --filter @workspace/db exec prisma migrate deploy
pnpm --filter api dev
pnpm --filter web dev
```

Open http://localhost:3000.

`ENROLLMENT_SECRET` in `.env.example` is a development placeholder. Production refuses to start when that value is missing, shorter than 16 characters, or still starts with `change-me-`.

Do not run `prisma migrate deploy` from a second terminal while the API process has the database open. SQLite returns `database is locked`. Stop that API process, or let the API apply migrations when it reloads.

## Enroll an agent

```bash
cd apps/agent
cp config.example.yaml config.yaml
```

Set `enrollment_secret` to the same value as `ENROLLMENT_SECRET`, then `make run` (Go **1.25+**). The agent enrolls, stores `device_id` and `device_key`, and keeps one WebSocket to `/agent-ws`.

The same hostname and platform without that key returns **409 `device_exists`**. On the device page, **Reset enrollment** clears the key so the next enroll can reclaim the row.

## Demo device

A local database may already contain a device named `cloud-agent-demo` (`11111111-1111-4111-8111-111111111111`). That row is leftover demo data, not a live agent. Commands queued to it stay pending until a real agent with that id connects. Scans and scripts you start against it are real API rows; they do not invent scanner output.

## Operator access

If `OPERATOR_TOKEN` is unset and no dashboard password is stored, admin routes are open and the API logs a warning. Set `OPERATOR_TOKEN` and `NEXT_PUBLIC_OPERATOR_TOKEN` before the API is reachable beyond your own machine. A password created under Settings → Security also gates the UI.
