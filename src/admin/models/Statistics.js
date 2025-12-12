/**
 * Modelo de Estatísticas
 * Gerencia coleta e armazenamento de estatísticas do sistema
 */

class StatisticsModel {
  constructor(getIpBlocker = null) {
    const fs = require('fs');
    const path = require('path');
    
    // Função para obter ipBlocker (pode ser null inicialmente)
    this.getIpBlocker = getIpBlocker || (() => global.ipBlocker || null);
    
    // Caminho do arquivo de persistência (fallback)
    let appRoot;
    try {
      appRoot = global.APP_ROOT || process.env.APP_ROOT;
      if (!appRoot) {
        appRoot = path.resolve(__dirname, '..', '..', '..');
      }
    } catch (e) {
      appRoot = path.resolve(__dirname, '..', '..', '..');
    }
    this.statsFile = path.join(appRoot, 'statistics.json');
    
    // Contadores de mensagens (serão carregados do banco)
    this.messagesSent = 0;
    this.messagesReceived = 0;
    this.messagesFailed = 0;
    
    // Dispositivos conectados (temporários - não persistem)
    this.devicesConnected = new Map(); // IP -> { lastSeen, connectionType, metadata }
    
    // Conexões por rota (cache em memória, mas persistem no banco)
    this.routeConnections = new Map(); // route -> count
    
    // Requisições por IP (cache em memória, mas persistem no banco)
    this.ipRequests = new Map(); // ip -> count
    
    // Histórico (últimas 24h)
    this.hourlyStats = [];
    
    // Timestamp de inicialização
    this.startTime = Date.now();
    
    // Carrega estatísticas do banco (aguarda banco estar pronto)
    this.loadStatsFromDB();
    
    // Carrega rotas e IPs do banco (aguarda banco estar pronto)
    this.loadRoutesAndIPsFromDB();
    
    // Inicializa histórico
    this.initHourlyStats();
    
    // Salva estatísticas periodicamente (a cada 5 minutos)
    setInterval(() => this.saveStatsToDB(), 5 * 60 * 1000);
    
    // Salva ao encerrar
    process.on('SIGINT', () => this.saveStatsToDB());
    process.on('SIGTERM', () => this.saveStatsToDB());
  }
  
  // Carrega rotas e IPs do banco de dados
  async loadRoutesAndIPsFromDB() {
    const ipBlocker = this.getIpBlocker();
    if (!ipBlocker || !ipBlocker.getAllRoutes || !ipBlocker.getAllIPs) {
      console.warn('[Statistics] Funções getAllRoutes/getAllIPs não disponíveis');
      return;
    }
    
    try {
      // Aguarda banco estar pronto
      if (ipBlocker._promise) {
        await ipBlocker._promise;
      }
      
      // Aguarda um pouco mais para garantir que o banco está totalmente pronto
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Carrega todas as rotas do banco
      const allRoutes = await ipBlocker.getAllRoutes().catch((err) => {
        console.warn('[Statistics] Erro ao carregar rotas:', err.message);
        return [];
      });
      
      // Preenche o Map de rotas com dados do banco
      if (allRoutes && allRoutes.length > 0) {
        allRoutes.forEach(route => {
          if (route.route && route.count) {
            this.routeConnections.set(route.route, route.count);
          }
        });
      }
      
      // Carrega todos os IPs do banco
      const allIPs = await ipBlocker.getAllIPs().catch((err) => {
        console.warn('[Statistics] Erro ao carregar IPs:', err.message);
        return [];
      });
      
      // Preenche o Map de IPs com dados do banco
      if (allIPs && allIPs.length > 0) {
        allIPs.forEach(ipData => {
          if (ipData.ip && ipData.count) {
            this.ipRequests.set(ipData.ip, ipData.count);
          }
        });
      }
      
      console.log('[Statistics] ✅ Rotas e IPs carregados do banco:', {
        rotas: this.routeConnections.size,
        ips: this.ipRequests.size,
        top5Rotas: Array.from(this.routeConnections.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([r, c]) => `${r}:${c}`).join(', '),
        top5IPs: Array.from(this.ipRequests.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([ip, c]) => `${ip}:${c}`).join(', ')
      });
    } catch (error) {
      console.warn('[Statistics] Erro ao carregar rotas/IPs do banco:', error.message);
    }
  }
  
  // Carrega estatísticas do banco de dados
  async loadStatsFromDB() {
    const ipBlocker = this.getIpBlocker();
    if (!ipBlocker || !ipBlocker.loadStatistic) {
      // Fallback para arquivo se banco não estiver disponível
      this.loadStatsFromFile();
      return;
    }
    
    try {
      // Aguarda banco estar pronto
      if (ipBlocker._promise) {
        await ipBlocker._promise;
      }
      
      // Carrega do banco
      const [sent, received, failed] = await Promise.all([
        ipBlocker.loadStatistic('messages_sent'),
        ipBlocker.loadStatistic('messages_received'),
        ipBlocker.loadStatistic('messages_failed')
      ]);
      
      this.messagesSent = sent || 0;
      this.messagesReceived = received || 0;
      this.messagesFailed = failed || 0;
      
      console.log('[Statistics] Estatísticas carregadas do banco:', {
        sent: this.messagesSent,
        received: this.messagesReceived,
        failed: this.messagesFailed
      });
    } catch (error) {
      console.warn('[Statistics] Erro ao carregar do banco, usando arquivo:', error.message);
      this.loadStatsFromFile();
    }
  }
  
