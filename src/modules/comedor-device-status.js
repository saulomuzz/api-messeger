/**
 * Módulo Comedor Device Status
 * Gerencia status e histórico de dispositivos ESP32 do comedor
 */

const fs = require('fs');
const path = require('path');

/**
 * Inicializa o módulo de status de dispositivos
 * @param {Object} config - Configuração do módulo
 * @param {Object} config.logger - Objeto com funções de log
 * @param {string} config.dataDir - Diretório para armazenar dados
 * @returns {Object} API do módulo
 */
function initComedorDeviceStatusModule({
  logger,
  dataDir
}) {
  const { log, dbg, warn, err, nowISO } = logger;
  
  const DEVICES_DB_FILE = path.join(dataDir || path.join(__dirname, '..', '..', 'data'), 'comedor-devices.json');
  const TOKEN_CONFIG_FILE = path.join(dataDir || path.join(__dirname, '..', '..', 'data'), 'comedor-token.json');
  
  // Garante que o diretório existe
  const ensureDataDir = () => {
    const dir = path.dirname(DEVICES_DB_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      log(`[COMEDOR-DEVICE] Diretório de dados criado: ${dir}`);
    }
  };
  
  // Carrega banco de dados de dispositivos
  function loadDevicesDB() {
    try {
      ensureDataDir();
      if (fs.existsSync(DEVICES_DB_FILE)) {
        const data = fs.readFileSync(DEVICES_DB_FILE, 'utf8');
        return JSON.parse(data);
      }
    } catch (e) {
      warn(`[COMEDOR-DEVICE] Erro ao carregar DB:`, e.message);
    }
    return {};
  }
  
  // Salva banco de dados de dispositivos
  function saveDevicesDB(db) {
    try {
      ensureDataDir();
      fs.writeFileSync(DEVICES_DB_FILE, JSON.stringify(db, null, 2), 'utf8');
    } catch (e) {
      err(`[COMEDOR-DEVICE] Erro ao salvar DB:`, e.message);
    }
  }
  
  // Carrega configuração de token
  function loadTokenConfig() {
    try {
      ensureDataDir();
      if (fs.existsSync(TOKEN_CONFIG_FILE)) {
        const data = fs.readFileSync(TOKEN_CONFIG_FILE, 'utf8');
        return JSON.parse(data);
      }
    } catch (e) {
      warn(`[COMEDOR-DEVICE] Erro ao carregar token config:`, e.message);
    }
    return { token: null, updatedAt: null };
  }
  
  // Salva configuração de token
  function saveTokenConfig(config) {
    try {
      ensureDataDir();
      fs.writeFileSync(TOKEN_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
      log(`[COMEDOR-DEVICE] Token configurado e salvo`);
    } catch (e) {
      err(`[COMEDOR-DEVICE] Erro ao salvar token config:`, e.message);
    }
  }
  
  /**
   * Registra uma tentativa de conexão de um dispositivo (mesmo se autenticação falhar)
   * Isso permite que dispositivos apareçam na lista como "não adotados"
   * @param {string} deviceIp - IP do dispositivo
   * @param {string} deviceId - MAC Address do dispositivo (opcional)
   * @returns {Object} Dados do dispositivo
   */
  function registerDeviceAttempt(deviceIp, deviceId = null) {
    const db = loadDevicesDB();
    const now = Date.now();
    
    // Se deviceId foi fornecido, usar como chave principal (mais seguro)
    const key = deviceId || deviceIp;
    
    if (!db[key]) {
      db[key] = {
        deviceId: deviceId || null,
        ip: deviceIp,
        firstSeen: now,
        lastSeen: now,
        notificationCount: 0,
        lastNotification: null,
        notifications: [],
        adopted: false,  // Dispositivo adotado/autorizado
        adoptedAt: null,  // Data/hora da adoção
        ipHistory: [deviceIp],  // Histórico de IPs (para detectar mudanças)
        config: null  // Configurações do dispositivo (stepperDirection, scaleZeroTolerance, etc)
      };
      log(`[COMEDOR-DEVICE] Novo dispositivo detectado: ${deviceId || deviceIp} (IP: ${deviceIp}, não adotado)`);
    } else {
      const device = db[key];
      // Atualiza última tentativa de conexão
      device.lastSeen = now;
      // Atualiza IP se mudou
      if (device.ip !== deviceIp && !device.ipHistory.includes(deviceIp)) {
        warn(`[COMEDOR-DEVICE] IP mudou para ${device.ip} -> ${deviceIp} (deviceId: ${deviceId || 'N/A'})`);
        device.ip = deviceIp;
        device.ipHistory.push(deviceIp);
        // Manter apenas últimos 5 IPs
        if (device.ipHistory.length > 5) {
          device.ipHistory = device.ipHistory.slice(-5);
        }
      }
      // Se deviceId estava null e agora temos, atualizar
      if (!device.deviceId && deviceId) {
        device.deviceId = deviceId;
      }
    }
    
    saveDevicesDB(db);
    
    return db[key];
  }
  
  /**
   * Registra uma notificação de um dispositivo
   * @param {string} deviceIp - IP do dispositivo
   * @param {Object} notificationData - Dados da notificação (deve conter deviceId)
   * @returns {Object} Dados do dispositivo atualizados
   */
  function registerNotification(deviceIp, notificationData) {
    const db = loadDevicesDB();
    const now = Date.now();
    
    // Extrair deviceId da notificação (MAC address)
    const deviceId = notificationData.deviceId || notificationData.device_id || null;
    
    // Usar deviceId como chave principal se disponível, senão usar IP (compatibilidade)
    const key = deviceId || deviceIp;
    
    if (!db[key]) {
      db[key] = {
        deviceId: deviceId,
        ip: deviceIp,
        firstSeen: now,
        lastSeen: now,
        notificationCount: 0,
        lastNotification: null,
        notifications: [],
        adopted: false,  // Dispositivo adotado/autorizado
        adoptedAt: null,  // Data/hora da adoção
        ipHistory: [deviceIp],  // Histórico de IPs
        config: null  // Configurações do dispositivo
      };
      log(`[COMEDOR-DEVICE] Novo dispositivo registrado: ${deviceId || deviceIp} (IP: ${deviceIp})`);
    } else {
      const device = db[key];
      
      // VALIDAÇÃO ANTI-CLONAGEM: Verificar se deviceId corresponde
      if (deviceId && device.deviceId && device.deviceId !== deviceId) {
        err(`[COMEDOR-DEVICE] ⚠️ ALERTA: Tentativa de clonagem detectada!`);
        err(`[COMEDOR-DEVICE] DeviceId registrado: ${device.deviceId}, Recebido: ${deviceId}`);
        err(`[COMEDOR-DEVICE] IP registrado: ${device.ip}, IP atual: ${deviceIp}`);
        // Rejeitar e registrar como tentativa suspeita
        return null;
      }
      
      // VALIDAÇÃO: Se já temos deviceId mas está tentando com IP diferente
      if (device.deviceId && device.ip !== deviceIp) {
        warn(`[COMEDOR-DEVICE] IP mudou: ${device.ip} -> ${deviceIp} (deviceId: ${device.deviceId})`);
        if (!device.ipHistory) {
          device.ipHistory = [device.ip];
        }
        if (!device.ipHistory.includes(deviceIp)) {
          device.ipHistory.push(deviceIp);
          // Manter apenas últimos 5 IPs
          if (device.ipHistory.length > 5) {
            device.ipHistory = device.ipHistory.slice(-5);
          }
        }
        device.ip = deviceIp;  // Atualizar IP atual
      }
      
      // Se deviceId estava null e agora temos, atualizar
      if (!device.deviceId && deviceId) {
        device.deviceId = deviceId;
      }
    }
    
    const device = db[key];
    device.lastSeen = now;
    device.notificationCount = (device.notificationCount || 0) + 1;
    device.lastNotification = {
      type: notificationData.type,
      timestamp: notificationData.timestamp || Math.floor(now / 1000),
      data: notificationData,
      receivedAt: nowISO()
    };
    
    // Mantém apenas as últimas 50 notificações
    if (!device.notifications) {
      device.notifications = [];
    }
    device.notifications.unshift({
      type: notificationData.type,
      timestamp: notificationData.timestamp || Math.floor(now / 1000),
      data: notificationData,
      receivedAt: nowISO()
    });
    
    if (device.notifications.length > 50) {
      device.notifications = device.notifications.slice(0, 50);
    }
    
    // Se notificação contém dados de configuração, armazenar
    // Lista de campos de configuração que podem vir nas notificações
    const configFields = [
      'stepperSpeed', 'stepperDirection', 'stepperStepsForward', 'stepperBackoffSteps',
      'servoTimeA', 'servoTimeB', 'servoSpeed', 'servoSpeedA', 'servoSpeedB', 'servoUseHome',
      'scaleOffset', 'scaleFactor', 'weightTolerance', 'scaleZeroTolerance',
      'defaultFeedAmountA', 'defaultFeedAmountB', 'fallbackInterval',
      'reservoirEmptyCm', 'reservoirFullCm',
      'debugEnabled', 'debugLevelSensor',
      'animalType', 'animalAName', 'animalBName', 'apiNotificationUrl', 'apiNotificationUseSSL'
    ];
    
    const hasConfig = configFields.some(field => notificationData[field] !== undefined) ||
        (notificationData.config && typeof notificationData.config === 'object');
    
    if (hasConfig) {
      if (!device.config) {
        device.config = {};
      }
      
      // Atualizar campos individuais
      configFields.forEach(field => {
        if (notificationData[field] !== undefined) {
          device.config[field] = notificationData[field];
        }
      });
      
      // Se notificação tem objeto config, mesclar (tem prioridade sobre campos individuais)
      if (notificationData.config && typeof notificationData.config === 'object') {
        Object.assign(device.config, notificationData.config);
      }
      
      // Sincronizar weightTolerance e scaleZeroTolerance
      if (device.config.weightTolerance !== undefined && device.config.scaleZeroTolerance === undefined) {
        device.config.scaleZeroTolerance = device.config.weightTolerance;
      }
      if (device.config.scaleZeroTolerance !== undefined && device.config.weightTolerance === undefined) {
        device.config.weightTolerance = device.config.scaleZeroTolerance;
      }
    }
    
    saveDevicesDB(db);
    
    dbg(`[COMEDOR-DEVICE] Notificação registrada para ${deviceId || deviceIp} (IP: ${deviceIp}): ${notificationData.type}`);
    
    return device;
  }
  
  /**
   * Busca dispositivo por deviceId ou IP (para compatibilidade)
   * @param {string} deviceId - MAC Address do dispositivo
   * @param {string} deviceIp - IP do dispositivo (opcional, para busca alternativa)
   * @returns {Object|null} Dados do dispositivo ou null se não encontrado
   */
  function findDevice(deviceId, deviceIp = null) {
    const db = loadDevicesDB();
    
    // Primeiro tenta por deviceId (chave principal)
    if (deviceId && db[deviceId]) {
      return { key: deviceId, device: db[deviceId] };
    }
    
    // Se não encontrou por deviceId, tenta por IP (compatibilidade com dados antigos)
    if (deviceIp && db[deviceIp]) {
      return { key: deviceIp, device: db[deviceIp] };
    }
    
    // Busca por IP em todos os dispositivos (caso deviceId seja a chave mas IP mudou)
    if (deviceIp) {
      for (const [key, device] of Object.entries(db)) {
        if (device.ip === deviceIp) {
          return { key, device };
        }
      }
    }
    
    return null;
  }
  
  /**
   * Obtém status de um dispositivo específico
   * @param {string} identifier - IP ou deviceId do dispositivo
   * @param {string} deviceId - deviceId específico (opcional, tem prioridade)
   * @returns {Object|null} Dados do dispositivo ou null se não encontrado
   */
  function getDeviceStatus(identifier, deviceId = null) {
    const found = findDevice(deviceId || identifier, deviceId ? identifier : null);
    
    if (!found) {
      return null;
    }
    
    // Usar diretamente do banco para garantir que temos os dados mais atualizados
    const db = loadDevicesDB();
    const device = db[found.key] || found.device;
    const now = Date.now();
    const lastSeenMs = now - device.lastSeen;
    const lastSeenSeconds = Math.floor(lastSeenMs / 1000);
    const lastSeenMinutes = Math.floor(lastSeenSeconds / 60);
    const lastSeenHours = Math.floor(lastSeenMinutes / 60);
    
    let lastSeenText = '';
    if (lastSeenSeconds < 60) {
      lastSeenText = `${lastSeenSeconds} segundos atrás`;
    } else if (lastSeenMinutes < 60) {
      lastSeenText = `${lastSeenMinutes} minuto(s) atrás`;
    } else if (lastSeenHours < 24) {
      lastSeenText = `${lastSeenHours} hora(s) atrás`;
    } else {
      const days = Math.floor(lastSeenHours / 24);
      lastSeenText = `${days} dia(s) atrás`;
    }
    
    return {
      ...device,
      lastSeenText,
      lastSeenSeconds,
      isOnline: lastSeenSeconds < 300, // Considera online se viu nos últimos 5 minutos
      firstSeenISO: new Date(device.firstSeen).toISOString(),
      lastSeenISO: new Date(device.lastSeen).toISOString(),
      adopted: device.adopted || false,
      adoptedAt: device.adoptedAt || null,
      adoptedAtISO: device.adoptedAt ? new Date(device.adoptedAt).toISOString() : null,
      ipHistory: device.ipHistory || [],
      config: device.config || {},  // Incluir configurações (sempre objeto, nunca null)
      schedules: (device.config && device.config.schedules) ? device.config.schedules : [] // Incluir horários
    };
  }
  
  /**
   * Lista todos os dispositivos
   * @returns {Array} Lista de dispositivos
   */
  function listDevices() {
    const db = loadDevicesDB();
    const devices = [];
    
    for (const [key, device] of Object.entries(db)) {
      // Usar deviceId como identificador se disponível, senão usar a chave
      // Isso garante que sempre buscamos o dispositivo correto
      const identifier = device.deviceId || key;
      const deviceId = device.deviceId || null;
      
      // Para garantir que pegamos os dados mais atualizados, usar diretamente do db
      // mas aplicar formatação do getDeviceStatus
      const deviceData = device;
      const now = Date.now();
      const lastSeenMs = now - deviceData.lastSeen;
      const lastSeenSeconds = Math.floor(lastSeenMs / 1000);
      const lastSeenMinutes = Math.floor(lastSeenSeconds / 60);
      const lastSeenHours = Math.floor(lastSeenMinutes / 60);
      
      let lastSeenText = '';
      if (lastSeenSeconds < 60) {
        lastSeenText = `${lastSeenSeconds} segundos atrás`;
      } else if (lastSeenMinutes < 60) {
        lastSeenText = `${lastSeenMinutes} minuto(s) atrás`;
      } else if (lastSeenHours < 24) {
        lastSeenText = `${lastSeenHours} hora(s) atrás`;
      } else {
        const days = Math.floor(lastSeenHours / 24);
        lastSeenText = `${days} dia(s) atrás`;
      }
      
      devices.push({
        ...deviceData,
        lastSeenText,
        lastSeenSeconds,
        isOnline: lastSeenSeconds < 300,
        firstSeenISO: new Date(deviceData.firstSeen).toISOString(),
        lastSeenISO: new Date(deviceData.lastSeen).toISOString(),
        adopted: deviceData.adopted || false,
        adoptedAt: deviceData.adoptedAt || null,
        adoptedAtISO: deviceData.adoptedAt ? new Date(deviceData.adoptedAt).toISOString() : null,
        ipHistory: deviceData.ipHistory || [],
        config: deviceData.config || {},
        schedules: (deviceData.config && deviceData.config.schedules) ? deviceData.config.schedules : []
      });
    }
    
    // Ordena por última atividade (mais recente primeiro)
    devices.sort((a, b) => b.lastSeen - a.lastSeen);
    
    return devices;
  }
  
  /**
   * Obtém token configurado
   * @returns {string|null} Token ou null se não configurado
   */
  function getToken() {
    const config = loadTokenConfig();
    return config.token || null;
  }
  
  /**
   * Configura token
   * @param {string} token - Token a ser configurado
   * @returns {boolean} true se configurado com sucesso
   */
  function setToken(token) {
    if (!token || typeof token !== 'string' || token.trim().length === 0) {
      return false;
    }
    
    const config = {
      token: token.trim(),
      updatedAt: nowISO()
    };
    
    saveTokenConfig(config);
    return true;
  }
  
  /**
   * Verifica se um token é válido ou se o dispositivo está adotado
   * @param {string} token - Token a verificar
   * @param {string} deviceIp - IP do dispositivo
   * @param {string} deviceId - MAC Address do dispositivo (opcional, tem prioridade)
   * @returns {boolean} true se válido ou dispositivo adotado
   */
  function validateToken(token, deviceIp = null, deviceId = null) {
    // Se dispositivo está adotado, permite sem token
    if (deviceId || deviceIp) {
      const device = getDeviceStatus(deviceId || deviceIp, deviceId);
      if (device && device.adopted) {
        return true;
      }
    }
    
    const configuredToken = getToken();
    if (!configuredToken) {
      return false; // Se não há token configurado e dispositivo não está adotado, requer token
    }
    return token === configuredToken;
  }
  
  /**
   * Adota um dispositivo (autoriza sem token)
   * @param {string} identifier - IP ou deviceId do dispositivo
   * @param {string} deviceId - deviceId específico (opcional, tem prioridade)
   * @returns {boolean} true se adotado com sucesso
   */
  function adoptDevice(identifier, deviceId = null) {
    const db = loadDevicesDB();
    let found = findDevice(deviceId || identifier, deviceId ? identifier : null);
    
    // Se encontrou mas está usando a chave errada (IP em vez de deviceId), precisamos migrar
    if (found && deviceId && found.key !== deviceId) {
      // Dispositivo existe mas está usando IP como chave, precisamos migrar para deviceId
      const oldKey = found.key;
      const device = found.device;
      
      // Criar nova entrada com deviceId como chave
      db[deviceId] = {
        ...device,
        deviceId: deviceId,
        ip: device.ip || identifier,
        adopted: true,
        adoptedAt: Date.now()
      };
      
      // Remover entrada antiga
      delete db[oldKey];
      
      saveDevicesDB(db);
      log(`[COMEDOR-DEVICE] Dispositivo migrado de chave ${oldKey} para ${deviceId} e adotado`);
      return true;
    } else if (!found) {
      // Cria dispositivo se não existir
      const key = deviceId || identifier;
      db[key] = {
        deviceId: deviceId || null,
        ip: identifier,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        notificationCount: 0,
        lastNotification: null,
        notifications: [],
        adopted: true,
        adoptedAt: Date.now(),
        ipHistory: [identifier],
        config: {}
      };
      
      saveDevicesDB(db);
      log(`[COMEDOR-DEVICE] Novo dispositivo criado e adotado: ${deviceId || identifier} (IP: ${identifier})`);
      return true;
    }
    
    // Dispositivo encontrado, atualizar estado
    const device = db[found.key]; // Garantir que estamos editando o objeto correto do banco
    device.adopted = true;
    device.adoptedAt = Date.now();
    
    // Garantir que deviceId está correto
    if (deviceId && device.deviceId !== deviceId) {
      device.deviceId = deviceId;
    }
    
    saveDevicesDB(db);
    log(`[COMEDOR-DEVICE] Dispositivo ${device.deviceId || identifier} (IP: ${device.ip}) adotado/autorizado - adopted=${device.adopted}`);
    
    // Verificação de debug
    const verify = loadDevicesDB();
    const verifyDevice = verify[found.key] || (deviceId ? verify[deviceId] : null) || (identifier ? verify[identifier] : null);
    if (verifyDevice) {
      log(`[COMEDOR-DEVICE] Verificação pós-adoção: adopted=${verifyDevice.adopted}, deviceId=${verifyDevice.deviceId}, ip=${verifyDevice.ip}`);
    }
    
    return true;
  }
  
  /**
   * Remove adoção de um dispositivo (requer token novamente)
   * @param {string} identifier - IP ou deviceId do dispositivo
   * @param {string} deviceId - deviceId específico (opcional, tem prioridade)
   * @returns {boolean} true se removido com sucesso
   */
  function unadoptDevice(identifier, deviceId = null) {
    const db = loadDevicesDB();
    const found = findDevice(deviceId || identifier, deviceId ? identifier : null);
    
    if (!found) {
      return false;
    }
    
    const device = found.device;
    device.adopted = false;
    device.adoptedAt = null;
    
    saveDevicesDB(db);
    log(`[COMEDOR-DEVICE] Adoção removida do dispositivo ${device.deviceId || identifier} (IP: ${device.ip})`);
    
    return true;
  }
  
  /**
   * Atualiza configurações de um dispositivo
   * @param {string} identifier - IP ou deviceId do dispositivo
   * @param {string} deviceId - deviceId específico (opcional, tem prioridade)
   * @param {Object} config - Objeto com configurações do dispositivo
   * @returns {boolean} true se atualizado com sucesso
   */
  function updateDeviceConfig(identifier, deviceId = null, config = {}) {
    const db = loadDevicesDB();
    const found = findDevice(deviceId || identifier, deviceId ? identifier : null);
    
    if (!found) {
      return false;
    }
    
    // Garantir que estamos editando o objeto correto do banco
    const device = db[found.key];
    if (!device.config) {
      device.config = {};
    }
    
    // Lista de todas as configurações possíveis
    const configFields = [
      // Stepper
      'stepperSpeed', 'stepperDirection', 'stepperStepsForward', 'stepperBackoffSteps',
      // Servo
      'servoTimeA', 'servoTimeB', 'servoSpeed', 'servoSpeedA', 'servoSpeedB', 'servoUseHome',
      // Balança
      'scaleOffset', 'scaleFactor', 'weightTolerance', 'scaleZeroTolerance',
      // Alimentação
      'defaultFeedAmountA', 'defaultFeedAmountB', 'fallbackInterval',
      // Reservatório
      'reservoirEmptyCm', 'reservoirFullCm',
      // Debug
      'debugEnabled', 'debugLevelSensor',
      // Animais e Notificações
      'animalType', 'animalAName', 'animalBName', 'apiNotificationUrl', 'apiNotificationUseSSL',
      // Horários
      'schedules'
    ];
    
    // Atualizar apenas campos fornecidos
    configFields.forEach(field => {
      if (config[field] !== undefined) {
        // Tratamento especial para schedules (array)
        if (field === 'schedules' && Array.isArray(config[field])) {
          device.config[field] = config[field];
        } else if (field !== 'schedules') {
          // Salvar o valor diretamente (inclui null, false, 0, '', etc.)
          device.config[field] = config[field];
        }
      }
    });
    
    // Além dos campos na lista, processar campos adicionais que possam ter vindo
    // (garante que campos não listados também sejam salvos)
    Object.keys(config).forEach(field => {
      if (!configFields.includes(field) && config[field] !== undefined) {
        device.config[field] = config[field];
      }
    });
    
    // Se scaleZeroTolerance foi atualizado mas weightTolerance não, sincronizar
    if (config.scaleZeroTolerance !== undefined && config.weightTolerance === undefined) {
      device.config.weightTolerance = config.scaleZeroTolerance;
    }
    // Se weightTolerance foi atualizado mas scaleZeroTolerance não, sincronizar
    if (config.weightTolerance !== undefined && config.scaleZeroTolerance === undefined) {
      device.config.scaleZeroTolerance = config.weightTolerance;
    }
    
    saveDevicesDB(db);
    log(`[COMEDOR-DEVICE] Configurações atualizadas para dispositivo ${device.deviceId || identifier} (IP: ${device.ip})`);
    
    return true;
  }
  
  // Inicialização
  ensureDataDir();
  log(`[COMEDOR-DEVICE] Módulo inicializado | DB: ${DEVICES_DB_FILE}`);
  
    return {
      registerDeviceAttempt,
      registerNotification,
      getDeviceStatus,
      listDevices,
      getToken,
      setToken,
      validateToken,
      adoptDevice,
      unadoptDevice,
      updateDeviceConfig
    };
}

module.exports = {
  initComedorDeviceStatusModule
};

