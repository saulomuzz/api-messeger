require('dotenv').config();

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
// Removidos imports não utilizados diretamente (agora nos módulos)

// Importar módulos
const { initLogger, normalizeBR, toggleNineBR, requestId, readNumbersFromFile, isNumberAuthorized, getClientIp } = require('./modules/utils');
const { initTuyaModule } = require('./modules/tuya');
const { initCameraModule } = require('./modules/camera');
const { initRoutesModule } = require('./modules/routes');
const { initTuyaMonitorModule } = require('./modules/tuya-monitor');
const { initIPBlockerModule } = require('./modules/ip-blocker');
const { initAbuseIPDBModule } = require('./modules/abuseipdb');
const { initWebSocketESP32Module } = require('./modules/websocket-esp32');
const { initAdminModule } = require('./modules/admin');

/* ===== env ===== */
// Detecta APP_ROOT automaticamente baseado no diretório do script
// Se não estiver definido no .env, usa o diretório pai do arquivo atual (src/app.js -> raiz do projeto)
// IMPORTANTE: APP_ROOT deve ser definido ANTES de qualquer uso
const APP_ROOT = process.env.APP_ROOT || (() => {
  // Usa __dirname se disponível (CommonJS), senão usa require.main.filename
  const scriptDir = typeof __dirname !== 'undefined' 
    ? __dirname 
    : path.dirname(require.main?.filename || process.cwd());
  const projectRoot = path.resolve(scriptDir, '..'); // Sobe um nível de src/ para raiz
  return projectRoot;
})();

const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.API_TOKEN || '';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const DEBUG = /^true$/i.test(process.env.DEBUG || 'false');
// Configurações de segurança
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10); // Janela de tempo em ms (padrão: 1 minuto)
const RATE_LIMIT_MAX_REQUESTS = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10); // Máximo de requisições por janela (padrão: 100)
const RATE_LIMIT_STRICT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_STRICT_WINDOW_MS || '60000', 10); // Janela para endpoints críticos
const RATE_LIMIT_STRICT_MAX = parseInt(process.env.RATE_LIMIT_STRICT_MAX || '10', 10); // Máximo para endpoints críticos (ex: /send, /trigger-snapshot)
const ENABLE_IP_WHITELIST = /^true$/i.test(process.env.ENABLE_IP_WHITELIST || 'false'); // Whitelist global de IPs
const IP_WHITELIST = process.env.IP_WHITELIST ? process.env.IP_WHITELIST.split(',').map(ip => ip.trim()) : [];
const GLOBAL_IP_WHITELIST = process.env.GLOBAL_IP_WHITELIST ? process.env.GLOBAL_IP_WHITELIST.split(',').map(ip => ip.trim()) : [];
const ENABLE_GLOBAL_IP_VALIDATION = /^true$/i.test(process.env.ENABLE_GLOBAL_IP_VALIDATION || 'true');
// BLOCKED_IPS_FILE removido - agora usa banco SQLite via ip-blocker.js
// Mantido apenas para referência (não é mais usado)
const ENABLE_REQUEST_TIMEOUT = /^true$/i.test(process.env.ENABLE_REQUEST_TIMEOUT || 'true');
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || '30000', 10); // Timeout de 30 segundos
const LOG_PATH = process.env.LOG_PATH || '/var/log/whatsapp-api.log';
const LOG_TIMEZONE_LOCAL = /^true$/i.test(process.env.LOG_TIMEZONE_LOCAL || 'true'); // Usar horário local nos logs (padrão: true)
const SIG_MAX_SKEW = parseInt(process.env.SIG_MAX_SKEW_SECONDS || '300', 10);
const REQUIRE_SIGNED = /^true$/i.test(process.env.REQUIRE_SIGNED_REQUESTS || 'false'); // <-- MUDANÇA: Padrão para 'false' para facilitar testes
const PUBLIC_KEY_PATH_RAW = process.env.PUBLIC_KEY_PATH || '';
const CAMERA_SNAPSHOT_URL = process.env.CAMERA_SNAPSHOT_URL || '';
const CAMERA_USER = process.env.CAMERA_USER || '';
const CAMERA_PASS = process.env.CAMERA_PASS || '';
const CAMERA_RTSP_URL = process.env.CAMERA_RTSP_URL || '';
const RECORD_DURATION_SEC = parseInt(process.env.RECORD_DURATION_SEC || '30', 10); // Duração padrão: 30 segundos
const MIN_SNAPSHOT_INTERVAL_MS = parseInt(process.env.MIN_SNAPSHOT_INTERVAL_MS || '20000', 10); // Intervalo mínimo entre snapshots em ms (padrão: 20 segundos)
const ENABLE_VIDEO_RECORDING = /^true$/i.test(process.env.ENABLE_VIDEO_RECORDING || 'true'); // Habilitar gravação de vídeo (padrão: true)
const VIDEO_RECORD_DURATION_SEC = parseInt(process.env.VIDEO_RECORD_DURATION_SEC || '15', 10); // Duração do vídeo ao tocar campainha (padrão: 15 segundos)
const MIN_VIDEO_RECORD_INTERVAL_MS = parseInt(process.env.MIN_VIDEO_RECORD_INTERVAL_MS || '60000', 10); // Intervalo mínimo entre gravações em ms (padrão: 60 segundos = 1 minuto)
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
const WHATSAPP_MAX_VIDEO_SIZE_MB = parseFloat(process.env.WHATSAPP_MAX_VIDEO_SIZE_MB || '16', 10); // Tamanho máximo permitido pela API do WhatsApp (padrão: 16MB)
const VIDEO_CRF = parseInt(process.env.VIDEO_CRF || '23', 10); // CRF para compressão (0-51: menor = melhor qualidade, padrão: 23 para qualidade muito boa)
const VIDEO_PRESET = process.env.VIDEO_PRESET || 'medium'; // Preset FFmpeg: ultrafast, fast, medium, slow, slower (padrão: medium)
const VIDEO_PROFILE = process.env.VIDEO_PROFILE || 'high'; // Perfil H.264: baseline, main, high (padrão: high)
const VIDEO_LEVEL = process.env.VIDEO_LEVEL || '4.0'; // Nível H.264: 3.0, 3.1, 4.0, 4.1, etc (padrão: 4.0)
const VIDEO_MAXRATE = process.env.VIDEO_MAXRATE || '3M'; // Bitrate máximo (padrão: 3M)
const VIDEO_BUFSIZE = process.env.VIDEO_BUFSIZE || '6M'; // Tamanho do buffer (padrão: 6M)
const VIDEO_GOP = parseInt(process.env.VIDEO_GOP || '60', 10); // GOP size (padrão: 60)
const VIDEO_MAX_WIDTH = parseInt(process.env.VIDEO_MAX_WIDTH || '1920', 10); // Largura máxima (padrão: 1920)
const VIDEO_MAX_HEIGHT = parseInt(process.env.VIDEO_MAX_HEIGHT || '1080', 10); // Altura máxima (padrão: 1080)
const VIDEO_AUDIO_BITRATE = process.env.VIDEO_AUDIO_BITRATE || '128k'; // Bitrate de áudio (padrão: 128k)

/* ===== logging ===== */
const logger = initLogger({
  logPath: LOG_PATH,
  debug: DEBUG,
  useLocalTimezone: LOG_TIMEZONE_LOCAL
});
const { log, dbg, warn, err, nowISO } = logger;

// Log de inicialização do processo
log(`═══════════════════════════════════════════════════════════`);
log(`🚀 [INIT] Iniciando aplicação WhatsApp API`);
log(`📅 [INIT] Data/Hora: ${nowISO()}`);
log(`🆔 [INIT] PID: ${process.pid}`);
log(`📁 [INIT] Diretório: ${process.cwd()}`);
log(`🔧 [INIT] Node.js: ${process.version}`);
log(`💻 [INIT] Plataforma: ${os.platform()} ${os.arch()}`);
log(`═══════════════════════════════════════════════════════════`);

/* ===== Tuya API ===== */
const TUYA_CLIENT_ID = (process.env.TUYA_CLIENT_ID || '').trim();
const TUYA_CLIENT_SECRET = (process.env.TUYA_CLIENT_SECRET || '').trim();
const TUYA_REGION = (process.env.TUYA_REGION || 'us').trim().toLowerCase(); // us, eu, cn, in
const TUYA_UID = (process.env.TUYA_UID || '').trim(); // UID padrão do usuário

