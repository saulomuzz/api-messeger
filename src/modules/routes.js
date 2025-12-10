/**
 * Módulo Routes
 * Gerencia todos os endpoints HTTP da API
 */

const QRCode = require('qrcode');
const { MessageMedia } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');

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
  tuyaUid,
  recordingsDir,
  strictRateLimit
}) {
  const { log, dbg, warn, err, nowISO } = logger;
  const { requestId, normalizeBR, readNumbersFromFile, getClientIp, isNumberAuthorized } = utils;
  
  // Sistema de gerenciamento de vídeos temporários (24 horas)
  const TEMP_VIDEOS_DIR = path.join(recordingsDir || path.join(__dirname, '..', '..', 'recordings'), 'temp_videos');
  const TEMP_VIDEOS_DB = path.join(TEMP_VIDEOS_DIR, 'videos_db.json');
  const VIDEO_EXPIRY_HOURS = 24;
  
  // Garante que o diretório existe
  if (!fs.existsSync(TEMP_VIDEOS_DIR)) {
    fs.mkdirSync(TEMP_VIDEOS_DIR, { recursive: true });
    log(`[TEMP-VIDEOS] Diretório criado: ${TEMP_VIDEOS_DIR}`);
  }
  
  // Carrega banco de dados de vídeos temporários
  function loadTempVideosDB() {
    try {
      if (fs.existsSync(TEMP_VIDEOS_DB)) {
        const data = fs.readFileSync(TEMP_VIDEOS_DB, 'utf8');
        return JSON.parse(data);
      }
    } catch (e) {
      warn(`[TEMP-VIDEOS] Erro ao carregar DB:`, e.message);
    }
    return {};
  }
  
  // Salva banco de dados de vídeos temporários
  function saveTempVideosDB(db) {
    try {
      fs.writeFileSync(TEMP_VIDEOS_DB, JSON.stringify(db, null, 2), 'utf8');
    } catch (e) {
      err(`[TEMP-VIDEOS] Erro ao salvar DB:`, e.message);
    }
  }
  
  // Limpa vídeos expirados
  function cleanupExpiredVideos() {
    const db = loadTempVideosDB();
    const now = Date.now();
    const expired = [];
    
    for (const [videoId, videoData] of Object.entries(db)) {
      if (now > videoData.expiresAt) {
        expired.push(videoId);
        // Remove arquivo
        if (videoData.filePath && fs.existsSync(videoData.filePath)) {
          try {
            fs.unlinkSync(videoData.filePath);
            log(`[TEMP-VIDEOS] Vídeo expirado removido: ${videoId}`);
          } catch (e) {
            warn(`[TEMP-VIDEOS] Erro ao remover vídeo expirado:`, e.message);
          }
        }
      }
    }
    
    if (expired.length > 0) {
      expired.forEach(id => delete db[id]);
      saveTempVideosDB(db);
      log(`[TEMP-VIDEOS] ${expired.length} vídeo(s) expirado(s) removido(s)`);
    }
  }
  
  // Registra vídeo temporário
  function registerTempVideo(filePath, phoneNumbers) {
    const videoId = `video_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const expiresAt = Date.now() + (VIDEO_EXPIRY_HOURS * 60 * 60 * 1000);
    
    const db = loadTempVideosDB();
    db[videoId] = {
      filePath,
      phoneNumbers: phoneNumbers.map(n => normalizeBR(n)),
      createdAt: Date.now(),
      expiresAt,
      expiresAtISO: new Date(expiresAt).toISOString()
    };
    saveTempVideosDB(db);
    
    log(`[TEMP-VIDEOS] Vídeo registrado: ${videoId} (expira em ${VIDEO_EXPIRY_HOURS}h)`);
    return videoId;
  }
  
  // Obtém vídeo temporário
  function getTempVideo(videoId) {
    cleanupExpiredVideos();
    const db = loadTempVideosDB();
    return db[videoId] || null;
  }
  
  // Lista todos os vídeos disponíveis (histórico)
  function listVideos(phoneNumber = null) {
    cleanupExpiredVideos();
    const db = loadTempVideosDB();
    const videos = [];
    
    for (const [videoId, videoData] of Object.entries(db)) {
      // Se phoneNumber fornecido, verifica se está autorizado
      if (phoneNumber) {
        const normalizedPhone = normalizeBR(phoneNumber);
        const isAuthorized = videoData.phoneNumbers.some(p => {
          const normalized = normalizeBR(p);
          return normalized === normalizedPhone || normalized.replace(/^\+/, '') === normalizedPhone.replace(/^\+/, '');
        });
        if (!isAuthorized) continue;
      }
      
      // Verifica se arquivo ainda existe
      const fileExists = videoData.filePath && fs.existsSync(videoData.filePath);
      
      videos.push({
        videoId,
        createdAt: videoData.createdAt,
        createdAtISO: new Date(videoData.createdAt).toISOString(),
        expiresAt: videoData.expiresAt,
        expiresAtISO: videoData.expiresAtISO,
        filePath: videoData.filePath,
        fileExists,
        phoneNumbers: videoData.phoneNumbers
      });
    }
    
    // Ordena por data de criação (mais recente primeiro)
    videos.sort((a, b) => b.createdAt - a.createdAt);
    
    return videos;
  }
  
  // Limpa vídeos expirados periodicamente (a cada hora)
  setInterval(() => {
    cleanupExpiredVideos();
  }, 60 * 60 * 1000);
  
  // Limpa na inicialização
  cleanupExpiredVideos();
  
  // Compatibilidade: API oficial não tem client da mesma forma
  const client = whatsapp.client || null;
  const getLastQR = whatsapp.getLastQR || (() => null);
  // Garante que getIsReady sempre retorna boolean (compatível com ESP32)
  const getIsReady = () => {
    const ready = whatsapp.isReady ? whatsapp.isReady() : true;
    return typeof ready === 'boolean' ? ready : true;
  };
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
  
  // Health check - compatível com ESP32
  app.get('/health', (_req, res) => {
    const isReady = getIsReady();
    const response = { 
      ok: true, 
      service: 'whatsapp-api', 
      ready: isReady, 
      ts: nowISO() 
    };
    // Garante que ready é boolean (não undefined)
    if (typeof response.ready !== 'boolean') {
      response.ready = true; // Default para true se não for boolean
    }
    log(`[HEALTH] Check solicitado | ready=${response.ready}`);
    res.json(response);
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
  app.post('/send', strictRateLimit || ((req, res, next) => next()), auth, async (req, res) => {
    const rid = requestId();
    const clientIp = getClientIp(req);
    
    // Validação de entrada
    if (!req.body) {
      warn(`[SECURITY][${rid}] Requisição sem body de ${clientIp}`);
      return res.status(400).json({ ok: false, error: 'invalid_request', message: 'Corpo da requisição inválido', requestId: rid });
    }
    
    // Verifica assinatura apenas se REQUIRE_SIGNED_REQUESTS=true
    // Se REQUIRE_SIGNED=false, a função verifySignedRequest retorna true automaticamente
    if (!verifySignedRequest(req, '/send')) {
      warn(`[SECURITY][${rid}] Assinatura inválida de ${clientIp}`);
      dbg(`[SEND][${rid}] Verificação de assinatura falhou. Configure REQUIRE_SIGNED_REQUESTS=false no .env para desabilitar`);
      return res.status(403).json({ ok: false, error: 'invalid signature', requestId: rid, hint: 'Set REQUIRE_SIGNED_REQUESTS=false to disable signature verification' });
    }
    
    if (!getIsReady()) {
      return res.status(503).json({ ok: false, error: 'whatsapp not ready', requestId: rid });
    }
    
    const { phone, message, subject } = req.body || {};
    if (!phone || !message) {
      warn(`[SECURITY][${rid}] Requisição com campos faltando de ${clientIp}`);
      return res.status(400).json({ ok: false, error: 'phone and message are required', requestId: rid });
    }
    
    // Validação de tamanho
    if (typeof message !== 'string' || message.length > 4096) {
      warn(`[SECURITY][${rid}] Mensagem muito longa de ${clientIp} (${message.length} caracteres)`);
      return res.status(400).json({ ok: false, error: 'invalid_request', message: 'Mensagem muito longa (máximo 4096 caracteres)', requestId: rid });
    }
    
    // Validação de formato de telefone básico
    const phoneStr = String(phone).replace(/\D/g, '');
    if (phoneStr.length < 10 || phoneStr.length > 15) {
      warn(`[SECURITY][${rid}] Formato de telefone inválido de ${clientIp}: ${phone}`);
      return res.status(400).json({ ok: false, error: 'invalid_request', message: 'Formato de telefone inválido', requestId: rid });
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
  
  // ESP32 Validate - compatível com ESP32 (não requer mudanças no código do ESP)
  app.get('/esp32/validate', (req, res) => {
    const validation = validateESP32Authorization(req);
    
    if (validation.authorized) {
      log(`[ESP32-VALIDATE] Autorizado | ip=${validation.ip}`);
      // Garante formato exato esperado pelo ESP32
      const response = {
        ok: true,
        authorized: true,
        message: 'ESP32 autorizado',
        ip: validation.ip,
        checks: validation.checks,
        timestamp: nowISO()
      };
      // Garante que authorized é boolean
      if (typeof response.authorized !== 'boolean') {
        response.authorized = true;
      }
      return res.json(response);
    } else {
      warn(`[ESP32-VALIDATE] Não autorizado | ip=${validation.ip} | reason=${validation.reason}`);
      // Garante formato exato esperado pelo ESP32
      const response = {
        ok: false,
        authorized: false,
        error: validation.reason,
        message: validation.checks[validation.reason === 'invalid_token' ? 'token' : 'ip'].message,
        ip: validation.ip,
        checks: validation.checks,
        timestamp: nowISO()
      };
      // Garante que authorized é boolean
      if (typeof response.authorized !== 'boolean') {
        response.authorized = false;
      }
      return res.status(401).json(response);
    }
  });
  
  // Trigger Snapshot
  app.post('/trigger-snapshot', strictRateLimit || ((req, res, next) => next()), (req, res, next) => {
    const validation = validateESP32Authorization(req);
    const rid = requestId();
    const clientIp = validation.ip;
    
    // Validação de tamanho do body
    if (req.body && JSON.stringify(req.body).length > 1024) {
      warn(`[SECURITY][${rid}] Body muito grande de ${clientIp}`);
      return res.status(400).json({ ok: false, error: 'invalid_request', message: 'Corpo da requisição muito grande', requestId: rid });
    }

    if (!validation.authorized) {
      warn(`[SECURITY][${rid}] Requisição não autorizada | ip=${clientIp} | reason=${validation.reason}`);
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
      
      // Grava vídeo de 15 segundos em background (não bloqueia o envio da foto)
      let videoIdPromise = Promise.resolve(null);
      if (camera && camera.buildRTSPUrl && camera.recordRTSPVideo) {
        const rtspUrl = camera.buildRTSPUrl();
        if (rtspUrl) {
          log(`[SNAPSHOT][${rid}] Iniciando gravação de vídeo de 15 segundos em background...`);
          videoIdPromise = (async () => {
            try {
              const fakeMessage = {
                from: 'system',
                reply: async () => {} // Não precisa responder durante gravação
              };
              
              const result = await camera.recordRTSPVideo(rtspUrl, 15, fakeMessage);
              
              if (result.success && result.filePath && fs.existsSync(result.filePath)) {
                // Comprime vídeo apenas se necessário (função já verifica tamanho)
                let finalVideoPath = result.filePath;
                try {
                  // compressVideoIfNeeded só comprime se o vídeo for maior que MAX_VIDEO_SIZE_MB
                  // Se não precisar comprimir, retorna o arquivo original sem modificar
                  finalVideoPath = await camera.compressVideoIfNeeded(result.filePath, fakeMessage);
                  log(`[SNAPSHOT][${rid}] Vídeo processado: ${finalVideoPath === result.filePath ? 'sem compressão (tamanho OK)' : 'comprimido'}`);
                } catch (compressError) {
                  warn(`[SNAPSHOT][${rid}] Erro ao processar vídeo:`, compressError.message);
                  // Continua com arquivo original se compressão falhar
                }
                
                // Registra vídeo temporário
                const phoneNumbers = validNumbers.map(n => n.normalized);
                const videoId = registerTempVideo(finalVideoPath, phoneNumbers);
                log(`[SNAPSHOT][${rid}] Vídeo gravado e registrado: ${videoId}`);
                return videoId;
              } else {
                warn(`[SNAPSHOT][${rid}] Falha na gravação de vídeo: ${result.error || 'Erro desconhecido'}`);
                return null;
              }
            } catch (videoError) {
              err(`[SNAPSHOT][${rid}] Erro ao gravar vídeo:`, videoError.message);
              return null;
            }
          })();
        }
      }
      
      const sendPromises = validNumbers.map(async ({ normalized, numberId, rawPhone }) => {
        try {
          const to = numberId._serialized;
          let r;
          
          // Verifica qual API está sendo usada
          if (whatsapp.sendMediaFromBase64) {
            // API Oficial do WhatsApp - usa base64 diretamente
            r = await whatsapp.sendMediaFromBase64(to, base64, mimeType, message);
          } else if (client && client.sendMessage) {
            // whatsapp-web.js - usa MessageMedia
            r = await client.sendMessage(to, media, { caption: message });
          } else {
            throw new Error('Nenhuma API WhatsApp configurada para envio de mídia');
          }
          
          log(`[SNAPSHOT OK][${rid}] Enviado para ${to} | id=${r.id?._serialized || r.messages?.[0]?.id || 'n/a'}`);
          
          // Envia mensagem perguntando se quer ver o vídeo (aguarda gravação terminar)
          videoIdPromise.then(async (videoId) => {
            if (!videoId) return; // Se não gravou vídeo, não envia mensagem
            
            try {
              // Aguarda um pouco para garantir que tudo está processado
              await new Promise(resolve => setTimeout(resolve, 500));
              
              if (whatsapp.sendInteractiveButtons) {
                // API Oficial - usa botões interativos
                await whatsapp.sendInteractiveButtons(
                  to,
                  '🎥 *Vídeo Gravado*\n\nFoi gravado um vídeo de 15 segundos da campainha.\n\nDeseja visualizar o vídeo? (Válido por 24 horas)',
                  [
                    { id: `view_video_${videoId}`, title: '👁️ Ver Vídeo' },
                    { id: 'skip_video', title: '⏭️ Pular' }
                  ],
                  'Campainha - Vídeo Temporário'
                );
              } else if (client && client.sendMessage) {
                // whatsapp-web.js - usa botões
                try {
                  const buttonMessage = {
                    text: '🎥 *Vídeo Gravado*\n\nFoi gravado um vídeo de 15 segundos da campainha.\n\nDeseja visualizar o vídeo? (Válido por 24 horas)',
                    buttons: [
                      { body: `👁️ Ver Vídeo (${videoId.substring(0, 8)}...)` },
                      { body: '⏭️ Pular' }
                    ],
                    footer: 'Campainha - Vídeo Temporário'
                  };
                  await client.sendMessage(to, buttonMessage);
                } catch (buttonError) {
                  // Fallback para texto
                  await client.sendMessage(to, `🎥 *Vídeo Gravado*\n\nFoi gravado um vídeo de 15 segundos.\n\nDigite: \`!video ${videoId}\` para ver o vídeo (válido por 24 horas)`);
                }
              }
              
              log(`[SNAPSHOT][${rid}] Mensagem de vídeo enviada para ${to} (videoId: ${videoId})`);
            } catch (videoMsgError) {
              warn(`[SNAPSHOT][${rid}] Erro ao enviar mensagem de vídeo:`, videoMsgError.message);
            }
          }).catch((error) => {
            warn(`[SNAPSHOT][${rid}] Erro ao processar vídeo:`, error.message);
          });
          
          return { phone: normalized, success: true, to, msgId: r.id?._serialized || r.messages?.[0]?.id || null };
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
      
      // Garante formato exato esperado pelo ESP32 - sempre retorna ok: true se a requisição foi processada
      // (mesmo que alguns envios tenham falhado, a requisição em si foi bem-sucedida)
      const response = {
        ok: true,
        requestId: rid,
        total: results.length,
        success: successCount,
        failed: results.length - successCount,
        results
      };
      // Garante que ok é boolean
      if (typeof response.ok !== 'boolean') {
        response.ok = true;
      }
      return res.json(response);
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
  
  // Função helper para processar vídeos temporários (exportada para uso externo)
  function processTempVideo(videoId, phoneNumber) {
    const videoData = getTempVideo(videoId);
    
    if (!videoData) {
      return { success: false, error: 'Vídeo não encontrado ou expirado' };
    }
    
    // Verifica se o número está autorizado para ver este vídeo
    // Agora permite que qualquer número autorizado veja qualquer vídeo
    const normalizedPhone = normalizeBR(phoneNumber);
    const isAuthorized = videoData.phoneNumbers.some(p => {
      const normalized = normalizeBR(p);
      return normalized === normalizedPhone || normalized.replace(/^\+/, '') === normalizedPhone.replace(/^\+/, '');
    });
    
    // Se não está na lista original, verifica se o número está autorizado no sistema
    if (!isAuthorized) {
      const authorizedNumbers = readNumbersFromFile(numbersFile || '');
      if (authorizedNumbers.length > 0) {
        // Se há números autorizados no sistema, verifica se o número atual está autorizado
        const isSystemAuthorized = isNumberAuthorized(phoneNumber, numbersFile || '', dbg);
        if (!isSystemAuthorized) {
          return { success: false, error: 'Você não está autorizado a ver este vídeo' };
        }
      } else {
        // Se não há lista de autorizados, permite acesso
        log(`[TEMP-VIDEOS] Número ${phoneNumber} autorizado (sem lista de restrição)`);
      }
    }
    
    // Verifica se o arquivo ainda existe
    if (!fs.existsSync(videoData.filePath)) {
      return { success: false, error: 'Arquivo de vídeo não encontrado' };
    }
    
    return {
      success: true,
      filePath: videoData.filePath,
      createdAt: videoData.createdAt,
      expiresAt: videoData.expiresAt
    };
  }
  
  return {
    processTempVideo,
    listVideos
  };
}

module.exports = { initRoutesModule };

