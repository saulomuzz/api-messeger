#!/bin/sh
# Restaura um backup do api-messeger (SQLite).
# Uso: sh scripts/restore.sh <bundle.tar> [--sanitize]
#
# --sanitize: mascara telefones/nomes de contato e conteudo de mensagens
# apos restaurar. Use isso ao trazer um backup de producao para popular
# um ambiente de dev - nunca use ao restaurar em producao de verdade.
set -eu

PROJECT_DIR=${PROJECT_DIR:-/opt/api-messeger}
ENV_FILE=${ENV_FILE:-.env}
COMPOSE_FILE=${COMPOSE_FILE:-docker-compose.prod.yml}

BUNDLE="${1:?Uso: restore.sh <bundle.tar> [--sanitize]}"
SANITIZE=0
[ "${2:-}" = "--sanitize" ] && SANITIZE=1

cd "$PROJECT_DIR"
DC="docker compose --env-file $ENV_FILE -f $COMPOSE_FILE"
CONTAINER=$($DC ps -q app)

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

tar -xf "$BUNDLE" -C "$WORKDIR"
DB_DUMP=$(ls "$WORKDIR"/db-*.sqlite.gz 2>/dev/null || true)
if [ -z "$DB_DUMP" ]; then
  echo "Nenhum banco encontrado no bundle." >&2
  exit 1
fi

echo "==> Parando o app para trocar o banco com seguranca..."
$DC stop app

gunzip -k -c "$DB_DUMP" > "$WORKDIR/app.sqlite"
docker cp "$WORKDIR/app.sqlite" "$CONTAINER":/app/data/app.sqlite

if [ "$SANITIZE" = "1" ]; then
  echo "==> Sanitizando dados sensiveis (--sanitize)..."
  docker cp "$(dirname "$0")/sanitize.sql" "$CONTAINER":/tmp/sanitize.sql
  $DC start app
  sleep 2
  $DC exec -T app sh -c 'command -v sqlite3 >/dev/null 2>&1 && sqlite3 "$SQLITE_PATH" < /tmp/sanitize.sql || echo "sqlite3 CLI nao disponivel na imagem - rode o sanitize.sql manualmente"'
  $DC exec -T app rm -f /tmp/sanitize.sql
else
  $DC start app
fi

echo "==> Restore concluido."
