# Operator runbook

Day-to-day deploy, rollback, SQLite lock, enrollment secret, installer, and scan-scope notes are in the repository root [RUNBOOK.md](../../RUNBOOK.md). Read that file before changing production. This page adds the scanner binaries and the GitHub steps that cannot be done from the agent environment.

## Scanner binaries

Install on the **agent host**, not necessarily the API host. The API only queues the command.

- `nmap` — port and service scan. Without it, scans finish as `nmap_unavailable`.
- `nuclei` — template scan with the safe flags baked into the agent. Update templates yourself: `nuclei -update-templates` about weekly. The agent will not do that.
- `trivy` — optional offline package scan. Without it, posture says `trivy_unavailable` and still evaluates Defender, firewall, BitLocker, Windows updates, and `config/software-rules.yaml`.

Keep `lab_mode: true` until `authorized_networks` lists only ranges you own. Sign `SECURITY_AUTHORIZATION.md` when that list is real. The signature in git is a blank line.

## GitHub

- Do not merge or close pull requests from an environment that cannot write to GitHub safely.
- PR #3 is the fleet platform. PR #4 is the security module. Leave both for a human review.
- Enable branch protection on `main` so the CI workflow must pass. That setting is not available from the cloud agent.

## Rollback

```bash
git tag v3.3.0 <sha>
git push origin v3.3.0
git checkout v3.3.0
```

Push the tag only when you mean to publish it. Migrations 0017–0019 are additive. Restoring an older binary leaves the new tables in place. Restoring `data/pcmanager.db` from `data/backups/` is the data rollback, and only while the API is stopped.