// Tuya Monitor
const TUYA_MONITOR_ENABLED = /^true$/i.test(process.env.TUYA_MONITOR_ENABLED || 'true');
const TUYA_MONITOR_ALERT_HOURS = parseFloat(process.env.TUYA_MONITOR_ALERT_HOURS || '1', 10);
const TUYA_MONITOR_CHECK_INTERVAL_MINUTES = parseInt(process.env.TUYA_MONITOR_CHECK_INTERVAL_MINUTES || '5', 10);
const TUYA_MONITOR_NOTIFICATION_NUMBERS = process.env.TUYA_MONITOR_NOTIFICATION_NUMBERS
  ? process.env.TUYA_MONITOR_NOTIFICATION_NUMBERS.split(',').map(n => n.trim())
  : [];

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
let camera;
try {
  log(`[INIT] Inicializando módulo Camera...`);
  camera = initCameraModule({
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
    whatsappMaxVideoSizeMB: WHATSAPP_MAX_VIDEO_SIZE_MB,
    videoCRF: VIDEO_CRF,
    videoPreset: VIDEO_PRESET,
    videoProfile: VIDEO_PROFILE,
    videoLevel: VIDEO_LEVEL,
    videoMaxrate: VIDEO_MAXRATE,
    videoBufsize: VIDEO_BUFSIZE,
    videoGOP: VIDEO_GOP,
    videoMaxWidth: VIDEO_MAX_WIDTH,
    videoMaxHeight: VIDEO_MAX_HEIGHT,
    videoAudioBitrate: VIDEO_AUDIO_BITRATE,
    logger
  });
  log(`[INIT] Módulo Camera inicializado com sucesso`);
} catch (cameraError) {
  err(`[FATAL] Erro ao inicializar módulo Camera:`, cameraError.message);
  err(`[FATAL] Stack:`, cameraError.stack);
  process.exit(1);
}

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
// Cookie parser para sessões admin
app.use(cookieParser());
// Validação de tamanho de payload
app.use(express.json({
  limit: '256kb',
  verify: (req, _res, buf) => { 
    req.rawBody = buf.toString('utf8');
    // Validação adicional de tamanho
    if (buf.length > 256 * 1024) {
      throw new Error('Payload muito grande');
    }
  }
}));

// Configuração do Helmet com opções de segurança
// CSP será ajustado dinamicamente para rotas admin
app.use((req, res, next) => {
  const isAdminRoute = req.path.startsWith('/admin');
  
  // Para rotas admin, permite scripts inline (necessário para funcionalidade)
  // Para outras rotas, mantém CSP restritivo
  if (isAdminRoute) {
    // Configuração permissiva para admin (permite scripts inline)
    return helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"], // Permite scripts inline para admin
          scriptSrcAttr: ["'unsafe-inline'"], // Permite event handlers inline (onclick, etc)
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'"], // Permite fetch/XMLHttpRequest
        },
      },
      crossOriginEmbedderPolicy: false,
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
      }
    })(req, res, next);
  } else {
    // Configuração restritiva para outras rotas
    return helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"], // Restritivo para outras rotas
          imgSrc: ["'self'", "data:", "https:"],
        },
      },
      crossOriginEmbedderPolicy: false,
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
      }
    })(req, res, next);
  }
});

// Middleware de timeout de requisições
if (ENABLE_REQUEST_TIMEOUT) {
  app.use((req, res, next) => {
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      const clientIp = getClientIp(req);
      warn(`[SECURITY] Timeout de requisição para IP ${clientIp} em ${req.path}`);
      if (!res.headersSent) {
        res.status(408).json({ error: 'request_timeout', message: 'Requisição excedeu o tempo limite' });
      }
    });
    next();
  });
}

// Middleware de validação de IP (whitelist global)
if (ENABLE_IP_WHITELIST && IP_WHITELIST.length > 0) {
  app.use((req, res, next) => {
    const clientIp = getClientIp(req);
    const isAllowed = IP_WHITELIST.some(allowedIp => {
      if (allowedIp.includes('/')) {
        return ipInCidr(clientIp, allowedIp);
      }
      return normalizeIp(clientIp) === normalizeIp(allowedIp);
    });
    
    if (!isAllowed) {
      warn(`[SECURITY] IP bloqueado pela whitelist: ${clientIp} em ${req.path}`);
      return res.status(403).json({ 
        error: 'ip_not_allowed',
        message: 'IP não autorizado'
      });
    }
    next();
  });
}
// Helmet já está configurado dinamicamente acima (linha ~200)
// Não aplicar novamente para evitar sobrescrever CSP
app.use(cors({
  origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN,
  methods: ['GET','POST'],
  allowedHeaders: [
    'Content-Type','X-API-Token','X-Date','X-Content-SHA256','X-Signature','X-Sign-Alg','X-Forwarded-For','X-ESP32-Token'
  ],
}));

/* ===== IP Blocker Module ===== */
let ipBlocker = null;
try {
  log(`[INIT] Inicializando módulo IP Blocker...`);
  log(`[INIT] APP_ROOT: ${APP_ROOT}`);
  const ipBlockerResult = initIPBlockerModule({
    appRoot: APP_ROOT,
    logger
  });
  log(`[INIT] initIPBlockerModule retornou: ${typeof ipBlockerResult}`);
  log(`[INIT] ipBlockerResult é null: ${ipBlockerResult === null}`);
  log(`[INIT] ipBlockerResult é undefined: ${ipBlockerResult === undefined}`);
  
  if (ipBlockerResult) {
    ipBlocker = ipBlockerResult;
    const functions = Object.keys(ipBlocker).filter(key => typeof ipBlocker[key] === 'function');
    log(`[INIT] ✅ Módulo IP Blocker inicializado com sucesso - ${functions.length} funções disponíveis`);
    log(`[INIT] Funções: ${functions.join(', ')}`);
    log(`[INIT] ipBlocker atribuído: ${!!ipBlocker}`);
  } else {
    err(`[INIT] ❌ ATENÇÃO: initIPBlockerModule retornou null/undefined`);
    err(`[INIT] ❌ Tipo retornado: ${typeof ipBlockerResult}`);
    err(`[INIT] ❌ Valor retornado: ${ipBlockerResult}`);
    ipBlocker = null;
  }
} catch (ipBlockerError) {
  err(`[FATAL] Erro ao inicializar módulo IP Blocker:`, ipBlockerError.message);
  err(`[FATAL] Stack:`, ipBlockerError.stack);
  ipBlocker = null; // Garante que está null em caso de erro
  // Não encerra a aplicação, mas loga o erro
}

/* ===== AbuseIPDB Module ===== */
let abuseIPDB = null;
try {
  log(`[INIT] Inicializando módulo AbuseIPDB...`);
  abuseIPDB = initAbuseIPDBModule({
    apiKey: process.env.ABUSEIPDB_API_KEY || '',
    logger,
    ipBlocker
  });
  log(`[INIT] Módulo AbuseIPDB inicializado com sucesso`);
  
  // Verifica se deve recategorizar IPs na inicialização
  const RECATEGORIZE_IPS = /^true$/i.test(process.env.ABUSEIPDB_RECATEGORIZE_IPS || 'false');
  if (RECATEGORIZE_IPS && abuseIPDB && abuseIPDB.recategorizeAllIPs && ipBlocker) {
    log(`[INIT] Recategorização de IPs habilitada (ABUSEIPDB_RECATEGORIZE_IPS=true)`);
    log(`[INIT] Iniciando recategorização em background...`);
    
    // Executa em background para não bloquear a inicialização
    (async () => {
      try {
        const result = await abuseIPDB.recategorizeAllIPs(ipBlocker);
        log(`[INIT] ✅ Recategorização concluída: ${result.recategorized} IP(s) recategorizado(s), ${result.errors} erro(s)`);
        
        // Log resumido dos IPs que mudaram
        const changedIPs = result.results.filter(r => r.changed);
        if (changedIPs.length > 0) {
          log(`[INIT] IPs recategorizados:`);
          changedIPs.forEach(r => {
            log(`[INIT]   - ${r.ip}: ${r.previousList} (${r.previousConfidence}%) → ${r.newList} (${r.newConfidence}%)`);
          });
        }
      } catch (recatError) {
        err(`[INIT] Erro na recategorização:`, recatError.message);
      }
    })();
  } else if (RECATEGORIZE_IPS) {
    warn(`[INIT] Recategorização solicitada mas módulos não disponíveis`);
  }
} catch (abuseIPDBError) {
  warn(`[INIT] Erro ao inicializar módulo AbuseIPDB:`, abuseIPDBError.message);
  // Não encerra a aplicação, mas loga o erro
}

