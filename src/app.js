require('dotenv').config();

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const axios = require('axios');
const http = require('http');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

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
const APP_ROOT = process.env.APP_ROOT || '/opt/whatsapp-api';
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

// Cache de tipo de autenticação por URL (evita tentar Basic se já sabemos que é Digest)
const authTypeCache = new Map();

/* ===== Tuya API ===== */
const TUYA_CLIENT_ID = process.env.TUYA_CLIENT_ID || '';
const TUYA_CLIENT_SECRET = process.env.TUYA_CLIENT_SECRET || '';
const TUYA_REGION = process.env.TUYA_REGION || 'us'; // us, eu, cn, in
const TUYA_UID = process.env.TUYA_UID || ''; // UID padrão do usuário
const TUYA_BASE_URL = `https://openapi.tuya${TUYA_REGION === 'us' ? 'us' : TUYA_REGION === 'eu' ? 'eu' : TUYA_REGION === 'in' ? 'in' : 'cn'}.com`;
let tuyaAccessToken = null;
let tuyaTokenExpiry = 0;
// Cache para lista de dispositivos (indexado por número/nome)
let tuyaDevicesCache = null;
let tuyaDevicesCacheTime = 0;
const TUYA_DEVICES_CACHE_TTL = 5 * 60 * 1000; // 5 minutos

/* ===== logging ===== */
try {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  if (!fs.existsSync(LOG_PATH)) fs.writeFileSync(LOG_PATH, '');
} catch {}
const append = (l) => { try { fs.appendFileSync(LOG_PATH, l); } catch {} };
const nowISO = () => new Date().toISOString();
const out = (lvl, ...a) => {
  const line = `[${lvl}] ${nowISO()} ${a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')}\n`;
  append(line);
  if (lvl === 'ERROR') console.error(line.trim());
  else if (lvl === 'WARN') console.warn(line.trim());
  else console.log(line.trim());
};
const log  = (...a) => out('INFO', ...a);
const dbg  = (...a) => { if (DEBUG) out('DEBUG', ...a); };
const warn = (...a) => out('WARN', ...a);
const err  = (...a) => out('ERROR', ...a);

// Configura caminho do ffmpeg (depois das funções de logging)
let ffmpegConfigured = false;
if (ffmpegPath) {
  try {
    ffmpeg.setFfmpegPath(ffmpegPath);
    // Verifica se o arquivo existe
    if (fs.existsSync(ffmpegPath)) {
      ffmpegConfigured = true;
      log(`[INIT] FFmpeg configurado: ${ffmpegPath}`);
    } else {
      warn(`[INIT] FFmpeg path não encontrado: ${ffmpegPath}`);
    }
  } catch (e) {
    warn(`[INIT] Erro ao configurar ffmpeg-static:`, e.message);
  }
}

// Fallback: tenta usar ffmpeg do sistema
if (!ffmpegConfigured) {
  const { execSync } = require('child_process');
  try {
    // Verifica se ffmpeg está disponível no PATH
    execSync('which ffmpeg', { stdio: 'ignore' });
    // Se chegou aqui, ffmpeg está disponível
    ffmpegConfigured = true;
    log(`[INIT] Usando ffmpeg do sistema (PATH)`);
  } catch (e) {
    warn(`[INIT] FFmpeg não encontrado no sistema. Instale ffmpeg ou use ffmpeg-static.`);
  }
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

const ip = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || req.ip || 'unknown';

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
function digitsOnly(s) {
  return String(s || '').replace(/\D/g, '');
}

function normalizeBR(input) {
  let d = digitsOnly(input);
  if (d.startsWith('0')) d = d.replace(/^0+/, '');
  if (!d.startsWith('55')) d = '55' + d;
  const nsn = d.slice(2);
  if (nsn.length === 10 && /[6-9]/.test(nsn[2])) {
    d = '55' + nsn.slice(0, 2) + '9' + nsn.slice(2);
  }
  return '+' + d;
}

function toggleNineBR(e164) {
  const m = /^\+55(\d{2})(\d+)$/.exec(e164);
  if (!m) return null;
  const ddd = m[1], sub = m[2];
  if (sub.length === 8) return null;
  if (sub.length === 9 && sub.startsWith('9')) return `+55${ddd}${sub.slice(1)}`;
  if (sub.length === 10) return `+55${ddd}9${sub}`;
  return null;
}

function requestId() {
  return (crypto.randomUUID && crypto.randomUUID()) || crypto.randomBytes(16).toString('hex');
}

/* ===== whatsapp client ===== */
log(`Iniciando cliente WhatsApp... (APP_ROOT: ${APP_ROOT})`);
let lastQR = null, isReady = false;
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: AUTH_DATA_PATH
    }),
    puppeteer: {
        // Para maior confiabilidade, é melhor deixar o whatsapp-web.js
        // gerenciar sua própria versão do Chromium, em vez de especificar um caminho.
        // executablePath: process.env.CHROME_PATH,
                dumpio: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--disable-web-security',           // Permite WebAssembly para processamento de vídeo
            '--disable-features=IsolateOrigins', // Necessário para WebAssembly
            '--disable-site-isolation-trials'    // Permite unsafe-eval para WebAssembly
        ]
    }
});

// <-- MUDANÇA: Todos os eventos do cliente foram agrupados e melhorados aqui
client.on('loading_screen', (percent, message) => {
    log(`[STATUS] Carregando: ${percent}% - ${message}`);
});

client.on('qr', qr => {
    lastQR = qr;
    isReady = false;
    qrcodeTerminal.generate(qr, { small: true });
    log('[STATUS] QR Code gerado. Escaneie com seu celular para autenticar.');
});

client.on('authenticated', () => {
    log('[AUTH] Autenticado com sucesso!');
});

client.on('ready', () => {
    isReady = true;
    lastQR = null;
    log('[READY] ✅ Cliente conectado e pronto para uso!');
});

client.on('auth_failure', m => {
    isReady = false;
    err('[AUTH] Falha na autenticação!', m, `Limpe a pasta ${AUTH_DATA_PATH} e tente novamente.`);
});

client.on('disconnected', r => {
    isReady = false;
    warn('[STATUS] Cliente desconectado.', r, 'Tentando reconectar em 5 segundos...');
    setTimeout(() => client.initialize(), 5000);
});

