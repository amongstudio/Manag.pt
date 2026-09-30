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

`run_module` is a narrower command path: `/admin/modules/:id/runs` checks enabled/revoked state, signature, device grant, target, and arguments before inserting commands pinned to the current signature. The agent repeats those checks and runs EXEs as bounded child processes. Cancelling a module command also sends `command_cancel` on `/agent-ws`. See [Safe module library](modules.md).

## Scans

`POST /api/v1/admin/scans` checks `authorizeTarget` / `authorizeURL` against the in-memory scan scope, writes `Scan`, audits `scan_start`, and queues `network_scan`, `nuclei_scan`, or `host_posture`. That scope is the database copy when Configuration has been read or saved, otherwise `config/scan-scope.yaml`. The agent checks its own copy of the scope again before exec. When the command reaches a terminal status, `finishScan` upserts `Finding` rows and audits `scan_end`. A job also finalizes scans whose command already finished if the API missed the first write.

`GET` and `PUT /api/v1/admin/config/:section` are the operator path for rules, automations, scan scope, software rules, helper options, and agent intervals. Unknown keys and out-of-range numbers are rejected. Saves call `setRulesOverride`, `setAutomationsOverride`, `setScanScopeOverride`, or `setSoftwareRulesOverride`, so the job loop does not need a restart. Agent intervals go through `patchSettings`, which clears the five-second settings cache. Helper saves queue `apply_config`.

Mesh peers cannot run `network_scan` or `nuclei_scan` (`MESH_NEVER_COMMANDS`).