// Middleware de verificação de IP bloqueado e validação AbuseIPDB (executado no início de cada requisição)
app.use(async (req, res, next) => {
  // Ignora requisições WebSocket (upgrade requests) - elas são tratadas pelo módulo WebSocket
  if (req.headers.upgrade === 'websocket' || req.path === '/ws/esp32') {
    return next();
  }
  
  const clientIp = getClientIp(req);
  const normalizedIp = normalizeIp(clientIp);
  
  // Ignora IPs locais e inválidos
  if (!normalizedIp || normalizedIp === 'unknown' || normalizedIp === 'localhost' || 
      normalizedIp.startsWith('127.') || normalizedIp.startsWith('192.168.') || 
      normalizedIp.startsWith('10.') || normalizedIp.startsWith('172.')) {
    return next();
  }
  
  // Ignora IPs na whitelist
  if (ENABLE_IP_WHITELIST && IP_WHITELIST.length > 0) {
    const isAllowed = IP_WHITELIST.some(allowedIp => {
      if (allowedIp.includes('/')) {
        return ipInCidr(normalizedIp, allowedIp);
      }
      return normalizeIp(normalizedIp) === normalizeIp(allowedIp);
    });
    if (isAllowed) {
      return next();
    }
  }
  
  // Verifica se IP está bloqueado no banco
  if (ipBlocker && ipBlocker.isBlocked) {
    try {
      const isBlocked = await ipBlocker.isBlocked(normalizedIp);
      if (isBlocked) {
        // Registra tentativa de acesso bloqueado
        if (ipBlocker.recordBlockedAttempt) {
          await ipBlocker.recordBlockedAttempt(normalizedIp);
        }
        warn(`[SECURITY] Tentativa de acesso de IP bloqueado: ${normalizedIp} em ${req.path}`);
        // Retorna 404 genérico para não revelar que o IP está bloqueado
        return res.status(404).send('Not Found');
      }
      
      // Se não está bloqueado, verifica se está em whitelist/yellowlist e registra tentativa
      if (ipBlocker && ipBlocker.recordIPAttempt) {
        // Registra tentativa de acesso (atualiza contador se estiver em alguma lista)
        ipBlocker.recordIPAttempt(normalizedIp).catch(err => {
          dbg(`[SECURITY] Erro ao registrar tentativa de IP:`, err.message);
        });
      }
    } catch (e) {
      // Em caso de erro, permite acesso mas loga
      dbg(`[SECURITY] Erro ao verificar IP bloqueado:`, e.message);
    }
  }
  
  // Valida IP no AbuseIPDB para rotas não configuradas ou suspeitas
  const knownRoutes = ['/health', '/webhook/whatsapp', '/esp32/validate', '/qr.png', '/qr/status', '/status', '/send', '/trigger-snapshot', '/tuya/', '/esp32/ota', '/esp32/ota/check', '/esp32/ota/download', '/admin'];
  const isKnownRoute = knownRoutes.some(route => req.path.startsWith(route));
  
  // Valida apenas se não for rota conhecida
  if (!isKnownRoute && abuseIPDB && abuseIPDB.checkAndBlockIP) {
    try {
      // Verifica de forma assíncrona (não bloqueia a requisição imediatamente)
      abuseIPDB.checkAndBlockIP(normalizedIp, `Tentativa de acesso a rota não configurada: ${req.method} ${req.path}`)
        .then(result => {
          if (result.blocked) {
            log(`[ABUSEIPDB] IP ${normalizedIp} bloqueado automaticamente após verificação: ${result.reason}`);
          } else if (result.abuseConfidence > 0) {
            dbg(`[ABUSEIPDB] IP ${normalizedIp} verificado: ${result.abuseConfidence}% confiança, ${result.reports} report(s)`);
          }
        })
        .catch(err => {
          warn(`[ABUSEIPDB] Erro ao verificar/bloquear IP ${normalizedIp}:`, err.message);
        });
    } catch (abuseError) {
      // Não bloqueia requisição em caso de erro na verificação
      dbg(`[ABUSEIPDB] Erro ao iniciar verificação:`, abuseError.message);
    }
  }
  
  next();
});

// Rate limiting global (mais permissivo)
const globalRateLimit = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX_REQUESTS,
  message: { error: 'Muitas requisições. Tente novamente mais tarde.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Pula rate limit para IPs na whitelist (se habilitado)
    if (ENABLE_IP_WHITELIST && IP_WHITELIST.length > 0) {
      const clientIp = getClientIp(req);
      return IP_WHITELIST.some(allowedIp => {
        if (allowedIp.includes('/')) {
          return ipInCidr(clientIp, allowedIp);
        }
        return normalizeIp(clientIp) === normalizeIp(allowedIp);
      });
    }
    return false;
  },
  handler: (req, res) => {
    const clientIp = getClientIp(req);
    warn(`[SECURITY] Rate limit excedido para IP ${clientIp} em ${req.path}`);
    res.status(429).json({ 
      error: 'rate_limit_exceeded',
      message: 'Muitas requisições. Tente novamente mais tarde.',
      retryAfter: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)
    });
  }
});

// Rate limiting estrito para endpoints críticos
const strictRateLimit = rateLimit({
  windowMs: RATE_LIMIT_STRICT_WINDOW_MS,
  max: RATE_LIMIT_STRICT_MAX,
  message: { error: 'Limite de requisições excedido para este endpoint.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    if (ENABLE_IP_WHITELIST && IP_WHITELIST.length > 0) {
      const clientIp = getClientIp(req);
      return IP_WHITELIST.some(allowedIp => {
        if (allowedIp.includes('/')) {
          return ipInCidr(clientIp, allowedIp);
        }
        return normalizeIp(clientIp) === normalizeIp(allowedIp);
      });
    }
    return false;
  },
  handler: (req, res) => {
    const clientIp = getClientIp(req);
    warn(`[SECURITY] Rate limit estrito excedido para IP ${clientIp} em ${req.path}`);
    res.status(429).json({ 
      error: 'rate_limit_exceeded',
      message: 'Limite de requisições excedido para este endpoint. Tente novamente mais tarde.',
      retryAfter: Math.ceil(RATE_LIMIT_STRICT_WINDOW_MS / 1000)
    });
  }
});

// Nota: detectScanner será aplicado após sua definição (linha ~468)
// mas a ordem de registro em Express importa - será executado na ordem registrada
const ip = getClientIp;

if (DEBUG) {
  app.use((req, _res, next) => {
    dbg(`HTTP ${req.method} ${req.originalUrl} | ip=${ip(req)}`);
    if (req.method === 'POST') dbg(`RAW: ${(req.rawBody||'').slice(0,512)}${(req.rawBody||'').length>512?'…':''}`);
    next();
  });
}

// Sistema de bloqueio de IPs (agora usando banco SQLite via ipBlocker)
// Código antigo removido - tudo é gerenciado pelo módulo ip-blocker.js
let failedAttempts = new Map(); // IP -> { count, firstAttempt, lastAttempt }
let scannerDetection = new Map(); // IP -> { suspiciousPaths: Set, firstSeen, lastSeen, count }

// Endpoints suspeitos que indicam varredura/reconhecimento
const SUSPICIOUS_PATHS = [
  '/robots.txt',
  '/sitemap.xml',
  '/.well-known/security.txt',
  '/favicon.ico',
  '/.env',
  '/.git',
  '/wp-admin',
  '/wp-login.php',
  '/phpmyadmin',
  '/admin',
  '/administrator',
  '/.well-known',
  '/.git/config',
  '/config.php',
  '/backup',
  '/test',
  '/api',
  '/swagger',
  '/docs'
];

// Funções antigas de carregar/salvar IPs bloqueados removidas
// Agora tudo é gerenciado pelo módulo ip-blocker.js usando SQLite
// A migração do JSON é feita automaticamente pelo módulo na primeira inicialização

// Limpa tentativas antigas (mais de 1 hora)
setInterval(() => {
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  for (const [ip, data] of failedAttempts.entries()) {
    if (data.lastAttempt < oneHourAgo) {
      failedAttempts.delete(ip);
    }
  }
}, 60 * 60 * 1000); // A cada hora

// IPs bloqueados são carregados do banco SQLite pelo módulo ip-blocker.js
// Não precisa mais carregar do arquivo JSON