// <-- MUDANÇA: Lógica para receber e responder mensagens
client.on('message', async (message) => {
    // Ignora mensagens de status (entrada/saída de grupos, etc.)
    if (message.isStatus) return;

    log(`[MSG] Mensagem recebida de ${message.from}: "${message.body}"`);

    const msgBody = message.body.trim();
    const msgLower = msgBody.toLowerCase();

    // Responde ao comando !ping (sem diferenciar maiúsculas/minúsculas)
    if (msgLower === '!ping') {
        log(`[CMD] Comando !ping recebido de ${message.from}. Respondendo...`);
        try {
            await message.reply('pong');
            log(`[CMD] Resposta 'pong' enviada para ${message.from}.`);
        } catch (e) {
            err(`[CMD] Falha ao responder 'pong' para ${message.from}:`, e.message);
        }
        return;
    }
<<<<<<< HEAD
    
    // Comando !record - Grava vídeo RTSP
    const recordMatch = message.body.match(/^!record(?:\s+(\d+))?$/i);
    if (recordMatch) {
        const fromNumber = message.from.replace('@c.us', '');
        log(`[CMD] Comando !record recebido de ${message.from} (${fromNumber})`);
        
        // Verifica se o número está cadastrado
        if (!isNumberRegistered(fromNumber)) {
            log(`[CMD] Número ${fromNumber} não está cadastrado. Negando acesso.`);
            const denyMsg = '❌ Você não está autorizado a usar este comando. Seu número precisa estar cadastrado no arquivo de números.';
            log(`[CMD] Enviando mensagem de negação: "${denyMsg}"`);
            try {
                await message.reply(denyMsg);
                log(`[CMD] Mensagem de negação enviada`);
            } catch (e) {
                err(`[CMD] Falha ao responder negação para ${message.from}:`, e.message);
            }
            return;
        }
        
        // Constrói URL RTSP com credenciais
        const rtspUrl = buildRTSPUrl();
        if (!rtspUrl) {
            log(`[CMD] RTSP não configurado`);
            const configMsg = '❌ Gravação não configurada. Configure CAMERA_RTSP_URL ou CAMERA_USER/CAMERA_PASS.';
            log(`[CMD] Enviando mensagem de erro de configuração: "${configMsg}"`);
            try {
                await message.reply(configMsg);
                log(`[CMD] Mensagem de erro de configuração enviada`);
            } catch (e) {
                err(`[CMD] Falha ao responder erro de configuração:`, e.message);
            }
            return;
        }
        
        // Extrai duração (padrão: RECORD_DURATION_SEC)
        const duration = recordMatch[1] ? parseInt(recordMatch[1], 10) : RECORD_DURATION_SEC;
        const finalDuration = Math.min(Math.max(5, duration), 120); // Entre 5 e 120 segundos (limite máximo)
        
        if (duration > 120) {
            const limitMsg = `⚠️ Duração limitada a 120 segundos (solicitado: ${duration}s)`;
            log(`[CMD] ${limitMsg}`);
            try {
                await message.reply(limitMsg);
            } catch (e) {
                err(`[CMD] Falha ao enviar mensagem de limite:`, e.message);
            }
        }
        
        log(`[CMD] Iniciando gravação de ${finalDuration} segundos para ${message.from}`);
        
        // Processa gravação em background para não bloquear
        (async () => {
            try {
                const result = await recordRTSPVideo(rtspUrl, finalDuration, message);
                
                if (result.success && result.filePath && fs.existsSync(result.filePath)) {
                    // Guarda caminho original para limpeza posterior
                    const originalFilePath = result.filePath;
                    
                    // Lê o arquivo de vídeo
                    const fileStats = fs.statSync(originalFilePath);
                    log(`[RECORD] Arquivo gerado: ${originalFilePath} (${(fileStats.size / 1024 / 1024).toFixed(2)} MB)`);
                    
                    // Comprime vídeo se necessário
                    const finalVideoPath = await compressVideoIfNeeded(originalFilePath, message);
                    const finalStats = fs.statSync(finalVideoPath);
                    log(`[RECORD] Arquivo final para envio: ${finalVideoPath} (${(finalStats.size / 1024 / 1024).toFixed(2)} MB)`);
                    
                    const videoBuffer = fs.readFileSync(finalVideoPath);
                    
                    // Valida se o vídeo não está vazio ou corrompido
                    if (videoBuffer.length === 0) {
                        throw new Error('Vídeo está vazio ou corrompido');
                    }
                    
                    // Verifica se o tamanho não excede 16MB (limite do WhatsApp)
                    const sizeMB = videoBuffer.length / 1024 / 1024;
                    if (sizeMB > 16) {
                        throw new Error(`Vídeo muito grande (${sizeMB.toFixed(2)} MB). Limite do WhatsApp: 16 MB`);
                    }
                    
                    const videoBase64 = videoBuffer.toString('base64');
                    log(`[RECORD] Vídeo convertido para base64: ${sizeMB.toFixed(2)} MB`);
                    log(`[RECORD] Base64 length: ${videoBase64.length} caracteres`);
                    
                    // Cria MessageMedia com nome de arquivo simples (sem caracteres especiais)
                    const fileName = `video_${Date.now()}.mp4`;
                    const videoMedia = new MessageMedia('video/mp4', videoBase64, fileName);
                    const caption = `🎥 Gravação de ${finalDuration} segundos`;
                    log(`[RECORD] Enviando vídeo para ${message.from} com caption: "${caption}"`);
                    log(`[RECORD] MessageMedia criado: mimetype=video/mp4, filename=${fileName}, size=${(videoBuffer.length / 1024).toFixed(2)} KB`);
                    
                    // Tenta enviar vídeo como VÍDEO primeiro (com thumbnail e player)
                    // Se falhar, usa sendMediaAsDocument como fallback
                    try {
                        log(`[RECORD] Tentando enviar vídeo como VÍDEO (com thumbnail)...`);
                        // Tenta primeiro como vídeo normal (sem sendMediaAsDocument)
                        const sendResult = await client.sendMessage(message.from, videoMedia, { caption });
                        log(`[CMD] Vídeo enviado com sucesso como VÍDEO | id=${sendResult.id?._serialized || 'n/a'}`);
                        
                        // Limpa arquivos imediatamente após envio bem-sucedido
                        cleanupVideoFile(finalVideoPath, 'após envio bem-sucedido (como vídeo)');
                        if (originalFilePath !== finalVideoPath && fs.existsSync(originalFilePath)) {
                            cleanupVideoFile(originalFilePath, 'após envio (arquivo original restante)');
                        }
                    } catch (sendError) {
                        err(`[CMD] Erro ao enviar vídeo como VÍDEO:`, sendError.message);
                        
                        // Fallback 1: Tenta com message.reply() (pode ter tratamento diferente)
                        try {
                            log(`[RECORD] Tentando via message.reply() como vídeo...`);
                            const replyResult = await message.reply(videoMedia, undefined, { caption });
                            log(`[CMD] Vídeo enviado via message.reply() | id=${replyResult.id?._serialized || 'n/a'}`);
                            
                            cleanupVideoFile(finalVideoPath, 'após envio (message.reply como vídeo)');
                            if (originalFilePath !== finalVideoPath && fs.existsSync(originalFilePath)) {
                                cleanupVideoFile(originalFilePath, 'após envio (arquivo original restante)');
                            }
                        } catch (replyError) {
                            err(`[CMD] Erro ao enviar via message.reply():`, replyError.message);
                            
                            // Fallback 2: Tenta sem caption
                            try {
                                log(`[RECORD] Tentando sem caption como vídeo...`);
                                const result2 = await message.reply(videoMedia);
                                log(`[CMD] Vídeo enviado sem caption | id=${result2.id?._serialized || 'n/a'}`);
                                await message.reply(caption);
                                
                                cleanupVideoFile(finalVideoPath, 'após envio (sem caption como vídeo)');
                                if (originalFilePath !== finalVideoPath && fs.existsSync(originalFilePath)) {
                                    cleanupVideoFile(originalFilePath, 'após envio (arquivo original restante)');
                                }
                            } catch (sendError2) {
                                err(`[CMD] Erro ao enviar vídeo sem caption:`, sendError2.message);
                                
                                // Fallback 3: ÚLTIMO RECURSO - Envia como documento (sem thumbnail, mas funciona)
                                try {
                                    log(`[RECORD] Fallback final: enviando como documento (sendMediaAsDocument: true)...`);
                                    const result3 = await client.sendMessage(message.from, videoMedia, { 
                                        caption: `${caption}\n\n⚠️ Enviado como documento devido a limitação do WhatsApp Web.`,
                                        sendMediaAsDocument: true
                                    });
                                    log(`[CMD] Vídeo enviado como documento (fallback) | id=${result3.id?._serialized || 'n/a'}`);
                                    
                                    cleanupVideoFile(finalVideoPath, 'após envio como documento (fallback)');
                                    if (originalFilePath !== finalVideoPath && fs.existsSync(originalFilePath)) {
                                        cleanupVideoFile(originalFilePath, 'após envio como documento (original)');
                                    }
                                } catch (sendError3) {
                                    err(`[CMD] Erro ao enviar como documento:`, sendError3.message);
                                    
                                    // Limpa arquivos após erro
                                    cleanupVideoFile(finalVideoPath, 'após erro no envio');
                                    if (originalFilePath !== finalVideoPath && fs.existsSync(originalFilePath)) {
                                        cleanupVideoFile(originalFilePath, 'após erro (original)');
                                    }
                                    
                                    // Tenta enviar mensagem de erro
                                    try {
                                        await message.reply(`❌ Erro ao enviar vídeo. Tamanho: ${(videoBuffer.length / 1024 / 1024).toFixed(2)} MB. Erro: ${sendError3.message}\n\n💡 O vídeo foi gravado mas não pôde ser enviado. Este é um problema conhecido do WhatsApp Web ao processar vídeos com WebAssembly.`);
                                    } catch (e2) {
                                        err(`[CMD] Falha ao enviar mensagem de erro do vídeo:`, e2.message);
                                    }
                                    throw sendError3; // Re-lança para ser capturado pelo catch externo
                                }
                            }
                        }
                    }
                } else {
                    const failMsg = `❌ Falha na gravação: ${result.error || 'Erro desconhecido'}`;
                    log(`[RECORD] Enviando mensagem de falha: "${failMsg}"`);
                    try {
                        await message.reply(failMsg);
                        log(`[RECORD] Mensagem de falha enviada`);
                    } catch (e) {
                        err(`[RECORD] Erro ao enviar mensagem de falha:`, e.message);
                    }
                    
                    // Limpa arquivo se existir após falha na gravação
                    if (result.filePath && fs.existsSync(result.filePath)) {
                        cleanupVideoFile(result.filePath, 'após falha na gravação');
                    }
                }
            } catch (e) {
                err(`[CMD] Erro ao processar gravação:`, e.message);
                err(`[CMD] Stack trace completo:`, e.stack);
                if (e.cause) {
                    err(`[CMD] Causa do erro:`, e.cause);
                }
                
                // Limpa arquivos em caso de erro geral (se result existir)
                try {
                    if (typeof result !== 'undefined' && result && result.filePath && fs.existsSync(result.filePath)) {
                        cleanupVideoFile(result.filePath, 'após erro geral');
                    }
                } catch (cleanupErr) {
                    warn(`[CLEANUP] Erro ao limpar após erro geral:`, cleanupErr.message);
                }
                
                const errorMsg = `❌ Erro ao processar gravação: ${e.message}`;
                log(`[RECORD] Enviando mensagem de erro: "${errorMsg}"`);
                try {
                    await message.reply(errorMsg);
                    log(`[RECORD] Mensagem de erro enviada`);
                } catch (e2) {
                    err(`[CMD] Falha ao enviar mensagem de erro:`, e2.message);
                    err(`[CMD] Stack trace do erro de envio:`, e2.stack);
                }
            }
        })();
        
        return;
    }

    // Comandos Tuya - verifica se está habilitado
    if (TUYA_CLIENT_ID && TUYA_CLIENT_SECRET) {
        // Verifica se o número está autorizado no arquivo numbers.txt
        const senderNumber = message.from.split('@')[0];
        const isAuthorized = isNumberAuthorized(senderNumber, NUMBERS_FILE);
        
        if (!isAuthorized && !msgLower.startsWith('!tuya help')) {
            dbg(`[CMD-TUYA] Número ${senderNumber} não está autorizado no arquivo numbers.txt. Ignorando comando.`);
            return;
        }

        // Comando: !tuya help
        if (msgLower === '!tuya help' || msgLower === '!tuya') {
            log(`[CMD-TUYA] Comando help recebido de ${message.from}`);
            try {
                const helpMsg = formatTuyaHelpMessage();
                await message.reply(helpMsg);
                log(`[CMD-TUYA] Mensagem de ajuda enviada para ${message.from}.`);
            } catch (e) {
                err(`[CMD-TUYA] Falha ao enviar ajuda para ${message.from}:`, e.message);
            }
            return;
        }

        // Comando: !tuya list
        if (msgLower === '!tuya list') {
            log(`[CMD-TUYA] Comando list recebido de ${message.from}`);
            try {
                await message.reply('⏳ Buscando seus dispositivos...');
                
                const devices = await getCachedTuyaDevices();
                const responseMsg = formatDevicesListMessage(devices);
                await message.reply(responseMsg);
                log(`[CMD-TUYA] Lista de ${devices.length} dispositivo(s) enviada para ${message.from}.`);
            } catch (e) {
                err(`[CMD-TUYA] Erro ao listar dispositivos para ${message.from}:`, e.message);
                if (e.message.includes('UID não configurado')) {
                    await message.reply(`❌ *Erro:* UID não configurado.\n\nConfigure TUYA_UID no arquivo .env ou use: \`!tuya devices <uid>\``);
                } else {
                    await message.reply(`❌ *Erro ao listar dispositivos:*\n${e.message}`);
                }
            }
            return;
        }

        // Comando: !tuya status <número, nome ou deviceId>
        if (msgLower.startsWith('!tuya status ')) {
            const identifier = msgBody.substring(13).trim();
            if (!identifier) {
                await message.reply('❌ *Erro:* Identificador não fornecido.\nUse: `!tuya status 1` ou `!tuya status Nome do Dispositivo`');
                return;
            }

            log(`[CMD-TUYA] Comando status recebido de ${message.from} para identificador: ${identifier}`);
            try {
                await message.reply('⏳ Consultando dispositivo...');
                
                // Primeiro tenta buscar na lista em cache
                let device = null;
                let deviceId = identifier;
                
                try {
                    const devices = await getCachedTuyaDevices();
                    device = findDeviceByIdentifier(identifier, devices);
                    if (device) {
                        deviceId = device.id;
                        log(`[CMD-TUYA] Dispositivo encontrado: ${device.name} (${deviceId})`);
                    }
                } catch (e) {
                    dbg(`[CMD-TUYA] Não foi possível buscar na lista, tentando diretamente com ID: ${e.message}`);
                }
                
                const status = await getTuyaDeviceStatus(deviceId);
                
                const poweredOn = status.filter(s => {
                    const code = s.code?.toLowerCase() || '';
                    const value = s.value;
                    if (code.includes('switch') || code.includes('power')) {
                        return value === true || value === 1 || value === 'true' || value === 'on';
                    }
                    return false;
                }).length > 0;

                const deviceName = device ? device.name : deviceId;
                const responseMsg = formatDeviceStatusMessage(deviceName, status, poweredOn);
                await message.reply(responseMsg);
                log(`[CMD-TUYA] Status do dispositivo ${deviceId} enviado para ${message.from}.`);
            } catch (e) {
                err(`[CMD-TUYA] Erro ao consultar status para ${message.from}:`, e.message);
                await message.reply(`❌ *Erro ao consultar dispositivo:*\n${e.message}\n\n💡 *Dica:* Use \`!tuya list\` para ver todos os dispositivos disponíveis.`);
            }
            return;
        }

        // Comando: !tuya devices <uid>
        if (msgLower.startsWith('!tuya devices ')) {
            const uid = msgBody.substring(14).trim();
            if (!uid) {
                await message.reply('❌ *Erro:* UID não fornecido.\nUse: `!tuya devices <uid>`');
                return;
            }

            log(`[CMD-TUYA] Comando devices recebido de ${message.from} para UID ${uid}`);
            try {
                await message.reply('⏳ Consultando dispositivos...');
                
                const devices = await getTuyaDevices(uid);
                
                const devicesWithStatus = await Promise.all(devices.map(async (device) => {
                    try {
                        const status = await getTuyaDeviceStatus(device.id);
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
                            poweredOnCount: poweredOn.length
                        };
                    } catch (e) {
                        warn(`[CMD-TUYA] Erro ao obter status do dispositivo ${device.id}:`, e.message);
                        return {
                            id: device.id,
                            name: device.name,
                            online: device.online || false,
                            category: device.category,
                            error: e.message
                        };
                    }
                }));

                const responseMsg = formatDevicesListMessage(devicesWithStatus);
                await message.reply(responseMsg);
                log(`[CMD-TUYA] Lista de ${devicesWithStatus.length} dispositivo(s) enviada para ${message.from}.`);
            } catch (e) {
                err(`[CMD-TUYA] Erro ao listar dispositivos para ${message.from}:`, e.message);
                await message.reply(`❌ *Erro ao listar dispositivos:*\n${e.message}\n\nVerifique se o UID está correto.`);
            }
            return;
        }
>>>>>>> b267b6e (feat: Integração com API Tuya e comandos WhatsApp - Adiciona integração completa com API Tuya para controle de dispositivos via WhatsApp - Implementa comandos: !tuya help, !tuya list, !tuya status - Adiciona autenticação HMAC-SHA256 e gerenciamento de tokens - Cria script de teste test-tuya-sign.js para debug - Adiciona documentação completa (TUYA_INTEGRATION.md, TUYA_TROUBLESHOOTING.md) - Usa numbers.txt para autorização de comandos Tuya)
    }
});

