/**
 * Módulo Routes
 * Gerencia todos os endpoints HTTP da API
 */

const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

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
 * @param {number} config.minSnapshotIntervalMs - Intervalo mínimo entre snapshots em ms
 * @param {boolean} config.enableVideoRecording - Habilitar gravação de vídeo
 * @param {number} config.videoRecordDurationSec - Duração do vídeo ao tocar campainha
 * @param {number} config.minVideoRecordIntervalMs - Intervalo mínimo entre gravações em ms
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
  minSnapshotIntervalMs = 20000,
  enableVideoRecording = true,
  videoRecordDurationSec = 15,
  minVideoRecordIntervalMs = 60000,
  strictRateLimit
}) {
  const { log, dbg, warn, err, nowISO } = logger;
  const { requestId, normalizeBR, readNumbersFromFile, getClientIp, isNumberAuthorized } = utils;
  
  // Sistema de bloqueio para evitar múltiplas gravações simultâneas
  let isRecordingVideo = false;
  let lastSnapshotTime = 0;
  let lastVideoRecordTime = 0;
  const MIN_SNAPSHOT_INTERVAL_MS = minSnapshotIntervalMs; // Configurável via .env
  const ENABLE_VIDEO_RECORDING = enableVideoRecording; // Configurável via .env
  const VIDEO_RECORD_DURATION_SEC = videoRecordDurationSec; // Configurável via .env
  const MIN_VIDEO_RECORD_INTERVAL_MS = minVideoRecordIntervalMs; // Configurável via .env
  
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
    
    // Se phoneNumber fornecido, verifica se está autorizado no sistema
    let isSystemAuthorized = true;
    if (phoneNumber) {
      const authorizedNumbers = readNumbersFromFile(numbersFile || '');
      if (authorizedNumbers.length > 0) {
        isSystemAuthorized = isNumberAuthorized(phoneNumber, numbersFile || '', dbg);
      }
    }
    
    for (const [videoId, videoData] of Object.entries(db)) {
      // Se o número está autorizado no sistema, mostra todos os vídeos
      // Caso contrário, mostra apenas os vídeos enviados para ele
      if (phoneNumber && !isSystemAuthorized) {
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
  
  // API oficial não usa client (usa HTTP direto)
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
  
  // Função para enviar mensagem (API Oficial)
  const sendMessage = async (to, message) => {
    if (whatsapp.sendTextMessage) {
      return await whatsapp.sendTextMessage(to, message);
    }
    throw new Error('API WhatsApp não configurada');
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
      res.json({ 
        ok: true, 
        ready: getIsReady(), 
        state: 'CONNECTED', // API oficial sempre está conectada
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
  
  // QR Code PNG (não aplicável para API oficial - sempre retorna que está conectado)
  app.get('/qr.png', async (_req, res) => {
    res.status(200).send('API Oficial do WhatsApp não requer QR code. Cliente sempre autenticado.');
  });
  
  // QR Status (não aplicável para API oficial)
  app.get('/qr/status', async (_req, res) => {
    try {
      return res.json({
        ok: true,
        hasQR: false,
        isReady: getIsReady(),
        state: 'CONNECTED', // API oficial sempre está conectada
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
  
  // OTA (Over-The-Air) - Upload de firmware
  const otaStorage = multer.diskStorage({
    destination: (req, file, cb) => {
      const otaDir = path.join(recordingsDir || path.join(__dirname, '..', '..', 'recordings'), 'ota');
      if (!fs.existsSync(otaDir)) {
        fs.mkdirSync(otaDir, { recursive: true });
      }
      cb(null, otaDir);
    },
    filename: (req, file, cb) => {
      // Nome do arquivo: firmware_YYYYMMDD_HHMMSS.bin
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').substring(0, 19);
      cb(null, `firmware_${timestamp}.bin`);
    }
  });
  
  const otaUpload = multer({
    storage: otaStorage,
    limits: {
      fileSize: 2 * 1024 * 1024 // 2MB máximo
    },
    fileFilter: (req, file, cb) => {
      // Aceita apenas arquivos .bin
      if (file.mimetype === 'application/octet-stream' || file.originalname.endsWith('.bin')) {
        cb(null, true);
      } else {
        cb(new Error('Apenas arquivos .bin são permitidos'), false);
      }
    }
  });
  
  app.post('/esp32/ota', auth, otaUpload.single('firmware'), (req, res) => {
    const rid = requestId();
    const clientIp = ip(req);
    
    if (!req.file) {
      warn(`[OTA][${rid}] Upload sem arquivo | ip=${clientIp}`);
      return res.status(400).json({
        ok: false,
        error: 'no_file',
        message: 'Nenhum arquivo enviado',
        requestId: rid
      });
    }
    
    log(`[OTA][${rid}] Firmware recebido | ip=${clientIp} | tamanho=${req.file.size} bytes | arquivo=${req.file.filename}`);
    
    // Retorna informações do firmware para o ESP32 baixar
    const firmwareUrl = `${req.protocol}://${req.get('host')}/esp32/ota/download/${path.basename(req.file.filename)}`;
    
    res.json({
      ok: true,
      message: 'Firmware recebido com sucesso',
      firmware: {
        filename: req.file.filename,
        size: req.file.size,
        url: firmwareUrl,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24 horas
      },
      requestId: rid
    });
  });
  
  // Verifica se há atualização OTA disponível
  app.get('/esp32/ota/check', (req, res) => {
    const rid = requestId();
    const clientIp = ip(req);
    const currentVersion = req.query.version || req.headers['x-firmware-version'] || null;
    
    const otaDir = path.join(recordingsDir || path.join(__dirname, '..', '..', 'recordings'), 'ota');
    
    // Verifica se o diretório existe
    if (!fs.existsSync(otaDir)) {
      dbg(`[OTA][${rid}] Diretório OTA não existe | ip=${clientIp}`);
      return res.json({
        ok: true,
        updateAvailable: false,
        message: 'Nenhuma atualização disponível',
        requestId: rid
      });
    }
    
    // Lista todos os arquivos .bin no diretório OTA
    const files = fs.readdirSync(otaDir)
      .filter(file => file.endsWith('.bin'))
      .map(file => {
        const filePath = path.join(otaDir, file);
        const stats = fs.statSync(filePath);
        return {
          filename: file,
          size: stats.size,
          modified: stats.mtime,
          path: filePath
        };
      })
      .sort((a, b) => b.modified - a.modified); // Mais recente primeiro
    
    if (files.length === 0) {
      dbg(`[OTA][${rid}] Nenhum firmware disponível | ip=${clientIp}`);
      return res.json({
        ok: true,
        updateAvailable: false,
        message: 'Nenhuma atualização disponível',
        requestId: rid
      });
    }
    
    // Pega o firmware mais recente
    const latestFirmware = files[0];
    const firmwareUrl = `${req.protocol}://${req.get('host')}/esp32/ota/download/${latestFirmware.filename}`;
    
    log(`[OTA][${rid}] Verificação de atualização | ip=${clientIp} | versão atual=${currentVersion || 'desconhecida'} | firmware disponível=${latestFirmware.filename}`);
    
    res.json({
      ok: true,
      updateAvailable: true,
      firmware: {
        filename: latestFirmware.filename,
        size: latestFirmware.size,
        url: firmwareUrl,
        modified: latestFirmware.modified.toISOString()
      },
      requestId: rid
    });
  });
  
  // Download de firmware OTA
  app.get('/esp32/ota/download/:filename', (req, res) => {
    const { filename } = req.params;
    const rid = requestId();
    const clientIp = ip(req);
    
    // Validação básica de segurança (apenas .bin)
    if (!filename.endsWith('.bin') || filename.includes('..') || filename.includes('/')) {
      warn(`[OTA][${rid}] Tentativa de download inválido | ip=${clientIp} | filename=${filename}`);
      return res.status(400).json({
        ok: false,
        error: 'invalid_filename',
        message: 'Nome de arquivo inválido',
        requestId: rid
      });
    }
    
    const otaDir = path.join(recordingsDir || path.join(__dirname, '..', '..', 'recordings'), 'ota');
    const filePath = path.join(otaDir, filename);
    
    if (!fs.existsSync(filePath)) {
      warn(`[OTA][${rid}] Arquivo não encontrado | ip=${clientIp} | filename=${filename}`);
      return res.status(404).json({
        ok: false,
        error: 'file_not_found',
        message: 'Arquivo não encontrado',
        requestId: rid
      });
    }
    
    log(`[OTA][${rid}] Download de firmware | ip=${clientIp} | filename=${filename}`);
    
    res.download(filePath, filename, (err) => {
      if (err) {
        err(`[OTA][${rid}] Erro ao enviar arquivo:`, err.message);
        if (!res.headersSent) {
          res.status(500).json({
            ok: false,
            error: 'download_failed',
            message: 'Erro ao baixar arquivo',
            requestId: rid
          });
        }
      }
    });
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
    
    // Verifica cooldown no servidor (proteção adicional)
    const now = Date.now();
    const timeSinceLastSnapshot = now - lastSnapshotTime;
    if (timeSinceLastSnapshot < MIN_SNAPSHOT_INTERVAL_MS) {
      const secondsRemaining = Math.ceil((MIN_SNAPSHOT_INTERVAL_MS - timeSinceLastSnapshot) / 1000);
      warn(`[SNAPSHOT][${rid}] Cooldown ativo no servidor: ${secondsRemaining}s restantes`);
      return res.status(429).json({ 
        ok: false, 
        error: 'cooldown_active', 
        message: `Aguarde ${secondsRemaining} segundos antes de enviar novamente`,
        retryAfter: secondsRemaining,
        requestId: rid 
      });
    }
    
    // Verifica se já há uma gravação em andamento
    if (isRecordingVideo) {
      warn(`[SNAPSHOT][${rid}] Gravação de vídeo já em andamento, ignorando nova requisição`);
      return res.status(429).json({ 
        ok: false, 
        error: 'recording_in_progress', 
        message: 'Já existe uma gravação de vídeo em andamento. Aguarde a conclusão.',
        requestId: rid 
      });
    }
    
    if (!getIsReady()) {
      warn(`[SNAPSHOT][${rid}] WhatsApp não está pronto`);
      return res.status(503).json({ ok: false, error: 'whatsapp not ready', requestId: rid });
    }
    
    if (!cameraSnapshotUrl) {
      warn(`[SNAPSHOT][${rid}] CAMERA_SNAPSHOT_URL não configurada`);
      return res.status(500).json({ ok: false, error: 'camera not configured', requestId: rid });
    }
    
    // Atualiza timestamp do último snapshot
    lastSnapshotTime = now;
    
    try {
      // Lê números primeiro (mais rápido que baixar snapshot)
      const numbers = readNumbersFromFile(numbersFile);
      if (numbers.length === 0) {
        warn(`[SNAPSHOT][${rid}] Nenhum número encontrado no arquivo`);
        return res.status(400).json({ ok: false, error: 'no numbers found in file', requestId: rid });
      }
      
      // Inicia download do snapshot e resolução de números em paralelo para otimizar tempo
      log(`[SNAPSHOT][${rid}] Baixando snapshot e resolvendo ${numbers.length} número(s) em paralelo...`);
      const [snapshotResult, ...numberResolutions] = await Promise.all([
        camera.downloadSnapshot(cameraSnapshotUrl),
        ...numbers.map(async (rawPhone) => {
          try {
            const normalized = normalizeBR(rawPhone);
            dbg(`[SNAPSHOT][${rid}] Resolvendo número: ${rawPhone} -> ${normalized}`);
            const { id: numberId, tried } = await resolveWhatsAppNumber(normalized);
            dbg(`[SNAPSHOT][${rid}] Resultado para ${normalized}: numberId=${numberId ? 'encontrado' : 'null'}, tried=${tried?.length || 0}`);
            return { rawPhone, normalized, numberId, tried, error: null };
          } catch (e) {
            warn(`[SNAPSHOT][${rid}] Erro ao resolver ${rawPhone}: ${e.message}`);
            return { rawPhone, normalized: rawPhone, numberId: null, tried: [], error: String(e) };
          }
        })
      ]);
      
      const { base64, mimeType } = snapshotResult;
      const message = req.body?.message || '📸 Snapshot da câmera';
      
      const validNumbers = numberResolutions.filter(n => n.numberId !== null);
      const invalidNumbers = numberResolutions.filter(n => n.numberId === null);
      
      dbg(`[SNAPSHOT][${rid}] Resolução completa: ${validNumbers.length} válidos, ${invalidNumbers.length} inválidos`);
      invalidNumbers.forEach(n => {
        warn(`[SNAPSHOT][${rid}] Número inválido: ${n.normalized} - erro: ${n.error || 'not_on_whatsapp'}`);
      });
      
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
      
      // Para API oficial: faz upload uma vez e reutiliza media ID (mais rápido)
      let mediaId = null;
      if (whatsapp && whatsapp.uploadMedia) {
        try {
          log(`[SNAPSHOT][${rid}] Fazendo upload de mídia uma vez para reutilizar...`);
          mediaId = await whatsapp.uploadMedia(base64, mimeType);
          log(`[SNAPSHOT][${rid}] Upload concluído, media ID: ${mediaId}`);
        } catch (uploadError) {
          warn(`[SNAPSHOT][${rid}] Erro no upload, usando método direto:`, uploadError.message);
        }
      }
      
      // Grava vídeo em background (não bloqueia o envio da foto)
      let videoIdPromise = Promise.resolve(null);
      if (ENABLE_VIDEO_RECORDING && camera && camera.buildRTSPUrl && camera.recordRTSPVideo) {
        const rtspUrl = camera.buildRTSPUrl();
        if (rtspUrl) {
          // Verifica intervalo mínimo entre gravações
          const now = Date.now();
          const timeSinceLastVideo = now - lastVideoRecordTime;
          
          if (timeSinceLastVideo < MIN_VIDEO_RECORD_INTERVAL_MS) {
            const secondsRemaining = Math.ceil((MIN_VIDEO_RECORD_INTERVAL_MS - timeSinceLastVideo) / 1000);
            log(`[SNAPSHOT][${rid}] Gravação de vídeo ignorada - cooldown ativo (${secondsRemaining}s restantes)`);
            } else {
              // Verifica se já está gravando
              if (isRecordingVideo) {
                log(`[SNAPSHOT][${rid}] Gravação de vídeo ignorada - já existe uma gravação em andamento`);
              } else {
                // Marca que está gravando para evitar múltiplas gravações simultâneas
                isRecordingVideo = true;
                // NÃO atualiza lastVideoRecordTime aqui - será atualizado quando a gravação terminar
                log(`[SNAPSHOT][${rid}] Iniciando gravação de vídeo de ${VIDEO_RECORD_DURATION_SEC} segundos em background...`);
                log(`[SNAPSHOT][${rid}] Última gravação: ${lastVideoRecordTime > 0 ? new Date(lastVideoRecordTime).toISOString() : 'nunca'} (${Math.floor((now - lastVideoRecordTime) / 1000)}s atrás)`);
              videoIdPromise = (async () => {
                try {
                  const fakeMessage = {
                    from: 'system',
                    reply: async () => {} // Não precisa responder durante gravação
                  };
                  
                  const result = await camera.recordRTSPVideo(rtspUrl, VIDEO_RECORD_DURATION_SEC, fakeMessage);
              
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
                
                // Atualiza timestamp APÓS gravação terminar (não quando inicia)
                lastVideoRecordTime = Date.now();
                log(`[SNAPSHOT][${rid}] Timestamp de gravação atualizado: ${new Date(lastVideoRecordTime).toISOString()}`);
                
                return videoId;
              } else {
                warn(`[SNAPSHOT][${rid}] Falha na gravação de vídeo: ${result.error || 'Erro desconhecido'}`);
                // Atualiza timestamp mesmo em caso de falha para evitar tentativas muito frequentes
                lastVideoRecordTime = Date.now();
                return null;
              }
            } catch (videoError) {
              err(`[SNAPSHOT][${rid}] Erro ao gravar vídeo:`, videoError.message);
              // Atualiza timestamp mesmo em caso de erro para evitar tentativas muito frequentes
              lastVideoRecordTime = Date.now();
              return null;
            } finally {
              // Libera o bloqueio de gravação após conclusão (sucesso ou erro)
              // Timeout de segurança: libera após duração + margem mesmo se houver problema
              const timeoutMs = (VIDEO_RECORD_DURATION_SEC + 10) * 1000;
              setTimeout(() => {
                if (isRecordingVideo) {
                  warn(`[SNAPSHOT][${rid}] Timeout de segurança: liberando bloqueio de gravação`);
                  isRecordingVideo = false;
                }
              }, timeoutMs);
              
              isRecordingVideo = false;
              log(`[SNAPSHOT][${rid}] Bloqueio de gravação liberado`);
            }
          })();
            }
          }
        } else {
          // Se não há RTSP URL, não marca como gravando
          log(`[SNAPSHOT][${rid}] RTSP URL não disponível, pulando gravação de vídeo`);
        }
      } else if (!ENABLE_VIDEO_RECORDING) {
        log(`[SNAPSHOT][${rid}] Gravação de vídeo desabilitada (ENABLE_VIDEO_RECORDING=false)`);
      }
      
      // Envia para todos os números em paralelo para máxima velocidade
      const sendPromises = validNumbers.map(async ({ normalized, numberId, rawPhone }) => {
        try {
          const to = numberId._serialized;
          let r;
          
          // Usa API Oficial do WhatsApp
          if (whatsapp.sendMediaById && mediaId) {
            // Usa media ID (mais rápido, upload já feito)
            r = await whatsapp.sendMediaById(to, mediaId, 'image', message);
          } else if (whatsapp.sendMediaFromBase64) {
            // Fallback: usa base64 diretamente
            r = await whatsapp.sendMediaFromBase64(to, base64, mimeType, message);
          } else {
            throw new Error('API WhatsApp não configurada para envio de mídia');
          }
          
          log(`[SNAPSHOT OK][${rid}] Enviado para ${to} | id=${r.id?._serialized || r.messages?.[0]?.id || 'n/a'}`);
          
          // Envia mensagem perguntando se quer ver o vídeo (aguarda gravação terminar em background)
          // Não bloqueia o retorno da requisição
          videoIdPromise.then(async (videoId) => {
            if (!videoId) {
              log(`[SNAPSHOT][${rid}] Nenhum vídeo gravado, não enviando mensagem de vídeo para ${to}`);
              return; // Se não gravou vídeo, não envia mensagem
            }
            
            log(`[SNAPSHOT][${rid}] Vídeo gravado (ID: ${videoId}), enviando mensagem para ${to}...`);
            
            try {
              // Aguarda um pouco para garantir que tudo está processado
              await new Promise(resolve => setTimeout(resolve, 1000));
              
              if (whatsapp.sendInteractiveButtons) {
                // API Oficial - usa botões interativos
                log(`[SNAPSHOT][${rid}] Enviando botões interativos para ${to}...`);
                try {
                  await whatsapp.sendInteractiveButtons(
                    to,
                    `🎥 *Vídeo Gravado*\n\nFoi gravado um vídeo de ${VIDEO_RECORD_DURATION_SEC} segundos da campainha.\n\nDeseja visualizar o vídeo? (Válido por 24 horas)`,
                    [
                      { id: `view_video_${videoId}`, title: '👁️ Ver Vídeo' },
                      { id: 'skip_video', title: '⏭️ Pular' }
                    ],
                    'Campainha - Vídeo Temporário'
                  );
                  log(`[SNAPSHOT][${rid}] ✅ Botões interativos enviados com sucesso para ${to}`);
                } catch (buttonError) {
                  err(`[SNAPSHOT][${rid}] ❌ Erro ao enviar botões interativos:`, buttonError.message);
                  // Tenta fallback para texto
                  try {
                    await whatsapp.sendTextMessage(to, `🎥 *Vídeo Gravado*\n\nFoi gravado um vídeo de ${VIDEO_RECORD_DURATION_SEC} segundos.\n\nDigite: \`!video ${videoId}\` para ver o vídeo (válido por 24 horas)`);
                    log(`[SNAPSHOT][${rid}] ✅ Mensagem de texto enviada como fallback para ${to}`);
                  } catch (textError) {
                    err(`[SNAPSHOT][${rid}] ❌ Erro ao enviar mensagem de texto:`, textError.message);
                  }
                }
              } else {
                warn(`[SNAPSHOT][${rid}] Nenhum método de envio disponível para mensagem de vídeo`);
              }
            } catch (videoMsgError) {
              err(`[SNAPSHOT][${rid}] ❌ Erro geral ao enviar mensagem de vídeo para ${to}:`, videoMsgError.message);
              err(`[SNAPSHOT][${rid}] Stack:`, videoMsgError.stack);
            }
          }).catch((error) => {
            err(`[SNAPSHOT][${rid}] ❌ Erro ao processar promise de vídeo:`, error.message);
            err(`[SNAPSHOT][${rid}] Stack:`, error.stack);
          });
          
          return { phone: normalized, success: true, to, msgId: r.id?._serialized || r.messages?.[0]?.id || null };
        } catch (e) {
          err(`[SNAPSHOT][${rid}] Erro ao enviar para ${rawPhone}:`, e.message);
          return { phone: normalized, success: false, error: String(e) };
        }
      });
      
      // Aguarda todos os envios em paralelo (máxima velocidade)
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
      // Garante que o bloqueio seja liberado mesmo em caso de erro
      if (isRecordingVideo) {
        isRecordingVideo = false;
        warn(`[SNAPSHOT][${rid}] Bloqueio de gravação liberado após erro`);
      }
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
    dbg(`[TEMP-VIDEOS] Processando vídeo ${videoId} para ${phoneNumber}`);
    
    // Limpa vídeos expirados antes de buscar
    cleanupExpiredVideos();
    
    const videoData = getTempVideo(videoId);
    
    if (!videoData) {
      warn(`[TEMP-VIDEOS] Vídeo ${videoId} não encontrado no banco de dados`);
      return { success: false, error: 'Vídeo não encontrado ou expirado' };
    }
    
    dbg(`[TEMP-VIDEOS] Vídeo encontrado: ${videoId}, caminho: ${videoData.filePath}`);
    
    // Verifica se o número está autorizado para ver este vídeo
    // Agora permite que qualquer número autorizado veja qualquer vídeo
    const normalizedPhone = normalizeBR(phoneNumber);
    dbg(`[TEMP-VIDEOS] Número normalizado: ${normalizedPhone}`);
    
    const isAuthorized = videoData.phoneNumbers.some(p => {
      const normalized = normalizeBR(p);
      const matches = normalized === normalizedPhone || normalized.replace(/^\+/, '') === normalizedPhone.replace(/^\+/, '');
      if (matches) {
        dbg(`[TEMP-VIDEOS] Número autorizado na lista original: ${normalized}`);
      }
      return matches;
    });
    
    // Se não está na lista original, verifica se o número está autorizado no sistema
    if (!isAuthorized) {
      const authorizedNumbers = readNumbersFromFile(numbersFile || '');
      if (authorizedNumbers.length > 0) {
        // Se há números autorizados no sistema, verifica se o número atual está autorizado
        const isSystemAuthorized = isNumberAuthorized(phoneNumber, numbersFile || '', dbg);
        if (!isSystemAuthorized) {
          warn(`[TEMP-VIDEOS] Número ${phoneNumber} não autorizado no sistema`);
          return { success: false, error: 'Você não está autorizado a ver este vídeo' };
        }
        log(`[TEMP-VIDEOS] Número ${phoneNumber} autorizado no sistema (não estava na lista original)`);
      } else {
        // Se não há lista de autorizados, permite acesso
        log(`[TEMP-VIDEOS] Número ${phoneNumber} autorizado (sem lista de restrição)`);
      }
    } else {
      log(`[TEMP-VIDEOS] Número ${phoneNumber} autorizado na lista original do vídeo`);
    }
    
    // Verifica se o arquivo ainda existe
    if (!videoData.filePath) {
      warn(`[TEMP-VIDEOS] Vídeo ${videoId} não tem caminho de arquivo`);
      return { success: false, error: 'Caminho do arquivo não encontrado' };
    }
    
    if (!fs.existsSync(videoData.filePath)) {
      warn(`[TEMP-VIDEOS] Arquivo não existe: ${videoData.filePath}`);
      return { success: false, error: 'Arquivo de vídeo não encontrado no servidor' };
    }
    
    log(`[TEMP-VIDEOS] Vídeo ${videoId} autorizado e arquivo encontrado: ${videoData.filePath}`);
    
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

