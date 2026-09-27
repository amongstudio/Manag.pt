# Helper (watchdog)

Local sidecar that keeps the Mnag.pt agent service running. It does **not** enroll, store device keys, or call the fleet API.

Masria Code · [Contact@Mnag.pt.com](mailto:Contact@Mnag.pt.com) · [https://Mnag.pt](https://Mnag.pt)

## Role

- Probe `http://127.0.0.1:<status_port>/status` about every **45s** (keep-alives on, loopback only).
- If the agent service is down, start it (with backoff).
- After consecutive probe failures, restart the service.
- Optional local binary replace when `update_file` is set **and** `update_sha256` + `update_signature` + `update_signing_secret` are all present.

Idle footprint should be one loopback GET per probe interval. There is no busy loop.

On Windows, `PCManagerHelper` is a LocalSystem service with SCM restart on failure (5s / 30s / 60s), same as the agent. Official stop is **helper then agent** (`pc-manager-agent.exe stop`, tray **Stop agent**, or uninstall). Official start is **helper then agent** (`pc-manager-agent.exe start` or tray **Start agent**). Ending only the agent in Task Manager is expected to come back; that is the watchdog’s job.

## Config

`helper.yaml` next to the binary, `PC_MANAGER_HELPER_CONFIG`, or `%USERPROFILE%\.pc-manager\helper.yaml` / `~/.pc-manager/helper.yaml`.

See `apps/helper/config.example.yaml`. Do not put `enrollment_secret` or `device_key` in helper config.

`update_file` is optional. If it is empty, the helper does not `os.Stat` a sidecar binary on every tick.

## Run

```bash
cd apps/helper
go test ./...
go run ./cmd/helper
```

Build: `make dist` in `apps/helper`.
