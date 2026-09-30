# Testing

From the repo root:

```bash
pnpm --filter api test
pnpm --filter api typecheck
pnpm --filter web typecheck
pnpm --filter @workspace/shared test
cd apps/agent && go test ./...
cd apps/helper && go test ./...
```

`pnpm test` and `pnpm build` are the workspace turbo tasks. CI (`.github/workflows/ci.yml`) runs those plus `go test` and `go build` for the agent and the helper on `ubuntu-latest` with Go 1.25.

API tests are `node:test` via `tsx`. Scan and posture checks live in `apps/api/src/scan.test.ts` and `platform.test.ts`. They do not open a socket to the public internet.

Agent scan tests read:

- `apps/agent/testdata/nmap-localhost.xml`
- `apps/agent/testdata/nmap-vulners.xml`
- `apps/agent/testdata/nuclei.jsonl`

A live Nmap, Nuclei, or Trivy run is not part of CI. Those binaries are optional on a developer machine. Do not point a test at an address outside `127.0.0.1` unless `lab_mode` is off and that network is in `authorized_networks` on a machine you are allowed to scan.

Dashboard checks are the Next.js pages under `apps/web/app/(app)/`. The dev server proxies `/api` to port 4000.