// Garante que diretórios necessários existem
if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  log(`[INIT] Diretório de gravações criado: ${RECORDINGS_DIR}`);
}

client.initialize().catch(e => err('[INIT] Falha ao inicializar o cliente:', e.message));

/* ===== resolutor de número (getNumberId + fallback com/sem 9) ===== */
async function resolveWhatsAppNumber(client, e164) {
  const tried = [];
  const toDigits = s => String(s || '').replace(/\D/g, '');
  tried.push(e164);
  let id = await client.getNumberId(toDigits(e164)).catch(() => null);
   if (id) return { id, tried };
   const alt = toggleNineBR(e164);
   if (alt && !tried.includes(alt)) {
     tried.push(alt);
    id = await client.getNumberId(toDigits(alt)).catch(() => null);
     if (id) return { id, tried };
   }
   return { id: null, tried };
}

/* ===== funções para snapshot da câmera ===== */
/**
 * Otimiza imagem: redimensiona e comprime se necessário
 * @param {Buffer} imageBuffer - Buffer da imagem original
 * @param {string} mimeType - Tipo MIME da imagem
 * @returns {Promise<{buffer: Buffer, mimeType: string, optimized: boolean}>}
 */
async function optimizeImage(imageBuffer, mimeType) {
  const originalSizeKB = imageBuffer.length / 1024;
  let optimized = false;
  let processedBuffer = imageBuffer;
  
  try {
    // Só processa se for JPEG/PNG e se o tamanho for maior que o limite
    if (!mimeType.match(/^image\/(jpeg|jpg|png)$/i)) {
      if (DEBUG) {
        dbg(`[OPTIMIZE] Tipo ${mimeType} não suportado para otimização, mantendo original`);
      }
      return { buffer: imageBuffer, mimeType, optimized: false };
    }
    
    let sharpImage = sharp(imageBuffer);
    const metadata = await sharpImage.metadata();
    
    // Verifica se precisa redimensionar
    const needsResize = metadata.width > MAX_IMAGE_WIDTH || metadata.height > MAX_IMAGE_HEIGHT;
    const needsCompress = originalSizeKB > MAX_IMAGE_SIZE_KB;
    
    if (!needsResize && !needsCompress) {
      if (DEBUG) {
        dbg(`[OPTIMIZE] Imagem já otimizada: ${originalSizeKB.toFixed(1)}KB, ${metadata.width}x${metadata.height}px`);
      }
      return { buffer: imageBuffer, mimeType, optimized: false };
    }
    
    if (DEBUG) {
      dbg(`[OPTIMIZE] Otimizando imagem: ${originalSizeKB.toFixed(1)}KB, ${metadata.width}x${metadata.height}px`);
    }
    
    // Redimensiona mantendo aspect ratio
    if (needsResize) {
      sharpImage = sharpImage.resize(MAX_IMAGE_WIDTH, MAX_IMAGE_HEIGHT, {
        fit: 'inside',
        withoutEnlargement: true
      });
      if (DEBUG) {
        dbg(`[OPTIMIZE] Redimensionando para máximo ${MAX_IMAGE_WIDTH}x${MAX_IMAGE_HEIGHT}px`);
      }
    }
    
    // Comprime JPEG
    if (mimeType.match(/^image\/(jpeg|jpg)$/i)) {
      processedBuffer = await sharpImage
        .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
        .toBuffer();
      optimized = true;
    } else if (mimeType.match(/^image\/png$/i)) {
      // Para PNG, converte para JPEG (mais compacto)
      processedBuffer = await sharpImage
        .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
        .toBuffer();
      mimeType = 'image/jpeg';
      optimized = true;
    }
    
    const newSizeKB = processedBuffer.length / 1024;
    const reduction = ((originalSizeKB - newSizeKB) / originalSizeKB * 100).toFixed(1);
    
    if (optimized) {
      log(`[OPTIMIZE] Imagem otimizada: ${originalSizeKB.toFixed(1)}KB → ${newSizeKB.toFixed(1)}KB (${reduction}% redução)`);
    }
    
    return { buffer: processedBuffer, mimeType, optimized };
  } catch (error) {
    warn(`[OPTIMIZE] Erro ao otimizar imagem, usando original:`, error.message);
    return { buffer: imageBuffer, mimeType, optimized: false };
  }
}

/**
 * Adiciona parâmetros de otimização na URL da câmera (se suportado)
 * Tenta múltiplos formatos de parâmetros (diferentes modelos de câmera)
 */
function optimizeCameraUrl(url) {
  try {
    const urlObj = new URL(url);
    const baseUrl = urlObj.origin + urlObj.pathname;
    
    // Tenta diferentes formatos de parâmetros (alguns modelos usam width/height, outros resolution)
    if (!urlObj.searchParams.has('resolution') && !urlObj.searchParams.has('width')) {
      // Tenta resolution primeiro
      urlObj.searchParams.set('resolution', `${MAX_IMAGE_WIDTH}x${MAX_IMAGE_HEIGHT}`);
      // Se não funcionar, alguns modelos usam width/height separados
      // urlObj.searchParams.set('width', String(MAX_IMAGE_WIDTH));
      // urlObj.searchParams.set('height', String(MAX_IMAGE_HEIGHT));
    }
    if (!urlObj.searchParams.has('quality')) {
      urlObj.searchParams.set('quality', String(JPEG_QUALITY));
    }
    if (!urlObj.searchParams.has('compression')) {
      urlObj.searchParams.set('compression', 'high');
    }
    // Alguns modelos usam 'subtype' ou 'subType' para qualidade
    if (!urlObj.searchParams.has('subtype') && !urlObj.searchParams.has('subType')) {
      urlObj.searchParams.set('subtype', '0'); // 0 = JPEG, 1 = MJPEG
    }
    
    return urlObj.toString();
  } catch (e) {
    // Se falhar ao parsear URL, retorna original
    return url;
  }
}

