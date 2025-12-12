# API Messenger

API REST para integração com o WhatsApp utilizando [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js), com suporte para envio de snapshots de câmera IP via ESP32.

## Características

- ✅ Envio de mensagens de texto via WhatsApp
- ✅ Envio de snapshots de câmera IP (via ESP32)
- ✅ **Otimização automática de imagens** (compressão e redimensionamento)
- ✅ **Envio paralelo** para múltiplos números (mais rápido)
- ✅ Integração com API Tuya para consultar status de dispositivos inteligentes via WhatsApp ou API REST
- ✅ Autenticação por token e whitelist de IPs
- ✅ Suporte a autenticação Basic e Digest HTTP para câmeras
- ✅ Validação de autorização ESP32
- ✅ Logs detalhados e debug mode

## Requisitos

- Node.js 18 ou superior
- Navegador Chromium (fornecido automaticamente pelo `whatsapp-web.js`)
- Acesso a uma câmera IP (opcional, para funcionalidade de snapshot)
- **Sharp** (biblioteca para otimização de imagens - instalada automaticamente via `npm install`)

## Configuração Rápida

1. **Instale as dependências:**
   ```bash
   npm install
   ```

2. **Configure as variáveis de ambiente:**
   ```bash
   cp .env.example .env
   # Edite .env com suas configurações
   ```

3. **Execute a aplicação:**
   ```bash
   npm start
   ```

4. **Escaneie o QR Code** exibido no terminal ou acesse `/qr.png` para autenticar o WhatsApp.

## Documentação Completa

Para documentação detalhada, consulte a pasta [`docs/`](docs/):

### Documentação Principal
- **[docs/API_DOCUMENTATION.md](docs/API_DOCUMENTATION.md)** - Documentação completa da API
- **[docs/SECURITY.md](docs/SECURITY.md)** - Medidas de segurança implementadas
- **[docs/WHATSAPP_OFFICIAL_API.md](docs/WHATSAPP_OFFICIAL_API.md)** - Configuração da API Oficial do WhatsApp
- **[docs/CONFIGURAR_WEBHOOK.md](docs/CONFIGURAR_WEBHOOK.md)** - Como configurar o webhook do WhatsApp

### Integrações
- **[docs/ESP32_VALIDATION.md](docs/ESP32_VALIDATION.md)** - Endpoint de validação ESP32
- **[docs/CAMERA_CONFIG.md](docs/CAMERA_CONFIG.md)** - Configuração de câmera IP
- **[docs/TUYA_INTEGRATION.md](docs/TUYA_INTEGRATION.md)** - Integração com API Tuya
- **[docs/TUYA_ENV_SETUP.md](docs/TUYA_ENV_SETUP.md)** - Configuração do Tuya
- **[docs/TUYA_TROUBLESHOOTING.md](docs/TUYA_TROUBLESHOOTING.md)** - Solução de problemas Tuya

### Testes e Troubleshooting
- **[docs/TESTE_ENVIO_RAPIDO.md](docs/TESTE_ENVIO_RAPIDO.md)** - Testes rápidos de envio
- **[docs/TESTAR_ENVIO_MENSAGENS.md](docs/TESTAR_ENVIO_MENSAGENS.md)** - Guia de testes
- **[docs/WHATSAPP_24H_WINDOW.md](docs/WHATSAPP_24H_WINDOW.md)** - Janela de 24h do WhatsApp

## Endpoints Principais

- `GET /health` - Verifica status da API e WhatsApp
- `GET /status` - Estado detalhado do WhatsApp
- `GET /qr.png` - QR Code para autenticação
- `POST /send` - Envia mensagem de texto
- `POST /trigger-snapshot` - **ESP32** - Envia snapshot de câmera
- `GET /esp32/validate` - **ESP32** - Valida autorização
- `GET /tuya/device/:deviceId/status` - **Tuya** - Consulta status de dispositivo
- `GET /tuya/devices` - **Tuya** - Lista dispositivos do usuário
- `POST /tuya/devices/status` - **Tuya** - Consulta status de múltiplos dispositivos

## Variáveis de Ambiente Principais

