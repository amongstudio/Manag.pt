# Security scans

There is no exploit engine. The agent only runs `nmap`, `nuclei`, or `trivy` after the target passes `config/scan-scope.yaml`. If the binary cannot be found, the scan summary is `nmap_unavailable`, `nuclei_unavailable`, or `trivy_unavailable`. The product does not invent results.

## Finding and installing the scanners

The agent runs as a Windows service, so its `PATH` is the machine `PATH` from when the service started, not your user `PATH`. That is why a scanner installed interactively often showed as unavailable. The agent now looks in this order and uses the first working binary:

1. Its own tools directory, `<agent data dir>\tools\<tool>\<version>\`.
2. The service `PATH`.
3. The current machine `PATH` from the registry, so a new install is found without restarting the service.
4. The standard Program Files folders (for example `C:\Program Files (x86)\Nmap`).

User-writable folders (the user profile, temp) are never searched.

On **Security**, select a device and click **Check tools** to see each tool's status, version, and where it was found. **Install pinned** is operator-invoked and confirmed. It downloads one fixed official release, checks its SHA-256 before extracting, extracts into the agent's tools directory (rejecting path traversal and oversized archives), runs `--version`, and writes an audit row. Only one install runs per device at a time.

| Tool | Pinned release | Notes |
| --- | --- | --- |
| nuclei | 3.11.1 | Windows amd64, Linux amd64/arm64. |
| trivy | 0.74.0 | Windows amd64, Linux amd64/arm64. The install also downloads the vulnerability database into `tools\trivy\cache`. |
| nmap | 7.92 (win32 zip) | The newest nmap published as a zip. Its bundled Microsoft Visual C++ x86 runtime is installed silently. Npcap is not installed. |

Without Npcap, nmap runs `--unprivileged -sT -sV` (TCP connect, no OS detection). With Npcap present, it runs `-sV -O`. The tool status shows which mode applies.

**Scan history** on the Security page can be filtered by tool (Nmap, Nuclei, Trivy through host posture) and by the selected device. The API equivalent is `GET /api/v1/admin/scans?tool=nmap&deviceId=<id>`. Summaries that say `*_unavailable` or `trivy_db_missing` show a hint pointing to Scanner tools.

## Allowlist

`SECURITY_AUTHORIZATION.md` is the human record (signature lines are blank until a person signs them). Operators change the scope on Configuration. The process enforces that saved scope (seeded from `config/scan-scope.yaml` when the database row is empty):

- `lab_mode: true` (the default, including when the key is omitted) allows only `127.0.0.1/32`, `::1`, and `lab_networks`.
- Otherwise the target must sit inside `authorized_networks`.
- `excluded_hosts` may be a single address or a CIDR. Overlap is refused.
- Targets are IPv4 addresses, IPv4 CIDRs, or `http(s)` URLs whose host is one of those addresses. DNS names are refused. A URL userinfo cannot hide a second host; Nuclei is given a URL whose host is the authorized address.

A fresh checkout cannot scan a LAN. `8.8.8.8` and `192.168.1.10` return **403 `target_refused`** under the default file.

Nmap is `nmap -sV -O -oX - --max-rate <scan_rate_limit>` with the YAML timeout (`--unprivileged -sT -sV` without `-O` when Npcap is missing). `--script vulners` is added only when `enable_vulners: true` (default false). CVE ids parsed from that script are stored as findings. They are version correlations, not exploits. Product/version pairs are cached for 30 days.

Nuclei is always invoked with `-severity critical,high,medium` and `-exclude-tags dos,intrusive,fuzz,exploit`. There is no switch that puts those tags back. The agent does not run `nuclei -update-templates`. Operators who want fresh templates run that themselves, about weekly.

Host posture now runs Trivy, when present, as `trivy fs --scanners vuln --format json --offline-scan --skip-db-update` over `trivy_paths` from the agent's `config/scan-scope.yaml`. When that key is unset, it scans Program Files on Windows, or `/opt` and `/usr/local` elsewhere; `trivy_paths: []` turns it off. The posture result reports Trivy as `scanned`, `partial`, `db_missing`, `failed`, `no_paths`, or `unavailable`. When Trivy is absent, package CVE lookup is skipped and the summary says so. Local outdated checks use `config/software-rules.yaml` (name and minimum version) with no network call.

Host posture also reads data the agent already collected: Defender real-time off, a firewall profile off, BitLocker protection off, pending high/critical Windows updates, autologon, and SMBv1 when a read-only registry value says so.

## Findings

Statuses: `open` → `acknowledged` → `remediating`, or `open`/`acknowledged` → `accepted` with a reason in the audit log. A later scan that does not report the same host/source/category/title/CVE marks the row `fixed`. If it appears again, it returns to `open` unless it was left `acknowledged`, `remediating`, or `accepted`. Acknowledging a finding that is already acknowledged returns **409**.

**Remediate** queues the linked library script through the normal script-run API. Link a script on the Security page first.

Open findings export as CSV from the Security page. Every scan start and end writes an `AuditLog` row.
