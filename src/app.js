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

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');


/* ===== env ===== */
const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.API_TOKEN || '';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const DEBUG = /^true$/i.test(process.env.DEBUG || 'false');
const LOG_PATH = process.env.LOG_PATH || '/var/log/whatsapp-api.log';
const SIG_MAX_SKEW = parseInt(process.env.SIG_MAX_SKEW_SECONDS || '300', 10);
const REQUIRE_SIGNED = /^true$/i.test(process.env.REQUIRE_SIGNED_REQUESTS || 'false');
const PUBLIC_KEY_PATH_RAW = process.env.PUBLIC_KEY_PATH || '';

/* ===== logging ===== */
try {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  if (!fs.existsSync(LOG_PATH)) fs.writeFileSync(LOG_PATH, '');
} catch (error) {
  console.warn('[WARN] Falha ao preparar arquivo de log:', error.message);
}

const append = (line) => {
  try {
    fs.appendFileSync(LOG_PATH, line);
  } catch (error) {
    console.warn('[WARN] Falha ao gravar log:', error.message);
  }
};

const nowISO = () => new Date().toISOString();
const out = (level, ...args) => {
  const line = `[${level}] ${nowISO()} ${args
    .map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
    .join(' ')}\n`;
  append(line);
  if (level === 'ERROR') console.error(line.trim());
  else if (level === 'WARN') console.warn(line.trim());
  else console.log(line.trim());
};
const log = (...args) => out('INFO', ...args);
const dbg = (...args) => {
  if (DEBUG) out('DEBUG', ...args);
};
const warn = (...args) => out('WARN', ...args);
const err = (...args) => out('ERROR', ...args);

/* ===== load public key ===== */
const expandHome = (p) => (p && p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
let publicKeyPem = '';
try {
  const resolvedPath = expandHome(PUBLIC_KEY_PATH_RAW);
  if (resolvedPath) {
    publicKeyPem = fs.readFileSync(resolvedPath, 'utf8');
    if (!/BEGIN PUBLIC KEY/.test(publicKeyPem)) throw new Error('Arquivo não parece PEM');
    dbg(`Chave pública carregada de ${resolvedPath}`);
  }
} catch (e) {
  if (PUBLIC_KEY_PATH_RAW) err('Falha ao carregar a chave pública (PUBLIC_KEY_PATH):', e.message);
}

/* ===== express ===== */
const app = express();
app.set('trust proxy', 1);
app.use(
  express.json({

    limit: '2mb',

    verify: (req, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  }),
);
app.use(helmet());
app.use(
  cors({
    origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN,
    methods: ['GET', 'POST'],
    allowedHeaders: [
      'Content-Type',
      'X-API-Token',
      'X-Date',
      'X-Content-SHA256',
      'X-Signature',
      'X-Sign-Alg',
      'X-Forwarded-For',
    ],
  }),
);
app.use(rateLimit({ windowMs: 60_000, max: 120 }));

const ip = (req) =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
  req.socket?.remoteAddress ||
  req.ip ||
  'unknown';

if (DEBUG) {
  app.use((req, _res, next) => {
    dbg(`HTTP ${req.method} ${req.originalUrl} | ip=${ip(req)}`);
    if (req.method === 'POST')
      dbg(`RAW: ${(req.rawBody || '').slice(0, 512)}${(req.rawBody || '').length > 512 ? '…' : ''}`);
    next();
  });
}

/* ===== auth token (opcional) ===== */
function auth(req, res, next) {
  if (!API_TOKEN) return next();
  const token = req.header('X-API-Token') || '';
  if (token !== API_TOKEN) {
    warn(`401 invalid token | uri=${req.originalUrl} ip=${ip(req)}`);
    return res.status(401).json({ error: 'invalid token' });
  }
  return next();
}

/* ===== assinatura (RSA-SHA256) ===== */
function verifySignedRequest(req, endpointPath) {
  if (!REQUIRE_SIGNED) return true;
  if (!publicKeyPem) {
    warn('Requisição assinada recebida, mas nenhuma chave pública foi carregada. Rejeitando.');
    return false;
  }

  const alg = (req.header('X-Sign-Alg') || '').toLowerCase();
  const sigB64 = req.header('X-Signature') || '';
  const xDate = req.header('X-Date') || '';
  const body64 = req.header('X-Content-SHA256') || '';
  if (alg !== 'rsa-sha256' || !sigB64 || !xDate || !body64) return false;

  const ts = Date.parse(xDate);
  if (!ts || Math.abs(Date.now() - ts) > SIG_MAX_SKEW * 1000) return false;

  const hash = crypto.createHash('sha256').update(req.rawBody || '').digest('base64');
  if (hash !== body64) return false;

  const canonical = `POST\n${endpointPath}\n${body64}\n${xDate}`;
  try {
    return crypto.verify(
      'sha256',
      Buffer.from(canonical, 'utf8'),
      crypto.createPublicKey(publicKeyPem),
      Buffer.from(sigB64, 'base64'),
    );
  } catch (error) {
    err('Falha ao verificar assinatura:', error.message);
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
  const match = /^\+55(\d{2})(\d+)$/.exec(e164);
  if (!match) return null;
  const ddd = match[1];
  const subscriber = match[2];
  if (subscriber.length === 8) return null;
  if (subscriber.length === 9 && subscriber.startsWith('9')) return `+55${ddd}${subscriber.slice(1)}`;
  if (subscriber.length === 10) return `+55${ddd}9${subscriber}`;
  return null;
}

function requestId() {
  return (crypto.randomUUID && crypto.randomUUID()) || crypto.randomBytes(16).toString('hex');
}


function sanitizeBase64(input) {
  return String(input || '').replace(/\r?\n|\s/g, '');
}

function parseMediaPayload(media) {
  if (!media || typeof media !== 'object') {
    return { error: 'media payload is required' };
  }
  const mimetype = String(media.mimetype || '').trim();
  const filename = media.filename ? String(media.filename).trim() : undefined;
  if (!mimetype) return { error: 'media.mimetype is required' };
  if (!media.data) return { error: 'media.data is required' };
  const base64 = sanitizeBase64(media.data);
  if (!base64) return { error: 'media.data is empty' };
  try {
    // Validate base64 by decoding; Buffer throws on invalid length/characters.
    Buffer.from(base64, 'base64');
  } catch (error) {
    return { error: `invalid base64 media data: ${error.message}` };
  }
  return { media: new MessageMedia(mimetype, base64, filename) };
}


/* ===== whatsapp client ===== */
log('Iniciando cliente WhatsApp...');
let lastQR = null;
let isReady = false;
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    dumpio: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  },
});

