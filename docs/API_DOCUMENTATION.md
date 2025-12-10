# Documentação da API WhatsApp

API REST para integração com WhatsApp utilizando `whatsapp-web.js`, com suporte para envio de snapshots de câmera IP via ESP32.

## Índice

- [Requisitos](#requisitos)
- [Configuração](#configuração)
- [Endpoints](#endpoints)
- [Segurança ESP32](#segurança-esp32)
- [Configuração da Câmera](#configuração-da-câmera)
- [Estrutura do Projeto](#estrutura-do-projeto)

## Requisitos

- Node.js 18 ou superior
- Navegador Chromium (fornecido automaticamente pelo `whatsapp-web.js`)
- Acesso a uma câmera IP (opcional, para funcionalidade de snapshot)

## Configuração

### 1. Instalação

```bash
npm install
```

### 2. Variáveis de Ambiente

Copie o arquivo `.env.example` para `.env` e configure as variáveis:

```bash
cp .env.example .env
```

#### Variáveis Principais

**API Básica:**
- `PORT`: Porta onde a API será exposta (padrão: 3000)
- `API_TOKEN`: Token opcional para autenticação via cabeçalho `X-API-Token`
- `CORS_ORIGIN`: Origem permitida para CORS (use `*` para liberar geral)
- `DEBUG`: Habilita logs detalhados (`true`/`false`)
- `LOG_PATH`: Caminho do arquivo de log (padrão: `/var/log/whatsapp-api.log`)
- `APP_ROOT`: Diretório raiz da aplicação (padrão: `/opt/whatsapp-api`)

**WhatsApp:**
- `AUTH_DATA_PATH`: Caminho para dados de autenticação do WhatsApp (padrão: `{APP_ROOT}/.wwebjs_auth`)

**Câmera IP (para snapshots):**
- `CAMERA_SNAPSHOT_URL`: URL completa do snapshot da câmera (ex: `http://192.168.1.100/cgi-bin/snapshot.cgi?channel=1`)
- `CAMERA_USER`: Usuário para autenticação na câmera
- `CAMERA_PASS`: Senha para autenticação na câmera

**Números de Telefone:**
- `NUMBERS_FILE`: Caminho do arquivo com números de telefone (padrão: `{APP_ROOT}/numbers.txt`)

**Segurança ESP32:**
- `ESP32_TOKEN`: Token secreto para autenticação de dispositivos ESP32
- `ESP32_ALLOWED_IPS`: Lista de IPs permitidos (separados por vírgula, suporta CIDR)

**Tuya API (opcional):**
- `TUYA_CLIENT_ID`: Client ID da API Tuya
- `TUYA_CLIENT_SECRET`: Client Secret da API Tuya
- `TUYA_REGION`: Região da API Tuya (`us`, `eu`, `cn`, `in`) - padrão: `us`
- **Nota:** Os comandos Tuya via WhatsApp usam o mesmo arquivo `numbers.txt` para autorização

**Assinatura RSA (Opcional):**
- `REQUIRE_SIGNED_REQUESTS`: Exige assinaturas RSA para `/send` (`true`/`false`)
- `PUBLIC_KEY_PATH`: Caminho para a chave pública RSA
- `SIG_MAX_SKEW_SECONDS`: Tolerância de tempo para assinaturas (padrão: 300s)

### 3. Arquivo de Números

Crie o arquivo `numbers.txt` (ou configure `NUMBERS_FILE`) com um número por linha:

```
+5511999999999
+5511888888888
# Linhas começando com # são ignoradas
```

### 4. Execução

```bash
npm start
```

No primeiro acesso, será necessário escanear o QR Code exibido no terminal ou acessando `/qr.png`.

## Endpoints

### GET /health

Verifica se a API está disponível e se o WhatsApp está pronto.

**Resposta de Sucesso (200):**
```json
{
  "ok": true,
  "ready": true,
  "status": "connected"
}
```

**Resposta quando WhatsApp não está pronto:**
```json
{
  "ok": true,
  "ready": false,
  "status": "disconnected"
}
```

### GET /status

Retorna o estado detalhado do cliente WhatsApp.

**Autenticação:** Requer `X-API-Token` se `API_TOKEN` estiver configurado.

**Resposta:**
```json
{
  "ok": true,
  "ready": true,
  "status": "connected",
  "qr": null
}
```

### GET /qr.png

Retorna o QR Code atual em formato PNG para autenticação do WhatsApp.

### POST /send

Envia mensagens de texto para um número brasileiro.

**Autenticação:** Requer `X-API-Token` se `API_TOKEN` estiver configurado.

**Corpo da Requisição:**
```json
{
  "phone": "+5511999999999",
  "message": "Olá!",
  "subject": "Assunto opcional (para grupos)"
}
```

**Resposta de Sucesso:**
```json
{
  "ok": true,
  "msgId": "true_5511999999999@c.us_ABC123",
  "to": "5511999999999@c.us"
}
```

### POST /trigger-snapshot

**Endpoint para ESP32** - Captura snapshot da câmera IP e envia para números cadastrados.

**Autenticação:** Requer `X-ESP32-Token` e IP na whitelist (se configurado).

**Headers:**
- `X-ESP32-Token`: Token configurado em `ESP32_TOKEN`

**Corpo da Requisição (opcional):**
```json
{
  "message": "Mensagem personalizada"
}
```

**Resposta de Sucesso:**
```json
{
  "ok": true,
  "requestId": "uuid-do-request",
  "total": 2,
  "success": 2,
  "failed": 0,
  "results": [
    {
      "phone": "+5511999999999",
      "success": true,
      "to": "5511999999999@c.us",
      "msgId": "true_5511999999999@c.us_ABC123"
    }
  ]
}
```

**Erros Comuns:**
- `401`: Token inválido ou IP não autorizado
- `400`: Câmera não configurada ou snapshot falhou
- `503`: WhatsApp não está pronto

### GET /tuya/device/:deviceId/status

Consulta o status de um dispositivo Tuya específico e identifica se está ligado.

**Autenticação:** Requer `X-API-Token` se `API_TOKEN` estiver configurado.

**Parâmetros:**
- `deviceId` (path): ID do dispositivo Tuya

**Resposta de Sucesso:**
```json
{
  "ok": true,
  "requestId": "uuid",
  "deviceId": "bf1234567890abcdef",
  "status": [
    {
      "code": "switch_led",
      "value": true,
      "t": 1234567890
    }
  ],
  "poweredOn": true,
  "poweredOnCount": 1,
  "timestamp": "2024-01-01T12:00:00.000Z"
}
```

Para documentação completa sobre a integração Tuya, consulte **[TUYA_INTEGRATION.md](TUYA_INTEGRATION.md)**.

### GET /tuya/devices

Lista todos os dispositivos de um usuário Tuya e seus status.

**Autenticação:** Requer `X-API-Token` se `API_TOKEN` estiver configurado.

**Parâmetros:**
- `uid` (query): ID do usuário Tuya (obrigatório)

**Exemplo:**
```
GET /tuya/devices?uid=az1234567890abcdef
```

### POST /tuya/devices/status

Consulta o status de múltiplos dispositivos Tuya de uma vez.

**Autenticação:** Requer `X-API-Token` se `API_TOKEN` estiver configurado.

**Corpo da Requisição:**
```json
{
  "deviceIds": [
    "bf1234567890abcdef",
    "bf0987654321fedcba"
  ]
}
```

### GET /esp32/validate

**Endpoint para ESP32** - Valida se o dispositivo está autorizado sem enviar snapshot.

**Autenticação:** Requer `X-ESP32-Token` e IP na whitelist (se configurado).

**Headers:**
- `X-ESP32-Token`: Token configurado em `ESP32_TOKEN`

**Resposta Autorizada:**
```json
{
  "ok": true,
  "authorized": true,
  "message": "ESP32 autorizado",
  "ip": "192.168.1.100",
  "checks": {
    "ip": {
      "passed": true,
      "message": "IP 192.168.1.100 autorizado"
    },
    "token": {
      "passed": true,
      "message": "Token válido"
    }
  }
}
```

**Resposta Não Autorizada:**
```json
{
  "ok": false,
  "authorized": false,
  "error": "invalid_token",
  "message": "Token inválido ou não fornecido"
}
```

## Segurança ESP32

### Configuração de Token

Defina um token forte em `ESP32_TOKEN`:

```bash
ESP32_TOKEN=seu_token_super_secreto_aqui
```

### Whitelist de IPs (Opcional)

Para restringir acesso apenas a IPs específicos:

```bash
ESP32_ALLOWED_IPS=192.168.1.100,192.168.1.0/24,10.0.0.10
```

- Suporta IPs individuais: `192.168.1.100`
- Suporta CIDR: `192.168.1.0/24`
- Múltiplos IPs separados por vírgula

### Como Funciona

1. O ESP32 envia o token no header `X-ESP32-Token`
2. A API verifica se o token corresponde a `ESP32_TOKEN`
3. Se `ESP32_ALLOWED_IPS` estiver configurado, verifica se o IP do cliente está na lista
4. Retorna `authorized: true` apenas se ambas as verificações passarem

## Configuração da Câmera

### Autenticação

A API suporta dois métodos de autenticação:

1. **Basic HTTP**: Tenta primeiro
2. **Digest HTTP**: Usado automaticamente se Basic falhar

### Variáveis Necessárias

```bash
CAMERA_SNAPSHOT_URL=http://192.168.1.100/cgi-bin/snapshot.cgi?channel=1
CAMERA_USER=admin
CAMERA_PASS=sua_senha
```

### Teste Manual

```bash
# Teste Basic
curl -u admin:senha http://192.168.1.100/cgi-bin/snapshot.cgi?channel=1 -o test.jpg

# Teste Digest (se Basic falhar)
curl --digest -u admin:senha http://192.168.1.100/cgi-bin/snapshot.cgi?channel=1 -o test.jpg
```

## Estrutura do Projeto

```
api-messeger/
├── src/
│   └── app.js          # Implementação principal da API
├── .env                # Variáveis de ambiente (não versionado)
├── .env.example        # Exemplo de configuração
├── numbers.txt         # Números de telefone (não versionado)
├── numbers.txt.example # Exemplo de números
├── package.json        # Dependências Node.js
├── README.md           # Documentação básica
└── API_DOCUMENTATION.md # Esta documentação
```

## Logs

Os logs são salvos no arquivo configurado em `LOG_PATH`. Use `DEBUG=true` para logs detalhados.

**Níveis de Log:**
- `INFO`: Operações normais
- `DEBUG`: Informações detalhadas (apenas com `DEBUG=true`)
- `WARN`: Avisos
- `ERROR`: Erros

## Troubleshooting

### WhatsApp não conecta

1. Verifique se o QR Code foi escaneado
2. Verifique os logs em `LOG_PATH`
3. Certifique-se de que o diretório `.wwebjs_auth` tem permissões de escrita

### Snapshot falha com 401

1. Verifique `CAMERA_USER` e `CAMERA_PASS`
2. Teste a URL da câmera manualmente com `curl`
3. Verifique os logs em modo DEBUG para detalhes da autenticação

### ESP32 não autorizado

1. Verifique se `ESP32_TOKEN` está configurado corretamente
2. Verifique se o IP do ESP32 está em `ESP32_ALLOWED_IPS` (se configurado)
3. Use o endpoint `/esp32/validate` para testar

## Licença

Este projeto baseia-se no trabalho de [BenyFilho/whatsapp-web.js](https://github.com/BenyFilho/whatsapp-web.js) e nos termos da licença MIT.


