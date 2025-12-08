# Troubleshooting - Webhook WhatsApp Business API

## 🔍 Problema: Mensagens não estão sendo recebidas

Se o servidor está rodando mas você não recebe mensagens quando envia "oi", siga estes passos:

### 1. Verificar se o Webhook está configurado no Meta

1. Acesse [Meta for Developers](https://developers.facebook.com/)
2. Vá para seu App → WhatsApp → Configuração
3. Verifique se o webhook está configurado:
   - **URL do Webhook:** `https://api.biancavolken.com.br/webhook/whatsapp`
   - **Token de Verificação:** Deve ser exatamente igual ao `WHATSAPP_WEBHOOK_VERIFY_TOKEN` no seu `.env`
   - **Campos de Assinatura:** Deve estar marcado

### 2. Verificar se o Webhook está ativo

No Meta for Developers, verifique se o webhook mostra status "Ativo" (verde).

### 3. Verificar logs do servidor

Quando você envia uma mensagem, você deve ver nos logs:

```
[WEBHOOK] POST recebido - Objeto: whatsapp_business_account
[WEBHOOK] ✅ Objeto WhatsApp Business Account confirmado
[WEBHOOK] Processando 1 entrada(s)
[WEBHOOK] Processando entrada...
[WEBHOOK] Processando entrada do webhook: {...}
```

**Se você NÃO vê esses logs:**
- O webhook não está recebendo requisições do Meta
- Verifique se o Nginx está roteando corretamente
- Verifique se o firewall está bloqueando

### 4. Testar o webhook manualmente

```bash
# Teste de verificação (GET)
curl "https://api.biancavolken.com.br/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=SEU_TOKEN&hub.challenge=test123"

# Deve retornar: test123
```

### 5. Verificar se o número está autorizado

O número que envia a mensagem deve estar no arquivo `numbers.txt`:

```bash
cat numbers.txt
```

O número deve estar no formato:
```
554299219594
```

### 6. Verificar configuração do Nginx

O Nginx deve estar configurado para rotear `/webhook/whatsapp` para `http://localhost:4000`:

```nginx
location /webhook/whatsapp {
    proxy_pass http://localhost:4000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_cache_bypass $http_upgrade;
    proxy_buffering off;
}
```

### 7. Verificar se o número está na janela de 24h

A API oficial do WhatsApp Business só permite enviar mensagens livres para números que:
- Iniciaram uma conversa nas últimas 24h
- Responderam a uma mensagem nas últimas 24h

**Solução:** Envie uma mensagem do WhatsApp para o número Business primeiro, depois teste novamente.

### 8. Verificar logs detalhados

Com `DEBUG=true` no `.env`, você verá logs muito mais detalhados:

```bash
# No servidor, monitore os logs em tempo real
tail -f /var/log/whatsapp-api-dev.log
```

Ou se estiver rodando diretamente:
```bash
node src/app.js
```

### 9. Testar envio de mensagem via API

Teste se o envio está funcionando:

```bash
curl -X POST http://localhost:4000/send \
  -H "Content-Type: application/json" \
  -H "X-API-Token: SEU_TOKEN" \
  -d '{
    "phone": "554299219594",
    "message": "Teste",
    "subject": "Teste"
  }'
```

Se isso funcionar, o problema é apenas no recebimento via webhook.

### 10. Verificar eventos no Meta

No Meta for Developers → WhatsApp → Webhooks, você pode ver os eventos recebidos:
- Clique em "Testar" para enviar um evento de teste
- Verifique se aparece algum erro

## ✅ Checklist

- [ ] Webhook configurado no Meta for Developers
- [ ] URL do webhook está correta e acessível
- [ ] Token de verificação está correto (case-sensitive)
- [ ] Nginx está roteando corretamente
- [ ] Servidor está rodando e ouvindo na porta 4000
- [ ] Número está no `numbers.txt`
- [ ] Número está na janela de 24h (enviou mensagem primeiro)
- [ ] Logs mostram requisições POST chegando
- [ ] Firewall não está bloqueando

## 🆘 Se ainda não funcionar

1. Verifique os logs completos do servidor
2. Verifique os logs do Nginx: `tail -f /var/log/nginx/error.log`
3. Teste o webhook diretamente (sem Nginx): `http://IP_DO_SERVIDOR:4000/webhook/whatsapp`
4. Verifique se o Meta está enviando requisições (use `tcpdump` ou `wireshark`)

