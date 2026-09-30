# Scripts

Library rows live in the `Script` table: name, description, language (`powershell`, `python`, `batch`, or `shell`), content, parameter definitions, and timeout (1–3600 seconds, default 60).

**Run** on Scripts, or **Remediate** on a linked finding, creates a `ScriptRun` and queues the existing `run_script` command. The agent runs the script with its own privilege. There is no second channel.

- `powershell` uses `powershell` on Windows and `pwsh` elsewhere (error `powershell_not_found` if `pwsh` is missing).
- `python` uses `python3` or `python` (`python_not_found` otherwise).
- `batch` and `shell` use `cmd /C` on Windows and `sh -c` elsewhere.
- An empty language keeps the old default: PowerShell on Windows, `sh` elsewhere.

`{{Name}}` is replaced from the parameter values before the process starts. A parameter can have an anchored `pattern` (`^…$`, up to 200 characters). Run-time values and the default must match it, and any value with a line break or NUL is rejected (`invalid_parameter:<name>`), so a value cannot add statements. Stdout and stderr are capped at 64KiB.

## Templates

The **Templates** card on Scripts lists reviewed, read-only PowerShell checks defined in `packages/shared/src/script-templates.ts`: inventory snapshot, Windows Update check (search only), disk cleanup preview (measures, deletes nothing), winget upgrade dry run, service status, recent system errors, and Defender status. Their content is fixed, and every parameter has a strict pattern with no quotes, spaces, or shell metacharacters.

**Run on device** posts `templateId` to `POST /api/v1/admin/devices/:id/scripts/run`. The API resolves the template on the server, so the browser cannot change its content, and the `script_run` audit row records the template id. **Copy to editor** loads the template into the library form so you can review it and save a copy. `GET /api/v1/admin/script-templates` returns the list. The exit code is stored on `ScriptRun` when the command result arrives.

Schedules are five-field UTC cron expressions on `ScriptSchedule`. The API job loop (about once a minute) queues due schedules. One device, or every enrolled device up to 200 when `deviceId` is empty. The same minute is not fired twice.

Only operator-authenticated admin routes can create, edit, run, or schedule scripts. Mesh peers cannot run `run_script` unless an operator explicitly allowlists it, and credential commands stay blocked.