// Middleware de detecção de scanners/bots
async function detectScanner(req, res, next) {
  const clientIp = getClientIp(req);
  const path = req.path.toLowerCase();
  
  // Ignora rotas administrativas e outras rotas conhecidas
  const adminRoutes = ['/admin'];
  const isAdminRoute = adminRoutes.some(route => path.startsWith(route));
  if (isAdminRoute) {
    return next();
  }
  
  // Ignora IPs na whitelist
  if (ENABLE_IP_WHITELIST && IP_WHITELIST.length > 0) {
    const isAllowed = IP_WHITELIST.some(allowedIp => {
      if (allowedIp.includes('/')) {
        return ipInCidr(clientIp, allowedIp);
      }
      return normalizeIp(clientIp) === normalizeIp(allowedIp);
    });
    if (isAllowed) {
      return next();
    }
  }
  
  // Verificação de IP bloqueado já é feita no middleware global acima
  // Esta verificação local é mantida apenas para compatibilidade
  
  // Verifica se o path é suspeito
  const isSuspicious = SUSPICIOUS_PATHS.some(suspiciousPath => 
    path === suspiciousPath || path.startsWith(suspiciousPath + '/')
  );
  
  if (isSuspicious) {
    const now = Date.now();
    let scannerData = scannerDetection.get(clientIp);
    
    if (!scannerData) {
      scannerData = {
        suspiciousPaths: new Set(),
        firstSeen: now,
        lastSeen: now,
        count: 0
      };
      scannerDetection.set(clientIp, scannerData);
    }
    
    scannerData.suspiciousPaths.add(path);
    scannerData.lastSeen = now;
    scannerData.count++;
    
    // Bloqueia se detectou 3+ endpoints suspeitos em 5 minutos
    const timeWindow = now - scannerData.firstSeen;
    const BLOCK_THRESHOLD = 3; // Número de endpoints suspeitos
    const TIME_WINDOW_MS = 5 * 60 * 1000; // 5 minutos
    
    if (scannerData.suspiciousPaths.size >= BLOCK_THRESHOLD && timeWindow <= TIME_WINDOW_MS) {
      // Bloqueia no banco de dados
      const reason = `Varredura/reconhecimento (${scannerData.suspiciousPaths.size} endpoints suspeitos: ${Array.from(scannerData.suspiciousPaths).join(', ')})`;
      if (ipBlocker && ipBlocker.blockIP) {
        try {
          await ipBlocker.blockIP(clientIp, reason);
        } catch (e) {
          err(`[SECURITY] Erro ao bloquear IP no banco:`, e.message);
        }
      }
      
      err(`[SECURITY] IP ${clientIp} bloqueado automaticamente por varredura/reconhecimento (${scannerData.suspiciousPaths.size} endpoints suspeitos: ${Array.from(scannerData.suspiciousPaths).join(', ')})`);
      
      // Remove da detecção
      scannerDetection.delete(clientIp);
      
      return res.status(403).json({ 
          error: 'not_found',
          message: 'Not Found'
      });
    } else {
      warn(`[SECURITY] Atividade suspeita detectada de ${clientIp}: ${path} (${scannerData.suspiciousPaths.size}/${BLOCK_THRESHOLD} endpoints suspeitos)`);
    }
  }
  
  // Limpa detecções antigas (mais de 10 minutos)
  const tenMinutesAgo = Date.now() - (10 * 60 * 1000);
  for (const [ip, data] of scannerDetection.entries()) {
    if (data.lastSeen < tenMinutesAgo) {
      scannerDetection.delete(ip);
    }
  }
  
  next();
}

// Aplica detecção de scanner ANTES do rate limiting (mas após sua definição)
// Isso garante que scanners sejam bloqueados antes de consumir recursos de rate limiting
app.use(detectScanner);

/* ===== auth token (opcional) ===== */
async function auth(req, res, next) {
  const clientIp = getClientIp(req);
  
  // Verificação de IP bloqueado já é feita no middleware global
  // Esta verificação local é mantida apenas para compatibilidade
  
  if (!API_TOKEN) return next();
  
  const t = req.header('X-API-Token') || '';
  if (t !== API_TOKEN) {
    // Registra tentativa falhada
    const now = Date.now();
    const attempts = failedAttempts.get(clientIp) || { count: 0, firstAttempt: now, lastAttempt: now };
    attempts.count++;
    attempts.lastAttempt = now;
    failedAttempts.set(clientIp, attempts);
    
    // Bloqueia IP após 5 tentativas falhadas em 15 minutos
    if (attempts.count >= 5) {
      const timeSinceFirst = now - attempts.firstAttempt;
      if (timeSinceFirst < 15 * 60 * 1000) { // 15 minutos
        // Bloqueia no banco de dados
        const reason = `Múltiplas tentativas falhadas de autenticação (${attempts.count} tentativas)`;
        if (ipBlocker && ipBlocker.blockIP) {
          try {
            await ipBlocker.blockIP(clientIp, reason);
          } catch (e) {
            err(`[SECURITY] Erro ao bloquear IP no banco:`, e.message);
          }
        }
        
        err(`[SECURITY] IP ${clientIp} bloqueado após ${attempts.count} tentativas falhadas`);
        return res.status(403).json({ 
          error: 'not_found',
          message: 'Not Found'
        });
      } else {
        // Reset contador se passou muito tempo
        attempts.count = 1;
        attempts.firstAttempt = now;
        failedAttempts.set(clientIp, attempts);
      }
    }
    
    warn(`[SECURITY] Tentativa de acesso com token inválido de ${clientIp} (tentativa ${attempts.count}/5)`);
    return res.status(401).json({ 
      error: 'invalid_token', 
      message: 'Token inválido ou não fornecido' 
    });
  }
  
  // Limpa tentativas falhadas em caso de sucesso
  if (failedAttempts.has(clientIp)) {
    failedAttempts.delete(clientIp);
  }
  
  next();
}

/* ===== validação de autorização ESP32 ===== */
function normalizeIp(ipAddress) {
  // Remove prefixo IPv6 mapeado para IPv4 (::ffff:)
  if (ipAddress && ipAddress.startsWith('::ffff:')) {
    return ipAddress.substring(7);
  }
  return ipAddress;
}

function ipInCidr(ipAddress, cidr) {
  const [network, prefixStr] = cidr.split('/');
  const prefixLength = parseInt(prefixStr, 10);
  
  if (isNaN(prefixLength) || prefixLength < 0 || prefixLength > 32) {
    return false;
  }
  
  const networkParts = network.split('.').map(Number);
  const ipParts = ipAddress.split('.').map(Number);
  
  if (networkParts.length !== 4 || ipParts.length !== 4) {
    return false;
  }
  
  // Verifica se todos os valores são válidos
  if (networkParts.some(p => isNaN(p) || p < 0 || p > 255) ||
      ipParts.some(p => isNaN(p) || p < 0 || p > 255)) {
    return false;
  }
  
  const mask = (0xFFFFFFFF << (32 - prefixLength)) >>> 0;
  const networkNum = (networkParts[0] << 24) + (networkParts[1] << 16) + (networkParts[2] << 8) + networkParts[3];
  const ipNum = (ipParts[0] << 24) + (ipParts[1] << 16) + (ipParts[2] << 8) + ipParts[3];
  
  return (networkNum & mask) === (ipNum & mask);
}

function validateESP32Authorization(req) {
  const rawClientIp = ip(req);
  const clientIp = normalizeIp(rawClientIp);
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
      // Suporta CIDR básico (ex: 192.168.1.0/24) ou IP exato
      if (allowedIp.includes('/')) {
        return ipInCidr(clientIp, allowedIp);
      } else {
        // Normaliza o IP permitido também para comparação
        const normalizedAllowedIp = normalizeIp(allowedIp);
        return clientIp === normalizedAllowedIp;
      }
    });
    
    if (!isAllowed) {
      result.authorized = false;
      result.reason = 'ip_not_allowed';
      result.checks.ip = {
        passed: false,
        message: `IP não autorizado`
      };
      return result;
    } else {
      result.checks.ip = {
        passed: true,
        message: `IP autorizado`
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

// Usa apenas API Oficial do WhatsApp Business
if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
  err(`[FATAL] WHATSAPP_ACCESS_TOKEN e WHATSAPP_PHONE_NUMBER_ID são obrigatórios.`);
  err(`[FATAL] Configure essas variáveis no arquivo .env para usar a API Oficial do WhatsApp Business.`);
  process.exit(1);
}

log(`[INIT] Usando API Oficial do WhatsApp Business`);
try {
  log(`[INIT] Carregando módulo whatsapp-official...`);
  const { initWhatsAppOfficialModule } = require('./modules/whatsapp-official');
  log(`[INIT] Módulo whatsapp-official carregado com sucesso`);
  
  log(`[INIT] Inicializando módulo WhatsApp Official...`);
  log(`[INIT] Parâmetros: camera=${!!camera}, tuya=${!!tuya}, whatsappMaxVideoSizeMB=${WHATSAPP_MAX_VIDEO_SIZE_MB}`);
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
    ipBlocker,
    numbersFile: NUMBERS_FILE,
    recordDurationSec: RECORD_DURATION_SEC,
    whatsappMaxVideoSizeMB: WHATSAPP_MAX_VIDEO_SIZE_MB
  });
  log(`[INIT] Módulo WhatsApp Official inicializado com sucesso`);
} catch (whatsappError) {
  err(`[FATAL] Erro ao inicializar módulo WhatsApp Official:`, whatsappError.message);
  err(`[FATAL] Stack:`, whatsappError.stack);
  process.exit(1);
}

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
let routesModule;
try {
  log(`[INIT] Inicializando módulo Routes...`);
  routesModule = initRoutesModule({
    app,
    whatsapp,
    camera,
    tuya: (TUYA_CLIENT_ID && TUYA_CLIENT_SECRET) ? tuya : null,
    utils: { requestId, normalizeBR, readNumbersFromFile, getClientIp, isNumberAuthorized },
    logger,
    auth,
    verifySignedRequest,
    validateESP32Authorization,
    numbersFile: NUMBERS_FILE,
    cameraSnapshotUrl: CAMERA_SNAPSHOT_URL,
    authDataPath: AUTH_DATA_PATH,
    tuyaUid: TUYA_UID,
    recordingsDir: RECORDINGS_DIR,
    minSnapshotIntervalMs: MIN_SNAPSHOT_INTERVAL_MS,
    enableVideoRecording: ENABLE_VIDEO_RECORDING,
    videoRecordDurationSec: VIDEO_RECORD_DURATION_SEC,
    minVideoRecordIntervalMs: MIN_VIDEO_RECORD_INTERVAL_MS,
    strictRateLimit // Passa rate limit estrito para endpoints críticos
  });
  log(`[INIT] Módulo Routes inicializado com sucesso`);
} catch (routesError) {
  err(`[FATAL] Erro ao inicializar módulo Routes:`, routesError.message);
  err(`[FATAL] Stack:`, routesError.stack);
  process.exit(1);
}

