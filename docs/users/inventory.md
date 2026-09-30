# Inventory

Inventory is tables, not a blob inside a command result. **Refresh inventory** queues `collect_inventory`. A daily job also queues it for online devices around 03:00 UTC.

The agent fills what it can actually see:

- Linux and macOS: OS, CPU, one memory total, disks and volumes, network adapters, processes (capped), local users from `/etc/passwd` on Linux, software from `dpkg-query` when that binary exists, USB nodes under `/sys/bus/usb/devices` on Linux. Serial numbers that are OEM placeholders are stored as empty. Missing Windows-only tables stay empty.
- Windows: the same cross-platform fields, plus registry uninstall keys, WMI manufacturer/model/serial when the query works, printers, services from the SCM, and Run-key startup items.

The dashboard device tabs are Hardware, Software, Users, and the live Services list (SCM, not the inventory snapshot). Fleet **Inventory** filters software by name (contains) and version (equals) in SQL.

Software and OS snapshots keep a handful of collection times. Processes keep the latest snapshot only.
