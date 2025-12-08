# Janela de 24h do WhatsApp Business API

## ⚠️ Por que a mensagem não chegou?

A **API Oficial do WhatsApp Business** tem uma regra importante:

### 📋 Regra da Janela de 24h

Você só pode enviar mensagens **livres** (não-template) para números que:

1. ✅ **Iniciaram uma conversa com você** nas últimas 24 horas
2. ✅ **Responderam a uma mensagem sua** nas últimas 24 horas

### 🔒 Fora da Janela de 24h

Se o número **não** iniciou conversa nas últimas 24h, você precisa usar **mensagens template** (aprovadas pelo Meta).

## ✅ Soluções

### Opção 1: Usuário inicia conversa primeiro

1. O usuário envia uma mensagem para seu número WhatsApp Business
2. Você recebe via webhook
3. Agora você tem 24h para enviar mensagens livres

### Opção 2: Usar Template Messages

Crie templates aprovados no Meta for Developers e use-os:

```javascript
// Exemplo de template (precisa ser aprovado no Meta)
{
  "messaging_product": "whatsapp",
  "to": "554299219594",
  "type": "template",
  "template": {
    "name": "hello_world",
    "language": {
      "code": "pt_BR"
    }
  }
}
```

### Opção 3: Verificar se o número está correto

O número foi normalizado para `5542999219594` (com 9 adicionado). Verifique se o número real tem o 9:

- Se o número real é: `554299219594` (sem 9) → pode estar errado
- Se o número real é: `5542999219594` (com 9) → está correto

## 🧪 Como Testar

### 1. Envie uma mensagem do WhatsApp para o número Business

1. Abra o WhatsApp no celular
2. Envie uma mensagem para o número configurado no Meta
3. Agora você tem 24h para enviar mensagens livres

### 2. Verifique o webhook

Quando o usuário enviar mensagem, você verá nos logs:

```
[WHATSAPP-API] Mensagem recebida de 554299219594: "mensagem do usuário"
```

### 3. Teste o envio novamente

Após o usuário iniciar a conversa, teste:

```bash
curl -X POST http://10.10.0.3:4000/send \
  -H "Content-Type: application/json" \
  -H "X-API-Token: 9f35a6e95a5f4b7f8c0c7c5a83a61c43eaa8b1e0f4b845c99b403ae9a02fbb2e" \
  -d '{
    "phone": "554299219594",
    "message": "Teste após iniciar conversa",
    "subject": "Teste"
  }'
```

## 📊 Status da Mensagem

A API retorna um `messageId` (wamid.xxx), mas isso não garante entrega. Para verificar o status:

1. Configure webhook para receber status updates
2. Ou use a API para consultar status da mensagem

## 💡 Dica

Para desenvolvimento/testes, você pode usar o **Modo de Teste** do Meta, que permite enviar para números de teste sem a janela de 24h.