// Passa função de processamento de vídeos temporários para o módulo WhatsApp
try {
  if (whatsapp && routesModule) {
    dbg(`[INIT] Verificando funções do routesModule...`);
    dbg(`[INIT] routesModule.processTempVideo:`, typeof routesModule.processTempVideo);
    dbg(`[INIT] routesModule.listVideos:`, typeof routesModule.listVideos);
    
    if (routesModule.processTempVideo && whatsapp.setTempVideoProcessor) {
      whatsapp.setTempVideoProcessor(routesModule.processTempVideo);
      log(`[INIT] Processador de vídeos temporários configurado`);
    } else {
      warn(`[INIT] processTempVideo não disponível ou setTempVideoProcessor não existe`);
    }
    
    if (routesModule.listVideos && whatsapp.setListVideosFunction) {
      whatsapp.setListVideosFunction(routesModule.listVideos);
      log(`[INIT] Função de listagem de vídeos configurada`);
    } else {
      warn(`[INIT] listVideos não disponível (tipo: ${typeof routesModule.listVideos}) ou setListVideosFunction não existe`);
      if (whatsapp.setListVideosFunction) {
        dbg(`[INIT] setListVideosFunction existe`);
      } else {
        warn(`[INIT] setListVideosFunction não existe no módulo WhatsApp`);
      }
    }
    
    // Configura função de trigger de snapshot
    if (whatsapp.setTriggerSnapshotFunction) {
      whatsapp.setTriggerSnapshotFunction(async (message, from) => {
        // Cria um wrapper que chama triggerSnapshotForWS mas adapta para o formato esperado
        const result = await triggerSnapshotForWS(message || '📸 Snapshot solicitado manualmente', from || 'whatsapp');
        return result;
      });
      log(`[INIT] Função de trigger de snapshot configurada`);
    } else {
      warn(`[INIT] setTriggerSnapshotFunction não existe no módulo WhatsApp`);
    }
  } else {
    warn(`[INIT] whatsapp ou routesModule não disponível`);
  }
} catch (tempVideoError) {
  err(`[FATAL] Erro ao configurar processador de vídeos temporários:`, tempVideoError.message);
  err(`[FATAL] Stack:`, tempVideoError.stack);
  process.exit(1);
}

/* ===== Tuya Monitor Module ===== */
let tuyaMonitor = null;
if (TUYA_MONITOR_ENABLED && TUYA_CLIENT_ID && TUYA_CLIENT_SECRET && whatsapp) {
  try {
    log(`[INIT] Inicializando módulo Tuya Monitor...`);
    
    // Obtém números para notificação
    let notificationNumbers = TUYA_MONITOR_NOTIFICATION_NUMBERS;
    if (notificationNumbers.length === 0) {
      // Se não especificado, usa números autorizados do WhatsApp
      try {
        notificationNumbers = readNumbersFromFile(NUMBERS_FILE);
        log(`[TUYA-MONITOR] Usando ${notificationNumbers.length} número(s) autorizado(s) para notificações`);
      } catch (e) {
        warn(`[TUYA-MONITOR] Erro ao ler números autorizados:`, e.message);
        notificationNumbers = [];
      }
    }
    
    tuyaMonitor = initTuyaMonitorModule({
      tuya: (TUYA_CLIENT_ID && TUYA_CLIENT_SECRET) ? tuya : null,
      whatsapp,
      logger,
      appRoot: APP_ROOT,
      tuyaUid: TUYA_UID,
      alertThresholdHours: TUYA_MONITOR_ALERT_HOURS,
      checkIntervalMinutes: TUYA_MONITOR_CHECK_INTERVAL_MINUTES,
      notificationNumbers
    });
    
    if (tuyaMonitor) {
      tuyaMonitor.startMonitoring();
      log(`[INIT] Módulo Tuya Monitor inicializado e iniciado com sucesso`);
      log(`[INIT] Monitoramento: alerta após ${TUYA_MONITOR_ALERT_HOURS}h, verificação a cada ${TUYA_MONITOR_CHECK_INTERVAL_MINUTES}min`);
      if (notificationNumbers.length > 0) {
        log(`[INIT] Notificações serão enviadas para ${notificationNumbers.length} número(s)`);
      } else {
        warn(`[INIT] Nenhum número configurado para receber notificações`);
      }
    }
  } catch (monitorError) {
    warn(`[INIT] Erro ao inicializar módulo Tuya Monitor:`, monitorError.message);
    // Não encerra a aplicação se o monitor falhar
  }
} else {
  if (!TUYA_MONITOR_ENABLED) {
    log(`[INIT] Módulo Tuya Monitor desabilitado (TUYA_MONITOR_ENABLED=false)`);
  } else if (!TUYA_CLIENT_ID || !TUYA_CLIENT_SECRET) {
    log(`[INIT] Módulo Tuya Monitor desabilitado (credenciais Tuya não configuradas)`);
  } else if (!whatsapp) {
    log(`[INIT] Módulo Tuya Monitor desabilitado (módulo WhatsApp não disponível)`);
  }
}

/* ===== Webhook para API Oficial do WhatsApp ===== */
if (USE_OFFICIAL_API && WHATSAPP_ACCESS_TOKEN && WHATSAPP_PHONE_NUMBER_ID) {
  // Endpoint de verificação do webhook (GET)
  app.get('/webhook/whatsapp', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'] || '';
    const challenge = req.query['hub.challenge'] || '';
    
    // Debug detalhado
    dbg(`[WEBHOOK] Verificação recebida:`);
    dbg(`[WEBHOOK] Mode: ${mode}`);
    dbg(`[WEBHOOK] Token recebido (length: ${token.length}): ${token}`);
    dbg(`[WEBHOOK] Token esperado (length: ${WHATSAPP_WEBHOOK_VERIFY_TOKEN.length}): ${WHATSAPP_WEBHOOK_VERIFY_TOKEN}`);
    dbg(`[WEBHOOK] Challenge: ${challenge}`);
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
      
      // Log detalhado do webhook recebido
      dbg(`[WEBHOOK] Webhook recebido:`, JSON.stringify(body, null, 2));
      
      // Verifica se é uma notificação do WhatsApp
      if (body.object === 'whatsapp_business_account') {
        for (const entry of body.entry || []) {
          log(`[WEBHOOK] Processando entry:`, entry.id);
          await whatsapp.processWebhookMessage(entry);
        }
        res.sendStatus(200);
      } else {
        dbg(`[WEBHOOK] Objeto desconhecido recebido: ${body.object}`);
        res.sendStatus(200);
      }
    } catch (error) {
      err(`[WEBHOOK] Erro ao processar webhook:`, error.message);
      err(`[WEBHOOK] Stack:`, error.stack);
      res.sendStatus(500);
    }
  });
  
  log(`[WEBHOOK] Endpoints de webhook configurados:`);
  log(`[WEBHOOK] GET  /webhook/whatsapp - Verificação`);
  log(`[WEBHOOK] POST /webhook/whatsapp - Recebimento de mensagens`);
}

// Tratamento de erros não capturados
process.on('uncaughtException', (error) => {
  err(`[FATAL] Erro não capturado:`, error.message);
  err(`[FATAL] Stack:`, error.stack);
  log(`═══════════════════════════════════════════════════════════`);
  log(`🛑 [SHUTDOWN] Processo finalizado devido a erro não capturado`);
  log(`📅 [SHUTDOWN] Data/Hora: ${nowISO()}`);
  log(`🆔 [SHUTDOWN] PID: ${process.pid}`);
  log(`═══════════════════════════════════════════════════════════`);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  const errorMsg = reason?.message || String(reason) || 'Erro desconhecido';
  const errorStack = reason?.stack || 'N/A';
  
  // Ignora erros conhecidos do WhatsApp Web.js que não são críticos
  if (errorMsg.includes('Minified invariant') || 
      errorMsg.includes('Evaluation failed') ||
      errorMsg.includes('Invalid value') ||
      errorMsg.includes('getStorage') ||
      errorMsg.includes('getMetaTable')) {
    warn(`[WHATSAPP] Erro não crítico do WhatsApp Web.js ignorado: ${errorMsg}`);
    if (DEBUG) {
      warn(`[WHATSAPP] Stack: ${errorStack}`);
    }
    return; // Não encerra o processo
  }
  
  err(`[FATAL] Promise rejeitada não tratada:`, reason);
  if (reason && reason.stack) {
    err(`[FATAL] Stack:`, reason.stack);
  }
  log(`═══════════════════════════════════════════════════════════`);
  log(`🛑 [SHUTDOWN] Processo finalizado devido a promise rejeitada`);
  log(`📅 [SHUTDOWN] Data/Hora: ${nowISO()}`);
  log(`🆔 [SHUTDOWN] PID: ${process.pid}`);
  log(`═══════════════════════════════════════════════════════════`);
  process.exit(1);
});