```bash
# API Básica
PORT=3000
API_TOKEN=seu_token_opcional
DEBUG=false

# Câmera IP
CAMERA_SNAPSHOT_URL=http://192.168.1.100/cgi-bin/snapshot.cgi?channel=1
CAMERA_USER=admin
CAMERA_PASS=senha
RECORD_DURATION_SEC=30       # Duração padrão de gravação de vídeo em segundos (padrão: 30)
MIN_SNAPSHOT_INTERVAL_MS=20000  # Intervalo mínimo entre snapshots em ms (padrão: 20000 = 20s)

# Gravação de Vídeo ao Tocar Campainha
ENABLE_VIDEO_RECORDING=true  # Habilitar gravação de vídeo ao tocar campainha (padrão: true)
VIDEO_RECORD_DURATION_SEC=15  # Duração do vídeo ao tocar campainha em segundos (padrão: 15)
MIN_VIDEO_RECORD_INTERVAL_MS=60000  # Intervalo mínimo entre gravações em ms (padrão: 60000 = 1 minuto)

# Otimização de Imagem (opcional)
MAX_IMAGE_SIZE_KB=500        # Tamanho máximo antes de comprimir (padrão: 500KB)
MAX_IMAGE_WIDTH=1920         # Largura máxima (padrão: 1920px)
MAX_IMAGE_HEIGHT=1080        # Altura máxima (padrão: 1080px)
JPEG_QUALITY=85              # Qualidade JPEG 1-100 (padrão: 85)

# Segurança ESP32
ESP32_TOKEN=token_secreto_esp32
ESP32_ALLOWED_IPS=192.168.1.100,192.168.1.0/24

# Tuya API (opcional)
TUYA_CLIENT_ID=seu_client_id
TUYA_CLIENT_SECRET=seu_client_secret
TUYA_REGION=us

# Números de telefone
NUMBERS_FILE=/opt/whatsapp-api/numbers.txt

# AbuseIPDB - Validação e Bloqueio Automático de IPs
ABUSEIPDB_ENABLED=true  # Habilitar validação AbuseIPDB (padrão: true)
ABUSEIPDB_API_KEY=seu_api_key_aqui  # Chave da API do AbuseIPDB (obtenha em https://www.abuseipdb.com/)
ABUSEIPDB_RECATEGORIZE_IPS=false  # Recategorizar todos os IPs na inicialização (padrão: false)
                                    # Use "true" para forçar reanálise e corrigir classificações incorretas

# Configurações de Listas AbuseIPDB
# IMPORTANTE: Os intervalos devem ser contíguos sem sobreposição
# WHITELIST: < WHITELIST_MAX_CONFIDENCE
# YELLOWLIST: >= WHITELIST_MAX_CONFIDENCE && < YELLOWLIST_MAX_CONFIDENCE
# BLACKLIST: >= BLACKLIST_MIN_CONFIDENCE
ABUSEIPDB_WHITELIST_MAX_CONFIDENCE=30  # Confiança máxima para whitelist em % (padrão: 30)
                                        # IPs com confiança < este valor vão para WHITELIST
ABUSEIPDB_WHITELIST_TTL_DAYS=7  # Tempo de vida da whitelist em dias (padrão: 7)
ABUSEIPDB_YELLOWLIST_MAX_CONFIDENCE=70  # Confiança máxima para yellowlist em % (padrão: 70)
                                         # IPs com confiança >= WHITELIST_MAX_CONFIDENCE e < este valor vão para YELLOWLIST
                                         # NOTA: YELLOWLIST_MIN_CONFIDENCE não é mais necessário (usa WHITELIST_MAX_CONFIDENCE)
ABUSEIPDB_YELLOWLIST_TTL_DAYS=3  # Tempo de vida da yellowlist em dias (padrão: 3)
ABUSEIPDB_BLACKLIST_MIN_CONFIDENCE=70  # Confiança mínima para blacklist em % (padrão: 70)
                                        # IPs com confiança >= este valor vão para BLACKLIST (permanente)
```

## Estrutura do Projeto

```
api-messeger/
├── src/
│   └── app.js              # Implementação principal
├── .env                     # Variáveis de ambiente (não versionado)
├── .env.example            # Exemplo de configuração
├── numbers.txt             # Números de telefone (não versionado)
├── numbers.txt.example     # Exemplo de números
├── package.json            # Dependências
├── README.md               # Este arquivo
└── API_DOCUMENTATION.md    # Documentação completa
```

## Segurança

- ⚠️ **Nunca commite** arquivos `.env` ou `numbers.txt`
- Use tokens fortes para `ESP32_TOKEN`
- Configure `ESP32_ALLOWED_IPS` para restringir acesso
- Use HTTPS em produção
- Mantenha `.wwebjs_auth` protegido

## Licença

Este projeto baseia-se no trabalho de [BenyFilho/whatsapp-web.js](https://github.com/BenyFilho/whatsapp-web.js) e nos termos da licença MIT.
