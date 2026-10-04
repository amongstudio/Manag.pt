# Dashboard

The sidebar is `APP_NAV` in `apps/web/lib/nav.ts`. Every entry below is a real route.

## Overview (`/`)

Online and offline counts, recent commands, and live socket alerts. Presence is last-seen. Fleet CPU charts are not drawn from heartbeats; metrics are on the device page and come from the separate metrics frame.

## Devices (`/devices`)

Search and status filter. Open a row for the device page.

The device page stacks Desktop, Files, Admin, Processes, Shell, and History. Admin tabs:

- **Metrics** — latest `MetricSample` rows for that device
- **Hardware** — chassis, OS, volumes from the inventory tables, plus **Refresh inventory** (`collect_inventory`)
- **Software** — latest software snapshot for that device
- **Users** — user profiles from the last inventory
- **Services** — live Windows SCM list (`get_services`, start, stop, restart). Other platforms show that the controls are Windows-only
- **Registry, Credentials, Network, Windows** — existing native tools. The event log tab filters channel, level, event ID, source, and time range, then queues `get_event_log`

The header **Assistant** proposes an existing command (`refresh inventory`, `restart service NAME`, `kill NAME`, `run script NAME`). Destructive proposals stay on a confirm step. With no LLM base URL the panel says the model key is unset and still parses those phrases. Session flags on the same card store watermark text, consent, a privacy-screen *request*, owner, timeout, and an invite token. The privacy-screen flag does not blank the Windows console.

## Commands (`/commands`)

Command history, cancel, retry, and templates. Types the composer can queue are the shared `COMMAND_TYPES` list. `network_scan` and `nuclei_scan` are easier to start from Security, which checks the allowlist before queueing.

## Scripts (`/scripts`)

Create a library script, select it, pick a device, and **Run**. That calls `POST /api/v1/admin/devices/:id/scripts/run`, which inserts a `ScriptRun` and a `run_script` command. **Schedule** saves a UTC cron (`POST /api/v1/admin/script-schedules`). Leave the device empty to target up to 200 enrolled devices. Recent runs show status, exit code, and captured stdout/stderr. An empty library shows an empty table, not sample scripts.

## Alerts (`/alerts`)

Socket notifications, including `metric_rule` and `storage_failure` rows written by the rule evaluator. CSV and HTML exports are linked from the page. An empty table means no socket notifications have been stored.

## Inventory (`/inventory`)

Fleet software search. **Name contains** and **Version equals** are SQL filters on `Software` joined to the latest `SoftwareInstallation` per device. CSV and HTML exports use the same filter. An empty table means no inventory rows match.

## Security (`/security`)

Start a scan for a device: Nmap, Nuclei, or host posture. The API refuses targets outside the scan scope before a command is queued. Operators edit that scope on Configuration. The file `config/scan-scope.yaml` is only the default copied into SQLite the first time. An empty allowlist with lab mode off is rejected, and `0.0.0.0/0` is rejected. The scans table shows status and summary (`nmap_unavailable`, `nuclei_unavailable`, `trivy_unavailable`, or a finding count). Filters cover severity, status, port, and service. **Ack**, **Accept** (asks for a reason), **Link script**, and **Remediate** call the findings API. Remediate stays disabled until a library script is linked, and it only moves `open` or `acknowledged` findings to `remediating`.

## Plugins (`/plugins`)

Upload or stamp a plugin and grant devices. `run_plugin` still requires a grant.

## Builder (`/builder`)

Stamp an installer pack (config, enrollment secret, optional binary). Compile is a separate action and only runs when `ENABLE_AGENT_COMPILE=1`.

## Logs (`/logs`)

Agent log lines shipped after heartbeats. Filter by level and message.

## Settings (`/settings`)

Telegram, Discord, Teams incoming webhook, SMTP, thresholds, metric retention, agent intervals, LLM copilot, mesh, and operator password. Saved secrets are redacted in the API response. Teams posts a MessageCard to the webhook URL. These values live in the `app` settings row. The API cache is cleared on save, so the job loop sees them on the next read.

## Configuration (`/configuration`)

Dashboard, API, Agent, and Helper tabs. YAML for alert rules, automations, scan scope, and software version rules is stored in SQLite and overrides the files in `config/` until you change it again. A fresh checkout still boots from those files. Agent idle heartbeat and poll interval save through the same settings row and ride the next heartbeat as `agentConfig`. Helper watchdog numbers are pushed to online agents as `apply_config`, which writes `helper.yaml`. The helper reads that file when it starts, so a probe-interval change waits for a helper restart. The install command on this page and on Builder uses the API public URL and masks the enrollment secret.

Process-start values stay in the environment: `OPERATOR_TOKEN`, `NEXT_PUBLIC_OPERATOR_TOKEN`, `NEXT_PUBLIC_WS_URL`, `ENROLLMENT_SECRET`, `CREDENTIALS_KEY`, `UPDATE_SIGNING_SECRET`, `PUBLIC_URL`, and `ENABLE_AGENT_COMPILE`. Helper `update_signing_secret` and `agent_exe` are not returned by the API.

The Public access tab can publish the dashboard through ngrok, Cloudflare Tunnel, LocalTunnel, zrok, or Pinggy. See [Public access](public-access.md). The operator token is still required.

## Docs (`/docs`)

Markdown shipped in `docs/`, grouped as Users, Developers, and Operators. Each page is a path such as `/docs/users/getting-started`. The API reads the files from the repo and escapes HTML before the dashboard renders it.
