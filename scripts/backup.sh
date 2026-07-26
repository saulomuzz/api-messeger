#!/bin/sh
# Backup do api-messeger: banco SQLite (snapshot consistente via .backup).
# Uso: sh scripts/backup.sh
set -eu

PROJECT_DIR=${PROJECT_DIR:-/opt/api-messeger}
ENV_FILE=${ENV_FILE:-.env}
COMPOSE_FILE=${COMPOSE_FILE:-docker-compose.prod.yml}
OUT_DIR=${OUT_DIR:-$PROJECT_DIR/backups}
TS=$(date +%Y%m%d-%H%M%S)

cd "$PROJECT_DIR"
mkdir -p "$OUT_DIR"
DC="docker compose --env-file $ENV_FILE -f $COMPOSE_FILE"
CONTAINER=$($DC ps -q app)

echo "==> Snapshot consistente do SQLite (.backup, sem lock)..."
$DC exec -T app sh -c 'command -v sqlite3 >/dev/null 2>&1 && sqlite3 "$SQLITE_PATH" ".backup /tmp/backup.sqlite" || cp "$SQLITE_PATH" /tmp/backup.sqlite'
docker cp "$CONTAINER":/tmp/backup.sqlite "$OUT_DIR/db-$TS.sqlite"
$DC exec -T app rm -f /tmp/backup.sqlite
gzip "$OUT_DIR/db-$TS.sqlite"

BUNDLE="$OUT_DIR/api-messeger-$TS.tar"
tar -cf "$BUNDLE" -C "$OUT_DIR" "db-$TS.sqlite.gz"
rm -f "$OUT_DIR/db-$TS.sqlite.gz"

echo "==> Backup pronto: $BUNDLE"
ls -lh "$BUNDLE"
