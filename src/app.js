require('dotenv').config();

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
// Removidos imports não utilizados diretamente (agora nos módulos)

// Importar módulos
const { initLogger, normalizeBR, toggleNineBR, requestId, readNumbersFromFile, isNumberAuthorized, getClientIp } = require('./modules/utils');
const { initTuyaModule } = require('./modules/tuya');
const { initCameraModule } = require('./modules/camera');
const { initWhatsAppModule } = require('./modules/whatsapp');
const { initRoutesModule } = require('./modules/routes');

/* ===== env ===== */
const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.API_TOKEN || '';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const DEBUG = /^true$/i.test(process.env.DEBUG || 'false');
const LOG_PATH = process.env.LOG_PATH || '/var/log/whatsapp-api.log';
const SIG_MAX_SKEW = parseInt(process.env.SIG_MAX_SKEW_SECONDS || '300', 10);
const REQUIRE_SIGNED = /^true$/i.test(process.env.REQUIRE_SIGNED_REQUESTS || 'false'); // <-- MUDANÇA: Padrão para 'false' para facilitar testes
const PUBLIC_KEY_PATH_RAW = process.env.PUBLIC_KEY_PATH || '';
const CAMERA_SNAPSHOT_URL = process.env.CAMERA_SNAPSHOT_URL || '';
const CAMERA_USER = process.env.CAMERA_USER || '';
const CAMERA_PASS = process.env.CAMERA_PASS || '';
const CAMERA_RTSP_URL = process.env.CAMERA_RTSP_URL || '';
const RECORD_DURATION_SEC = parseInt(process.env.RECORD_DURATION_SEC || '30', 10); // Duração padrão: 30 segundos
// Detecta APP_ROOT automaticamente baseado no diretório do script
// Se não estiver definido no .env, usa o diretório pai do arquivo atual (src/app.js -> raiz do projeto)
const APP_ROOT = process.env.APP_ROOT || (() => {
  // Usa __dirname se disponível (CommonJS), senão usa require.main.filename
  const scriptDir = typeof __dirname !== 'undefined' 
    ? __dirname 
    : path.dirname(require.main?.filename || process.cwd());
  const projectRoot = path.resolve(scriptDir, '..'); // Sobe um nível de src/ para raiz
  return projectRoot;
})();
const RECORDINGS_DIR = process.env.RECORDINGS_DIR || path.join(APP_ROOT, 'recordings');
const NUMBERS_FILE = process.env.NUMBERS_FILE || path.join(APP_ROOT, 'numbers.txt');
const AUTH_DATA_PATH = process.env.AUTH_DATA_PATH || path.join(APP_ROOT, '.wwebjs_auth');
const ESP32_TOKEN = process.env.ESP32_TOKEN || '';
const ESP32_ALLOWED_IPS = process.env.ESP32_ALLOWED_IPS ? process.env.ESP32_ALLOWED_IPS.split(',').map(ip => ip.trim()) : [];
// Configurações de otimização de imagem
const MAX_IMAGE_SIZE_KB = parseInt(process.env.MAX_IMAGE_SIZE_KB || '500', 10); // Tamanho máximo em KB antes de comprimir
const MAX_IMAGE_WIDTH = parseInt(process.env.MAX_IMAGE_WIDTH || '1920', 10); // Largura máxima (WhatsApp recomenda até 1920px)
const MAX_IMAGE_HEIGHT = parseInt(process.env.MAX_IMAGE_HEIGHT || '1080', 10); // Altura máxima
const JPEG_QUALITY = parseInt(process.env.JPEG_QUALITY || '85', 10); // Qualidade JPEG (1-100)
// Configurações de otimização de vídeo
const MAX_VIDEO_SIZE_MB = parseFloat(process.env.MAX_VIDEO_SIZE_MB || '8', 10); // Tamanho máximo em MB antes de comprimir (WhatsApp aceita até ~16MB)
const VIDEO_CRF = parseInt(process.env.VIDEO_CRF || '32', 10); // CRF para compressão (maior = menor qualidade, menor arquivo, padrão: 32)

/* ===== logging ===== */
const logger = initLogger({
  logPath: LOG_PATH,
  debug: DEBUG
});
const { log, dbg, warn, err, nowISO } = logger;

/* ===== Tuya API ===== */
const TUYA_CLIENT_ID = (process.env.TUYA_CLIENT_ID || '').trim();
const TUYA_CLIENT_SECRET = (process.env.TUYA_CLIENT_SECRET || '').trim();
const TUYA_REGION = (process.env.TUYA_REGION || 'us').trim().toLowerCase(); // us, eu, cn, in
const TUYA_UID = (process.env.TUYA_UID || '').trim(); // UID padrão do usuário

