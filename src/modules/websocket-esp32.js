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
    perMessageDeflate: false // Desabilita compressão para reduzir latência
  });
  
  log(`[WS-ESP32] Servidor WebSocket inicializado em /ws/esp32`);
  
  // Valida autorização de um cliente
  function validateClient(ws, req) {
    const clientIp = req.socket.remoteAddress || 
                     req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
                     req.socket.address()?.address || 
                     'unknown';
    
    // Verifica IP whitelist
    if (ESP32_ALLOWED_IPS.length > 0) {
      const isAllowed = ESP32_ALLOWED_IPS.some(allowedIp => {
        if (allowedIp.includes('/')) {
          // CIDR - implementação simples
          return clientIp.startsWith(allowedIp.split('/')[0]);
        }
        return clientIp === allowedIp;
      });
      
      if (!isAllowed) {
        warn(`[WS-ESP32] IP não autorizado: ${clientIp}`);
        return { authorized: false, reason: 'IP não autorizado', ip: clientIp };
      }
    }
    
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
    const validation = validateClient(ws, req);
    
    if (!validation.authorized) {
      warn(`[WS-ESP32] Conexão rejeitada: ${validation.reason}`);
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

