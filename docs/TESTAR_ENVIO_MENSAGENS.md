# Como Testar o Envio de Mensagens - API Oficial WhatsApp

## 1. Configuração no .env

Adicione estas variáveis ao seu `.env`:

```env
# API Oficial do WhatsApp
USE_WHATSAPP_OFFICIAL_API=true
WHATSAPP_ACCESS_TOKEN=seu_access_token_aqui
WHATSAPP_PHONE_NUMBER_ID=seu_phone_number_id_aqui
WHATSAPP_WEBHOOK_VERIFY_TOKEN=seu_token_secreto
WHATSAPP_WEBHOOK_DOMAIN=seu-dominio.com.br
```

## 2. Testar Envio de Mensagem via API REST

### Método 1: Usando curl

```bash
curl -X POST https://seu-dominio.com.br/send \
  -H "Content-Type: application/json" \
  -H "X-API-Token: seu_api_token" \
  -d '{
    "phone": "+5511999999999",
    "message": "Teste de mensagem via API Oficial!",
    "subject": "Teste"
  }'
```

### Método 2: Usando Postman ou Insomnia

**URL:** `POST https://seu-dominio.com.br/send`

**Headers:**
```
Content-Type: application/json
X-API-Token: seu_api_token (se configurado)
```

**Body (JSON):**
```json
{
  "phone": "+5511999999999",
  "message": "Olá! Esta é uma mensagem de teste via API Oficial do WhatsApp Business.",
  "subject": "Teste"
}
```

### Método 3: Teste direto no código Node.js

Crie um arquivo `test-send.js`:

```javascript
const axios = require('axios');

async function testSend() {
  try {
    const response = await axios.post('http://localhost:4000/send', {
      phone: '+5511999999999',
      message: 'Teste de mensagem via API Oficial!',
      subject: 'Teste'
    }, {
      headers: {
        'Content-Type': 'application/json',
        'X-API-Token': 'seu_api_token' // Se configurado
      }
    });
    
    console.log('✅ Sucesso:', response.data);
  } catch (error) {
    console.error('❌ Erro:', error.response?.data || error.message);
  }
}

testSend();
```

Execute:
```bash
node test-send.js
```

## 2.1 Testar envio de imagem ou video

O endpoint alinhado com a Cloud API da Meta e recomendado para outras ferramentas e:

`POST /v1/messages/media`

Campos aceitos:

- `to`: numero em formato internacional
- `media_type`: `image`, `video`, `document`, `audio` ou `sticker`
- `link` ou `media_id`: informe somente um dos dois
- `caption`: opcional para `image`, `video` e `document`
- `filename`: opcional para `document`

### Exemplo com imagem por URL

```bash
curl -X POST https://seu-dominio.com.br/v1/messages/media \
  -H "Authorization: Bearer seu_token_do_cliente" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "5511999999999",
    "media_type": "image",
    "link": "https://exemplo.com/foto.jpg",
    "caption": "Imagem enviada por integracao externa"
  }'
```

### Exemplo com video por `media_id`

```bash
curl -X POST https://seu-dominio.com.br/v1/messages/media \
  -H "Authorization: Bearer seu_token_do_cliente" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "5511999999999",
    "media_type": "video",
    "media_id": "123456789012345",
    "caption": "Video ja hospedado na Meta"
  }'
```

### Exemplo legado com `X-API-Token`

```bash
curl -X POST https://seu-dominio.com.br/send/media \
  -H "Content-Type: application/json" \
  -H "X-API-Token: seu_api_token" \
  -d '{
    "phone": "5511999999999",
    "media_type": "image",
    "link": "https://exemplo.com/foto.jpg",
    "caption": "Imagem via endpoint legado"
  }'
```

## 3. Testar Mensagens Interativas

### Enviar Menu com Botões

```bash
curl -X POST http://localhost:4000/send \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "+5511999999999",
    "message": "🏠 *Menu Principal*\n\nSelecione uma opção:",
    "buttons": [
      {"title": "📋 Dispositivos", "id": "btn_devices"},
      {"title": "⚡ Status", "id": "btn_status"},
      {"title": "🎥 Gravar", "id": "btn_record"},
      {"title": "❓ Ajuda", "id": "btn_help"}
    ]
  }'
```

**Nota:** A API oficial suporta botões nativamente! Mas o endpoint `/send` atual pode precisar de ajustes.

## 4. Verificar Status da API

```bash
curl https://seu-dominio.com.br/status
```

Deve retornar:
```json
{
  "ok": true,
  "ready": true,
  "state": "CONNECTED"
}
```

## 5. Testar Webhook (Recebimento de Mensagens)

### Enviar mensagem para o número configurado

1. Envie uma mensagem do WhatsApp para o número configurado no Meta
2. Verifique os logs:
   ```bash
   tail -f /var/log/whatsapp-api.log
   ```
3. Você deve ver logs como:
   ```
   [WHATSAPP-API] Mensagem recebida de +5511999999999: "sua mensagem"
   ```

## 6. Troubleshooting

### Erro: "whatsapp not ready"
- Verifique se `USE_WHATSAPP_OFFICIAL_API=true`
- Verifique se `WHATSAPP_ACCESS_TOKEN` e `WHATSAPP_PHONE_NUMBER_ID` estão configurados

### Erro: "not_on_whatsapp"
- O número precisa estar no WhatsApp
- Verifique o formato: deve ser E.164 (ex: +5511999999999)

### Erro: "invalid token"
- Verifique se o `X-API-Token` está correto (se configurado)
- Ou remova o header se não usar autenticação

### Mensagem não chega
- Verifique os logs do servidor
- Verifique se o número está autorizado no `numbers.txt`
- Verifique se o Access Token está válido no Meta

## 7. Exemplo Completo de Teste

```bash
#!/bin/bash

# Configurações
API_URL="https://seu-dominio.com.br"
PHONE="+5511999999999"
API_TOKEN="seu_token" # Opcional

echo "1. Verificando status..."
curl -s "${API_URL}/status" | jq .

echo -e "\n2. Enviando mensagem de teste..."
curl -X POST "${API_URL}/send" \
  -H "Content-Type: application/json" \
  -H "X-API-Token: ${API_TOKEN}" \
  -d "{
    \"phone\": \"${PHONE}\",
    \"message\": \"✅ Teste de mensagem via API Oficial do WhatsApp Business!\n\nEsta mensagem foi enviada com sucesso.\",
    \"subject\": \"Teste API Oficial\"
  }" | jq .

echo -e "\n✅ Teste concluído!"
```

## 8. Próximos Passos

Após confirmar que o envio funciona:

1. ✅ Teste recebimento de mensagens (webhook)
2. ✅ Teste mensagens interativas (botões/listas)
3. ✅ Integre com seus comandos Tuya existentes
4. ✅ Configure notificações automáticas

