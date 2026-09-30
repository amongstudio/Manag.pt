# Agent

Module `github.com/pc-manager/agent`, Go **1.25+**. Entry `apps/agent/cmd/agent`. Helper is a separate module, Go 1.23.

`commands.Handle` is the only execution switch. Classes are exclusive (power, update), long (scripts, scans, inventory, Windows tools), and fast (everything else).

Scan-related types:

- `network_scan` — `internal/scan.RunNmap` after `AuthorizeTarget`. Error `nmap_unavailable` when `nmap` is not on `PATH`
- `nuclei_scan` — `TargetHost` + `NucleiURL`, then nuclei with the fixed safe arguments. Error `nuclei_unavailable`
- `host_posture` — read-only Winlogon `AutoAdminLogon` and LanmanServer `SMB1` when the registry read works; reports whether `trivy` is on `PATH`
- `collect_inventory` — `internal/inventory.Collect`

`internal/scan` parses Nmap XML and Nuclei JSONL. Tests use `apps/agent/testdata`. They do not scan the network.

`run_module` is implemented in `internal/moduletool`. It accepts only a catalog ID, the expected signed manifest, and a bounded argument array. EXEs run directly as child processes after signature, hash, PE, target, and argument checks. `run_plugin` is disabled. DLL plug-ins return an explicit unsupported error until a dedicated module-host executable and ABI exist.

## Adding a command

1. Add the string to `COMMAND_TYPES` in `packages/shared/src/commands.ts`.
2. Add a payload schema in `packages/shared/src/schemas.ts` (`commandPayloadSchemas`).
3. Handle it in `apps/agent/internal/commands/commands.go` and `Classify`.
4. If peers must never run it, add it to `MESH_NEVER_COMMANDS` and `apps/agent/internal/mesh/policy.go` `neverCommands`.
5. If the API must store rows from the result, extend `applyCommandEffects`.

`apply_config` writes `helper.yaml` under the agent data directory via `internal/helpercfg`. The payload is watchdog options only (service name, status port, backoff, probe interval, fail threshold, max backoff, startup grace). It does not carry enrollment secrets. Optional `watchedServices` updates the agent config and saves it. The command is in `MESH_NEVER_COMMANDS`. The helper process still loads `helper.yaml` at startup, so a probe-interval change applies after the helper restarts. An explicit `startup_grace_sec: 0` is kept; omitting the field leaves the 60 second default. `HELPER_PROBE_INTERVAL_SEC`, `HELPER_FAIL_THRESHOLD`, `HELPER_MAX_BACKOFF_SEC`, and `HELPER_STARTUP_GRACE_SEC` override the file the same way `HELPER_BACKOFF_SEC` already did.

`gofmt` Go changes. `go test ./...` in `apps/agent` must pass on Linux. Windows files are behind `//go:build windows`.

Build: `make build` or `make dist` in `apps/agent`. See `docs/users/agent-install.md` for the installer.
