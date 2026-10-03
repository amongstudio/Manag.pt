# Data model

Prisma schema: `packages/db/prisma/schema.prisma`. SQLite. The API runs `prisma migrate deploy` on startup.

## Migrations 0016–0019

| Folder | What it adds |
|---|---|
| `0016_command_latest_idx` | Index on `Command(deviceId, type, status, createdAt)` |
| `0017_platform` | `Script`, `ScriptRun`, `ScriptSchedule`, `AuditLog`, `MetricSample`, `AlertState` |
| `0018_inventory` | Hardware, OS, CPU, memory, disk, volume, GPU, adapter, monitor, printer, USB, software, Windows update, driver, certificate, service snapshot, process snapshot, startup item, browser, user profile |
| `0019_scans` | `Scan`, `Finding`, `CveCache` |

Earlier folders (`0001` through `0015`) create devices, commands, credentials, chat, operator sessions, and remote sessions. `0002` dropped an older `AuditLog`; `0017` creates the current append-only table. There is no update or delete API for it.

## Who writes what

- **Device, Command, Log** — enroll, heartbeats, command queue and results
- **Script / ScriptRun / ScriptSchedule** — `/api/v1/admin/scripts`, run, and the schedule job. Command results update the run
- **MetricSample** — agent `metrics` frames. Pruned after 30 days
- **AlertState, Notification** — rule evaluator and `enqueueAlert`
- **AuditLog** — script changes, script runs, settings updates, service and process commands, remote sessions, automations, rules, scan start/end, finding acknowledge/accept/remediate/link, tunnel save/start/stop (provider name only)
- **Setting `tunnel`** — reverse-tunnel provider, ports, public URL, status, and write-only provider tokens. Responses omit the tokens
- **Inventory tables** — `collect_inventory` results through `upsertInventory`
- **WindowsUpdate** — inventory updates and `get_windows_update`, plus the approval routes
- **Scan / Finding / CveCache** — scan routes and `finishScan`
- **DeviceCredential.secretEnc** — AES-256-GCM. Key is `CREDENTIALS_KEY` or, if unset, `UPDATE_SIGNING_SECRET`. The rest of the SQLite file is not SQLCipher

Finding identity is `(hostIp, source, category, title, cveId)`. Indexes cover `deviceId`, `severity`, `cveId`, `status`, and scans by `deviceId, createdAt`.
