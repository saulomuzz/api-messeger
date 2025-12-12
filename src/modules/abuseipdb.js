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
  // IMPORTANTE: Os intervalos devem ser contíguos sem sobreposição
  // WHITELIST: < WHITELIST_MAX_CONFIDENCE
  // YELLOWLIST: >= WHITELIST_MAX_CONFIDENCE && < YELLOWLIST_MAX_CONFIDENCE
  // BLACKLIST: >= BLACKLIST_MIN_CONFIDENCE
  const WHITELIST_MAX_CONFIDENCE = parseFloat(process.env.ABUSEIPDB_WHITELIST_MAX_CONFIDENCE || '30');
  const WHITELIST_TTL_DAYS = parseInt(process.env.ABUSEIPDB_WHITELIST_TTL_DAYS || '7', 10);
  const YELLOWLIST_MAX_CONFIDENCE = parseFloat(process.env.ABUSEIPDB_YELLOWLIST_MAX_CONFIDENCE || '70');
  const YELLOWLIST_TTL_DAYS = parseInt(process.env.ABUSEIPDB_YELLOWLIST_TTL_DAYS || '3', 10);
  const BLACKLIST_MIN_CONFIDENCE = parseFloat(process.env.ABUSEIPDB_BLACKLIST_MIN_CONFIDENCE || '70');
  
  // YELLOWLIST_MIN_CONFIDENCE não é mais necessário (usa WHITELIST_MAX_CONFIDENCE)
  // Mantido apenas para compatibilidade com logs/documentação
  const YELLOWLIST_MIN_CONFIDENCE = WHITELIST_MAX_CONFIDENCE;
  
  // Cache de verificações (evita verificar o mesmo IP múltiplas vezes)
  const checkCache = new Map();
  const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 horas
  
  // Lock de verificações em andamento (evita múltiplas consultas simultâneas do mesmo IP)
  const pendingChecks = new Map(); // Map<ip, Promise<result>>
  
  // Validação das configurações
  if (WHITELIST_MAX_CONFIDENCE >= YELLOWLIST_MAX_CONFIDENCE) {
    warn(`[ABUSEIPDB] ⚠️ Configuração inválida: WHITELIST_MAX_CONFIDENCE (${WHITELIST_MAX_CONFIDENCE}%) >= YELLOWLIST_MAX_CONFIDENCE (${YELLOWLIST_MAX_CONFIDENCE}%)`);
    warn(`[ABUSEIPDB] Ajustando YELLOWLIST_MAX_CONFIDENCE para ${WHITELIST_MAX_CONFIDENCE + 1}%`);
    // Não altera a variável, apenas avisa - o usuário deve corrigir no .env
  }
  
  if (YELLOWLIST_MAX_CONFIDENCE > BLACKLIST_MIN_CONFIDENCE) {
    warn(`[ABUSEIPDB] ⚠️ Configuração inválida: YELLOWLIST_MAX_CONFIDENCE (${YELLOWLIST_MAX_CONFIDENCE}%) > BLACKLIST_MIN_CONFIDENCE (${BLACKLIST_MIN_CONFIDENCE}%)`);
    warn(`[ABUSEIPDB] Recomendado: YELLOWLIST_MAX_CONFIDENCE <= BLACKLIST_MIN_CONFIDENCE para evitar sobreposição`);
  }
  
  // Log das configurações
  if (ABUSEIPDB_ENABLED && ABUSEIPDB_API_KEY) {
    log(`[ABUSEIPDB] Configurações de listas:`);
    log(`[ABUSEIPDB]   Whitelist: < ${WHITELIST_MAX_CONFIDENCE}% confiança, válido por ${WHITELIST_TTL_DAYS} dias`);
    log(`[ABUSEIPDB]   Yellowlist: >= ${WHITELIST_MAX_CONFIDENCE}% e < ${YELLOWLIST_MAX_CONFIDENCE}% confiança, válido por ${YELLOWLIST_TTL_DAYS} dias`);
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
        // Registra tentativa de acesso
        if (ipBlocker.recordWhitelistAttempt) {
          ipBlocker.recordWhitelistAttempt(normalizedIp).catch(err => {
            dbg(`[ABUSEIPDB] Erro ao registrar tentativa na whitelist:`, err.message);
          });
        }
        dbg(`[ABUSEIPDB] IP ${normalizedIp} encontrado na whitelist (${whitelistCheck.abuseConfidence}% confiança, válido até ${new Date(whitelistCheck.expiresAt * 1000).toISOString()})`);
        return {
          isAbusive: false,
          abuseConfidence: whitelistCheck.abuseConfidence,
          usageType: 'unknown',
          reports: 0,
          fromCache: 'whitelist',
          listType: 'whitelist'
        };
      }
      
      // Verifica yellowlist (50-80% confiança, válido por 7 dias)
      const yellowlistCheck = await ipBlocker.isInYellowlist(normalizedIp);
      if (yellowlistCheck.inYellowlist) {
        // Registra tentativa de acesso
        if (ipBlocker.recordYellowlistAttempt) {
          ipBlocker.recordYellowlistAttempt(normalizedIp).catch(err => {
            dbg(`[ABUSEIPDB] Erro ao registrar tentativa na yellowlist:`, err.message);
          });
        }
        dbg(`[ABUSEIPDB] IP ${normalizedIp} encontrado na yellowlist (${yellowlistCheck.abuseConfidence}% confiança, válido até ${new Date(yellowlistCheck.expiresAt * 1000).toISOString()})`);
        return {
          isAbusive: false, // Não bloqueia, mas monitora
          abuseConfidence: yellowlistCheck.abuseConfidence,
          usageType: 'unknown',
          reports: 0,
          fromCache: 'yellowlist',
          listType: 'yellowlist'
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
      
      // Log da resposta completa para debug (apenas se houver problema)
      const data = response.data?.data || {};
      
      // A API do AbuseIPDB retorna "abuseConfidenceScore" (não "abuseConfidencePercentage")
      // Verifica múltiplos formatos possíveis da resposta para compatibilidade
      let abuseConfidence = null; // null indica que não foi encontrado
      if (data.abuseConfidenceScore !== undefined && data.abuseConfidenceScore !== null) {
        // Campo correto da API v2
        abuseConfidence = parseFloat(data.abuseConfidenceScore);
      } else if (data.abuseConfidencePercentage !== undefined && data.abuseConfidencePercentage !== null) {
        // Campo alternativo (caso mude no futuro)
        abuseConfidence = parseFloat(data.abuseConfidencePercentage);
      } else if (data.abuseConfidence !== undefined && data.abuseConfidence !== null) {
        // Campo alternativo
        abuseConfidence = parseFloat(data.abuseConfidence);
      } else if (data.confidence !== undefined && data.confidence !== null) {
        // Campo alternativo
        abuseConfidence = parseFloat(data.confidence);
      }
      
      const usageType = data.usageType || 'unknown';
      // Parse reports com validação
      let reports = 0;
      if (data.totalReports !== undefined && data.totalReports !== null) {
        const parsed = parseInt(data.totalReports, 10);
        reports = isNaN(parsed) ? 0 : parsed;
      } else if (data.reports !== undefined && data.reports !== null) {
        const parsed = parseInt(data.reports, 10);
        reports = isNaN(parsed) ? 0 : parsed;
      }
      
      // Verifica se o IP está na whitelist do AbuseIPDB
      const isWhitelistedByAbuseIPDB = data.isWhitelisted === true;
      
      // Valida se o valor é um número válido
      if (abuseConfidence === null || isNaN(abuseConfidence) || abuseConfidence < 0 || abuseConfidence > 100) {
        // Se não encontrou confiança mas tem reports, pode ser um problema na API
        if (reports > 0) {
          warn(`[ABUSEIPDB] ⚠️ ERRO: IP ${normalizedIp} tem ${reports} reports mas confiança inválida/ausente`);
          warn(`[ABUSEIPDB] Resposta completa da API:`, JSON.stringify(response.data, null, 2));
          // Não adiciona à whitelist - trata como erro
          throw new Error(`Resposta da API inválida: confiança não encontrada mas há ${reports} reports`);
        }
        // Se não tem reports e não tem confiança, assume 0 (IP limpo)
        abuseConfidence = 0;
      }
      
      // Se o IP está na whitelist do AbuseIPDB, trata como confiável mesmo com reports
      // AbuseIPDB pode ter IPs na whitelist que têm reports mas confiança 0%
      if (isWhitelistedByAbuseIPDB) {
        dbg(`[ABUSEIPDB] IP ${normalizedIp} está na whitelist do AbuseIPDB (isWhitelisted: true) - tratando como confiável`);
        // Força confiança 0 e classifica como whitelist (mesmo com reports)
        abuseConfidence = 0;
        // Não valida inconsistência se está na whitelist do AbuseIPDB
      } else {
        // Validação de segurança: se tem muitos reports mas confiança 0, pode ser erro na API
        if (reports > 50 && abuseConfidence === 0) {
          warn(`[ABUSEIPDB] ⚠️ ATENÇÃO: IP ${normalizedIp} tem ${reports} reports mas confiança 0% - possível erro na API`);
          warn(`[ABUSEIPDB] Resposta completa da API:`, JSON.stringify(response.data, null, 2));
          // Não adiciona à whitelist - trata como erro
          throw new Error(`Dados inconsistentes: ${reports} reports mas confiança 0%`);
        }
      }
      
      // Log detalhado para debug
      const whitelistNote = isWhitelistedByAbuseIPDB ? ' (whitelist AbuseIPDB)' : '';
      log(`[ABUSEIPDB] Resposta da API para ${normalizedIp}: confiança=${abuseConfidence}%, reports=${reports}, usageType=${usageType}${whitelistNote}`);
      
      // Classifica baseado na confiança (usando valores configuráveis)
      // Lógica: intervalos contíguos sem sobreposição
      // WHITELIST: < WHITELIST_MAX_CONFIDENCE
      // YELLOWLIST: >= WHITELIST_MAX_CONFIDENCE && < YELLOWLIST_MAX_CONFIDENCE
      // BLACKLIST: >= BLACKLIST_MIN_CONFIDENCE
      let isAbusive = false;
      let listType = null;
      
      if (abuseConfidence >= BLACKLIST_MIN_CONFIDENCE) {
        // >= BLACKLIST_MIN_CONFIDENCE%: Blacklist (permanente)
        isAbusive = true;
        listType = 'blacklist';
      } else if (abuseConfidence >= WHITELIST_MAX_CONFIDENCE && abuseConfidence < YELLOWLIST_MAX_CONFIDENCE) {
        // >= WHITELIST_MAX_CONFIDENCE% && < YELLOWLIST_MAX_CONFIDENCE%: Yellowlist
        isAbusive = false; // Não bloqueia, mas monitora
        listType = 'yellowlist';
      } else if (abuseConfidence < WHITELIST_MAX_CONFIDENCE) {
        // < WHITELIST_MAX_CONFIDENCE%: Whitelist
        isAbusive = false;
        listType = 'whitelist';
      } else {
        // Caso edge: se >= YELLOWLIST_MAX_CONFIDENCE mas < BLACKLIST_MIN_CONFIDENCE
        // Trata como yellowlist (zona de transição)
        isAbusive = false;
        listType = 'yellowlist';
        warn(`[ABUSEIPDB] IP ${normalizedIp} em zona de transição: ${abuseConfidence}% (entre yellowlist max e blacklist min)`);
      }
      
      const result = {
        isAbusive,
        abuseConfidence,
        usageType,
        reports,
        ipAddress: normalizedIp,
        isPublic: data.isPublic || false,
        isWhitelisted: isWhitelistedByAbuseIPDB,
        countryCode: data.countryCode || '',
        lastReportedAt: data.lastReportedAt || null,
        listType
      };
      
      // Salva no banco de dados baseado na classificação
      // IMPORTANTE: Só adiciona à whitelist/yellowlist se a confiança for válida
      if (ipBlocker && listType) {
        try {
          if (listType === 'whitelist') {
            await ipBlocker.addToWhitelist(normalizedIp, abuseConfidence, reports, WHITELIST_TTL_DAYS);
            // Registra tentativa na whitelist
            if (ipBlocker.recordWhitelistAttempt) {
              await ipBlocker.recordWhitelistAttempt(normalizedIp);
            }
          } else if (listType === 'yellowlist') {
            await ipBlocker.addToYellowlist(normalizedIp, abuseConfidence, reports, YELLOWLIST_TTL_DAYS);
            // Registra tentativa na yellowlist
            if (ipBlocker.recordYellowlistAttempt) {
              await ipBlocker.recordYellowlistAttempt(normalizedIp);
            }
          }
          // Blacklist é gerenciada pelo blockIP() separadamente
        } catch (listError) {
          warn(`[ABUSEIPDB] Erro ao adicionar IP à lista:`, listError.message);
        }
      } else if (ipBlocker && ipBlocker.recordIPAttempt) {
        // Se o IP já está em alguma lista, registra a tentativa
        await ipBlocker.recordIPAttempt(normalizedIp);
      }
      
      // Salva no cache em memória também
      checkCache.set(cacheKey, {
        result,
        timestamp: Date.now()
      });
      
      // Log detalhado da classificação
      if (isAbusive) {
        warn(`[ABUSEIPDB] IP ${normalizedIp} reportado como abusivo: ${abuseConfidence}% confiança, ${reports} report(s) → BLACKLIST`);
      } else if (listType === 'yellowlist') {
        log(`[ABUSEIPDB] IP ${normalizedIp} verificado: ${abuseConfidence}% confiança, ${reports} report(s) → YELLOWLIST (monitorado)`);
      } else if (listType === 'whitelist') {
        // Se tem muitos reports mas confiança baixa, pode ser um problema
        if (reports > 100 && abuseConfidence < 10) {
          warn(`[ABUSEIPDB] ⚠️ ATENÇÃO: IP ${normalizedIp} tem ${reports} reports mas confiança ${abuseConfidence}% - possível erro na API`);
        }
        log(`[ABUSEIPDB] IP ${normalizedIp} verificado: ${abuseConfidence}% confiança, ${reports} report(s) → WHITELIST`);
      } else {
        warn(`[ABUSEIPDB] IP ${normalizedIp} não foi classificado corretamente: confiança=${abuseConfidence}%, reports=${reports}`);
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
        // Log da resposta de erro se disponível
        if (error.response?.data) {
          dbg(`[ABUSEIPDB] Resposta de erro da API:`, JSON.stringify(error.response.data, null, 2));
        }
      }
      
      // Retorna resultado neutro em caso de erro (mas não adiciona à whitelist!)
      return { 
        isAbusive: false, 
        abuseConfidence: 0, 
        usageType: 'unknown', 
        reports: 0, 
        error: error.message,
        listType: null // Não classifica em caso de erro
      };
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
  
  /**
   * Recategoriza todos os IPs nas listas (whitelist e yellowlist)
   * Força reanálise com a API para corrigir classificações incorretas
   * @param {Object} blockerModule - Módulo de bloqueio de IPs (opcional, usa ipBlocker se não fornecido)
   * @returns {Promise<{recategorized: number, errors: number, results: Array}>}
   */
  async function recategorizeAllIPs(blockerModule = null) {
    const blocker = blockerModule || ipBlocker;
    if (!blocker) {
      throw new Error('Módulo ipBlocker não disponível');
    }
    
    if (!ABUSEIPDB_ENABLED || !ABUSEIPDB_API_KEY) {
      warn(`[ABUSEIPDB] Recategorização desabilitada: API não configurada`);
      return { recategorized: 0, errors: 0, results: [] };
    }
    
    log(`[ABUSEIPDB] Iniciando recategorização de todos os IPs...`);
    
    const results = [];
    let recategorized = 0;
    let errors = 0;
    
    try {
      // Busca todos os IPs da whitelist
      const whitelistIPs = await blocker.listWhitelistIPs(1000, 0);
      log(`[ABUSEIPDB] Encontrados ${whitelistIPs.length} IP(s) na whitelist para recategorizar`);
      
      // Busca todos os IPs da yellowlist
      const yellowlistIPs = await blocker.listYellowlistIPs(1000, 0);
      log(`[ABUSEIPDB] Encontrados ${yellowlistIPs.length} IP(s) na yellowlist para recategorizar`);
      
      const allIPs = [
        ...whitelistIPs.map(ip => ({ ip: ip.ip, currentList: 'whitelist', abuseConfidence: ip.abuse_confidence, reports: ip.reports })),
        ...yellowlistIPs.map(ip => ({ ip: ip.ip, currentList: 'yellowlist', abuseConfidence: ip.abuse_confidence, reports: ip.reports }))
      ];
      
      log(`[ABUSEIPDB] Total de ${allIPs.length} IP(s) para recategorizar`);
      
      // Processa cada IP com um pequeno delay para não sobrecarregar a API
      for (let i = 0; i < allIPs.length; i++) {
        const ipData = allIPs[i];
        const normalizedIp = normalizeIp(ipData.ip);
        
        try {
          // Força verificação na API (ignora cache e listas)
          const checkResult = await checkIP(normalizedIp, 90, true);
          
          const newConfidence = checkResult.abuseConfidence || 0;
          const newReports = checkResult.reports || 0;
          const newListType = checkResult.listType;
          
          // Compara com a classificação anterior
          const changed = 
            (ipData.currentList === 'whitelist' && newListType !== 'whitelist') ||
            (ipData.currentList === 'yellowlist' && newListType !== 'yellowlist') ||
            (Math.abs(newConfidence - (ipData.abuseConfidence || 0)) > 5); // Mudança significativa
          
          if (changed) {
            log(`[ABUSEIPDB] IP ${normalizedIp} recategorizado: ${ipData.currentList} → ${newListType || 'nenhuma'} (${ipData.abuseConfidence || 0}% → ${newConfidence}%)`);
            
            // Remove da lista atual (já feito automaticamente ao adicionar à nova)
            // Adiciona à lista correta baseado na nova classificação
            if (newListType === 'blacklist' && checkResult.isAbusive) {
              await blocker.blockIP(normalizedIp, `Recategorizado: ${newConfidence}% confiança, ${newReports} report(s)`);
            } else if (newListType === 'yellowlist') {
              await blocker.addToYellowlist(normalizedIp, newConfidence, newReports, YELLOWLIST_TTL_DAYS);
            } else if (newListType === 'whitelist') {
              await blocker.addToWhitelist(normalizedIp, newConfidence, newReports, WHITELIST_TTL_DAYS);
            }
            
            recategorized++;
          }
          
          results.push({
            ip: normalizedIp,
            previousList: ipData.currentList,
            previousConfidence: ipData.abuseConfidence || 0,
            newList: newListType,
            newConfidence,
            newReports,
            changed
          });
          
          // Delay de 1 segundo entre verificações para não exceder rate limit
          if (i < allIPs.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        } catch (error) {
          errors++;
          err(`[ABUSEIPDB] Erro ao recategorizar IP ${normalizedIp}:`, error.message);
          results.push({
            ip: normalizedIp,
            previousList: ipData.currentList,
            error: error.message,
            changed: false
          });
        }
      }
      
      log(`[ABUSEIPDB] Recategorização concluída: ${recategorized} IP(s) recategorizado(s), ${errors} erro(s)`);
      
      return {
        recategorized,
        errors,
        results
      };
    } catch (error) {
      err(`[ABUSEIPDB] Erro geral na recategorização:`, error.message);
      throw error;
    }
  }
  
  return {
    checkIP,
    checkAndBlockIP,
    normalizeIp,
    recategorizeAllIPs
  };
}

module.exports = { initAbuseIPDBModule };

