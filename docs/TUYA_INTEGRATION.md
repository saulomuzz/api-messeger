# Integração com API Tuya

Documentação completa sobre como usar a integração com a API do Tuya para consultar o status dos dispositivos inteligentes.

## Índice

- [Configuração](#configuração)
- [Uso via WhatsApp](#uso-via-whatsapp)
- [Endpoints REST](#endpoints-rest)
- [Exemplos](#exemplos)
- [Troubleshooting](#troubleshooting)

## Configuração

### Variáveis de Ambiente

Adicione as seguintes variáveis ao seu arquivo `.env`:

```bash
# Tuya API - DADOS SENSÍVEIS - NÃO COMMITAR NO GIT
TUYA_CLIENT_ID=seu_access_id_aqui
TUYA_CLIENT_SECRET=seu_access_secret_aqui
TUYA_REGION=us
TUYA_UID=seu_uid_aqui
```

**⚠️ IMPORTANTE: Segurança**
- O arquivo `.env` já está no `.gitignore` e **NÃO será commitado no Git**
- **NUNCA** adicione dados reais em arquivos de documentação (`.md`)
- Use apenas placeholders (`seu_client_id_aqui`, etc.) nos arquivos versionados

**Onde obter as credenciais na plataforma Tuya:**

Na página do seu projeto (como mostra a imagem), você encontrará:

1. **Access ID/Client ID** → Vai em `TUYA_CLIENT_ID`
   - Copie o valor do campo "Access ID/Client ID"
   
2. **Access Secret/Client Secret** → Vai em `TUYA_CLIENT_SECRET`
   - Clique no ícone do olho para mostrar o segredo
   - Copie o valor completo do "Access Secret/Client Secret"
   
3. **TUYA_REGION** → Baseado no "Data Center"
   - `Western America Data Center` = `us`
   - `Eastern America Data Center` = `us`
   - `Central Europe Data Center` = `eu`
   - `Western Europe Data Center` = `eu`
   - `China Data Center` = `cn`
   - `India Data Center` = `in`

4. **TUYA_UID** → UID da conta de aplicativo vinculada ao projeto
   - **Onde encontrar:** Na página de gerenciamento de contas de aplicativo do projeto
   - **Como acessar:** Plataforma Tuya Developer > Seu Projeto > Gerenciamento de Contas de App
   - **O que procurar:** Coluna "UID" na tabela (exemplo: `az1655237368792Wwr37`)
   - Este UID é usado para listar os dispositivos daquela conta

**Regiões disponíveis:**
- `us` - Estados Unidos (padrão)
- `eu` - Europa
- `cn` - China
- `in` - Índia

**Configuração do UID:**
- `TUYA_UID`: UID do usuário Tuya (obrigatório para usar comandos simplificados)
- Se configurado, você pode usar `!tuya list` sem precisar digitar o UID toda vez

**Autorização de Números:**
Os comandos Tuya via WhatsApp usam o mesmo arquivo de números (`numbers.txt`) configurado na variável `NUMBERS_FILE`. Apenas números presentes neste arquivo poderão usar os comandos (exceto `!tuya help`, que sempre está disponível).

### Como Descobrir o TUYA_UID

O **TUYA_UID** é o UID da conta de aplicativo vinculada ao seu projeto. Para encontrá-lo:

1. Acesse a plataforma Tuya Developer
2. Vá para seu projeto (ex: "Api-Wpp")
3. Navegue até a seção de **"Gerenciamento de Contas de App"** ou similar
4. Na tabela de contas vinculadas, procure a coluna **"UID"**
5. Copie o valor do UID (formato exemplo: `az1234567890abcdef`)

**Exemplo:**
- **UID:** `az1234567890abcdef`
- **App Name:** SmartLife
- **Projeto Vinculado:** Seu-Projeto
- **Dispositivos:** 32/32

Este é o UID que você deve usar no `TUYA_UID` do arquivo `.env`.

**Nota:** Se você não configurar o `TUYA_UID`, ainda poderá usar os comandos, mas precisará fornecer o UID manualmente em cada comando.

## Uso via WhatsApp

Você pode consultar o status dos dispositivos Tuya enviando comandos diretamente via WhatsApp para o número conectado à API.

### Comandos Disponíveis

#### `!tuya help`
Mostra a lista de comandos disponíveis e exemplos de uso.

**Exemplo:**
```
!tuya help
```

#### `!tuya list`
Lista todos os seus dispositivos automaticamente (usa o UID configurado no `.env`).

**Exemplo:**
```
!tuya list
```

**Resposta:**
```
📱 Seus Dispositivos Tuya

Total: 3
Ligados: 2

Para consultar status, use:
!tuya status 1 (número da lista)
!tuya status Nome do Dispositivo (nome)

━━━━━━━━━━━━━━━━━━━━

1. 🟢 Lâmpada Sala
   🟢 Online: Sim
   📦 Categoria: kg
   ⚡ 1 propriedade(s) ligada(s)

2. 🔴 Lâmpada Quarto
   🟢 Online: Sim
   📦 Categoria: kg
```

#### `!tuya status <número, nome ou ID>`
Consulta o status de um dispositivo. Você pode usar:
- **Número da lista**: `!tuya status 1`
- **Nome do dispositivo**: `!tuya status Lâmpada Sala`
- **ID completo**: `!tuya status bf1234567890abcdef`

**Exemplos:**
```
!tuya status 1
!tuya status Lâmpada Sala
!tuya status bf1234567890abcdef
```

**Resposta:**
```
📱 Status do Dispositivo Tuya

Nome: Lâmpada Sala
Status: 🟢 LIGADO

Propriedades:
🟢 switch_led: true
⚙️ bright: 50
```

#### `!tuya devices <uid>` (Compatibilidade)
Lista dispositivos fornecendo o UID manualmente (útil se não configurou `TUYA_UID` no `.env`).

**Exemplo:**
```
!tuya devices az1234567890abcdef
```

### Segurança

Os comandos Tuya verificam se o número está no arquivo `numbers.txt` (configurado via `NUMBERS_FILE`). Apenas números presentes neste arquivo poderão usar os comandos Tuya. O comando `!tuya help` sempre estará disponível para todos.

**Nota:** Se o arquivo `numbers.txt` estiver vazio ou não existir, todos os números poderão usar os comandos. Recomenda-se adicionar os números autorizados ao arquivo.

## Endpoints REST

### GET /tuya/device/:deviceId/status

Consulta o status de um dispositivo específico e identifica se está ligado.

**Autenticação:** Requer `X-API-Token` se `API_TOKEN` estiver configurado.

**Parâmetros:**
- `deviceId` (path): ID do dispositivo Tuya

**Exemplo de Requisição:**
```bash
curl -X GET "http://localhost:3000/tuya/device/bf1234567890abcdef/status" \
  -H "X-API-Token: seu_token_secreto"
```

**Resposta de Sucesso (200):**
```json
{
  "ok": true,
  "requestId": "uuid-do-request",
  "deviceId": "bf1234567890abcdef",
  "status": [
    {
      "code": "switch_led",
      "value": true,
      "t": 1234567890
    },
    {
      "code": "bright",
      "value": 50,
      "t": 1234567890
    }
  ],
  "poweredOn": true,
  "poweredOnCount": 1,
  "timestamp": "2024-01-01T12:00:00.000Z"
}
```

**Campos da Resposta:**
- `status`: Array com todas as propriedades do dispositivo
- `poweredOn`: `true` se pelo menos uma propriedade de ligar/desligar estiver ativa
- `poweredOnCount`: Número de propriedades ligadas

### GET /tuya/devices

Lista todos os dispositivos de um usuário e seus status.

**Autenticação:** Requer `X-API-Token` se `API_TOKEN` estiver configurado.

**Parâmetros:**
- `uid` (query): ID do usuário Tuya (obrigatório)

**Exemplo de Requisição:**
```bash
curl -X GET "http://localhost:3000/tuya/devices?uid=az1234567890abcdef" \
  -H "X-API-Token: seu_token_secreto"
```

**Resposta de Sucesso (200):**
```json
{
  "ok": true,
  "requestId": "uuid-do-request",
  "total": 3,
  "poweredOn": 2,
  "devices": [
    {
      "id": "bf1234567890abcdef",
      "name": "Lâmpada Sala",
      "online": true,
      "category": "kg",
      "poweredOn": true,
      "poweredOnCount": 1,
      "status": [
        {
          "code": "switch_led",
          "value": true,
          "t": 1234567890
        }
      ]
    },
    {
      "id": "bf0987654321fedcba",
      "name": "Lâmpada Quarto",
      "online": true,
      "category": "kg",
      "poweredOn": false,
      "poweredOnCount": 0,
      "status": [
        {
          "code": "switch_led",
          "value": false,
          "t": 1234567890
        }
      ]
    }
  ],
  "timestamp": "2024-01-01T12:00:00.000Z"
}
```

### POST /tuya/devices/status

Consulta o status de múltiplos dispositivos de uma vez.

**Autenticação:** Requer `X-API-Token` se `API_TOKEN` estiver configurado.

**Corpo da Requisição:**
```json
{
  "deviceIds": [
    "bf1234567890abcdef",
    "bf0987654321fedcba",
    "bfabcdef1234567890"
  ]
}
```

**Exemplo de Requisição:**
```bash
curl -X POST "http://localhost:3000/tuya/devices/status" \
  -H "Content-Type: application/json" \
  -H "X-API-Token: seu_token_secreto" \
  -d '{
    "deviceIds": [
      "bf1234567890abcdef",
      "bf0987654321fedcba"
    ]
  }'
```

**Resposta de Sucesso (200):**
```json
{
  "ok": true,
  "requestId": "uuid-do-request",
  "total": 2,
  "poweredOn": 1,
  "devices": [
    {
      "id": "bf1234567890abcdef",
      "poweredOn": true,
      "poweredOnCount": 1,
      "status": [
        {
          "code": "switch_led",
          "value": true,
          "t": 1234567890
        }
      ]
    },
    {
      "id": "bf0987654321fedcba",
      "poweredOn": false,
      "poweredOnCount": 0,
      "status": [
        {
          "code": "switch_led",
          "value": false,
          "t": 1234567890
        }
      ]
    }
  ],
  "timestamp": "2024-01-01T12:00:00.000Z"
}
```

## Detecção de Dispositivos Ligados

A API identifica automaticamente quais dispositivos estão ligados procurando por propriedades com códigos que contenham:
- `switch`
- `power`

E valores que indiquem estado ligado:
- `true`
- `1`
- `"true"`
- `"on"`

## Exemplos de Uso

### Consultar um Dispositivo Específico

```bash
# Descobrir se uma lâmpada está ligada
curl -X GET "http://localhost:3000/tuya/device/bf1234567890abcdef/status" \
  -H "X-API-Token: seu_token"
```

### Listar Todos os Dispositivos de um Usuário

```bash
# Listar todos os dispositivos e ver quais estão ligados
curl -X GET "http://localhost:3000/tuya/devices?uid=az1234567890abcdef" \
  -H "X-API-Token: seu_token"
```

### Consultar Múltiplos Dispositivos

```bash
# Verificar status de várias lâmpadas
curl -X POST "http://localhost:3000/tuya/devices/status" \
  -H "Content-Type: application/json" \
  -H "X-API-Token: seu_token" \
  -d '{
    "deviceIds": [
      "bf1234567890abcdef",
      "bf0987654321fedcba",
      "bfabcdef1234567890"
    ]
  }'
```

## Troubleshooting

### Erro: "TUYA_CLIENT_ID e TUYA_CLIENT_SECRET devem estar configurados"

Verifique se você adicionou as variáveis de ambiente no arquivo `.env`:
```bash
TUYA_CLIENT_ID=seu_client_id
TUYA_CLIENT_SECRET=seu_client_secret
TUYA_REGION=us
```

### Erro: "Falha ao obter token" ou "sign invalid" (código 1004)

**Este é o erro mais comum!** Indica que a assinatura está incorreta.

**Causas possíveis:**

1. **Credenciais incorretas ou incompletas**
   - Verifique se `TUYA_CLIENT_ID` e `TUYA_CLIENT_SECRET` estão corretos no `.env`
   - Certifique-se de não haver espaços extras
   - Copie novamente da plataforma usando o ícone de cópia

2. **Região incorreta**
   - Verifique se `TUYA_REGION` corresponde ao Data Center do projeto
   - "Western America Data Center" = `us`
   - Veja a seção de configuração para mais detalhes

3. **Formato da assinatura**
   - A assinatura é gerada automaticamente
   - Se o problema persistir, ative `DEBUG=true` para ver os detalhes

**Solução rápida:**
1. Ative o modo debug: `DEBUG=true` no `.env`
2. Verifique os logs detalhados da assinatura
3. Confirme que as credenciais estão corretas na plataforma Tuya
4. Verifique se a região está correta

**Consulte:** `TUYA_TROUBLESHOOTING.md` para guia completo de troubleshooting

### Erro: "Falha ao obter status"

1. Verifique se o Device ID está correto
2. Verifique se o dispositivo está online
3. Verifique os logs com `DEBUG=true` para mais detalhes

### Como Ativar o Modo Debug

Adicione ao arquivo `.env`:
```bash
DEBUG=true
```

Isso mostrará informações detalhadas sobre as requisições à API Tuya.

## Logs

Os logs são salvos no arquivo configurado em `LOG_PATH`. Exemplos de mensagens:

- `[TUYA] Access token obtido com sucesso` - Token obtido
- `[TUYA-STATUS] Status obtido: X propriedade(s), Y ligado(s)` - Status consultado
- `[TUYA-DEVICES] X dispositivo(s) encontrado(s), Y ligado(s)` - Lista de dispositivos

## Referências

- [Tuya Developer Platform](https://developer.tuya.com/)
- [Tuya API Documentation](https://developer.tuya.com/en/docs/cloud/)
- [Tuya OpenAPI Reference](https://developer.tuya.com/en/docs/cloud/device-management?id=Kavzt4ci2y6zr)

