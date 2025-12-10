#!/bin/bash
# Script para testar chamadas do ESP32

API_URL="http://localhost:3000"
ESP32_TOKEN="seu_token_esp32_aqui"  # Substitua pelo token configurado no .env

echo "=========================================="
echo "Teste 1: Validação de autorização ESP32"
echo "=========================================="
echo ""

curl -X GET "${API_URL}/esp32/validate" \
  -H "X-ESP32-Token: ${ESP32_TOKEN}" \
  -w "\n\nStatus HTTP: %{http_code}\n" | jq .

echo ""
echo "=========================================="
echo "Teste 2: Trigger Snapshot (chamada principal do ESP32)"
echo "=========================================="
echo ""

curl -X POST "${API_URL}/trigger-snapshot" \
  -H "Content-Type: application/json" \
  -H "X-ESP32-Token: ${ESP32_TOKEN}" \
  -d '{
    "message": "Alerta de movimento detectado!"
  }' \
  -w "\n\nStatus HTTP: %{http_code}\n" | jq .

echo ""
echo "✅ Testes concluídos!"

