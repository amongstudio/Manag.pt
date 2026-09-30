# Safe module library

The module library is the supported artifact-execution path. Legacy `/admin/plugins` registration and `run_plugin` dispatch are disabled because they accepted arbitrary scripts and binaries without a signed approval manifest.

Arbitrary-process DLL injection, process hollowing, reflective loading, and remote-thread execution are not implemented. The dashboard has no process selector or injection controls.

## Trust boundary and lifecycle

1. An authenticated operator registers a Windows PE `.exe` or `.dll`. The API checks the extension, PE kind, machine architecture, size, and manifest schema.
2. The API hashes the artifact and signs the execution-critical manifest with an Ed25519 key derived from `UPDATE_SIGNING_SECRET`. New rows are disabled and have no device grants.
3. An operator reviews the hash, target, argument schema, timeout, and output bound, then explicitly enables the module and grants devices.
4. Dispatch writes a `run_module` command pinned to the current manifest signature. Revocation disables the row and clears grants; stale queued or retried commands fail closed.
5. The agent fetches metadata and a short-lived signed download URL over HTTPS (plain HTTP is accepted only for loopback development). It verifies the signer fingerprint, Ed25519 signature, expected command signature, SHA-256, exact size, PE kind, OS, architecture, and arguments.
6. An EXE runs directly with an argument array, never through a shell. It gets a private run directory, bounded stdout/stderr, a timeout, process-tree termination, a reduced environment, and best-effort network denial. Cancellation is sent on `/agent-ws`.
7. DLL artifacts can be cataloged and revoked, but dispatch and execution return `dll_plugin_host_pending`. A future DLL ABI must run only in a dedicated agent-owned module-host process.

The main agent never loads module DLLs. No command payload contains raw artifact bytes, a local server path, or an operator-supplied URL.

## API and data

- `GET/POST /api/v1/admin/modules`
- `GET/PATCH /api/v1/admin/modules/:id`
- `PUT /api/v1/admin/modules/:id/grants`
- `POST /api/v1/admin/modules/:id/runs`
- `POST /api/v1/admin/modules/:id/revoke`
- authenticated agent metadata and signed downloads under `/api/v1/agent/modules` and `/api/v1/agent/download-module`

`ModuleArtifact` stores the public manifest, internal artifact path, signature, state, and limits. `ModuleDeviceGrant` is the per-device allowlist. API serializers never return the internal path or signing secret. Register, update, grant, run, and revoke operations append `AuditLog` rows.

## Audit findings addressed in this pass

- The old plugin route was a high-impact unsigned arbitrary upload-and-run path (Python, Go source, or binary). Its route registration, dashboard controls, agent fetch, command dispatch, and copilot exposure are disabled.
- Cookie-authenticated admin mutations relied on CORS and `SameSite=Lax` but did not validate `Origin`. Admin unsafe methods now reject untrusted origins and `Sec-Fetch-Site: cross-site`.
- Command cancellation changed database state but did not stop a running child. `run_module` now has an authenticated WebSocket cancellation frame and pending-cancel tombstones.
- Plugin operations were not consistently audited. Every module lifecycle mutation and dispatch is audited without paths, keys, or artifact contents.
- Existing update downloads had signed URLs and SHA-256 but no artifact manifest signature. Modules extend `UPDATE_SIGNING_SECRET` with a storage-tamper-evident Ed25519 manifest signature and re-check the hash before every run.
- Admin update-list/upload and backup responses exposed server filesystem paths that the UI did not need. They now return public metadata or a basename only.

## Deliberate limitations

- The public signing key is delivered by the authenticated API rather than pinned in agent configuration. HTTPS is therefore required outside loopback; key pinning/rotation needs a provisioning design.
- Windows network denial is best effort, not a security sandbox. Modules should be treated as approved administrative code.
- CPU and memory job-object quotas and an Authenticode trust policy are deferred. This MVP enforces artifact size, argument count/length, output size, timeout, cancellation, and process-tree cleanup.
- Artifact replacement under one stable ID is intentionally deferred. Register a new ID for a new artifact until version history and rollback semantics are approved.
