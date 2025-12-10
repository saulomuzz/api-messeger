/**
 * Módulo de Utilitários
 * Funções auxiliares para logging, telefone, etc.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Inicializa o sistema de logging
 * @param {Object} config - Configuração
 * @param {string} config.logPath - Caminho do arquivo de log
 * @param {boolean} config.debug - Modo debug
 * @param {boolean} config.useLocalTimezone - Usar horário local ao invés de UTC (padrão: false)
 * @returns {Object} Funções de logging
 */
function initLogger({ logPath, debug = false, useLocalTimezone = false }) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    if (!fs.existsSync(logPath)) fs.writeFileSync(logPath, '');
  } catch {}
  
  const append = (l) => { try { fs.appendFileSync(logPath, l); } catch {} };
  
  // Função para formatar data/hora no timezone local
  const formatLocalDateTime = () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const ms = String(now.getMilliseconds()).padStart(3, '0');
    
    // Obtém o offset do timezone em minutos e converte para formato +/-HH:MM
    const offset = -now.getTimezoneOffset(); // Inverte porque getTimezoneOffset retorna o oposto
    const offsetHours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
    const offsetMinutes = String(Math.abs(offset) % 60).padStart(2, '0');
    const offsetSign = offset >= 0 ? '+' : '-';
    const timezone = `${offsetSign}${offsetHours}:${offsetMinutes}`;
    
    return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${ms}${timezone}`;
  };
  
  const nowISO = () => {
    // Se useLocalTimezone estiver habilitado, usa horário local
    // Caso contrário, mantém UTC (compatibilidade)
    return useLocalTimezone ? formatLocalDateTime() : new Date().toISOString();
  };
  
  const out = (lvl, ...a) => {
    const line = `[${lvl}] ${nowISO()} ${a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')}\n`;
    append(line);
    if (lvl === 'ERROR') console.error(line.trim());
    else if (lvl === 'WARN') console.warn(line.trim());
    else console.log(line.trim());
  };
  
  const log = (...a) => out('INFO', ...a);
  const dbg = (...a) => { if (debug) out('DEBUG', ...a); };
  const warn = (...a) => out('WARN', ...a);
  const err = (...a) => out('ERROR', ...a);
  
  return { log, dbg, warn, err, nowISO, DEBUG: debug };
}

/**
 * Funções de normalização de telefone (BR/E.164)
 */
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

/**
 * Gera um ID único para requisições
 */
function requestId() {
  return (crypto.randomUUID && crypto.randomUUID()) || crypto.randomBytes(16).toString('hex');
}

/**
 * Lê números do arquivo de números autorizados
 */
function readNumbersFromFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#') && line.length > 0);
    return lines;
  } catch (e) {
    return [];
  }
}

/**
 * Normaliza número para comparação (remove tudo exceto dígitos)
 */
function normalizeForComparison(phoneNumber) {
  const cleaned = digitsOnly(phoneNumber);
  // Remove zeros à esquerda
  const withoutLeadingZeros = cleaned.replace(/^0+/, '');
  // Se não começa com 55, adiciona
  if (!withoutLeadingZeros.startsWith('55') && withoutLeadingZeros.length >= 10) {
    return '55' + withoutLeadingZeros;
  }
  return withoutLeadingZeros;
}

/**
 * Verifica se um número está autorizado
 * @param {string} senderPhoneNumber - Número do remetente
 * @param {string} numbersFile - Caminho do arquivo com números autorizados
 * @param {Function} debugLog - Função opcional para log de debug
 */
