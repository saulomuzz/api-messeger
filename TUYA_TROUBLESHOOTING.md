# Troubleshooting - Erro "sign invalid" na API Tuya

## Erro: "sign invalid" (Código 1004)

Este erro indica que a assinatura HMAC-SHA256 está incorreta. Aqui estão as causas mais comuns e soluções:

### 1. Verificar Credenciais

Certifique-se de que as credenciais no arquivo `.env` estão corretas:

```bash
TUYA_CLIENT_ID=smu5nmy5cuueqvag5xty
TUYA_CLIENT_SECRET=8dc9e1576bb64b8c98bee0d4af2e8801
TUYA_REGION=us
```

**Verifique:**
- ✅ Não há espaços extras antes ou depois dos valores
- ✅ Os valores estão completos (sem truncamento)
- ✅ Não há caracteres especiais adicionais
- ✅ O `TUYA_CLIENT_SECRET` está correto (clique no ícone do olho para ver o valor completo)

### 2. Ativar Debug Mode

Adicione ao arquivo `.env`:

```bash
DEBUG=true
```

Isso mostrará logs detalhados sobre a geração da assinatura, incluindo:
- Método HTTP
- Path usado
- Hash do body
- String de assinatura (sem o secret)
- Assinatura gerada

### 3. Verificar Região (Data Center)

A região deve corresponder ao Data Center do seu projeto:

```bash
# Baseado na imagem: "Data Center: Western America Data Center"
TUYA_REGION=us
```

**Mapeamento:**
- Western America Data Center → `us`
- Eastern America Data Center → `us`
- Central Europe Data Center → `eu`
- Western Europe Data Center → `eu`
- China Data Center → `cn`
- India Data Center → `in`

### 4. Verificar Formato da Assinatura

A assinatura segue este formato:

```
stringToSign = method + "\n" + SHA256(body).toLowerCase() + "\n\n" + path
signStr = client_id + secret + timestamp + stringToSign
sign = HMAC-SHA256(signStr, secret).toUpperCase()
```

### 5. Problemas Comuns

#### Problema: Credenciais incorretas
**Solução:** Copie novamente da plataforma Tuya, clicando no ícone de cópia

#### Problema: Região incorreta
**Solução:** Verifique o Data Center do projeto e ajuste `TUYA_REGION`

#### Problema: Timestamp desatualizado
**Solução:** O timestamp é gerado automaticamente. Verifique se o relógio do servidor está correto.

#### Problema: Query string no path
**Solução:** Para requisições GET, o path na assinatura deve incluir a query string

### 6. Verificar Logs de Debug

Com `DEBUG=true`, você verá logs como:

```
[TUYA-SIGN] Method: GET
[TUYA-SIGN] Path: /v1.0/token?grant_type=1
[TUYA-SIGN] Body: "" (length: 0)
[TUYA-SIGN] BodyHash: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

### 7. Teste Manual com curl

**⚠️ IMPORTANTE:** Você NÃO pode usar o `CLIENT_SECRET` diretamente como assinatura! A assinatura deve ser calculada dinamicamente com HMAC-SHA256.

#### Opção 1: Usar o script de teste (Recomendado)

Execute o script `test-tuya-sign.js` que gera automaticamente a assinatura correta:

```bash
node test-tuya-sign.js
```

Este script vai:
- Calcular a assinatura corretamente usando HMAC-SHA256
- Gerar um timestamp atual (não use timestamps antigos!)
- Mostrar o comando curl completo pronto para usar

#### Erros Comuns no Teste Manual

**❌ ERRADO (o que você tentou):**
```bash
# NÃO use o CLIENT_SECRET como sign!
curl -X GET "https://openapi.tuyaus.com/v1.0/token?grant_type=1" \
  -H "client_id: smu5nmy5cuueqvag5xty" \
  -H "sign: 8dc9e1576bb64b8c98bee0d4af2e8801" \  # ❌ Isso é o SECRET, não a assinatura!
  -H "t: 1765068057679" \  # ❌ Timestamp antigo (vai dar erro "request time is invalid")
  -H "sign_method: HMAC-SHA256"
```

**Por que está errado:**
1. O campo `sign` deve conter a assinatura calculada com HMAC-SHA256, não o `CLIENT_SECRET`
2. O timestamp deve ser atual (gerado no momento da requisição), não um valor antigo
3. A assinatura depende do timestamp, então cada requisição precisa de uma assinatura nova

**✅ CORRETO:**
```bash
# Use o script test-tuya-sign.js para gerar tudo automaticamente
node test-tuya-sign.js
# Copie e execute o comando curl que o script mostrará IMEDIATAMENTE
```

### 8. Verificar IP Whitelist (Se Ativado)

Se você ativou a whitelist de IPs na plataforma Tuya, certifique-se de que o IP do servidor está na lista.

### 9. Contatar Suporte

Se o problema persistir após verificar todos os itens acima:

1. Verifique os logs completos com `DEBUG=true`
2. Verifique se as credenciais estão corretas na plataforma
3. Verifique se o projeto está ativo
4. Consulte a [documentação oficial da Tuya](https://developer.tuya.com/en/docs/iot/sign-requests-for-cloud-authorization)

## Checklist Rápido

- [ ] `TUYA_CLIENT_ID` está correto (sem espaços)
- [ ] `TUYA_CLIENT_SECRET` está correto e completo
- [ ] `TUYA_REGION` corresponde ao Data Center do projeto
- [ ] `DEBUG=true` está configurado para ver logs detalhados
- [ ] O servidor tem acesso à internet
- [ ] O relógio do servidor está sincronizado
- [ ] IP whitelist não está bloqueando (se configurado)

