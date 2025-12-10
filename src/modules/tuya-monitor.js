/**
 * Módulo de Monitoramento Tuya
 * Monitora dispositivos Tuya e envia alertas quando ficam ligados por muito tempo
 */

const fs = require('fs');
const path = require('path');

/**
 * Inicializa o módulo de monitoramento Tuya
 * @param {Object} config - Configuração do módulo
 * @param {Object} config.tuya - Módulo Tuya
 * @param {Object} config.whatsapp - Módulo WhatsApp (para enviar notificações)
 * @param {Object} config.logger - Objeto com funções de log (log, dbg, warn, err)
 * @param {string} config.appRoot - Diretório raiz da aplicação
 * @param {string} config.tuyaUid - UID do Tuya
 * @param {number} config.alertThresholdHours - Horas antes de alertar (padrão: 1)
 * @param {number} config.checkIntervalMinutes - Intervalo de verificação em minutos (padrão: 5)
 * @param {Array<string>} config.notificationNumbers - Números para receber notificações
 * @returns {Object} API do módulo de monitoramento
 */
function initTuyaMonitorModule({
  tuya,
  whatsapp,
  logger,
  appRoot,
  tuyaUid,
  alertThresholdHours = 1,
  checkIntervalMinutes = 5,
  notificationNumbers = []
}) {
  const { log, dbg, warn, err } = logger;
  
  if (!tuya) {
    warn(`[TUYA-MONITOR] Módulo Tuya não disponível, monitoramento desabilitado`);
    return null;
  }
  
  const DEVICES_STATE_FILE = path.join(appRoot, 'tuya_devices_state.json');
  const ALERT_THRESHOLD_MS = alertThresholdHours * 60 * 60 * 1000; // Converter horas para ms
  const CHECK_INTERVAL_MS = checkIntervalMinutes * 60 * 1000; // Converter minutos para ms
  
  // Estado dos dispositivos: { deviceId: { name, poweredOn, lastChangeTime, lastAlertTime } }
  let devicesState = {};
  let monitoringInterval = null;
  let isMonitoring = false;
  
  /**
   * Carrega estado dos dispositivos do arquivo
   */
  function loadDevicesState() {
    try {
      if (fs.existsSync(DEVICES_STATE_FILE)) {
        const data = JSON.parse(fs.readFileSync(DEVICES_STATE_FILE, 'utf8'));
        devicesState = data.devicesState || {};
        log(`[TUYA-MONITOR] Estado carregado: ${Object.keys(devicesState).length} dispositivo(s)`);
      }
    } catch (e) {
      warn(`[TUYA-MONITOR] Erro ao carregar estado:`, e.message);
      devicesState = {};
    }
  }
  
  /**
   * Salva estado dos dispositivos no arquivo
   */
  function saveDevicesState() {
    try {
      fs.writeFileSync(DEVICES_STATE_FILE, JSON.stringify({
        devicesState,
        updatedAt: new Date().toISOString()
      }, null, 2), 'utf8');
    } catch (e) {
      warn(`[TUYA-MONITOR] Erro ao salvar estado:`, e.message);
    }
  }
  
  /**
   * Atualiza estado de um dispositivo
   */
  function updateDeviceState(deviceId, deviceName, poweredOn) {
    const now = Date.now();
    const currentState = devicesState[deviceId];
    
    // Se o estado mudou (ligado -> desligado ou desligado -> ligado)
    if (!currentState || currentState.poweredOn !== poweredOn) {
      devicesState[deviceId] = {
        name: deviceName,
        poweredOn,
        lastChangeTime: now,
        lastAlertTime: currentState?.lastAlertTime || 0
      };
      log(`[TUYA-MONITOR] Estado atualizado: ${deviceName} (${deviceId}) -> ${poweredOn ? 'LIGADO' : 'DESLIGADO'}`);
      saveDevicesState();
      return true; // Estado mudou
    } else {
      // Estado não mudou, apenas atualiza o nome se necessário
      if (currentState.name !== deviceName) {
        currentState.name = deviceName;
        saveDevicesState();
      }
      return false; // Estado não mudou
    }
  }
  
  /**
   * Verifica dispositivos e envia alertas se necessário
   */
  async function checkDevicesAndAlert() {
    if (!isMonitoring) return;
    
    try {
      log(`[TUYA-MONITOR] Verificando dispositivos...`);
      
      // Obtém lista atual de dispositivos
      const devices = await tuya.getCachedDevices();
      
      // Filtra dispositivos que controlam luzes (lâmpadas e interruptores)
      const lights = devices.filter(d => {
        if (tuya.isLightControlDevice) {
          return tuya.isLightControlDevice(d);
        }
        // Fallback para compatibilidade
        const category = (d.category || '').toLowerCase();
        const name = (d.name || '').toLowerCase();
        return category.includes('light') || category.includes('lamp') || 
               category.includes('lampada') || category.includes('lâmpada') ||
               name.includes('lamp') || name.includes('lampada') || name.includes('lâmpada') ||
               name.includes('light') || name.includes('luz') ||
               (category.includes('switch') && (name.includes('escada') || name.includes('luz')));
      });
      
      const now = Date.now();
      const devicesToAlert = [];
      
      // Verifica cada dispositivo de luz (lâmpadas e interruptores)
      for (const device of lights) {
        const deviceId = device.id;
        const deviceName = device.name || deviceId;
        const poweredOn = device.poweredOn;
        
        // Atualiza estado
        const stateChanged = updateDeviceState(deviceId, deviceName, poweredOn);
        
        // Se está ligada
        if (poweredOn) {
          const state = devicesState[deviceId];
          const timeSinceOn = now - (state?.lastChangeTime || now);
          
          // Se ficou ligada por mais de 1 hora
          if (timeSinceOn >= ALERT_THRESHOLD_MS) {
            // Verifica se já alertou recentemente (evita spam - alerta a cada 30 minutos)
            const timeSinceLastAlert = now - (state?.lastAlertTime || 0);
            const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutos
            
            if (timeSinceLastAlert >= ALERT_COOLDOWN_MS || stateChanged) {
              const hoursOn = (timeSinceOn / (60 * 60 * 1000)).toFixed(1);
              devicesToAlert.push({
                deviceId,
                deviceName,
                hoursOn: parseFloat(hoursOn)
              });
              
              // Atualiza último alerta
              if (devicesState[deviceId]) {
                devicesState[deviceId].lastAlertTime = now;
              }
            }
          }
        }
      }
      
      // Remove dispositivos que não existem mais
      const existingDeviceIds = new Set(lights.map(d => d.id));
      for (const deviceId in devicesState) {
        if (!existingDeviceIds.has(deviceId)) {
          delete devicesState[deviceId];
          log(`[TUYA-MONITOR] Dispositivo removido do estado: ${deviceId}`);
        }
      }
      
      // Salva estado atualizado
      saveDevicesState();
      
      // Envia alertas
      if (devicesToAlert.length > 0 && notificationNumbers.length > 0) {
        for (const alert of devicesToAlert) {
          const message = `⚠️ *Alerta de Luz*\n\n` +
                         `*Dispositivo:* ${alert.deviceName}\n` +
                         `*Tempo ligado:* ${alert.hoursOn} hora(s)\n\n` +
                         `💡 Considere desligar para economizar energia.`;
          
          for (const number of notificationNumbers) {
            try {
              await whatsapp.sendTextMessage(number, message);
              log(`[TUYA-MONITOR] Alerta enviado para ${number}: ${alert.deviceName} (${alert.hoursOn}h)`);
            } catch (e) {
              err(`[TUYA-MONITOR] Erro ao enviar alerta para ${number}:`, e.message);
            }
          }
        }
      }
      
      if (devicesToAlert.length > 0) {
        log(`[TUYA-MONITOR] ${devicesToAlert.length} alerta(s) enviado(s)`);
      }
      
    } catch (e) {
      err(`[TUYA-MONITOR] Erro ao verificar dispositivos:`, e.message);
    }
  }
  
  /**
   * Inicia monitoramento
   */
  function startMonitoring() {
    if (isMonitoring) {
      warn(`[TUYA-MONITOR] Monitoramento já está ativo`);
      return;
    }
    
    log(`[TUYA-MONITOR] Iniciando monitoramento (verificação a cada ${checkIntervalMinutes} min, alerta após ${alertThresholdHours}h)`);
    
    // Carrega estado salvo
    loadDevicesState();
    
    // Verifica imediatamente
    checkDevicesAndAlert();
    
    // Configura verificação periódica
    monitoringInterval = setInterval(() => {
      checkDevicesAndAlert();
    }, CHECK_INTERVAL_MS);
    
    isMonitoring = true;
    log(`[TUYA-MONITOR] Monitoramento iniciado`);
  }
  
  /**
   * Para monitoramento
   */
  function stopMonitoring() {
    if (!isMonitoring) {
      return;
    }
    
    if (monitoringInterval) {
      clearInterval(monitoringInterval);
      monitoringInterval = null;
    }
    
    isMonitoring = false;
    log(`[TUYA-MONITOR] Monitoramento parado`);
  }
  
  /**
   * Obtém estatísticas de dispositivos
   */
  function getStatistics() {
    const now = Date.now();
    const stats = {
      totalDevices: Object.keys(devicesState).length,
      poweredOn: 0,
      poweredOff: 0,
      devicesOnLongTime: []
    };
    
    for (const deviceId in devicesState) {
      const state = devicesState[deviceId];
      if (state.poweredOn) {
        stats.poweredOn++;
        const timeSinceOn = now - (state.lastChangeTime || now);
        if (timeSinceOn >= ALERT_THRESHOLD_MS) {
          const hoursOn = (timeSinceOn / (60 * 60 * 1000)).toFixed(1);
          stats.devicesOnLongTime.push({
            deviceId,
            name: state.name,
            hoursOn: parseFloat(hoursOn)
          });
        }
      } else {
        stats.poweredOff++;
      }
    }
    
    return stats;
  }
  
  // Retorna API pública do módulo
  return {
    startMonitoring,
    stopMonitoring,
    checkDevicesAndAlert,
    getStatistics,
    updateDeviceState,
    loadDevicesState,
    saveDevicesState
  };
}

module.exports = { initTuyaMonitorModule };


