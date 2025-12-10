#!/bin/bash
# Script para testar envio de mensagem

API_TOKEN="seu_token_api_aqui"
API_URL="http://localhost:3000"

echo "Testando envio de mensagem..."
echo ""

curl -X POST "${API_URL}/send" \
  -H "Content-Type: application/json" \
  -H "X-API-Token: ${API_TOKEN}" \
  -d '{
    "phone": "+5511999999999",
    "message": "Teste de mensagem via API Oficial!",
    "subject": "Teste"
  }' | jq .

echo ""
echo "✅ Teste concluído!"

