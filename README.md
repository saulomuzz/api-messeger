# API Messenger

API REST para integração com o WhatsApp utilizando [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js), com suporte para envio de snapshots de câmera IP via ESP32.

## Características

- ✅ Envio de mensagens de texto via WhatsApp
- ✅ Envio de snapshots de câmera IP (via ESP32)
- ✅ **Otimização automática de imagens** (compressão e redimensionamento)
- ✅ **Envio paralelo** para múltiplos números (mais rápido)
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

Para documentação detalhada, consulte:

- **[API_DOCUMENTATION.md](API_DOCUMENTATION.md)** - Documentação completa da API
- **[ESP32_VALIDATION.md](ESP32_VALIDATION.md)** - Endpoint de validação ESP32
- **[CAMERA_CONFIG.md](CAMERA_CONFIG.md)** - Configuração de câmera IP
- **[TEST_CURL.md](TEST_CURL.md)** - Exemplos de teste com curl

## Endpoints Principais

- `GET /health` - Verifica status da API e WhatsApp
- `GET /status` - Estado detalhado do WhatsApp
- `GET /qr.png` - QR Code para autenticação
- `POST /send` - Envia mensagem de texto
- `POST /trigger-snapshot` - **ESP32** - Envia snapshot de câmera
- `GET /esp32/validate` - **ESP32** - Valida autorização

## Variáveis de Ambiente Principais

```bash
# API Básica
PORT=3000
API_TOKEN=seu_token_opcional
DEBUG=false

# Câmera IP
CAMERA_SNAPSHOT_URL=http://10.10.0.240/cgi-bin/snapshot.cgi?channel=1
CAMERA_USER=admin
CAMERA_PASS=senha

# Otimização de Imagem (opcional)
MAX_IMAGE_SIZE_KB=500        # Tamanho máximo antes de comprimir (padrão: 500KB)
MAX_IMAGE_WIDTH=1920         # Largura máxima (padrão: 1920px)
MAX_IMAGE_HEIGHT=1080        # Altura máxima (padrão: 1080px)
JPEG_QUALITY=85              # Qualidade JPEG 1-100 (padrão: 85)

# Segurança ESP32
ESP32_TOKEN=token_secreto_esp32
ESP32_ALLOWED_IPS=10.10.0.4,10.10.0.0/24

# Números de telefone
NUMBERS_FILE=/opt/whatsapp-api/numbers.txt
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