function isNumberAuthorized(senderPhoneNumber, numbersFile, debugLog = null) {
  try {
    const authorizedNumbers = readNumbersFromFile(numbersFile);
    if (authorizedNumbers.length === 0) {
      if (debugLog) debugLog(`[AUTH] Arquivo vazio, permitindo acesso para ${senderPhoneNumber}`);
      return true; // Se arquivo vazio, permite todos
    }

    const cleanSender = senderPhoneNumber.split('@')[0];
    const senderDigits = digitsOnly(cleanSender);
    const senderNormalized = normalizeBR(cleanSender);
    const senderForComparison = normalizeForComparison(cleanSender);
    
    // Detecta se parece ser um ID de lista (muito longo, geralmente > 13 dígitos)
    const isLikelyListId = senderDigits.length > 13;
    
    if (debugLog) {
      debugLog(`[AUTH] Verificando número: ${senderPhoneNumber}`);
      debugLog(`[AUTH] Limpo: ${cleanSender}, Dígitos: ${senderDigits}, Normalizado: ${senderNormalized}, Comparação: ${senderForComparison}`);
      debugLog(`[AUTH] Números autorizados: ${authorizedNumbers.join(', ')}`);
      if (isLikelyListId) {
        debugLog(`[AUTH] ⚠️ Este número parece ser um ID de lista de transmissão (${senderDigits.length} dígitos)`);
        debugLog(`[AUTH] 💡 Adicione este número (${cleanSender}) no arquivo numbers.txt para permitir acesso via lista de transmissão`);
      }
    }

    const isAuthorized = authorizedNumbers.some(authorized => {
      const authorizedDigits = digitsOnly(authorized);
      const authorizedNormalized = normalizeBR(authorized);
      const authorizedForComparison = normalizeForComparison(authorized);
      
      if (debugLog) {
        debugLog(`[AUTH] Comparando com autorizado: ${authorized} -> Dígitos: ${authorizedDigits}, Normalizado: ${authorizedNormalized}, Comparação: ${authorizedForComparison}`);
      }
      
      // Comparação direta de dígitos
      if (senderDigits === authorizedDigits) {
        if (debugLog) debugLog(`[AUTH] ✅ Match por dígitos diretos`);
        return true;
      }
      
      // Comparação normalizada (E.164)
      if (senderNormalized === authorizedNormalized) {
        if (debugLog) debugLog(`[AUTH] ✅ Match por normalização E.164`);
        return true;
      }
      
      // Comparação sem o +
      const senderNoPlus = senderNormalized.replace(/^\+/, '');
      const authorizedNoPlus = authorizedNormalized.replace(/^\+/, '');
      if (senderNoPlus === authorizedNoPlus) {
        if (debugLog) debugLog(`[AUTH] ✅ Match por normalização sem +`);
        return true;
      }
      
      // Comparação normalizada para comparação (apenas dígitos, com 55)
      if (senderForComparison === authorizedForComparison) {
        if (debugLog) debugLog(`[AUTH] ✅ Match por comparação normalizada`);
        return true;
      }
      
      // Comparação considerando variações com/sem 9
      const senderWith9 = senderForComparison.length === 12 && !senderForComparison.endsWith('9') 
        ? senderForComparison.slice(0, 2) + '9' + senderForComparison.slice(2)
        : senderForComparison;
      const senderWithout9 = senderForComparison.length === 13 && senderForComparison[2] === '9'
        ? senderForComparison.slice(0, 2) + senderForComparison.slice(3)
        : senderForComparison;
      
      const authorizedWith9 = authorizedForComparison.length === 12 && !authorizedForComparison.endsWith('9')
        ? authorizedForComparison.slice(0, 2) + '9' + authorizedForComparison.slice(2)
        : authorizedForComparison;
      const authorizedWithout9 = authorizedForComparison.length === 13 && authorizedForComparison[2] === '9'
        ? authorizedForComparison.slice(0, 2) + authorizedForComparison.slice(3)
        : authorizedForComparison;
      
      if (senderWith9 === authorizedWith9 || senderWithout9 === authorizedWithout9) {
        if (debugLog) debugLog(`[AUTH] ✅ Match por variação com/sem 9`);
        return true;
      }
      if (senderForComparison === authorizedWith9 || senderForComparison === authorizedWithout9) {
        if (debugLog) debugLog(`[AUTH] ✅ Match por comparação com variação 9`);
        return true;
      }
      if (authorizedForComparison === senderWith9 || authorizedForComparison === senderWithout9) {
        if (debugLog) debugLog(`[AUTH] ✅ Match por comparação reversa com variação 9`);
        return true;
      }
      
      return false;
    });
    
    if (debugLog) {
      debugLog(`[AUTH] Resultado final: ${isAuthorized ? '✅ AUTORIZADO' : '❌ NÃO AUTORIZADO'}`);
    }
    
    return isAuthorized;
  } catch (e) {
    // Em caso de erro, permite acesso (comportamento seguro padrão)
    return true;
  }
}

/**
 * Obtém IP do cliente da requisição
 */
function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || req.ip || 'unknown';
}

module.exports = {
  initLogger,
  digitsOnly,
  normalizeBR,
  toggleNineBR,
  requestId,
  readNumbersFromFile,
  isNumberAuthorized,
  getClientIp
};

