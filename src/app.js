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
const APP_ROOT = process.env.APP_ROOT || '/opt/whatsapp-api';
const NUMBERS_FILE = process.env.NUMBERS_FILE || path.join(APP_ROOT, 'numbers.txt');
const AUTH_DATA_PATH = process.env.AUTH_DATA_PATH || path.join(APP_ROOT, '.wwebjs_auth');
const ESP32_TOKEN = process.env.ESP32_TOKEN || '';
const ESP32_ALLOWED_IPS = process.env.ESP32_ALLOWED_IPS ? process.env.ESP32_ALLOWED_IPS.split(',').map(ip => ip.trim()) : [];

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
const log  = (...a) => out('INFO', ...a);
const dbg  = (...a) => { if (DEBUG) out('DEBUG', ...a); };
const warn = (...a) => out('WARN', ...a);
const err  = (...a) => out('ERROR', ...a);

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
            '--disable-dev-shm-usage'
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

    // Responde ao comando !ping (sem diferenciar maiúsculas/minúsculas)
    if (message.body.toLowerCase() === '!ping') {
        log(`[CMD] Comando !ping recebido de ${message.from}. Respondendo...`);
        try {
            await message.reply('pong');
            log(`[CMD] Resposta 'pong' enviada para ${message.from}.`);
        } catch (e) {
            err(`[CMD] Falha ao responder 'pong' para ${message.from}:`, e.message);
        }
    }
});

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
async function downloadSnapshot(url, username, password) {
  if (!username || !password) {
    throw new Error('CAMERA_USER e CAMERA_PASS devem estar configurados');
  }
  
  const cleanUrl = url.replace(/\/\/[^@]+@/, '//');
  const displayUrl = cleanUrl;
  
  log(`[SNAPSHOT] Baixando snapshot de ${displayUrl}`);
  
  // Debug: mostra credenciais se DEBUG estiver ativo
  if (DEBUG) {
    dbg(`[SNAPSHOT] Credenciais - User: ${username}, Pass: ${password}`);
    dbg(`[SNAPSHOT] URL: ${cleanUrl}`);
  }
  
  // Tenta primeiro com autenticação básica
  try {
    if (DEBUG) {
      dbg(`[SNAPSHOT] Tentando autenticação Basic HTTP`);
    }
    
    const response = await axios.get(cleanUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
      auth: { username, password },
      validateStatus: (status) => status === 200,
      headers: {
        'User-Agent': 'WhatsApp-API/1.0',
        'Accept': 'image/*,*/*'
      }
    });
    
    if (!response.data || response.data.length === 0) {
      throw new Error('Resposta vazia da câmera');
    }
    
    const buffer = Buffer.from(response.data);
    const base64 = buffer.toString('base64');
    const mimeType = response.headers['content-type'] || 'image/jpeg';
    
    log(`[SNAPSHOT] Snapshot baixado com sucesso (Basic): ${buffer.length} bytes, tipo: ${mimeType}`);
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
        dbg(`[SNAPSHOT] Todos os headers da resposta:`, JSON.stringify(e1.response?.headers || {}, null, 2));
        dbg(`[SNAPSHOT] Tipo de autenticação detectado: ${isDigest ? 'Digest' : 'Basic (ou não especificado)'}`);
        dbg(`[SNAPSHOT] Corpo da resposta (primeiros 200 chars):`, e1.response?.data ? String(e1.response.data).slice(0, 200) : '(vazio)');
      }
      
      // Se for Digest, implementa autenticação Digest manualmente
      if (isDigest) {
        try {
          if (DEBUG) {
            dbg(`[SNAPSHOT] Tentando autenticação Digest HTTP`);
            dbg(`[SNAPSHOT] Parsing WWW-Authenticate: ${wwwAuth}`);
          }
          
          // Parse do header WWW-Authenticate (formato: Digest realm="...", qop="...", nonce="...", opaque="...")
          const digestParams = {};
          
          // Extrai realm (pode ter espaços, então precisa de parsing mais cuidadoso)
          const realmMatch = wwwAuth.match(/realm="([^"]+)"/);
          const nonceMatch = wwwAuth.match(/nonce="([^"]+)"/);
          const qopMatch = wwwAuth.match(/qop="([^"]+)"/);
          const opaqueMatch = wwwAuth.match(/opaque="([^"]+)"/);
          
          const realm = realmMatch ? realmMatch[1] : '';
          const nonce = nonceMatch ? nonceMatch[1] : '';
          const qop = qopMatch ? qopMatch[1] : '';
          const opaque = opaqueMatch ? opaqueMatch[1] : '';
          
          // Implementação de Digest Authentication
          const urlObj = new URL(cleanUrl);
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
          
          // nc (nonce count) - sempre 00000001 para primeira requisição
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
            dbg(`[SNAPSHOT] HA1 input: "${ha1Input}" -> HA1: ${ha1}`);
            dbg(`[SNAPSHOT] HA2 input: "${ha2Input}" -> HA2: ${ha2}`);
            dbg(`[SNAPSHOT] Response input: "${responseInput}" -> Response: ${responseHash}`);
            dbg(`[SNAPSHOT] cnonce: ${cnonce}, nc: ${nc}`);
          }
          
          // Monta o header Authorization (ordem específica pode ser importante)
          let authHeader = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${responseHash}"`;
          if (qop) {
            authHeader += `, qop="${qop}", nc=${nc}, cnonce="${cnonce}"`;
          }
          if (opaque) {
            authHeader += `, opaque="${opaque}"`;
          }
          
          if (DEBUG) {
            dbg(`[SNAPSHOT] Authorization header: ${authHeader}`);
          }
          
          // Faz a requisição com o header Authorization
          const response = await axios.get(cleanUrl, {
            responseType: 'arraybuffer',
            timeout: 15000,
            headers: {
              'User-Agent': 'WhatsApp-API/1.0',
              'Accept': 'image/*,*/*',
              'Authorization': authHeader
            },
            validateStatus: (status) => status === 200
          });
          
          if (!response.data || response.data.length === 0) {
            throw new Error('Resposta vazia da câmera');
          }
          
          const buffer = Buffer.from(response.data);
          const base64 = buffer.toString('base64');
          const mimeType = response.headers['content-type'] || 'image/jpeg';
          
          log(`[SNAPSHOT] Snapshot baixado com sucesso (Digest): ${buffer.length} bytes, tipo: ${mimeType}`);
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
      // Outro tipo de erro
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
    
    // Envia para cada número
    const results = [];
    const message = req.body?.message || '📸 Snapshot da câmera';
    
    for (const rawPhone of numbers) {
      try {
        const normalized = normalizeBR(rawPhone);
        const { id: numberId, tried } = await resolveWhatsAppNumber(client, normalized);
        
        if (!numberId) {
          warn(`[SNAPSHOT][${rid}] Número não está no WhatsApp: ${normalized} | tried=${tried.join(',')}`);
          results.push({ phone: normalized, success: false, error: 'not_on_whatsapp', tried });
          continue;
        }

        const to = numberId._serialized;
        const r = await client.sendMessage(to, media, { caption: message });
        log(`[SNAPSHOT OK][${rid}] Enviado para ${to} | id=${r.id?._serialized || 'n/a'}`);
        results.push({ phone: normalized, success: true, to, msgId: r.id?._serialized || null });
      } catch (e) {
        err(`[SNAPSHOT][${rid}] Erro ao enviar para ${rawPhone}:`, e.message);
        results.push({ phone: rawPhone, success: false, error: String(e) });
      }
    }

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

app.listen(PORT, () => { log(`🚀 API ouvindo em ${PORT}`); if (DEBUG) log('DEBUG ativo'); });