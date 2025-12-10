# Como Testar o Envio de Mensagens

## ❌ Erro: "invalid token"

O endpoint `/send` está exigindo o header `X-API-Token` porque você tem `API_TOKEN` configurado no `.env`.

## ✅ Solução: Passe o Token no Header

### Opção 1: Usando curl com token

```bash
curl -X POST http://localhost:3000/send \
  -H "Content-Type: application/json" \
  -H "X-API-Token: seu_token_aqui" \
  -d '{
    "phone": "5511999999999",
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
# API_TOKEN=seu_token_aqui
```

**⚠️ ATENÇÃO:** Isso desabilita a autenticação para TODOS os endpoints que usam `auth`. Use apenas em desenvolvimento!

## 📋 Formato da Requisição

**URL:** `POST http://localhost:3000/send`

**Headers:**
```
Content-Type: application/json
X-API-Token: seu_token_aqui
```

**Body (JSON):**
```json
{
  "phone": "5511999999999",
  "message": "Sua mensagem aqui",
  "subject": "Assunto (opcional)"
}
```

## ✅ Resposta Esperada

```json
{
  "ok": true,
  "requestId": "...",
  "to": "5511999999999",
  "msgId": "wamid.xxx...",
  "normalized": "+5511999999999",
  "tried": ["+5511999999999"]
}
```

## 🧪 Teste Completo

```bash
# 1. Verificar status
curl http://localhost:3000/status

# 2. Enviar mensagem
curl -X POST http://localhost:3000/send \
  -H "Content-Type: application/json" \
  -H "X-API-Token: seu_token_aqui" \
  -d '{"phone":"5511999999999","message":"Teste","subject":"Teste"}'
```

