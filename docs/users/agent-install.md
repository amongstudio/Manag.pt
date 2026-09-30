# Agent install

The Windows installer is `apps/agent/installer/pc-manager.iss` (Inno Setup 6, Unicode). It follows `apps/agent/install.ps1`:

1. Copy `pc-manager-agent.exe` and, when present, `pc-manager-helper.exe` to `%ProgramFiles%\PC Manager Agent`.
2. Write `config.yaml` only when that file is missing. `/SERVER=` and `/SECRET=` become `server_url` and `enrollment_secret`.
3. Run the binaries' own commands: helper `install`, agent `install`, helper `start`, agent `start`.

Service names are **PCManagerHelper** and **PCManagerAgent** (LocalSystem). Uninstall stops and uninstalls the helper first, then the agent, so the watchdog cannot start the agent again.

Silent install:

```text
pc-manager-setup.exe /VERYSILENT /SERVER=https://pc.example.com /SECRET=your-enrollment-secret
```

`/VERYSILENT` is Inno Setup's switch. This repository does not contain a certificate. Signing is optional and uses your own `signtool` and `CERT_THUMBPRINT`. The commands are in the `.iss` header and in `RUNBOOK.md`. Build the binaries first:

```text
cd apps/agent && make dist
cd apps/helper && make dist
ISCC.exe apps/agent/installer/pc-manager.iss
```

Inno Setup was not executed in the Linux build environment. The script matches the Go `install` / `start` / `stop` / `uninstall` subcommands.

## Linux and macOS

`apps/agent/install.sh` installs a systemd unit. There is no package installer for macOS. Screen capture on macOS agent builds does not grab the display. Windows-only commands (SCM services, event log, Defender, BitLocker, registry writes) return `unsupported` on other platforms.

`watched_services` in `config.yaml` is the list of service names sampled as `service_up`. The Windows registry config store does not round-trip that list; a service that loads config only from `HKLM\SOFTWARE\PC Manager\Agent` will not keep it unless `config.yaml` is what the process reads.

The agent module is Go 1.25+. The helper module is Go 1.23.