// Inicializa módulo Tuya
const tuya = initTuyaModule({
  clientId: TUYA_CLIENT_ID,
  clientSecret: TUYA_CLIENT_SECRET,
  region: TUYA_REGION,
  uid: TUYA_UID,
  logger
});

/* ===== Camera Module ===== */
// Inicializa módulo Camera
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

/* ===== load public key ===== */
const expandHome = p => (p && p.startsWith('~/')) ? path.join(os.homedir(), p.slice(2)) : p;
let publicKeyPem = '';
try {
  const p = expandHome(PUBLIC_KEY_PATH_RAW);
  publicKeyPem = fs.readFileSync(p, 'utf8');
  if (!/BEGIN PUBLIC KEY/.test(publicKeyPem)) throw new Error('Arquivo não parece PEM');
  dbg(`Chave pública carregada de ${p}`);
} catch (e) {
  if (PUBLIC_KEY_PATH_RAW) err('Falha ao carregar a chave pública (PUBLIC_KEY_PATH):', e.message);
}

/* ===== express ===== */
const app = express();
app.set('trust proxy', 1);
app.use(express.json({
  limit: '256kb',
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); }
}));
app.use(helmet());
app.use(cors({
  origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN,
  methods: ['GET','POST'],
  allowedHeaders: [
    'Content-Type','X-API-Token','X-Date','X-Content-SHA256','X-Signature','X-Sign-Alg','X-Forwarded-For'
  ],
}));
app.use(rateLimit({ windowMs: 60_000, max: 120 }));

const ip = getClientIp;

if (DEBUG) {
  app.use((req, _res, next) => {
    dbg(`HTTP ${req.method} ${req.originalUrl} | ip=${ip(req)}`);
    if (req.method === 'POST') dbg(`RAW: ${(req.rawBody||'').slice(0,512)}${(req.rawBody||'').length>512?'…':''}`);
    next();
  });
}

/* ===== auth token (opcional) ===== */
function auth(req, res, next) {
  if (!API_TOKEN) return next();
  const t = req.header('X-API-Token') || '';
  if (t !== API_TOKEN) {
    warn(`401 invalid token | uri=${req.originalUrl} ip=${ip(req)}`);
    return res.status(401).json({ error: 'invalid token' });
  }
  next();
}

/* ===== validação de autorização ESP32 ===== */
function validateESP32Authorization(req) {
  const clientIp = ip(req);
  const token = req.header('X-ESP32-Token') || req.query?.token || req.body?.token || '';
  
  const result = {
    authorized: true,
    reason: 'ok',
    ip: clientIp,
    checks: {
      ip: { passed: true, message: '' },
      token: { passed: true, message: '' }
    }
  };
  
  // Verifica whitelist de IPs (se configurada)
  if (ESP32_ALLOWED_IPS.length > 0) {
    const isAllowed = ESP32_ALLOWED_IPS.some(allowedIp => {
      // Suporta CIDR básico (ex: 10.10.0.0/24) ou IP exato
      if (allowedIp.includes('/')) {
        const [network, prefix] = allowedIp.split('/');
        const prefixLength = parseInt(prefix, 10);
        const networkParts = network.split('.').map(Number);
        const ipParts = clientIp.split('.').map(Number);
        if (networkParts.length !== 4 || ipParts.length !== 4) return false;
        
        const mask = (0xFFFFFFFF << (32 - prefixLength)) >>> 0;
        const networkNum = (networkParts[0] << 24) + (networkParts[1] << 16) + (networkParts[2] << 8) + networkParts[3];
        const ipNum = (ipParts[0] << 24) + (ipParts[1] << 16) + (ipParts[2] << 8) + ipParts[3];
        
        return (networkNum & mask) === (ipNum & mask);
      } else {
        return clientIp === allowedIp;
      }
    });
    
    if (!isAllowed) {
      result.authorized = false;
      result.reason = 'ip_not_allowed';
      result.checks.ip = {
        passed: false,
        message: `IP ${clientIp} não está na whitelist. Permitidos: ${ESP32_ALLOWED_IPS.join(', ')}`
      };
      return result;
    } else {
      result.checks.ip = {
        passed: true,
        message: `IP ${clientIp} autorizado`
      };
    }
  } else {
    result.checks.ip = {
      passed: true,
      message: 'Whitelist de IPs não configurada (qualquer IP permitido)'
    };
  }
  
  // Verifica token (se configurado)
  if (ESP32_TOKEN) {
    if (token !== ESP32_TOKEN) {
      result.authorized = false;
      result.reason = 'invalid_token';
      result.checks.token = {
        passed: false,
        message: 'Token inválido ou não fornecido'
      };
      return result;
    } else {
      result.checks.token = {
        passed: true,
        message: 'Token válido'
      };
    }
  } else {
    result.checks.token = {
      passed: true,
      message: 'Token não configurado (qualquer token permitido)'
    };
  }
  
  return result;
}