client.on('loading_screen', (percent, message) => {
  log(`[STATUS] Carregando: ${percent}% - ${message}`);
});

client.on('qr', (qr) => {
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

client.on('auth_failure', (message) => {
  isReady = false;
  err('[AUTH] Falha na autenticação!', message, 'Limpe a pasta .wwebjs_auth e tente novamente.');
});

client.on('disconnected', (reason) => {
  isReady = false;
  warn('[STATUS] Cliente desconectado.', reason, 'Tentando reconectar em 5 segundos...');
  setTimeout(() => client.initialize(), 5000);
});

client.on('message', async (message) => {
  if (message.isStatus) return;

  log(`[MSG] Mensagem recebida de ${message.from}: "${message.body}"`);

  if (message.body.toLowerCase() === '!ping') {
    log(`[CMD] Comando !ping recebido de ${message.from}. Respondendo...`);
    try {
      await message.reply('pong');
      log(`[CMD] Resposta 'pong' enviada para ${message.from}.`);
    } catch (error) {
      err(`[CMD] Falha ao responder 'pong' para ${message.from}:`, error.message);
    }
  }
});

client
  .initialize()
  .catch((error) => err('[INIT] Falha ao inicializar o cliente:', error.message));

/* ===== resolutor de número (getNumberId + fallback com/sem 9) ===== */
async function resolveWhatsAppNumber(clientInstance, e164) {
  const tried = [];
  const toDigits = (s) => String(s || '').replace(/\D/g, '');
  tried.push(e164);
  let id = await clientInstance.getNumberId(toDigits(e164)).catch(() => null);
  if (id) return { id, tried };
  const alt = toggleNineBR(e164);
  if (alt && !tried.includes(alt)) {
    tried.push(alt);
    id = await clientInstance.getNumberId(toDigits(alt)).catch(() => null);
    if (id) return { id, tried };
  }
  return { id: null, tried };
}

/* ===== endpoints ===== */
app.get('/health', (_req, res) =>
  res.json({ ok: true, service: 'whatsapp-web.js', ready: isReady, ts: nowISO() }),
);

app.get('/status', auth, async (_req, res) => {
  try {
    const state = await client.getState().catch(() => null);
    res.json({ ok: true, ready: isReady, state: state || 'unknown', ts: nowISO() });
  } catch (error) {
    err('status:', error);
    res.status(500).json({ ok: false, ready: false, error: String(error) });
  }
});

app.get('/qr.png', async (_req, res) => {
  if (!lastQR) return res.status(404).send('No QR available');
  try {
    const png = await QRCode.toBuffer(lastQR, { type: 'png', margin: 1, scale: 6 });
    res.setHeader('Content-Type', 'image/png');
    res.send(png);
  } catch (error) {
    err('qr:', error);
    res.status(500).send('Failed to render QR');
  }
});

/* ===== envio de mensagem (com normalização + verificação) ===== */
app.post('/send', auth, async (req, res) => {
  const rid = requestId();
  if (!verifySignedRequest(req, '/send')) {
    warn(`[SEND][${rid}] 403 invalid signature /send`);
    return res.status(403).json({ ok: false, error: 'invalid signature', requestId: rid });
  }
  if (!isReady)
    return res.status(503).json({ ok: false, error: 'whatsapp not ready', requestId: rid });
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
      return res
        .status(404)
        .json({ ok: false, error: 'not_on_whatsapp', requestId: rid, tried });
    }
    const to = numberId._serialized;
    const body = subject ? `*${String(subject).trim()}*\n\n${message}` : message;
    const response = await client.sendMessage(to, body);
    log(`[SEND OK][${rid}] to=${to} id=${response.id?._serialized || 'n/a'} tried=${tried.join(',')}`);
    return res.json({
      ok: true,
      requestId: rid,
      to,
      msgId: response.id?._serialized || null,
      normalized,
      tried,
    });
  } catch (error) {
    err(`[SEND][${rid}] ERRO`, error);
    return res.status(500).json({ ok: false, error: String(error), requestId: rid });
  }
});