async function downloadSnapshot(url, username, password) {
  if (!username || !password) {
    throw new Error('CAMERA_USER e CAMERA_PASS devem estar configurados');
  }
  
  const cleanUrl = url.replace(/\/\/[^@]+@/, '//');
  
  // Tenta otimizar URL com parâmetros (se a câmera suportar)
  const optimizedUrl = optimizeCameraUrl(cleanUrl);
  const displayUrl = optimizedUrl !== cleanUrl ? `${cleanUrl} [otimizado]` : cleanUrl;
  
  log(`[SNAPSHOT] Baixando snapshot de ${displayUrl}`);
  
  // Debug: mostra credenciais se DEBUG estiver ativo
  if (DEBUG) {
    dbg(`[SNAPSHOT] Credenciais - User: ${username}, Pass: ${password}`);
    dbg(`[SNAPSHOT] URL original: ${cleanUrl}`);
    if (optimizedUrl !== cleanUrl) {
      dbg(`[SNAPSHOT] URL otimizada: ${optimizedUrl}`);
    }
  }
  
  // Usa URL otimizada para download
  const downloadUrl = optimizedUrl;
  
  // Verifica cache de tipo de autenticação (evita tentar Basic se já sabemos que é Digest)
  const cachedAuthType = authTypeCache.get(cleanUrl);
  
  // Se cache indica Digest, faz requisição inicial para obter nonce
  if (cachedAuthType === 'digest') {
    if (DEBUG) {
      dbg(`[SNAPSHOT] Cache indica Digest - fazendo requisição inicial para obter nonce`);
    }
    try {
      // Faz requisição inicial sem auth para obter WWW-Authenticate header
      const initialResponse = await axios.get(downloadUrl, {
        responseType: 'arraybuffer',
        timeout: 3000,
        validateStatus: () => true,  // Aceita qualquer status
        headers: {
          'User-Agent': 'WhatsApp-API/1.0',
          'Accept': 'image/*,*/*',
          'Connection': 'keep-alive'
        }
      });
      
      // Se por acaso funcionou sem auth (improvável), processa
      if (initialResponse.status === 200 && initialResponse.data) {
        let buffer = Buffer.from(initialResponse.data);
        let mimeType = initialResponse.headers['content-type'] || 'image/jpeg';
        const optimized = await optimizeImage(buffer, mimeType);
        buffer = optimized.buffer;
        mimeType = optimized.mimeType;
        const base64 = buffer.toString('base64');
        log(`[SNAPSHOT] Snapshot baixado (sem auth): ${buffer.length} bytes, tipo: ${mimeType}${optimized.optimized ? ' [OTIMIZADO]' : ''}`);
        return { base64, mimeType, buffer };
      }
      
      // Esperamos 401 com WWW-Authenticate
      if (initialResponse.status === 401) {
        const wwwAuth = initialResponse.headers['www-authenticate'] || '';
        const isDigest = wwwAuth.toLowerCase().includes('digest');
        
        if (isDigest) {
          // Parse do header WWW-Authenticate
          const realmMatch = wwwAuth.match(/realm="([^"]+)"/);
          const nonceMatch = wwwAuth.match(/nonce="([^"]+)"/);
          const qopMatch = wwwAuth.match(/qop="([^"]+)"/);
          const opaqueMatch = wwwAuth.match(/opaque="([^"]+)"/);
          
          const realm = realmMatch ? realmMatch[1] : '';
          const nonce = nonceMatch ? nonceMatch[1] : '';
          const qop = qopMatch ? qopMatch[1] : '';
          const opaque = opaqueMatch ? opaqueMatch[1] : '';
          
          // Implementação de Digest Authentication
          const urlObj = new URL(downloadUrl);
          const uri = urlObj.pathname + urlObj.search;
          const method = 'GET';
          
          if (DEBUG) {
            dbg(`[SNAPSHOT] Digest params - realm: "${realm}", nonce: "${nonce}", qop: "${qop}", opaque: "${opaque}"`);
            dbg(`[SNAPSHOT] URI: "${uri}", Method: "${method}"`);
          }
          
          // HA1 = MD5(username:realm:password)
          const ha1Input = `${username}:${realm}:${password}`;
          const ha1 = crypto.createHash('md5').update(ha1Input).digest('hex');
          
          // HA2 = MD5(method:uri)
          const ha2Input = `${method}:${uri}`;
          const ha2 = crypto.createHash('md5').update(ha2Input).digest('hex');
          
          // cnonce (client nonce)
          const cnonce = crypto.randomBytes(8).toString('hex');
          const nc = '00000001';
          
          // response = MD5(HA1:nonce:nc:cnonce:qop:HA2)
          let responseHash = '';
          let responseInput = '';
          if (qop) {
            responseInput = `${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`;
            responseHash = crypto.createHash('md5').update(responseInput).digest('hex');
          } else {
            responseInput = `${ha1}:${nonce}:${ha2}`;
            responseHash = crypto.createHash('md5').update(responseInput).digest('hex');
          }
          
          if (DEBUG) {
            dbg(`[SNAPSHOT] HA1: ${ha1}, HA2: ${ha2}, Response: ${responseHash}`);
          }
          
          // Monta o header Authorization
          let authHeader = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${responseHash}"`;
          if (qop) {
            authHeader += `, qop="${qop}", nc=${nc}, cnonce="${cnonce}"`;
          }
          if (opaque) {
            authHeader += `, opaque="${opaque}"`;
          }
          
          // Faz a requisição com o header Authorization
          const response = await axios.get(downloadUrl, {
            responseType: 'arraybuffer',
            timeout: 20000,
            headers: {
              'User-Agent': 'WhatsApp-API/1.0',
              'Accept': 'image/*,*/*',
              'Authorization': authHeader,
              'Connection': 'keep-alive'
            },
            validateStatus: (status) => status === 200,
            maxRedirects: 0
          });
          
          if (!response.data || response.data.length === 0) {
            throw new Error('Resposta vazia da câmera');
          }
          
          let buffer = Buffer.from(response.data);
          let mimeType = response.headers['content-type'] || 'image/jpeg';
          
          // Otimiza a imagem se necessário
          const optimized = await optimizeImage(buffer, mimeType);
          buffer = optimized.buffer;
          mimeType = optimized.mimeType;
          
          const base64 = buffer.toString('base64');
          log(`[SNAPSHOT] Snapshot baixado com sucesso (Digest - cache): ${buffer.length} bytes, tipo: ${mimeType}${optimized.optimized ? ' [OTIMIZADO]' : ''}`);
          return { base64, mimeType, buffer };
        }
      }
      
      // Se não for 401 ou não for Digest, tenta Basic mesmo assim
      throw new Error('Unexpected response from camera');
    } catch (e) {
      // Se falhar, limpa cache e tenta Basic
      if (DEBUG) {
        dbg(`[SNAPSHOT] Erro ao usar cache Digest, limpando cache e tentando Basic:`, e.message);
      }
      authTypeCache.delete(cleanUrl);
      // Continua com o fluxo normal abaixo (tenta Basic)
    }
  }
  
  // Tenta primeiro com autenticação básica (se cache não indica Digest ou se cache foi limpo)
  const currentCache = authTypeCache.get(cleanUrl);
  if (currentCache !== 'digest') {
    try {
      if (DEBUG) {
        dbg(`[SNAPSHOT] Tentando autenticação Basic HTTP`);
      }
      
      const response = await axios.get(downloadUrl, {
        responseType: 'arraybuffer',
        timeout: 5000,  // Reduzido para 5s (se for Digest, vai falhar rápido)
        auth: { username, password },
        validateStatus: (status) => status === 200,
        headers: {
          'User-Agent': 'WhatsApp-API/1.0',
          'Accept': 'image/*,*/*',
          'Connection': 'keep-alive'  // Reutiliza conexão
        },
        maxRedirects: 0  // Evita redirects desnecessários
      });
      
      if (!response.data || response.data.length === 0) {
        throw new Error('Resposta vazia da câmera');
      }
      
      let buffer = Buffer.from(response.data);
      let mimeType = response.headers['content-type'] || 'image/jpeg';
      
      // Otimiza a imagem se necessário
      const optimized = await optimizeImage(buffer, mimeType);
      buffer = optimized.buffer;
      mimeType = optimized.mimeType;
      
      const base64 = buffer.toString('base64');
      log(`[SNAPSHOT] Snapshot baixado com sucesso (Basic): ${buffer.length} bytes, tipo: ${mimeType}${optimized.optimized ? ' [OTIMIZADO]' : ''}`);
      // Cache: Basic funcionou
      authTypeCache.set(cleanUrl, 'basic');
      return { base64, mimeType, buffer };
    } catch (e1) {
      // Se receber 401, verifica se é Digest e tenta novamente
      if (e1.response?.status === 401) {
        const wwwAuth = e1.response?.headers['www-authenticate'] || '';
        const isDigest = wwwAuth.toLowerCase().includes('digest');
        
        if (DEBUG) {
          dbg(`[SNAPSHOT] Resposta 401 recebida`);
          dbg(`[SNAPSHOT] Status: ${e1.response?.status}`);
          dbg(`[SNAPSHOT] Status Text: ${e1.response?.statusText}`);
          dbg(`[SNAPSHOT] WWW-Authenticate header: ${wwwAuth || '(não presente)'}`);
          dbg(`[SNAPSHOT] Tipo de autenticação detectado: ${isDigest ? 'Digest' : 'Basic (ou não especificado)'}`);
        }
        
        // Cache: é Digest
        authTypeCache.set(cleanUrl, 'digest');
        
        // Se for Digest, implementa autenticação Digest manualmente
        if (isDigest) {
          try {
            if (DEBUG) {
              dbg(`[SNAPSHOT] Tentando autenticação Digest HTTP`);
              dbg(`[SNAPSHOT] Parsing WWW-Authenticate: ${wwwAuth}`);
            }
            
            // Parse do header WWW-Authenticate
            const realmMatch = wwwAuth.match(/realm="([^"]+)"/);
            const nonceMatch = wwwAuth.match(/nonce="([^"]+)"/);
            const qopMatch = wwwAuth.match(/qop="([^"]+)"/);
            const opaqueMatch = wwwAuth.match(/opaque="([^"]+)"/);
            
            const realm = realmMatch ? realmMatch[1] : '';
            const nonce = nonceMatch ? nonceMatch[1] : '';
            const qop = qopMatch ? qopMatch[1] : '';
            const opaque = opaqueMatch ? opaqueMatch[1] : '';
            
            // Implementação de Digest Authentication
            const urlObj = new URL(downloadUrl);
            const uri = urlObj.pathname + urlObj.search;
            const method = 'GET';
            
            if (DEBUG) {
              dbg(`[SNAPSHOT] Digest params - realm: "${realm}", nonce: "${nonce}", qop: "${qop}", opaque: "${opaque}"`);
              dbg(`[SNAPSHOT] URI: "${uri}", Method: "${method}"`);
            }
            
            // HA1 = MD5(username:realm:password)
            const ha1Input = `${username}:${realm}:${password}`;
            const ha1 = crypto.createHash('md5').update(ha1Input).digest('hex');
            
            // HA2 = MD5(method:uri)
            const ha2Input = `${method}:${uri}`;
            const ha2 = crypto.createHash('md5').update(ha2Input).digest('hex');
            
            // cnonce (client nonce)
            const cnonce = crypto.randomBytes(8).toString('hex');
            const nc = '00000001';
            
            // response = MD5(HA1:nonce:nc:cnonce:qop:HA2)
            let responseHash = '';
            let responseInput = '';
            if (qop) {
              responseInput = `${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`;
              responseHash = crypto.createHash('md5').update(responseInput).digest('hex');
            } else {
              responseInput = `${ha1}:${nonce}:${ha2}`;
              responseHash = crypto.createHash('md5').update(responseInput).digest('hex');
            }
            
            if (DEBUG) {
              dbg(`[SNAPSHOT] HA1: ${ha1}, HA2: ${ha2}, Response: ${responseHash}`);
            }
            
            // Monta o header Authorization
            let authHeader = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${responseHash}"`;
            if (qop) {
              authHeader += `, qop="${qop}", nc=${nc}, cnonce="${cnonce}"`;
            }
            if (opaque) {
              authHeader += `, opaque="${opaque}"`;
            }
            
            // Faz a requisição com o header Authorization
            const response = await axios.get(downloadUrl, {
              responseType: 'arraybuffer',
              timeout: 20000,  // Aumentado para 20s (câmera pode ser lenta para gerar imagem)
              headers: {
                'User-Agent': 'WhatsApp-API/1.0',
                'Accept': 'image/*,*/*',
                'Authorization': authHeader,
                'Connection': 'keep-alive'  // Reutiliza conexão
              },
              validateStatus: (status) => status === 200,
              maxRedirects: 0
            });
            
            if (!response.data || response.data.length === 0) {
              throw new Error('Resposta vazia da câmera');
            }
            
            let buffer = Buffer.from(response.data);
            let mimeType = response.headers['content-type'] || 'image/jpeg';
            
            // Otimiza a imagem se necessário
            const optimized = await optimizeImage(buffer, mimeType);
            buffer = optimized.buffer;
            mimeType = optimized.mimeType;
            
            const base64 = buffer.toString('base64');
            log(`[SNAPSHOT] Snapshot baixado com sucesso (Digest): ${buffer.length} bytes, tipo: ${mimeType}${optimized.optimized ? ' [OTIMIZADO]' : ''}`);
            return { base64, mimeType, buffer };
          } catch (e2) {
          if (DEBUG) {
            dbg(`[SNAPSHOT] Erro na autenticação Digest:`, e2.message);
            dbg(`[SNAPSHOT] Status: ${e2.response?.status}, Headers:`, JSON.stringify(e2.response?.headers || {}));
          }
          const status = e2.response?.status || e1.response?.status;
          const statusText = e2.response?.statusText || e1.response?.statusText;
          if (status === 401) {
            err(`[SNAPSHOT] Erro 401 - Autenticação Digest falhou. Verifique CAMERA_USER e CAMERA_PASS.`);
            err(`[SNAPSHOT] WWW-Authenticate: ${wwwAuth}`);
          } else {
            err(`[SNAPSHOT] Erro HTTP ${status} ${statusText || ''}:`, e2.message);
          }
              throw e2;
          }
        } else {
          // Se não for Digest mas ainda deu 401, reporta erro
          if (DEBUG) {
            dbg(`[SNAPSHOT] Erro na autenticação Basic:`, e1.message);
            dbg(`[SNAPSHOT] Status: ${e1.response?.status}, Headers:`, JSON.stringify(e1.response?.headers || {}));
          }
          err(`[SNAPSHOT] Erro 401 - Autenticação Basic falhou. Verifique CAMERA_USER e CAMERA_PASS.`);
          err(`[SNAPSHOT] WWW-Authenticate: ${wwwAuth || '(não fornecido)'}`);
          throw e1;
        }
      } else {
        // Outro tipo de erro (não foi 401)
        const status = e1.response?.status;
        const statusText = e1.response?.statusText;
        if (status) {
          err(`[SNAPSHOT] Erro HTTP ${status} ${statusText || ''}:`, e1.message);
        } else {
          err(`[SNAPSHOT] Erro ao baixar snapshot:`, e1.message);
        }
        throw e1;
      }
    }
  }
}

function readNumbersFromFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      warn(`[NUMBERS] Arquivo não encontrado: ${filePath}`);
      return [];
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#') && line.length > 0);
    log(`[NUMBERS] ${lines.length} número(s) lido(s) do arquivo ${filePath}`);
    return lines;
  } catch (e) {
    err(`[NUMBERS] Erro ao ler arquivo de números:`, e.message);
    return [];
  }
}

<<<<<<< HEAD
/**
 * Verifica se um número está cadastrado no arquivo
 * @param {string} phoneNumber - Número a verificar (pode estar em qualquer formato)
 * @returns {boolean}
 */
function isNumberRegistered(phoneNumber) {
  try {
    const numbers = readNumbersFromFile(NUMBERS_FILE);
    const normalized = normalizeBR(phoneNumber);
    const normalizedNumbers = numbers.map(n => normalizeBR(n));
    return normalizedNumbers.includes(normalized);
  } catch (e) {
    err(`[NUMBERS] Erro ao verificar número:`, e.message);
    return false;
  }
}

/**
 * Constrói URL RTSP com credenciais se necessário
 * @returns {string} URL RTSP completa
 */
function buildRTSPUrl() {
  // Se CAMERA_RTSP_URL já tem credenciais, usa diretamente
  if (CAMERA_RTSP_URL && CAMERA_RTSP_URL.includes('@')) {
    return CAMERA_RTSP_URL;
  }
  
  // Se não tem URL completa, constrói a partir das variáveis
  if (!CAMERA_RTSP_URL && CAMERA_USER && CAMERA_PASS) {
    // Tenta construir URL padrão baseada no snapshot URL
    const snapshotUrl = CAMERA_SNAPSHOT_URL || '';
    const match = snapshotUrl.match(/https?:\/\/([^\/]+)/);
    if (match) {
      const host = match[1].replace(/^[^@]+@/, ''); // Remove credenciais se existirem
      return `rtsp://${CAMERA_USER}:${CAMERA_PASS}@${host}:554/cam/realmonitor?channel=1&subtype=0`;
    }
  }
  
  // Se tem URL mas não tem credenciais, adiciona
  if (CAMERA_RTSP_URL && !CAMERA_RTSP_URL.includes('@') && CAMERA_USER && CAMERA_PASS) {
    const url = CAMERA_RTSP_URL.replace(/^rtsp:\/\//, '');
    return `rtsp://${CAMERA_USER}:${CAMERA_PASS}@${url}`;
  }
  
  return CAMERA_RTSP_URL || '';
}

/**
 * Remove arquivo de vídeo de forma segura
 * @param {string} filePath - Caminho do arquivo a ser removido
 * @param {string} context - Contexto para logs (ex: "após envio", "após erro")
 */
function cleanupVideoFile(filePath, context = '') {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      log(`[CLEANUP] Arquivo removido ${context}: ${filePath}`);
    }
  } catch (e) {
    warn(`[CLEANUP] Erro ao remover arquivo ${context}:`, e.message);
  }
}

/**
 * Comprime vídeo se necessário para WhatsApp (limite ~16MB, mas comprimimos se > MAX_VIDEO_SIZE_MB)
 * @param {string} inputFile - Caminho do arquivo de vídeo original
 * @param {object} message - Objeto de mensagem do WhatsApp para enviar feedback (opcional)
 * @returns {Promise<string>} Caminho do arquivo comprimido (pode ser o mesmo se não precisar comprimir)
 */
