/**
 * Módulo Routes
 * Gerencia todos os endpoints HTTP da API
 */

const QRCode = require('qrcode');
const { MessageMedia } = require('whatsapp-web.js');

/**
 * Inicializa o módulo Routes
 * @param {Object} config - Configuração do módulo
 * @param {Object} config.app - Instância do Express
 * @param {Object} config.whatsapp - Módulo WhatsApp
 * @param {Object} config.camera - Módulo Camera
 * @param {Object} config.tuya - Módulo Tuya
 * @param {Object} config.utils - Módulo Utils
 * @param {Object} config.logger - Objeto com funções de log
 * @param {Function} config.auth - Middleware de autenticação
 * @param {Function} config.verifySignedRequest - Função de verificação de assinatura
 * @param {Function} config.validateESP32Authorization - Função de validação ESP32
 * @param {string} config.numbersFile - Arquivo com números autorizados
 * @param {string} config.cameraSnapshotUrl - URL do snapshot da câmera
 * @param {string} config.authDataPath - Caminho dos dados de autenticação
 * @param {string} config.tuyaUid - UID padrão do Tuya
 * @returns {Object} API do módulo Routes
 */
function initRoutesModule({
  app,
  whatsapp,
  camera,
  tuya,
  utils,
  logger,
  auth,
  verifySignedRequest,
  validateESP32Authorization,
  numbersFile,
  cameraSnapshotUrl,
  authDataPath,
  tuyaUid
}) {
  const { log, dbg, warn, err, nowISO } = logger;
  const { requestId, normalizeBR, readNumbersFromFile, getClientIp } = utils;
  
  // Compatibilidade: API oficial não tem client da mesma forma
  const client = whatsapp.client || null;
  const getLastQR = whatsapp.getLastQR || (() => null);
  const getIsReady = whatsapp.isReady || (() => true);
  const resolveWhatsAppNumber = whatsapp.resolveWhatsAppNumber || (async (e164) => {
    const normalized = normalizeBR(e164);
    return { id: { _serialized: normalized.replace(/^\+/, '') }, tried: [normalized] };
  });
  
  // Função para enviar mensagem (compatível com ambas APIs)
  const sendMessage = async (to, message) => {
    if (whatsapp.sendTextMessage) {
      // API Oficial
      return await whatsapp.sendTextMessage(to, message);
    } else if (client) {
      // whatsapp-web.js
      return await client.sendMessage(to, message);
    }
    throw new Error('Nenhuma API WhatsApp configurada');
  };
  
  const ip = getClientIp;
  
  // Health check
  app.get('/health', (_req, res) => {
    res.json({ 
      ok: true, 
      service: 'whatsapp-web.js', 
      ready: getIsReady(), 
      ts: nowISO() 
    });
  });
  
  // Status
  app.get('/status', auth, async (_req, res) => {
    try {
      const state = await client.getState().catch(() => null);
      res.json({ 
        ok: true, 
        ready: getIsReady(), 
        state: state || 'unknown', 
        ts: nowISO() 
      });
    } catch (e) {
      err('status:', e);
      res.status(500).json({ 
        ok: false, 
        ready: false, 
        error: String(e) 
      });
    }
  });
  
  // QR Code PNG
  app.get('/qr.png', async (_req, res) => {
    const lastQR = getLastQR();
    if (!lastQR) {
      try {
        const state = await client.getState().catch(() => null);
        log(`[QR-API] QR não disponível. Estado: ${state}, isReady: ${getIsReady()}`);
        
        if (state === 'CONNECTED' || state === 'OPENING' || getIsReady()) {
          return res.status(200).send('Cliente já autenticado. Não é necessário QR code.');
        }
        
        if (state === 'UNPAIRED' || state === 'UNKNOWN') {
          log(`[QR-API] Estado ${state} - QR deve ser gerado em breve. Aguarde...`);
          return res.status(404).send('QR code ainda não foi gerado. Aguarde alguns segundos e tente novamente.');
        }
      } catch (e) {
        log(`[QR-API] Erro ao obter estado:`, e.message);
      }
      
      return res.status(404).send(`No QR available. Estado: ${getIsReady() ? 'ready' : 'not ready'}. Se já estava autenticado, limpe a pasta ${authDataPath} e reinicie.`);
    }
    
    try {
      const png = await QRCode.toBuffer(lastQR, { type: 'png', margin: 1, scale: 6 });
      res.setHeader('Content-Type', 'image/png');
      res.send(png);
      log(`[QR-API] QR code enviado com sucesso`);
    } catch (e) {
      err('[QR-API] Erro ao renderizar QR:', e);
      res.status(500).send('Failed to render QR');
    }
  });
  
  // QR Status
  app.get('/qr/status', async (_req, res) => {
    try {
      const state = await client.getState().catch(() => null);
      const hasQR = !!getLastQR();
      
      return res.json({
        ok: true,
        hasQR,
        isReady: getIsReady(),
        state: state || 'unknown',
        authPath: authDataPath,
        message: hasQR 
          ? 'QR code disponível. Acesse /qr.png para visualizar.'
          : (getIsReady() 
            ? 'Cliente já autenticado. Não é necessário QR code.'
            : 'QR code ainda não foi gerado. Aguarde alguns segundos.')
      });
    } catch (e) {
      err('[QR-STATUS] Erro:', e);
      return res.status(500).json({ ok: false, error: String(e) });
    }
  });
  
  // Send message
  app.post('/send', auth, async (req, res) => {
    const rid = requestId();
    // Verifica assinatura apenas se REQUIRE_SIGNED_REQUESTS=true
    // Se REQUIRE_SIGNED=false, a função verifySignedRequest retorna true automaticamente
    if (!verifySignedRequest(req, '/send')) {
      warn(`[SEND][${rid}] 403 invalid signature /send`);
      dbg(`[SEND][${rid}] Verificação de assinatura falhou. Configure REQUIRE_SIGNED_REQUESTS=false no .env para desabilitar`);
      return res.status(403).json({ ok: false, error: 'invalid signature', requestId: rid, hint: 'Set REQUIRE_SIGNED_REQUESTS=false to disable signature verification' });
    }
    if (!getIsReady()) {
      return res.status(503).json({ ok: false, error: 'whatsapp not ready', requestId: rid });
    }
    
    const { phone, message, subject } = req.body || {};
    if (!phone || !message) {
      return res.status(400).json({ ok: false, error: 'phone and message are required', requestId: rid });
    }
    
    const rawPhone = String(phone);
    const normalized = normalizeBR(rawPhone);
    log(`[SEND][${rid}] POST recebido | ip=${ip(req)} | raw_phone=${rawPhone} | normalized=${normalized}`);
    
    try {
      const { id: numberId, tried } = await resolveWhatsAppNumber(normalized);
      if (!numberId) {
        warn(`[SEND][${rid}] Número não está no WhatsApp | tried=${tried.join(',')}`);
        return res.status(404).json({ ok: false, error: 'not_on_whatsapp', requestId: rid, tried });
      }
      
      const to = numberId._serialized;
      const body = subject ? `*${String(subject).trim()}*\n\n${message}` : message;
      const r = await sendMessage(to, body);
      log(`[SEND OK][${rid}] to=${to} id=${r.id?._serialized || 'n/a'} tried=${tried.join(',')}`);
      return res.json({ ok: true, requestId: rid, to, msgId: r.id?._serialized || null, normalized, tried });
    } catch (e) {
      err(`[SEND][${rid}] ERRO`, e);
      return res.status(500).json({ ok: false, error: String(e), requestId: rid });
    }
  });
  
  // ESP32 Validate
  app.get('/esp32/validate', (req, res) => {
    const validation = validateESP32Authorization(req);
    
    if (validation.authorized) {
      log(`[ESP32-VALIDATE] Autorizado | ip=${validation.ip}`);
      return res.json({
        ok: true,
        authorized: true,
        message: 'ESP32 autorizado',
        ip: validation.ip,
        checks: validation.checks,
        timestamp: nowISO()
      });
    } else {
      warn(`[ESP32-VALIDATE] Não autorizado | ip=${validation.ip} | reason=${validation.reason}`);
      return res.status(401).json({
        ok: false,
        authorized: false,
        error: validation.reason,
        message: validation.checks[validation.reason === 'invalid_token' ? 'token' : 'ip'].message,
        ip: validation.ip,
        checks: validation.checks,
        timestamp: nowISO()
      });
    }
  });
  
  // Trigger Snapshot
  app.post('/trigger-snapshot', (req, res, next) => {
    const validation = validateESP32Authorization(req);
    
    if (!validation.authorized) {
      const rid = requestId();
      warn(`[SNAPSHOT][${rid}] Requisição não autorizada | ip=${validation.ip} | reason=${validation.reason}`);
      const statusCode = validation.reason === 'invalid_token' ? 401 : 403;
      return res.status(statusCode).json({
        ok: false,
        error: validation.reason,
        message: validation.checks[validation.reason === 'invalid_token' ? 'token' : 'ip'].message,
        requestId: rid
      });
    }
    
    next();
  }, async (req, res) => {
    const rid = requestId();
    log(`[SNAPSHOT][${rid}] Requisição recebida do ESP32 | ip=${ip(req)}`);
    
    if (!getIsReady()) {
      warn(`[SNAPSHOT][${rid}] WhatsApp não está pronto`);
      return res.status(503).json({ ok: false, error: 'whatsapp not ready', requestId: rid });
    }
    
    if (!cameraSnapshotUrl) {
      warn(`[SNAPSHOT][${rid}] CAMERA_SNAPSHOT_URL não configurada`);
      return res.status(500).json({ ok: false, error: 'camera not configured', requestId: rid });
    }
    
    try {
      const { base64, mimeType } = await camera.downloadSnapshot(cameraSnapshotUrl);
      
      const numbers = readNumbersFromFile(numbersFile);
      if (numbers.length === 0) {
        warn(`[SNAPSHOT][${rid}] Nenhum número encontrado no arquivo`);
        return res.status(400).json({ ok: false, error: 'no numbers found in file', requestId: rid });
      }
      
      const media = new MessageMedia(mimeType, base64, `snapshot_${Date.now()}.jpg`);
      const message = req.body?.message || '📸 Snapshot da câmera';
      
      log(`[SNAPSHOT][${rid}] Resolvendo ${numbers.length} número(s) em paralelo...`);
      const numberResolutions = await Promise.all(
        numbers.map(async (rawPhone) => {
          try {
            const normalized = normalizeBR(rawPhone);
            const { id: numberId, tried } = await resolveWhatsAppNumber(normalized);
            return { rawPhone, normalized, numberId, tried, error: null };
          } catch (e) {
            return { rawPhone, normalized: rawPhone, numberId: null, tried: [], error: String(e) };
          }
        })
      );
      
      const validNumbers = numberResolutions.filter(n => n.numberId !== null);
      const invalidNumbers = numberResolutions.filter(n => n.numberId === null);
      
      if (validNumbers.length === 0) {
        warn(`[SNAPSHOT][${rid}] Nenhum número válido encontrado`);
        return res.status(400).json({
          ok: false,
          error: 'no_valid_numbers',
          requestId: rid,
          results: invalidNumbers.map(n => ({
            phone: n.normalized,
            success: false,
            error: n.error || 'not_on_whatsapp',
            tried: n.tried
          }))
        });
      }
      
      log(`[SNAPSHOT][${rid}] ${validNumbers.length} número(s) válido(s), ${invalidNumbers.length} inválido(s)`);
      
      const sendPromises = validNumbers.map(async ({ normalized, numberId, rawPhone }) => {
        try {
          const to = numberId._serialized;
          const r = await client.sendMessage(to, media, { caption: message });
          log(`[SNAPSHOT OK][${rid}] Enviado para ${to} | id=${r.id?._serialized || 'n/a'}`);
          return { phone: normalized, success: true, to, msgId: r.id?._serialized || null };
        } catch (e) {
          err(`[SNAPSHOT][${rid}] Erro ao enviar para ${rawPhone}:`, e.message);
          return { phone: normalized, success: false, error: String(e) };
        }
      });
      
      const sendResults = await Promise.all(sendPromises);
      
      const results = [
        ...sendResults,
        ...invalidNumbers.map(n => ({
          phone: n.normalized,
          success: false,
          error: n.error || 'not_on_whatsapp',
          tried: n.tried
        }))
      ];
      
      const successCount = results.filter(r => r.success).length;
      log(`[SNAPSHOT][${rid}] Processo concluído: ${successCount}/${results.length} enviados com sucesso`);
      
      return res.json({
        ok: true,
        requestId: rid,
        total: results.length,
        success: successCount,
        failed: results.length - successCount,
        results
      });
    } catch (e) {
      err(`[SNAPSHOT][${rid}] ERRO`, e);
      return res.status(500).json({ ok: false, error: String(e), requestId: rid });
    }
  });
  
  // Tuya Devices
  app.get('/tuya/devices', auth, async (req, res) => {
    const rid = requestId();
    const { uid } = req.query;
    const targetUid = uid || tuyaUid;
    log(`[TUYA-DEVICES][${rid}] Listando dispositivos | ip=${ip(req)} | uid=${targetUid || 'não fornecido'}`);
    
    if (!targetUid) {
      return res.status(400).json({
        ok: false,
        error: 'UID não fornecido. Configure TUYA_UID no .env ou forneça via query: ?uid=seu_uid',
        requestId: rid,
        hint: 'Você pode configurar TUYA_UID no arquivo .env ou passar via query string: ?uid=seu_uid'
      });
    }
    
    try {
      const devices = await tuya.getDevices(targetUid);
      
      const devicesWithStatus = await Promise.all(devices.map(async (device) => {
        try {
          const status = await tuya.getDeviceStatus(device.id);
          
          const poweredOn = status.filter(s => {
            const code = s.code?.toLowerCase() || '';
            const value = s.value;
            if (code.includes('switch') || code.includes('power')) {
              return value === true || value === 1 || value === 'true' || value === 'on';
            }
            return false;
          });
          
          return {
            id: device.id,
            name: device.name,
            online: device.online || false,
            category: device.category,
            poweredOn: poweredOn.length > 0,
            poweredOnCount: poweredOn.length,
            status: status
          };
        } catch (e) {
          warn(`[TUYA-DEVICES][${rid}] Erro ao obter status do dispositivo ${device.id}:`, e.message);
          return {
            id: device.id,
            name: device.name,
            online: device.online || false,
            category: device.category,
            status: null,
            error: e.message
          };
        }
      }));
      
      const poweredOnDevices = devicesWithStatus.filter(d => d.poweredOn);
      log(`[TUYA-DEVICES][${rid}] ${devicesWithStatus.length} dispositivo(s) encontrado(s), ${poweredOnDevices.length} ligado(s)`);
      return res.json({
        ok: true,
        requestId: rid,
        total: devicesWithStatus.length,
        poweredOn: poweredOnDevices.length,
        devices: devicesWithStatus,
        timestamp: nowISO()
      });
    } catch (e) {
      err(`[TUYA-DEVICES][${rid}] ERRO`, e);
      const statusCode = e.response?.status || 500;
      return res.status(statusCode).json({
        ok: false,
        error: String(e),
        requestId: rid
      });
    }
  });
  
  // Tuya Device Status
  app.get('/tuya/device/:deviceId/status', auth, async (req, res) => {
    const rid = requestId();
    const { deviceId } = req.params;
    log(`[TUYA-STATUS][${rid}] Consultando status do dispositivo ${deviceId} | ip=${ip(req)}`);
    
    try {
      const status = await tuya.getDeviceStatus(deviceId);
      
      const poweredOn = status.filter(s => {
        const code = s.code?.toLowerCase() || '';
        const value = s.value;
        if (code.includes('switch') || code.includes('power')) {
          return value === true || value === 1 || value === 'true' || value === 'on';
        }
        return false;
      });
      
      log(`[TUYA-STATUS][${rid}] Status obtido: ${status.length} propriedade(s), ${poweredOn.length} ligado(s)`);
      return res.json({
        ok: true,
        requestId: rid,
        deviceId: deviceId,
        status: status,
        poweredOn: poweredOn.length > 0,
        poweredOnCount: poweredOn.length,
        timestamp: nowISO()
      });
    } catch (e) {
      err(`[TUYA-STATUS][${rid}] ERRO`, e);
      const statusCode = e.response?.status || 500;
      return res.status(statusCode).json({
        ok: false,
        error: String(e),
        requestId: rid,
        deviceId: deviceId
      });
    }
  });
  
  // Tuya Multiple Devices Status
  app.post('/tuya/devices/status', auth, async (req, res) => {
    const rid = requestId();
    const { deviceIds } = req.body || {};
    log(`[TUYA-MULTI-STATUS][${rid}] Consultando status de múltiplos dispositivos | ip=${ip(req)}`);
    
    if (!deviceIds || !Array.isArray(deviceIds) || deviceIds.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'Array deviceIds é necessário no corpo da requisição',
        requestId: rid
      });
    }
    
    try {
      const devicesStatus = [];
      
      for (const deviceId of deviceIds) {
        try {
          const status = await tuya.getDeviceStatus(deviceId);
          
          const poweredOn = status.filter(s => {
            const code = s.code?.toLowerCase() || '';
            const value = s.value;
            if (code.includes('switch') || code.includes('power')) {
              return value === true || value === 1 || value === 'true' || value === 'on';
            }
            return false;
          });
          
          devicesStatus.push({
            id: deviceId,
            poweredOn: poweredOn.length > 0,
            poweredOnCount: poweredOn.length,
            status: status
          });
        } catch (e) {
          warn(`[TUYA-MULTI-STATUS][${rid}] Erro ao obter status do dispositivo ${deviceId}:`, e.message);
          devicesStatus.push({
            id: deviceId,
            error: e.message
          });
        }
      }
      
      const poweredOnDevices = devicesStatus.filter(d => d.poweredOn && !d.error);
      log(`[TUYA-MULTI-STATUS][${rid}] ${poweredOnDevices.length}/${devicesStatus.length} dispositivo(s) ligado(s)`);
      
      return res.json({
        ok: true,
        requestId: rid,
        total: devicesStatus.length,
        poweredOn: poweredOnDevices.length,
        devices: devicesStatus,
        timestamp: nowISO()
      });
    } catch (e) {
      err(`[TUYA-MULTI-STATUS][${rid}] ERRO`, e);
      return res.status(500).json({
        ok: false,
        error: String(e),
        requestId: rid
      });
    }
  });
  
  // Tuya Device Command
  app.post('/tuya/device/:deviceId/command', auth, async (req, res) => {
    const rid = requestId();
    const { deviceId } = req.params;
    const { commands } = req.body || {};
    
    log(`[TUYA-COMMAND][${rid}] Enviando comando para dispositivo ${deviceId} | ip=${ip(req)}`);
    
    if (!commands || !Array.isArray(commands) || commands.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'Array de commands é obrigatório no corpo da requisição',
        requestId: rid,
        example: {
          commands: [
            { code: 'switch_led', value: true }
          ]
        }
      });
    }
    
    try {
      const result = await tuya.sendCommand(deviceId, commands);
      
      log(`[TUYA-COMMAND][${rid}] Comando enviado com sucesso para ${deviceId}`);
      return res.json({
        ok: true,
        requestId: rid,
        deviceId: deviceId,
        commands: commands,
        result: result,
        timestamp: nowISO()
      });
    } catch (e) {
      err(`[TUYA-COMMAND][${rid}] ERRO`, e);
      const statusCode = e.response?.status || 500;
      return res.status(statusCode).json({
        ok: false,
        error: String(e),
        requestId: rid,
        deviceId: deviceId
      });
    }
  });
  
  return {};
}

module.exports = { initRoutesModule };

