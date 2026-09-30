# Agent

Cross-platform Go binary for **Mnag.pt** (version **3.3.0**). **WebSocket-first** (`/agent-ws`): presence-only idle heartbeats (~90s) that refresh `lastSeen`, HTTP long-poll only if the WS is down. Optional local status at `http://127.0.0.1:17890/status`. Optional helper watchdog: [docs/helper.md](helper.md).

Masria Code · [Contact@Mnag.pt.com](mailto:Contact@Mnag.pt.com) · [https://Mnag.pt](https://Mnag.pt)

## Config

`config.yaml` next to the binary, `PC_MANAGER_CONFIG`, walking **up from the current working directory**, the exe directory (ignored when the path contains `go-build`, so `go run` temp binaries do not win), or `%USERPROFILE%\.pc-manager\config.yaml`. Env overrides: `SERVER_URL`, `ENROLLMENT_SECRET`, `FALLBACK_URLS`.

On **Windows**, if no YAML is found, the agent reads and writes `HKLM\SOFTWARE\PC Manager\Agent` (service / elevated) and falls back to `HKCU\SOFTWARE\PC Manager\Agent`. Fields match YAML (`server_url`, `enrollment_secret`, `device_id`, `device_key`, intervals, feature flags). After enroll, `device_id` / `device_key` stay in the registry — a YAML file is not created. Linux and macOS stay YAML-only.

A compile-time `DefaultServerURL` (Makefile `DEFAULT_SERVER_URL`, `-ldflags -X github.com/pc-manager/agent/internal/config.DefaultServerURL=...`) is used when there is no YAML and no registry value. `SERVER_URL` still wins.

Run the agent from `apps/agent` (`make run` / `go run ./cmd/agent run`) so the repo `config.yaml` is found. Empty `enrollment_secret` while not enrolled is **not fatal**: the process keeps running (tray **Not enrolled** / local `/status`). HTTP 400 / `invalid_enrollment_secret` / 409 `device_exists` do not retry forever when a secret is present.

```yaml
server_url: http://localhost:4000
fallback_urls: []
enrollment_secret: change-me-enrollment-secret
heartbeat_interval_sec: 90
idle_heartbeat_sec: 90
watched_heartbeat_sec: 15
poll_interval_sec: 15
screenshot_interval_sec: 0
auto_restart_time: ""   # HH:MM local; empty disables. Logs then waits 60s before reboot.
data_dir: ""            # empty keeps ~/.pc-manager
status_port: 17890
sandbox_roots: []
lightweight: true
enable_gpu: false
enable_temps: false
enable_plugins: true
enable_screenshot: true
enable_webrtc: false
```

Heartbeat responses include `agentConfig` (intervals, `autoRestartTime`, extra sandbox roots). The agent writes those fields back to YAML or the Windows registry when they change.

First run enrolls with `enrollment_secret`, then persists `device_id` and `device_key`. Keep the config file private; the key is the device credential. Re-registering the same `deviceId` with a matching key updates identity fields only and does not rotate the stored key. If this hostname+platform is already enrolled and no key is sent, the API returns **409 `device_exists`** (no second row, no UUID loop). An operator can `POST /api/v1/admin/devices/:id/reset-enrollment` so the next enroll without a key reclaims that device.

`pc-manager-agent version` (also `--version` and `run --version`) prints the build version and exits without loading config. The updater uses this to probe a newly applied binary. Windows GUI builds attach to the parent console for `version` / `install` / `stop` so those still print in cmd.exe. `run` and `console` allocate a console for developers.

## Heartbeats (presence-only)

Heartbeats are presence pings. They refresh `Device.lastSeen` (and online status). They do **not** send cpu, ram, disk, processes, GPU, temps, or extras, and the server does not write `Stat` rows from them. Older agents may still include those fields; the API ignores them.

WS payload is `{ "type": "heartbeat", "lanAddrs": [...], "lanPort": 17891 }`. HTTP `POST /api/v1/agent/heartbeat` may include the same `lanAddrs` / `lanPort`. Idle cadence is `idle_heartbeat_sec` (~90s); watched devices or in-flight commands use `watched_heartbeat_sec` (~15s). `lanAddrs` are RFC1918 IPv4 and IPv6 ULA only (max 16); `lanPort` is the dest listen port for operator-ticketed peer copy (default **17891**). Hello on `/agent-ws` sends the same fields.

## Connectivity

While the agent WebSocket is up, the agent does **not** probe `GET /healthz` on each heartbeat and does not long-poll commands. HTTP long-poll is the fallback after repeated WS failures. JSON posts (enroll, heartbeat, logs, command results) set `GetBody` so failover can replay a small buffer. File uploads reopen the source file per attempt and never `ReadAll` the contents. **4xx is not retried**. Command-result POST is retried once on failure with the same `resultId`; the command itself is not re-executed.

Upload size cap defaults to 512MB (`MAX_UPLOAD_BYTES`, overridable on the API). The agent applies `agentConfig.maxUploadBytes` from `hello_ok` / `agent_config` / HTTP heartbeat ack. Screenshots 8MB; self-update downloads 100MB. The API rejects oversized agent uploads with `{ "error": "too_large" }`. Chunked WS transfers still resume within the cap.

## Commands

The poll loop only dispatches. Execution uses three pools:

| Class | Types | Concurrency |
|---|---|---|
| Exclusive | `restart`, `shutdown`, `kill_switch`, `update_agent` | One at a time; waits for long jobs to finish |
| Long | `install_app`, `uninstall_app`, `run_script`, `upload_file`, `download_file`, `search_files`, `get_services`, `start_service`, `stop_service`, `restart_service`, `get_adapters`, `get_ports`, `get_firewall`, `set_firewall_rule`, `delete_firewall_rule`, `peer_listen`, `peer_offer`, `get_event_log`, `get_windows_update`, `start_quick_assist`, `get_tasks`, `set_task_enabled`, `get_defender`, `set_defender`, `start_defender_scan`, `update_defender`, `defender_action`, `get_bitlocker`, `get_capabilities`, `get_smb`, `get_credentials`, `set_credential`, `delete_credential`, `generate_credential`, `backup_credentials`, `restore_credentials`, `get_local_users`, `local_user_action`, `get_connections`, `get_scan_tools`, `install_scan_tool` | Up to 2; may POST `status: running` with `progress` 0–100 |
| Fast | everything else | Up to 8 in-flight |

Each execution generates a UUID `resultId`. Duplicate `POST /agent/command-result` with that id is a no-op (`{ ok: true, duplicate: true }`). Terminal statuses (`success` / `failed` / `cancelled`) are not overwritten.

`restart` / `shutdown` / `kill_switch` POST `{ scheduled: true, action: "restart"|"shutdown" }` with `status: success` first, wait ~2s, then invoke the OS power action.

`kill_process` checks `PidExists` before and after kill (Windows `os.FindProcess` is not used as a liveness check). Missing processes return `process_not_found`. A process `name` in the payload is resolved when `pid` is absent.

`get_services` enumerates Win32 services via SCM (`OpenSCManager`, `EnumServicesStatusEx` with a **resume handle** pointer, looping `ERROR_MORE_DATA`). Display name and PID come from `ENUM_SERVICE_STATUS_PROCESS`. `QueryServiceConfig` (OpenService) runs only for **PCManagerAgent** / **PCManagerHelper**. Failures map to `scm_access_denied` / `scm_enum_failed`. `start_service` / `stop_service` / `restart_service` take `{ name }` and call `StartService` / `ControlService`. Linux and macOS return `unsupported`. Stopping or restarting **PCManagerAgent** posts `{ scheduled: true }` first, then stops this process so SCM recovery / the helper can bring it back.

`get_registry` `{ hive, path }` lists subkeys and values (HKLM / HKCU only). Opens with `KEY_READ | KEY_WOW64_64KEY`, then the 32-bit view if the key is missing. The documented config key `SOFTWARE\PC Manager\Agent` returns an **empty key** (not `registry_not_found`) when it does not exist (YAML-only `go run`, other hive, or the other WOW64 view). Hive-root value enumeration failure is tolerated. Other missing keys still return `registry_not_found`; access denied maps to `registry_access_denied`. `set_registry` / `delete_registry` write or delete a value or an empty key. HKCU is the agent process identity. Non-Windows returns `unsupported`.

`get_adapters` lists interfaces via IP Helper `GetAdaptersAddresses` (addresses, DNS, DHCP, MAC, oper status). `get_ports` uses `GetExtendedTcpTable` / `GetExtendedUdpTable` (`OWNER_PID`) and `QueryFullProcessImageName`; optional `{ listenOnly: true }` drops non-listen TCP. Local port **17891** is marked `official`. `get_firewall` reads profiles and rules through COM `INetFwPolicy2`. `set_firewall_rule` `{ name, direction, action, enabled, protocol, localPorts, ... }` adds or updates one named rule; `delete_firewall_rule` `{ name }` removes it. There is no API to disable the firewall globally. Access denied maps to `firewall_access_denied`. Linux and macOS return `unsupported`.

`get_event_log` `{ log?, newest?, level? }` uses wevtapi `EvtQuery` (channel path, reverse). Default System / 50 / all. Access denied maps to `event_log_access_denied`. `get_windows_update` `{ online? }` is WUAPI `IUpdateSearcher` (pending `IsInstalled=0` plus `QueryHistory`). Default `online: false` uses the local cache. Failure maps to `wuapi_unavailable`. `get_admin_center` is read-only SCM + registry for `ServerManagementGateway`. `start_quick_assist` `{ app?: "quickassist"|"msra" }` starts Quick Assist or `msra.exe` in the console session (`CreateProcessAsUser`, `WinSta0\\Default`) and posts a tray toast; it refuses `.msc` and does not launch MMC from Session 0. Missing session maps to `no_interactive_session`. `get_tasks` `{ query? }` walks Task Scheduler `ITaskService` (hidden included). `set_task_enabled` `{ path, enabled }` confirms in the UI and sets `IRegisteredTask.Enabled` only. `get_defender` reads WMI `MSFT_MpComputerStatus` / `MSFT_MpPreference` / `MSFT_MpThreatDetection` and falls back to `Get-MpComputerStatus` PowerShell when WMI is missing. `set_defender`, `start_defender_scan`, `update_defender`, and `defender_action` wrap `Set-MpPreference` / `Start-MpScan` / `Update-MpSignature` / `Remove-MpThreat` / `Restore-MpThreat`. `get_credentials` lists Windows Credential Manager plus Chrome/Edge/Firefox login metadata; `backup_credentials` reveals secrets for the dashboard vault. Chrome/Edge DPAPI needs an interactive session (`winsession.RunInteractive`); Firefox `logins.json` is listed without NSS decryption. `set_credential` / `delete_credential` / `generate_credential` / `restore_credentials` use `CredWrite` / `CredDelete`. Credential commands are never accepted from mesh peers. `get_bitlocker` is read-only `Win32_EncryptableVolume`. `get_capabilities` `{ query? }` lists DISM capabilities (RSAT/optional); it never installs. Access denied maps to `task_access_denied` / `defender_access_denied` / `bitlocker_access_denied` / `dism_access_denied` / `credential_access_denied` / `no_interactive_session`. Non-Windows returns `unsupported`.

`peer_listen` / `peer_offer` are operator-driven LAN file copy (not in the command composer). Ticketed payload is `{ ticket, fileId }`. Dest listens on `ticket.port` (default 17891, TLS + ALPN `pm-peer-file`) for ~20s; source dials `ticket.addrs` for ~3s. When Settings **mesh.enabled** is on, the same commands use `{ mesh: true, ... }` (no HMAC ticket): dest waits on the persistent mTLS listener and source dials with the enrollment mesh cert. Both sides `Resolve` the sandbox path. On `lan_dial_failed` the source uploads through the API (`via: "relay"`) so the dest can `download_file`. Mesh peers may also send allowlisted `cmd` envelopes (same `commands.Handle` path). Plugin blobs, ticketed peer copy, and `update_agent` are never accepted from peers. Helper does not proxy files.

## Watch stills

If heartbeat returns `watch: { intervalMs: 1000 }`, the agent captures display 0 as JPEG (~1 FPS) and uploads it. Failed or oversized frames are skipped. Optional `screenshot_interval_sec` takes slower stills when watch is off. The capture ticker runs only while watch or screenshot interval is non-zero; it stops when both are zero.

## Files

`mkdir`, `rename_file`, `move_file`, and `search_files` (name/extension, max 500 hits). Content search is limited to text-like extensions, files under ~1MB, first few matching lines. All paths still go through the sandbox (`Resolve`): `Abs` + `Clean` + `EvalSymlinks` when the path exists, membership via prefix + separator (so `C:\Users` does not match `C:\Userspace`).

## Logs

Local `agent.log` lines are buffered and shipped with `POST /api/v1/agent/logs` after heartbeats.

## Local status

`GET http://127.0.0.1:<status_port>/status` (loopback only) returns `deviceId`, `version`, `serverUrl`, `activeEndpoint`, `watchIntervalMs`, `lastHeartbeat`, `inFlightCommands`, `wsConnected`, `enrolled`, and `lastError`. A matching `X-Status-Token` is still accepted; loopback clients may omit it (the tray does). The helper sends the token from `data_dir/status.token` when present.

## Scheduled restart

`auto_restart_time` (`HH:MM` local, also pushed from server `agentConfig`) logs a warning, waits 60 seconds, then reboots (same as a `restart` command).

## Windows

Ship **one exe**. Windows `make dist` / goreleaser builds use `-H windowsgui` (no console on double-click) and bake `DefaultServerURL`.

Live capture uses **DXGI** desktop duplication in an interactive session. When the agent runs in **Session 0** (Windows service), it starts a `capture-helper` in the logged-on session and talks over a named pipe so stills and remote desktop still work. The pipe may return JPEG, or scaled **NV12/BGRA** under the 16MB body cap, so H.264 does not JPEG-decode helper frames.

Interactive **shell** uses **ConPTY** (`CreatePseudoConsole`) for PowerShell or cmd; when the agent is a service it may launch the shell as the logged-on user.

A **clipboard listener** (`AddClipboardFormatListener`, with sequence-number polling as fallback) pushes text/html/image/file clips into the remote-desktop clipboard ring.

H.264 (Windows, `!lite`, `enable_webrtc`) uses Media Foundation Constrained Baseline (`profile-level-id=42e01f`, `packetization-mode=1`), encode width capped at **1920**. The agent activates the encoder via `mfh264enc.dll` / `MFTEnumEx`, then `IMFSinkWriter` if `IMFTransform` QI fails, and in Session 0 can encode inside `capture-helper`. Failure falls back to JPEG with a precise reason: `mf_class_missing` (class not registered / HRESULT `0x80040154` / `0x80040111` — typical on Windows N/KN without Media Feature Pack), `mf_transform_unavailable` (encoder DLL or MFT catalog is present but `IMFTransform` is not exposed — do not treat this as a missing Feature Pack), `frame_too_large`, `no_interactive_session`, the encoder HRESULT text, or `capture_failed`. `enable_webrtc: false` reports `webrtc_disabled`, not a codec error. Non-Windows H.264 offers fall back with `h264 is Windows-only`.

### LocalSystem service + helper

First double-click (or `self-install`) elevates once (UAC), copies the exe to `%ProgramFiles%\PC Manager Agent\`, migrates HKCU config into HKLM, and installs **PCManagerAgent** and **PCManagerHelper** as **LocalSystem** services. The helper is installed when its binary is next to the agent (or a `dist\pc-manager-helper-windows-*.exe` name), same as `install.ps1`. Later double-clicks only show the **tray** (the service already owns the agent loop). Session 0 never shows a tray.

Both services get SCM failure actions: restart after **5s / 30s / 60s**. The helper also probes loopback `/status` and starts the agent if the service is down. The process stays visible in Task Manager.

```powershell
# from a built dist/ folder, elevated
.\install.ps1 -ServerUrl https://pc.example.com -EnrollmentSecret "your-secret"
```

This copies the exe to Program Files, writes `config.yaml` if missing, registers `PCManagerAgent` + `PCManagerHelper`, sets SCM recovery, and adds a **private-profile** inbound firewall rule for TCP **17891** (LAN peer files). If `install` / `start` / `stop` fails, the process exits with the error from `service.Control` (`log.Fatal`).

Manual: `pc-manager-agent.exe install` then `start`. `install` also registers the helper when it is present and applies SCM recovery.

### Tray

The user-session tray reads `http://127.0.0.1:17890/status` and shows enrolled / WS / last error. It also listens on named pipe `\\.\pipe\pc-manager-notify` (SYSTEM + console user SID, same security as capture-helper). The service writes one JSON line `{ kind, title, body }` per toast (`enrolled`, `ws_down`, `ws_up`, `update_applied`, `desktop_incoming`, `mesh_peer`, `agent_recovering`, `quick_assist`). The tray shows `Shell_NotifyIcon` `NIF_INFO` (warning flags for `ws_down` / `agent_recovering`). If nobody is logged on, the service skips the toast. If the pipe is not listening, the service starts `pc-manager-agent tray` as the console user (`CreateProcessAsUser`). Linux/mac: no-op (log).

- **Hide icon** — closes the tray until you run the exe again (no extra Run keys).
- **Start agent** — shown when the service is installed but not running. Elevates once, then coordinated start of **helper then agent**.
- **Stop agent** — confirm, then coordinated stop of **helper then agent** (needs admin). They stay down until **Start agent** / `start` / reinstall.
- **Exit tray** — closes the tray process only; services keep running.
- **Install as service** — shown when the service is not installed (UAC cancelled or not yet elevated).

### Stop vs End task

| Action | Result |
| --- | --- |
| Tray **Stop agent**, `pc-manager-agent.exe stop`, or uninstall | Stops **helper then agent**. Official stop. Stays down. |
| Tray **Start agent** or `pc-manager-agent.exe start` | Starts **helper then agent** (needs admin). |
| Dashboard **kill_switch** | Stops the helper first so it cannot race, then shuts down the host (same as today). |
| Task Manager **End task** on the agent only | SCM recovery + helper start the agent again. |
| End task on **both** services, or official stop | Stays down until start/reinstall. |

Do not use extra Run keys or stealth scheduled tasks besides `PCManagerAgent` and `PCManagerHelper`.

`make dist DEFAULT_SERVER_URL=https://pc.example.com` bakes that URL on every OS. Windows builds also use `-H windowsgui`.

## Linux

```bash
sudo SERVER_URL=https://pc.example.com ENROLLMENT_SECRET=your-secret ./install.sh
```

Installs a systemd unit `pc-manager-agent`.

## Updates

Operators upload binaries (version, platform, arch, notes) in Settings → Agent binaries. The agent polls `GET /api/v1/agent/update`. Download is skipped when the current semver is greater than or equal to the remote (after trimming `v`). Downloads are capped at 100MB (`Content-Length` and `LimitReader`). SHA-256 is verified; the previous binary is kept as `*.bak`. After apply, the agent runs `<exe> version`; if that fails, it restores `.bak` (Linux rename; Windows update bat restores bak and restarts the service if `version` or `sc start` fails).

Build all targets: `make dist` in `apps/agent` (`VERSION=3.3.0` and `DEFAULT_SERVER_URL` by default). Goreleaser config is `.goreleaser.yaml`.

## Sandbox

File commands only run under home, temp, and extra `sandbox_roots`. Path traversal, symlink escape (via `EvalSymlinks`), prefix-boundary mismatches, and sensitive OS paths are denied. Screenshot and transfer size caps are enforced on both agent and server.

## Live transport (WS-first)

HTTP long-poll is the fallback. The agent prefers:

- **Agent WebSocket** (`/agent-ws`) — command push, heartbeats, file chunks, screenshots. Ping ~45s, stale after ~90s.
- **WebRTC remote desktop** — gated by `enable_webrtc` (default **off**). Pion starts only on an SDP offer. Offer/answer and input ride the WS or an E2E envelope. Windows H.264 uses Baseline fmtp as above; JPEG datachannel is the automatic fallback.
- **Modules** — `enable_plugins` remains the backward-compatible policy switch for `run_module`. Approved EXEs run as verified child processes; DLL hosting and legacy `run_plugin` are disabled. The helper/watchdog never executes modules.
- **LAN peer files** — dest may listen on `lanPort` (17891) after an operator ticket (`peer_listen`) for ~20s. A **persistent** mTLS listener on **17891** is started **only when `mesh.enabled`** (enrollment certs, mDNS `_mnag._tcp`, UDP beacon). Discovery and WAN ICE/TURN between agents are gated the same way. Allowlisted `cmd` on the mesh uses `commands.Handle`; unsigned LAN JSON and plugin blob push are refused. Without mesh, 17891 is not always-on.

`make dist` keeps full features. `make dist-lite` (`-tags lite`) stubs WebRTC/desktop.

Server-issued `POST /api/v1/agent/ws-challenge` nonces are required before the WS hello.

## Config keys

| Key | Default | Meaning |
| --- | --- | --- |
| `server_url` | `http://localhost:4000` (or baked `DefaultServerURL`) | Primary API |
| `fallback_urls` | `[]` | Extra API bases |
| `enrollment_secret` | (optional on first run) | Shared enroll secret; empty keeps the process up (not enrolled) |
| `device_id` / `device_key` | assigned | Persist after enroll; do not commit |
| `heartbeat_interval_sec` | `90` | Legacy / idle cadence |
| `idle_heartbeat_sec` | `90` | Idle heartbeat |
| `watched_heartbeat_sec` | `15` | While watched or commanded |
| `poll_interval_sec` | `15` | Long-poll fallback interval |
| `screenshot_interval_sec` | `0` | Watch stills when not in an explicit watch |
| `auto_restart_time` | `""` | `HH:MM` host restart |
| `data_dir` | `~/.pc-manager` | Config, keys, logs; **excluded from the file sandbox**. Empty YAML does not overwrite. Mesh certs live here as `mesh.crt` / `mesh.key` / `mesh-ca.crt` (next to `device_key` in `config.yaml`). Last-known mesh policy is `mesh-policy.json`; peer audit is `mesh-audit.jsonl`. |
| `sandbox_roots` | `[]` | Extra allowed roots besides home and temp |
| `status_port` | `17890` | Local `/status` (`data_dir/status.token` for the helper; tray may omit the header) |
| `lightweight` | `true` | Kept in YAML / `agentConfig`; heartbeats are presence-only regardless |
| `enable_gpu` / `enable_temps` | off | Kept in YAML; not sent on heartbeats |
| `enable_plugins` | on | Backward-compatible switch allowing approved `run_module` execution |
| `enable_screenshot` | on | Watch / capture (macOS agent build is a stub) |
| `enable_webrtc` | off | Remote desktop |

CI, goreleaser, and `make dist` (including darwin, where screenshots are stubbed) live under `apps/agent`. `make dist-lite` omits pion.
