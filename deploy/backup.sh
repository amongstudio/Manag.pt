#!/bin/sh
# Manual WAL-safe SQLite backup. Nightly backups are already handled by the API
# job in apps/api/src/jobs.ts; this script is for operators / cron on the host.
set -eu
DB="${PCM_DB:-/data/pcmanager.db}"
DESTDIR="${PCM_BACKUP_DIR:-/data/backups}"
DATE=$(date -u +%Y%m%d-%H%M%S)
DEST="$DESTDIR/pcmanager-$DATE.db"
mkdir -p "$DESTDIR"
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB" ".backup '$DEST'"
else
  echo "sqlite3 not found; refusing a raw copy of a WAL database" >&2
  exit 1
fi
if [ ! -s "$DEST" ]; then
  echo "backup failed: empty $DEST" >&2
  exit 1
fi
find "$DESTDIR" -type f -mtime +14 -delete
echo "backup written $DEST"