async function compressVideoIfNeeded(inputFile, message = null) {
  const stats = fs.statSync(inputFile);
  const sizeMB = stats.size / 1024 / 1024;
  
  if (sizeMB <= MAX_VIDEO_SIZE_MB) {
    log(`[COMPRESS] Vídeo não precisa comprimir: ${sizeMB.toFixed(2)} MB (limite: ${MAX_VIDEO_SIZE_MB} MB)`);
    return inputFile;
  }
  
  log(`[COMPRESS] Vídeo muito grande (${sizeMB.toFixed(2)} MB), comprimindo para ${MAX_VIDEO_SIZE_MB} MB...`);
  if (message) {
    const compressMsg = `📦 Comprimindo vídeo (${sizeMB.toFixed(1)} MB → ~${MAX_VIDEO_SIZE_MB} MB)...`;
    log(`[COMPRESS] Enviando mensagem: "${compressMsg}"`);
    message.reply(compressMsg)
      .then(() => log(`[COMPRESS] Mensagem de compressão enviada`))
      .catch((e) => err(`[COMPRESS] Erro ao enviar mensagem:`, e.message));
  }
  
  const compressedFile = inputFile.replace('.mp4', '_compressed.mp4');
  
  return new Promise((resolve, reject) => {
    ffmpeg(inputFile)
      .outputOptions([
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', String(VIDEO_CRF),  // CRF maior = menor qualidade, menor arquivo
        '-maxrate', '1.5M',         // Bitrate máximo para compressão
        '-bufsize', '3M',           // Buffer size
        '-vf', 'scale=1280:720',   // Reduz resolução para 720p
        '-c:a', 'aac',
        '-b:a', '96k',              // Reduz bitrate de áudio
        '-ar', '44100',             // Sample rate de áudio
        '-movflags', '+faststart',  // Otimização (removido empty_moov)
        '-pix_fmt', 'yuv420p',      // Formato de pixel compatível (necessário para WhatsApp)
        '-profile:v', 'baseline',   // Perfil H.264 baseline (mais compatível)
        '-level', '3.1',            // Nível H.264 3.1 (mais compatível)
        '-g', '30',                 // GOP size
        '-keyint_min', '30',        // Intervalo mínimo entre keyframes
        '-sc_threshold', '0',       // Desabilita scene change detection
        '-avoid_negative_ts', 'make_zero',  // Evita problemas de timestamp
        '-fflags', '+genpts',       // Gera timestamps corretos
        '-strict', '-2'             // Permite experimental codecs
      ])
      .output(compressedFile)
      .on('start', (cmdline) => {
        log(`[COMPRESS] Iniciando compressão...`);
        if (DEBUG) {
          dbg(`[COMPRESS] Comando: ${cmdline}`);
        }
      })
      .on('end', () => {
        const newStats = fs.statSync(compressedFile);
        const newSizeMB = newStats.size / 1024 / 1024;
        const reduction = ((sizeMB - newSizeMB) / sizeMB * 100).toFixed(1);
        log(`[COMPRESS] Compressão concluída: ${sizeMB.toFixed(2)} MB → ${newSizeMB.toFixed(2)} MB (${reduction}% redução)`);
        
        // Remove arquivo original
        try {
          fs.unlinkSync(inputFile);
          log(`[COMPRESS] Arquivo original removido`);
        } catch (e) {
          warn(`[COMPRESS] Erro ao remover arquivo original:`, e.message);
        }
        
        resolve(compressedFile);
      })
      .on('error', (err) => {
        err(`[COMPRESS] Erro na compressão:`, err.message);
        // Se falhar, retorna o original
        resolve(inputFile);
      })
      .run();
  });
}

/**
 * Grava vídeo RTSP por X segundos e envia feedback durante o processo
 * @param {string} rtspUrl - URL RTSP da câmera
 * @param {number} durationSeconds - Duração da gravação em segundos
 * @param {object} message - Objeto de mensagem do WhatsApp para enviar feedback
 * @returns {Promise<{success: boolean, filePath: string|null, error: string|null}>}
 */
async function recordRTSPVideo(rtspUrl, durationSeconds, message) {
  if (!rtspUrl) {
    throw new Error('CAMERA_RTSP_URL não configurada');
  }
  
  // Verifica se ffmpeg está disponível
  if (!ffmpegConfigured) {
    const errorMsg = 'FFmpeg não está disponível. Instale ffmpeg no sistema ou verifique a instalação do ffmpeg-static.';
    err(`[RECORD] ${errorMsg}`);
    throw new Error(errorMsg);
  }
  
  // Garante que o diretório de gravações existe
  if (!fs.existsSync(RECORDINGS_DIR)) {
    fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
    log(`[RECORD] Diretório de gravações criado: ${RECORDINGS_DIR}`);
  }
  
  const timestamp = Date.now();
  const outputFile = path.join(RECORDINGS_DIR, `recording_${timestamp}.mp4`);
  
  return new Promise((resolve, reject) => {
    let progressInterval = null;
    let lastProgress = 0;
    
    // Envia feedback inicial
    const initialMsg = `🎥 Iniciando gravação de ${durationSeconds} segundos...`;
    log(`[RECORD] Enviando mensagem: "${initialMsg}"`);
    message.reply(initialMsg)
      .then(() => log(`[RECORD] Mensagem enviada com sucesso: "${initialMsg}"`))
      .catch((e) => err(`[RECORD] Erro ao enviar mensagem inicial:`, e.message));
    
    // Constrói comando ffmpeg (corrigido: não duplica -i)
    const command = ffmpeg()
      .input(rtspUrl)
      .inputOptions([
        '-rtsp_transport', 'tcp',  // Usa TCP para maior confiabilidade
        '-timeout', '5000000',     // Timeout de 5 segundos (em microsegundos)
        '-rtsp_flags', 'prefer_tcp' // Prefere TCP para RTSP
      ])
      .outputOptions([
        '-t', String(durationSeconds),  // Duração
        '-c:v', 'libx264',              // Codec de vídeo
        '-preset', 'ultrafast',         // Preset rápido
        '-crf', '23',                   // Qualidade melhor (23 é padrão, mais compatível que 28)
        '-maxrate', '2M',               // Bitrate máximo (limita tamanho)
        '-bufsize', '4M',               // Buffer size
        '-c:a', 'aac',                  // Codec de áudio
        '-b:a', '128k',                 // Bitrate de áudio
        '-ar', '44100',                 // Sample rate de áudio (padrão WhatsApp)
        '-movflags', '+faststart',      // Otimização para streaming (removido empty_moov que pode causar problemas)
        '-pix_fmt', 'yuv420p',         // Formato de pixel compatível (necessário para WhatsApp)
        '-profile:v', 'baseline',       // Perfil H.264 baseline (mais compatível)
        '-level', '3.1',                // Nível H.264 3.1 (mais compatível que 3.0)
        '-g', '30',                     // GOP size (keyframe a cada 30 frames)
        '-keyint_min', '30',            // Intervalo mínimo entre keyframes
        '-sc_threshold', '0',           // Desabilita scene change detection
        '-avoid_negative_ts', 'make_zero',  // Evita problemas de timestamp
        '-fflags', '+genpts',          // Gera timestamps corretos
        '-strict', '-2'                 // Permite experimental codecs se necessário
      ])
      .output(outputFile)
      .on('start', (cmdline) => {
        log(`[RECORD] Iniciando gravação: ${outputFile}`);
        if (DEBUG) {
          dbg(`[RECORD] Comando ffmpeg: ${cmdline}`);
        }
        
        // Envia feedback a cada 25% do progresso
        progressInterval = setInterval(() => {
          const elapsed = Date.now() - timestamp;
          const progress = Math.min(100, Math.floor((elapsed / (durationSeconds * 1000)) * 100));
          
          if (progress >= lastProgress + 25 && progress <= 100) {
            lastProgress = progress;
            const remaining = Math.max(0, durationSeconds - Math.floor(elapsed / 1000));
            const progressMsg = `⏳ Gravando... ${progress}% (${remaining}s restantes)`;
            log(`[RECORD] Enviando progresso: "${progressMsg}"`);
            message.reply(progressMsg)
              .then(() => log(`[RECORD] Progresso enviado: ${progress}%`))
              .catch((e) => err(`[RECORD] Erro ao enviar progresso:`, e.message));
          }
        }, 1000); // Verifica a cada segundo
      })
      .on('progress', (progress) => {
        if (DEBUG && progress.percent) {
          dbg(`[RECORD] Progresso: ${progress.percent.toFixed(1)}%`);
        }
      })
      .on('end', () => {
        if (progressInterval) {
          clearInterval(progressInterval);
        }
        log(`[RECORD] Gravação concluída: ${outputFile}`);
        const completeMsg = `✅ Gravação concluída! Processando vídeo...`;
        log(`[RECORD] Enviando mensagem: "${completeMsg}"`);
        message.reply(completeMsg)
          .then(() => log(`[RECORD] Mensagem de conclusão enviada`))
          .catch((e) => err(`[RECORD] Erro ao enviar mensagem de conclusão:`, e.message));
        resolve({ success: true, filePath: outputFile, error: null });
      })
      .on('error', (ffmpegError, stdout, stderr) => {
        if (progressInterval) {
          clearInterval(progressInterval);
        }
        err(`[RECORD] Erro na gravação:`, ffmpegError.message);
        if (stderr) {
          dbg(`[RECORD] stderr: ${stderr}`);
        }
        const errorMsg = `❌ Erro na gravação: ${ffmpegError.message}`;
        log(`[RECORD] Enviando mensagem de erro: "${errorMsg}"`);
        message.reply(errorMsg)
          .then(() => log(`[RECORD] Mensagem de erro enviada`))
          .catch((e) => err(`[RECORD] Erro ao enviar mensagem de erro:`, e.message));
        
        // Remove arquivo parcial se existir
        if (fs.existsSync(outputFile)) {
          fs.unlinkSync(outputFile);
        }
        
        resolve({ success: false, filePath: null, error: ffmpegError.message });
      });
    
    command.run();
  });
}

