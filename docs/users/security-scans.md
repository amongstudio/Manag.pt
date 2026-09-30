# Security scans

There is no exploit engine. The agent only runs `nmap`, `nuclei`, or `trivy` when that binary is on `PATH`, and only after the target passes `config/scan-scope.yaml`. If the binary is missing, the scan summary is `nmap_unavailable`, `nuclei_unavailable`, or `trivy_unavailable`. The product does not invent results.

## Allowlist

`SECURITY_AUTHORIZATION.md` is the human record (signature lines are blank until a person signs them). The process enforces the YAML:

- `lab_mode: true` (the default, including when the key is omitted) allows only `127.0.0.1/32`, `::1`, and `lab_networks`.
- Otherwise the target must sit inside `authorized_networks`.
- `excluded_hosts` may be a single address or a CIDR. Overlap is refused.
- Targets are IPv4 addresses, IPv4 CIDRs, or `http(s)` URLs whose host is one of those addresses. DNS names are refused. A URL userinfo cannot hide a second host; Nuclei is given a URL whose host is the authorized address.

A fresh checkout cannot scan a LAN. `8.8.8.8` and `192.168.1.10` return **403 `target_refused`** under the default file.

Nmap is `nmap -sV -O -oX - --max-rate <scan_rate_limit>` with the YAML timeout. `--script vulners` is added only when `enable_vulners: true` (default false). CVE ids parsed from that script are stored as findings. They are version correlations, not exploits. Product/version pairs are cached for 30 days.

Nuclei is always invoked with `-severity critical,high,medium` and `-exclude-tags dos,intrusive,fuzz,exploit`. There is no switch that puts those tags back. The agent does not run `nuclei -update-templates`. Operators who want fresh templates run that themselves, about weekly.

Trivy, when present, is `trivy fs --scanners vuln --format json --offline-scan --skip-db-update`. When it is absent, package CVE lookup is skipped and the summary says so. Local outdated checks use `config/software-rules.yaml` (name and minimum version) with no network call.

Host posture also reads data the agent already collected: Defender real-time off, a firewall profile off, BitLocker protection off, pending high/critical Windows updates, autologon, and SMBv1 when a read-only registry value says so.

## Findings

Statuses: `open` → `acknowledged` → `remediating`, or `open`/`acknowledged` → `accepted` with a reason in the audit log. A later scan that does not report the same host/source/category/title/CVE marks the row `fixed`. If it appears again, it returns to `open` unless it was left `acknowledged`, `remediating`, or `accepted`. Acknowledging a finding that is already acknowledged returns **409**.

**Remediate** queues the linked library script through the normal script-run API. Link a script on the Security page first.

Open findings export as CSV from the Security page. Every scan start and end writes an `AuditLog` row.
