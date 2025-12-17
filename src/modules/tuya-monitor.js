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
 * @param {Function} config.getCurrentIpBlocker - Getter para o ipBlocker
 * @param {number} config.energyCollectIntervalMinutes - Intervalo de coleta de energia em minutos (padrão: 60)
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
  notificationNumbers = [],
  getCurrentIpBlocker,
  energyCollectIntervalMinutes = 60
}) {
  const { log, dbg, warn, err } = logger;
  
  if (!tuya) {
    warn(`[TUYA-MONITOR] Módulo Tuya não disponível, monitoramento desabilitado`);
    return null;
  }
  
  const DEVICES_STATE_FILE = path.join(appRoot, 'tuya_devices_state.json');

  const toPositiveInt = (value, fallback) => {
    const n = Number.parseInt(String(value), 10);
    if (!Number.isFinite(n) || Number.isNaN(n)) return fallback;
    if (n <= 0) return fallback;
    return n;
  };

  const safeCheckIntervalMinutes = toPositiveInt(checkIntervalMinutes, 5);
  const safeEnergyCollectIntervalMinutes = toPositiveInt(energyCollectIntervalMinutes, 60);

  const ALERT_THRESHOLD_MS = (Number(alertThresholdHours) || 1) * 60 * 60 * 1000; // Converter horas para ms
  const CHECK_INTERVAL_MS = safeCheckIntervalMinutes * 60 * 1000; // Converter minutos para ms
  const ENERGY_COLLECT_INTERVAL_MS = safeEnergyCollectIntervalMinutes * 60 * 1000;
  
  // Estado dos dispositivos: { deviceId: { name, poweredOn, lastChangeTime, lastAlertTime } }
  let devicesState = {};
  let monitoringInterval = null;
  let energyCollectInterval = null; // mantido por compatibilidade (não usado no novo scheduler)
  let energyCollectTimeout = null;
  let isMonitoring = false;
  let isCollectingEnergy = false;
  let lastEnergyCollectAt = 0;
  let nextEnergyCollectAt = 0;
  
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
   * Coleta leituras de energia de dispositivos medidores
   */
  async function collectEnergyReadings() {
    try {
      // Evita execuções concorrentes (pode acontecer se a coleta demorar mais que o intervalo)
      if (isCollectingEnergy) {
        dbg(`[TUYA-MONITOR] Coleta de energia já em andamento, pulando esta execução`);
        return { success: false, error: 'already_running' };
      }
      isCollectingEnergy = true;
      lastEnergyCollectAt = Date.now();

      log(`[TUYA-MONITOR] Iniciando coleta de energia...`);
      const ipBlocker = getCurrentIpBlocker?.();
      if (!ipBlocker || typeof ipBlocker.saveTuyaEnergyReading !== 'function') {
        warn(`[TUYA-MONITOR] IP Blocker não disponível para salvar leituras de energia`);
        return { success: false, error: 'IP Blocker não disponível' };
      }
      
      // Busca dispositivos
      const devices = await tuya.getCachedDevices();
      log(`[TUYA-MONITOR] Verificando ${devices.length} dispositivo(s) para coleta de energia`);
      let collected = 0;
      let checked = 0;
      let hasEnergyButNoData = 0;
      
      for (const device of devices) {
        try {
          checked++;
          // Verifica se é um medidor de energia
          const status = await tuya.getDeviceStatus(device.id);
          if (!status || !Array.isArray(status)) {
            dbg(`[TUYA-MONITOR] Dispositivo ${device.name} (${device.id}): sem status`);
            continue;
          }
          
          // Detecta se tem dados de energia (verifica vários códigos comuns)
          const hasEnergyData = status.some(s => {
            const code = (s.code || '').toLowerCase();
            return code.includes('current') || code.includes('voltage') || 
                   code.includes('power') || code.includes('energy') ||
                   code.includes('add_ele') || code.includes('frequency') ||
                   code.includes('cur_power') || code.includes('cur_current') ||
                   code.includes('cur_voltage') || code.includes('activepower') ||
                   code.includes('active_power') || code.includes('power_factor');
          });
          
          if (!hasEnergyData) {
            dbg(`[TUYA-MONITOR] Dispositivo ${device.name} (${device.id}): não é medidor de energia`);
            continue;
          }
          
          hasEnergyButNoData++;
          // Lista códigos de energia encontrados para debug
          const energyCodes = status.filter(s => {
            const code = (s.code || '').toLowerCase();
            return code.includes('current') || code.includes('voltage') || 
                   code.includes('power') || code.includes('energy') ||
                   code.includes('add_ele') || code.includes('frequency') ||
                   code.includes('cur_power') || code.includes('cur_current') ||
                   code.includes('cur_voltage') || code.includes('activepower') ||
                   code.includes('active_power') || code.includes('power_factor');
          }).map(s => s.code).join(', ');
          log(`[TUYA-MONITOR] Medidor encontrado: ${device.name} (${device.id}) | Códigos: ${energyCodes}`);
          
          // Extrai valores de energia (usa mesma lógica do tuya.js)
          const energyData = {};
          
          for (const s of status) {
            const code = (s.code || '').toLowerCase();
            const value = s.value;
            const codeOriginal = s.code || '';
            
            if (typeof value !== 'number') continue;
            
            // Tensão (suporta cur_voltage, voltage, etc.)
            if (code.includes('voltage') || code.includes('cur_voltage') || code.includes('curvoltage')) {
              // Tensão geralmente em V/10 (cur_voltage) ou V (voltage)
              if (code.includes('cur_voltage') || code.includes('curvoltage')) {
                energyData.voltage = value / 10; // cur_voltage está em V/10
              } else {
                energyData.voltage = value; // voltage já está em V
              }
            } 
            // Corrente (suporta cur_current, current, etc.)
            else if ((code.includes('current') && !code.includes('active')) || 
                     code.includes('cur_current') || code.includes('curcurrent')) {
              // Corrente geralmente em mA (cur_current) ou A (current)
              if (code.includes('cur_current') || code.includes('curcurrent')) {
                energyData.current = value / 1000; // cur_current está em mA
              } else {
                energyData.current = value; // current já está em A
              }
            } 
            // Potência Ativa (suporta cur_power, activepower, etc.)
            else if (code.includes('activepower') || code.includes('active_power') || 
                     code.includes('cur_power') || code.includes('curpower') ||
                     (code.includes('power') && !code.includes('factor') && !code.includes('reactive'))) {
              // Potência geralmente em W/10 (cur_power) ou W (activepower)
              if (code.includes('cur_power') || code.includes('curpower')) {
                energyData.power = value / 10; // cur_power está em W/10
              } else {
                energyData.power = value; // activepower já está em W
              }
            } 
            // Energia Consumida (suporta add_ele, energyconsumed, etc.)
            else if (code.includes('energyconsumed') || code.includes('energy_consumed') || 
                     code.includes('add_ele') ||
                     (code.includes('energy') && !code.includes('power'))) {
              // Energia geralmente em Wh, converte para kWh
              energyData.energy = value / 1000; // Converte Wh para kWh
            } 
            // Fator de Potência
            else if (code.includes('powerfactor') || code.includes('power_factor') || code.includes('factor')) {
              energyData.powerFactor = value / 100; // Geralmente em %
            } 
            // Frequência
            else if (code.includes('frequency')) {
              energyData.frequency = value / 10; // Geralmente em Hz/10
            }
          }
          
          // Só salva se tiver algum dado válido
          if (Object.keys(energyData).length > 0) {
            await ipBlocker.saveTuyaEnergyReading(device.id, device.name, energyData);
            collected++;
            log(`[TUYA-MONITOR] ✅ Energia coletada: ${device.name} | V=${energyData.voltage?.toFixed(1) || '-'} | A=${energyData.current?.toFixed(3) || '-'} | W=${energyData.power?.toFixed(1) || '-'} | kWh=${energyData.energy?.toFixed(2) || '-'}`);
          } else {
            dbg(`[TUYA-MONITOR] Dispositivo ${device.name} tem códigos de energia mas valores não numéricos`);
          }
        } catch (e) {
          err(`[TUYA-MONITOR] Erro ao coletar energia de ${device.name} (${device.id}):`, e.message);
        }
      }
      
      if (collected > 0) {
        log(`[TUYA-MONITOR] ✅ Coleta de energia concluída: ${collected} dispositivo(s) registrado(s) de ${hasEnergyButNoData} medidor(es) encontrado(s)`);
      } else if (hasEnergyButNoData > 0) {
        warn(`[TUYA-MONITOR] ⚠️ ${hasEnergyButNoData} medidor(es) encontrado(s) mas nenhum dado válido coletado`);
      } else {
        dbg(`[TUYA-MONITOR] Nenhum medidor de energia encontrado em ${checked} dispositivo(s) verificado(s)`);
      }
      
      return { success: true, collected, checked, hasEnergyButNoData };
    } catch (e) {
      err(`[TUYA-MONITOR] Erro na coleta de energia:`, e.message);
      return { success: false, error: e.message };
    } finally {
      isCollectingEnergy = false;
    }
  }

  function scheduleEnergyCollection(initialDelayMs) {
    // Cancela qualquer agenda anterior
    if (energyCollectTimeout) {
      clearTimeout(energyCollectTimeout);
      energyCollectTimeout = null;
    }

    const delay = Math.max(0, Number(initialDelayMs) || 0);
    nextEnergyCollectAt = Date.now() + delay;

    energyCollectTimeout = setTimeout(async () => {
      try {
        await collectEnergyReadings();
      } catch (e) {
        // collectEnergyReadings já loga, aqui só garante que o scheduler segue
        dbg(`[TUYA-MONITOR] Erro no loop de coleta: ${e?.message || e}`);
      } finally {
        // Agenda a próxima execução SEM overlap
        scheduleEnergyCollection(ENERGY_COLLECT_INTERVAL_MS);
      }
    }, delay);
  }
  
  /**
   * Inicia monitoramento
   */
  function startMonitoring() {
    if (isMonitoring) {
      warn(`[TUYA-MONITOR] Monitoramento já está ativo`);
      return;
    }
    
    // Marca como ativo antes da primeira verificação (senão checkDevicesAndAlert retorna cedo)
    isMonitoring = true;

    log(`[TUYA-MONITOR] Iniciando monitoramento (verificação a cada ${safeCheckIntervalMinutes} min, alerta após ${alertThresholdHours}h)`);
    
    // Carrega estado salvo
    loadDevicesState();
    
    // Verifica imediatamente
    checkDevicesAndAlert();
    
    // Configura verificação periódica
    monitoringInterval = setInterval(() => {
      checkDevicesAndAlert();
    }, CHECK_INTERVAL_MS);
    
    // Configura coleta de energia (se ipBlocker disponível)
    if (typeof getCurrentIpBlocker === 'function' && safeEnergyCollectIntervalMinutes > 0) {
      log(`[TUYA-MONITOR] Coleta de energia configurada a cada ${safeEnergyCollectIntervalMinutes} minuto(s) (ms=${ENERGY_COLLECT_INTERVAL_MS})`);

      // Coleta inicial após um delay pequeno (mas nunca maior que o próprio intervalo)
      const firstDelayMs = Math.min(60 * 1000, ENERGY_COLLECT_INTERVAL_MS);
      log(`[TUYA-MONITOR] Primeira coleta de energia em ~${Math.ceil(firstDelayMs / 1000)}s`);
      scheduleEnergyCollection(firstDelayMs);
    }
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
    
    if (energyCollectInterval) {
      clearInterval(energyCollectInterval);
      energyCollectInterval = null;
    }

    if (energyCollectTimeout) {
      clearTimeout(energyCollectTimeout);
      energyCollectTimeout = null;
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
    saveDevicesState,
    collectEnergyReadings // Exporta para permitir coleta manual
  };
}

module.exports = { initTuyaMonitorModule };


