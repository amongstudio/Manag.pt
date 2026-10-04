# Inventory

Inventory is tables, not a blob inside a command result. **Refresh inventory** queues `collect_inventory`. A daily job also queues it for online devices around 03:00 UTC.

The agent fills what it can actually see. OEM placeholder serials are stored as empty. The collector does not invent serials, monitors, or roles.

- Linux: hostname, FQDN (`hostname -f`), kernel, boot time, uptime, timezone, DNS and domain from `/etc/resolv.conf`, default gateway from `/proc/net/route`, primary addresses, and roles inferred from listening ports (`ss`). DMI files supply manufacturer, model, serial, chassis type, and BIOS when the kernel exposes them. `dmidecode -t memory` adds module size, speed, and locator when it is permitted. `lsblk` supplies disk model and serial. `dpkg-query` supplies package name, version, and maintainer. `systemctl show` supplies service state, start type, user, binary path, and drop-in path. Listening ports are attached from that one `ss` call. Processes are the latest snapshot (name, pid, user, cpu, rss), capped, and older snapshots are deleted. Memory modules, GPUs, monitors, and a helper version stay empty when the OS does not expose them.
- macOS: the same cross-platform fields, plus `brew list --versions` when Homebrew is installed. DMI and systemd fields stay empty.
- Windows: WMI for computer system, BIOS, chassis, processors, memory modules, disk drives, and the operating system caption. Services come from `Win32_Service` (start name and path) when that query works, otherwise the SCM list. Software comes from the uninstall registry, including install date and install location. Paths that contain a password are stored redacted.

The device **Hardware** tab includes the server fields. **Software** shows source and install path. **Services** shows the inventory snapshot (account, ports, path) above the live service controls. Fleet **Inventory** still filters software by name (contains) and version (equals) in SQL.

Software and OS snapshots keep a handful of collection times. Processes keep the latest snapshot only.