function isNumberAuthorized(senderPhoneNumber, numbersFile) {
  try {
    const authorizedNumbers = readNumbersFromFile(numbersFile);
    if (authorizedNumbers.length === 0) {
      // Se o arquivo estiver vazio ou não existir, permite todos (comportamento padrão)
      dbg(`[NUMBERS] Arquivo vazio ou não encontrado. Permitindo acesso.`);
      return true;
    }

    // Remove @c.us se presente e normaliza
    const cleanSender = senderPhoneNumber.split('@')[0];
    const senderDigits = digitsOnly(cleanSender);
    const senderNormalized = normalizeBR(cleanSender);

    // Verifica se o número está na lista (com várias tentativas de normalização)
    const isAuthorized = authorizedNumbers.some(authorized => {
      const authorizedDigits = digitsOnly(authorized);
      const authorizedNormalized = normalizeBR(authorized);
      
      // Compara apenas dígitos (sem +, espaços, etc)
      if (senderDigits === authorizedDigits) return true;
      
      // Compara formatos normalizados completos
      if (senderNormalized === authorizedNormalized) return true;
      
      // Remove o + e compara
      const senderNoPlus = senderNormalized.replace(/^\+/, '');
      const authorizedNoPlus = authorizedNormalized.replace(/^\+/, '');
      if (senderNoPlus === authorizedNoPlus) return true;
      
      return false;
    });
    
    if (!isAuthorized) {
      dbg(`[NUMBERS] Número ${cleanSender} não autorizado. Arquivo tem ${authorizedNumbers.length} número(s) cadastrado(s).`);
    }
    
    return isAuthorized;
  } catch (e) {
    err(`[NUMBERS] Erro ao verificar autorização:`, e.message);
    // Em caso de erro, permite acesso (comportamento seguro padrão)
    return true;
  }
}

/* ===== funções para API Tuya ===== */
function generateTuyaSign(clientId, secret, timestamp, method, path, body = '') {
  // Para GET sem body, o body é string vazia
  const bodyStr = body || '';
  // Calcula SHA256 do body (string vazia = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855)
  const bodyHash = crypto.createHash('sha256').update(bodyStr, 'utf8').digest('hex').toLowerCase();
  
  // Formato do stringToSign: method\nbodyHash\n\npath
  const stringToSign = method + '\n' + bodyHash + '\n\n' + path;
  
  // String para assinar: client_id + secret + timestamp + stringToSign
  const signStr = clientId + secret + timestamp + stringToSign;
  
  // Gera HMAC-SHA256 e retorna em maiúsculas
  const sign = crypto.createHmac('sha256', secret).update(signStr, 'utf8').digest('hex').toUpperCase();
  
  if (DEBUG) {
    dbg(`[TUYA-SIGN] Method: ${method}`);
    dbg(`[TUYA-SIGN] Path: ${path}`);
    dbg(`[TUYA-SIGN] Body: "${bodyStr}" (length: ${bodyStr.length})`);
    dbg(`[TUYA-SIGN] BodyHash: ${bodyHash}`);
    dbg(`[TUYA-SIGN] StringToSign: ${JSON.stringify(stringToSign)}`);
    dbg(`[TUYA-SIGN] SignStr (sem secret): ${clientId}***${timestamp}${stringToSign.substring(0, 50)}...`);
    dbg(`[TUYA-SIGN] Sign: ${sign.substring(0, 20)}...`);
  }
  
  return sign;
}

async function getTuyaAccessToken() {
  if (tuyaAccessToken && Date.now() < tuyaTokenExpiry) {
    return tuyaAccessToken;
  }

  if (!TUYA_CLIENT_ID || !TUYA_CLIENT_SECRET) {
    throw new Error('TUYA_CLIENT_ID e TUYA_CLIENT_SECRET devem estar configurados');
  }

  try {
    const timestamp = Date.now().toString();
    const method = 'GET';
    // Para requisições GET, o path no stringToSign deve incluir a query string
    const path = `/v1.0/token?grant_type=1`;
    
    const sign = generateTuyaSign(TUYA_CLIENT_ID, TUYA_CLIENT_SECRET, timestamp, method, path);

    dbg(`[TUYA] Solicitando access token... (timestamp: ${timestamp})`);

    const response = await axios.get(`${TUYA_BASE_URL}${path}`, {
      headers: {
        'client_id': TUYA_CLIENT_ID,
        'sign': sign,
        't': timestamp,
        'sign_method': 'HMAC-SHA256'
      },
      timeout: 10000
    });

    if (response.data && response.data.success && response.data.result) {
      tuyaAccessToken = response.data.result.access_token;
      const expiresIn = (response.data.result.expire_time || 7200) * 1000; // converter para ms
      tuyaTokenExpiry = Date.now() + expiresIn - 60000; // renova 1 minuto antes
      log(`[TUYA] Access token obtido com sucesso (expira em ${Math.floor(expiresIn / 1000 / 60)} minutos)`);
      return tuyaAccessToken;
    } else {
      throw new Error(`Falha ao obter token: ${JSON.stringify(response.data)}`);
    }
  } catch (e) {
    err(`[TUYA] Erro ao obter access token:`, e.response?.data || e.message);
    throw e;
  }
}

async function getTuyaDeviceStatus(deviceId) {
  if (!TUYA_CLIENT_ID || !TUYA_CLIENT_SECRET) {
    throw new Error('TUYA_CLIENT_ID e TUYA_CLIENT_SECRET devem estar configurados');
  }

  try {
    const accessToken = await getTuyaAccessToken();
    const timestamp = Date.now().toString();
    const method = 'GET';
    const path = `/v1.0/iot-03/devices/${deviceId}/status`;
    const sign = generateTuyaSign(TUYA_CLIENT_ID, TUYA_CLIENT_SECRET, timestamp, method, path);

    dbg(`[TUYA] Consultando status do dispositivo ${deviceId}...`);

    const response = await axios.get(`${TUYA_BASE_URL}${path}`, {
      headers: {
        'client_id': TUYA_CLIENT_ID,
        'access_token': accessToken,
        'sign': sign,
        't': timestamp,
        'sign_method': 'HMAC-SHA256'
      },
      timeout: 10000
    });

    if (response.data && response.data.success) {
      return response.data.result;
    } else {
      throw new Error(`Falha ao obter status: ${JSON.stringify(response.data)}`);
    }
  } catch (e) {
    err(`[TUYA] Erro ao obter status do dispositivo ${deviceId}:`, e.response?.data || e.message);
    throw e;
  }
}

async function getTuyaDevices(uid) {
  if (!TUYA_CLIENT_ID || !TUYA_CLIENT_SECRET) {
    throw new Error('TUYA_CLIENT_ID e TUYA_CLIENT_SECRET devem estar configurados');
  }

  if (!uid) {
    throw new Error('UID do usuário é necessário para listar dispositivos');
  }

  try {
    const accessToken = await getTuyaAccessToken();
    const timestamp = Date.now().toString();
    const method = 'GET';
    const path = `/v1.0/users/${uid}/devices`;
    const sign = generateTuyaSign(TUYA_CLIENT_ID, TUYA_CLIENT_SECRET, timestamp, method, path);

    dbg(`[TUYA] Listando dispositivos para usuário ${uid}...`);

    const response = await axios.get(`${TUYA_BASE_URL}${path}`, {
      headers: {
        'client_id': TUYA_CLIENT_ID,
        'access_token': accessToken,
        'sign': sign,
        't': timestamp,
        'sign_method': 'HMAC-SHA256'
      },
      timeout: 10000
    });

    if (response.data && response.data.success) {
      return response.data.result || [];
    } else {
      throw new Error(`Falha ao listar dispositivos: ${JSON.stringify(response.data)}`);
    }
  } catch (e) {
    err(`[TUYA] Erro ao listar dispositivos:`, e.response?.data || e.message);
    throw e;
  }
}

/* ===== funções auxiliares para formatação de mensagens Tuya no WhatsApp ===== */
function formatDeviceStatusMessage(deviceNameOrId, status, poweredOn) {
  let message = `*📱 Status do Dispositivo Tuya*\n\n`;
  message += `*Nome:* ${deviceNameOrId}\n`;
  message += `*Status:* ${poweredOn ? '🟢 LIGADO' : '🔴 DESLIGADO'}\n\n`;
  
  if (status && status.length > 0) {
    message += `*Propriedades:*\n`;
    status.forEach(s => {
      const code = s.code || 'N/A';
      const value = s.value;
      const emoji = (code.toLowerCase().includes('switch') || code.toLowerCase().includes('power')) 
        ? (value === true || value === 1 || value === 'true' || value === 'on' ? '🟢' : '🔴')
        : '⚙️';
      message += `${emoji} *${code}:* ${value}\n`;
    });
  }
  
  return message;
}

function formatDevicesListMessage(devices) {
  if (!devices || devices.length === 0) {
    return `*📱 Dispositivos Tuya*\n\nNenhum dispositivo encontrado.`;
  }
  
  let message = `*📱 Seus Dispositivos Tuya*\n\n`;
  message += `*Total:* ${devices.length}\n`;
  
  const poweredOnCount = devices.filter(d => d.poweredOn).length;
  message += `*Ligados:* ${poweredOnCount}\n\n`;
  message += `*Para consultar status, use:*\n`;
  message += `\`!tuya status 1\` (número da lista)\n`;
  message += `\`!tuya status Nome do Dispositivo\` (nome)\n\n`;
  message += `━━━━━━━━━━━━━━━━━━━━\n\n`;
  
  devices.forEach((device, index) => {
    const statusEmoji = device.poweredOn ? '🟢' : '🔴';
    const onlineEmoji = device.online ? '🟢' : '🔴';
    message += `${index + 1}. ${statusEmoji} *${device.name || device.id}*\n`;
    message += `   ${onlineEmoji} Online: ${device.online ? 'Sim' : 'Não'}\n`;
    if (device.category) {
      message += `   📦 Categoria: ${device.category}\n`;
    }
    if (device.poweredOnCount > 0) {
      message += `   ⚡ ${device.poweredOnCount} propriedade(s) ligada(s)\n`;
    }
    message += `\n`;
  });
  
  return message;
}

