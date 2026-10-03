# Operator runbook

Day-to-day deploy, rollback, SQLite lock, enrollment secret, installer, and scan-scope notes are in the repository root [RUNBOOK.md](../../RUNBOOK.md). Read that file before changing production. This page adds the scanner binaries, dashboard configuration, and the GitHub steps that cannot be done from the agent environment.

## Dashboard configuration

Change operator-editable values on **Configuration** and **Settings**. Do not hand-edit the YAML for a running API.

- Settings stores notification targets (Telegram, webhook, Teams, SMTP), metric retention, thresholds, and mesh policy in the `app` settings row. Secrets are masked in responses. Replacing a masked value writes a new secret. The settings cache drops on save.
- Configuration stores rules, automations, scan scope, and software version rules as text. On first read, empty rows are seeded from `config/*.yaml`. Later reads use the database, and the in-memory rule, automation, software-rule, and scan-scope caches reload immediately. `authorizeTarget` still applies: lab mode, the allowlist, and excluded CIDRs. Saving `lab_mode: false` with an empty allowlist returns `empty_allowlist`. Saving `0.0.0.0/0` returns `allowlist_too_wide`.
- Agent intervals are pushed on the next heartbeat. An offline agent keeps its last `config.yaml` or registry values and applies the new intervals when it connects.
- Helper options are queued as `apply_config` for online devices. The agent writes `helper.yaml` and does not log the enrollment secret. Probe interval, backoff, and the other watchdog fields apply the next time the helper process starts.
- Every save writes `AuditLog` action `config_save` with the section and key names, not secret values.
- `PUBLIC_URL`, enrollment secret, credentials key, operator token, and compile enable stay in the environment. Restart the API after changing them. Script cron expressions are still checked on the Scripts page (`invalid_cron`).

## Public access

Configuration → Public access starts one reverse tunnel for the dashboard (default `127.0.0.1:3000`) and, if the operator turns it on, a second tunnel for the API port (default `127.0.0.1:4000`). The API restarts a tunnel it started if that process exits, with backoff, and stops after five retries. Stop signals only that process id. Nothing is published on boot unless `enabled` was saved by Start. Provider tokens are write-only in the `tunnel` settings row. Audit actions are `tunnel_save`, `tunnel_start`, and `tunnel_stop` with the provider name, not the secret. The operator token and scan allowlist still apply. Details: [Public access](../users/public-access.md).

## Scanner binaries

Install on the **agent host**, not necessarily the API host. The API only queues the command.

- `nmap` — port and service scan. Without it, scans finish as `nmap_unavailable`.
- `nuclei` — template scan with the safe flags baked into the agent. Update templates yourself: `nuclei -update-templates` about weekly. The agent will not do that.
- `trivy` — optional offline package scan. Without it, posture says `trivy_unavailable` and still evaluates Defender, firewall, BitLocker, Windows updates, and the software version rules (seeded from `config/software-rules.yaml`).

Keep lab mode on until authorized networks list only ranges you own. Edit that list on Configuration. Sign `SECURITY_AUTHORIZATION.md` when that list is real. The signature in git is a blank line. The git YAML remains the default for a new database.

## GitHub

- Do not merge or close pull requests from an environment that cannot write to GitHub safely.
- PR #3 is the fleet platform. PR #4 is the security module. Leave both for a human review.
- Enable branch protection on `main` so the CI workflow must pass. That setting is not available from the cloud agent.

## Rollback

```bash
git tag v3.4.0 <sha>
git push origin v3.4.0
git checkout v3.4.0
```

Push the tag only when you mean to publish it. Migrations 0017–0019 are additive. Restoring an older binary leaves the new tables in place. Restoring `data/pcmanager.db` from `data/backups/` is the data rollback, and only while the API is stopped.
