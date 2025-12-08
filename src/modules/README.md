# Módulos do Projeto

Este diretório contém os módulos modulares do projeto, organizados por funcionalidade.

## Estrutura

- **`tuya.js`** - Módulo Tuya API
  - Gerencia todas as operações relacionadas à API Tuya
  - Funções: autenticação, listagem de dispositivos, controle de dispositivos, formatação de mensagens
  
- **`camera.js`** - Módulo de Câmera
  - Gerencia operações relacionadas à câmera IP
  - Funções: download de snapshots, gravação RTSP, compressão de vídeo, otimização de imagens
  
- **`utils.js`** - Módulo de Utilitários
  - Funções auxiliares compartilhadas
  - Funções: logging, normalização de telefone, validação de números, geração de IDs

## Como Usar

### Inicializando os Módulos

```javascript
const { initLogger } = require('./modules/utils');
const { initTuyaModule } = require('./modules/tuya');
const { initCameraModule } = require('./modules/camera');

// Inicializa logger
const logger = initLogger({
  logPath: process.env.LOG_PATH || '/var/log/whatsapp-api.log',
  debug: process.env.DEBUG === 'true'
});

// Inicializa módulo Tuya
const tuya = initTuyaModule({
  clientId: process.env.TUYA_CLIENT_ID,
  clientSecret: process.env.TUYA_CLIENT_SECRET,
  region: process.env.TUYA_REGION,
  uid: process.env.TUYA_UID,
  logger
});

// Inicializa módulo Camera
const camera = initCameraModule({
  snapshotUrl: process.env.CAMERA_SNAPSHOT_URL,
  username: process.env.CAMERA_USER,
  password: process.env.CAMERA_PASS,
  rtspUrl: process.env.CAMERA_RTSP_URL,
  recordingsDir: process.env.RECORDINGS_DIR,
  recordDurationSec: parseInt(process.env.RECORD_DURATION_SEC || '30'),
  maxImageSizeKB: parseInt(process.env.MAX_IMAGE_SIZE_KB || '500'),
  maxImageWidth: parseInt(process.env.MAX_IMAGE_WIDTH || '1920'),
  maxImageHeight: parseInt(process.env.MAX_IMAGE_HEIGHT || '1080'),
  jpegQuality: parseInt(process.env.JPEG_QUALITY || '85'),
  maxVideoSizeMB: parseFloat(process.env.MAX_VIDEO_SIZE_MB || '8'),
  videoCRF: parseInt(process.env.VIDEO_CRF || '32'),
  logger
});
```

### Exemplo de Uso do Módulo Tuya

```javascript
// Listar dispositivos
const devices = await tuya.getCachedDevices();

// Obter status de um dispositivo
const status = await tuya.getDeviceStatus('device_id');

// Enviar comando
await tuya.sendCommand('device_id', [{ code: 'switch_led', value: true }]);

// Formatar mensagem de ajuda
const helpMsg = tuya.formatHelpMessage();
```

### Exemplo de Uso do Módulo Camera

```javascript
// Baixar snapshot
const { base64, mimeType } = await camera.downloadSnapshot();

// Gravar vídeo RTSP
const result = await camera.recordRTSPVideo(rtspUrl, 30, message);

// Comprimir vídeo se necessário
const compressedPath = await camera.compressVideoIfNeeded(videoPath, message);
```

## Benefícios da Modularização

1. **Organização**: Código separado por funcionalidade
2. **Manutenibilidade**: Mais fácil de encontrar e corrigir bugs
3. **Testabilidade**: Módulos podem ser testados independentemente
4. **Reutilização**: Módulos podem ser usados em outros projetos
5. **Escalabilidade**: Mais fácil adicionar novas funcionalidades

## Próximos Passos

Para completar a refatoração do `app.js`:

1. Importar os módulos no início do arquivo
2. Substituir as funções antigas pelas chamadas aos módulos
3. Manter apenas a lógica de endpoints e configuração do Express no `app.js`
4. Mover handlers de mensagens WhatsApp para um módulo separado (opcional)