  // Carrega estatísticas do arquivo (fallback)
  loadStatsFromFile() {
    try {
      const fs = require('fs');
      if (fs.existsSync(this.statsFile)) {
        const data = JSON.parse(fs.readFileSync(this.statsFile, 'utf8'));
        this.messagesSent = data.messagesSent || 0;
        this.messagesReceived = data.messagesReceived || 0;
        this.messagesFailed = data.messagesFailed || 0;
      }
    } catch (error) {
      console.warn('[Statistics] Erro ao carregar do arquivo:', error.message);
    }
  }
  
  // Salva estatísticas no banco de dados
  async saveStatsToDB() {
    const ipBlocker = this.getIpBlocker();
    if (!ipBlocker || !ipBlocker.saveStatistic) {
      // Fallback para arquivo se banco não estiver disponível
      this.saveStatsToFile();
      return;
    }
    
    try {
      // Salva no banco
      await Promise.all([
        ipBlocker.saveStatistic('messages_sent', this.messagesSent),
        ipBlocker.saveStatistic('messages_received', this.messagesReceived),
        ipBlocker.saveStatistic('messages_failed', this.messagesFailed)
      ]);
      
      console.log('[Statistics] Estatísticas salvas no banco');
    } catch (error) {
      console.warn('[Statistics] Erro ao salvar no banco, usando arquivo:', error.message);
      this.saveStatsToFile();
    }
  }
  
  // Salva estatísticas no arquivo (fallback)
  saveStatsToFile() {
    try {
      const fs = require('fs');
      const path = require('path');
      const dir = path.dirname(this.statsFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.statsFile, JSON.stringify({
        messagesSent: this.messagesSent,
        messagesReceived: this.messagesReceived,
        messagesFailed: this.messagesFailed,
        lastSaved: Date.now()
      }, null, 2));
    } catch (error) {
      console.warn('[Statistics] Erro ao salvar no arquivo:', error.message);
    }
  }
  
  initHourlyStats() {
    // Cria 24 slots (uma hora cada)
    for (let i = 0; i < 24; i++) {
      this.hourlyStats.push({
        hour: i,
        sent: 0,
        received: 0,
        failed: 0,
        devices: 0
      });
    }
  }
  
  // Mensagens
  incrementSent() {
    this.messagesSent++;
    this.updateHourlyStats('sent');
    // Salva no banco (assíncrono, com verificação de banco pronto)
    const ipBlocker = this.getIpBlocker();
    if (ipBlocker && ipBlocker.saveStatistic && ipBlocker._ready && ipBlocker._ready()) {
      ipBlocker.saveStatistic('messages_sent', this.messagesSent).catch((err) => {
        console.warn('[Statistics] Erro ao salvar messages_sent:', err.message);
      });
    }
  }
  
  incrementReceived() {
    this.messagesReceived++;
    this.updateHourlyStats('received');
    // Salva no banco (assíncrono, com verificação de banco pronto)
    const ipBlocker = this.getIpBlocker();
    if (ipBlocker && ipBlocker.saveStatistic && ipBlocker._ready && ipBlocker._ready()) {
      ipBlocker.saveStatistic('messages_received', this.messagesReceived).catch((err) => {
        console.warn('[Statistics] Erro ao salvar messages_received:', err.message);
      });
    }
  }
  
  incrementFailed() {
    this.messagesFailed++;
    this.updateHourlyStats('failed');
    // Salva no banco (assíncrono, com verificação de banco pronto)
    const ipBlocker = this.getIpBlocker();
    if (ipBlocker && ipBlocker.saveStatistic && ipBlocker._ready && ipBlocker._ready()) {
      ipBlocker.saveStatistic('messages_failed', this.messagesFailed).catch((err) => {
        console.warn('[Statistics] Erro ao salvar messages_failed:', err.message);
      });
    }
  }
  
  // Dispositivos
  addDevice(ip, connectionType = 'websocket', metadata = {}) {
    this.devicesConnected.set(ip, {
      ip,
      connectionType,
      lastSeen: Date.now(),
      metadata
    });
  }
  
  updateDeviceLastSeen(ip) {
    const device = this.devicesConnected.get(ip);
    if (device) {
      device.lastSeen = Date.now();
    }
  }
  
  removeDevice(ip) {
    this.devicesConnected.delete(ip);
  }
  
