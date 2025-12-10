# Como Aplicar o .env Otimizado

## 📋 Passo a Passo

### 1. Faça backup do .env atual

```bash
cp .env .env.backup
```

### 2. Copie o conteúdo do arquivo `env-otimizado.txt`

O arquivo `env-otimizado.txt` contém a versão otimizada com todas as correções:

- ✅ `REQUIRE_SIGNED_REQUESTS=false` (sem duplicatas)
- ✅ `ESP32_ALLOWED_IPS=10.10.0.4,10.10.0.0/23` (sem duplicatas)
- ✅ `WHATSAPP_WEBHOOK_DOMAIN` configurado
- ✅ `WHATSAPP_API_VERSION` adicionado
- ✅ Organizado por seções
- ✅ Sem espaços em branco desnecessários

### 3. Substitua o conteúdo do .env

**Opção A - Via terminal:**
```bash
cp env-otimizado.txt .env
```

**Opção B - Manualmente:**
1. Abra o arquivo `env-otimizado.txt`
2. Copie todo o conteúdo (Ctrl+A, Ctrl+C)
3. Abra o arquivo `.env`
4. Substitua todo o conteúdo (Ctrl+A, Ctrl+V)
5. Salve

### 4. Verifique se está correto

```bash
# Verifica se não há duplicatas
grep "REQUIRE_SIGNED_REQUESTS" .env
# Deve aparecer apenas UMA linha

grep "ESP32_ALLOWED_IPS" .env
# Deve aparecer apenas UMA linha
```

### 5. Reinicie o serviço

```bash
# Pare o serviço atual (Ctrl+C)
# Depois inicie novamente:
node src/app.js
```

## ✅ Verificações

Após reiniciar, você deve ver nos logs:

```
[CONFIG] USE_WHATSAPP_OFFICIAL_API: true
[INFO] API Oficial do WhatsApp Business ativa
[INFO] Configure o webhook no Meta: https://seu-dominio.com/webhook/whatsapp
[INFO] Token de verificação: seu_token_de_verificacao_aqui
```

## 🧪 Teste o Envio

```bash
curl -X POST http://localhost:3000/send \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "5511999999999",
    "message": "Teste de mensagem via API Oficial!",
    "subject": "Teste"
  }'
```

Deve retornar `{"ok":true,...}` sem erro de "invalid signature"!

