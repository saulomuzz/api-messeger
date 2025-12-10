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
const { initTuyaMonitorModule } = require('./modules/tuya-monitor');
const { initIPBlockerModule } = require('./modules/ip-blocker');

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
const BLOCKED_IPS_FILE = process.env.BLOCKED_IPS_FILE || path.join(APP_ROOT, 'blocked_ips.json');
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
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  crossOriginEmbedderPolicy: false, // Permite CORS para APIs
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));

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
app.use(helmet());
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
  ipBlocker = initIPBlockerModule({
    appRoot: APP_ROOT,
    logger
  });
  log(`[INIT] Módulo IP Blocker inicializado com sucesso`);
} catch (ipBlockerError) {
  err(`[FATAL] Erro ao inicializar módulo IP Blocker:`, ipBlockerError.message);
  err(`[FATAL] Stack:`, ipBlockerError.stack);
  // Não encerra a aplicação, mas loga o erro
}

// Middleware de verificação de IP bloqueado (executado no início de cada requisição)
app.use(async (req, res, next) => {
  const clientIp = getClientIp(req);
  
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
  
  // Verifica se IP está bloqueado no banco
  if (ipBlocker && ipBlocker.isBlocked) {
    try {
      const isBlocked = await ipBlocker.isBlocked(clientIp);
      if (isBlocked) {
        // Registra tentativa de acesso bloqueado
        await ipBlocker.recordBlockedAttempt(clientIp);
        warn(`[SECURITY] Tentativa de acesso de IP bloqueado: ${clientIp} em ${req.path}`);
        return res.status(403).json({ 
          error: 'ip_blocked',
          message: 'IP bloqueado'
        });
      }
    } catch (e) {
      // Em caso de erro, permite acesso mas loga
      dbg(`[SECURITY] Erro ao verificar IP bloqueado:`, e.message);
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

// Sistema de bloqueio de IPs
let blockedIPs = new Set();
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

// Carrega IPs bloqueados do arquivo
function loadBlockedIPs() {
  try {
    if (fs.existsSync(BLOCKED_IPS_FILE)) {
      const data = JSON.parse(fs.readFileSync(BLOCKED_IPS_FILE, 'utf8'));
      blockedIPs = new Set(data.blockedIPs || []);
      log(`[SECURITY] ${blockedIPs.size} IP(s) bloqueado(s) carregado(s)`);
    }
  } catch (e) {
    warn(`[SECURITY] Erro ao carregar IPs bloqueados:`, e.message);
  }
}

// Salva IPs bloqueados
function saveBlockedIPs() {
  try {
    fs.writeFileSync(BLOCKED_IPS_FILE, JSON.stringify({ 
      blockedIPs: Array.from(blockedIPs),
      updatedAt: new Date().toISOString()
    }, null, 2), 'utf8');
  } catch (e) {
    warn(`[SECURITY] Erro ao salvar IPs bloqueados:`, e.message);
  }
}

// Limpa tentativas antigas (mais de 1 hora)
setInterval(() => {
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  for (const [ip, data] of failedAttempts.entries()) {
    if (data.lastAttempt < oneHourAgo) {
      failedAttempts.delete(ip);
    }
  }
}, 60 * 60 * 1000); // A cada hora

// Carrega IPs bloqueados na inicialização
loadBlockedIPs();

// Middleware de detecção de scanners/bots
async function detectScanner(req, res, next) {
  const clientIp = getClientIp(req);
  const path = req.path.toLowerCase();
  
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
      
      // Mantém compatibilidade com sistema antigo (opcional)
      blockedIPs.add(clientIp);
      saveBlockedIPs();
      
      err(`[SECURITY] IP ${clientIp} bloqueado automaticamente por varredura/reconhecimento (${scannerData.suspiciousPaths.size} endpoints suspeitos: ${Array.from(scannerData.suspiciousPaths).join(', ')})`);
      
      // Remove da detecção
      scannerDetection.delete(clientIp);
      
      return res.status(403).json({ 
        error: 'ip_blocked',
        message: 'IP bloqueado por atividade suspeita'
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
        
        // Mantém compatibilidade com sistema antigo (opcional)
        blockedIPs.add(clientIp);
        saveBlockedIPs();
        
        err(`[SECURITY] IP ${clientIp} bloqueado após ${attempts.count} tentativas falhadas`);
        return res.status(403).json({ 
          error: 'ip_blocked',
          message: 'IP bloqueado por múltiplas tentativas falhadas'
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
      // Suporta CIDR básico (ex: 10.10.0.0/23) ou IP exato
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

// Escolhe qual API usar
if (USE_OFFICIAL_API && WHATSAPP_ACCESS_TOKEN && WHATSAPP_PHONE_NUMBER_ID) {
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
let routesModule;
try {
  log(`[INIT] Inicializando módulo Routes...`);
  routesModule = initRoutesModule({
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
    tuyaUid: TUYA_UID,
    recordingsDir: RECORDINGS_DIR,
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
  if (whatsapp && routesModule && routesModule.processTempVideo) {
    if (whatsapp.setTempVideoProcessor) {
      whatsapp.setTempVideoProcessor(routesModule.processTempVideo);
      log(`[INIT] Processador de vídeos temporários configurado`);
    }
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
  log(`═══════════════════════════════════════════════════════════`);
});