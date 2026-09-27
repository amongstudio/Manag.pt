#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for Mnag.pt.
# Safe to run repeatedly: skips the Go tarball when 1.25+ is already installed,
# refreshes the lockfile install, and reapplies SQLite migrations.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

GO_VERSION="1.27.1"
GO_TARBALL="go${GO_VERSION}.linux-amd64.tar.gz"
GO_SHA256="63d339f0da5ab53635a56f2490a7984dfe12dfcff22ad749f63edaf590168445"
MIN_GO="go1.25.0"

go_is_new_enough() {
  local bin="$1"
  local current oldest
  [ -x "$bin" ] || return 1
  current="$("$bin" env GOVERSION 2>/dev/null || echo go0)"
  oldest="$(printf '%s\n' "$MIN_GO" "$current" | sort -V | head -n1)"
  [ "$oldest" = "$MIN_GO" ]
}

if ! go_is_new_enough /usr/local/go/bin/go; then
  tmp="$(mktemp)"
  curl -fsSL "https://go.dev/dl/${GO_TARBALL}" -o "$tmp"
  echo "${GO_SHA256}  ${tmp}" | sha256sum -c -
  sudo rm -rf /usr/local/go
  sudo tar -C /usr/local -xzf "$tmp"
  rm -f "$tmp"
fi

sudo ln -sfn /usr/local/go/bin/go /usr/local/bin/go
sudo ln -sfn /usr/local/go/bin/gofmt /usr/local/bin/gofmt
export PATH="/usr/local/go/bin:${PATH}"
hash -r

if [ ! -f .env ]; then
  cp .env.example .env
fi

mkdir -p data
export DATABASE_URL="file:${ROOT}/data/pcmanager.db"

corepack enable
corepack prepare pnpm@10.33.4 --activate
pnpm install --frozen-lockfile
pnpm --filter @workspace/db exec prisma migrate deploy

(cd apps/agent && go mod download)
(cd apps/helper && go mod download)
