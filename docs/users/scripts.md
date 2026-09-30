# Scripts

Library rows live in the `Script` table: name, description, language (`powershell`, `python`, `batch`, or `shell`), content, parameter definitions, and timeout (1–3600 seconds, default 60).

**Run** on Scripts, or **Remediate** on a linked finding, creates a `ScriptRun` and queues the existing `run_script` command. The agent runs the script with its own privilege. There is no second channel.

- `powershell` uses `powershell` on Windows and `pwsh` elsewhere (error `powershell_not_found` if `pwsh` is missing).
- `python` uses `python3` or `python` (`python_not_found` otherwise).
- `batch` and `shell` use `cmd /C` on Windows and `sh -c` elsewhere.
- An empty language keeps the old default: PowerShell on Windows, `sh` elsewhere.

`{{Name}}` is replaced from the parameter values before the process starts. Stdout and stderr are capped at 64KiB. The exit code is stored on `ScriptRun` when the command result arrives.

Schedules are five-field UTC cron expressions on `ScriptSchedule`. The API job loop (about once a minute) queues due schedules. One device, or every enrolled device up to 200 when `deviceId` is empty. The same minute is not fired twice.

Only operator-authenticated admin routes can create, edit, run, or schedule scripts. Mesh peers cannot run `run_script` unless an operator explicitly allowlists it, and credential commands stay blocked.
