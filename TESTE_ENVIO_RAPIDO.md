# Como Testar o Envio de Mensagens

## ❌ Erro: "invalid token"

O endpoint `/send` está exigindo o header `X-API-Token` porque você tem `API_TOKEN` configurado no `.env`.

## ✅ Solução: Passe o Token no Header

### Opção 1: Usando curl com token

```bash
curl -X POST http://10.10.0.3:4000/send \
  -H "Content-Type: application/json" \
  -H "X-API-Token: 9f35a6e95a5f4b7f8c0c7c5a83a61c43eaa8b1e0f4b845c99b403ae9a02fbb2e" \
  -d '{
    "phone": "554299219594",
    "message": "Teste de mensagem via API Oficial!",
    "subject": "Teste"
  }'
```

### Opção 2: Usando o script de teste

```bash
chmod +x test-send.sh
./test-send.sh
```

### Opção 3: Desabilitar autenticação (apenas para testes)

Se quiser testar sem token, remova ou comente a linha `API_TOKEN` no `.env`:

```env
# API_TOKEN=9f35a6e95a5f4b7f8c0c7c5a83a61c43eaa8b1e0f4b845c99b403ae9a02fbb2e
```

**⚠️ ATENÇÃO:** Isso desabilita a autenticação para TODOS os endpoints que usam `auth`. Use apenas em desenvolvimento!

## 📋 Formato da Requisição

**URL:** `POST http://10.10.0.3:4000/send`

**Headers:**
```
Content-Type: application/json
X-API-Token: 9f35a6e95a5f4b7f8c0c7c5a83a61c43eaa8b1e0f4b845c99b403ae9a02fbb2e
```

**Body (JSON):**
```json
{
  "phone": "554299219594",
  "message": "Sua mensagem aqui",
  "subject": "Assunto (opcional)"
}
```

## ✅ Resposta Esperada

```json
{
  "ok": true,
  "requestId": "...",
  "to": "554299219594",
  "msgId": "wamid.xxx...",
  "normalized": "+554299219594",
  "tried": ["+554299219594"]
}
```

## 🧪 Teste Completo

```bash
# 1. Verificar status
curl http://10.10.0.3:4000/status

# 2. Enviar mensagem
curl -X POST http://10.10.0.3:4000/send \
  -H "Content-Type: application/json" \
  -H "X-API-Token: 9f35a6e95a5f4b7f8c0c7c5a83a61c43eaa8b1e0f4b845c99b403ae9a02fbb2e" \
  -d '{"phone":"554299219594","message":"Teste","subject":"Teste"}'
```

