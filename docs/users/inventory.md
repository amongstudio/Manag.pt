# Inventory

Inventory is tables, not a blob inside a command result. **Refresh inventory** queues `collect_inventory`. A daily job also queues it for online devices around 03:00 UTC.

The agent fills what it can actually see:

- Linux and macOS: OS, CPU, one memory total, disks and volumes, network adapters, processes (capped), local users from `/etc/passwd` on Linux, software from `dpkg-query` when that binary exists, USB nodes under `/sys/bus/usb/devices` on Linux. Serial numbers that are OEM placeholders are stored as empty. Missing Windows-only tables stay empty.
- Windows: the same cross-platform fields, plus registry uninstall keys, WMI manufacturer/model/serial when the query works, printers, services from the SCM, and Run-key startup items.

The dashboard device tabs are Hardware, Software, Users, and the live Services list (SCM, not the inventory snapshot). Fleet **Inventory** filters software by name (contains) and version (equals) in SQL.

## Software actions

Both actions are confirmed, audited (action `install_app` or `uninstall_app` with the operator and the validated payload), and never mesh-forwardable.

- **Install from winget** (`install_app`) takes a winget package id (`^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$`), an optional version, and an optional machine or user scope. The agent runs `winget install --id <id> --exact --silent --source winget --accept-package-agreements --accept-source-agreements --disable-interactivity` from an argument list, with no shell. When winget is not on the service `PATH`, the agent finds the newest `Microsoft.DesktopAppInstaller` package.
- **Uninstall** (`uninstall_app`) matches the exact display name in the uninstall registry keys. MSI products use `msiexec /x {ProductCode} /qn /norestart`. Otherwise the agent uses the entry's `QuietUninstallString` only if it is an absolute `.exe` that is not a shell or script host, then falls back to `winget uninstall --exact`. Interactive-only uninstallers are refused with `interactive_uninstaller_only`.

The dashboard has no upload-and-run installer. To run your own installer or tool, register it in the signed module catalog (**Modules**), where it is signed, registered disabled, and needs approval and device grants.

## Local accounts

On Windows, **Users → Load local accounts** queues `get_local_users` and shows each local SAM account: full name, comment, enabled, locked out, administrator, password age, expiry, and whether a password is required, plus last logon and logon count. Passwords and hashes are never read or returned.

**Enable**, **Disable**, and **Set password** (`local_user_action`) are confirmed and audited. They accept only local account names (no `DOMAIN\user` or `user@domain`), are refused on domain controllers, and will not disable the last enabled administrator. The new password is 8–127 characters, sealed with the vault key in the queued command, and redacted from command history and the audit log. The agent zeroes its copy after `NetUserSetInfo`.

Software and OS snapshots keep a handful of collection times. Processes keep the latest snapshot only.
