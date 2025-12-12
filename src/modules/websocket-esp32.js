/**
 * Módulo WebSocket para comunicação com ESP32
 * 
 * Substitui HTTP por WebSocket para comunicação mais rápida e eficiente
 * Mantém conexão persistente, reduzindo latência e overhead
 */

const WebSocket = require('ws');

/**
 * Inicializa o módulo WebSocket para ESP32
 * 
 * @param {Object} config - Configurações do módulo
 * @param {Object} config.server - Servidor HTTP (para anexar WebSocket)
 * @param {Object} config.logger - Logger (log, dbg, warn, err)
 * @param {Function} config.validateESP32Authorization - Função de validação ESP32
 * @param {Function} config.triggerSnapshot - Função para disparar snapshot
 * @param {Function} config.checkApiStatus - Função para verificar status da API
 * @param {string} config.ESP32_TOKEN - Token de autenticação ESP32
 * @param {Array<string>} config.ESP32_ALLOWED_IPS - IPs permitidos para ESP32
 * @returns {Object} Objeto com funções de controle
 */
function initWebSocketESP32Module({
  server,
  logger,
  validateESP32Authorization,
  triggerSnapshot,
  checkApiStatus,
  ESP32_TOKEN,
  ESP32_ALLOWED_IPS = []
}) {
  const { log, dbg, warn, err } = logger;
  
  if (!server) {
    throw new Error('Servidor HTTP não fornecido para WebSocket');
  }
  
  // Armazena conexões ativas por IP
  const activeConnections = new Map(); // IP -> { ws, lastPing, authenticated }
  
  // Cria servidor WebSocket anexado ao servidor HTTP
  const wss = new WebSocket.Server({ 
    server,
    path: '/ws/esp32',
    perMessageDeflate: false, // Desabilita compressão para reduzir latência
    verifyClient: (info) => {
      // Log da tentativa de conexão
      const rawIp = info.origin || info.req?.socket?.remoteAddress || 'unknown';
      const normalizedIp = normalizeIp(rawIp);
      log(`[WS-ESP32] 🔌 Tentativa de conexão WebSocket de ${normalizedIp} (raw: ${rawIp})`);
      
      // Permite a conexão - validação será feita no handler de conexão
      return true;
    }
  });
  
  log(`[WS-ESP32] ✅ Servidor WebSocket inicializado em /ws/esp32`);
  log(`[WS-ESP32] ✅ Server disponível: ${server ? 'sim' : 'não'}`);
  log(`[WS-ESP32] ✅ Path: /ws/esp32`);
  
  // Normaliza IP (remove prefixo IPv6 mapeado para IPv4)
  function normalizeIp(ipAddress) {
    if (!ipAddress) return ipAddress;
    // Remove prefixo IPv6 mapeado para IPv4 (::ffff:)
    if (ipAddress.startsWith('::ffff:')) {
      return ipAddress.substring(7);
    }
    return ipAddress;
  }
  
  // Verifica se IP está em CIDR
  function ipInCidr(ipAddress, cidr) {
    const [network, prefixStr] = cidr.split('/');
    const prefixLength = parseInt(prefixStr, 10);
    
    if (isNaN(prefixLength) || prefixLength < 0 || prefixLength > 32) {
      return false;
    }
    
    const networkParts = network.split('.').map(Number);
    const ipParts = ipAddress.split('.').map(Number);
    
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
  
  // Valida autorização de um cliente
  function validateClient(ws, req) {
    const rawClientIp = req.socket.remoteAddress || 
                        req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
                        req.socket.address()?.address || 
                        'unknown';
    
    // Normaliza IP (remove prefixo IPv6 mapeado)
    const clientIp = normalizeIp(rawClientIp);
    
    dbg(`[WS-ESP32] IP recebido: ${rawClientIp} -> normalizado: ${clientIp}`);
    
    // Verifica IP whitelist
    if (ESP32_ALLOWED_IPS.length > 0) {
      dbg(`[WS-ESP32] Verificando IP ${clientIp} contra whitelist: ${ESP32_ALLOWED_IPS.join(', ')}`);
      
      const isAllowed = ESP32_ALLOWED_IPS.some(allowedIp => {
        // Normaliza IP permitido também
        const normalizedAllowedIp = normalizeIp(allowedIp);
        
        if (allowedIp.includes('/')) {
          // CIDR - usa função completa
          const inCidr = ipInCidr(clientIp, allowedIp);
          dbg(`[WS-ESP32] Verificando CIDR: ${clientIp} em ${allowedIp} = ${inCidr}`);
          return inCidr;
        }
        // Compara IPs normalizados
        const matches = clientIp === normalizedAllowedIp;
        dbg(`[WS-ESP32] Comparando: ${clientIp} === ${normalizedAllowedIp} = ${matches}`);
        return matches;
      });
      
      if (!isAllowed) {
        warn(`[WS-ESP32] IP não autorizado: ${rawClientIp} (normalizado: ${clientIp})`);
        warn(`[WS-ESP32] IPs permitidos: ${ESP32_ALLOWED_IPS.join(', ')}`);
        return { authorized: false, reason: 'IP não autorizado', ip: clientIp };
      }
      
      log(`[WS-ESP32] IP autorizado: ${clientIp} (match com whitelist)`);
    }
    
    log(`[WS-ESP32] IP autorizado: ${clientIp}`);
    
    // Token será validado na primeira mensagem
    return { authorized: true, ip: clientIp };
  }
  
  // Envia mensagem para cliente
  function sendToClient(ws, type, data = {}) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type, ...data, timestamp: Date.now() }));
        return true;
      } catch (e) {
        err(`[WS-ESP32] Erro ao enviar mensagem:`, e.message);
        return false;
      }
    }
    return false;
  }
  
  // Processa mensagens recebidas
  async function handleMessage(ws, connection, message) {
    try {
      const data = JSON.parse(message);
      const { type, token, ...payload } = data;
      
      dbg(`[WS-ESP32] Mensagem recebida: ${type} de ${connection.ip}`);
      
      // Autenticação na primeira mensagem
      if (!connection.authenticated) {
        if (type !== 'auth') {
          sendToClient(ws, 'error', { message: 'Autenticação necessária' });
          ws.close(1008, 'Não autenticado');
          return;
        }
        
        // Valida token
        if (ESP32_TOKEN && token !== ESP32_TOKEN) {
          warn(`[WS-ESP32] Token inválido de ${connection.ip}`);
          sendToClient(ws, 'error', { message: 'Token inválido' });
          ws.close(1008, 'Token inválido');
          return;
        }
        
        connection.authenticated = true;
        connection.authenticatedAt = Date.now();
        sendToClient(ws, 'auth_success', { message: 'Autenticado com sucesso' });
        log(`[WS-ESP32] Cliente autenticado: ${connection.ip}`);
        return;
      }
      
      // Processa mensagens autenticadas
      switch (type) {
        case 'ping':
          connection.lastPing = Date.now();
          // Atualiza estatística de dispositivo
          if (global.statisticsModel) {
            global.statisticsModel.updateDeviceLastSeen(connection.ip);
          }
          sendToClient(ws, 'pong');
          break;
          
        case 'check_status':
          try {
            const isReady = await checkApiStatus();
            sendToClient(ws, 'status', { 
              ready: isReady,
              timestamp: Date.now()
            });
          } catch (e) {
            err(`[WS-ESP32] Erro ao verificar status:`, e.message);
            sendToClient(ws, 'status', { 
              ready: false,
              error: e.message,
              timestamp: Date.now()
            });
          }
          break;
          
        case 'trigger_snapshot':
          try {
            const message = payload.message || '*Campainha Tocando*';
            dbg(`[WS-ESP32] Disparando snapshot de ${connection.ip}`);
            
            // Dispara snapshot de forma assíncrona
            triggerSnapshot(message, connection.ip)
              .then(result => {
                if (result && result.ok) {
                  sendToClient(ws, 'snapshot_result', { 
                    success: true,
                    message: 'Snapshot enviado com sucesso'
                  });
                } else {
                  sendToClient(ws, 'snapshot_result', { 
                    success: false,
                    error: result?.error || 'Erro desconhecido'
                  });
                }
              })
              .catch(error => {
                err(`[WS-ESP32] Erro ao processar snapshot:`, error.message);
                sendToClient(ws, 'snapshot_result', { 
                  success: false,
                  error: error.message
                });
              });
            
            // Resposta imediata (processamento é assíncrono)
            sendToClient(ws, 'snapshot_ack', { 
              message: 'Snapshot em processamento'
            });
          } catch (e) {
            err(`[WS-ESP32] Erro ao processar trigger:`, e.message);
            sendToClient(ws, 'error', { message: e.message });
          }
          break;
          
        default:
          warn(`[WS-ESP32] Tipo de mensagem desconhecido: ${type}`);
          sendToClient(ws, 'error', { message: `Tipo desconhecido: ${type}` });
      }
    } catch (e) {
      err(`[WS-ESP32] Erro ao processar mensagem:`, e.message);
      sendToClient(ws, 'error', { message: 'Erro ao processar mensagem' });
    }
  }
  
  // Gerencia conexões
  wss.on('connection', (ws, req) => {
    log(`[WS-ESP32] 🔌 Nova tentativa de conexão WebSocket recebida`);
    const validation = validateClient(ws, req);
    
    log(`[WS-ESP32] 🔍 Validação: authorized=${validation.authorized}, reason=${validation.reason}, ip=${validation.ip}`);
    
    if (!validation.authorized) {
      warn(`[WS-ESP32] ❌ Conexão rejeitada: ${validation.reason}`);
      warn(`[WS-ESP32] ❌ IP: ${validation.ip}`);
      ws.close(1008, validation.reason);
      return;
    }
    
    const connection = {
      ws,
      ip: validation.ip,
      connectedAt: Date.now(),
      lastPing: Date.now(),
      authenticated: false,
      authenticatedAt: null
    };
    
    activeConnections.set(validation.ip, connection);
    log(`[WS-ESP32] Nova conexão de ${validation.ip} (total: ${activeConnections.size})`);
    
    // Adiciona dispositivo nas estatísticas
    if (global.statisticsModel) {
      global.statisticsModel.addDevice(validation.ip, 'websocket', {
        connectedAt: connection.connectedAt
      });
    }
    
    // Envia mensagem de boas-vindas
    sendToClient(ws, 'connected', { 
      message: 'Conectado ao servidor WebSocket',
      requiresAuth: !!ESP32_TOKEN
    });
    
    // Processa mensagens
    ws.on('message', (message) => {
      handleMessage(ws, connection, message.toString());
    });
    
    // Gerencia desconexão
    ws.on('close', (code, reason) => {
      activeConnections.delete(validation.ip);
      // Remove dispositivo das estatísticas
      if (global.statisticsModel) {
        global.statisticsModel.removeDevice(validation.ip);
      }
      log(`[WS-ESP32] Conexão fechada: ${validation.ip} (code: ${code}, reason: ${reason.toString()})`);
    });
    
    // Gerencia erros
    ws.on('error', (error) => {
      err(`[WS-ESP32] Erro na conexão ${validation.ip}:`, error.message);
    });
    
    // Ping automático a cada 30 segundos
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        connection.lastPing = Date.now();
        sendToClient(ws, 'ping');
      } else {
        clearInterval(pingInterval);
      }
    }, 30000);
    
    ws.on('close', () => {
      clearInterval(pingInterval);
    });
  });
  
  // Limpa conexões inativas (mais de 5 minutos sem ping)
  setInterval(() => {
    const now = Date.now();
    const timeout = 5 * 60 * 1000; // 5 minutos
    
    for (const [ip, conn] of activeConnections.entries()) {
      if (now - conn.lastPing > timeout) {
        warn(`[WS-ESP32] Fechando conexão inativa: ${ip}`);
        if (conn.ws.readyState === WebSocket.OPEN) {
          conn.ws.close(1000, 'Timeout');
        }
        activeConnections.delete(ip);
      }
    }
  }, 60000); // Verifica a cada 1 minuto
  
  return {
    // Retorna estatísticas
    getStats: () => {
      return {
        totalConnections: activeConnections.size,
        authenticatedConnections: Array.from(activeConnections.values())
          .filter(c => c.authenticated).length,
        connections: Array.from(activeConnections.values()).map(c => ({
          ip: c.ip,
          connectedAt: c.connectedAt,
          authenticated: c.authenticated,
          lastPing: c.lastPing
        }))
      };
    },
    
    // Retorna lista de dispositivos conectados
    getConnectedDevices: () => {
      return Array.from(activeConnections.values())
        .filter(c => c.authenticated)
        .map(c => ({
          ip: c.ip,
          connectedAt: c.connectedAt,
          lastPing: c.lastPing,
          connectionType: 'websocket'
        }));
    },
    
    // Fecha todas as conexões
    close: () => {
      log(`[WS-ESP32] Fechando todas as conexões...`);
      for (const [ip, conn] of activeConnections.entries()) {
        if (conn.ws.readyState === WebSocket.OPEN) {
          conn.ws.close(1000, 'Servidor encerrando');
        }
      }
      activeConnections.clear();
      wss.close();
      log(`[WS-ESP32] Servidor WebSocket fechado`);
    }
  };
}

module.exports = { initWebSocketESP32Module };