function formatTuyaHelpMessage() {
  let message = `*🤖 Comandos Tuya*\n\n`;
  message += `*Comandos disponíveis:*\n\n`;
  message += `*!tuya list*\n`;
  message += `Lista todos os seus dispositivos\n`;
  message += `Exemplo: !tuya list\n\n`;
  message += `*!tuya status <número ou nome>*\n`;
  message += `Consulta o status de um dispositivo\n`;
  message += `Você pode usar:\n`;
  message += `- Número da lista: !tuya status 1\n`;
  message += `- Nome do dispositivo: !tuya status Lâmpada Sala\n`;
  message += `- ID completo: !tuya status bf1234567890abcdef\n\n`;
  message += `*!tuya help*\n`;
  message += `Mostra esta mensagem de ajuda\n\n`;
  message += `*Dica:* Use \`!tuya list\` para ver todos os dispositivos disponíveis.`;
  
  return message;
}

/* ===== funções auxiliares para cache e busca de dispositivos ===== */
async function getCachedTuyaDevices(uid) {
  const now = Date.now();
  
  // Verifica se há cache válido
  if (tuyaDevicesCache && (now - tuyaDevicesCacheTime) < TUYA_DEVICES_CACHE_TTL) {
    dbg(`[TUYA] Usando cache de dispositivos (${Math.floor((now - tuyaDevicesCacheTime) / 1000)}s de idade)`);
    return tuyaDevicesCache;
  }
  
  // Busca dispositivos
  if (!uid) {
    if (!TUYA_UID) {
      throw new Error('UID não configurado. Configure TUYA_UID no .env ou forneça o UID no comando.');
    }
    uid = TUYA_UID;
  }
  
  const devices = await getTuyaDevices(uid);
  
  // Processa status de cada dispositivo
  const devicesWithStatus = await Promise.all(devices.map(async (device) => {
    try {
      const status = await getTuyaDeviceStatus(device.id);
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
        name: device.name || device.id,
        online: device.online || false,
        category: device.category,
        poweredOn: poweredOn.length > 0,
        poweredOnCount: poweredOn.length
      };
    } catch (e) {
      warn(`[TUYA] Erro ao obter status do dispositivo ${device.id}:`, e.message);
      return {
        id: device.id,
        name: device.name || device.id,
        online: device.online || false,
        category: device.category,
        error: e.message
      };
    }
  }));
  
  // Atualiza cache
  tuyaDevicesCache = devicesWithStatus;
  tuyaDevicesCacheTime = now;
  
  return devicesWithStatus;
}

function findDeviceByIdentifier(identifier, devices) {
  if (!identifier || !devices || devices.length === 0) {
    return null;
  }
  
  const idLower = identifier.toLowerCase().trim();
  
  // Tenta por número da lista (1, 2, 3...)
  const index = parseInt(idLower) - 1;
  if (!isNaN(index) && index >= 0 && index < devices.length) {
    return devices[index];
  }
  
  // Tenta por ID completo
  const byId = devices.find(d => d.id.toLowerCase() === idLower);
  if (byId) return byId;
  
  // Tenta por nome (busca parcial, case-insensitive)
  const byName = devices.find(d => {
    const name = (d.name || '').toLowerCase();
    return name === idLower || name.includes(idLower) || idLower.includes(name);
  });
  if (byName) return byName;
  
  return null;
>>>>>>> b267b6e (feat: Integração com API Tuya e comandos WhatsApp - Adiciona integração completa com API Tuya para controle de dispositivos via WhatsApp - Implementa comandos: !tuya help, !tuya list, !tuya status - Adiciona autenticação HMAC-SHA256 e gerenciamento de tokens - Cria script de teste test-tuya-sign.js para debug - Adiciona documentação completa (TUYA_INTEGRATION.md, TUYA_TROUBLESHOOTING.md) - Usa numbers.txt para autorização de comandos Tuya)
}

/* ===== endpoints ===== */
app.get('/health', (_req, res) => res.json({ ok: true, service: 'whatsapp-web.js', ready: isReady, ts: nowISO() }));

app.get('/status', auth, async (_req, res) => {
  try {
    const state = await client.getState().catch(() => null);
    res.json({ ok: true, ready: isReady, state: state || 'unknown', ts: nowISO() });
  } catch (e) { err('status:', e); res.status(500).json({ ok: false, ready: false, error: String(e) }); }
});

app.get('/qr.png', async (_req, res) => {
  if (!lastQR) return res.status(404).send('No QR available');
  try {
    const png = await QRCode.toBuffer(lastQR, { type: 'png', margin: 1, scale: 6 });
    res.setHeader('Content-Type', 'image/png'); res.send(png);
  } catch (e) { err('qr:', e); res.status(500).send('Failed to render QR'); }
});

/* ===== envio de mensagem (com normalização + verificação) ===== */
app.post('/send', auth, async (req, res) => {
  const rid = requestId();
  if (!verifySignedRequest(req, '/send')) {
    warn(`[SEND][${rid}] 403 invalid signature /send`);
    return res.status(403).json({ ok: false, error: 'invalid signature', requestId: rid });
  }
  if (!isReady) return res.status(503).json({ ok: false, error: 'whatsapp not ready', requestId: rid });
  const { phone, message, subject } = req.body || {};
  if (!phone || !message) {
    return res.status(400).json({ ok: false, error: 'phone and message are required', requestId: rid });
  }
  const rawPhone = String(phone);
  const normalized = normalizeBR(rawPhone);
  log(`[SEND][${rid}] POST recebido | ip=${ip(req)} | raw_phone=${rawPhone} | normalized=${normalized}`);
  try {
    const { id: numberId, tried } = await resolveWhatsAppNumber(client, normalized);
    if (!numberId) {
      warn(`[SEND][${rid}] Número não está no WhatsApp | tried=${tried.join(',')}`);
      return res.status(404).json({ ok: false, error: 'not_on_whatsapp', requestId: rid, tried });
    }
    const to = numberId._serialized;
    const body = subject ? `*${String(subject).trim()}*\n\n${message}` : message;
    const r = await client.sendMessage(to, body);
    log(`[SEND OK][${rid}] to=${to} id=${r.id?._serialized || 'n/a'} tried=${tried.join(',')}`);
    return res.json({ ok: true, requestId: rid, to, msgId: r.id?._serialized || null, normalized, tried });
  } catch (e) {
    err(`[SEND][${rid}] ERRO`, e);
    return res.status(500).json({ ok: false, error: String(e), requestId: rid });
  }
});

/* ===== endpoint de validação de autorização ESP32 ===== */
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

/* ===== endpoint para trigger de snapshot do ESP32 ===== */
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
  
  if (!isReady) {
    warn(`[SNAPSHOT][${rid}] WhatsApp não está pronto`);
    return res.status(503).json({ ok: false, error: 'whatsapp not ready', requestId: rid });
  }

  if (!CAMERA_SNAPSHOT_URL) {
    warn(`[SNAPSHOT][${rid}] CAMERA_SNAPSHOT_URL não configurada`);
    return res.status(500).json({ ok: false, error: 'camera not configured', requestId: rid });
  }

  try {
    // Baixa o snapshot da câmera
    const { base64, mimeType } = await downloadSnapshot(CAMERA_SNAPSHOT_URL, CAMERA_USER, CAMERA_PASS);
    
    // Lê os números do arquivo
    const numbers = readNumbersFromFile(NUMBERS_FILE);
    if (numbers.length === 0) {
      warn(`[SNAPSHOT][${rid}] Nenhum número encontrado no arquivo`);
      return res.status(400).json({ ok: false, error: 'no numbers found in file', requestId: rid });
    }

    // Cria o MessageMedia
    const media = new MessageMedia(mimeType, base64, `snapshot_${Date.now()}.jpg`);
    const message = req.body?.message || '📸 Snapshot da câmera';
    
    // OTIMIZAÇÃO: Resolve todos os números em paralelo ANTES de enviar
    log(`[SNAPSHOT][${rid}] Resolvendo ${numbers.length} número(s) em paralelo...`);
    const numberResolutions = await Promise.all(
      numbers.map(async (rawPhone) => {
        try {
          const normalized = normalizeBR(rawPhone);
          const { id: numberId, tried } = await resolveWhatsAppNumber(client, normalized);
          return { rawPhone, normalized, numberId, tried, error: null };
        } catch (e) {
          return { rawPhone, normalized: rawPhone, numberId: null, tried: [], error: String(e) };
        }
      })
    );
    
    // Filtra números válidos
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
    
    // OTIMIZAÇÃO: Envia para todos os números em PARALELO
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
    
    // Aguarda todos os envios em paralelo
    const sendResults = await Promise.all(sendPromises);
    
    // Combina resultados (válidos + inválidos)
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

/* ===== endpoints Tuya ===== */
app.get('/tuya/devices', auth, async (req, res) => {
  const rid = requestId();
  const { uid } = req.query;
  log(`[TUYA-DEVICES][${rid}] Listando dispositivos | ip=${ip(req)} | uid=${uid || 'não fornecido'}`);

  if (!uid) {
    return res.status(400).json({
      ok: false,
      error: 'Parâmetro uid é necessário (query: ?uid=seu_uid)',
      requestId: rid
    });
  }

  try {
    const devices = await getTuyaDevices(uid);
    
    // Processa cada dispositivo para obter status
    const devicesWithStatus = await Promise.all(devices.map(async (device) => {
      try {
        const status = await getTuyaDeviceStatus(device.id);
        
        // Identifica quais estão ligados
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

app.get('/tuya/device/:deviceId/status', auth, async (req, res) => {
  const rid = requestId();
  const { deviceId } = req.params;
  log(`[TUYA-STATUS][${rid}] Consultando status do dispositivo ${deviceId} | ip=${ip(req)}`);

  try {
    const status = await getTuyaDeviceStatus(deviceId);
    
    // Identifica quais dispositivos estão ligados
    const poweredOn = status.filter(s => {
      const code = s.code?.toLowerCase() || '';
      const value = s.value;
      
      // Verifica códigos comuns de ligado/desligado
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
        const status = await getTuyaDeviceStatus(deviceId);
        
        // Identifica quais estão ligados
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

app.listen(PORT, () => { log(`🚀 API ouvindo em ${PORT}`); if (DEBUG) log('DEBUG ativo'); });