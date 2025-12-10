#!/bin/bash
# Script para testar o webhook

TOKEN="seu_token_secreto"  # Substitua pelo token do seu .env
DOMAIN="https://seu-dominio.com.br"

echo "Testando webhook via HTTPS..."
echo ""

# Teste 1: Verificação do webhook (GET)
echo "1. Teste de verificação (GET):"
curl -v "${DOMAIN}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=${TOKEN}&hub.challenge=test123"
echo ""
echo ""

# Teste 2: Teste direto no IP (deve funcionar)
echo "2. Teste direto no IP (deve funcionar):"
curl -v "http://localhost:3000/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=${TOKEN}&hub.challenge=test123"
echo ""
echo ""

# Teste 3: Verificar se o nginx está roteando
echo "3. Verificando logs do nginx..."
echo "Execute: sudo tail -f /var/log/nginx/seu-dominio_error.log"
echo ""

