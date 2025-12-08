# Exemplo de Integração dos Módulos no app.js

Este documento mostra como integrar os módulos criados no `app.js` existente.

## Passo 1: Importar os Módulos

No início do `app.js`, após as importações existentes:

```javascript
// Importar módulos
const { initLogger, normalizeBR, toggleNineBR, requestId, readNumbersFromFile, isNumberAuthorized, getClientIp } = require('./modules/utils');
const { initTuyaModule } = require('./modules/tuya');
const { initCameraModule } = require('./modules/camera');
```

## Passo 2: Inicializar Logger

Substituir a seção de logging (linhas ~74-91) por:

```javascript
/* ===== logging ===== */
const logger = initLogger({
  logPath: LOG_PATH,
  debug: DEBUG
});
const { log, dbg, warn, err, nowISO } = logger;
```

## Passo 3: Inicializar Módulo Tuya

Substituir a seção Tuya (linhas ~61-72) e funções Tuya (linhas ~1783-2257) por:

```javascript
/* ===== Tuya API ===== */
const tuya = initTuyaModule({
  clientId: (process.env.TUYA_CLIENT_ID || '').trim(),
  clientSecret: (process.env.TUYA_CLIENT_SECRET || '').trim(),
  region: (process.env.TUYA_REGION || 'us').trim().toLowerCase(),
  uid: (process.env.TUYA_UID || '').trim(),
  logger
});
```

Depois, substituir todas as chamadas:
- `getTuyaAccessToken()` → `tuya.getAccessToken()`
- `getTuyaDeviceStatus(deviceId)` → `tuya.getDeviceStatus(deviceId)`
- `getTuyaDevices(uid)` → `tuya.getDevices(uid)`
- `sendTuyaCommand(deviceId, commands)` → `tuya.sendCommand(deviceId, commands)`
- `findSwitchCode(status)` → `tuya.findSwitchCode(status)`
- `getCachedTuyaDevices()` → `tuya.getCachedDevices()`
- `findDeviceByIdentifier(identifier, devices)` → `tuya.findDeviceByIdentifier(identifier, devices)`
- `formatDeviceStatusMessage(...)` → `tuya.formatDeviceStatusMessage(...)`
- `formatDevicesListMessage(...)` → `tuya.formatDevicesListMessage(...)`
- `formatTuyaHelpMessage()` → `tuya.formatHelpMessage()`

## Passo 4: Inicializar Módulo Camera

Substituir a seção de câmera e funções relacionadas (linhas ~991-1736) por:

```javascript
/* ===== Camera Module ===== */
const camera = initCameraModule({
  snapshotUrl: CAMERA_SNAPSHOT_URL,
  username: CAMERA_USER,
  password: CAMERA_PASS,
  rtspUrl: CAMERA_RTSP_URL,
  recordingsDir: RECORDINGS_DIR,
  recordDurationSec: RECORD_DURATION_SEC,
  maxImageSizeKB: MAX_IMAGE_SIZE_KB,
  maxImageWidth: MAX_IMAGE_WIDTH,
  maxImageHeight: MAX_IMAGE_HEIGHT,
  jpegQuality: JPEG_QUALITY,
  maxVideoSizeMB: MAX_VIDEO_SIZE_MB,
  videoCRF: VIDEO_CRF,
  logger
});
```

Depois, substituir todas as chamadas:
- `downloadSnapshot(url, username, password)` → `camera.downloadSnapshot(url)`
- `buildRTSPUrl()` → `camera.buildRTSPUrl()`
- `recordRTSPVideo(rtspUrl, duration, message)` → `camera.recordRTSPVideo(rtspUrl, duration, message)`
- `compressVideoIfNeeded(file, message)` → `camera.compressVideoIfNeeded(file, message)`
- `cleanupVideoFile(file, context)` → `camera.cleanupVideoFile(file, context)`

## Passo 5: Substituir Funções Utilitárias

Substituir as funções utilitárias (linhas ~287-315, ~1459-1781) pelas importadas do módulo:
- `digitsOnly()` → já importado
- `normalizeBR()` → já importado
- `toggleNineBR()` → já importado
- `requestId()` → já importado
- `readNumbersFromFile()` → já importado
- `isNumberAuthorized()` → já importado
- `ip(req)` → usar `getClientIp(req)`

## Passo 6: Remover Código Duplicado

Remover as seguintes seções do `app.js` (já estão nos módulos):
- Funções Tuya (linhas ~1783-2257)
- Funções de câmera (linhas ~991-1736)
- Funções utilitárias (linhas ~287-315, ~1459-1781)
- Configuração de logging (linhas ~74-91) - substituída pela inicialização do módulo
- Configuração de FFmpeg (linhas ~93-122) - movida para módulo camera

## Nota Importante

⚠️ **A refatoração completa deve ser feita gradualmente para evitar quebrar o código.**

Sugestão de ordem:
1. Primeiro, adicione os imports e inicialize os módulos
2. Teste se o código ainda funciona
3. Depois, substitua as funções uma por uma
4. Teste após cada substituição
5. Por fim, remova o código antigo