/* ===== assinatura (RSA-SHA256) ===== */
function verifySignedRequest(req, endpointPath) {
  if (!REQUIRE_SIGNED) return true;
  if (!publicKeyPem) {
    warn('Requisição assinada recebida, mas nenhuma chave pública foi carregada. Rejeitando.');
    return false;
  }

  const alg    = (req.header('X-Sign-Alg') || '').toLowerCase();
  const sigB64 = req.header('X-Signature') || '';
  const xDate  = req.header('X-Date') || '';
  const body64 = req.header('X-Content-SHA256') || '';
  if (alg !== 'rsa-sha256' || !sigB64 || !xDate || !body64) return false;

  const ts = Date.parse(xDate);
  if (!ts || Math.abs(Date.now() - ts) > SIG_MAX_SKEW * 1000) return false;

  const hash = crypto.createHash('sha256').update(req.rawBody || '').digest('base64');
  if (hash !== body64) return false;

  const canonical = `POST\n${endpointPath}\n${body64}\n${xDate}`;
  try {
    return crypto.verify('sha256', Buffer.from(canonical, 'utf8'),
      crypto.createPublicKey(publicKeyPem),
      Buffer.from(sigB64, 'base64'));
  } catch {
    return false;
  }
}

/* ===== helpers de telefone (BR/E.164) ===== */
// Funções movidas para módulo utils - usar normalizeBR, toggleNineBR, requestId do módulo

