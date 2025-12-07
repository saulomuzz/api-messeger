# Exemplo de .env Preenchido - Tuya API

⚠️ **IMPORTANTE:** Este arquivo é apenas um **EXEMPLO**. Os valores abaixo são baseados nas suas imagens e devem ser colocados **APENAS no arquivo `.env` local**, que não será commitado no Git.

## Método de Autenticação

Segundo a [documentação oficial da Tuya](https://developer.tuya.com/en/docs/iot/authentication-method?id=Ka49gbaxjygox), estamos usando o **Simple Mode** (grant_type=1), que é aplicável para acessar dados criados por ou associados a um projeto cloud.

## Campos Preenchidos Baseados na Sua Plataforma

### Dados da Seção "Authorization Key":

```bash
# Tuya API - DADOS SENSÍVEIS - NUNCA COMMITAR
TUYA_CLIENT_ID=smu5nmy5cuueqvag5xty
TUYA_CLIENT_SECRET=8dc9e1576bb64b8c98bee0d4af2e8801
```

**Onde encontrar:**
- **TUYA_CLIENT_ID**: Campo "Access ID/Client ID" na página Overview do projeto "Api-Wpp"
- **TUYA_CLIENT_SECRET**: Campo "Access Secret/Client Secret" na mesma página

### Dados da Seção "Data Center":

```bash
TUYA_REGION=us
```

**Onde encontrar:**
- Baseado no "Data Center: Western America Data Center" do projeto
- **Mapeamento:**
  - `Western America Data Center` → `us`
  - `Eastern America Data Center` → `us`
  - `Central Europe Data Center` → `eu`
  - `Western Europe Data Center` → `eu`
  - `China Data Center` → `cn`
  - `India Data Center` → `in`

### Dados Adicionais Necessários:

```bash
TUYA_UID=obter_separadamente
```

**Sobre o TUYA_UID:**
- ✅ **Onde encontrar:** Na página de gerenciamento de contas de aplicativo do projeto
- ✅ **Como acessar:** Na plataforma Tuya Developer, vá para o projeto > seção de gerenciamento de contas de aplicativo
- ✅ **O que procurar:** Na coluna "UID" da tabela de contas de aplicativo
- 📋 **Exemplo do seu caso:** `az1655237368792Wwr37` (vinculado ao projeto "Api-Wpp" com 32 dispositivos)

**Nota importante:**
- O "User ID: 32M19MVD" da página "Account Center" **NÃO é o TUYA_UID**
- O TUYA_UID correto está na tabela de contas de aplicativo vinculadas ao projeto

## Arquivo .env Completo (Exemplo)

```bash
# ============================================
# TUYA API - Configuração
# ============================================
# ⚠️ ESTES SÃO DADOS SENSÍVEIS - NUNCA COMMITAR
# O arquivo .env já está no .gitignore

TUYA_CLIENT_ID=smu5nmy5cuueqvag5xty
TUYA_CLIENT_SECRET=8dc9e1576bb64b8c98bee0d4af2e8801
TUYA_REGION=us
TUYA_UID=az1655237368792Wwr37

# ============================================
# Outras configurações do projeto
# ============================================
PORT=3000
DEBUG=false
```

## Como Obter o TUYA_UID

O TUYA_UID necessário para listar dispositivos pode ser obtido de algumas formas:

### Opção 1: Através da API (quando tiver um dispositivo)

Depois que você tiver pelo menos um dispositivo vinculado, você pode obter o UID através da lista de dispositivos ou através do próprio dispositivo.

### Opção 2: Através do App Tuya

1. Abra o app Tuya no celular
2. Vá nas configurações da conta
3. O UID pode estar visível nas informações da conta

### Opção 3: Através da API de Usuários

Você precisará fazer uma chamada à API de usuários da Tuya para obter o UID associado ao seu projeto.

## Autenticação Simple Mode

Conforme a [documentação da Tuya](https://developer.tuya.com/en/docs/iot/authentication-method?id=Ka49gbaxjygox):

1. **Obter access_token**: `GET /v1.0/token?grant_type=1`
   - Parâmetros necessários: `client_id` (header), `secret` (para assinar), `grant_type=1` (fixo)
   - Retorna: `access_token`

2. **Fazer chamadas de serviço**: Usar o `access_token` obtido
   - Headers necessários: `client_id`, `access_token`, `sign`, `t`, `sign_method`

## Referências

- [Documentação de Autenticação Tuya](https://developer.tuya.com/en/docs/iot/authentication-method?id=Ka49gbaxjygox)
- [Assinar Requisições para Cloud Authorization](https://developer.tuya.com/en/docs/iot/sign-requests-for-cloud-authorization)
- [Obter Token - Referência da API](https://developer.tuya.com/en/docs/iot/get-a-token)

## Checklist de Segurança

- [ ] Arquivo `.env` criado na raiz do projeto
- [ ] Dados sensíveis adicionados APENAS no `.env`
- [ ] Arquivo `.env` está no `.gitignore` (já configurado)
- [ ] Nenhum dado real está em arquivos de documentação (`.md`)
- [ ] TUYA_UID obtido e configurado

