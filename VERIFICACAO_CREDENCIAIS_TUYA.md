# Guia de Verificação de Credenciais Tuya

## Problema: Erro "sign invalid" (Código 1004)

Este erro indica que a assinatura foi rejeitada pela API Tuya. As causas mais comuns são:

1. **Credenciais incorretas** (mais provável)
2. **Região incorreta**
3. **Projeto inativo ou sem permissões**

## Passo a Passo para Verificar

### 1. Acesse a Plataforma Tuya

1. Acesse: https://iot.tuya.com/
2. Faça login com sua conta
3. Vá em **Cloud Development** > Seu Projeto

### 2. Verifique as Credenciais

Na página **Overview** do seu projeto, verifique:

#### Access ID / Client ID
- **No .env:** `TUYA_CLIENT_ID=seu_client_id_aqui`
- **Na plataforma:** Compare com "Access ID" ou "Client ID"
- **Devem ser EXATAMENTE iguais** (sem espaços, sem diferenças de maiúsculas/minúsculas)

#### Access Secret / Client Secret
- **No .env:** `TUYA_CLIENT_SECRET=seu_client_secret_aqui`
- **Na plataforma:** Clique no ícone do olho 👁️ para revelar o "Access Secret"
- **Deve ter 32 caracteres hexadecimais**
- **Devem ser EXATAMENTE iguais** (sem espaços, sem diferenças)

### 3. Verifique a Região (Data Center)

Na mesma página **Overview**, procure por **"Data Center"** ou **"Region"**:

| Data Center na Plataforma | Valor no .env |
|---------------------------|---------------|
| Western America Data Center | `TUYA_REGION=us` |
| Eastern America Data Center | `TUYA_REGION=us` |
| Central Europe Data Center | `TUYA_REGION=eu` |
| Western Europe Data Center | `TUYA_REGION=eu` |
| China Data Center | `TUYA_REGION=cn` |
| India Data Center | `TUYA_REGION=in` |

**No seu caso:** Se o Data Center for "Western America" ou "Eastern America", use `TUYA_REGION=us` ✅

### 4. Verifique o Status do Projeto

- O projeto deve estar **ativo**
- Verifique se há **restrições de IP** ativadas (pode bloquear requisições)
- Verifique se as **permissões necessárias** estão habilitadas

### 5. Teste com o Script

No servidor, execute:

```bash
cd /opt/whatsapp-api-dev
node test-tuya-sign.js
```

Isso vai:
- Mostrar as credenciais que estão sendo usadas
- Gerar uma assinatura
- Fazer uma requisição de teste
- Mostrar o resultado

### 6. Se Ainda Falhar

1. **Copie novamente as credenciais** da plataforma Tuya (use o botão de copiar)
2. **Cole diretamente no .env** (sem espaços extras)
3. **Reinicie a aplicação**
4. **Teste novamente**

## Checklist Rápido

- [ ] Access ID no .env = Access ID na plataforma Tuya
- [ ] Access Secret no .env = Access Secret na plataforma Tuya (32 chars)
- [ ] Data Center na plataforma corresponde a `TUYA_REGION` no .env
- [ ] Projeto está ativo na plataforma Tuya
- [ ] Não há restrições de IP bloqueando
- [ ] Credenciais não têm espaços extras ou caracteres invisíveis

## Comandos Úteis

```bash
# Verificar credenciais no .env
cat .env | grep TUYA

# Testar assinatura
node test-tuya-sign.js

# Verificar logs da aplicação
pm2 logs whatsapp-api-dev
# ou
tail -f /var/log/whatsapp-api-dev.log
```

## Exemplo de .env Correto

```bash
TUYA_CLIENT_ID=seu_client_id_aqui
TUYA_CLIENT_SECRET=seu_client_secret_aqui
TUYA_REGION=us
TUYA_UID=seu_uid_aqui
```

**Importante:** 
- Sem espaços antes ou depois do `=`
- Sem aspas ao redor dos valores
- Sem comentários na mesma linha