  getActiveDevices() {
    const now = Date.now();
    const timeout = 5 * 60 * 1000; // 5 minutos
    const active = [];
    
    for (const [ip, device] of this.devicesConnected.entries()) {
      if (now - device.lastSeen < timeout) {
        active.push(device);
      }
    }
    
    return active;
  }
  
  // Rotas
  incrementRoute(route) {
    if (!route || route === '') return;
    const current = this.routeConnections.get(route) || 0;
    this.routeConnections.set(route, current + 1);
    
    // Salva no banco (assíncrono, com verificação de banco pronto)
    const ipBlocker = this.getIpBlocker();
    if (ipBlocker && ipBlocker.incrementRouteStat && ipBlocker._ready && ipBlocker._ready()) {
      ipBlocker.incrementRouteStat(route).catch(err => {
        console.warn('[Statistics] Erro ao salvar rota no banco:', err.message);
      });
    }
  }
  
  // Alias para compatibilidade
  incrementRouteRequest(route) {
    this.incrementRoute(route);
  }
  
  // IPs
  incrementIPRequest(ip) {
    if (!ip || ip === 'unknown') return;
    const current = this.ipRequests.get(ip) || 0;
    this.ipRequests.set(ip, current + 1);
    
    // Salva no banco (assíncrono, com verificação de banco pronto)
    const ipBlocker = this.getIpBlocker();
    if (ipBlocker && ipBlocker.incrementIPStat && ipBlocker._ready && ipBlocker._ready()) {
      ipBlocker.incrementIPStat(ip).catch(err => {
        console.warn('[Statistics] Erro ao salvar IP no banco:', err.message);
      });
    }
  }
  
  // Retorna top IPs
  getTopIPs(limit = 5) {
    return Array.from(this.ipRequests.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([ip, count]) => ({ ip, count }));
  }
  
  // Estatísticas horárias
  updateHourlyStats(type) {
    const now = new Date();
    const currentHour = now.getHours();
    const stats = this.hourlyStats[currentHour];
    
    if (stats) {
      if (type === 'sent') stats.sent++;
      else if (type === 'received') stats.received++;
      else if (type === 'failed') stats.failed++;
    }
  }
  
  // Limpa dispositivos inativos
  cleanupInactiveDevices() {
    const now = Date.now();
    const timeout = 30 * 60 * 1000; // 30 minutos
    
    for (const [ip, device] of this.devicesConnected.entries()) {
      if (now - device.lastSeen > timeout) {
        this.devicesConnected.delete(ip);
      }
    }
  }
  
  // Retorna todas as estatísticas
  async getAllStats() {
    const activeDevices = this.getActiveDevices();
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);
    
    // Tenta obter top rotas e IPs do banco
    const ipBlocker = this.getIpBlocker();
    let topRoutes = [];
    let topIPs = [];
    
    if (ipBlocker && ipBlocker.getTopRoutes && ipBlocker.getTopIPs) {
      try {
        [topRoutes, topIPs] = await Promise.all([
          ipBlocker.getTopRoutes(10),
          ipBlocker.getTopIPs(10)
        ]);
      } catch (error) {
        console.warn('[Statistics] Erro ao obter top rotas/IPs do banco, usando cache:', error.message);
        // Fallback para cache em memória
        topRoutes = Array.from(this.routeConnections.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([route, count]) => ({ route, count }));
        topIPs = this.getTopIPs(10);
      }
    } else {
      // Fallback para cache em memória
      topRoutes = Array.from(this.routeConnections.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([route, count]) => ({ route, count }));
      topIPs = this.getTopIPs(10);
    }
    
    // Estatísticas das últimas 24h
    const last24h = {
      sent: this.hourlyStats.reduce((sum, h) => sum + h.sent, 0),
      received: this.hourlyStats.reduce((sum, h) => sum + h.received, 0),
      failed: this.hourlyStats.reduce((sum, h) => sum + h.failed, 0)
    };
    
    return {
      messages: {
        totalSent: this.messagesSent,
        totalReceived: this.messagesReceived,
        totalFailed: this.messagesFailed,
        last24h
      },
      devices: {
        total: this.devicesConnected.size,
        active: activeDevices.length,
        list: activeDevices.map(d => ({
          ip: d.ip,
          connectionType: d.connectionType,
          lastSeen: d.lastSeen,
          metadata: d.metadata
        }))
      },
      routes: {
        total: this.routeConnections.size,
        topRoutes
      },
      topIPs: topIPs,
      system: {
        uptime,
        startTime: this.startTime
      },
      hourly: this.hourlyStats
    };
  }
}

// Singleton
let instance = null;

function getStatisticsModel(getIpBlocker = null) {
  if (!instance) {
    instance = new StatisticsModel(getIpBlocker);
  } else if (getIpBlocker && !instance.getIpBlocker) {
    // Atualiza getter se fornecido
    instance.getIpBlocker = getIpBlocker;
  }
  return instance;
}

module.exports = { StatisticsModel, getStatisticsModel };

