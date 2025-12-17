/**
 * Controller do Dashboard
 * Gerencia lógica do dashboard administrativo
 */

class DashboardController {
  constructor({ statisticsModel, ipBlocker, whatsappOfficial, websocketESP32 }) {
    this.statistics = statisticsModel;
    this.ipBlocker = ipBlocker;
    this.whatsappOfficial = whatsappOfficial;
    this.websocketESP32 = websocketESP32;
  }
  
  /**
   * Obtém todas as estatísticas para o dashboard
   */
  async getDashboardStats() {
    try {
      // Estatísticas do sistema (agora é async)
      const systemStats = await this.statistics.getAllStats();
      
      console.log('[DashboardController] Estatísticas do sistema:', {
        messages: systemStats.messages,
        routes: systemStats.routes,
        topIPs: systemStats.topIPs,
        hourly: systemStats.hourly?.length
      });
      
      // Estatísticas de IPs
      let ipStats = {
        blocked: 0,
        whitelist: 0,
        yellowlist: 0,
        migrations: 0
      };
      
      if (this.ipBlocker) {
        try {
          const [blocked, whitelist, yellowlist, migrations] = await Promise.all([
            this.ipBlocker.countBlockedIPs?.() || Promise.resolve(0),
            this.ipBlocker.countWhitelistIPs?.() || Promise.resolve(0),
            this.ipBlocker.countYellowlistIPs?.() || Promise.resolve(0),
            this.ipBlocker.countMigrationLogs?.() || Promise.resolve(0)
          ]);
          
          ipStats = {
            blocked: Number(blocked) || 0,
            whitelist: Number(whitelist) || 0,
            yellowlist: Number(yellowlist) || 0,
            migrations: Number(migrations) || 0
          };
        } catch (error) {
          console.error('Erro ao obter estatísticas de IPs:', error);
        }
      }
      
      // Status do WhatsApp
      const whatsappStatus = {
        ready: this.whatsappOfficial?.isReady?.() || false,
        phoneNumber: this.whatsappOfficial?.getPhoneNumber?.() || null
      };
      
      // Dispositivos ESP32 conectados (WebSocket)
      let esp32Devices = [];
      if (this.websocketESP32) {
        if (typeof this.websocketESP32.getConnectedDevices === 'function') {
          esp32Devices = this.websocketESP32.getConnectedDevices();
        } else if (this.websocketESP32.getStats) {
          const stats = this.websocketESP32.getStats();
          esp32Devices = stats.connections || [];
        }
      }
      
      // Dispositivos ESP32 via HTTP (do banco de dados)
      let esp32HttpDevices = [];
      if (this.ipBlocker && typeof this.ipBlocker.listESP32Devices === 'function') {
        try {
          esp32HttpDevices = await this.ipBlocker.listESP32Devices(120); // Online se visto nos últimos 2 min
        } catch (e) {
          console.error('Erro ao buscar ESP32 HTTP:', e.message);
        }
      }
      
      // Combina dispositivos WebSocket e HTTP (evita duplicatas por IP)
      const allDevices = [...esp32Devices];
      const wsIPs = new Set(esp32Devices.map(d => d.ip));
      
      for (const httpDevice of esp32HttpDevices) {
        if (!wsIPs.has(httpDevice.ip)) {
          // is_online pode vir como 1, '1', ou true da query SQL
          const isOnline = httpDevice.is_online === 1 || httpDevice.is_online === '1' || httpDevice.is_online === true;
          allDevices.push({
            ip: httpDevice.ip,
            connectedAt: httpDevice.first_seen * 1000,
            lastPing: httpDevice.last_seen * 1000,
            connectionType: 'http',
            isOnline: isOnline,
            requestCount: httpDevice.request_count,
            deviceName: httpDevice.device_name
          });
        }
      }
      
      const result = {
        success: true,
        stats: {
          ...systemStats,
          ips: ipStats,
          whatsapp: whatsappStatus,
          esp32: {
            connected: allDevices.filter(d => d.connectionType === 'websocket' || d.isOnline).length,
            devices: allDevices
          },
          // Mantém compatibilidade com dashboard antigo
          devices: {
            total: allDevices.length,
            online: allDevices.filter(d => d.connectionType === 'websocket' || d.isOnline).length,
            list: allDevices
          }
        }
      };
      
      console.log('[DashboardController] Resultado final:', {
        topIPs: result.stats.topIPs?.length,
        topRoutes: result.stats.routes?.topRoutes?.length,
        messages: result.stats.messages
      });
      
      return result;
    } catch (error) {
      console.error('[DashboardController] Erro:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
}

module.exports = DashboardController;