// Handlers para graceful shutdown (SIGTERM, SIGINT)
let server = null;
let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    warn(`[SHUTDOWN] Já está em processo de encerramento, forçando saída...`);
    process.exit(1);
    return;
  }
  
  isShuttingDown = true;
  log(`═══════════════════════════════════════════════════════════`);
  log(`🛑 [SHUTDOWN] Recebido sinal: ${signal}`);
  log(`📅 [SHUTDOWN] Data/Hora: ${nowISO()}`);
  log(`🆔 [SHUTDOWN] PID: ${process.pid}`);
  log(`⏳ [SHUTDOWN] Iniciando encerramento graceful...`);
  log(`═══════════════════════════════════════════════════════════`);
  
  // Para o monitor Tuya se estiver ativo
  if (tuyaMonitor && tuyaMonitor.stopMonitoring) {
    try {
      log(`[SHUTDOWN] Parando monitor Tuya...`);
      tuyaMonitor.stopMonitoring();
      log(`[SHUTDOWN] Monitor Tuya parado`);
    } catch (e) {
      warn(`[SHUTDOWN] Erro ao parar monitor Tuya:`, e.message);
    }
  }
  
  // Fecha conexão com banco de IPs bloqueados
  if (ipBlocker && ipBlocker.close) {
    try {
      log(`[SHUTDOWN] Fechando banco de IPs bloqueados...`);
      await ipBlocker.close();
      log(`[SHUTDOWN] Banco de IPs bloqueados fechado`);
    } catch (e) {
      warn(`[SHUTDOWN] Erro ao fechar banco de IPs bloqueados:`, e.message);
    }
  }
  
  // Fecha WebSocket ESP32
  if (wsESP32 && wsESP32.close) {
    try {
      log(`[SHUTDOWN] Fechando WebSocket ESP32...`);
      wsESP32.close();
      log(`[SHUTDOWN] WebSocket ESP32 fechado`);
    } catch (e) {
      warn(`[SHUTDOWN] Erro ao fechar WebSocket ESP32:`, e.message);
    }
  }
  
  // Fecha o servidor HTTP
  if (server) {
    server.close(() => {
      log(`[SHUTDOWN] Servidor HTTP fechado`);
      log(`═══════════════════════════════════════════════════════════`);
      log(`✅ [SHUTDOWN] Processo finalizado com sucesso`);
      log(`📅 [SHUTDOWN] Data/Hora: ${nowISO()}`);
      log(`🆔 [SHUTDOWN] PID: ${process.pid}`);
      log(`═══════════════════════════════════════════════════════════`);
      process.exit(0);
    });
    
    // Timeout de 10 segundos para forçar encerramento
    setTimeout(() => {
      warn(`[SHUTDOWN] Timeout de encerramento, forçando saída...`);
      process.exit(1);
    }, 10000);
  } else {
    log(`═══════════════════════════════════════════════════════════`);
    log(`✅ [SHUTDOWN] Processo finalizado`);
    log(`📅 [SHUTDOWN] Data/Hora: ${nowISO()}`);
    log(`🆔 [SHUTDOWN] PID: ${process.pid}`);
    log(`═══════════════════════════════════════════════════════════`);
    process.exit(0);
  }
}

// Registra handlers para sinais de encerramento
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Funções auxiliares para WebSocket ESP32
async function checkApiStatusForWS() {
  try {
    if (!whatsapp || !whatsapp.isReady) {
      return false;
    }
    const isReady = whatsapp.isReady();
    return isReady === true;
  } catch (e) {
    warn(`[WS-ESP32] Erro ao verificar status da API:`, e.message);
    return false;
  }
}

async function triggerSnapshotForWS(message, clientIp) {
  const rid = requestId();
  try {
    if (!whatsapp || !whatsapp.isReady || !whatsapp.isReady()) {
      return { ok: false, error: 'whatsapp not ready' };
    }
    
    if (!camera || !CAMERA_SNAPSHOT_URL) {
      return { ok: false, error: 'camera not configured' };
    }
    
    const { base64, mimeType } = await camera.downloadSnapshot(CAMERA_SNAPSHOT_URL);
    const numbers = readNumbersFromFile(NUMBERS_FILE);
    
    if (numbers.length === 0) {
      return { ok: false, error: 'no numbers found' };
    }
    
    // Resolve números do WhatsApp
    const numberResolutions = await Promise.all(
      numbers.map(async (rawPhone) => {
        try {
          const normalized = normalizeBR(rawPhone);
          if (whatsapp.resolveWhatsAppNumber) {
            const { id: numberId } = await whatsapp.resolveWhatsAppNumber(normalized);
            return { normalized, numberId, success: numberId !== null };
          }
          return { normalized, numberId: null, success: false };
        } catch (e) {
          return { normalized: rawPhone, numberId: null, success: false };
        }
      })
    );
    
    const validNumbers = numberResolutions.filter(n => n.success && n.numberId);
    
    if (validNumbers.length === 0) {
      return { ok: false, error: 'no valid numbers' };
    }
    
    // Envia snapshot para todos os números válidos
    const sendPromises = validNumbers.map(async ({ normalized, numberId }) => {
      try {
        // Para API oficial, usa o número normalizado diretamente
        const to = numberId?._serialized || normalized.replace(/^\+/, '') || normalized;
        if (whatsapp.sendMediaFromBase64) {
          await whatsapp.sendMediaFromBase64(to, base64, mimeType, message || '📸 Snapshot da câmera');
        } else {
          return { success: false, error: 'send method not available' };
        }
        return { success: true, phone: normalized };
      } catch (e) {
        return { success: false, phone: normalized, error: e.message };
      }
    });
    
    const results = await Promise.all(sendPromises);
    const successCount = results.filter(r => r.success).length;
    
    // Inicia gravação de vídeo em background (não bloqueia)
    if (ENABLE_VIDEO_RECORDING && camera && camera.buildRTSPUrl && camera.recordRTSPVideo) {
      const rtspUrl = camera.buildRTSPUrl();
      if (rtspUrl) {
        // Verifica intervalo mínimo entre gravações
        const now = Date.now();
        const timeSinceLastVideo = now - lastVideoRecordTimeWS;
        
        if (timeSinceLastVideo < MIN_VIDEO_RECORD_INTERVAL_MS) {
          const secondsRemaining = Math.ceil((MIN_VIDEO_RECORD_INTERVAL_MS - timeSinceLastVideo) / 1000);
          log(`[WS-ESP32] Gravação de vídeo ignorada - cooldown ativo (${secondsRemaining}s restantes)`);
        } else {
          (async () => {
            try {
              const fakeMessage = { from: 'system', reply: async () => {} };
              const result = await camera.recordRTSPVideo(rtspUrl, VIDEO_RECORD_DURATION_SEC, fakeMessage);
            if (result.success && result.filePath) {
              const finalVideoPath = await camera.compressVideoIfNeeded(result.filePath, fakeMessage);
              // Registra vídeo temporário usando a mesma lógica do routes
              // (registerTempVideo não é exportado, então fazemos manualmente)
              let videoId = null;
              try {
                const tempVideosDBPath = path.join(RECORDINGS_DIR, 'temp_videos', 'videos.json');
                const VIDEO_EXPIRY_HOURS = 24;
                
                let db = {};
                if (fs.existsSync(tempVideosDBPath)) {
                  db = JSON.parse(fs.readFileSync(tempVideosDBPath, 'utf8'));
                }
                
                videoId = `video_${Date.now()}_${Math.random().toString(36).substring(7)}`;
                const expiresAt = Date.now() + (VIDEO_EXPIRY_HOURS * 60 * 60 * 1000);
                const phoneNumbers = validNumbers.map(n => normalizeBR(n.normalized));
                
                db[videoId] = {
                  filePath: finalVideoPath,
                  phoneNumbers,
                  createdAt: Date.now(),
                  expiresAt,
                  expiresAtISO: new Date(expiresAt).toISOString()
                };
                
                // Cria diretório se não existir
                const dbDir = path.dirname(tempVideosDBPath);
                if (!fs.existsSync(dbDir)) {
                  fs.mkdirSync(dbDir, { recursive: true });
                }
                
                fs.writeFileSync(tempVideosDBPath, JSON.stringify(db, null, 2));
                log(`[WS-ESP32] Vídeo registrado: ${videoId}`);
                
                // Atualiza timestamp APÓS gravação terminar
                lastVideoRecordTimeWS = Date.now();
                log(`[WS-ESP32] Timestamp de gravação atualizado: ${new Date(lastVideoRecordTimeWS).toISOString()}`);
                
                // Envia mensagem com botões para todos os números que receberam a imagem
                if (videoId && validNumbers.length > 0) {
                  log(`[WS-ESP32] Enviando notificação de vídeo para ${validNumbers.length} número(s)...`);
                  
                  // Aguarda um pouco para garantir que tudo está processado
                  await new Promise(resolve => setTimeout(resolve, 1000));
                  
                  for (const { normalized, numberId } of validNumbers) {
                    try {
                      const to = numberId._serialized || normalized.replace(/^\+/, '') || normalized;
                      
                      if (whatsapp.sendInteractiveButtons) {
                        // API Oficial - usa botões interativos
                        log(`[WS-ESP32] Enviando botões interativos para ${to}...`);
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
                          log(`[WS-ESP32] ✅ Botões interativos enviados com sucesso para ${to}`);
                        } catch (buttonError) {
                          err(`[WS-ESP32] ❌ Erro ao enviar botões interativos para ${to}:`, buttonError.message);
                          // Tenta fallback para texto
                          try {
                            await whatsapp.sendTextMessage(to, `🎥 *Vídeo Gravado*\n\nFoi gravado um vídeo de ${VIDEO_RECORD_DURATION_SEC} segundos.\n\nDigite: \`!video ${videoId}\` para ver o vídeo (válido por 24 horas)`);
                            log(`[WS-ESP32] ✅ Mensagem de texto enviada como fallback para ${to}`);
                          } catch (textError) {
                            err(`[WS-ESP32] ❌ Erro ao enviar mensagem de texto:`, textError.message);
                          }
                        }
                      } else {
                        warn(`[WS-ESP32] sendInteractiveButtons não disponível, enviando mensagem de texto`);
                        await whatsapp.sendTextMessage(to, `🎥 *Vídeo Gravado*\n\nFoi gravado um vídeo de ${VIDEO_RECORD_DURATION_SEC} segundos.\n\nDigite: \`!video ${videoId}\` para ver o vídeo (válido por 24 horas)`);
                        log(`[WS-ESP32] ✅ Mensagem de texto enviada para ${to}`);
                      }
                    } catch (sendError) {
                      err(`[WS-ESP32] ❌ Erro ao enviar notificação de vídeo para ${normalized}:`, sendError.message);
                    }
                  }
                }
              } catch (e) {
                warn(`[WS-ESP32] Erro ao registrar vídeo:`, e.message);
              }
            } else {
              // Atualiza timestamp mesmo em caso de falha
              lastVideoRecordTimeWS = Date.now();
            }
          } catch (e) {
            warn(`[WS-ESP32] Erro ao gravar vídeo:`, e.message);
            // Atualiza timestamp mesmo em caso de erro
            lastVideoRecordTimeWS = Date.now();
          }
        })();
        }
      }
    }
    
    return { 
      ok: true, 
      successCount, 
      totalCount: results.length,
      requestId: rid
    };
  } catch (e) {
    err(`[WS-ESP32] Erro ao processar snapshot:`, e.message);
    return { ok: false, error: e.message, requestId: rid };
  }
}