/* ===== WhatsApp Module ===== */
// Configurações da API oficial do WhatsApp Business
const WHATSAPP_ACCESS_TOKEN = (process.env.WHATSAPP_ACCESS_TOKEN || '').trim();
const WHATSAPP_PHONE_NUMBER_ID = (process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
const WHATSAPP_BUSINESS_ACCOUNT_ID = (process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '').trim();
const WHATSAPP_WEBHOOK_VERIFY_TOKEN = (process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || 'my_verify_token').trim();
const WHATSAPP_API_VERSION = (process.env.WHATSAPP_API_VERSION || 'v21.0').trim();
const USE_OFFICIAL_API = /^true$/i.test(process.env.USE_WHATSAPP_OFFICIAL_API || 'false');
const WHATSAPP_WEBHOOK_DOMAIN = (process.env.WHATSAPP_WEBHOOK_DOMAIN || 'seu-dominio.com').trim();

// Debug: mostra o token carregado (apenas os primeiros e últimos caracteres por segurança)
if (WHATSAPP_WEBHOOK_VERIFY_TOKEN && WHATSAPP_WEBHOOK_VERIFY_TOKEN !== 'my_verify_token') {
  const tokenPreview = WHATSAPP_WEBHOOK_VERIFY_TOKEN.length > 20 
    ? `${WHATSAPP_WEBHOOK_VERIFY_TOKEN.substring(0, 20)}...${WHATSAPP_WEBHOOK_VERIFY_TOKEN.substring(WHATSAPP_WEBHOOK_VERIFY_TOKEN.length - 10)}`
    : WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  dbg(`[CONFIG] WHATSAPP_WEBHOOK_VERIFY_TOKEN carregado (length: ${WHATSAPP_WEBHOOK_VERIFY_TOKEN.length}): ${tokenPreview}`);
}

log(`[CONFIG] APP_ROOT: ${APP_ROOT}`);
log(`[CONFIG] AUTH_DATA_PATH: ${AUTH_DATA_PATH}`);
log(`[CONFIG] NUMBERS_FILE: ${NUMBERS_FILE}`);
log(`[CONFIG] RECORDINGS_DIR: ${RECORDINGS_DIR}`);
log(`[CONFIG] USE_WHATSAPP_OFFICIAL_API: ${USE_OFFICIAL_API}`);

let whatsapp;
let client = null;

// Escolhe qual API usar
if (USE_OFFICIAL_API && WHATSAPP_ACCESS_TOKEN && WHATSAPP_PHONE_NUMBER_ID) {
  log(`[INIT] Usando API Oficial do WhatsApp Business`);
  const { initWhatsAppOfficialModule } = require('./modules/whatsapp-official');
  
  whatsapp = initWhatsAppOfficialModule({
    accessToken: WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: WHATSAPP_PHONE_NUMBER_ID,
    businessAccountId: WHATSAPP_BUSINESS_ACCOUNT_ID,
    webhookVerifyToken: WHATSAPP_WEBHOOK_VERIFY_TOKEN,
    apiVersion: WHATSAPP_API_VERSION,
    logger,
    camera,
    tuya: (TUYA_CLIENT_ID && TUYA_CLIENT_SECRET) ? tuya : null,
    utils: { normalizeBR, toggleNineBR, isNumberAuthorized },
    numbersFile: NUMBERS_FILE,
    recordDurationSec: RECORD_DURATION_SEC
  });
  
  // API oficial não tem cliente (usa HTTP direto)
  // Cria um objeto mock para compatibilidade
  client = {
    sendMessage: async (to, message) => {
      if (typeof message === 'string') {
        return await whatsapp.sendTextMessage(to, message);
      }
      // Para outros tipos, implementar conforme necessário
      throw new Error('Tipo de mensagem não suportado na API oficial');
    },
    getState: async () => 'CONNECTED',
    getNumberId: async () => null
  };
} else {
  log(`[INIT] Usando whatsapp-web.js (API não oficial)`);
  
  if (USE_OFFICIAL_API) {
    warn(`[INIT] USE_WHATSAPP_OFFICIAL_API=true mas WHATSAPP_ACCESS_TOKEN ou WHATSAPP_PHONE_NUMBER_ID não configurados. Usando whatsapp-web.js como fallback.`);
  }
  
  whatsapp = initWhatsAppModule({
    authDataPath: AUTH_DATA_PATH,
    port: PORT,
    logger,
    camera,
    tuya: (TUYA_CLIENT_ID && TUYA_CLIENT_SECRET) ? tuya : null,
    utils: { normalizeBR, toggleNineBR, isNumberAuthorized },
    numbersFile: NUMBERS_FILE,
    recordDurationSec: RECORD_DURATION_SEC
  });
  
  client = whatsapp.client;
  
  // Garante que diretórios necessários existem
  if (!fs.existsSync(RECORDINGS_DIR)) {
    fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
    log(`[INIT] Diretório de gravações criado: ${RECORDINGS_DIR}`);
  }
  
  // Inicializa o cliente WhatsApp (apenas para whatsapp-web.js)
  whatsapp.initialize();
}

// Garante que diretórios necessários existem
if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  log(`[INIT] Diretório de gravações criado: ${RECORDINGS_DIR}`);
}

/* ===== funções para snapshot da câmera ===== */
// Funções movidas para módulo camera - usar camera.downloadSnapshot(), camera.buildRTSPUrl(), etc.
// Todas as funções de câmera foram movidas para src/modules/camera.js

// Funções movidas para módulos:
// - readNumbersFromFile, isNumberAuthorized -> src/modules/utils.js
// - buildRTSPUrl, cleanupVideoFile, compressVideoIfNeeded, recordRTSPVideo -> src/modules/camera.js

/* ===== funções para API Tuya ===== */
// Funções movidas para módulo tuya - usar tuya.getAccessToken(), tuya.getDeviceStatus(), etc.
// Todas as funções Tuya foram movidas para src/modules/tuya.js

/* ===== Routes Module ===== */
// Inicializa módulo Routes (todos os endpoints HTTP)
initRoutesModule({
  app,
  whatsapp,
  camera,
  tuya: (TUYA_CLIENT_ID && TUYA_CLIENT_SECRET) ? tuya : null,
  utils: { requestId, normalizeBR, readNumbersFromFile, getClientIp },
  logger,
  auth,
  verifySignedRequest,
  validateESP32Authorization,
  numbersFile: NUMBERS_FILE,
  cameraSnapshotUrl: CAMERA_SNAPSHOT_URL,
  authDataPath: AUTH_DATA_PATH,
  tuyaUid: TUYA_UID
});

