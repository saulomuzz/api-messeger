# Diagnóstico do Erro "sign invalid" (Código 1004)

## Resumo do Problema

Você está recebendo o erro **"sign invalid" (código 1004)** ao tentar obter um access token da API Tuya.

## O que já foi feito

1. ✅ Função de assinatura implementada (`generateTuyaSign`)
2. ✅ Logs de debug adicionados (mostram todos os detalhes da assinatura)
3. ✅ Formato da assinatura verificado (conforme documentação Tuya)
4. ✅ Script de teste criado (`test-tuya-sign.js`)

## Análise dos Logs

Nos logs de debug, vejo que:
- ✅ A assinatura está sendo gerada
- ✅ O formato parece correto
- ❌ Mas a Tuya está rejeitando (erro 1004)

## Causas Possíveis (por ordem de probabilidade)

### 1. Credenciais Incorretas ou Incompletas ⚠️ **MAIS PROVÁVEL**

Verifique no arquivo `.env`:

```bash
TUYA_CLIENT_ID=smu5nmy5cuueqvag5xty
TUYA_CLIENT_SECRET=8dc9e1576bb64b8c98bee0d4af2e8801
TUYA_REGION=us
```

**Ações:**
- [ ] Confirme que não há espaços antes/depois dos valores
- [ ] Copie novamente da plataforma Tuya (use o ícone de cópia)
- [ ] Verifique se o `TUYA_CLIENT_SECRET` está completo (32 caracteres hex)
- [ ] Certifique-se de que não há quebras de linha ou caracteres invisíveis

### 2. Região Incorreta

Verifique qual Data Center está configurado no seu projeto Tuya:

```bash
# Western America Data Center = us
# Eastern America Data Center = us  
# Central Europe Data Center = eu
# Western Europe Data Center = eu
# China Data Center = cn
# India Data Center = in
```

**Ação:**
- [ ] Confirme na plataforma Tuya qual é o Data Center do seu projeto
- [ ] Ajuste `TUYA_REGION` se necessário

### 3. Projeto Inativo ou Permissões

**Ações:**
- [ ] Verifique se o projeto está ativo na plataforma Tuya
- [ ] Confirme que as permissões necessárias estão habilitadas
- [ ] Verifique se não há restrições de IP ativadas

### 4. Relógio do Servidor Dessincronizado

**Ação:**
```bash
# Verificar hora do servidor
date

# Sincronizar (Linux)
sudo ntpdate -s time.nist.gov
# ou
sudo timedatectl set-ntp true
```

### 5. Formato da Assinatura (Menos Provável)

O formato está correto segundo a documentação, mas pode haver alguma diferença sutil.

## Como Diagnosticar

### Passo 1: Execute o Script de Teste

```bash
node test-tuya-sign.js
```

Isso vai mostrar:
- As credenciais que estão sendo usadas
- O cálculo completo da assinatura
- Um comando curl pronto para testar

### Passo 2: Verifique as Credenciais na Plataforma

1. Acesse: https://iot.tuya.com/
2. Vá no seu projeto
3. Na página "Overview", verifique:
   - Access ID/Client ID
   - Access Secret/Client Secret (clique no ícone do olho)
   - Data Center

### Passo 3: Compare com o Arquivo .env

Compare os valores do `.env` com os da plataforma:
- Eles devem ser **EXATAMENTE** iguais
- Sem espaços extras
- Sem caracteres invisíveis

### Passo 4: Teste com o Script

Execute o script e copie o comando curl que ele gerar:

```bash
node test-tuya-sign.js
# Copie o comando curl e execute IMEDIATAMENTE
```

**⚠️ IMPORTANTE:** Execute o curl IMEDIATAMENTE após gerar, pois o timestamp expira rapidamente!

## Próximos Passos

1. **Verifique as credenciais** no `.env` comparando com a plataforma Tuya
2. **Execute o script de teste** para ver o cálculo da assinatura
3. **Teste com curl** usando o comando gerado pelo script
4. **Se ainda falhar**, verifique:
   - Status do projeto na plataforma Tuya
   - Permissões do projeto
   - Restrições de IP
   - Sincronização do relógio do servidor

## Arquivos Úteis

- `test-tuya-sign.js` - Script para gerar assinatura e testar
- `TUYA_TROUBLESHOOTING.md` - Guia completo de troubleshooting
- `ENV_PREENCHIDO_EXEMPLO.txt` - Exemplo de como preencher o .env
- `TUYA_INTEGRATION.md` - Documentação da integração

## Erro no Teste Manual que Você Tentou

No teste manual com curl que você tentou, havia dois erros:

1. **Timestamp antigo**: `1765068057679` (causou erro "request time is invalid")
2. **Assinatura incorreta**: Você usou o `CLIENT_SECRET` diretamente como `sign`, mas a assinatura precisa ser calculada com HMAC-SHA256

**Solução:** Use o script `test-tuya-sign.js` que calcula tudo automaticamente!


