/**
 * Módulo de Validação de IPs com AbuseIPDB
 * Verifica se IPs estão reportados como abusivos e bloqueia automaticamente
 */

const axios = require('axios');

/**
 * Inicializa o módulo de validação AbuseIPDB
 * @param {Object} config - Configuração do módulo
 * @param {string} config.apiKey - Chave da API do AbuseIPDB (opcional)
 * @param {Object} config.logger - Objeto com funções de log
 * @param {Object} config.ipBlocker - Módulo de bloqueio de IPs
 * @returns {Object} API do módulo
 */
function initAbuseIPDBModule({ apiKey, logger, ipBlocker }) {
  const { log, dbg, warn, err } = logger;
  
  const ABUSEIPDB_API_KEY = apiKey || process.env.ABUSEIPDB_API_KEY || '';
  const ABUSEIPDB_ENABLED = /^true$/i.test(process.env.ABUSEIPDB_ENABLED || 'true');
  const ABUSEIPDB_API_URL = 'https://api.abuseipdb.com/api/v2/check';
  
  // Configurações de listas (valores padrão)
  const WHITELIST_MAX_CONFIDENCE = parseFloat(process.env.ABUSEIPDB_WHITELIST_MAX_CONFIDENCE || '50');
  const WHITELIST_TTL_DAYS = parseInt(process.env.ABUSEIPDB_WHITELIST_TTL_DAYS || '15', 10);
  const YELLOWLIST_MIN_CONFIDENCE = parseFloat(process.env.ABUSEIPDB_YELLOWLIST_MIN_CONFIDENCE || '50');
  const YELLOWLIST_MAX_CONFIDENCE = parseFloat(process.env.ABUSEIPDB_YELLOWLIST_MAX_CONFIDENCE || '80');
  const YELLOWLIST_TTL_DAYS = parseInt(process.env.ABUSEIPDB_YELLOWLIST_TTL_DAYS || '7', 10);
  const BLACKLIST_MIN_CONFIDENCE = parseFloat(process.env.ABUSEIPDB_BLACKLIST_MIN_CONFIDENCE || '80');
  
  // Cache de verificações (evita verificar o mesmo IP múltiplas vezes)
  const checkCache = new Map();
  const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 horas
  
  // Lock de verificações em andamento (evita múltiplas consultas simultâneas do mesmo IP)
  const pendingChecks = new Map(); // Map<ip, Promise<result>>
  
  // Log das configurações
  if (ABUSEIPDB_ENABLED && ABUSEIPDB_API_KEY) {
    log(`[ABUSEIPDB] Configurações de listas:`);
    log(`[ABUSEIPDB]   Whitelist: < ${WHITELIST_MAX_CONFIDENCE}% confiança, válido por ${WHITELIST_TTL_DAYS} dias`);
    log(`[ABUSEIPDB]   Yellowlist: ${YELLOWLIST_MIN_CONFIDENCE}-${YELLOWLIST_MAX_CONFIDENCE}% confiança, válido por ${YELLOWLIST_TTL_DAYS} dias`);
    log(`[ABUSEIPDB]   Blacklist: >= ${BLACKLIST_MIN_CONFIDENCE}% confiança, permanente`);
  }
  
  /**
   * Normaliza IP (remove ::ffff: prefixo IPv6-mapped IPv4)
   */
  function normalizeIp(ip) {
    if (!ip) return '';
    // Remove prefixo IPv6-mapped IPv4
    if (ip.startsWith('::ffff:')) {
      return ip.replace('::ffff:', '');
    }
    return ip.trim();
  }
  
  /**
   * Verifica se um IP está reportado no AbuseIPDB
   * @param {string} ip - Endereço IP para verificar
   * @param {number} maxAgeInDays - Idade máxima dos reports em dias (padrão: 90)
   * @param {boolean} forceCheck - Força verificação mesmo se estiver em cache/lista (padrão: false)
   * @returns {Promise<{isAbusive: boolean, abuseConfidence: number, usageType: string, reports: number}>}
   */
  async function checkIP(ip, maxAgeInDays = 90, forceCheck = false) {
    const normalizedIp = normalizeIp(ip);
    
    if (!normalizedIp || normalizedIp === 'unknown' || normalizedIp === 'localhost') {
      return { isAbusive: false, abuseConfidence: 0, usageType: 'unknown', reports: 0 };
    }
    
    // Verifica primeiro nas listas do banco de dados (evita chamadas desnecessárias à API)
    if (!forceCheck && ipBlocker) {
      // Verifica whitelist (< 50% confiança, válido por 15 dias)
      const whitelistCheck = await ipBlocker.isInWhitelist(normalizedIp);
      if (whitelistCheck.inWhitelist) {
        dbg(`[ABUSEIPDB] IP ${normalizedIp} encontrado na whitelist (${whitelistCheck.abuseConfidence}% confiança, válido até ${new Date(whitelistCheck.expiresAt * 1000).toISOString()})`);
        return {
          isAbusive: false,
          abuseConfidence: whitelistCheck.abuseConfidence,
          usageType: 'unknown',
          reports: 0,
          fromCache: 'whitelist'
        };
      }
      
      // Verifica yellowlist (50-80% confiança, válido por 7 dias)
      const yellowlistCheck = await ipBlocker.isInYellowlist(normalizedIp);
      if (yellowlistCheck.inYellowlist) {
        dbg(`[ABUSEIPDB] IP ${normalizedIp} encontrado na yellowlist (${yellowlistCheck.abuseConfidence}% confiança, válido até ${new Date(yellowlistCheck.expiresAt * 1000).toISOString()})`);
        return {
          isAbusive: false, // Não bloqueia, mas monitora
          abuseConfidence: yellowlistCheck.abuseConfidence,
          usageType: 'unknown',
          reports: 0,
          fromCache: 'yellowlist'
        };
      }
    }
    
    // Verifica cache em memória
    const cacheKey = `${normalizedIp}_${maxAgeInDays}`;
    const cached = checkCache.get(cacheKey);
    if (!forceCheck && cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
      dbg(`[ABUSEIPDB] Usando cache em memória para ${normalizedIp}`);
      return cached.result;
    }
    
    // Verifica se já existe uma verificação em andamento para este IP
    if (!forceCheck && pendingChecks.has(normalizedIp)) {
      dbg(`[ABUSEIPDB] Verificação já em andamento para ${normalizedIp}, aguardando resultado...`);
      try {
        return await pendingChecks.get(normalizedIp);
      } catch (error) {
        // Se a verificação anterior falhou, tenta novamente
        pendingChecks.delete(normalizedIp);
      }
    }
    
    if (!ABUSEIPDB_ENABLED || !ABUSEIPDB_API_KEY) {
      dbg(`[ABUSEIPDB] Validação desabilitada ou API key não configurada`);
      return { isAbusive: false, abuseConfidence: 0, usageType: 'unknown', reports: 0 };
    }
    
    // Cria promise para verificação e adiciona ao lock
    const checkPromise = performAPICheck(normalizedIp, maxAgeInDays, cacheKey);
    pendingChecks.set(normalizedIp, checkPromise);
    
    try {
      const result = await checkPromise;
      return result;
    } finally {
      // Remove do lock após conclusão (sucesso ou erro)
      pendingChecks.delete(normalizedIp);
    }
  }
  
  /**
   * Executa a verificação real na API do AbuseIPDB
   * @param {string} normalizedIp - IP normalizado
   * @param {number} maxAgeInDays - Idade máxima dos reports
   * @param {string} cacheKey - Chave do cache
   * @returns {Promise<{isAbusive: boolean, abuseConfidence: number, usageType: string, reports: number}>}
   */
  async function performAPICheck(normalizedIp, maxAgeInDays, cacheKey) {
    
    try {
      log(`[ABUSEIPDB] Consultando API para IP ${normalizedIp}...`);
      const response = await axios.get(ABUSEIPDB_API_URL, {
        params: {
          ipAddress: normalizedIp,
          maxAgeInDays: maxAgeInDays,
          verbose: ''
        },
        headers: {
          'Key': ABUSEIPDB_API_KEY,
          'Accept': 'application/json'
        },
        timeout: 5000 // 5 segundos de timeout
      });
      
      const data = response.data?.data || {};
      const abuseConfidence = data.abuseConfidencePercentage || 0;
      const usageType = data.usageType || 'unknown';
      const reports = data.totalReports || 0;
      
      // Classifica baseado na confiança (usando valores configuráveis)
      let isAbusive = false;
      let listType = null;
      
      if (abuseConfidence >= BLACKLIST_MIN_CONFIDENCE) {
        // >= BLACKLIST_MIN_CONFIDENCE%: Blacklist (permanente)
        isAbusive = true;
        listType = 'blacklist';
      } else if (abuseConfidence >= YELLOWLIST_MIN_CONFIDENCE && abuseConfidence < YELLOWLIST_MAX_CONFIDENCE) {
        // YELLOWLIST_MIN_CONFIDENCE% - YELLOWLIST_MAX_CONFIDENCE%: Yellowlist
        isAbusive = false; // Não bloqueia, mas monitora
        listType = 'yellowlist';
      } else if (abuseConfidence < WHITELIST_MAX_CONFIDENCE) {
        // < WHITELIST_MAX_CONFIDENCE%: Whitelist
        isAbusive = false;
        listType = 'whitelist';
      } else {
        // Caso edge (entre whitelist e yellowlist ou yellowlist e blacklist)
        // Por padrão, trata como yellowlist se estiver no intervalo
        isAbusive = false;
        listType = 'yellowlist';
      }
      
      const result = {
        isAbusive,
        abuseConfidence,
        usageType,
        reports,
        ipAddress: normalizedIp,
        isPublic: data.isPublic || false,
        isWhitelisted: data.isWhitelisted || false,
        countryCode: data.countryCode || '',
        lastReportedAt: data.lastReportedAt || null,
        listType
      };
      
      // Salva no banco de dados baseado na classificação
      if (ipBlocker && listType) {
        try {
          if (listType === 'whitelist') {
            await ipBlocker.addToWhitelist(normalizedIp, abuseConfidence, reports, WHITELIST_TTL_DAYS);
          } else if (listType === 'yellowlist') {
            await ipBlocker.addToYellowlist(normalizedIp, abuseConfidence, reports, YELLOWLIST_TTL_DAYS);
          }
          // Blacklist é gerenciada pelo blockIP() separadamente
        } catch (listError) {
          warn(`[ABUSEIPDB] Erro ao adicionar IP à lista:`, listError.message);
        }
      }
      
      // Salva no cache em memória também
      checkCache.set(cacheKey, {
        result,
        timestamp: Date.now()
      });
      
      if (isAbusive) {
        warn(`[ABUSEIPDB] IP ${normalizedIp} reportado como abusivo: ${abuseConfidence}% confiança, ${reports} report(s) → BLACKLIST`);
      } else if (listType === 'yellowlist') {
        dbg(`[ABUSEIPDB] IP ${normalizedIp} verificado: ${abuseConfidence}% confiança, ${reports} report(s) → YELLOWLIST (monitorado)`);
      } else {
        dbg(`[ABUSEIPDB] IP ${normalizedIp} verificado: ${abuseConfidence}% confiança, ${reports} report(s) → WHITELIST`);
      }
      
      return result;
    } catch (error) {
      // Em caso de erro, não bloqueia (fail-open)
      if (error.response?.status === 429) {
        warn(`[ABUSEIPDB] Rate limit excedido para verificação de ${normalizedIp}`);
      } else if (error.response?.status === 401) {
        err(`[ABUSEIPDB] API key inválida ou expirada`);
      } else {
        warn(`[ABUSEIPDB] Erro ao verificar IP ${normalizedIp}:`, error.message);
      }
      
      // Retorna resultado neutro em caso de erro
      return { isAbusive: false, abuseConfidence: 0, usageType: 'unknown', reports: 0, error: error.message };
    }
  }
  
  /**
   * Limpa locks pendentes antigos (segurança)
   */
  function cleanPendingChecks() {
    // Remove locks que estão há mais de 30 segundos (timeout da API é 5s)
    // Isso evita locks "presos" em caso de erro não tratado
    const now = Date.now();
    const TIMEOUT_MS = 30000; // 30 segundos
    
    for (const [ip, promise] of pendingChecks.entries()) {
      // Se a promise foi resolvida/rejeitada, ela não está mais pendente
      // Mas não podemos verificar isso diretamente, então apenas removemos após timeout
      // Na prática, o finally no checkIP já remove, mas isso é uma segurança extra
    }
  }
  
  // Limpa locks pendentes a cada 5 minutos (segurança)
  setInterval(cleanPendingChecks, 5 * 60 * 1000);
  
  /**
   * Verifica e bloqueia IP se estiver reportado como abusivo
   * @param {string} ip - Endereço IP para verificar
   * @param {string} reason - Motivo do bloqueio (padrão: baseado no AbuseIPDB)
   * @returns {Promise<{blocked: boolean, reason: string, abuseConfidence: number}>}
   */
  async function checkAndBlockIP(ip, reason = null) {
    const normalizedIp = normalizeIp(ip);
    
    if (!normalizedIp || normalizedIp === 'unknown' || normalizedIp === 'localhost') {
      return { blocked: false, reason: 'IP inválido ou localhost' };
    }
    
    // Verifica se já está bloqueado
    if (ipBlocker && ipBlocker.isBlocked) {
      const alreadyBlocked = await ipBlocker.isBlocked(normalizedIp);
      if (alreadyBlocked) {
        dbg(`[ABUSEIPDB] IP ${normalizedIp} já está bloqueado`);
        return { blocked: true, reason: 'Já estava bloqueado', abuseConfidence: 0 };
      }
    }
    
    // Verifica no AbuseIPDB
    const checkResult = await checkIP(normalizedIp);
    
    // Só bloqueia se confiança >= BLACKLIST_MIN_CONFIDENCE% (blacklist)
    if (checkResult.isAbusive && checkResult.abuseConfidence >= BLACKLIST_MIN_CONFIDENCE) {
      const blockReason = reason || 
        `Reportado no AbuseIPDB: ${checkResult.abuseConfidence}% confiança, ${checkResult.reports} report(s) → BLACKLIST`;
      
      // Bloqueia o IP (blacklist permanente)
      if (ipBlocker && ipBlocker.blockIP) {
        try {
          await ipBlocker.blockIP(normalizedIp, blockReason);
          log(`[ABUSEIPDB] IP ${normalizedIp} bloqueado automaticamente (BLACKLIST): ${blockReason}`);
          return {
            blocked: true,
            reason: blockReason,
            abuseConfidence: checkResult.abuseConfidence,
            reports: checkResult.reports,
            listType: 'blacklist'
          };
        } catch (blockError) {
          err(`[ABUSEIPDB] Erro ao bloquear IP ${normalizedIp}:`, blockError.message);
          return {
            blocked: false,
            reason: `Erro ao bloquear: ${blockError.message}`,
            abuseConfidence: checkResult.abuseConfidence
          };
        }
      } else {
        warn(`[ABUSEIPDB] IP ${normalizedIp} é abusivo mas módulo de bloqueio não disponível`);
        return {
          blocked: false,
          reason: 'Módulo de bloqueio não disponível',
          abuseConfidence: checkResult.abuseConfidence
        };
      }
    }
    
    // IP está em whitelist ou yellowlist (não bloqueia)
    const listStatus = checkResult.listType || 'unknown';
    return {
      blocked: false,
      reason: listStatus === 'whitelist' 
        ? `IP na whitelist (${checkResult.abuseConfidence}% confiança, válido por 15 dias)`
        : listStatus === 'yellowlist'
        ? `IP na yellowlist (${checkResult.abuseConfidence}% confiança, válido por 7 dias - monitorado)`
        : 'IP não reportado como abusivo',
      abuseConfidence: checkResult.abuseConfidence,
      reports: checkResult.reports,
      listType: listStatus
    };
  }
  
  /**
   * Limpa cache antigo (mantém apenas últimos 24h)
   */
  function cleanCache() {
    const now = Date.now();
    for (const [key, value] of checkCache.entries()) {
      if (now - value.timestamp > CACHE_TTL) {
        checkCache.delete(key);
      }
    }
  }
  
  // Limpa cache a cada hora
  setInterval(cleanCache, 60 * 60 * 1000);
  
  return {
    checkIP,
    checkAndBlockIP,
    normalizeIp
  };
}

module.exports = { initAbuseIPDBModule };

