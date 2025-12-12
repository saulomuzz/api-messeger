/**
 * Módulo de Administração - Versão que aguarda banco estar pronto
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

function initAdminModule({ app, appRoot, logger, getCurrentIpBlocker, whatsappOfficial, websocketESP32, getClientIp }) {
  const { log, warn, err, dbg } = logger;
  
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
  createDashboardRoutes({ app, requireAuth, dashboardController, logger });
  
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
  
  // Armazena códigos e sessões
  const pendingCodes = new Map();
  const activeSessions = new Map();
  
  // Funções auxiliares
  function generateAccessCode() {
    return crypto.randomInt(100000, 999999).toString();
  }
  
  function generateSessionId() {
    return crypto.randomBytes(32).toString('hex');
  }
  
  // Limpeza automática
  setInterval(() => {
    const now = Date.now();
    for (const [phone, data] of pendingCodes.entries()) {
      if (data.expiresAt < now) pendingCodes.delete(phone);
    }
    for (const [sessionId, session] of activeSessions.entries()) {
      if (session.expiresAt < now) activeSessions.delete(sessionId);
    }
  }, 60 * 1000);
  
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
      if (whatsappOfficial?.sendTextMessage) {
        await whatsappOfficial.sendTextMessage(phone, 
          `🔐 *Código de Acesso*\n\nCódigo: *${code}*\nExpira em ${ADMIN_CODE_EXPIRY_MINUTES} minutos.`
        );
        return { success: true };
      }
    } catch (error) {
      err(`[ADMIN] Erro ao enviar código:`, error.message);
    }
    return { success: false, error: 'WhatsApp not available' };
  }
  
  // Valida código
  function validateCode(phone, code) {
    const codeData = pendingCodes.get(phone);
    if (!codeData || codeData.expiresAt < Date.now() || codeData.code !== code) {
      return { valid: false, error: 'Código inválido ou expirado' };
    }
    
    const sessionId = generateSessionId();
    activeSessions.set(sessionId, {
      phone,
      createdAt: Date.now(),
      expiresAt: Date.now() + (ADMIN_SESSION_EXPIRY_HOURS * 60 * 60 * 1000)
    });
    
    pendingCodes.delete(phone);
    return { valid: true, sessionId };
  }
  
  // Valida sessão
  function validateSession(sessionId) {
    const session = activeSessions.get(sessionId);
    if (!session || session.expiresAt < Date.now()) {
      return { valid: false };
    }
    return { valid: true, phone: session.phone };
  }
  
  // Middleware de autenticação
  function requireAuth(req, res, next) {
    const sessionId = req.cookies?.admin_session || req.headers['x-admin-session'];
    const validation = validateSession(sessionId);
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
  
  app.get('/admin', (req, res) => {
    const template = loadTemplate('login');
    res.send(template || 'Erro ao carregar página');
  });
  
  app.post('/admin/request-code', async (req, res) => {
    const result = await sendAccessCode(req.body.phone);
    res.json(result);
  });
  
  app.post('/admin/validate-code', (req, res) => {
    const result = validateCode(req.body.phone, req.body.code);
    if (result.valid) {
      res.cookie('admin_session', result.sessionId, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        maxAge: ADMIN_SESSION_EXPIRY_HOURS * 60 * 60 * 1000,
        sameSite: 'strict'
      });
      res.json({ success: true });
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
  
  app.post('/admin/logout', requireAuth, (req, res) => {
    const sessionId = req.cookies?.admin_session || req.headers['x-admin-session'];
    if (sessionId) activeSessions.delete(sessionId);
    res.clearCookie('admin_session');
    res.json({ success: true });
  });
  
  // Endpoint temporário de debug (SEM autenticação - REMOVER EM PRODUÇÃO)
  app.get('/admin/debug/info', async (req, res) => {
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
  
  log(`[ADMIN] ✅ Módulo inicializado | Admin: ${ADMIN_PHONE_NUMBER || 'NÃO CONFIGURADO'}`);
  
  return { sendAccessCode, validateCode, validateSession };
}

module.exports = { initAdminModule };
