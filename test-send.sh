#!/bin/bash
# Script para testar envio de mensagem
# Configure as variáveis abaixo com seus valores

API_TOKEN="${API_TOKEN:-seu_token_aqui}"
API_URL="${API_URL:-http://localhost:4000}"
PHONE="${PHONE:-5511999999999}"

echo "Testando envio de mensagem..."
echo ""

curl -X POST "${API_URL}/send" \
  -H "Content-Type: application/json" \
  -H "X-API-Token: ${API_TOKEN}" \
  -d "{
    \"phone\": \"${PHONE}\",
    \"message\": \"Teste de mensagem via API Oficial!\",
    \"subject\": \"Teste\"
  }" | jq .

echo ""
echo "✅ Teste concluído!"