// ===== MIDDLEWARE GLOBAL DE VALIDAÇÃO DE IP =====
// Valida TODAS as requisições, verifica no AbuseIPDB e incrementa contadores
// DEVE ser adicionado ANTES de qualquer rota ser registrada
if (ENABLE_GLOBAL_IP_VALIDATION && ipBlocker && abuseIPDB) {
  log(`[INIT] Habilitando validação global de IPs (verificação AbuseIPDB em todas as requisições)`);
  
  // Função para verificar se IP é local
  function isLocalIP(ip) {
    if (!ip || ip === 'unknown' || ip === 'localhost') return true;
    
    // Remove prefixo IPv6
    let normalizedIp = ip;
    if (normalizedIp.startsWith('::ffff:')) {
      normalizedIp = normalizedIp.substring(7);
    }
    
    // IPs locais
    if (normalizedIp === '127.0.0.1' || normalizedIp === '::1') return true;
    
    // Verifica ranges privados
    const parts = normalizedIp.split('.');
    if (parts.length === 4) {
      const [a, b] = parts.map(Number);
      
      // 10.0.0.0/8
      if (a === 10) return true;
      
      // 192.168.0.0/16
      if (a === 192 && b === 168) return true;
      
      // 172.16.0.0/12
      if (a === 172 && b >= 16 && b <= 31) return true;
      
      // 127.0.0.0/8
      if (a === 127) return true;
      
      // 169.254.0.0/16 (link-local)
      if (a === 169 && b === 254) return true;
    }
    
    return false;
  }
  
  // Função para verificar se IP está na whitelist
  function isWhitelisted(ip) {
    if (!ip || ip === 'unknown') return false;
    
    // Combina whitelists
    const allWhitelists = [...IP_WHITELIST, ...GLOBAL_IP_WHITELIST, ...ESP32_ALLOWED_IPS];
    
    if (allWhitelists.length === 0) return false;
    
    let normalizedIp = ip;
    if (normalizedIp.startsWith('::ffff:')) {
      normalizedIp = normalizedIp.substring(7);
    }
    
    return allWhitelists.some(allowedIp => {
      if (allowedIp.includes('/')) {
        // CIDR notation
        return ipInCidr(normalizedIp, allowedIp);
      }
      return normalizeIp(normalizedIp) === normalizeIp(allowedIp);
    });
  }
  
  // Middleware global de validação de IP (DEVE ser ANTES de todas as rotas)
  app.use(async (req, res, next) => {
    // Ignora arquivos estáticos e health checks
    if (req.path.startsWith('/admin/static/') || 
        req.path === '/health' || 
        req.path === '/favicon.ico') {
      return next();
    }
    
    const clientIp = getClientIp(req);
    let normalizedIp = clientIp;
    if (normalizedIp && normalizedIp.startsWith('::ffff:')) {
      normalizedIp = normalizedIp.substring(7);
    }
    
    // Se IP é local ou está na whitelist do ENV, permite sem validação
    if (isLocalIP(normalizedIp) || isWhitelisted(normalizedIp)) {
      dbg(`[IP-VALIDATION] IP ${normalizedIp} é local ou whitelisted - permitindo sem validação`);
      return next();
    }
    
    // Para outros IPs, valida e incrementa contador
    if (normalizedIp && normalizedIp !== 'unknown') {
      // Registra requisição do IP e rota nas estatísticas
      // O statisticsModel já salva no banco automaticamente
      if (global.statisticsModel) {
        global.statisticsModel.incrementIPRequest(normalizedIp);
        global.statisticsModel.incrementRoute(req.path);
      }
      
      // Também salva diretamente no banco via ipBlocker (garante persistência)
      if (ipBlocker && ipBlocker._ready && ipBlocker._ready()) {
        if (ipBlocker.incrementIPStat) {
          ipBlocker.incrementIPStat(normalizedIp).catch((err) => {
            dbg(`[IP-VALIDATION] Erro ao salvar IP no banco:`, err.message);
          });
        }
        if (ipBlocker.incrementRouteStat) {
          ipBlocker.incrementRouteStat(req.path).catch((err) => {
            dbg(`[IP-VALIDATION] Erro ao salvar rota no banco:`, err.message);
          });
        }
      }
      
      // Verifica primeiro se IP já está bloqueado (síncrono - bloqueia requisição)
      if (ipBlocker.isBlocked) {
        try {
          const isBlocked = await Promise.race([
            ipBlocker.isBlocked(normalizedIp),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 1000))
          ]);
          
          if (isBlocked) {
            warn(`[IP-VALIDATION] 🚫 Requisição bloqueada: IP ${normalizedIp} está na lista de bloqueados`);
            // Retorna 404 genérico para não revelar que o IP está bloqueado
            return res.status(404).send('Not Found');
          }
        } catch (err) {
          // Se timeout ou erro, permite a requisição (fail-open)
          dbg(`[IP-VALIDATION] Erro ao verificar se IP está bloqueado (permitindo requisição):`, err.message);
        }
      }
      
      // Verifica se IP está na whitelist ou yellowlist do banco (não vencido)
      let shouldCheckAbuseIPDB = true;
      if (ipBlocker.isInWhitelist && ipBlocker.isInYellowlist) {
        try {
          const [inWhitelist, inYellowlist] = await Promise.all([
            Promise.race([
              ipBlocker.isInWhitelist(normalizedIp),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 500))
            ]).catch(() => ({ inWhitelist: false })),
            Promise.race([
              ipBlocker.isInYellowlist(normalizedIp),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 500))
            ]).catch(() => ({ inYellowlist: false }))
          ]);
          
          // Verifica se o resultado é um objeto com a propriedade inWhitelist/inYellowlist
          const isInWhitelist = inWhitelist && (inWhitelist.inWhitelist === true || inWhitelist === true);
          const isInYellowlist = inYellowlist && (inYellowlist.inYellowlist === true || inYellowlist === true);
          
          if (isInWhitelist || isInYellowlist) {
            dbg(`[IP-VALIDATION] IP ${normalizedIp} encontrado na ${isInWhitelist ? 'whitelist' : 'yellowlist'} - não consultando AbuseIPDB`);
            if (isInWhitelist && inWhitelist.expiresAt) {
              const now = Math.floor(Date.now() / 1000);
              dbg(`[IP-VALIDATION] IP ${normalizedIp} whitelist válido até ${inWhitelist.expiresAt}, now=${now}`);
            }
            shouldCheckAbuseIPDB = false;
          }
        } catch (err) {
          dbg(`[IP-VALIDATION] Erro ao verificar listas (consultando AbuseIPDB):`, err.message);
        }
      }
      
      // Incrementa contador de tentativas (não bloqueia, apenas registra)
      if (ipBlocker.recordIPAttempt) {
        ipBlocker.recordIPAttempt(normalizedIp).catch(err => {
          dbg(`[IP-VALIDATION] Erro ao registrar tentativa para ${normalizedIp}:`, err.message);
        });
      }
      
      // Verifica no AbuseIPDB APENAS se não estiver nas listas
      if (shouldCheckAbuseIPDB && abuseIPDB.checkIP) {
        abuseIPDB.checkIP(normalizedIp, 90, false)
          .then(result => {
            if (result && result.abuseConfidence !== undefined) {
              dbg(`[IP-VALIDATION] IP ${normalizedIp} verificado no AbuseIPDB: ${result.abuseConfidence}% confiança, ${result.reports || 0} report(s)`);
              
              // Se confiança alta, bloqueia automaticamente
              if (result.abuseConfidence >= 75 && ipBlocker.blockIP) {
                ipBlocker.isBlocked(normalizedIp).then(isBlocked => {
                  if (!isBlocked) {
                    log(`[IP-VALIDATION] 🚫 Bloqueando IP ${normalizedIp} automaticamente (confiança: ${result.abuseConfidence}%)`);
                    ipBlocker.blockIP(normalizedIp, `Alta confiança de abuso (${result.abuseConfidence}%) - verificação automática`)
                      .then(() => {
                        log(`[IP-VALIDATION] ✅ IP ${normalizedIp} bloqueado com sucesso`);
                      })
                      .catch(err => {
                        warn(`[IP-VALIDATION] ❌ Erro ao bloquear IP ${normalizedIp}:`, err.message);
                      });
                  }
                }).catch(() => {});
              }
            }
          })
          .catch(err => {
            dbg(`[IP-VALIDATION] Erro ao verificar IP ${normalizedIp} no AbuseIPDB:`, err.message);
          });
      }
    }
    
    // Continua com a requisição
    next();
  });
  
  log(`[INIT] ✅ Middleware global de validação de IP habilitado`);
} else {
  if (!ENABLE_GLOBAL_IP_VALIDATION) {
    log(`[INIT] ⚠️ Validação global de IP desabilitada (ENABLE_GLOBAL_IP_VALIDATION=false)`);
  } else if (!ipBlocker) {
    warn(`[INIT] ⚠️ Validação global de IP desabilitada (módulo IP Blocker não disponível)`);
  } else if (!abuseIPDB) {
    warn(`[INIT] ⚠️ Validação global de IP desabilitada (módulo AbuseIPDB não disponível)`);
  }
}

