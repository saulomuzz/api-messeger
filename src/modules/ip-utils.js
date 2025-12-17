/**
 * Módulo de Utilidades de IP
 * Centraliza funções de manipulação e validação de endereços IP
 */

/**
 * Normaliza endereço IP removendo prefixo IPv6 mapeado
 * @param {string} ipAddress - Endereço IP
 * @returns {string} IP normalizado
 */
function normalizeIp(ipAddress) {
  if (!ipAddress) return 'unknown';
  
  // Remove prefixo IPv6 mapeado para IPv4 (::ffff:)
  if (ipAddress.startsWith('::ffff:')) {
    return ipAddress.substring(7);
  }
  
  return ipAddress;
}

/**
 * Verifica se um IP é local (loopback ou rede privada)
 * @param {string} ip - Endereço IP
 * @returns {boolean} true se for IP local
 */
function isLocalIP(ip) {
  if (!ip || ip === 'unknown' || ip === 'localhost') return true;
  
  // Normaliza o IP
  const normalizedIp = normalizeIp(ip);
  
  // IPv6 loopback
  if (normalizedIp === '::1') return true;
  
  // IPv4 loopback e privados
  const parts = normalizedIp.split('.');
  if (parts.length !== 4) return false;
  
  const [a, b] = parts.map(Number);
  
  // Valida se são números válidos
  if (isNaN(a) || isNaN(b)) return false;
  
  // 10.0.0.0/8 - Classe A privada
  if (a === 10) return true;
  
  // 192.168.0.0/16 - Classe C privada
  if (a === 192 && b === 168) return true;
  
  // 172.16.0.0/12 - Classe B privada
  if (a === 172 && b >= 16 && b <= 31) return true;
  
  // 127.0.0.0/8 - Loopback
  if (a === 127) return true;
  
  // 169.254.0.0/16 - Link-local
  if (a === 169 && b === 254) return true;

  return false;
}

/**
 * Verifica se um IP está dentro de um range CIDR
 * @param {string} ipAddress - Endereço IP a verificar
 * @param {string} cidr - Range CIDR (ex: 192.168.1.0/24)
 * @returns {boolean} true se o IP está no range
 */