app.post('/send-media', auth, async (req, res) => {
  const rid = requestId();
  if (!verifySignedRequest(req, '/send-media')) {
    warn(`[MEDIA][${rid}] 403 invalid signature /send-media`);
    return res.status(403).json({ ok: false, error: 'invalid signature', requestId: rid });
  }
  if (!isReady)
    return res.status(503).json({ ok: false, error: 'whatsapp not ready', requestId: rid });

  const { phone, caption, media } = req.body || {};
  if (!phone || !media) {
    return res
      .status(400)
      .json({ ok: false, error: 'phone and media are required', requestId: rid });
  }
  const rawPhone = String(phone);
  const normalized = normalizeBR(rawPhone);
  log(
    `[MEDIA][${rid}] POST recebido | ip=${ip(req)} | raw_phone=${rawPhone} | normalized=${normalized}`,
  );

  const parsed = parseMediaPayload(media);
  if (parsed.error) {
    warn(`[MEDIA][${rid}] payload inválido: ${parsed.error}`);
    return res.status(400).json({ ok: false, error: parsed.error, requestId: rid });
  }

  try {
    const { id: numberId, tried } = await resolveWhatsAppNumber(client, normalized);
    if (!numberId) {
      warn(`[MEDIA][${rid}] Número não está no WhatsApp | tried=${tried.join(',')}`);
      return res
        .status(404)
        .json({ ok: false, error: 'not_on_whatsapp', requestId: rid, tried });
    }
    const to = numberId._serialized;
    const options = caption ? { caption: String(caption) } : undefined;
    const response = await client.sendMessage(to, parsed.media, options);
    log(
      `[MEDIA OK][${rid}] to=${to} id=${response.id?._serialized || 'n/a'} tried=${tried.join(',')}`,
    );
    return res.json({
      ok: true,
      requestId: rid,
      to,
      msgId: response.id?._serialized || null,
      normalized,
      tried,
    });
  } catch (error) {
    err(`[MEDIA][${rid}] ERRO`, error);
    return res.status(500).json({ ok: false, error: String(error), requestId: rid });
  }
});


app.listen(PORT, () => {
  log(`🚀 API ouvindo em ${PORT}`);
  if (DEBUG) log('DEBUG ativo');
});
