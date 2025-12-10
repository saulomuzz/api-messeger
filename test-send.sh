#!/bin/bash
# Script para testar envio de mensagem

API_TOKEN="9f35a6e95a5f4b7f8c0c7c5a83a61c43eaa8b1e0f4b845c99b403ae9a02fbb2e"
API_URL="http://10.10.0.3:4000"

echo "Testando envio de mensagem..."
echo ""

curl -X POST "${API_URL}/send" \
  -H "Content-Type: application/json" \
  -H "X-API-Token: ${API_TOKEN}" \
  -d '{
    "phone": "554299219594",
    "message": "Teste de mensagem via API Oficial!",
    "subject": "Teste"
  }' | jq .

echo ""
echo "✅ Teste concluído!"

