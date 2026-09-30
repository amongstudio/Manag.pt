# Dashboard

The sidebar is `APP_NAV` in `apps/web/lib/nav.ts`. Every entry below is a real route.

## Overview (`/`)

Online and offline counts, recent commands, and live socket alerts. Presence is last-seen. Fleet CPU charts are not drawn from heartbeats; metrics are on the device page and come from the separate metrics frame.

## Devices (`/devices`)

Search and status filter. Open a row for the device page.

The device page stacks Desktop, Files, Admin, Processes, Shell, and History. Admin tabs:

- **Metrics** — latest `MetricSample` rows for that device
- **Hardware** — chassis, OS, volumes from the inventory tables, plus **Refresh inventory** (`collect_inventory`)
- **Software** — latest software snapshot for that device, plus confirmed, audited winget install and uninstall (see [inventory](inventory.md))
- **Users** — live local accounts on Windows with confirmed, audited enable, disable, and set password, plus user profiles from the last inventory
- **Services** — live Windows SCM list (`get_services`, start, stop, restart). Other platforms show that the controls are Windows-only
- **Registry, Credentials, Network, Windows** — existing native tools. The event log tab filters channel, level, event ID, source, and time range, then queues `get_event_log`
- **Credentials** — each row shows a vault state: *encrypted* (revealable), *metadata only* (Reveal backs it up from the agent first), *decrypt failed* (the vault copy does not decrypt with the current `CREDENTIALS_KEY`), or *not readable* (Windows domain and "other" credentials, whose secret Windows never returns). Reveal is confirmed and audited (`credential_reveal`) and never writes plaintext to logs. **Clear vault secrets** (`POST /api/v1/admin/devices/:id/credentials/clear-secrets` with `{ "confirm": true }`) deletes every stored secret for the device, keeps the metadata rows, leaves the device's own credential stores alone, and audits `credential_vault_clear` with the count
- **Network → Connections** — `get_connections` lists sockets: process, PID, protocol, local and remote address, and state, plus interface byte totals and per-process I/O totals. Per-connection byte counts are not available from Windows without packet capture, so they are not shown. **Live** re-queues every 5, 15, or 60 seconds while the tab is open and visible. The request is capped at 1000 rows, and only one runs per device at a time (`connections_in_flight`). No packet contents, DNS queries, or HTTP bodies are collected

The header **Assistant** proposes an existing command (`refresh inventory`, `restart service NAME`, `kill NAME`, `run script NAME`). Destructive proposals stay on a confirm step. With no LLM base URL the panel says the model key is unset and still parses those phrases. Session flags on the same card store watermark text, consent, a privacy-screen *request*, owner, timeout, and an invite token. The privacy-screen flag does not blank the Windows console.

## Commands (`/commands`)

Command history, cancel, retry, and templates. Types the composer can queue are the shared `COMMAND_TYPES` list. `network_scan` and `nuclei_scan` are easier to start from Security, which checks the allowlist before queueing.

## Scripts (`/scripts`)

**Templates** lists reviewed, read-only checks with pattern-checked parameters; **Run on device** sends only the template id and parameters (see [scripts](scripts.md)). Create a library script (parameters found as `{{name}}` can have an anchored pattern), select it, fill in any parameters, pick a device, and **Run**. That calls `POST /api/v1/admin/devices/:id/scripts/run`, which inserts a `ScriptRun` and a `run_script` command. **Schedule** saves a UTC cron (`POST /api/v1/admin/script-schedules`). Leave the device empty to target up to 200 enrolled devices. Recent runs show status, exit code, and captured stdout/stderr. An empty library shows an empty table, not sample scripts.

## Alerts (`/alerts`)

Socket notifications, including `metric_rule` and `storage_failure` rows written by the rule evaluator. CSV and HTML exports are linked from the page. An empty table means no socket notifications have been stored.

## Inventory (`/inventory`)

Fleet software search. **Name contains** and **Version equals** are SQL filters on `Software` joined to the latest `SoftwareInstallation` per device. CSV and HTML exports use the same filter. An empty table means no inventory rows match.

## Security (`/security`)

Start a scan for a device: Nmap, Nuclei, or host posture. The API refuses targets outside the scan scope before a command is queued. Operators edit that scope on Configuration. The file `config/scan-scope.yaml` is only the default copied into SQLite the first time. An empty allowlist with lab mode off is rejected, and `0.0.0.0/0` is rejected. With a device selected, **Scanner tools** shows where nmap, nuclei, and trivy were found and can install the pinned, checksum-verified release. Scan history filters by tool and device and shows status and summary (`nmap_unavailable`, `nuclei_unavailable`, `trivy_unavailable`, or a finding count), with a setup hint for missing tools. Filters cover severity, status, port, and service. **Ack**, **Accept** (asks for a reason), **Link script**, and **Remediate** call the findings API. Remediate stays disabled until a library script is linked, and it only moves `open` or `acknowledged` findings to `remediating`.

## Modules (`/modules`)

Register approved Windows EXE tools or DLL plug-in artifacts. **Module templates** fill in the registration form for read-only Sysinternals tools; you still upload the binary. New artifacts are disabled and ungranted. Review the signed manifest, approve it, grant devices, and confirm each EXE run. The agent verifies the signature and SHA-256 before every bounded child-process execution. DLLs show `host pending` and cannot run.

The old `/plugins` page only links here. Arbitrary script/binary plugin upload and `run_plugin` dispatch are disabled. There are no process-injection controls.

## Builder (`/builder`)

Stamp an installer pack (config, enrollment secret, optional binary). Compile is a separate action and only runs when `ENABLE_AGENT_COMPILE=1`.

## Logs (`/logs`)

Agent log lines shipped after heartbeats. Filter by level and message.

## Settings (`/settings`)

Telegram, Discord, Teams incoming webhook, SMTP, thresholds, metric retention, agent intervals, LLM copilot, mesh, and operator password. Saved secrets are redacted in the API response. Teams posts a MessageCard to the webhook URL. These values live in the `app` settings row. The API cache is cleared on save, so the job loop sees them on the next read.

## Configuration (`/configuration`)

Dashboard, API, Agent, and Helper tabs. YAML for alert rules, automations, scan scope, and software version rules is stored in SQLite and overrides the files in `config/` until you change it again. A fresh checkout still boots from those files. Agent idle heartbeat and poll interval save through the same settings row and ride the next heartbeat as `agentConfig`. Helper watchdog numbers are pushed to online agents as `apply_config`, which writes `helper.yaml`. The helper reads that file when it starts, so a probe-interval change waits for a helper restart. The install command on this page and on Builder uses the API public URL and masks the enrollment secret.

Process-start values stay in the environment: `OPERATOR_TOKEN`, `NEXT_PUBLIC_OPERATOR_TOKEN`, `NEXT_PUBLIC_WS_URL`, `ENROLLMENT_SECRET`, `CREDENTIALS_KEY`, `UPDATE_SIGNING_SECRET`, `PUBLIC_URL`, and `ENABLE_AGENT_COMPILE`. Helper `update_signing_secret` and `agent_exe` are not returned by the API.

## Docs (`/docs`)

Markdown shipped in `docs/`, grouped as Users, Developers, and Operators. Each page is a path such as `/docs/users/getting-started`. The API reads the files from the repo and escapes HTML before the dashboard renders it.
