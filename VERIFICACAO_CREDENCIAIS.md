# Verificação de Credenciais - Erro "sign invalid" (1004)

## Status Atual

O erro **"sign invalid" (código 1004)** persiste mesmo com a assinatura sendo calculada corretamente.

## Análise

O formato da assinatura está correto segundo a documentação, mas a Tuya continua rejeitando. Isso indica que o problema mais provável é com as **credenciais** ou a **região**.

## ⚠️ AÇÃO URGENTE: Verificar Credenciais na Plataforma Tuya

### Passo 1: Acessar a Plataforma

1. Acesse: https://iot.tuya.com/
2. Faça login na sua conta
3. Vá no seu projeto (provavelmente "Api-Wpp")

### Passo 2: Verificar as Credenciais

Na página **"Overview"** do projeto, você encontrará:

#### 1. Access ID / Client ID
- **Onde:** Seção "Authorization Key"
- **Valor atual no .env:** `smu5nmy5cuueqvag5xty`
- **Verificação:** 
  - [ ] O valor na plataforma é **EXATAMENTE** igual?
  - [ ] Não há espaços extras?
  - [ ] Está completo (sem truncamento)?

#### 2. Access Secret / Client Secret
- **Onde:** Seção "Authorization Key" (clique no ícone do olho para revelar)
- **Valor atual no .env:** `8dc9e1576bb64b8c98bee0d4af2e8801`
- **Verificação:**
  - [ ] O valor na plataforma é **EXATAMENTE** igual?
  - [ ] Tem 32 caracteres hexadecimais?
  - [ ] Não há espaços ou caracteres extras?
  - [ ] Você copiou o valor completo (não está truncado)?

#### 3. Data Center / Região
- **Onde:** Página "Overview" do projeto
- **Valor atual no .env:** `us` (Western America Data Center)
- **Verificação:**
  - [ ] O Data Center do seu projeto na plataforma é realmente "Western America Data Center"?
  - [ ] Se for outro, ajuste o `TUYA_REGION` no `.env`:
    - Western America Data Center → `us`
    - Eastern America Data Center → `us`
    - Central Europe Data Center → `eu`
    - Western Europe Data Center → `eu`
    - China Data Center → `cn`
    - India Data Center → `in`

### Passo 3: Atualizar o Arquivo .env

Se encontrar alguma diferença:

1. Abra o arquivo `.env` no servidor
2. Atualize os valores **EXATAMENTE** como aparecem na plataforma
3. **NÃO ADICIONE ESPAÇOS** antes ou depois dos valores
4. Salve o arquivo
5. Reinicie a aplicação

### Passo 4: Testar Novamente

```bash
node test-tuya-sign.js
```

## Outras Possibilidades (menos prováveis)

### 1. Projeto Inativo

- [ ] Verifique se o projeto está **ativo** na plataforma Tuya
- [ ] Verifique se não há restrições ou bloqueios no projeto

### 2. Permissões do Projeto

- [ ] Verifique se as permissões necessárias estão habilitadas
- [ ] Confirme que o tipo de projeto permite acesso à API

### 3. IP Whitelist

- [ ] Se você ativou whitelist de IPs, verifique se o IP do servidor está na lista
- [ ] Tente desativar temporariamente a whitelist para testar

### 4. Formato do Path na Assinatura

Estamos testando se o path no `stringToSign` deve incluir ou não a query string para requisições GET. Pode haver uma diferença sutil na documentação.

## Próximos Passos

1. **PRIORIDADE MÁXIMA:** Verifique as credenciais na plataforma Tuya e compare com o `.env`
2. Se as credenciais estiverem corretas, vamos investigar o formato do path
3. Verifique se o projeto está ativo e sem restrições

## Checklist Rápido

- [ ] Acessei a plataforma Tuya (https://iot.tuya.com/)
- [ ] Comparei `TUYA_CLIENT_ID` com o "Access ID" na plataforma
- [ ] Comparei `TUYA_CLIENT_SECRET` com o "Access Secret" na plataforma (revelado)
- [ ] Confirmei que o Data Center corresponde ao `TUYA_REGION`
- [ ] Atualizei o `.env` se necessário (sem espaços extras)
- [ ] Testei novamente com `node test-tuya-sign.js`

## Suporte

Se após verificar tudo isso o problema persistir:
- Consulte a documentação oficial: https://developer.tuya.com/en/docs/iot/authentication-method
- Entre em contato com o suporte da Tuya


