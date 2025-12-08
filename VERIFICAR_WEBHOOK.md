# Como Verificar se o Webhook Está Recebendo Mensagens

## 🔍 Problema: Mensagens "oi" não geram resposta

Se você enviou "oi" várias vezes mas não recebeu o menu, o webhook não está recebendo as mensagens do Meta.

## ✅ Passo 1: Verificar se o Webhook está configurado no Meta

1. **Acesse o Meta for Developers:**
   - https://developers.facebook.com/
   - Vá para seu App → WhatsApp → Configuração

2. **Verifique a configuração do Webhook:**
   - **URL do Webhook:** `https://api.biancavolken.com.br/webhook/whatsapp`
   - **Token de Verificação:** Deve ser exatamente igual ao `WHATSAPP_WEBHOOK_VERIFY_TOKEN` do seu `.env`
   - **Campos de Assinatura:** Deve estar marcado

3. **Verifique se está "Ativo":**
   - O webhook deve mostrar status "Ativo" (verde)
   - Se estiver "Inativo", clique em "Verificar e Salvar"

## ✅ Passo 2: Testar o Webhook Manualmente

### Teste 1: Verificação (GET)

```bash
curl "https://seu-dominio.com.br/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=SEU_TOKEN_AQUI&hub.challenge=test123"
```

**Deve retornar:** `test123`

### Teste 2: Simular Mensagem (POST)

```bash
curl -X POST https://api.biancavolken.com.br/webhook/whatsapp \
  -H "Content-Type: application/json" \
  -d '{
    "object": "whatsapp_business_account",
    "entry": [{
      "changes": [{
        "value": {
          "messages": [{
            "from": "554299219594",
            "id": "test123",
            "type": "text",
            "text": {
              "body": "oi"
            }
          }]
        }
      }]
    }]
  }'
```

**Deve retornar:** `200 OK`

E você deve ver nos logs do servidor:
```
[WEBHOOK] POST recebido - Objeto: whatsapp_business_account
[WEBHOOK] ✅ Objeto WhatsApp Business Account confirmado
[WEBHOOK] Processando 1 entrada(s)
[WHATSAPP-API] Mensagem recebida de 554299219594: "oi"
```

## ✅ Passo 3: Verificar Logs do Servidor

Quando você envia "oi" do WhatsApp, você DEVE ver nos logs:

```
[WEBHOOK] POST recebido - Objeto: whatsapp_business_account
[WEBHOOK] ✅ Objeto WhatsApp Business Account confirmado
[WEBHOOK] Processando 1 entrada(s)
[WEBHOOK] Processando entrada...
[WEBHOOK] Processando entrada do webhook: {...}
[WHATSAPP-API] Mensagem recebida de 554299219594: "oi"
[CMD] Saudação recebida de 554299219594, enviando menu principal
```

**Se você NÃO vê esses logs:**
- O webhook não está recebendo requisições do Meta
- Verifique a configuração do webhook no Meta
- Verifique se o Nginx está roteando corretamente

## ✅ Passo 4: Verificar Nginx

Verifique se o Nginx está configurado corretamente:

```bash
# Verifique a configuração do Nginx
cat /etc/nginx/sites-available/api.biancavolken.com.br

# Ou onde estiver sua configuração
```

Deve ter algo como:

```nginx
location /webhook/whatsapp {
    proxy_pass http://localhost:4000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
}
```

## ✅ Passo 5: Verificar Logs do Nginx

```bash
# Ver logs de acesso
tail -f /var/log/nginx/access.log | grep webhook

# Ver logs de erro
tail -f /var/log/nginx/error.log
```

Quando você enviar "oi", deve aparecer uma linha no access.log com:
```
POST /webhook/whatsapp HTTP/1.1 200
```

## ✅ Passo 6: Testar Diretamente (Sem Nginx)

Para testar se o problema é no Nginx, teste diretamente no servidor:

```bash
# No servidor, teste localmente
curl -X POST http://localhost:4000/webhook/whatsapp \
  -H "Content-Type: application/json" \
  -d '{
    "object": "whatsapp_business_account",
    "entry": [{
      "changes": [{
        "value": {
          "messages": [{
            "from": "554299219594",
            "id": "test123",
            "type": "text",
            "text": {
              "body": "oi"
            }
          }]
        }
      }]
    }]
  }'
```

Se funcionar localmente mas não via Nginx, o problema está na configuração do Nginx.

## ✅ Passo 7: Verificar Firewall

Verifique se o firewall não está bloqueando:

```bash
# Ver regras do firewall
ufw status
# ou
iptables -L -n | grep 4000
```

## 🆘 Se ainda não funcionar

1. **Verifique no Meta for Developers:**
   - Vá para: WhatsApp → Webhooks
   - Clique em "Testar" para enviar um evento de teste
   - Verifique se aparece algum erro

2. **Verifique se o número está autorizado:**
   ```bash
   cat numbers.txt
   ```
   Deve conter: `554299219594`

3. **Monitore os logs em tempo real:**
   ```bash
   # No servidor
   tail -f /var/log/whatsapp-api-dev.log
   # Ou se estiver rodando diretamente
   node src/app.js
   ```

4. **Teste com tcpdump (se disponível):**
   ```bash
   sudo tcpdump -i any -A -s 0 'tcp port 4000 and (((ip[2:2] - ((ip[0]&0xf)<<2)) - ((tcp[12]&0xf0)>>2)) != 0)'
   ```

## 📝 Checklist Final

- [ ] Webhook configurado no Meta for Developers
- [ ] URL do webhook está correta e acessível
- [ ] Token de verificação está correto
- [ ] Webhook mostra status "Ativo" no Meta
- [ ] Nginx está roteando corretamente
- [ ] Servidor está rodando e ouvindo na porta 4000
- [ ] Número está no `numbers.txt`
- [ ] Logs mostram requisições POST chegando
- [ ] Firewall não está bloqueando

