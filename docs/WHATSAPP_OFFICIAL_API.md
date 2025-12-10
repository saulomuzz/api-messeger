# Configuração da API Oficial do WhatsApp Business

## O que mudou?

Agora você pode usar a **API Oficial do WhatsApp Business** (Meta) em vez do `whatsapp-web.js`. A API oficial oferece:

✅ **Suporte nativo a mensagens interativas** (botões, listas)  
✅ **Mais confiável** (não depende de QR code)  
✅ **Melhor para produção**  
✅ **Suporte completo a webhooks**

## Configuração

### 1. Variáveis de Ambiente

Adicione ao seu `.env`:

```env
# Ativar API Oficial (true/false)
USE_WHATSAPP_OFFICIAL_API=true

# Credenciais da API Oficial (obrigatórias se USE_WHATSAPP_OFFICIAL_API=true)
WHATSAPP_ACCESS_TOKEN=seu_access_token_aqui
WHATSAPP_PHONE_NUMBER_ID=seu_phone_number_id_aqui
WHATSAPP_BUSINESS_ACCOUNT_ID=seu_business_account_id (opcional)
WHATSAPP_WEBHOOK_VERIFY_TOKEN=meu_token_secreto
WHATSAPP_API_VERSION=v21.0
```

### 2. Como obter as credenciais

1. Acesse [Meta for Developers](https://developers.facebook.com/)
2. Crie um app do tipo "Business"
3. Adicione o produto "WhatsApp"
4. Obtenha:
   - **Access Token**: Token temporário ou permanente
   - **Phone Number ID**: ID do número de telefone verificado
   - **Business Account ID**: ID da conta de negócios (opcional)

### 3. Configurar Webhook

No Meta for Developers, configure o webhook:

- **URL do Webhook**: `https://seu-dominio.com/webhook/whatsapp`
- **Token de Verificação**: O mesmo valor de `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
- **Campos de Assinatura**: `messages`, `messaging_postbacks`

## Como funciona?

### Modo Híbrido

O sistema detecta automaticamente qual API usar:

- Se `USE_WHATSAPP_OFFICIAL_API=true` **E** credenciais configuradas → Usa API Oficial
- Caso contrário → Usa `whatsapp-web.js` (fallback)

### Endpoints

#### API Oficial:
- `GET /webhook/whatsapp` - Verificação do webhook
- `POST /webhook/whatsapp` - Recebimento de mensagens

#### Ambos os modos:
- `POST /send` - Enviar mensagem
- `GET /status` - Status da conexão
- Todos os outros endpoints continuam funcionando

## Migração

Para migrar de `whatsapp-web.js` para API Oficial:

1. Configure as variáveis de ambiente
2. Configure o webhook no Meta
3. Reinicie a aplicação
4. Teste enviando uma mensagem

**Nota**: A API oficial não precisa de QR code - está sempre "pronta"!

## Suporte

- [Documentação Oficial Meta](https://developers.facebook.com/docs/whatsapp)
- [Guia de Webhooks](https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks)

