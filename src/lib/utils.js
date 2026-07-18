const crypto = require('crypto');
const net = require('net');

function requestId() {
  return crypto.randomBytes(10).toString('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.pbkdf2Sync(String(password || ''), salt, 120000, 32, 'sha256').toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, storedHash) {
  const [salt, derived] = String(storedHash || '').split(':');
  if (!salt || !derived) {
    return false;
  }
  const candidate = crypto.pbkdf2Sync(String(password || ''), salt, 120000, 32, 'sha256').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(derived, 'hex'));
}

function maskSecret(value) {
  const text = String(value || '');
  if (!text) {
    return '';
  }
  if (text.length <= 4) {
    return '*'.repeat(text.length);
  }
  return `${'*'.repeat(Math.max(4, text.length - 4))}${text.slice(-4)}`;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseList(value) {
  return String(value || '')
    .split(/[\n,;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0];
  }
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || '';
}

function normalizeIp(ip) {
  const value = String(ip || '').trim();
  if (!value) {
    return '';
  }
  if (value.startsWith('::ffff:')) {
    return value.slice(7);
  }
  return value;
}

function ipToInt(ip) {
  return normalizeIp(ip)
    .split('.')
    .reduce((acc, octet) => ((acc << 8) >>> 0) + Number.parseInt(octet, 10), 0) >>> 0;
}

function ipInCidr(ip, cidr) {
  const target = normalizeIp(ip);
  const block = String(cidr || '').trim();
  if (!target || !block) {
    return false;
  }
  if (!block.includes('/')) {
    return target === normalizeIp(block);
  }
  if (!net.isIPv4(target)) {
    return false;
  }
  const [range, prefixRaw] = block.split('/');
  const prefix = Number.parseInt(prefixRaw, 10);
  if (!net.isIPv4(range) || !Number.isFinite(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }
  const mask = prefix === 0 ? 0 : (~((1 << (32 - prefix)) - 1)) >>> 0;
  return (ipToInt(target) & mask) === (ipToInt(range) & mask);
}

function isIpInList(ip, list) {
  return (list || []).some((entry) => ipInCidr(ip, entry));
}

function normalizePhoneBR(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  // Números BR de 13 dígitos (com o 9º dígito) → normaliza para 12 dígitos
  if (s.length === 13 && s.startsWith('55') && s[4] === '9') {
    return s.slice(0, 4) + s.slice(5);
  }
  return s;
}

function safeJsonParse(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function sanitizePayload(value) {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sanitizePayload);
  }
  if (typeof value !== 'object') {
    return value;
  }
  const blocked = new Set(['access_token', 'authorization', 'token', 'verify_token', 'password', 'secret']);
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (blocked.has(String(key).toLowerCase())) {
      result[key] = '[masked]';
      continue;
    }
    result[key] = sanitizePayload(entry);
  }
  return result;
}

module.exports = {
  getClientIp,
  hashPassword,
  ipInCidr,
  isIpInList,
  maskSecret,
  normalizeIp,
  normalizePhoneBR,
  nowIso,
  parseBoolean,
  parseList,
  parsePositiveInt,
  requestId,
  safeJsonParse,
  sanitizePayload,
  sha256,
  verifyPassword,
};
