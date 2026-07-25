#!/bin/sh
set -eu

PROJECT_DIR=${PROJECT_DIR:-/opt/api-messeger}
ENV_FILE=${ENV_FILE:-.env}
COMPOSE_FILE=${COMPOSE_FILE:-docker-compose.prod.yml}

cd "$PROJECT_DIR"

if [ ! -f "$ENV_FILE" ]; then
  echo "Arquivo $ENV_FILE nao encontrado. Crie a partir de .env.production.example." >&2
  exit 1
fi

git pull --ff-only origin main

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --build

echo "Aguardando o servico responder..."
for i in $(seq 1 15); do
  if curl -sf http://localhost:3000/v1/health >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

curl -f http://localhost:3000/v1/health
echo
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps
