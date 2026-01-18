/**
 * Módulo de Administração - Versão que aguarda banco estar pronto
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

function initAdminModule({ app, appRoot, logger, getCurrentIpBlocker, whatsappOfficial, websocketESP32, getClientIp, getAbuseIPDB, tuya, getCurrentTuyaMonitor, getCurrentComedorDeviceStatus, getCurrentRoutesModule }) {
  const { log, warn, err, dbg } = logger;
  
  // Debug: verifica se tuyaMonitor foi recebido
  const initialTuyaMonitor = getCurrentTuyaMonitor?.();
  dbg(`[ADMIN-INIT] tuyaMonitor recebido? ${!!initialTuyaMonitor}`);
  if (initialTuyaMonitor) {
    dbg(`[ADMIN-INIT] tuyaMonitor.collectEnergyReadings? ${typeof initialTuyaMonitor.collectEnergyReadings === 'function'}`);
    dbg(`[ADMIN-INIT] tuyaMonitor métodos disponíveis: ${Object.keys(initialTuyaMonitor).join(', ')}`);
  }
  
  // Função auxiliar para obter IP do cliente
  const getClientIpAddress = getClientIp || ((req) => {
    return req.ip || req.connection?.remoteAddress || 
           req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
           req.socket?.remoteAddress || 'unknown';
  });
  
  // Importa modelo de estatísticas
  const { getStatisticsModel } = require(path.join(appRoot, 'src', 'admin', 'models', 'Statistics'));
  const statisticsModel = getStatisticsModel(() => getCurrentIpBlocker());
  
  // Importa controller e rotas
  const DashboardController = require(path.join(appRoot, 'src', 'admin', 'controllers', 'DashboardController'));
  const createDashboardRoutes = require(path.join(appRoot, 'src', 'admin', 'routes', 'dashboardRoutes'));
  
  // Cria controller
  const dashboardController = new DashboardController({
    statisticsModel,
    ipBlocker: getCurrentIpBlocker(),
    whatsappOfficial,
    websocketESP32
  });
  
  // Serve arquivos estáticos do admin (DEVE ser ANTES de todas as outras rotas admin)
  const express = require('express');
  app.use('/admin/static', express.static(path.join(appRoot, 'src', 'admin', 'static'), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.js')) {
        res.setHeader('Content-Type', 'application/javascript');
      }
    }
  }));
  
  // Registra rotas do dashboard
  createDashboardRoutes({
    app,
    requireAuth,
    dashboardController,
    logger,
    getVideoManager: getCurrentRoutesModule,
    getAuditStore: getCurrentIpBlocker
  });
  
  // Expõe statisticsModel globalmente para outros módulos
  global.statisticsModel = statisticsModel;
  
  
  // Limpa dispositivos inativos a cada 5 minutos
  setInterval(() => {
    statisticsModel.cleanupInactiveDevices();
  }, 5 * 60 * 1000);
  
  // Configurações
  const ADMIN_PHONE_NUMBER = process.env.ADMIN_PHONE_NUMBER || '';
  const ADMIN_CODE_EXPIRY_MINUTES = parseInt(process.env.ADMIN_CODE_EXPIRY_MINUTES || '10', 10);
  const ADMIN_SESSION_EXPIRY_HOURS = parseInt(process.env.ADMIN_SESSION_EXPIRY_HOURS || '24', 10);
  const ADMIN_TRUST_DAYS = parseInt(process.env.ADMIN_TRUST_DAYS || '30', 10);
  
  // Armazena apenas códigos pendentes em memória (expiram rápido)
  // Sessões são persistidas no banco de dados
  const pendingCodes = new Map();
  
  // Cache de sessões em memória (para performance)
  const sessionCache = new Map();
  const SESSION_CACHE_TTL = 5 * 60 * 1000; // 5 minutos
  
  // Funções auxiliares
  function generateAccessCode() {
    return crypto.randomInt(100000, 999999).toString();
  }
  
  function generateSessionId() {
    return crypto.randomBytes(32).toString('hex');
  }
  
  function generateDeviceFingerprint(req) {
    const userAgent = req.headers['user-agent'] || '';
    const ip = getClientIpAddress(req);
    // Fingerprint: hash de user-agent + parte do IP (para ser mais tolerante a mudanças de IP)
    const ipPrefix = ip.split('.').slice(0, 2).join('.'); // Ex: 192.168
    const data = `${userAgent}|${ipPrefix}`;
    return crypto.createHash('sha256').update(data).digest('hex').substring(0, 32);
  }
  
  function getDeviceName(req) {
    const ua = req.headers['user-agent'] || '';
    if (ua.includes('Windows')) return 'Windows';
    if (ua.includes('Mac')) return 'Mac';
    if (ua.includes('Linux')) return 'Linux';
    if (ua.includes('Android')) return 'Android';
    if (ua.includes('iPhone') || ua.includes('iPad')) return 'iOS';
    return 'Desconhecido';
  }
  
  // Limpeza automática de códigos pendentes e cache
  setInterval(() => {
    const now = Date.now();
    for (const [phone, data] of pendingCodes.entries()) {
      if (data.expiresAt < now) pendingCodes.delete(phone);
    }
    // Limpa cache de sessões antigas
    for (const [sessionId, cacheData] of sessionCache.entries()) {
      if (cacheData.cachedAt + SESSION_CACHE_TTL < now) {
        sessionCache.delete(sessionId);
      }
    }
  }, 60 * 1000);
  
  // Limpeza de sessões expiradas no banco (a cada 10 minutos)
  setInterval(async () => {
    try {
      const ipBlocker = getCurrentIpBlocker();
      if (ipBlocker && typeof ipBlocker.cleanExpiredAdminSessions === 'function') {
        const cleaned = await ipBlocker.cleanExpiredAdminSessions();
        if (cleaned > 0) {
          log(`[ADMIN] Limpeza: ${cleaned} sessões expiradas removidas`);
        }
      }
    } catch (e) {
      dbg(`[ADMIN] Erro na limpeza de sessões:`, e.message);
    }
  }, 10 * 60 * 1000);
  
  // Envia código via WhatsApp
  async function sendAccessCode(phone) {
    if (!ADMIN_PHONE_NUMBER || phone !== ADMIN_PHONE_NUMBER) {
      return { success: false, error: 'Unauthorized' };
    }
    
    const code = generateAccessCode();
    pendingCodes.set(phone, {
      code,
      expiresAt: Date.now() + (ADMIN_CODE_EXPIRY_MINUTES * 60 * 1000),
      attempts: 0
    });
    
    try {
      // Padroniza envio de código via template aprovado (login_web_app)
      if (whatsappOfficial?.sendLoginWebAppCode) {
        await whatsappOfficial.sendLoginWebAppCode(phone, code, 'pt_BR');
        return { success: true, channel: 'whatsapp_template', template: 'login_web_app' };
      }
      // Fallback (não recomendado): mantém compatibilidade se o helper não existir
      if (whatsappOfficial?.sendTemplateMessage) {
        const components = [
          { type: 'body', parameters: [{ type: 'text', text: String(code) }] },
          { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: String(code) }] }
        ];
        await whatsappOfficial.sendTemplateMessage(phone, 'login_web_app', 'pt_BR', components);
        return { success: true, channel: 'whatsapp_template', template: 'login_web_app' };
      }
    } catch (error) {
      err(`[ADMIN] Erro ao enviar código:`, error.message);
    }
    return { success: false, error: 'WhatsApp not available' };
  }
  
  // Valida código e cria sessão
  async function validateCode(phone, code, req, trustDevice = false) {
    const codeData = pendingCodes.get(phone);
    if (!codeData || codeData.expiresAt < Date.now() || codeData.code !== code) {
      return { valid: false, error: 'Código inválido ou expirado' };
    }
    
    const sessionId = generateSessionId();
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + (ADMIN_SESSION_EXPIRY_HOURS * 3600);
    
    // Dados da sessão
    const sessionData = {
      phone,
      deviceFingerprint: generateDeviceFingerprint(req),
      deviceName: getDeviceName(req),
      ipAddress: getClientIpAddress(req),
      userAgent: (req.headers['user-agent'] || '').substring(0, 255),
      trustedUntil: trustDevice ? now + (ADMIN_TRUST_DAYS * 24 * 3600) : null,
      createdAt: now,
      expiresAt,
      lastUsedAt: now
    };
    
    // Salva no banco
    try {
      const ipBlocker = getCurrentIpBlocker();
      if (ipBlocker && typeof ipBlocker.saveAdminSession === 'function') {
        await ipBlocker.saveAdminSession(sessionId, sessionData);
        log(`[ADMIN] Sessão criada: ${sessionId.substring(0, 8)}... | Dispositivo: ${sessionData.deviceName} | Confiável: ${trustDevice ? ADMIN_TRUST_DAYS + ' dias' : 'não'}`);
      }
    } catch (e) {
      err(`[ADMIN] Erro ao salvar sessão no banco:`, e.message);
      // Em caso de erro, ainda retorna válido (fallback para memória)
    }
    
    // Adiciona ao cache
    sessionCache.set(sessionId, {
      session: { ...sessionData, session_id: sessionId },
      cachedAt: Date.now()
    });
    
    pendingCodes.delete(phone);
    return { valid: true, sessionId, trusted: trustDevice };
  }
  
  // Valida sessão (primeiro no cache, depois no banco)
  async function validateSession(sessionId) {
    if (!sessionId) return { valid: false };
    
    const now = Math.floor(Date.now() / 1000);
    
    // Verifica cache primeiro
    const cached = sessionCache.get(sessionId);
    if (cached && cached.cachedAt + SESSION_CACHE_TTL > Date.now()) {
      const session = cached.session;
      if (session.expires_at > now || (session.trusted_until && session.trusted_until > now)) {
        return { valid: true, phone: session.phone };
      }
    }
    
    // Busca no banco
    try {
      const ipBlocker = getCurrentIpBlocker();
      if (ipBlocker && typeof ipBlocker.getAdminSession === 'function') {
        const session = await ipBlocker.getAdminSession(sessionId);
        if (session) {
          // Verifica se sessão ainda é válida
          if (session.expires_at > now || (session.trusted_until && session.trusted_until > now)) {
            // Atualiza cache
            sessionCache.set(sessionId, { session, cachedAt: Date.now() });
            // Atualiza último uso (async, não espera)
            ipBlocker.updateAdminSessionLastUsed(sessionId).catch(() => {});
            return { valid: true, phone: session.phone };
          }
        }
      }
    } catch (e) {
      dbg(`[ADMIN] Erro ao validar sessão:`, e.message);
    }
    
    return { valid: false };
  }
  
  // Verifica se dispositivo é confiável (para pular código)
  async function checkTrustedDevice(req) {
    const fingerprint = generateDeviceFingerprint(req);
    
    try {
      const ipBlocker = getCurrentIpBlocker();
      if (ipBlocker && typeof ipBlocker.getAdminSessionByFingerprint === 'function') {
        const session = await ipBlocker.getAdminSessionByFingerprint(fingerprint);
        if (session) {
          log(`[ADMIN] Dispositivo confiável detectado: ${session.device_name} (${fingerprint.substring(0, 8)}...)`);
          return { 
            trusted: true, 
            phone: session.phone,
            sessionId: session.session_id,
            deviceName: session.device_name
          };
        }
      }
    } catch (e) {
      dbg(`[ADMIN] Erro ao verificar dispositivo confiável:`, e.message);
    }
    
    return { trusted: false };
  }
  
  // Middleware de autenticação (agora async)
  async function requireAuth(req, res, next) {
    const sessionId = req.cookies?.admin_session || req.headers['x-admin-session'];
    const validation = await validateSession(sessionId);
    if (!validation.valid) {
      // Sessão inválida ou expirada - apenas retorna 401
      // NÃO bloqueia o IP pois é comportamento normal de usuário não logado
      dbg(`[ADMIN] Sessão inválida para: ${req.path}`);
      return res.status(401).json({ error: 'Unauthorized' });
    }
    req.adminPhone = validation.phone;
    next();
  }
  
  // Carrega template
  function loadTemplate(name) {
    try {
      return fs.readFileSync(
        path.join(appRoot, 'src', 'admin', 'templates', `${name}.html`),
        'utf8'
      );
    } catch (error) {
      err(`[ADMIN] Erro ao carregar template ${name}:`, error.message);
      return null;
    }
  }
  
  // Função auxiliar para aguardar banco estar pronto
  async function waitForDatabase(ipBlocker, maxWait = 10000) {
    if (!ipBlocker) return false;
    
    // Se tem _promise, aguarda
    if (ipBlocker._promise) {
      try {
        await Promise.race([
          ipBlocker._promise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), maxWait))
        ]);
        return true;
      } catch (e) {
        warn(`[ADMIN] Timeout aguardando banco:`, e.message);
        return false;
      }
    }
    
    // Tenta chamar uma função para verificar se está pronto
    try {
      const test = await Promise.race([
        ipBlocker.countBlockedIPs?.(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 2000))
      ]);
      return true;
    } catch (e) {
      // Se falhou, tenta novamente após um delay
      await new Promise(resolve => setTimeout(resolve, 500));
      try {
        await ipBlocker.countBlockedIPs?.();
        return true;
      } catch (e2) {
        return false;
      }
    }
  }
  
  // ===== ROTAS =====
  
  app.get('/admin', async (req, res) => {
    // Verifica se já tem sessão válida
    const sessionId = req.cookies?.admin_session;
    if (sessionId) {
      const validation = await validateSession(sessionId);
      if (validation.valid) {
        return res.redirect('/admin/dashboard');
      }
    }
    
    // Verifica se dispositivo é confiável
    const trusted = await checkTrustedDevice(req);
    if (trusted.trusted) {
      // Dispositivo confiável - cria nova sessão automaticamente
      const newSessionId = generateSessionId();
      const now = Math.floor(Date.now() / 1000);
      
      try {
        const ipBlocker = getCurrentIpBlocker();
        if (ipBlocker && typeof ipBlocker.saveAdminSession === 'function') {
          await ipBlocker.saveAdminSession(newSessionId, {
            phone: trusted.phone,
            deviceFingerprint: generateDeviceFingerprint(req),
            deviceName: getDeviceName(req),
            ipAddress: getClientIpAddress(req),
            userAgent: (req.headers['user-agent'] || '').substring(0, 255),
            trustedUntil: now + (ADMIN_TRUST_DAYS * 24 * 3600),
            createdAt: now,
            expiresAt: now + (ADMIN_SESSION_EXPIRY_HOURS * 3600),
            lastUsedAt: now
          });
          
          res.cookie('admin_session', newSessionId, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            maxAge: ADMIN_TRUST_DAYS * 24 * 60 * 60 * 1000,
            sameSite: 'strict'
          });
          
          log(`[ADMIN] Login automático via dispositivo confiável: ${trusted.deviceName}`);
          return res.redirect('/admin/dashboard');
        }
      } catch (e) {
        err(`[ADMIN] Erro ao criar sessão para dispositivo confiável:`, e.message);
      }
    }
    
    const template = loadTemplate('login');
    res.send(template || 'Erro ao carregar página');
  });
  
  app.post('/admin/request-code', async (req, res) => {
    const result = await sendAccessCode(req.body.phone);
    res.json(result);
  });
  
  app.post('/admin/validate-code', async (req, res) => {
    const trustDevice = req.body.trustDevice === true || req.body.trustDevice === 'true';
    const result = await validateCode(req.body.phone, req.body.code, req, trustDevice);
    
    if (result.valid) {
      const cookieMaxAge = result.trusted 
        ? ADMIN_TRUST_DAYS * 24 * 60 * 60 * 1000 
        : ADMIN_SESSION_EXPIRY_HOURS * 60 * 60 * 1000;
      
      res.cookie('admin_session', result.sessionId, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        maxAge: cookieMaxAge,
        sameSite: 'strict'
      });
      res.json({ success: true, trusted: result.trusted });
    } else {
      res.status(401).json({ success: false, error: result.error });
    }
  });
  
  app.get('/admin/dashboard', requireAuth, (req, res) => {
    // Tenta carregar novo template, senão usa o antigo
    const newTemplatePath = path.join(appRoot, 'src', 'admin', 'templates', 'dashboard-new.html');
    if (fs.existsSync(newTemplatePath)) {
      const template = fs.readFileSync(newTemplatePath, 'utf8');
      res.send(template);
    } else {
      const template = loadTemplate('dashboard');
      res.send(template || 'Erro ao carregar dashboard');
    }
  });
  
  // API: Estatísticas - AGUARDA BANCO ESTAR PRONTO
  app.get('/admin/api/stats', requireAuth, async (req, res) => {
    try {
      const ipBlocker = getCurrentIpBlocker();
      
      if (!ipBlocker) {
        log(`[ADMIN] ⚠️ ipBlocker não disponível`);
        return res.json({
          success: true,
          stats: { blocked: 0, whitelist: 0, yellowlist: 0, migrations: 0, total: 0 }
        });
      }
      
      // AGUARDA banco estar pronto
      const dbReady = await waitForDatabase(ipBlocker);
      if (!dbReady) {
        warn(`[ADMIN] ⚠️ Banco não está pronto após aguardar`);
      }
      
      // Aguarda um pouco mais para garantir
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Busca dados com retry
      let blocked = 0, whitelist = 0, yellowlist = 0, migrations = 0;
      
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          [blocked, whitelist, yellowlist, migrations] = await Promise.all([
            ipBlocker.countBlockedIPs?.() || Promise.resolve(0),
            ipBlocker.countWhitelistIPs?.() || Promise.resolve(0),
            ipBlocker.countYellowlistIPs?.() || Promise.resolve(0),
            ipBlocker.countMigrationLogs?.() || Promise.resolve(0)
          ]);
          
          // Se conseguiu valores válidos, para
          if (blocked !== undefined && blocked !== null) break;
          
          // Se falhou, aguarda antes de tentar novamente
          if (attempt < 2) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        } catch (e) {
          err(`[ADMIN] Erro na tentativa ${attempt + 1}:`, e.message);
          if (attempt < 2) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
      }
      
      log(`[ADMIN] ✅ Stats finais: blocked=${blocked}, whitelist=${whitelist}, yellowlist=${yellowlist}, migrations=${migrations}`);
      
      res.json({
        success: true,
        stats: {
          blocked: Number(blocked) || 0,
          whitelist: Number(whitelist) || 0,
          yellowlist: Number(yellowlist) || 0,
          migrations: Number(migrations) || 0,
          total: (Number(blocked) || 0) + (Number(whitelist) || 0) + (Number(yellowlist) || 0)
        }
      });
    } catch (error) {
      err(`[ADMIN] ❌ Erro ao buscar stats:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // API: IPs Bloqueados - AGUARDA BANCO ESTAR PRONTO
  app.get('/admin/api/blocked', requireAuth, async (req, res) => {
    try {
      const ipBlocker = getCurrentIpBlocker();
      const limit = parseInt(req.query.limit || '50', 10);
      const offset = parseInt(req.query.offset || '0', 10);
      
      if (!ipBlocker?.listBlockedIPs) {
        return res.json({ success: true, data: [], pagination: { limit, offset, total: 0, hasMore: false } });
      }
      
      // AGUARDA banco estar pronto
      await waitForDatabase(ipBlocker);
      await new Promise(resolve => setTimeout(resolve, 500));
      
      log(`[ADMIN] 🔍 Consultando blocked IPs: limit=${limit}, offset=${offset}`);
      const [ips, total] = await Promise.all([
        ipBlocker.listBlockedIPs(limit, offset),
        ipBlocker.countBlockedIPs()
      ]);
      
      log(`[ADMIN] ✅ Blocked IPs: ${ips?.length || 0} de ${total || 0}`);
      if (ips && ips.length > 0) {
        log(`[ADMIN] 📋 Primeiros IPs bloqueados: ${ips.slice(0, 5).map(ip => ip.ip).join(', ')}`);
      }
      
      res.json({
        success: true,
        data: ips || [],
        pagination: {
          limit,
          offset,
          total: Number(total) || 0,
          hasMore: (offset + limit) < (Number(total) || 0)
        }
      });
    } catch (error) {
      err(`[ADMIN] ❌ Erro ao buscar blocked IPs:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // API: IPs Whitelist - AGUARDA BANCO ESTAR PRONTO
  app.get('/admin/api/whitelist', requireAuth, async (req, res) => {
    try {
      const ipBlocker = getCurrentIpBlocker();
      const limit = parseInt(req.query.limit || '50', 10);
      const offset = parseInt(req.query.offset || '0', 10);
      
      if (!ipBlocker?.listWhitelistIPs) {
        return res.json({ success: true, data: [], pagination: { limit, offset, total: 0, hasMore: false } });
      }
      
      // AGUARDA banco estar pronto
      await waitForDatabase(ipBlocker);
      await new Promise(resolve => setTimeout(resolve, 500));
      
      log(`[ADMIN] 🔍 Consultando whitelist IPs: limit=${limit}, offset=${offset}`);
      const [ips, total] = await Promise.all([
        ipBlocker.listWhitelistIPs(limit, offset),
        ipBlocker.countWhitelistIPs()
      ]);
      
      log(`[ADMIN] ✅ Whitelist IPs: ${ips?.length || 0} de ${total || 0}`);
      if (ips && ips.length > 0) {
        log(`[ADMIN] 📋 Primeiros IPs whitelist: ${ips.slice(0, 5).map(ip => ip.ip).join(', ')}`);
        // Log detalhado para debug
        const now = Math.floor(Date.now() / 1000);
        ips.slice(0, 5).forEach((ip, idx) => {
          const isValid = ip.expires_at > now;
          log(`[ADMIN] 📋 IP ${idx + 1}: ${ip.ip}, expires_at: ${ip.expires_at} (${isValid ? 'VÁLIDO' : 'EXPIRADO'}), now: ${now}, confidence: ${ip.abuse_confidence || 'N/A'}, reports: ${ip.reports || 0}`);
        });
        
        // Verifica se o IP 177.30.183.227 está na lista
        const targetIP = ips.find(ip => ip.ip === '177.30.183.227');
        if (targetIP) {
          log(`[ADMIN] ✅ IP 177.30.183.227 encontrado na lista retornada: expires_at=${targetIP.expires_at}, now=${now}`);
        } else {
          log(`[ADMIN] ⚠️ IP 177.30.183.227 NÃO encontrado na lista retornada (pode estar em outra página ou expirado)`);
        }
      } else {
        log(`[ADMIN] ⚠️ Nenhum IP retornado da whitelist, mas total é ${total}`);
        log(`[ADMIN] ⚠️ Verificando banco diretamente...`);
        // Tenta consultar diretamente para debug
        if (ipBlocker && ipBlocker._ready && ipBlocker._ready()) {
          log(`[ADMIN] ⚠️ Banco está pronto, mas nenhum IP retornado`);
        } else {
          log(`[ADMIN] ⚠️ Banco pode não estar pronto ainda`);
        }
      }
      
      res.json({
        success: true,
        data: ips || [],
        pagination: {
          limit,
          offset,
          total: Number(total) || 0,
          hasMore: (offset + limit) < (Number(total) || 0)
        }
      });
    } catch (error) {
      err(`[ADMIN] ❌ Erro ao buscar whitelist IPs:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // API: IPs Yellowlist - AGUARDA BANCO ESTAR PRONTO
  app.get('/admin/api/yellowlist', requireAuth, async (req, res) => {
    try {
      const ipBlocker = getCurrentIpBlocker();
      const limit = parseInt(req.query.limit || '50', 10);
      const offset = parseInt(req.query.offset || '0', 10);
      
      if (!ipBlocker?.listYellowlistIPs) {
        return res.json({ success: true, data: [], pagination: { limit, offset, total: 0, hasMore: false } });
      }
      
      // AGUARDA banco estar pronto
      await waitForDatabase(ipBlocker);
      await new Promise(resolve => setTimeout(resolve, 500));
      
      log(`[ADMIN] 🔍 Consultando yellowlist IPs: limit=${limit}, offset=${offset}`);
      const [ips, total] = await Promise.all([
        ipBlocker.listYellowlistIPs(limit, offset),
        ipBlocker.countYellowlistIPs()
      ]);
      
      log(`[ADMIN] ✅ Yellowlist IPs: ${ips?.length || 0} de ${total || 0}`);
      if (ips && ips.length > 0) {
        log(`[ADMIN] 📋 Primeiros IPs yellowlist: ${ips.slice(0, 5).map(ip => ip.ip).join(', ')}`);
      }
      
      res.json({
        success: true,
        data: ips || [],
        pagination: {
          limit,
          offset,
          total: Number(total) || 0,
          hasMore: (offset + limit) < (Number(total) || 0)
        }
      });
    } catch (error) {
      err(`[ADMIN] ❌ Erro ao buscar yellowlist IPs:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // API: Migrações - AGUARDA BANCO ESTAR PRONTO
  app.get('/admin/api/migrations', requireAuth, async (req, res) => {
    try {
      const ipBlocker = getCurrentIpBlocker();
      const limit = parseInt(req.query.limit || '50', 10);
      const offset = parseInt(req.query.offset || '0', 10);
      const ip = req.query.ip || null;
      
      if (!ipBlocker?.listMigrationLogs) {
        return res.json({ success: true, data: [], pagination: { limit, offset, total: 0, hasMore: false } });
      }
      
      // AGUARDA banco estar pronto
      await waitForDatabase(ipBlocker);
      await new Promise(resolve => setTimeout(resolve, 500));
      
      log(`[ADMIN] 🔍 Consultando migrations: limit=${limit}, offset=${offset}, ip=${ip || 'todos'}`);
      const [logs, total] = await Promise.all([
        ipBlocker.listMigrationLogs(limit, offset, ip),
        ipBlocker.countMigrationLogs(ip)
      ]);
      
      log(`[ADMIN] ✅ Migrations: ${logs?.length || 0} de ${total || 0}`);
      if (logs && logs.length > 0) {
        log(`[ADMIN] 📋 Primeiras migrations: ${logs.slice(0, 3).map(log => `${log.ip || 'N/A'}:${log.action || 'N/A'}`).join(', ')}`);
      }
      
      res.json({
        success: true,
        data: logs || [],
        pagination: {
          limit,
          offset,
          total: Number(total) || 0,
          hasMore: (offset + limit) < (Number(total) || 0)
        }
      });
    } catch (error) {
      err(`[ADMIN] ❌ Erro ao buscar migrations:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  app.post('/admin/logout', requireAuth, async (req, res) => {
    const sessionId = req.cookies?.admin_session || req.headers['x-admin-session'];
    if (sessionId) {
      // Remove do cache
      sessionCache.delete(sessionId);
      // Remove do banco
      try {
        const ipBlocker = getCurrentIpBlocker();
        if (ipBlocker && typeof ipBlocker.deleteAdminSession === 'function') {
          await ipBlocker.deleteAdminSession(sessionId);
        }
      } catch (e) {
        dbg(`[ADMIN] Erro ao remover sessão do banco:`, e.message);
      }
    }
    res.clearCookie('admin_session');
    res.json({ success: true });
  });
  
  // ===== DISPOSITIVOS CONFIÁVEIS =====
  
  // Lista dispositivos confiáveis do usuário atual
  app.get('/admin/api/trusted-devices', requireAuth, async (req, res) => {
    try {
      const ipBlocker = getCurrentIpBlocker();
      if (!ipBlocker || typeof ipBlocker.listTrustedDevices !== 'function') {
        return res.status(503).json({ success: false, error: 'Serviço não disponível' });
      }
      
      const devices = await ipBlocker.listTrustedDevices(req.adminPhone);
      
      // Identifica o dispositivo atual
      const currentFingerprint = generateDeviceFingerprint(req);
      
      const formattedDevices = devices.map(d => ({
        id: d.session_id,
        name: d.device_name || 'Desconhecido',
        ip: d.ip_address,
        trustedUntil: d.trusted_until,
        createdAt: d.created_at,
        lastUsedAt: d.last_used_at,
        isCurrent: d.device_fingerprint === currentFingerprint
      }));
      
      res.json({ success: true, devices: formattedDevices });
    } catch (error) {
      err(`[ADMIN] Erro ao listar dispositivos confiáveis:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // Revoga confiança de um dispositivo
  app.post('/admin/api/trusted-devices/:sessionId/revoke', requireAuth, async (req, res) => {
    try {
      const { sessionId } = req.params;
      
      const ipBlocker = getCurrentIpBlocker();
      if (!ipBlocker || typeof ipBlocker.revokeTrustedDevice !== 'function') {
        return res.status(503).json({ success: false, error: 'Serviço não disponível' });
      }
      
      await ipBlocker.revokeTrustedDevice(sessionId);
      
      // Remove do cache
      sessionCache.delete(sessionId);
      
      log(`[ADMIN] Dispositivo revogado: ${sessionId.substring(0, 8)}...`);
      
      res.json({ success: true });
    } catch (error) {
      err(`[ADMIN] Erro ao revogar dispositivo:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // Revoga todos os dispositivos (exceto o atual)
  app.post('/admin/api/trusted-devices/revoke-all', requireAuth, async (req, res) => {
    try {
      const ipBlocker = getCurrentIpBlocker();
      if (!ipBlocker || typeof ipBlocker.listTrustedDevices !== 'function') {
        return res.status(503).json({ success: false, error: 'Serviço não disponível' });
      }
      
      const currentSessionId = req.cookies?.admin_session || req.headers['x-admin-session'];
      const devices = await ipBlocker.listTrustedDevices(req.adminPhone);
      
      let revoked = 0;
      for (const device of devices) {
        if (device.session_id !== currentSessionId) {
          await ipBlocker.revokeTrustedDevice(device.session_id);
          sessionCache.delete(device.session_id);
          revoked++;
        }
      }
      
      log(`[ADMIN] ${revoked} dispositivos revogados`);
      
      res.json({ success: true, revoked });
    } catch (error) {
      err(`[ADMIN] Erro ao revogar dispositivos:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // Endpoint de debug (PROTEGIDO com autenticação)
  // Em produção, considere desabilitar completamente via variável de ambiente
  const ENABLE_DEBUG_ENDPOINT = process.env.ENABLE_DEBUG_ENDPOINT === 'true';
  
  app.get('/admin/debug/info', requireAuth, async (req, res) => {
    // Verifica se o endpoint está habilitado
    if (!ENABLE_DEBUG_ENDPOINT) {
      return res.status(404).json({ error: 'Endpoint não disponível' });
    }
    try {
      const fs = require('fs');
      const path = require('path');
      
      // Verifica data de modificação dos arquivos
      const ipBlockerPath = path.join(appRoot, 'src', 'modules', 'ip-blocker.js');
      const adminPath = path.join(appRoot, 'src', 'modules', 'admin.js');
      
      const ipBlockerStats = fs.existsSync(ipBlockerPath) ? fs.statSync(ipBlockerPath) : null;
      const adminStats = fs.existsSync(adminPath) ? fs.statSync(adminPath) : null;
      
      // Verifica se tem a função de logs
      const ipBlockerContent = fs.existsSync(ipBlockerPath) ? fs.readFileSync(ipBlockerPath, 'utf8') : '';
      const hasLogsInit = ipBlockerContent.includes('[INIT] SQL:');
      const hasLogsSQL = ipBlockerContent.includes('🔍 SQL:');
      
      // Verifica IPs no banco
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      
      let dbInfo = { error: 'Não foi possível acessar' };
      try {
        const dbPath = path.join(appRoot, 'blocked_ips.db');
        if (fs.existsSync(dbPath)) {
          const { stdout } = await execAsync(`sqlite3 "${dbPath}" "SELECT COUNT(*) as total FROM blocked_ips;"`);
          dbInfo = { total: parseInt(stdout.trim()) || 0 };
          
          // Pega alguns IPs
          const { stdout: ipsOut } = await execAsync(`sqlite3 "${dbPath}" "SELECT ip, reason FROM blocked_ips LIMIT 5;"`);
          dbInfo.sampleIPs = ipsOut.trim().split('\n').filter(l => l);
        }
      } catch (e) {
        dbInfo = { error: e.message };
      }
      
      // Últimas linhas do log
      let recentLogs = [];
      try {
        const logPath = path.join(appRoot, 'logs', 'app.log');
        if (fs.existsSync(logPath)) {
          const { stdout } = await execAsync(`tail -n 50 "${logPath}" | grep -E "(IP-BLOCKER|ADMIN|SQL)" | tail -n 20`);
          recentLogs = stdout.trim().split('\n').filter(l => l);
        }
      } catch (e) {
        recentLogs = [{ error: e.message }];
      }
      
      res.json({
        success: true,
        files: {
          ipBlocker: {
            exists: !!ipBlockerStats,
            modified: ipBlockerStats ? ipBlockerStats.mtime : null,
            hasLogsInit,
            hasLogsSQL
          },
          admin: {
            exists: !!adminStats,
            modified: adminStats ? adminStats.mtime : null
          }
        },
        database: dbInfo,
        recentLogs: recentLogs.slice(0, 10)
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // Endpoint temporário para acessar logs
  app.get('/admin/api/logs', requireAuth, async (req, res) => {
    try {
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      
      const logPath = path.join(appRoot, 'logs', 'app.log');
      const lines = parseInt(req.query.lines || '200', 10);
      const filter = req.query.filter || '';
      
      let command = `tail -n ${lines} "${logPath}"`;
      if (filter) {
        command += ` | grep -E "${filter}"`;
      }
      
      const { stdout, stderr } = await execAsync(command);
      
      res.json({
        success: true,
        logs: stdout.split('\n').filter(line => line.trim()),
        error: stderr || null
      });
    } catch (error) {
      err(`[ADMIN] ❌ Erro ao ler logs:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // Função auxiliar para bloquear IP por tentativa de acesso não autorizado
  function blockUnauthorizedAccess(req, reason) {
    const clientIp = getClientIpAddress(req);
    let normalizedIp = clientIp;
    if (normalizedIp && normalizedIp.startsWith('::ffff:')) {
      normalizedIp = normalizedIp.substring(7);
    }
    
    if (normalizedIp === 'unknown' || !normalizedIp) {
      return;
    }
    
    log(`[ADMIN] 🚨 ${reason}: ${normalizedIp} -> ${req.path}`);
    
    const ipBlocker = getCurrentIpBlocker();
    if (ipBlocker && ipBlocker.blockIP) {
      ipBlocker.isBlocked(normalizedIp).then(isBlocked => {
        if (!isBlocked) {
          log(`[ADMIN] 🚫 Bloqueando IP ${normalizedIp} por ${reason}`);
          ipBlocker.blockIP(normalizedIp, `${reason}: ${req.path}`)
            .then(() => {
              log(`[ADMIN] ✅ IP ${normalizedIp} bloqueado com sucesso`);
            })
            .catch(err => {
              warn(`[ADMIN] ❌ Erro ao bloquear IP ${normalizedIp}:`, err.message);
            });
        } else {
          dbg(`[ADMIN] IP ${normalizedIp} já está bloqueado`);
        }
      }).catch(err => {
        warn(`[ADMIN] Erro ao verificar se IP está bloqueado:`, err.message);
      });
    }
  }
  
  // API: Gerenciamento de IPs
  app.post('/admin/api/ip/unblock', requireAuth, async (req, res) => {
    try {
      const { ip } = req.body;
      if (!ip) {
        return res.status(400).json({ success: false, error: 'IP não fornecido' });
      }
      
      const ipBlocker = getCurrentIpBlocker();
      if (!ipBlocker || !ipBlocker.unblockIP) {
        return res.status(500).json({ success: false, error: 'Módulo IP Blocker não disponível' });
      }
      
      await ipBlocker.unblockIP(ip);
      log(`[ADMIN] IP ${ip} desbloqueado por ${req.adminPhone}`);
      res.json({ success: true });
    } catch (error) {
      err(`[ADMIN] Erro ao desbloquear IP:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  app.post('/admin/api/ip/remove', requireAuth, async (req, res) => {
    try {
      const { ip, listType } = req.body;
      if (!ip || !listType) {
        return res.status(400).json({ success: false, error: 'IP ou tipo de lista não fornecido' });
      }
      
      if (!['whitelist', 'yellowlist'].includes(listType)) {
        return res.status(400).json({ success: false, error: 'Tipo de lista inválido' });
      }
      
      const ipBlocker = getCurrentIpBlocker();
      if (!ipBlocker) {
        return res.status(500).json({ success: false, error: 'Módulo IP Blocker não disponível' });
      }
      
      // Remove da lista específica
      if (listType === 'whitelist' && ipBlocker.removeFromWhitelist) {
        await ipBlocker.removeFromWhitelist(ip);
      } else if (listType === 'yellowlist' && ipBlocker.removeFromYellowlist) {
        await ipBlocker.removeFromYellowlist(ip);
      } else {
        return res.status(500).json({ success: false, error: 'Função de remoção não disponível' });
      }
      
      log(`[ADMIN] IP ${ip} removido da ${listType} por ${req.adminPhone}`);
      res.json({ success: true });
    } catch (error) {
      err(`[ADMIN] Erro ao remover IP:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  app.post('/admin/api/ip/migrate', requireAuth, async (req, res) => {
    try {
      const { ip, fromList, toList } = req.body;
      if (!ip || !fromList || !toList) {
        return res.status(400).json({ success: false, error: 'Parâmetros incompletos' });
      }
      
      const validLists = ['blocked', 'whitelist', 'yellowlist'];
      if (!validLists.includes(fromList) || !validLists.includes(toList)) {
        return res.status(400).json({ success: false, error: 'Tipo de lista inválido' });
      }
      
      if (fromList === toList) {
        return res.status(400).json({ success: false, error: 'Lista origem e destino são iguais' });
      }
      
      const ipBlocker = getCurrentIpBlocker();
      if (!ipBlocker) {
        return res.status(500).json({ success: false, error: 'Módulo IP Blocker não disponível' });
      }
      
      // Remove da lista origem
      if (fromList === 'blocked' && ipBlocker.unblockIP) {
        await ipBlocker.unblockIP(ip);
      } else if (fromList === 'whitelist' && ipBlocker.removeFromWhitelist) {
        await ipBlocker.removeFromWhitelist(ip);
      } else if (fromList === 'yellowlist' && ipBlocker.removeFromYellowlist) {
        await ipBlocker.removeFromYellowlist(ip);
      }
      
      // Adiciona à lista destino
      if (toList === 'blocked' && ipBlocker.blockIP) {
        await ipBlocker.blockIP(ip, `Migrado de ${fromList} pelo admin`);
      } else if (toList === 'whitelist' && ipBlocker.addToWhitelist) {
        await ipBlocker.addToWhitelist(ip, null, null, null);
      } else if (toList === 'yellowlist' && ipBlocker.addToYellowlist) {
        await ipBlocker.addToYellowlist(ip, null, null, null);
      }
      
      // Registra migração
      if (ipBlocker.logMigration) {
        await ipBlocker.logMigration(ip, fromList, toList, null, null, null, null);
      }
      
      log(`[ADMIN] IP ${ip} migrado de ${fromList} para ${toList} por ${req.adminPhone}`);
      res.json({ success: true });
    } catch (error) {
      err(`[ADMIN] Erro ao migrar IP:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // API: Métricas do Servidor
  app.get('/admin/api/server/metrics', requireAuth, async (req, res) => {
    try {
      const os = require('os');
      const fs = require('fs').promises;
      const path = require('path');
      
      // CPU - Leitura real usando /proc/stat ou top
      const cpuCount = os.cpus().length;
      const loadAvg = os.loadavg();
      
      // Calcula uso real de CPU
      let cpu1minFinal = 0;
      let cpu5minFinal = 0;
      let cpu15minFinal = 0;
      
      try {
        const { execSync } = require('child_process');
        
        // Método 1: Usa top para obter uso de CPU real (100 - idle)
        // top -bn1 mostra: %Cpu(s): 37.2 us, 39.3 sy, 0.0 ni, 23.4 id, ...
        // idle é a 4ª coluna, CPU uso = 100 - idle
        const topOutput = execSync("top -bn1 | head -5 | grep Cpu", { encoding: 'utf8' });
        
        // Extrai o valor de idle (id) da saída
        const idleMatch = topOutput.match(/(\d+\.?\d*)\s*id/);
        if (idleMatch) {
          const idle = parseFloat(idleMatch[1]);
          cpu1minFinal = Math.round(100 - idle);
        } else {
          // Fallback: extrai us + sy
          const usMatch = topOutput.match(/(\d+\.?\d*)\s*us/);
          const syMatch = topOutput.match(/(\d+\.?\d*)\s*sy/);
          const us = usMatch ? parseFloat(usMatch[1]) : 0;
          const sy = syMatch ? parseFloat(syMatch[1]) : 0;
          cpu1minFinal = Math.round(us + sy);
        }
        
        // Para 5 e 15 min, usa load average normalizado (não há dados históricos de CPU real)
        // Mas normaliza para ser proporcional ao uso atual
        const currentLoad = loadAvg[0] / cpuCount;
        const load5 = loadAvg[1] / cpuCount;
        const load15 = loadAvg[2] / cpuCount;
        
        // Se o load atual é X e o CPU real é Y%, então escala proporcionalmente
        if (currentLoad > 0) {
          const factor = cpu1minFinal / (currentLoad * 100);
          cpu5minFinal = Math.min(100, Math.round(load5 * 100 * factor));
          cpu15minFinal = Math.min(100, Math.round(load15 * 100 * factor));
        } else {
          cpu5minFinal = cpu1minFinal;
          cpu15minFinal = cpu1minFinal;
        }
        
      } catch (e) {
        // Fallback: usa load average normalizado mas com limite realista
        const load1 = loadAvg[0] / cpuCount;
        const load5 = loadAvg[1] / cpuCount;
        const load15 = loadAvg[2] / cpuCount;
        
        // Limita a 100% mesmo se load > 1
        cpu1minFinal = Math.min(Math.round(load1 * 100), 100);
        cpu5minFinal = Math.min(Math.round(load5 * 100), 100);
        cpu15minFinal = Math.min(Math.round(load15 * 100), 100);
        
        dbg(`[ADMIN] Erro ao obter uso de CPU real, usando load average:`, e.message);
      }
      
      // Garante que os valores estão entre 0 e 100
      cpu1minFinal = Math.max(0, Math.min(100, cpu1minFinal));
      cpu5minFinal = Math.max(0, Math.min(100, cpu5minFinal));
      cpu15minFinal = Math.max(0, Math.min(100, cpu15minFinal));
      
      // Memória
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      
      // Disco (usa o diretório raiz do app)
      let diskTotal = 0;
      let diskUsed = 0;
      let diskFree = 0;
      
      try {
        const { execSync } = require('child_process');
        // Tenta usar comando df (Linux/Unix)
        const dfOutput = execSync(`df -B1 ${appRoot} 2>/dev/null | tail -1`, { encoding: 'utf8' });
        const parts = dfOutput.trim().split(/\s+/);
        if (parts.length >= 4) {
          diskTotal = parseInt(parts[1]) || 0;
          diskUsed = parseInt(parts[2]) || 0;
          diskFree = parseInt(parts[3]) || 0;
        }
      } catch (e) {
        // Se falhar, tenta método alternativo
        try {
          const { execSync } = require('child_process');
          // Tenta sem -B1 (alguns sistemas não suportam)
          const dfOutput = execSync(`df ${appRoot} 2>/dev/null | tail -1`, { encoding: 'utf8' });
          const parts = dfOutput.trim().split(/\s+/);
          if (parts.length >= 4) {
            // Valores em KB, converte para bytes
            diskTotal = (parseInt(parts[1]) || 0) * 1024;
            diskUsed = (parseInt(parts[2]) || 0) * 1024;
            diskFree = (parseInt(parts[3]) || 0) * 1024;
          }
        } catch (e2) {
          dbg(`[ADMIN] Não foi possível obter informações de disco:`, e2.message);
        }
      }
      
      // Informações do sistema
      const uptime = os.uptime();
      
      res.json({
        success: true,
        metrics: {
          cpu: {
            load1min: cpu1minFinal,
            load5min: cpu5minFinal,
            load15min: cpu15minFinal,
            loadAvgRaw: loadAvg,
            cores: cpuCount
          },
          memory: {
            total: totalMem,
            used: usedMem,
            free: freeMem,
            percent: (usedMem / totalMem) * 100
          },
          disk: {
            total: diskTotal,
            used: diskUsed,
            free: diskFree,
            percent: diskTotal > 0 ? (diskUsed / diskTotal) * 100 : 0
          },
          system: {
            platform: os.platform(),
            arch: os.arch(),
            type: os.type(),
            uptime: uptime,
            hostname: os.hostname()
          }
        }
      });
    } catch (error) {
      err(`[ADMIN] Erro ao obter métricas do servidor:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // ===== TRUSTED IP RANGES =====
  
  // API: Listar ranges confiáveis
  app.get('/admin/api/trusted-ranges', requireAuth, async (req, res) => {
    try {
      const ipBlocker = getCurrentIpBlocker();
      const category = req.query.category || null;
      const enabledOnly = req.query.enabledOnly === 'true';
      
      await waitForDatabase(ipBlocker);
      
      if (!ipBlocker || typeof ipBlocker.listTrustedRanges !== 'function') {
        return res.status(503).json({ success: false, error: 'IP Blocker não disponível' });
      }
      
      const ranges = await ipBlocker.listTrustedRanges(category, enabledOnly);
      const counts = await ipBlocker.countTrustedRangesByCategory();
      
      res.json({ 
        success: true, 
        ranges,
        counts,
        total: ranges.length
      });
    } catch (error) {
      err(`[ADMIN] Erro ao listar ranges confiáveis:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // API: Adicionar range confiável
  app.post('/admin/api/trusted-ranges', requireAuth, async (req, res) => {
    try {
      const ipBlocker = getCurrentIpBlocker();
      const { cidr, category, description } = req.body;
      
      if (!cidr || !category) {
        return res.status(400).json({ success: false, error: 'CIDR e categoria são obrigatórios' });
      }
      
      // Valida formato CIDR básico
      const cidrRegex = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
      if (!cidrRegex.test(cidr)) {
        return res.status(400).json({ success: false, error: 'Formato CIDR inválido (ex: 192.168.1.0/24)' });
      }
      
      await waitForDatabase(ipBlocker);
      
      if (!ipBlocker || typeof ipBlocker.addTrustedRange !== 'function') {
        return res.status(503).json({ success: false, error: 'IP Blocker não disponível' });
      }
      
      const result = await ipBlocker.addTrustedRange(cidr, category, description || '');
      
      log(`[ADMIN] Range confiável adicionado: ${cidr} (${category})`);
      res.json({ success: true, ...result });
    } catch (error) {
      err(`[ADMIN] Erro ao adicionar range confiável:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // API: Remover range confiável
  app.delete('/admin/api/trusted-ranges/:id', requireAuth, async (req, res) => {
    try {
      const ipBlocker = getCurrentIpBlocker();
      const id = parseInt(req.params.id, 10);
      
      if (isNaN(id)) {
        return res.status(400).json({ success: false, error: 'ID inválido' });
      }
      
      await waitForDatabase(ipBlocker);
      
      if (!ipBlocker || typeof ipBlocker.removeTrustedRange !== 'function') {
        return res.status(503).json({ success: false, error: 'IP Blocker não disponível' });
      }
      
      const removed = await ipBlocker.removeTrustedRange(id);
      
      if (removed) {
        log(`[ADMIN] Range confiável removido: ID ${id}`);
        res.json({ success: true, removed: true });
      } else {
        res.status(404).json({ success: false, error: 'Range não encontrado' });
      }
    } catch (error) {
      err(`[ADMIN] Erro ao remover range confiável:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // API: Habilitar/Desabilitar range confiável
  app.put('/admin/api/trusted-ranges/:id/toggle', requireAuth, async (req, res) => {
    try {
      const ipBlocker = getCurrentIpBlocker();
      const id = parseInt(req.params.id, 10);
      const { enabled } = req.body;
      
      if (isNaN(id)) {
        return res.status(400).json({ success: false, error: 'ID inválido' });
      }
      
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ success: false, error: 'Campo "enabled" deve ser boolean' });
      }
      
      await waitForDatabase(ipBlocker);
      
      if (!ipBlocker || typeof ipBlocker.toggleTrustedRange !== 'function') {
        return res.status(503).json({ success: false, error: 'IP Blocker não disponível' });
      }
      
      const updated = await ipBlocker.toggleTrustedRange(id, enabled);
      
      if (updated) {
        log(`[ADMIN] Range confiável ${enabled ? 'habilitado' : 'desabilitado'}: ID ${id}`);
        res.json({ success: true, enabled });
      } else {
        res.status(404).json({ success: false, error: 'Range não encontrado' });
      }
    } catch (error) {
      err(`[ADMIN] Erro ao atualizar range confiável:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // API: Importar ranges do Meta
  app.post('/admin/api/trusted-ranges/import-meta', requireAuth, async (req, res) => {
    try {
      const ipBlocker = getCurrentIpBlocker();
      
      await waitForDatabase(ipBlocker);
      
      if (!ipBlocker || typeof ipBlocker.importMetaRanges !== 'function') {
        return res.status(503).json({ success: false, error: 'IP Blocker não disponível' });
      }
      
      const result = await ipBlocker.importMetaRanges();
      
      log(`[ADMIN] Ranges Meta importados: ${result.imported} novos, ${result.skipped} ignorados`);
      res.json({ success: true, ...result });
    } catch (error) {
      err(`[ADMIN] Erro ao importar ranges Meta:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // ===== ABUSEIPDB STATS =====
  
  // API: Estatísticas de uso da API AbuseIPDB
  app.get('/admin/api/abuseipdb/stats', requireAuth, async (req, res) => {
    try {
      const ipBlocker = getCurrentIpBlocker();
      
      await waitForDatabase(ipBlocker);
      
      if (!ipBlocker || typeof ipBlocker.getAbuseIPDBStats !== 'function') {
        return res.status(503).json({ success: false, error: 'IP Blocker não disponível' });
      }
      
      const stats = await ipBlocker.getAbuseIPDBStats();
      
      res.json({ success: true, stats });
    } catch (error) {
      err(`[ADMIN] Erro ao obter stats AbuseIPDB:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // ===== IP LOOKUP =====
  
  // API: Consultar informações de um IP
  app.get('/admin/api/ip/lookup', requireAuth, async (req, res) => {
    try {
      const { ip, checkAbuse } = req.query;
      
      if (!ip) {
        return res.status(400).json({ success: false, error: 'IP é obrigatório' });
      }
      
      // Valida formato básico do IP
      const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
      if (!ipRegex.test(ip)) {
        return res.status(400).json({ success: false, error: 'Formato de IP inválido' });
      }
      
      const ipBlocker = getCurrentIpBlocker();
      await waitForDatabase(ipBlocker);
      
      if (!ipBlocker) {
        return res.status(503).json({ success: false, error: 'IP Blocker não disponível' });
      }
      
      // Verifica em qual lista o IP está
      const [isBlocked, whitelistCheck, yellowlistCheck] = await Promise.all([
        ipBlocker.isBlocked(ip),
        ipBlocker.isInWhitelist(ip),
        ipBlocker.isInYellowlist(ip)
      ]);
      
      // Determina status atual
      let currentList = 'none';
      let listDetails = null;
      
      if (isBlocked) {
        currentList = 'blocked';
      } else if (whitelistCheck.inWhitelist) {
        currentList = 'whitelist';
        listDetails = {
          abuseConfidence: whitelistCheck.abuseConfidence,
          expiresAt: whitelistCheck.expiresAt
        };
      } else if (yellowlistCheck.inYellowlist) {
        currentList = 'yellowlist';
        listDetails = {
          abuseConfidence: yellowlistCheck.abuseConfidence,
          expiresAt: yellowlistCheck.expiresAt
        };
      }
      
      // Verifica se é IP confiável (trusted range)
      let trustedInfo = null;
      if (typeof ipBlocker.getEnabledTrustedRanges === 'function') {
        try {
          const { checkTrustedIP } = require('./ip-utils');
          const trustedCheck = await checkTrustedIP(ip, ipBlocker);
          if (trustedCheck.trusted) {
            trustedInfo = {
              trusted: true,
              category: trustedCheck.category
            };
          }
        } catch (e) {
          dbg(`[ADMIN] Erro ao verificar trusted IP:`, e.message);
        }
      }
      
      // Busca histórico de migrações
      let migrations = [];
      if (typeof ipBlocker.listMigrationLogs === 'function') {
        try {
          const allMigrations = await ipBlocker.listMigrationLogs(50);
          migrations = allMigrations.filter(m => m.ip === ip).slice(0, 10);
        } catch (e) {
          dbg(`[ADMIN] Erro ao buscar migrações:`, e.message);
        }
      }
      
      // Busca no AbuseIPDB se solicitado
      let abuseData = null;
      if (checkAbuse === 'true') {
        const abuseIPDB = getAbuseIPDB ? getAbuseIPDB() : null;
        if (abuseIPDB && typeof abuseIPDB.checkIP === 'function') {
          try {
            abuseData = await abuseIPDB.checkIP(ip, 90, true); // forceCheck = true
            log(`[ADMIN] Consulta AbuseIPDB para ${ip}: ${abuseData.abuseConfidence}% confiança`);
          } catch (e) {
            warn(`[ADMIN] Erro ao consultar AbuseIPDB:`, e.message);
            abuseData = { error: e.message };
          }
        } else {
          abuseData = { error: 'AbuseIPDB não disponível' };
        }
      }
      
      res.json({
        success: true,
        ip,
        status: {
          currentList,
          listDetails,
          trusted: trustedInfo
        },
        abuse: abuseData,
        migrations
      });
    } catch (error) {
      err(`[ADMIN] Erro ao consultar IP:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // ===== ENVIO DE MENSAGENS =====
  
  // API: Enviar template
  app.post('/admin/api/send/template', requireAuth, async (req, res) => {
    try {
      const { phone, template, language, components } = req.body;
      
      if (!phone || !template) {
        return res.status(400).json({ ok: false, error: 'phone e template são obrigatórios' });
      }
      
      if (!whatsappOfficial || !whatsappOfficial.sendTemplateMessage) {
        return res.status(500).json({ ok: false, error: 'Função de envio de template não disponível' });
      }
      
      log(`[ADMIN] Enviando template "${template}" para ${phone}`);
      
      const result = await whatsappOfficial.sendTemplateMessage(
        phone, 
        template, 
        language || 'pt_BR', 
        components || []
      );
      
      log(`[ADMIN] ✅ Template enviado: ${result.id?._serialized || 'N/A'}`);
      
      res.json({ 
        ok: true, 
        to: phone,
        template,
        msgId: result.id?._serialized || null
      });
    } catch (error) {
      err(`[ADMIN] Erro ao enviar template:`, error.message);
      res.status(500).json({ ok: false, error: error.message });
    }
  });
  
  // API: Enviar texto
  app.post('/admin/api/send/text', requireAuth, async (req, res) => {
    try {
      const { phone, subject, message } = req.body;
      
      if (!phone || !message) {
        return res.status(400).json({ ok: false, error: 'phone e message são obrigatórios' });
      }
      
      if (!whatsappOfficial || !whatsappOfficial.sendTextMessage) {
        return res.status(500).json({ ok: false, error: 'Função de envio de texto não disponível' });
      }
      
      log(`[ADMIN] Enviando mensagem de texto para ${phone}`);
      
      // Formata mensagem com assunto se fornecido
      const formattedMessage = subject ? `*${subject}*\n\n${message}` : message;
      
      const result = await whatsappOfficial.sendTextMessage(phone, formattedMessage);
      
      log(`[ADMIN] ✅ Mensagem enviada: ${result.id?._serialized || 'N/A'}`);
      
      res.json({ 
        ok: true, 
        to: phone,
        msgId: result.id?._serialized || null
      });
    } catch (error) {
      err(`[ADMIN] Erro ao enviar mensagem:`, error.message);
      res.status(500).json({ ok: false, error: error.message });
    }
  });
  
  // API: Enviar código via template "login_web_app" (atalho)
  app.post('/admin/api/send/status-code', requireAuth, async (req, res) => {
    try {
      const { phone, code, language } = req.body;
      
      if (!phone || !code) {
        return res.status(400).json({ ok: false, error: 'phone e code são obrigatórios' });
      }
      
      if (!whatsappOfficial || !whatsappOfficial.sendLoginWebAppCode) {
        return res.status(500).json({ ok: false, error: 'Função de envio de código não disponível' });
      }
      
      log(`[ADMIN] Enviando código (login_web_app) para ${phone}`);
      
      const result = await whatsappOfficial.sendLoginWebAppCode(phone, String(code), language || 'pt_BR');
      
      log(`[ADMIN] ✅ Código enviado: ${result.id?._serialized || 'N/A'}`);
      
      res.json({ 
        ok: true, 
        to: phone,
        code: '***',
        template: 'login_web_app',
        msgId: result.id?._serialized || null
      });
    } catch (error) {
      err(`[ADMIN] Erro ao enviar código:`, error.message);
      res.status(500).json({ ok: false, error: error.message });
    }
  });
  
  // ===== TUYA ENDPOINTS =====
  
  // API: Listar dispositivos Tuya com status
  app.get('/admin/api/tuya/devices', requireAuth, async (req, res) => {
    try {
      if (!tuya) {
        return res.status(503).json({ success: false, error: 'Módulo Tuya não disponível' });
      }
      
      const devices = await tuya.getCachedDevices();
      
      // Conta estatísticas
      const stats = {
        total: devices.length,
        online: devices.filter(d => d.online).length,
        offline: devices.filter(d => !d.online).length,
        poweredOn: devices.filter(d => d.poweredOn).length,
        poweredOff: devices.filter(d => !d.poweredOn).length
      };
      
      res.json({ success: true, devices, stats });
    } catch (error) {
      err(`[ADMIN] Erro ao listar dispositivos Tuya:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // API: Obter status de um dispositivo específico
  app.get('/admin/api/tuya/device/:deviceId/status', requireAuth, async (req, res) => {
    try {
      const { deviceId } = req.params;
      
      if (!tuya) {
        return res.status(503).json({ success: false, error: 'Módulo Tuya não disponível' });
      }
      
      const status = await tuya.getDeviceStatus(deviceId);
      
      res.json({ success: true, deviceId, status });
    } catch (error) {
      err(`[ADMIN] Erro ao obter status do dispositivo:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // API: Alternar estado de um dispositivo (toggle)
  app.post('/admin/api/tuya/device/:deviceId/toggle', requireAuth, async (req, res) => {
    try {
      const { deviceId } = req.params;
      const { switchCode } = req.body; // Opcional: código específico do switch
      
      if (!tuya) {
        return res.status(503).json({ success: false, error: 'Módulo Tuya não disponível' });
      }
      
      // Obtém status atual para saber se está ligado ou desligado
      const status = await tuya.getDeviceStatus(deviceId);
      const currentSwitchCode = switchCode || tuya.findSwitchCode(status);
      
      if (!currentSwitchCode) {
        return res.status(400).json({ success: false, error: 'Dispositivo não tem switch controlável' });
      }
      
      // Encontra o valor atual do switch
      const currentSwitch = status.find(s => s.code === currentSwitchCode);
      const currentValue = currentSwitch?.value || false;
      const newValue = !currentValue;
      
      // Envia comando para alternar
      const commands = [{ code: currentSwitchCode, value: newValue }];
      const result = await tuya.sendCommand(deviceId, commands);
      
      // Registra evento no banco
      const ipBlocker = getCurrentIpBlocker();
      if (ipBlocker && typeof ipBlocker.logTuyaEvent === 'function') {
        await ipBlocker.logTuyaEvent(
          deviceId,
          null, // deviceName será preenchido depois
          'power_change',
          currentValue ? 'ON' : 'OFF',
          newValue ? 'ON' : 'OFF',
          'admin'
        );
      }
      
      log(`[ADMIN] Dispositivo ${deviceId} alternado: ${currentValue ? 'ON' : 'OFF'} → ${newValue ? 'ON' : 'OFF'}`);
      
      res.json({ 
        success: true, 
        deviceId, 
        previousState: currentValue,
        newState: newValue,
        result 
      });
    } catch (error) {
      err(`[ADMIN] Erro ao alternar dispositivo:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // API: Ligar dispositivo
  app.post('/admin/api/tuya/device/:deviceId/on', requireAuth, async (req, res) => {
    try {
      const { deviceId } = req.params;
      const { switchCode } = req.body;
      
      if (!tuya) {
        return res.status(503).json({ success: false, error: 'Módulo Tuya não disponível' });
      }
      
      const status = await tuya.getDeviceStatus(deviceId);
      const targetCode = switchCode || tuya.findSwitchCode(status);
      
      if (!targetCode) {
        return res.status(400).json({ success: false, error: 'Dispositivo não tem switch controlável' });
      }
      
      const commands = [{ code: targetCode, value: true }];
      const result = await tuya.sendCommand(deviceId, commands);
      
      // Registra evento
      const ipBlocker = getCurrentIpBlocker();
      if (ipBlocker && typeof ipBlocker.logTuyaEvent === 'function') {
        await ipBlocker.logTuyaEvent(deviceId, null, 'power_change', 'OFF', 'ON', 'admin');
      }
      
      log(`[ADMIN] Dispositivo ${deviceId} ligado via admin`);
      
      res.json({ success: true, deviceId, state: true, result });
    } catch (error) {
      err(`[ADMIN] Erro ao ligar dispositivo:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // API: Desligar dispositivo
  app.post('/admin/api/tuya/device/:deviceId/off', requireAuth, async (req, res) => {
    try {
      const { deviceId } = req.params;
      const { switchCode } = req.body;
      
      if (!tuya) {
        return res.status(503).json({ success: false, error: 'Módulo Tuya não disponível' });
      }
      
      const status = await tuya.getDeviceStatus(deviceId);
      const targetCode = switchCode || tuya.findSwitchCode(status);
      
      if (!targetCode) {
        return res.status(400).json({ success: false, error: 'Dispositivo não tem switch controlável' });
      }
      
      const commands = [{ code: targetCode, value: false }];
      const result = await tuya.sendCommand(deviceId, commands);
      
      // Registra evento
      const ipBlocker = getCurrentIpBlocker();
      if (ipBlocker && typeof ipBlocker.logTuyaEvent === 'function') {
        await ipBlocker.logTuyaEvent(deviceId, null, 'power_change', 'ON', 'OFF', 'admin');
      }
      
      log(`[ADMIN] Dispositivo ${deviceId} desligado via admin`);
      
      res.json({ success: true, deviceId, state: false, result });
    } catch (error) {
      err(`[ADMIN] Erro ao desligar dispositivo:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // API: Listar eventos Tuya
  app.get('/admin/api/tuya/events', requireAuth, async (req, res) => {
    try {
      const { limit = 50, offset = 0, deviceId, eventType } = req.query;
      
      const ipBlocker = getCurrentIpBlocker();
      await waitForDatabase(ipBlocker);
      
      if (!ipBlocker || typeof ipBlocker.listTuyaEvents !== 'function') {
        return res.status(503).json({ success: false, error: 'IP Blocker não disponível' });
      }
      
      const filters = {};
      if (deviceId) filters.deviceId = deviceId;
      if (eventType) filters.eventType = eventType;
      
      const [events, total] = await Promise.all([
        ipBlocker.listTuyaEvents(parseInt(limit), parseInt(offset), filters),
        ipBlocker.countTuyaEvents(filters)
      ]);
      
      res.json({ 
        success: true, 
        data: events,
        pagination: {
          total,
          limit: parseInt(limit),
          offset: parseInt(offset)
        }
      });
    } catch (error) {
      err(`[ADMIN] Erro ao listar eventos Tuya:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // API: Estatísticas Tuya
  app.get('/admin/api/tuya/stats', requireAuth, async (req, res) => {
    try {
      if (!tuya) {
        return res.status(503).json({ success: false, error: 'Módulo Tuya não disponível' });
      }
      
      const devices = await tuya.getCachedDevices();
      
      // Agrupa por categoria
      const byCategory = {};
      devices.forEach(d => {
        const cat = d.category || 'other';
        if (!byCategory[cat]) {
          byCategory[cat] = { total: 0, online: 0, poweredOn: 0 };
        }
        byCategory[cat].total++;
        if (d.online) byCategory[cat].online++;
        if (d.poweredOn) byCategory[cat].poweredOn++;
      });
      
      // Conta eventos recentes (últimas 24h)
      const ipBlocker = getCurrentIpBlocker();
      let recentEvents = 0;
      if (ipBlocker && typeof ipBlocker.countTuyaEvents === 'function') {
        recentEvents = await ipBlocker.countTuyaEvents();
      }
      
      res.json({ 
        success: true,
        stats: {
          total: devices.length,
          online: devices.filter(d => d.online).length,
          offline: devices.filter(d => !d.online).length,
          poweredOn: devices.filter(d => d.poweredOn).length,
          poweredOff: devices.filter(d => !d.poweredOn).length,
          byCategory,
          recentEvents
        }
      });
    } catch (error) {
      err(`[ADMIN] Erro ao obter estatísticas Tuya:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // API: Leituras de energia de um dispositivo
  app.get('/admin/api/tuya/energy/:deviceId', requireAuth, async (req, res) => {
    try {
      const { deviceId } = req.params;
      const { limit = 100, offset = 0 } = req.query;
      
      const ipBlocker = getCurrentIpBlocker();
      await waitForDatabase(ipBlocker);
      
      if (!ipBlocker || typeof ipBlocker.listTuyaEnergyReadings !== 'function') {
        return res.status(503).json({ success: false, error: 'IP Blocker não disponível' });
      }
      
      const readings = await ipBlocker.listTuyaEnergyReadings(deviceId, parseInt(limit), parseInt(offset));
      
      res.json({ success: true, data: readings });
    } catch (error) {
      err(`[ADMIN] Erro ao listar leituras de energia:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // API: Estatísticas de energia por período
  app.get('/admin/api/tuya/energy/:deviceId/stats', requireAuth, async (req, res) => {
    try {
      const { deviceId } = req.params;
      const { hours = 24 } = req.query;
      
      const ipBlocker = getCurrentIpBlocker();
      await waitForDatabase(ipBlocker);
      
      if (!ipBlocker || typeof ipBlocker.getTuyaEnergyStats !== 'function') {
        return res.status(503).json({ success: false, error: 'IP Blocker não disponível' });
      }
      
      const stats = await ipBlocker.getTuyaEnergyStats(deviceId, parseInt(hours));
      
      res.json({ success: true, data: stats });
    } catch (error) {
      err(`[ADMIN] Erro ao obter estatísticas de energia:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // API: Consumo por hora (para gráfico)
  app.get('/admin/api/tuya/energy/:deviceId/hourly', requireAuth, async (req, res) => {
    try {
      const { deviceId } = req.params;
      const { hours = 24 } = req.query;
      
      const ipBlocker = getCurrentIpBlocker();
      await waitForDatabase(ipBlocker);
      
      if (!ipBlocker || typeof ipBlocker.getTuyaEnergyByHour !== 'function') {
        return res.status(503).json({ success: false, error: 'IP Blocker não disponível' });
      }
      
      const hourlyData = await ipBlocker.getTuyaEnergyByHour(deviceId, parseInt(hours));
      
      res.json({ success: true, data: hourlyData });
    } catch (error) {
      err(`[ADMIN] Erro ao obter dados por hora:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // API: Forçar coleta manual de energia
  app.post('/admin/api/tuya/energy/collect-now', requireAuth, async (req, res) => {
    try {
      log(`[ADMIN] 🔍 Coleta manual de energia solicitada...`);
      
      // Tenta usar tuyaMonitor primeiro (se disponível)
      const tuyaMonitor = getCurrentTuyaMonitor?.();
      
      if (tuyaMonitor && typeof tuyaMonitor === 'object' && typeof tuyaMonitor.collectEnergyReadings === 'function') {
        log(`[ADMIN] ✅ Usando tuyaMonitor para coleta...`);
        const result = await tuyaMonitor.collectEnergyReadings();
        log(`[ADMIN] ✅ Coleta concluída: success=${result.success}, collected=${result.collected || 0}, checked=${result.checked || 0}`);
        return res.json({ 
          success: result.success, 
          collected: result.collected || 0,
          checked: result.checked || 0,
          hasEnergyButNoData: result.hasEnergyButNoData || 0,
          error: result.error
        });
      }
      
      // Fallback: coleta direta usando Tuya e ipBlocker
      log(`[ADMIN] ⚠️ tuyaMonitor não disponível, usando coleta direta...`);
      
      if (!tuya) {
        return res.status(503).json({ success: false, error: 'Módulo Tuya não disponível' });
      }
      
      const ipBlocker = getCurrentIpBlocker();
      await waitForDatabase(ipBlocker);
      
      if (!ipBlocker || typeof ipBlocker.saveTuyaEnergyReading !== 'function') {
        return res.status(503).json({ success: false, error: 'IP Blocker não disponível' });
      }
      
      // Busca dispositivos
      const devices = await tuya.getCachedDevices();
      log(`[ADMIN] Verificando ${devices.length} dispositivo(s) para coleta de energia`);
      
      let collected = 0;
      let checked = 0;
      let hasEnergyButNoData = 0;
      
      for (const device of devices) {
        try {
          checked++;
          const status = await tuya.getDeviceStatus(device.id);
          if (!status || !Array.isArray(status)) continue;
          
          // Detecta se tem dados de energia
          const hasEnergyData = status.some(s => {
            const code = (s.code || '').toLowerCase();
            return code.includes('current') || code.includes('voltage') || 
                   code.includes('power') || code.includes('energy') ||
                   code.includes('add_ele') || code.includes('frequency') ||
                   code.includes('cur_power') || code.includes('cur_current') ||
                   code.includes('cur_voltage') || code.includes('activepower') ||
                   code.includes('active_power') || code.includes('power_factor');
          });
          
          if (!hasEnergyData) continue;
          
          hasEnergyButNoData++;
          log(`[ADMIN] Medidor encontrado: ${device.name} (${device.id})`);
          
          // Extrai valores de energia organizados por fases
          const energyData = { phases: {} };
          const phases = ['A', 'B', 'C'];
          
          // Função auxiliar para detectar fase
          const getPhase = (code) => {
            const upperCode = code.toUpperCase();
            if (upperCode.includes('A') && !upperCode.includes('B') && !upperCode.includes('C')) return 'A';
            if (upperCode.includes('B') && !upperCode.includes('C')) return 'B';
            if (upperCode.includes('C')) return 'C';
            return null;
          };
          
          // Processa cada status
          for (const s of status) {
            const code = (s.code || '').toLowerCase();
            const codeOriginal = s.code || '';
            const value = s.value;
            
            if (typeof value !== 'number') continue;
            
            const phase = getPhase(codeOriginal);
            
            // Processa por tipo de dado
            if (code.includes('voltage') || code.includes('cur_voltage') || code.includes('curvoltage')) {
              const voltage = code.includes('cur_voltage') || code.includes('curvoltage') ? value / 10 : value;
              if (phase) {
                if (!energyData.phases[phase]) energyData.phases[phase] = {};
                energyData.phases[phase].voltage = voltage;
              } else {
                energyData.voltage = voltage;
              }
            } else if ((code.includes('current') && !code.includes('active')) || code.includes('cur_current') || code.includes('curcurrent')) {
              const current = code.includes('cur_current') || code.includes('curcurrent') ? value / 1000 : value;
              if (phase) {
                if (!energyData.phases[phase]) energyData.phases[phase] = {};
                energyData.phases[phase].current = current;
              } else {
                energyData.current = (energyData.current || 0) + current;
              }
            } else if (code.includes('activepower') || code.includes('active_power') || code.includes('cur_power') || code.includes('curpower') ||
                       (code.includes('power') && !code.includes('factor') && !code.includes('reactive'))) {
              const power = code.includes('cur_power') || code.includes('curpower') ? value / 10 : value;
              if (phase) {
                if (!energyData.phases[phase]) energyData.phases[phase] = {};
                energyData.phases[phase].power = power;
              } else {
                energyData.power = (energyData.power || 0) + power;
              }
            } else if (code.includes('reactivepower') || code.includes('reactive_power')) {
              const reactivePower = value;
              if (phase) {
                if (!energyData.phases[phase]) energyData.phases[phase] = {};
                energyData.phases[phase].reactivePower = reactivePower;
              }
            } else if (code.includes('energyconsumed') || code.includes('energy_consumed') || code.includes('add_ele') ||
                       (code.includes('energy') && !code.includes('power'))) {
              const energy = value / 1000; // Converte Wh para kWh
              if (phase) {
                if (!energyData.phases[phase]) energyData.phases[phase] = {};
                energyData.phases[phase].energy = energy;
              } else {
                energyData.energy = (energyData.energy || 0) + energy;
              }
            } else if (code.includes('powerfactor') || code.includes('power_factor') || code.includes('factor')) {
              const powerFactor = value / 100;
              if (phase) {
                if (!energyData.phases[phase]) energyData.phases[phase] = {};
                energyData.phases[phase].powerFactor = powerFactor;
              } else {
                // Média dos fatores de potência
                if (!energyData.powerFactor) energyData.powerFactor = 0;
                energyData.powerFactor = (energyData.powerFactor + powerFactor) / 2;
              }
            } else if (code.includes('frequency')) {
              energyData.frequency = value / 10;
            }
          }
          
          // Remove phases vazias
          Object.keys(energyData.phases).forEach(phase => {
            if (Object.keys(energyData.phases[phase]).length === 0) {
              delete energyData.phases[phase];
            }
          });
          
          // Se não há fases, remove o objeto phases
          if (Object.keys(energyData.phases).length === 0) {
            delete energyData.phases;
          }
          
          if (Object.keys(energyData).length > 0 && (energyData.voltage || energyData.current || energyData.power || energyData.energy || energyData.phases)) {
            await ipBlocker.saveTuyaEnergyReading(device.id, device.name, energyData);
            collected++;
            
            // Log melhorado
            if (energyData.phases) {
              const phasesInfo = Object.keys(energyData.phases).map(p => 
                `Fase ${p}: ${energyData.phases[p].power?.toFixed(1) || 0}W`
              ).join(', ');
              log(`[ADMIN] ✅ Energia coletada (múltiplas fases): ${device.name} | ${phasesInfo}`);
            } else {
              log(`[ADMIN] ✅ Energia coletada: ${device.name} | V=${energyData.voltage?.toFixed(1) || '-'} | A=${energyData.current?.toFixed(3) || '-'} | W=${energyData.power?.toFixed(1) || '-'}`);
            }
          }
        } catch (e) {
          err(`[ADMIN] Erro ao coletar energia de ${device.name}:`, e.message);
        }
      }
      
      log(`[ADMIN] ✅ Coleta concluída: ${collected} dispositivo(s) registrado(s) de ${hasEnergyButNoData} medidor(es) encontrado(s)`);
      
      res.json({ 
        success: true, 
        collected,
        checked,
        hasEnergyButNoData,
        error: null
      });
    } catch (error) {
      err(`[ADMIN] ❌ Erro ao forçar coleta de energia:`, error.message);
      err(`[ADMIN] Stack:`, error.stack);
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // API: Lista dispositivos com leituras de energia disponíveis
  app.get('/admin/api/tuya/energy-devices', requireAuth, async (req, res) => {
    try {
      const ipBlocker = getCurrentIpBlocker();
      await waitForDatabase(ipBlocker);
      
      if (!ipBlocker || typeof ipBlocker.listTuyaEnergyReadings !== 'function') {
        return res.status(503).json({ success: false, error: 'IP Blocker não disponível' });
      }
      
      // Busca todas as leituras recentes para identificar dispositivos com dados
      const readings = await ipBlocker.listTuyaEnergyReadings(null, 1000, 0);
      
      // Agrupa por dispositivo (dos que já têm leituras)
      const deviceMap = new Map();
      for (const r of readings) {
        if (!deviceMap.has(r.device_id)) {
          deviceMap.set(r.device_id, {
            deviceId: r.device_id,
            deviceName: r.device_name,
            readingsCount: 0,
            lastReading: r.created_at,
            latestPower: r.power_w,
            hasReadings: true
          });
        }
        deviceMap.get(r.device_id).readingsCount++;
      }
      
      // Também busca dispositivos Tuya diretamente para encontrar medidores sem leituras ainda
      if (tuya) {
        try {
          const allDevices = await tuya.getCachedDevices();
          
          for (const device of allDevices) {
            // Se já está no map (tem leituras), pula
            if (deviceMap.has(device.id)) continue;
            
            try {
              // Verifica se o dispositivo tem códigos de energia
              const status = await tuya.getDeviceStatus(device.id);
              if (status && Array.isArray(status)) {
                const hasEnergyData = status.some(s => {
                  const code = (s.code || '').toLowerCase();
                  return code.includes('current') || code.includes('voltage') || 
                         code.includes('power') || code.includes('energy') ||
                         code.includes('add_ele') || code.includes('frequency');
                });
                
                if (hasEnergyData) {
                  deviceMap.set(device.id, {
                    deviceId: device.id,
                    deviceName: device.name,
                    readingsCount: 0,
                    lastReading: null,
                    latestPower: null,
                    hasReadings: false
                  });
                }
              }
            } catch (e) {
              dbg(`[ADMIN] Erro ao verificar dispositivo ${device.id}:`, e.message);
            }
          }
        } catch (e) {
          warn(`[ADMIN] Erro ao buscar dispositivos Tuya:`, e.message);
        }
      }
      
      res.json({ success: true, data: Array.from(deviceMap.values()) });
    } catch (error) {
      err(`[ADMIN] Erro ao listar dispositivos de energia:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // ===== ACCESS LOG ENDPOINTS =====
  
  // API: Listar logs de acesso
  app.get('/admin/api/access-logs', requireAuth, async (req, res) => {
    try {
      const { limit = 100, offset = 0, ip, route, method } = req.query;
      
      const ipBlocker = getCurrentIpBlocker();
      await waitForDatabase(ipBlocker);
      
      if (!ipBlocker || typeof ipBlocker.listAccessLogs !== 'function') {
        return res.status(503).json({ success: false, error: 'IP Blocker não disponível' });
      }
      
      const filters = {};
      if (ip) filters.ip = ip;
      if (route) filters.route = route;
      if (method) filters.method = method;
      
      const [logs, total] = await Promise.all([
        ipBlocker.listAccessLogs(parseInt(limit), parseInt(offset), filters),
        ipBlocker.countAccessLogs(filters)
      ]);
      
      res.json({ 
        success: true, 
        data: logs,
        pagination: {
          total,
          limit: parseInt(limit),
          offset: parseInt(offset)
        }
      });
    } catch (error) {
      err(`[ADMIN] Erro ao listar access logs:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // API: Estatísticas de acesso por rota
  app.get('/admin/api/access-logs/stats/routes', requireAuth, async (req, res) => {
    try {
      const { limit = 20 } = req.query;
      
      const ipBlocker = getCurrentIpBlocker();
      await waitForDatabase(ipBlocker);
      
      if (!ipBlocker || typeof ipBlocker.getAccessStatsByRoute !== 'function') {
        return res.status(503).json({ success: false, error: 'IP Blocker não disponível' });
      }
      
      const stats = await ipBlocker.getAccessStatsByRoute(parseInt(limit));
      
      res.json({ success: true, data: stats });
    } catch (error) {
      err(`[ADMIN] Erro ao obter stats por rota:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // API: Estatísticas de acesso por IP
  app.get('/admin/api/access-logs/stats/ips', requireAuth, async (req, res) => {
    try {
      const { limit = 20 } = req.query;
      
      const ipBlocker = getCurrentIpBlocker();
      await waitForDatabase(ipBlocker);
      
      if (!ipBlocker || typeof ipBlocker.getAccessStatsByIP !== 'function') {
        return res.status(503).json({ success: false, error: 'IP Blocker não disponível' });
      }
      
      const stats = await ipBlocker.getAccessStatsByIP(parseInt(limit));
      
      res.json({ success: true, data: stats });
    } catch (error) {
      err(`[ADMIN] Erro ao obter stats por IP:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // ===== ROUTES ENDPOINT =====
  
  // API: Listar todas as rotas disponíveis
  app.get('/admin/api/routes', requireAuth, async (req, res) => {
    try {
      const routes = [];
      
      // Coleta rotas do Express
      app._router.stack.forEach((middleware) => {
        if (middleware.route) {
          // Rotas diretas
          const methods = Object.keys(middleware.route.methods).map(m => m.toUpperCase());
          routes.push({
            path: middleware.route.path,
            methods,
            type: 'route'
          });
        } else if (middleware.name === 'router') {
          // Sub-routers
          middleware.handle.stack.forEach((handler) => {
            if (handler.route) {
              const methods = Object.keys(handler.route.methods).map(m => m.toUpperCase());
              routes.push({
                path: handler.route.path,
                methods,
                type: 'router'
              });
            }
          });
        }
      });
      
      // Agrupa por categoria
      const categorized = {
        admin: routes.filter(r => r.path.startsWith('/admin')),
        api: routes.filter(r => !r.path.startsWith('/admin') && !r.path.startsWith('/webhook')),
        webhook: routes.filter(r => r.path.startsWith('/webhook'))
      };
      
      res.json({ 
        success: true, 
        total: routes.length,
        routes,
        categorized
      });
    } catch (error) {
      err(`[ADMIN] Erro ao listar rotas:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // ===== COMEDOR DEVICES ENDPOINTS =====
  
  // API: Listar dispositivos do comedor
  app.get('/admin/api/comedor/devices', requireAuth, async (req, res) => {
    try {
      const comedorDeviceStatus = getCurrentComedorDeviceStatus?.();
      if (!comedorDeviceStatus) {
        return res.status(503).json({ 
          success: false, 
          error: 'Comedor Device Status não disponível' 
        });
      }
      
      const devices = comedorDeviceStatus.listDevices();
      
      res.json({
        success: true,
        total: devices.length,
        devices: devices
      });
    } catch (error) {
      err(`[ADMIN] Erro ao listar dispositivos do comedor:`, error.message);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });
  
  // API: Obter token configurado
  app.get('/admin/api/comedor/config/token', requireAuth, async (req, res) => {
    try {
      const comedorDeviceStatus = getCurrentComedorDeviceStatus?.();
      if (!comedorDeviceStatus) {
        return res.status(503).json({ 
          success: false, 
          error: 'Comedor Device Status não disponível' 
        });
      }
      
      const token = comedorDeviceStatus.getToken();
      res.json({
        success: true,
        config: {
          token: token ? '***' : null,
          hasToken: token !== null,
          configured: token !== null
        }
      });
    } catch (error) {
      err(`[ADMIN] Erro ao obter token do comedor:`, error.message);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });
  
  // API: Configurar token
  app.post('/admin/api/comedor/config/token', requireAuth, async (req, res) => {
    try {
      const comedorDeviceStatus = getCurrentComedorDeviceStatus?.();
      if (!comedorDeviceStatus) {
        return res.status(503).json({ 
          success: false, 
          error: 'Comedor Device Status não disponível' 
        });
      }
      
      const { token } = req.body;
      if (!token || typeof token !== 'string' || token.trim().length === 0) {
        return res.status(400).json({ 
          success: false, 
          error: 'Token inválido. Forneça um token não vazio.' 
        });
      }
      
      const updated = comedorDeviceStatus.setToken(token);
      if (updated) {
        log(`[ADMIN] Token do comedor configurado via admin`);
        res.json({ 
          success: true, 
          message: 'Token configurado com sucesso',
          config: {
            hasToken: true,
            configured: true
          }
        });
      } else {
        res.status(400).json({ 
          success: false, 
          error: 'Falha ao configurar token' 
        });
      }
    } catch (error) {
      err(`[ADMIN] Erro ao configurar token do comedor:`, error.message);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });
  
  // API: Adotar dispositivo
  app.post('/admin/api/comedor/device/adopt', requireAuth, async (req, res) => {
    try {
      const comedorDeviceStatus = getCurrentComedorDeviceStatus?.();
      if (!comedorDeviceStatus) {
        return res.status(503).json({ 
          success: false, 
          error: 'Comedor Device Status não disponível' 
        });
      }
      
      const { ip, deviceId, device_id } = req.body;
      const identifier = ip || deviceId || device_id;
      const actualDeviceId = deviceId || device_id || null;
      
      if (!identifier || typeof identifier !== 'string' || identifier.trim().length === 0) {
        return res.status(400).json({ 
          success: false, 
          error: 'IP ou deviceId do dispositivo é obrigatório' 
        });
      }
      
      // Obter status do dispositivo para pegar o IP atual
      const deviceStatus = comedorDeviceStatus.getDeviceStatus(identifier.trim(), actualDeviceId ? actualDeviceId.trim() : null);
      const deviceIp = deviceStatus?.ip || ip || identifier;
      
      const adopted = comedorDeviceStatus.adoptDevice(identifier.trim(), actualDeviceId ? actualDeviceId.trim() : null);
      if (adopted) {
        log(`[ADMIN] Dispositivo ${actualDeviceId || identifier} (IP: ${deviceIp}) adotado via admin`);
        
        // Tentar enviar token ao dispositivo via HTTP POST
        try {
          const token = comedorDeviceStatus.getToken();
          if (token && deviceIp) {
            const axios = require('axios');
            const configUrl = `http://${deviceIp}/config/from-server`;
            const configData = {
              apiNotificationToken: token
            };
            
            dbg(`[ADMIN] Enviando token ao dispositivo ${deviceIp}...`);
            dbg(`[ADMIN] URL: ${configUrl}`);
            dbg(`[ADMIN] Token (primeiros 10 chars): ${token.substring(0, 10)}...`);
            await axios.post(configUrl, configData, {
              timeout: 5000,
              headers: { 
                'Content-Type': 'application/json',
                'Accept': 'application/json'
              },
              maxRedirects: 0
            }).then((response) => {
              log(`[ADMIN] Token enviado com sucesso ao dispositivo ${deviceIp} (status: ${response.status})`);
            }).catch((error) => {
              const errorMsg = error.response 
                ? `Status ${error.response.status}: ${error.response.statusText}` 
                : error.message;
              warn(`[ADMIN] Falha ao enviar token ao dispositivo ${deviceIp}: ${errorMsg}`);
              if (error.response && error.response.data) {
                dbg(`[ADMIN] Resposta do dispositivo: ${JSON.stringify(error.response.data)}`);
              }
              // Não falha a adoção se não conseguir enviar token
            });
          }
        } catch (sendError) {
          warn(`[ADMIN] Erro ao enviar token ao dispositivo:`, sendError.message);
          // Não falha a adoção se não conseguir enviar token
        }
        
        res.json({ 
          success: true, 
          message: 'Dispositivo adotado com sucesso',
          device: {
            deviceId: actualDeviceId,
            ip: deviceIp,
            adopted: true
          }
        });
      } else {
        res.status(400).json({ 
          success: false, 
          error: 'Falha ao adotar dispositivo' 
        });
      }
    } catch (error) {
      err(`[ADMIN] Erro ao adotar dispositivo do comedor:`, error.message);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });
  
  // API: Remover adoção de dispositivo
  app.post('/admin/api/comedor/device/unadopt', requireAuth, async (req, res) => {
    try {
      const comedorDeviceStatus = getCurrentComedorDeviceStatus?.();
      if (!comedorDeviceStatus) {
        return res.status(503).json({ 
          success: false, 
          error: 'Comedor Device Status não disponível' 
        });
      }
      
      const { ip, deviceId, device_id } = req.body;
      const identifier = ip || deviceId || device_id;
      const actualDeviceId = deviceId || device_id || null;
      
      if (!identifier || typeof identifier !== 'string' || identifier.trim().length === 0) {
        return res.status(400).json({ 
          success: false, 
          error: 'IP ou deviceId do dispositivo é obrigatório' 
        });
      }
      
      const unadopted = comedorDeviceStatus.unadoptDevice(identifier.trim(), actualDeviceId ? actualDeviceId.trim() : null);
      if (unadopted) {
        log(`[ADMIN] Adoção removida do dispositivo ${actualDeviceId || identifier} (IP: ${ip || 'N/A'}) via admin`);
        res.json({ 
          success: true, 
          message: 'Adoção removida com sucesso',
          device: {
            deviceId: actualDeviceId,
            ip: ip || identifier,
            adopted: false
          }
        });
      } else {
        res.status(404).json({ 
          success: false, 
          error: 'Dispositivo não encontrado' 
        });
      }
    } catch (error) {
      err(`[ADMIN] Erro ao remover adoção do dispositivo:`, error.message);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });
  
  // API: Status de um dispositivo específico
  app.get('/admin/api/comedor/device/status', requireAuth, async (req, res) => {
    try {
      const comedorDeviceStatus = getCurrentComedorDeviceStatus?.();
      if (!comedorDeviceStatus) {
        return res.status(503).json({ 
          success: false, 
          error: 'Comedor Device Status não disponível' 
        });
      }
      
      const deviceIp = req.query.ip;
      const deviceId = req.query.deviceId || req.query.device_id;
      
      if (!deviceIp && !deviceId) {
        return res.status(400).json({ 
          success: false, 
          error: 'IP ou deviceId do dispositivo não fornecido' 
        });
      }
      
      const status = comedorDeviceStatus.getDeviceStatus(deviceId || deviceIp, deviceId);
      if (!status) {
        return res.status(404).json({ 
          success: false, 
          error: 'Dispositivo não encontrado',
          ip: deviceIp,
          deviceId: deviceId
        });
      }
      
      res.json({
        success: true,
        device: status
      });
    } catch (error) {
      err(`[ADMIN] Erro ao obter status do dispositivo:`, error.message);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });
  
  // API: Buscar configurações do ESP32
  app.get('/admin/api/comedor/device/config/fetch', requireAuth, async (req, res) => {
    try {
      const comedorDeviceStatus = getCurrentComedorDeviceStatus?.();
      if (!comedorDeviceStatus) {
        return res.status(503).json({ 
          success: false, 
          error: 'Comedor Device Status não disponível' 
        });
      }
      
      const deviceIp = req.query.ip;
      const deviceId = req.query.deviceId || req.query.device_id;
      
      if (!deviceIp) {
        return res.status(400).json({ 
          success: false, 
          error: 'IP do dispositivo é obrigatório' 
        });
      }
      
      try {
        const axios = require('axios');
        const configUrl = `http://${deviceIp}/config`;
        dbg(`[ADMIN] Buscando configurações do dispositivo ${deviceIp}...`);
        
        const [configResponse, schedulesResponse] = await Promise.all([
          axios.get(configUrl, { timeout: 5000 }),
          axios.get(`http://${deviceIp}/schedules`, { timeout: 5000 }).catch(() => null)
        ]);
        
        const espConfig = configResponse.data;
        const espSchedules = schedulesResponse ? schedulesResponse.data : null;
        
        dbg(`[ADMIN] Configurações recebidas do ESP32:`, JSON.stringify(espConfig, null, 2));
        
        // Helper para converter string para boolean
        const parseBool = (val) => {
          if (val === true || val === 'true') return true;
          if (val === false || val === 'false') return false;
          return val;
        };
        
        // Helper para converter string para número
        const parseNum = (val) => {
          if (val === undefined || val === null) return undefined;
          const parsed = typeof val === 'string' ? parseFloat(val) : val;
          return isNaN(parsed) ? undefined : parsed;
        };
        
        // Helper para converter string para inteiro
        const parseIntSafe = (val) => {
          if (val === undefined || val === null) return undefined;
          const parsed = typeof val === 'string' ? parseInt(val, 10) : val;
          return isNaN(parsed) ? undefined : parsed;
        };
        
        // Mapear TODAS as configurações do ESP32 para o formato da API (com conversão de tipos)
        const apiConfig = {
          // Stepper
          stepperSpeed: parseIntSafe(espConfig.stepperSpeed),
          stepperDirection: parseBool(espConfig.stepperDirection),
          stepperStepsForward: parseIntSafe(espConfig.stepperStepsForward),
          stepperBackoffSteps: parseIntSafe(espConfig.stepperBackoffSteps),
          
          // Servo
          servoTimeA: parseIntSafe(espConfig.servoTimeA),
          servoTimeB: parseIntSafe(espConfig.servoTimeB),
          servoSpeed: parseIntSafe(espConfig.servoSpeed),
          servoSpeedA: parseIntSafe(espConfig.servoSpeedA),
          servoSpeedB: parseIntSafe(espConfig.servoSpeedB),
          servoUseHome: parseBool(espConfig.servoUseHome),
          
          // Balança
          scaleOffset: parseNum(espConfig.scaleOffset),
          scaleFactor: parseNum(espConfig.scaleFactor),
          weightTolerance: parseNum(espConfig.weightTolerance),
          scaleZeroTolerance: parseNum(espConfig.scaleZeroTolerance) || parseNum(espConfig.weightTolerance),
          
          // Alimentação
          defaultFeedAmountA: parseNum(espConfig.defaultFeedAmountA),
          defaultFeedAmountB: parseNum(espConfig.defaultFeedAmountB),
          fallbackInterval: parseIntSafe(espConfig.fallbackInterval),
          
          // Reservatório
          reservoirEmptyCm: parseNum(espConfig.reservoirEmptyCm),
          reservoirFullCm: parseNum(espConfig.reservoirFullCm),
          
          // Debug
          debugEnabled: parseBool(espConfig.debugEnabled),
          debugLevelSensor: parseBool(espConfig.debugLevelSensor),
          
          // Animais e Notificações (strings, manter como estão mas garantir que são strings)
          animalType: typeof espConfig.animalType === 'string' ? espConfig.animalType : (espConfig.animalType || ''),
          animalAName: typeof espConfig.animalAName === 'string' ? espConfig.animalAName : (espConfig.animalAName || ''),
          animalBName: typeof espConfig.animalBName === 'string' ? espConfig.animalBName : (espConfig.animalBName || ''),
          apiNotificationUrl: typeof espConfig.apiNotificationUrl === 'string' ? espConfig.apiNotificationUrl : (espConfig.apiNotificationUrl || ''),
          apiNotificationUseSSL: parseBool(espConfig.apiNotificationUseSSL),
          
          // Horários
          schedules: espSchedules || []
        };
        
        // Remover campos undefined
        Object.keys(apiConfig).forEach(key => {
          if (apiConfig[key] === undefined) {
            delete apiConfig[key];
          }
        });
        
        dbg(`[ADMIN] Configurações mapeadas para API:`, JSON.stringify(apiConfig, null, 2));
        
        // Salvar na API se deviceId foi fornecido
        if (deviceId) {
          const updated = comedorDeviceStatus.updateDeviceConfig(deviceIp, deviceId, apiConfig);
          if (updated) {
            log(`[ADMIN] Configurações buscadas do ESP32 e salvas na API para dispositivo ${deviceId}`);
          }
        }
        
        res.json({
          success: true,
          message: 'Configurações buscadas do ESP32 com sucesso',
          config: apiConfig,
          rawConfig: espConfig,
          schedules: espSchedules
        });
      } catch (fetchError) {
        const errorMsg = fetchError.response 
          ? `Status ${fetchError.response.status}: ${fetchError.response.statusText}` 
          : fetchError.message;
        warn(`[ADMIN] Erro ao buscar configurações do ESP32 ${deviceIp}: ${errorMsg}`);
        res.status(500).json({
          success: false,
          error: `Erro ao buscar configurações do ESP32: ${errorMsg}`
        });
      }
    } catch (error) {
      err(`[ADMIN] Erro ao buscar configurações do dispositivo:`, error.message);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });
  
  // API: Atualizar configurações de um dispositivo
  app.post('/admin/api/comedor/device/config', requireAuth, async (req, res) => {
    try {
      const comedorDeviceStatus = getCurrentComedorDeviceStatus?.();
      if (!comedorDeviceStatus) {
        return res.status(503).json({ 
          success: false, 
          error: 'Comedor Device Status não disponível' 
        });
      }
      
      const { ip, deviceId, device_id, config, sendToDevice } = req.body;
      const identifier = ip || deviceId || device_id;
      const actualDeviceId = deviceId || device_id || null;
      const shouldSendToDevice = sendToDevice !== false; // Por padrão envia ao dispositivo
      
      if (!identifier || typeof identifier !== 'string' || identifier.trim().length === 0) {
        return res.status(400).json({ 
          success: false, 
          error: 'IP ou deviceId do dispositivo é obrigatório' 
        });
      }
      
      if (!config || typeof config !== 'object') {
        return res.status(400).json({ 
          success: false, 
          error: 'Configurações inválidas' 
        });
      }
      
      // Salvar na API
      const updated = comedorDeviceStatus.updateDeviceConfig(identifier.trim(), actualDeviceId ? actualDeviceId.trim() : null, config);
      if (!updated) {
        return res.status(404).json({ 
          success: false, 
          error: 'Dispositivo não encontrado' 
        });
      }
      
      log(`[ADMIN] Configurações do dispositivo ${actualDeviceId || identifier} atualizadas via admin`);
      
      // Se solicitado, enviar ao dispositivo
      let sentToDevice = false;
      if (shouldSendToDevice && ip) {
        try {
          const axios = require('axios');
          const configUrl = `http://${ip}/config/from-server`;
          
          // Mapear configurações da API para o formato do ESP32
          const espConfig = {};
          
          // Sempre enviar token se disponível
          const token = comedorDeviceStatus.getToken();
          if (token) {
            espConfig.apiNotificationToken = token;
          }
          
          // Stepper
          if (config.stepperDirection !== undefined) espConfig.stepperDirection = config.stepperDirection;
          if (config.stepperSpeed !== undefined) espConfig.stepperSpeed = config.stepperSpeed;
          if (config.stepperStepsForward !== undefined) espConfig.stepperStepsForward = config.stepperStepsForward;
          if (config.stepperBackoffSteps !== undefined) espConfig.stepperBackoffSteps = config.stepperBackoffSteps;

          // Servo
          if (config.servoTimeA !== undefined) espConfig.servoTimeA = config.servoTimeA;
          if (config.servoTimeB !== undefined) espConfig.servoTimeB = config.servoTimeB;
          if (config.servoSpeed !== undefined) espConfig.servoSpeed = config.servoSpeed;
          if (config.servoSpeedA !== undefined) espConfig.servoSpeedA = config.servoSpeedA;
          if (config.servoSpeedB !== undefined) espConfig.servoSpeedB = config.servoSpeedB;
          if (config.servoUseHome !== undefined) espConfig.servoUseHome = config.servoUseHome;

          // Balança
          if (config.scaleOffset !== undefined) espConfig.scaleOffset = config.scaleOffset;
          if (config.scaleFactor !== undefined) espConfig.scaleFactor = config.scaleFactor;
          if (config.scaleZeroTolerance !== undefined || config.weightTolerance !== undefined) {
            espConfig.weightTolerance = config.scaleZeroTolerance || config.weightTolerance;
            espConfig.scaleZeroTolerance = config.scaleZeroTolerance || config.weightTolerance;
          }

          // Alimentação
          if (config.defaultFeedAmountA !== undefined) espConfig.defaultFeedAmountA = config.defaultFeedAmountA;
          if (config.defaultFeedAmountB !== undefined) espConfig.defaultFeedAmountB = config.defaultFeedAmountB;
          if (config.fallbackInterval !== undefined) espConfig.fallbackInterval = config.fallbackInterval;

          // Reservatório
          if (config.reservoirEmptyCm !== undefined) espConfig.reservoirEmptyCm = config.reservoirEmptyCm;
          if (config.reservoirFullCm !== undefined) espConfig.reservoirFullCm = config.reservoirFullCm;

          // Debug
          if (config.debugEnabled !== undefined) espConfig.debugEnabled = config.debugEnabled;
          if (config.debugLevelSensor !== undefined) espConfig.debugLevelSensor = config.debugLevelSensor;

          // Animais e Notificações
          if (config.animalType !== undefined) espConfig.animalType = config.animalType;
          if (config.animalAName !== undefined) espConfig.animalAName = config.animalAName;
          if (config.animalBName !== undefined) espConfig.animalBName = config.animalBName;
          if (config.apiNotificationUrl !== undefined) espConfig.apiNotificationUrl = config.apiNotificationUrl;
          if (config.apiNotificationUseSSL !== undefined) espConfig.apiNotificationUseSSL = config.apiNotificationUseSSL;
          
          dbg(`[ADMIN] Enviando configurações ao dispositivo ${ip}...`);
          await axios.post(configUrl, espConfig, {
            timeout: 5000,
            headers: { 
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            }
          });
          
          sentToDevice = true;
          log(`[ADMIN] Configurações enviadas ao dispositivo ${ip} com sucesso`);
        } catch (sendError) {
          const errorMsg = sendError.response 
            ? `Status ${sendError.response.status}: ${sendError.response.statusText}` 
            : sendError.message;
          warn(`[ADMIN] Erro ao enviar configurações ao dispositivo ${ip}: ${errorMsg}`);
          // Não falha a operação, apenas avisa
        }
      }
      
      // Se schedules foram fornecidos e dispositivo foi encontrado, enviar schedules
      let schedulesSent = false;
      if (config.schedules && Array.isArray(config.schedules) && shouldSendToDevice && ip) {
        try {
          const axios = require('axios');
          const schedulesUrl = `http://${ip}/schedules/save`;
          
          const schedulesPayload = {};
          config.schedules.forEach((schedule, i) => {
            schedulesPayload[`schedule${i}_hour`] = schedule.hour || 0;
            schedulesPayload[`schedule${i}_minute`] = schedule.minute || 0;
            schedulesPayload[`schedule${i}_amountA`] = schedule.amountA || 0;
            schedulesPayload[`schedule${i}_amountB`] = schedule.amountB || 0;
            schedulesPayload[`schedule${i}_enabled`] = schedule.enabled ? 'true' : 'false';
          });
          
          dbg(`[ADMIN] Enviando schedules ao dispositivo ${ip}...`);
          await axios.post(schedulesUrl, new URLSearchParams(schedulesPayload).toString(), {
            timeout: 5000,
            headers: { 
              'Content-Type': 'application/x-www-form-urlencoded'
            }
          });
          
          schedulesSent = true;
          log(`[ADMIN] Schedules enviados ao dispositivo ${ip} com sucesso`);
        } catch (schedError) {
          const errorMsg = schedError.response 
            ? `Status ${schedError.response.status}: ${schedError.response.statusText}` 
            : schedError.message;
          warn(`[ADMIN] Erro ao enviar schedules ao dispositivo ${ip}: ${errorMsg}`);
          // Não falha a operação, apenas avisa
        }
      }
      
      res.json({ 
        success: true, 
        message: 'Configurações atualizadas com sucesso' + (sentToDevice ? ' e enviadas ao dispositivo' : ''),
        sentToDevice: sentToDevice,
        schedulesSent: schedulesSent,
        device: {
          deviceId: actualDeviceId,
          ip: ip || identifier,
          config: config
        }
      });
    } catch (error) {
      err(`[ADMIN] Erro ao atualizar configurações do dispositivo:`, error.message);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });
  
  log(`[ADMIN] ✅ Módulo inicializado | Admin: ${ADMIN_PHONE_NUMBER || 'NÃO CONFIGURADO'}`);
  
  return { sendAccessCode, validateCode, validateSession };
}

module.exports = { initAdminModule };