/* ===== Webhook para API Oficial do WhatsApp ===== */
if (USE_OFFICIAL_API && WHATSAPP_ACCESS_TOKEN && WHATSAPP_PHONE_NUMBER_ID) {
  // Endpoint de verificação do webhook (GET)
  app.get('/webhook/whatsapp', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'] || '';
    const challenge = req.query['hub.challenge'] || '';
    
    log(`[WEBHOOK] GET recebido - Verificação do webhook`);
    log(`[WEBHOOK] IP: ${req.ip || req.socket?.remoteAddress || req.headers['x-forwarded-for'] || 'unknown'}`);
    log(`[WEBHOOK] Mode: ${mode}, Challenge: ${challenge}`);
    
    // Debug detalhado
    dbg(`[WEBHOOK] Token recebido (length: ${token.length}): ${token}`);
    dbg(`[WEBHOOK] Token esperado (length: ${WHATSAPP_WEBHOOK_VERIFY_TOKEN.length}): ${WHATSAPP_WEBHOOK_VERIFY_TOKEN}`);
    dbg(`[WEBHOOK] Query completa: ${JSON.stringify(req.query)}`);
    
    // Comparação exata (case-sensitive)
    const tokenMatch = token === WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    
    if (mode === 'subscribe' && tokenMatch) {
      log(`[WEBHOOK] ✅ Webhook verificado com sucesso!`);
      log(`[WEBHOOK] Retornando challenge: ${challenge}`);
      res.status(200).send(challenge);
    } else {
      warn(`[WEBHOOK] ❌ Falha na verificação do webhook`);
      warn(`[WEBHOOK] Mode match: ${mode === 'subscribe'}`);
      warn(`[WEBHOOK] Token match: ${tokenMatch}`);
      if (!tokenMatch) {
        warn(`[WEBHOOK] Diferença nos tokens:`);
        warn(`[WEBHOOK] Recebido: "${token}"`);
        warn(`[WEBHOOK] Esperado: "${WHATSAPP_WEBHOOK_VERIFY_TOKEN}"`);
        warn(`[WEBHOOK] Tamanhos: recebido=${token.length}, esperado=${WHATSAPP_WEBHOOK_VERIFY_TOKEN.length}`);
      }
      res.sendStatus(403);
    }
  });
  
  // Endpoint para receber mensagens do webhook (POST)
  app.post('/webhook/whatsapp', express.json(), async (req, res) => {
    try {
      const body = req.body;
      
      log(`[WEBHOOK] POST recebido - Objeto: ${body.object || 'não especificado'}`);
      dbg(`[WEBHOOK] Body completo:`, JSON.stringify(body, null, 2));
      
      // Verifica se é uma notificação do WhatsApp
      if (body.object === 'whatsapp_business_account') {
        log(`[WEBHOOK] ✅ Objeto WhatsApp Business Account confirmado`);
        log(`[WEBHOOK] Processando ${body.entry?.length || 0} entrada(s)`);
        
        for (const entry of body.entry || []) {
          log(`[WEBHOOK] Processando entrada...`);
          await whatsapp.processWebhookMessage(entry);
        }
        
        log(`[WEBHOOK] ✅ Processamento concluído, retornando 200`);
        res.sendStatus(200);
      } else {
        warn(`[WEBHOOK] ⚠️ Objeto desconhecido recebido: ${body.object}`);
        warn(`[WEBHOOK] Body:`, JSON.stringify(body, null, 2));
        res.sendStatus(200); // Retorna 200 mesmo assim para não gerar erro no Meta
      }
    } catch (error) {
      err(`[WEBHOOK] ❌ Erro ao processar webhook:`, error.message);
      err(`[WEBHOOK] Stack:`, error.stack);
      res.sendStatus(500);
    }
  });
  
  log(`[WEBHOOK] Endpoints de webhook configurados:`);
  log(`[WEBHOOK] GET  /webhook/whatsapp - Verificação`);
  log(`[WEBHOOK] POST /webhook/whatsapp - Recebimento de mensagens`);
}

app.listen(PORT, () => { 
  log(`🚀 API ouvindo em ${PORT}`); 
  if (DEBUG) log('DEBUG ativo');
  if (USE_OFFICIAL_API && WHATSAPP_ACCESS_TOKEN && WHATSAPP_PHONE_NUMBER_ID) {
    log(`[INFO] API Oficial do WhatsApp Business ativa`);
    const webhookUrl = WHATSAPP_WEBHOOK_DOMAIN.startsWith('http') 
      ? `${WHATSAPP_WEBHOOK_DOMAIN}/webhook/whatsapp`
      : `https://${WHATSAPP_WEBHOOK_DOMAIN}/webhook/whatsapp`;
    log(`[INFO] Configure o webhook no Meta: ${webhookUrl}`);
    log(`[INFO] Token de verificação: ${WHATSAPP_WEBHOOK_VERIFY_TOKEN}`);
    log(`[INFO] Phone Number ID: ${WHATSAPP_PHONE_NUMBER_ID}`);
  }
});