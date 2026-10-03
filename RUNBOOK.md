# Mnag.pt operator runbook

Version **3.4.0**. This file is the local deploy, rollback, and limit list for the RMM work on `cursor/rmm-platform-4753`.

## Deploy locally

From the repo root (the API and dashboard are already a pnpm workspace):

```bash
cp .env.example .env
# ENROLLMENT_SECRET in .env.example is a dev placeholder. Production must be
# at least 16 characters and must not start with change-me-.
pnpm install
pnpm --filter @workspace/db generate
pnpm --filter @workspace/db exec prisma migrate deploy
pnpm --filter api dev      # :4000
pnpm --filter web dev      # :3000
```

Open http://localhost:3000. The API applies the same Prisma migrations on startup. Do not run `migrate deploy` from a second process while that API holds `data/pcmanager.db`.

Agent (from `apps/agent`, so `config.yaml` is found):

```bash
cd apps/agent
cp config.example.yaml config.yaml
# enrollment_secret must match ENROLLMENT_SECRET
make run
```

`CREDENTIALS_KEY` is optional. When it is unset, the credential vault keeps deriving its AES-256-GCM key from `UPDATE_SIGNING_SECRET`. Set `CREDENTIALS_KEY` before the first vault backup if you want a separate secret. Changing either value makes existing `DeviceCredential.secretEnc` rows undecryptable.

SQLite is not SQLCipher. Prisma talks to the existing `file:` database; enabling SQLCipher would replace the engine and can destroy `data/pcmanager.db`. The credential blob is the encrypted column. Remote desktop media is WebRTC DTLS/SRTP (and the agent WebSocket is only as protected as the URL scheme: use HTTPS/WSS in production).

## Roll back

Do not push a tag from this environment unless you intend to publish it. To mark the previous release after you have chosen the commit:

```bash
git tag v3.4.0 <sha>
git push origin v3.4.0
git checkout v3.4.0
```

Schema changes in `packages/db/prisma/migrations/0017_platform` and `0018_inventory` are additive. Rolling the binary back without restoring a SQLite backup leaves the new tables in place; the older API ignores them. Restoring `data/pcmanager.db` from `data/backups/` is the data rollback. Copy the db only while the API is stopped.

## What breaks

- **SQLite lock.** `prisma migrate deploy` fails with `database is locked` if the API process has the file open. Stop that API PID (do not `pkill -f`) or restart that process so it can apply migrations itself.
- **Enrollment secret.** Agents enroll with `ENROLLMENT_SECRET`. A mismatch does not create a second device row; the same hostname and platform without a device key returns **409 `device_exists`**.
- **Go version.** `apps/agent/go.mod` requires Go **1.25+**. `apps/helper/go.mod` is Go **1.23**. This image's `/usr/bin/go` may be older than 1.25; CI and local agent builds need a 1.25+ toolchain (the cloud image used for this branch has 1.27.1). `go test ./...` in `apps/agent` must stay green on Linux.
- **Watched services.** Service-state metrics and the "service stopped" correlator only exist for names listed in the agent `watched_services` YAML list. The Windows registry config store does not round-trip that list; a service install that persists config only in `HKLM\SOFTWARE\PC Manager\Agent` will not keep it unless `config.yaml` is what the process loads.
- **Stale agent restart.** The automation never queues the host `restart` command (that reboots Windows). A disconnected agent cannot run a command. On Windows, a still-online but stale heartbeat can queue `restart_service` for `PCManagerAgent` at most once per cooldown. The helper and SCM recovery are the on-box path.

## Windows installer

Inno Setup 6 (Unicode), from `apps/agent` after the binaries exist:

```powershell
cd apps/agent
make dist
cd ../helper
make dist
cd ../agent
# Optional, before ISCC. Do not commit a certificate.
# signtool sign /sha1 %CERT_THUMBPRINT% /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 dist\pc-manager-agent-windows-amd64.exe
# signtool sign /sha1 %CERT_THUMBPRINT% /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 ..\helper\dist\pc-manager-helper-windows-amd64.exe
& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer\pc-manager.iss
```

Silent install matches `install.ps1`: it copies `pc-manager-agent.exe` and `pc-manager-helper.exe` to `%ProgramFiles%\PC Manager Agent`, writes `config.yaml` only when that file is missing, then runs the binaries' own `install` and `start` commands (LocalSystem services `PCManagerHelper` then `PCManagerAgent`).

```text
pc-manager-setup.exe /VERYSILENT /SERVER=https://pc.example.com /SECRET=your-enrollment-secret
```

`/SERVER` and `/SECRET` are Inno `/param` values. Uninstall runs helper `stop`, helper `uninstall`, agent `stop`, agent `uninstall`.

To sign the setup as well, pass a SignTool definition. The `.iss` does not embed a certificate:

```text
ISCC.exe /S"mysign=signtool sign /sha1 %CERT_THUMBPRINT% /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 $f" /DSignSetup installer\pc-manager.iss
```

This environment cannot run Inno Setup or a Windows VM. The script was checked against `install.ps1`, `winsvc` service names, and `pc-manager-agent.exe install|start|stop|uninstall`.

## Alert rules and automations

`config/rules.yaml` is read by the API job loop (about every 60 seconds). `config/automations.yaml` is the same loop. Notification URLs in those files are secrets; the examples use placeholders. Teams is an incoming webhook (`settings.teams` or a rule `notify.teams` URL) and uses a MessageCard JSON body. Webhook URLs are not written into `Notification` rows.

## Operator steps this environment cannot do

- **PR #1** (`cursor/cloud-env-setup-4753`, "Add a Cloud Agent environment for local development") was still **open** when this branch was cut. **PR #2** (`cursor/stability-fixes-4753`, Linux agent build) is **merged**. Do not merge or close either pull request from the agent. An operator with GitHub permissions should close PR #1 if the environment setup is already captured, and should leave PR #2 merged.
- **Branch protection on `main`.** Require the `CI` / `check` workflow before merge. This environment cannot change GitHub branch protection.
- **Code signing** needs a real `CERT_THUMBPRINT` and Windows `signtool`. Nothing in the repo is signed.
- **Pushing `v3.4.0`** is an operator action. The tag command is above; this branch does not push a tag.

## Security scans

`config/scan-scope.yaml` is the allowlist. `lab_mode: true` accepts only `127.0.0.1/32`, `::1`, and `lab_networks`. The human record is `SECURITY_AUTHORIZATION.md`; a blank signature line means nobody has signed it. Nmap, Nuclei, and Trivy run on the agent only when those binaries are on `PATH`. Nuclei always excludes tags `dos,intrusive,fuzz,exploit` and does not update templates. Do not point a scan at a network that is not listed.

## Not built

- SQLCipher for the whole SQLite file.
- A visual alert-rule builder, deployment rings, or CVE mapping.
- A new remote-desktop capture stack. Multi-monitor selection, clipboard text, and file drag/drop already exist on the current WebRTC and file channels. Session watermark, consent, privacy-screen request, owner, and invite token are stored on the session row and shown in the dashboard; privacy screen does not blank the Windows console.
- Mesh was not rewritten. Accept handling is capped at 32 concurrent connections so a peer flood cannot start an unbounded number of goroutines.
- PDF reports and a visual query builder. CSV and HTML exports cover software inventory, update approval, and alert history.
