# Monitoring and alerts

Heartbeats stay presence-only (`lastSeen`, online/offline). Metrics are a separate WebSocket message, type `metrics`, about every 60 seconds: `cpu_pct`, `ram_pct`, `disk_free_pct` per volume, agent uptime, boot time, session count, and `service_up` for names in `watched_services`. The API stores `MetricSample` rows and deletes samples older than 30 days.

## Rules

`config/rules.yaml` is read by the API job loop. A rule names a metric, a comparator, a threshold, and `forSamples` (or a duration rounded to 60-second samples). `storage-failure` correlates disk free below the threshold with `service_up == 0` for the labeled service name. If the agent is not reporting that service, the correlator does not fire.

Notifications:

- Telegram, Discord, and SMTP use Settings and the existing send lease (a row in `sending` is not delivered twice).
- Teams is an HTTPS incoming webhook (`settings.teams` or a rule `notify.teams` URL) with a MessageCard body. A rule URL equal to the settings URL is sent once.
- A rule `notify.webhook` URL is sent immediately and is not copied into the notification row.

Socket rows show on Overview and Alerts.

## Automations

`config/automations.yaml` is the same job loop:

- Restart a named service when the latest `service_up` sample or inventory row says it is stopped.
- Disk free is the rule above, not a second alert.
- Re-enable Defender only when the last successful `get_defender` result says real-time protection is off (`set_defender`).
- Stale heartbeat on Windows can queue `restart_service` for `PCManagerAgent`. It does **not** queue the host `restart` command. A disconnected agent cannot run a command; the helper and SCM recovery are the on-box path.
- Kill a configured process name is off unless you enable that entry.

Each run writes an `AuditLog` row. Failures raise `automation_failed`.
