<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Cloud Agent

Use the local commands in the README. Install copies `.env.example` to `.env` when `.env` is missing and migrates SQLite to `data/pcmanager.db`. The example enrollment secret is accepted only when `NODE_ENV` is not `production`.

`apps/agent` requires Go 1.25 or newer. The base image ships an older toolchain, so setup installs Go 1.27 under `/usr/local/go` and links `/usr/local/bin/go` ahead of `/usr/bin/go`.
