# Operator guide

Mnag.pt **3.3.0** by Masria Code. Contact: [Contact@Mnag.pt.com](mailto:Contact@Mnag.pt.com) · [https://Mnag.pt](https://Mnag.pt). Heartbeats are presence-only (`lastSeen` / online). The API ignores `cpu` / `ram` / `disk` on heartbeat and does not write `Stat` rows.

Optional dashboard login lives in SQLite (Settings → Security, or `/login` after a password exists). Until then, treat the UI as an operator console on a private network, VPN, or IP allowlist. **Production still needs `OPERATOR_TOKEN`** (and `TURN_URL` for WAN desktop). Mesh stays off until you opt in.

Anyone who can reach the UI can send commands unless `OPERATOR_TOKEN` is set or an operator password exists (send the same token as `NEXT_PUBLIC_OPERATOR_TOKEN` from the dashboard, or sign in). Agents still enroll with `ENROLLMENT_SECRET` and authenticate with a hashed per-device key. Same hostname+platform without that key is **409 `device_exists`**. On the device page, use **Reset enrollment** to clear the key so the next enroll without a stored `device_id`/`device_key` reclaims that machine (same as `POST /api/v1/admin/devices/:id/reset-enrollment`).

## Tour

- **Overview** — online/offline counts, recent commands, pending outbound alerts, and a **Live alerts** list (in-app `channel=socket` rows, dismissible). Presence is last-seen only; there are no fleet CPU/RAM/disk charts.
- **Devices** — search, status filter, multi-select bulk bar (restart / screenshot / command). Restart confirms. Sheet peek can jump to a device section.
- **Device** — stacked sections with sticky in-page nav: **Remote desktop**, **Processes** (refresh `get_processes`, kill with confirm), **Files**, **Services** (Windows SCM list / start / stop / restart, including PCManagerAgent and PCManagerHelper), **Network** (Windows adapters / ports / firewall), **Windows** (Event Log, Windows Update, Admin Center, Tasks, Defender, BitLocker, capabilities, Quick Assist), **Credentials** (Windows Credential Manager / browser logins / vault backup), **Registry** (HKLM / HKCU browse and confirmed writes), **Screenshots**, **Commands** (history + composer), **Chat** (LLM copilot that queues existing commands), **Shell**. No live-metrics charts or recent-heartbeat extras. **Reset enrollment** disconnects the agent and holds the row for reclaim; **Remove** deletes the device.
- **Commands** — filter by status, cancel pending, retry failed/cancelled, inspect result JSON, **Save as template**. Kill switch, shutdown, restart, and deletes ask for confirmation. `peer_listen` / `peer_offer` are ticketed copies from Files, not composer types.
- **Logs** — filter by level and message. Agents ship local log lines on heartbeat.
- **Plugins** — starter catalog plus custom file upload. Grant devices before `run_plugin`.
- **Builder** — stamp installer packs (config + optional uploaded or compiled agent binary + install script). **Compile** builds for the selected platform/arch when `ENABLE_AGENT_COMPILE=1`.
- **Settings** — Telegram / Discord / SMTP, offline/heartbeat-missed thresholds, retention, **LLM copilot** (`llm.baseUrl` / `apiKey` / `model`, OpenAI-compatible), **agent defaults** (idle/watched heartbeat, poll/screenshot interval, scheduled restart `HH:MM`, extra sandbox roots, stuck-command timeout, **Agent mesh**), agent catalog, SQLite backup, rate limit / IP allowlist readout. CPU/RAM/disk threshold fields and Telegram high-CPU/RAM/disk toggles are **hidden** (heartbeats are presence-only; those keys remain in saved JSON).

## Watch screen

Watch queues `start_watch` (default 60 minutes, cap 240) and sets `Device.watchUntil`. The agent sees `{ watch: { intervalMs: 1000 } }` on heartbeat and uploads JPEG stills via the existing screenshot endpoint (primary display, skip if capture fails or the frame exceeds the size cap). `stop_watch` clears the flag. Latest stills update over Socket.io `screenshot_ready`. This is a cheap ~1 FPS HTTP fallback on the **Screenshots** section.

**WebRTC desktop** (device **Remote desktop** section) is the primary live surface. Default is JPEG frames over a data channel (`PCM1` fragments). On Windows, the offer can set `codec: "h264"` (Media Foundation, Constrained Baseline, encode width capped at 1080p / `maxWidth`) and `audio: true` (WASAPI loopback → Opus); other platforms stay on JPEG and ignore audio. Optional remote input (confirm), quality/FPS/display, Fit / 1:1 / fullscreen, clipboard history (`text` / `html` / `image` / `files` badges, image thumbnail, pin, search, clear, send text/image, copy local), and a bitrate/FPS HUD.

If H.264 cannot start, the HUD shows **Fell back to JPEG (`reason`)** with the agent’s code, not a generic `mf_init_failed`. Typical reasons: `mf_class_missing` (Windows N/KN without Media Feature Pack), `mf_transform_unavailable` (encoder is installed but Media Foundation did not expose `IMFTransform` — JPEG stays up), `frame_too_large`, `no_interactive_session`, a Media Foundation HRESULT string, or `capture_failed`. `webrtc_disabled` / `enable_webrtc` is **not** a codec failure — the HUD says live video needs `enable_webrtc` (Builder **Full remote** stamp). Lightweight stamps should not claim live video. Capture hangups (`no_interactive_session`, `webrtc_unavailable`, `agent_offline`, `connect_timeout`, `no_frame`) also land on that HUD. ICE servers (including TURN from `GET /api/v1/admin/meta`) go on the offer so both sides can use TURN. Control messages `{ fps, quality, display, maxWidth, codec, audio }` go on the data channel. This is not VP8 and not an MJPEG server.

## Shell

The **Shell** section is Windows-only in 3.3.0 (other platforms show that message). Confirm before open. Choose PowerShell or cmd. The dashboard uses xterm.js plus the fit addon and talks Socket.io `shell_open` / `shell_data` / `shell_resize` / `shell_close` — the same strings as agent-ws (`AGENT_WS_TYPE.shell_*`). UTF-8 stdin/stdout; optional binary PTY frames use agent-ws type `4`. One session per device. The agent ConPTY path may run as the logged-on user when the agent is a service.

## Files

The explorer seeds from the latest successful `get_files` / `search_files` already on the device query. Listing tracks the queued command `id` from `POST /api/v1/admin/commands` and shows **Waiting for agent…** (not an empty “no listing” state). If Socket.io is still connecting or the agent is slow, the explorer polls `GET /api/v1/admin/commands/:id` until that command succeeds or fails (`GET /api/v1/admin/commands?deviceId=` is the list equivalent). Failed lists show an error banner and **Retry**. After mkdir/rename/delete/copy/move, the explorer reissues `get_files`.

Home sends no path (sandbox home). Breadcrumbs and sandbox-root chips navigate; sort/filter are client-side. Truncated listings show a banner (agent cap, typically 500).

Context menu: open, download, **Send to device…**, rename, copy, move, delete, preview. Multi-select supports batch delete/move. Move destination is `joinPath(folder, name)`. Drag-drop upload and a separate transfer progress panel sit below the listing. E2E uploads stream in chunks (`File.slice`) without reading the whole file into one `arrayBuffer`. Uploads default to **512 MB** (`MAX_UPLOAD_BYTES`; override with the env of the same name). `GET /api/v1/admin/meta` returns `maxUploadBytes`; the explorer uses that live cap and shows remaining size while transferring. Agents apply the same cap from `hello_ok` / `agentConfig.maxUploadBytes`. Chunked WS + resume stay required inside the cap. Socket.io `file_progress` patches transfer rows in the react-query cache instead of refetching the whole device.

**Send to device…** copies a file to another **online** agent. Pick a destination (labeled **likely LAN** when they share an RFC1918 /24 or IPv6 ULA, or the same public `Device.ip`) and a sandbox path, then confirm. By default the API mints an HMAC ticket (`UPDATE_SIGNING_SECRET`) and queues `peer_listen` on the dest plus `peer_offer` on the source. If **Settings → Agent defaults → Agent mesh** is on, those commands skip live tickets and the agents authenticate with enrollment mesh certs (mTLS) on port 17891; dest already has a persistent listener. The source still falls back to API upload/download if the LAN dial fails. Peers may also run **allowlisted** commands (see Mesh). Plugin blobs, `peer_listen` / `peer_offer`, and `update_agent` are never accepted from peers.

`copy_file` `{ from, to }` and `preview_file` `{ path }` (first ~64KB, text/small image) require the matching agent/API command types.

## Services

The **Services** section is Windows-only (other platforms show that). On mount, if the device is online, the UI **always queues a fresh `get_services`**. The last successful list (`latestSuccessful.get_services` on device GET, or a success in recent commands) is a skeleton only. Historical failed rows do **not** seed the error banner. While waiting, the section shows pending, not an empty “no listing” state. Poll timeout is 90s (`timeout` vs `agent_offline` when the device is offline). If there is no cache, **QueryErrorState** is used; **QueryErrorBanner** with “last known state” only appears when a list is already on screen.

**Refresh** queues `get_services` and lists Win32 services from the Service Control Manager (`OpenSCManager` / `EnumServicesStatusEx`), not the `builtin:win_services` plugin snapshot. Filter is client-side. **PCManagerAgent** and **PCManagerHelper** appear like any other service (official badge; start type is loaded only for those two). Start / stop / restart queue `start_service` / `stop_service` / `restart_service` `{ name }` after confirm, then re-list. Stopping the helper means it will not restart the agent; stopping the agent may come back via SCM recovery and the helper. Agent errors use `scm_access_denied` / `scm_enum_failed` rather than a generic fallback.

## Network

The **Network** section is Windows-only (other platforms show that). Tabs cover adapters, ports, and firewall. On first visit of a tab, if the device is online, the UI queues a fresh `get_adapters` / `get_ports` / `get_firewall`. Last successful results (`latestSuccessful` on device GET) are a skeleton only. Poll timeout is 90s.

**Adapters** uses IP Helper `GetAdaptersAddresses` (IPv4/IPv6, DNS, DHCP, MAC, status). **Ports** uses `GetExtendedTcpTable` / `GetExtendedUdpTable` plus `QueryFullProcessImageName`. Filter listen vs established vs all. Port **17891** is highlighted as the official LAN peer port. **Firewall** reads profiles and rules through COM `INetFwPolicy2`. Filter inbound/outbound and enabled. Add / edit / delete queue `set_firewall_rule` / `delete_firewall_rule` after confirm. There is no control to disable Windows Firewall globally and no WFP callouts.

## Mesh

**Settings → Agent defaults → Agent mesh** is off by default. When enabled, enrolled agents keep a persistent mTLS listener on TCP **17891** (mDNS `_mnag._tcp` plus a UDP beacon). Identity is the mesh cert issued at enroll (deviceId SAN, ~30 days), not open LAN trust. Unknown certs are dropped. Last-known policy on disk applies while the API is down.

- **Files** always work on the mesh (`file` op). **Send to device…** skips live HMAC tickets when mesh is on.
- **Commands** default to get-only: `get_files`, `get_processes`, `get_services`, `get_registry`, `get_adapters`, `get_ports`, `get_firewall`, `get_event_log`, `get_windows_update`, `get_admin_center`, `get_tasks`, `get_defender`, `get_bitlocker`, `get_capabilities`. Extra types are an operator allowlist (`kill_switch`, `set_registry`, `start_quick_assist`, `set_task_enabled`, …). `run_plugin`, ticketed `peer_listen` / `peer_offer`, `update_agent`, and all credential vault commands cannot be allowed from peers.
- **WAN (ICE / TURN)** is a separate switch. Across NAT it needs `TURN_URL`. The Settings page warns when WAN is on and TURN is unset; WAN mesh then fails closed. LAN mTLS on 17891 still works.
- **Forward to peer** (composer) only queues when mesh is on and the type is allowlisted. Audit rows flush to the API when the agent WebSocket returns.

## Agent toasts

Status-only balloons on the **signed-in desktop**, not operator→user chat. Session 0 cannot toast; the service writes `{ kind, title, body }` to `\\.\pipe\pc-manager-notify` and the user-session tray shows `Shell_NotifyIcon` `NIF_INFO`. If the tray is missing, the service starts it as the console user (same `CreateProcessAsUser` path as capture-helper). No interactive session: log only.

Kinds: `enrolled`, `ws_down`, `ws_up`, `update_applied`, `desktop_incoming` (“Remote desktop session starting”), `mesh_peer`, `agent_recovering`, `quick_assist` (“Opened on the desktop.”).

## Windows

The **Windows** section is Windows-only (other platforms show that). Tabs cover Event Log, Windows Update, Admin Center, Tasks, Defender, BitLocker, and capabilities. **Credentials** is a separate Admin tab. On first visit of a tab, if the device is online, the UI queues a fresh native get_*. Last successful results (`latestSuccessful` on device GET) are a skeleton only. Poll timeout is 90s (120s for updates, capabilities, and credential backup).

**Event log** uses `EvtQuery` (not `Get-EventLog`). Default channel System, newest 50, optional level filter. Prefer this over the `system_event_log` plugin starter.

**Windows Update** is read-only WUAPI `IUpdateSearcher`: pending (`IsInstalled=0`) plus recent install history. Default is the local cache (`online: false`).

**Admin Center** detects service `ServerManagementGateway` (installed / running / optional gateway URL). It does not start the gateway.

**Tasks** lists Task Scheduler via `ITaskService`. Enable/disable confirms (`set_task_enabled`). It does not launch `taskschd.msc`.

**Defender** shows status, signature ages, scans, ASR/network/PUA settings, and protection history. Operators can start quick/full/offline scans, update signatures, toggle preferences via `Set-MpPreference`, and remediate or allow threats (`Remove-MpThreat` / `Restore-MpThreat`). WMI is preferred; PowerShell is the fallback. Tamper Protection can block setting changes.

**Credentials** lists Windows Credential Manager, app entries, and Chrome/Edge/Firefox saved logins. Backup stores secrets in the dashboard vault with AES-256-GCM (key derived from `UPDATE_SIGNING_SECRET`). Reveal is operator-auth only and is not kept in command history. Chrome/Edge decryption needs a signed-in desktop (DPAPI). Firefox is metadata-only (NSS / `key4.db` is not unlocked). Generate writes an optional CredWrite entry. Restore writes vault secrets back to Credential Manager (not into browser stores).

**BitLocker** is read-only `Win32_EncryptableVolume`. **Capabilities** lists DISM / RSAT optional features and never installs them. Hyper-V, IIS, and clustering stay plugins.

**Open Quick Assist** confirms, then queues `start_quick_assist`. The agent starts Quick Assist (`quickassist.exe` / `ms-quick-assist:`) or `msra.exe` in the console session and toasts. It does **not** launch MMC or Server Manager from Session 0.

## Registry

The **Registry** section is Windows-only. Same auto-refresh and banner rules as Services: on mount (when online) always queue `get_registry` for `HKLM\SOFTWARE\PC Manager\Agent`. If that key is empty (YAML-only `go run`, missing key, or the other hive/WOW64 view), the agent returns an **empty key**, not `registry_not_found`, and the UI then opens parent `SOFTWARE`. Last success is a skeleton only; failed history does not seed the banner. Poll timeout is 90s.

Documented hives are **HKLM** and **HKCU** with well-known chips including `HKLM\SOFTWARE\PC Manager\Agent` (agent config; HKCU fallback). **HKCU is the agent process identity** (LocalSystem's hive when the agent runs as a service), not the logged-on user. Browse with `get_registry` `{ hive, path }`. Writes (`set_registry`) and deletes (`delete_registry`) still confirm in the UI. Run / Winlogon / Image File Execution Options paths show a warning; this editor does not add extra Run keys or scheduled tasks.

## Chat

The **Chat** section is an **LLM copilot** for this device, not end-user IM. Header **New chat** creates a thread (`POST /api/v1/admin/devices/:id/chats`). Messages (`POST .../chats/:threadId/messages`) stream tokens on Socket.io `chat_delta`. Configure **Settings → Copilot**: OpenAI-compatible `llm.baseUrl` (root ending in `/v1`, or a full `…/chat/completions` URL for Azure), optional `apiKey`, and `model`. Empty base URL disables copilot (`llm_not_configured`).

Tools are existing command types only: `get_processes`, `get_files`, `get_services`, `get_registry`, `get_adapters`, `get_ports`, `get_firewall`, `get_event_log`, `get_windows_update`, `get_admin_center`, `get_tasks`, `get_defender`, `get_bitlocker`, `get_capabilities`, `run_script`, `run_plugin` (granted plugins only), `preview_file`, `search_files`. Destructive tools (`run_plugin`) show a Confirm card before they queue (`POST .../confirm` with `toolCallId` + `confirmed`). Each tool result links to the command row. Copilot never bypasses the sandbox, command policy, plugin grants, or confirms. Rate limit is per thread.

## Command templates

The composer gallery mixes built-in `COMMAND_TEMPLATES` (restart, shutdown, processes, screenshot, start/stop watch, list home, search by name, print env, install/uninstall app) with operator-saved rows from `GET/POST/DELETE /api/v1/admin/command-templates`. When templates include a `category` field, the composer groups chips by that category (saved templates sit under **Saved**). Typed fields cover script, pid/name, path, duration, and plugin args; **Advanced JSON** remains as a disclosure. Destructive templates still go through the existing confirm dialog. The Commands page can **Save as template** from a row’s type and payload.

## Plugins

**Plugins** lists starter sources from `GET /api/v1/admin/plugins/templates` as cards. **Create** calls `POST /api/v1/admin/plugins/from-template` (name/version/grants) into the existing hash-pinned catalog. Windows starters (`installed_programs`, `win_services`, `system_event_log`, `disk_volumes`) run PowerShell via python/go wrappers, `networkAllowed: false`, and default `platform` to `windows`. Prefer native `get_event_log` over `system_event_log` (the starter now uses `Get-WinEvent` for older agents). Custom file upload remains. The run dialog can offer arg presets when the plugin matches a starter. The js_goja runtime is hidden. Empty grants mean nobody can run it. Treat plugin blobs like production code.

## Builder

**Builder** stamps installer packs. Choose platform (`windows` / `linux` / `darwin`) and arch (`amd64` / `arm64`). Preset chips fill intervals and feature flags: **Lightweight**, **Watched**, **Full remote** (WebRTC + screenshot + plugins). Extra fields: sandbox roots, idle/watched heartbeat, auto-restart `HH:MM`, and an include-helper checkbox only when a helper binary exists in Settings updates. A live **config.yaml** preview is generated in the browser. If Settings has no matching agent binary, the UI warns and the pack is config + installer only.

Download uses an `<a download>` (or blob trigger), not a full-page navigation. The pack table copies the signed URL, shows expiry (~10 minutes), and can delete a pack (`DELETE /api/v1/admin/builder/packs/:id`). Packs embed `enrollment_secret`. Stamp pack does not compile — use **Compile** (`POST /api/v1/admin/builder/compile`, poll `GET /api/v1/admin/builder/compile/:id`) for the selected platform/arch when `ENABLE_AGENT_COMPILE=1`, or upload a binary under Settings.

## Command safety

Destructive types (`restart`, `shutdown`, `kill_switch`, `kill_process`, `delete_file`, `uninstall_app`, `run_plugin`, `start_service`, `stop_service`, `restart_service`, `set_registry`, `delete_registry`, `set_firewall_rule`, `delete_firewall_rule`, `start_quick_assist`, `set_task_enabled`) always confirm. Payload JSON is parsed on the server; the agent still sandboxes paths and caps script output. Registry writes are limited to HKLM/HKCU. Service control uses SCM APIs only. Firewall writes change one named rule via `INetFwPolicy2` and never disable the firewall globally. Task enable/disable uses `ITaskService` only. Quick Assist starts in the console session only.

Pending commands can be cancelled. Failed or cancelled commands can be retried (cloned as pending). Commands left `running` longer than **stuck command timeout** (Settings, default 15 minutes) are marked failed.

## Alerts

Every `enqueueAlert` writes a `channel=socket` notification and emits Socket.io `ALERT` (`title`, `body`, `type`, `deviceId`). The dashboard shows a **top banner** (dismissible) plus a **toast**. Overview **Live alerts** lists the last 20 socket rows (dismissible in the tab), separate from the **pending** Telegram/Discord/SMTP count.

Offline uses last-seen vs `offlineThresholdSec`. Missed-heartbeat alerts use `heartbeatTimeoutSec`. CPU/RAM/disk thresholds are not shown and do not enqueue alerts. Channels retry failed outbound sends. Duplicate alerts of the same type are cooled down.

Do not paste bot tokens or LLM API keys into git; they live in Settings (SQLite) or Docker secrets.

## E2E

Start E2E from the device page. Handshake **metadata** (public keys, session id, last WebRTC signal kind) is stored in SQLite with an 8-hour TTL so an API restart can resume signaling. Session secrets stay on the browser and the agent. SQLite is one replica — not HA. WebRTC hangup and SDP also travel on the E2E envelope when a session is active.

## Realtime rooms

The dashboard attaches to per-device Socket.io rooms. Screenshots, file progress, WebRTC, E2E envelopes, **chat_delta**, and **shell** frames (`shell_open` / `shell_data` / `shell_resize` / `shell_close`) are only delivered for devices the operator tab attached. Relaying those events to an agent requires membership in that device room. One interactive shell session is allowed per device. Fleet events (status, alerts, command queue/results) go to every attached console.

HTTP already loads overview and devices. The header shows **Realtime connecting…** until Socket.io is up, then **Live**. After about 2 seconds without a socket connect it switches to **HTTP only** (reconnect remains available). **Live** means Socket.io is connected; it is not a console-down signal. In dev, Next can rewrite `/ws` to the API for same-origin Engine.IO.