// Inicializa WebSocket ESP32 (após servidor estar pronto)
let wsESP32 = null;
let lastVideoRecordTimeWS = 0; // Timestamp da última gravação via WebSocket

// Inicia o servidor
server = app.listen(PORT, () => { 
  log(`═══════════════════════════════════════════════════════════`);
  log(`✅ [SERVER] Servidor HTTP iniciado com sucesso`);
  log(`🌐 [SERVER] Ouvindo na porta: ${PORT}`);
  log(`📅 [SERVER] Data/Hora: ${nowISO()}`);
  log(`🆔 [SERVER] PID: ${process.pid}`);
  if (DEBUG) log(`🔍 [SERVER] DEBUG ativo`);
  if (USE_OFFICIAL_API && WHATSAPP_ACCESS_TOKEN && WHATSAPP_PHONE_NUMBER_ID) {
    log(`[SERVER] API Oficial do WhatsApp Business ativa`);
    const webhookUrl = WHATSAPP_WEBHOOK_DOMAIN.startsWith('http') 
      ? `${WHATSAPP_WEBHOOK_DOMAIN}/webhook/whatsapp`
      : `https://${WHATSAPP_WEBHOOK_DOMAIN}/webhook/whatsapp`;
    log(`[SERVER] Configure o webhook no Meta: ${webhookUrl}`);
    log(`[SERVER] Token de verificação: ${WHATSAPP_WEBHOOK_VERIFY_TOKEN}`);
    log(`[SERVER] Phone Number ID: ${WHATSAPP_PHONE_NUMBER_ID}`);
  }
  
  // Inicializa WebSocket ESP32 após servidor estar pronto
  try {
    wsESP32 = initWebSocketESP32Module({
      server,
      logger,
      validateESP32Authorization,
      triggerSnapshot: triggerSnapshotForWS,
      checkApiStatus: checkApiStatusForWS,
      ESP32_TOKEN,
      ESP32_ALLOWED_IPS
    });
    log(`[SERVER] WebSocket ESP32 inicializado em /ws/esp32`);
  } catch (wsError) {
    warn(`[SERVER] Erro ao inicializar WebSocket ESP32:`, wsError.message);
  }
  
  log(`═══════════════════════════════════════════════════════════`);
  
  /* ===== Admin Module ===== */
  let adminModule = null;
  try {
    log(`[INIT] Inicializando módulo Admin...`);
    log(`[INIT] Verificando ipBlocker: ${ipBlocker ? 'disponível' : 'NÃO DISPONÍVEL'}`);
    log(`[INIT] Tipo de ipBlocker: ${typeof ipBlocker}`);
    log(`[INIT] Valor de ipBlocker: ${ipBlocker}`);
    if (ipBlocker) {
      const functions = Object.keys(ipBlocker).filter(key => typeof ipBlocker[key] === 'function');
      log(`[INIT] ipBlocker funções (${functions.length}): ${functions.join(', ')}`);
    } else {
      err(`[INIT] ⚠️ ATENÇÃO: ipBlocker é null/undefined - admin não terá acesso às funcionalidades de IP`);
      err(`[INIT] ⚠️ Verifique se houve erro na inicialização do módulo IP Blocker acima`);
    }
    // Expõe APP_ROOT globalmente para Statistics
    global.APP_ROOT = APP_ROOT;
    
    adminModule = initAdminModule({
      app,
      appRoot: APP_ROOT,
      logger,
      getCurrentIpBlocker: () => ipBlocker, // Função getter para acesso dinâmico
      whatsappOfficial: whatsapp,
      websocketESP32: wsESP32,
      getClientIp: getClientIp
    });
    log(`[INIT] Módulo Admin inicializado com sucesso`);
  } catch (adminError) {
    warn(`[INIT] Erro ao inicializar módulo Admin:`, adminError.message);
    warn(`[INIT] Stack:`, adminError.stack);
  }
  
  // Middleware para rastrear rotas nas estatísticas
  app.use((req, res, next) => {
    if (global.statisticsModel) {
      global.statisticsModel.incrementRoute(req.path);
    }
    // Também salva diretamente no banco (garante persistência)
    if (ipBlocker && ipBlocker._ready && ipBlocker._ready() && ipBlocker.incrementRouteStat) {
      ipBlocker.incrementRouteStat(req.path).catch((err) => {
        dbg(`[ROUTE-TRACK] Erro ao salvar rota no banco:`, err.message);
      });
    }
    next();
  });

// Middleware para rotas não configuradas (deve ser o último, após todas as rotas)
  app.use((req, res) => {
    const clientIp = getClientIp(req);
    const normalizedIp = normalizeIp(clientIp);
    const path = req.path.toLowerCase();
    
    // Ignora rotas administrativas (já registradas pelo módulo admin)
    if (path.startsWith('/admin')) {
      // Se chegou aqui, a rota admin não foi encontrada - retorna 404
      res.status(404).json({ 
        error: 'not_found',
        message: 'Rota administrativa não encontrada',
        path: req.path
      });
      return;
    }
    
    // Log de tentativa de acesso a rota não configurada
    warn(`[ROUTE] Rota não configurada acessada: ${req.method} ${req.path} | ip=${normalizedIp}`);
    
    // Valida IP no AbuseIPDB para rotas não configuradas
    if (abuseIPDB && abuseIPDB.checkAndBlockIP && normalizedIp && normalizedIp !== 'unknown' && normalizedIp !== 'localhost') {
      // Verifica de forma assíncrona
      abuseIPDB.checkAndBlockIP(normalizedIp, `Tentativa de acesso a rota não configurada: ${req.method} ${req.path}`)
        .then(result => {
          if (result.blocked) {
            log(`[ABUSEIPDB] IP ${normalizedIp} bloqueado automaticamente: ${result.reason}`);
          } else if (result.abuseConfidence > 0) {
            dbg(`[ABUSEIPDB] IP ${normalizedIp} verificado: ${result.abuseConfidence}% confiança, ${result.reports} report(s)`);
          }
        })
        .catch(err => {
          warn(`[ABUSEIPDB] Erro ao verificar IP ${normalizedIp}:`, err.message);
        });
    }
    
    res.status(404).json({ 
      error: 'not_found',
      message: 'Rota não encontrada',
      path: req.path
    });
  });
});