function ipInCidr(ipAddress, cidr) {
  if (!ipAddress || !cidr) return false;
  
  const [network, prefixStr] = cidr.split('/');
  const prefixLength = parseInt(prefixStr, 10);
  
  if (isNaN(prefixLength) || prefixLength < 0 || prefixLength > 32) {
    return false;
  }
  
  const networkParts = network.split('.').map(Number);
  const ipParts = normalizeIp(ipAddress).split('.').map(Number);
  
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

/**
 * Verifica se um IP está em uma lista de IPs ou CIDRs
 * @param {string} ip - Endereço IP a verificar
 * @param {Array<string>} allowList - Lista de IPs ou CIDRs permitidos
 * @returns {boolean} true se o IP está na lista
 */
function isIPInList(ip, allowList) {
  if (!ip || !allowList || allowList.length === 0) return false;
  
  const normalizedIp = normalizeIp(ip);
  
  return allowList.some(allowedIp => {
    if (allowedIp.includes('/')) {
      return ipInCidr(normalizedIp, allowedIp);
    }
    return normalizedIp === normalizeIp(allowedIp);
  });
}

/**
 * Ranges de IPs do Meta/Facebook para webhooks (FALLBACK)
 * Usado quando o banco de dados não está disponível
 * Fonte: https://developers.facebook.com/docs/whatsapp/on-premises/reference/webhook-validation
 */
const META_WEBHOOK_IP_RANGES_FALLBACK = [
  // Facebook/Meta IP ranges
  '173.252.64.0/18',
  '173.252.88.0/21',
  '66.220.144.0/20',
  '69.63.176.0/20',
  '69.171.224.0/19',
  '74.119.76.0/22',
  '103.4.96.0/22',
  '157.240.0.0/16',
  '179.60.192.0/22',
  '185.60.216.0/22',
  '204.15.20.0/22',
  '31.13.24.0/21',
  '31.13.64.0/18'
];

// Cache local para ranges do banco (evita consultas frequentes)
let _trustedRangesCache = {};
let _trustedRangesCacheTime = {};
const TRUSTED_RANGES_CACHE_TTL = 60 * 1000; // 1 minuto

/**
 * Obtém ranges confiáveis do banco ou fallback
 * @param {string} category - Categoria (ex: 'meta')
 * @param {Object} ipBlocker - Módulo ip-blocker (opcional)
 * @returns {Promise<string[]>} Array de CIDRs
 */
async function getTrustedRanges(category, ipBlocker = null) {
  const now = Date.now();
  const cacheKey = category.toLowerCase();
  
  // Verifica cache local
  if (_trustedRangesCache[cacheKey] && 
      (now - _trustedRangesCacheTime[cacheKey]) < TRUSTED_RANGES_CACHE_TTL) {
    return _trustedRangesCache[cacheKey];
  }
  
  // Tenta buscar do banco via ipBlocker
  if (ipBlocker && typeof ipBlocker.getTrustedRangesByCategory === 'function') {
    try {
      const ranges = await ipBlocker.getTrustedRangesByCategory(category);
      if (ranges && ranges.length > 0) {
        _trustedRangesCache[cacheKey] = ranges;
        _trustedRangesCacheTime[cacheKey] = now;
        return ranges;
      }
    } catch (e) {
      // Silencia erro e usa fallback
    }
  }
  
  // Fallback para ranges hardcoded (apenas Meta)
  if (category.toLowerCase() === 'meta') {
    return META_WEBHOOK_IP_RANGES_FALLBACK;
  }
  
  return [];
}

/**
 * Verifica se um IP pertence ao Meta/Facebook (para webhooks)
 * Versão síncrona usando cache local
 * @param {string} ip - Endereço IP
 * @returns {boolean} true se for IP do Meta
 */
function isMetaIP(ip) {
  // Usa cache se disponível, senão usa fallback
  const ranges = _trustedRangesCache['meta'] || META_WEBHOOK_IP_RANGES_FALLBACK;
  return isIPInList(ip, ranges);
}

/**
 * Verifica se um IP pertence ao Meta/Facebook (versão async)
 * Busca ranges do banco de dados
 * @param {string} ip - Endereço IP
 * @param {Object} ipBlocker - Módulo ip-blocker
 * @returns {Promise<boolean>} true se for IP do Meta
 */
async function isMetaIPAsync(ip, ipBlocker) {
  const ranges = await getTrustedRanges('meta', ipBlocker);
  return isIPInList(ip, ranges);
}

/**
 * Verifica se um IP está em uma categoria confiável
 * @param {string} ip - Endereço IP
 * @param {string} category - Categoria (ex: 'meta', 'cloudflare', 'esp32')
 * @param {Object} ipBlocker - Módulo ip-blocker
 * @returns {Promise<boolean>} true se for IP confiável
 */
async function isTrustedIP(ip, category, ipBlocker) {
  const ranges = await getTrustedRanges(category, ipBlocker);
  return isIPInList(ip, ranges);
}

/**
 * Verifica se um IP está em QUALQUER categoria confiável
 * @param {string} ip - Endereço IP
 * @param {Object} ipBlocker - Módulo ip-blocker
 * @returns {Promise<{trusted: boolean, category: string|null}>}
 */
async function checkTrustedIP(ip, ipBlocker) {
  if (!ipBlocker || typeof ipBlocker.getEnabledTrustedRanges !== 'function') {
    // Fallback: verifica apenas Meta
    if (isIPInList(ip, META_WEBHOOK_IP_RANGES_FALLBACK)) {
      return { trusted: true, category: 'meta' };
    }
    return { trusted: false, category: null };
  }
  
  try {
    const allRanges = await ipBlocker.getEnabledTrustedRanges();
    
    for (const range of allRanges) {
      if (ipInCidr(ip, range.cidr)) {
        return { trusted: true, category: range.category };
      }
    }
  } catch (e) {
    // Em caso de erro, verifica fallback do Meta
    if (isIPInList(ip, META_WEBHOOK_IP_RANGES_FALLBACK)) {
      return { trusted: true, category: 'meta' };
    }
  }
  
  return { trusted: false, category: null };
}

/**
 * Limpa cache de ranges confiáveis
 */
function clearTrustedRangesCache() {
  _trustedRangesCache = {};
  _trustedRangesCacheTime = {};
}

/**
 * Valida formato de endereço IP (IPv4)
 * @param {string} ip - Endereço IP
 * @returns {boolean} true se for formato válido
 */
function isValidIPv4(ip) {
  if (!ip || typeof ip !== 'string') return false;
  
  const normalizedIp = normalizeIp(ip);
  const parts = normalizedIp.split('.');
  
  if (parts.length !== 4) return false;
  
  return parts.every(part => {
    const num = parseInt(part, 10);
    return !isNaN(num) && num >= 0 && num <= 255 && String(num) === part;
  });
}

/**
 * Valida formato CIDR
 * @param {string} cidr - Range CIDR
 * @returns {boolean} true se for formato válido
 */
function isValidCIDR(cidr) {
  if (!cidr || typeof cidr !== 'string') return false;
  
  const cidrRegex = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
  if (!cidrRegex.test(cidr)) return false;
  
  const [network, prefixStr] = cidr.split('/');
  const prefix = parseInt(prefixStr, 10);
  
  if (prefix < 0 || prefix > 32) return false;
  
  return isValidIPv4(network);
}

/**
 * Extrai IP do cliente de uma requisição Express
 * @param {Object} req - Requisição Express
 * @returns {string} IP do cliente
 */
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const forwardedIp = forwarded ? forwarded.split(',')[0].trim() : null;
  
  return forwardedIp || 
         req.socket?.remoteAddress || 
         req.ip || 
         'unknown';
}

module.exports = {
  normalizeIp,
  isLocalIP,
  ipInCidr,
  isIPInList,
  isMetaIP,
  isMetaIPAsync,
  isTrustedIP,
  checkTrustedIP,
  getTrustedRanges,
  clearTrustedRangesCache,
  isValidIPv4,
  isValidCIDR,
  getClientIp,
  META_WEBHOOK_IP_RANGES: META_WEBHOOK_IP_RANGES_FALLBACK // Para compatibilidade
};
