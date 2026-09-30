# Architecture

```
browser :3000  --HTTP /api, Socket.io /ws-->  API :4000  --SQLite data/pcmanager.db
                                              API :4000  <--WebSocket /agent-ws--  agent
                                              helper (optional) probes 127.0.0.1:17890
```

The Next.js app proxies `/api` and `/ws` to the API. Admin routes require the operator token or a session cookie. Agent routes require the device key.

## Command flow

1. The dashboard or a job calls `POST /api/v1/admin/commands` or a narrower route (scripts, scans) that inserts a `Command` row (`pending`).
2. The API pushes it on `/agent-ws` when the device socket is up. Otherwise the agent long-polls.
3. `commands.Handle` in the agent runs the type and posts `command_result` with a `resultId`.
4. `ingestCommandResult` stores the result. `applyCommandEffects` updates script runs, inventory, Windows update rows, and scan findings.

`startJobs` in `apps/api/src/app.ts` starts the cron loop: offline detection, stuck commands, notification flush, and `runPlatformJobs` (rules, automations, script schedules, metric prune, scan reconcile, daily inventory). There is not a second worker process.

## Scans

`POST /api/v1/admin/scans` checks `authorizeTarget` / `authorizeURL`, writes `Scan`, audits `scan_start`, and queues `network_scan`, `nuclei_scan`, or `host_posture`. The agent checks the same YAML again before exec. When the command reaches a terminal status, `finishScan` upserts `Finding` rows and audits `scan_end`. A job also finalizes scans whose command already finished if the API missed the first write.

Mesh peers cannot run `network_scan` or `nuclei_scan` (`MESH_NEVER_COMMANDS`).
