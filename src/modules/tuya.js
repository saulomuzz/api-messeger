/**
 * Módulo Tuya API
 * Gerencia todas as operações relacionadas à API Tuya
 */

const crypto = require('crypto');
const axios = require('axios');

/**
 * Inicializa o módulo Tuya
 * @param {Object} config - Configuração do módulo
 * @param {string} config.clientId - TUYA_CLIENT_ID
 * @param {string} config.clientSecret - TUYA_CLIENT_SECRET
 * @param {string} config.region - TUYA_REGION
 * @param {string} config.uid - TUYA_UID
 * @param {Object} config.logger - Objeto com funções de log (log, dbg, warn, err)
 * @returns {Object} API do módulo Tuya
 */
function initTuyaModule({ clientId, clientSecret, region, uid, logger }) {
  const { log, dbg, warn, err } = logger;
  
  // Configuração
  const TUYA_CLIENT_ID = String(clientId || '').trim();
  const TUYA_CLIENT_SECRET = String(clientSecret || '').trim();
  const TUYA_REGION = String(region || 'us').trim().toLowerCase();
  const TUYA_UID = String(uid || '').trim();
  const TUYA_BASE_URL = `https://openapi.tuya${TUYA_REGION === 'us' ? 'us' : TUYA_REGION === 'eu' ? 'eu' : TUYA_REGION === 'in' ? 'in' : 'cn'}.com`;
  
  // Estado interno
  let tuyaAccessToken = null;
  let tuyaTokenExpiry = 0;
  let tuyaDevicesCache = null;
  let tuyaDevicesCacheTime = 0;
  const TUYA_DEVICES_CACHE_TTL = 5 * 60 * 1000; // 5 minutos
  
  /**
   * Gera um nonce (UUID) para requisições Tuya
   */
  function generateNonce() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }
  
  /**
   * Gera assinatura Tuya conforme documentação oficial:
   * https://developer.tuya.com/en/docs/iot/new-singnature?id=Kbw0q34cs2e5g
   */
  function generateTuyaSign(clientId, secret, timestamp, method, path, body = '', accessToken = '', nonce = '', signatureHeaders = '') {
    const cleanClientId = String(clientId).trim();
    const cleanSecret = String(secret).trim();
    const cleanTimestamp = String(timestamp).trim();
    const cleanMethod = String(method).trim().toUpperCase();
    const cleanPath = String(path).trim();
    const cleanAccessToken = String(accessToken || '').trim();
    const cleanNonce = String(nonce || '').trim();
    const cleanSignatureHeaders = String(signatureHeaders || '').trim();
    const bodyStr = body || '';
    
    const bodyHash = crypto.createHash('sha256').update(bodyStr, 'utf8').digest('hex').toLowerCase();
    
    let stringToSign = cleanMethod + '\n' + bodyHash + '\n';
    if (cleanSignatureHeaders) {
      stringToSign += cleanSignatureHeaders + '\n';
    } else {
      stringToSign += '\n';
    }
    stringToSign += cleanPath;
    
    const isTokenAPI = path.includes('/token');
    
    let signStr;
    if (isTokenAPI) {
      signStr = cleanClientId + cleanTimestamp + cleanNonce + stringToSign;
    } else {
      signStr = cleanClientId + cleanAccessToken + cleanTimestamp + cleanNonce + stringToSign;
    }
    
    const sign = crypto.createHmac('sha256', cleanSecret).update(signStr, 'utf8').digest('hex').toUpperCase();
    
    if (logger.DEBUG) {
      dbg(`[TUYA-SIGN] Method: ${cleanMethod}`);
      dbg(`[TUYA-SIGN] Path: ${cleanPath}`);
      dbg(`[TUYA-SIGN] Body: "${bodyStr}" (length: ${bodyStr.length})`);
      dbg(`[TUYA-SIGN] BodyHash: ${bodyHash}`);
      dbg(`[TUYA-SIGN] ClientId: "${cleanClientId}" (${cleanClientId.length} chars)`);
      dbg(`[TUYA-SIGN] Secret: ${cleanSecret.length} chars`);
      dbg(`[TUYA-SIGN] Timestamp: ${cleanTimestamp}`);
      dbg(`[TUYA-SIGN] Nonce: ${cleanNonce || '(vazio)'}`);
      dbg(`[TUYA-SIGN] AccessToken: ${cleanAccessToken ? cleanAccessToken.substring(0, 10) + '...' : '(não usado)'}`);
      dbg(`[TUYA-SIGN] SignatureHeaders: ${cleanSignatureHeaders || '(vazio)'}`);
      dbg(`[TUYA-SIGN] StringToSign: ${JSON.stringify(stringToSign)}`);
      dbg(`[TUYA-SIGN] SignStr (sem secret): ${cleanClientId}${cleanAccessToken ? '***' : ''}${cleanTimestamp}${cleanNonce}${stringToSign.substring(0, 50)}...`);
      dbg(`[TUYA-SIGN] Sign: ${sign.substring(0, 20)}...`);
    }
    
    return sign;
  }
  
  /**
   * Obtém access token da Tuya (com cache)
   */
  async function getAccessToken() {
    if (tuyaAccessToken && Date.now() < tuyaTokenExpiry) {
      return tuyaAccessToken;
    }

    if (!TUYA_CLIENT_ID || !TUYA_CLIENT_SECRET) {
      throw new Error('TUYA_CLIENT_ID e TUYA_CLIENT_SECRET devem estar configurados');
    }

    const clientId = String(TUYA_CLIENT_ID).trim();
    const clientSecret = String(TUYA_CLIENT_SECRET).trim();
    
    if (!clientId || !clientSecret) {
      throw new Error('TUYA_CLIENT_ID e TUYA_CLIENT_SECRET não podem estar vazios');
    }
    
    if (clientSecret.length !== 32) {
      warn(`[TUYA] TUYA_CLIENT_SECRET tem ${clientSecret.length} caracteres (esperado: 32). Verifique se está completo.`);
    }

    try {
      const timestamp = Date.now().toString();
      const method = 'GET';
      const path = `/v1.0/token?grant_type=1`;
      const nonce = generateNonce();
      
      const sign = generateTuyaSign(clientId, clientSecret, timestamp, method, path, '', '', nonce);

      log(`[TUYA] Solicitando access token... (timestamp: ${timestamp}, nonce: ${nonce.substring(0, 8)}..., region: ${TUYA_REGION}, baseUrl: ${TUYA_BASE_URL})`);

      const response = await axios.get(`${TUYA_BASE_URL}${path}`, {
        headers: {
          'client_id': clientId,
          'sign': sign,
          't': timestamp,
          'sign_method': 'HMAC-SHA256',
          'nonce': nonce
        },
        timeout: 10000
      });

      if (response.data && response.data.success && response.data.result) {
        tuyaAccessToken = response.data.result.access_token;
        const expiresIn = (response.data.result.expire_time || 7200) * 1000;
        tuyaTokenExpiry = Date.now() + expiresIn - 60000;
        log(`[TUYA] Access token obtido com sucesso (expira em ${Math.floor(expiresIn / 1000 / 60)} minutos)`);
        return tuyaAccessToken;
      } else {
        const errorMsg = `Falha ao obter token: ${JSON.stringify(response.data)}`;
        err(`[TUYA] ${errorMsg}`);
        
        if (response.data?.code === 1004) {
          err(`[TUYA] ❌ Erro 1004: "sign invalid" - A assinatura foi rejeitada pela Tuya.`);
          err(`[TUYA] 🔍 Possíveis causas:`);
          err(`[TUYA]    1. TUYA_CLIENT_ID incorreto (atual: ${clientId.substring(0, 10)}...)`);
          err(`[TUYA]    2. TUYA_CLIENT_SECRET incorreto ou incompleto (tamanho: ${clientSecret.length} chars)`);
          err(`[TUYA]    3. TUYA_REGION incorreto (atual: ${TUYA_REGION}, baseUrl: ${TUYA_BASE_URL})`);
          err(`[TUYA]    4. Relógio do servidor dessincronizado (timestamp: ${timestamp})`);
          err(`[TUYA] 💡 Execute: node test-tuya-sign.js para diagnosticar`);
        }
        
        throw new Error(errorMsg);
      }
    } catch (e) {
      const errorData = e.response?.data || {};
      const errorCode = errorData.code;
      const errorMsg = errorData.msg || errorData.message || e.message;
      
      err(`[TUYA] Erro ao obter access token:`, errorCode ? `code=${errorCode}, msg=${errorMsg}` : errorMsg);
      
      if (errorCode === 1004) {
        err(`[TUYA] 🔧 SOLUÇÃO: Verifique as credenciais no .env comparando com a plataforma Tuya:`);
        err(`[TUYA]    - Acesse: https://iot.tuya.com/`);
        err(`[TUYA]    - Vá em seu projeto > Overview`);
        err(`[TUYA]    - Compare Access ID/Client ID com TUYA_CLIENT_ID`);
        err(`[TUYA]    - Compare Access Secret/Client Secret com TUYA_CLIENT_SECRET`);
        err(`[TUYA]    - Verifique o Data Center e ajuste TUYA_REGION se necessário`);
        err(`[TUYA]    - Certifique-se de que não há espaços extras ou caracteres invisíveis`);
      }
      
      throw e;
    }
  }
  
  /**
   * Obtém status de um dispositivo
   */
  async function getDeviceStatus(deviceId) {
    if (!TUYA_CLIENT_ID || !TUYA_CLIENT_SECRET) {
      throw new Error('TUYA_CLIENT_ID e TUYA_CLIENT_SECRET devem estar configurados');
    }

    try {
      const accessToken = await getAccessToken();
      const timestamp = Date.now().toString();
      const method = 'GET';
      const path = `/v1.0/iot-03/devices/${deviceId}/status`;
      const nonce = generateNonce();
      const sign = generateTuyaSign(TUYA_CLIENT_ID, TUYA_CLIENT_SECRET, timestamp, method, path, '', accessToken, nonce);

      dbg(`[TUYA] Consultando status do dispositivo ${deviceId}...`);

      const response = await axios.get(`${TUYA_BASE_URL}${path}`, {
        headers: {
          'client_id': TUYA_CLIENT_ID,
          'access_token': accessToken,
          'sign': sign,
          't': timestamp,
          'sign_method': 'HMAC-SHA256',
          'nonce': nonce
        },
        timeout: 10000
      });

      if (response.data && response.data.success) {
        return response.data.result;
      } else {
        throw new Error(`Falha ao obter status: ${JSON.stringify(response.data)}`);
      }
    } catch (e) {
      err(`[TUYA] Erro ao obter status do dispositivo ${deviceId}:`, e.response?.data || e.message);
      throw e;
    }
  }
  
  /**
   * Lista dispositivos de um usuário
   */
  async function getDevices(uid) {
    if (!TUYA_CLIENT_ID || !TUYA_CLIENT_SECRET) {
      throw new Error('TUYA_CLIENT_ID e TUYA_CLIENT_SECRET devem estar configurados');
    }

    if (!uid) {
      throw new Error('UID do usuário é necessário para listar dispositivos');
    }

    try {
      const accessToken = await getAccessToken();
      const timestamp = Date.now().toString();
      const method = 'GET';
      const path = `/v1.0/users/${uid}/devices`;
      const nonce = generateNonce();
      const sign = generateTuyaSign(TUYA_CLIENT_ID, TUYA_CLIENT_SECRET, timestamp, method, path, '', accessToken, nonce);

      dbg(`[TUYA] Listando dispositivos para usuário ${uid}...`);

      const response = await axios.get(`${TUYA_BASE_URL}${path}`, {
        headers: {
          'client_id': TUYA_CLIENT_ID,
          'access_token': accessToken,
          'sign': sign,
          't': timestamp,
          'sign_method': 'HMAC-SHA256',
          'nonce': nonce
        },
        timeout: 10000
      });

      if (response.data && response.data.success) {
        return response.data.result || [];
      } else {
        throw new Error(`Falha ao listar dispositivos: ${JSON.stringify(response.data)}`);
      }
    } catch (e) {
      err(`[TUYA] Erro ao listar dispositivos:`, e.response?.data || e.message);
      throw e;
    }
  }
  
  /**
   * Envia comando para um dispositivo
   */
  async function sendCommand(deviceId, commands) {
    if (!TUYA_CLIENT_ID || !TUYA_CLIENT_SECRET) {
      throw new Error('TUYA_CLIENT_ID e TUYA_CLIENT_SECRET devem estar configurados');
    }

    if (!deviceId || !commands || !Array.isArray(commands) || commands.length === 0) {
      throw new Error('deviceId e commands (array) são obrigatórios');
    }

    try {
      const accessToken = await getAccessToken();
      const timestamp = Date.now().toString();
      const method = 'POST';
      const path = `/v1.0/iot-03/devices/${deviceId}/commands`;
      const nonce = generateNonce();
      
      const body = JSON.stringify({ commands: commands });
      const sign = generateTuyaSign(TUYA_CLIENT_ID, TUYA_CLIENT_SECRET, timestamp, method, path, body, accessToken, nonce);

      dbg(`[TUYA] Enviando comando para dispositivo ${deviceId}...`);
      dbg(`[TUYA] Comandos:`, JSON.stringify(commands));

      const response = await axios.post(`${TUYA_BASE_URL}${path}`, body, {
        headers: {
          'client_id': TUYA_CLIENT_ID,
          'access_token': accessToken,
          'sign': sign,
          't': timestamp,
          'sign_method': 'HMAC-SHA256',
          'nonce': nonce,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });

      if (response.data && response.data.success) {
        log(`[TUYA] Comando enviado com sucesso para ${deviceId}`);
        return response.data.result || {};
      } else {
        throw new Error(`Falha ao enviar comando: ${JSON.stringify(response.data)}`);
      }
    } catch (e) {
      err(`[TUYA] Erro ao enviar comando para dispositivo ${deviceId}:`, e.response?.data || e.message);
      throw e;
    }
  }
  
  /**
   * Encontra o código de switch/power de um dispositivo
   */
  function findSwitchCode(status) {
    if (!status || !Array.isArray(status)) return null;
    
    const switchCodes = ['switch_led', 'switch_1', 'switch_2', 'switch_3', 'switch_4', 
                         'switch', 'power', 'switch_1_1', 'switch_2_1'];
    
    for (const code of switchCodes) {
      const found = status.find(s => s.code?.toLowerCase() === code.toLowerCase());
      if (found) return found.code;
    }
    
    const found = status.find(s => {
      const code = (s.code || '').toLowerCase();
      return code.includes('switch') || code.includes('power');
    });
    
    return found ? found.code : null;
  }
  
  /**
   * Obtém dispositivos com cache
   */
  async function getCachedDevices(uid) {
    const now = Date.now();
    
    if (tuyaDevicesCache && (now - tuyaDevicesCacheTime) < TUYA_DEVICES_CACHE_TTL) {
      dbg(`[TUYA] Usando cache de dispositivos (${Math.floor((now - tuyaDevicesCacheTime) / 1000)}s de idade)`);
      return tuyaDevicesCache;
    }
    
    if (!uid) {
      if (!TUYA_UID) {
        throw new Error('UID não configurado. Configure TUYA_UID no .env ou forneça o UID no comando.');
      }
      uid = TUYA_UID;
    }
    
    const devices = await getDevices(uid);
    
    const devicesWithStatus = await Promise.all(devices.map(async (device) => {
      try {
        const status = await getDeviceStatus(device.id);
        const poweredOn = status.filter(s => {
          const code = s.code?.toLowerCase() || '';
          const value = s.value;
          if (code.includes('switch') || code.includes('power')) {
            return value === true || value === 1 || value === 'true' || value === 'on';
          }
          return false;
        });

        return {
          id: device.id,
          name: device.name || device.id,
          online: device.online || false,
          category: device.category,
          poweredOn: poweredOn.length > 0,
          poweredOnCount: poweredOn.length
        };
      } catch (e) {
        warn(`[TUYA] Erro ao obter status do dispositivo ${device.id}:`, e.message);
        return {
          id: device.id,
          name: device.name || device.id,
          online: device.online || false,
          category: device.category,
          error: e.message
        };
      }
    }));
    
    tuyaDevicesCache = devicesWithStatus;
    tuyaDevicesCacheTime = now;
    
    return devicesWithStatus;
  }
  
  /**
   * Encontra dispositivo por identificador (número, nome ou ID)
   */
  function findDeviceByIdentifier(identifier, devices) {
    if (!identifier || !devices || devices.length === 0) {
      return null;
    }
    
    const idLower = identifier.toLowerCase().trim();
    
    const index = parseInt(idLower) - 1;
    if (!isNaN(index) && index >= 0 && index < devices.length) {
      return devices[index];
    }
    
    const byId = devices.find(d => d.id.toLowerCase() === idLower);
    if (byId) return byId;
    
    const byName = devices.find(d => {
      const name = (d.name || '').toLowerCase();
      return name === idLower || name.includes(idLower) || idLower.includes(name);
    });
    if (byName) return byName;
    
    return null;
  }
  
  /**
   * Formata mensagem de status do dispositivo
   * Detecta medidores elétricos e formata valores de forma especializada
   */
  function formatDeviceStatusMessage(deviceNameOrId, status, poweredOn) {
    let message = `*📱 Status do Dispositivo Tuya*\n\n`;
    message += `*Nome:* ${deviceNameOrId}\n`;
    
    if (!status || status.length === 0) {
      message += `*Status:* Nenhum dado disponível\n`;
      return message;
    }
    
    // Debug: mostra todos os códigos DP recebidos
    log(`[FORMAT-STATUS] Formatando status para ${deviceNameOrId}`);
    log(`[FORMAT-STATUS] Total de propriedades: ${status.length}`);
    status.forEach((s, idx) => {
      log(`[FORMAT-STATUS] [${idx}] code: "${s.code}", value: ${JSON.stringify(s.value)}, type: ${typeof s.value}`);
    });
    
    // Detecta se é um medidor elétrico (verifica códigos de corrente, tensão, potência)
    // Suporta diferentes formatos: CurrentA, current_a, Current, cur_current, etc.
    const isElectricMeter = status.some(s => {
      const code = (s.code || '').toLowerCase();
      return code.includes('current') || code.includes('cur_current') || code.includes('curcurrent') ||
             code.includes('voltage') || code.includes('cur_voltage') || code.includes('curvoltage') ||
             code.includes('activepower') || code.includes('active_power') || code.includes('cur_power') || code.includes('curpower') ||
             code.includes('energyconsumed') || code.includes('energy_consumed') || code.includes('add_ele') ||
             code.includes('energy') || code.includes('frequency') || 
             code.includes('powerfactor') || code.includes('power_factor') ||
             code.includes('reactivepower') || code.includes('reactive_power');
    });
    
    log(`[FORMAT-STATUS] É medidor elétrico? ${isElectricMeter}`);
    
    if (isElectricMeter) {
      // Formatação especializada para medidor elétrico
      message += `*Tipo:* ⚡ Medidor Elétrico\n\n`;
      
      // Agrupa valores por categoria
      const currents = [];
      const voltages = [];
      const activePowers = [];
      const reactivePowers = [];
      const powerFactors = [];
      const energies = [];
      const frequencies = [];
      const temperatures = [];
      const others = [];
      
      status.forEach(s => {
        const code = (s.code || '').toLowerCase();
        const value = s.value;
        const codeOriginal = s.code || 'N/A';
        
        // Corrente (suporta Current, CurrentA, CurrentB, CurrentC, current_a, cur_current, etc.)
        if (code.includes('current') || code.includes('cur_current') || code.includes('curcurrent')) {
          currents.push({ code: codeOriginal, value, phase: getPhase(code) });
        } 
        // Tensão (suporta Voltage, VoltageA, VoltageB, VoltageC, voltage_a, cur_voltage, etc.)
        else if (code.includes('voltage') || code.includes('cur_voltage') || code.includes('curvoltage')) {
          voltages.push({ code: codeOriginal, value, phase: getPhase(code) });
        } 
        // Potência Ativa (suporta ActivePower, ActivePowerA, active_power, cur_power, etc.)
        else if (code.includes('activepower') || code.includes('active_power') || 
                 code.includes('cur_power') || code.includes('curpower') ||
                 (code.includes('power') && !code.includes('factor') && !code.includes('reactive'))) {
          activePowers.push({ code: codeOriginal, value, phase: getPhase(code) });
        } 
        // Potência Reativa (suporta ReactivePower, ReactivePowerA, reactive_power, etc.)
        else if (code.includes('reactivepower') || code.includes('reactive_power')) {
          reactivePowers.push({ code: codeOriginal, value, phase: getPhase(code) });
        } 
        // Fator de Potência (suporta PowerFactor, PowerFactorA, power_factor, etc.)
        else if (code.includes('powerfactor') || code.includes('power_factor')) {
          powerFactors.push({ code: codeOriginal, value, phase: getPhase(code) });
        } 
        // Energia Consumida (suporta EnergyConsumed, EnergyConsumedA, energy_consumed, add_ele, etc.)
        else if (code.includes('energyconsumed') || code.includes('energy_consumed') || 
                 code.includes('add_ele') ||
                 (code.includes('energy') && !code.includes('power'))) {
          energies.push({ code: codeOriginal, value });
        } 
        // Frequência
        else if (code.includes('frequency')) {
          frequencies.push({ code: codeOriginal, value });
        } 
        // Temperatura
        else if (code.includes('temperature')) {
          temperatures.push({ code: codeOriginal, value });
        } 
        // Outros valores
        else {
          others.push({ code: codeOriginal, value });
        }
      });
      
      // Corrente
      if (currents.length > 0) {
        message += `*⚡ CORRENTE*\n`;
        currents.forEach(c => {
          const unit = formatValue(c.value, 'A', c.code);
          const phaseLabel = c.phase ? ` (Fase ${c.phase})` : '';
          message += `  ${c.code}: *${unit}*${phaseLabel}\n`;
        });
        message += `\n`;
      }
      
      // Tensão
      if (voltages.length > 0) {
        message += `*🔌 TENSÃO*\n`;
        voltages.forEach(v => {
          const unit = formatValue(v.value, 'V', v.code);
          const phaseLabel = v.phase ? ` (Fase ${v.phase})` : '';
          message += `  ${v.code}: *${unit}*${phaseLabel}\n`;
        });
        message += `\n`;
      }
      
      // Potência Ativa
      if (activePowers.length > 0) {
        message += `*⚡ POTÊNCIA ATIVA*\n`;
        activePowers.forEach(p => {
          const unit = formatValue(p.value, 'W', p.code);
          const phaseLabel = p.phase ? ` (Fase ${p.phase})` : '';
          message += `  ${p.code}: *${unit}*${phaseLabel}\n`;
        });
        message += `\n`;
      }
      
      // Potência Reativa
      if (reactivePowers.length > 0) {
        message += `*⚡ POTÊNCIA REATIVA*\n`;
        reactivePowers.forEach(p => {
          const unit = formatValue(p.value, 'VAR');
          const phaseLabel = p.phase ? ` (Fase ${p.phase})` : '';
          message += `  ${p.code}: *${unit}*${phaseLabel}\n`;
        });
        message += `\n`;
      }
      
      // Fator de Potência
      if (powerFactors.length > 0) {
        message += `*📊 FATOR DE POTÊNCIA*\n`;
        powerFactors.forEach(pf => {
          const phaseLabel = pf.phase ? ` (Fase ${pf.phase})` : '';
          // PowerFactor geralmente vem em % (0-100), converte para decimal (0.0-1.0)
          let pfValue = pf.value;
          if (typeof pfValue === 'number' && pfValue > 1 && pfValue <= 100) {
            pfValue = (pfValue / 100).toFixed(2);
          } else if (typeof pfValue === 'number') {
            pfValue = pfValue.toFixed(2);
          }
          message += `  ${pf.code}: *${pfValue}*${phaseLabel}\n`;
        });
        message += `\n`;
      }
      
      // Energia Consumida
      if (energies.length > 0) {
        message += `*🔋 ENERGIA CONSUMIDA*\n`;
        energies.forEach(e => {
          const unit = formatValue(e.value, 'kWh', e.code);
          message += `  ${e.code}: *${unit}*\n`;
        });
        message += `\n`;
      }
      
      // Frequência
      if (frequencies.length > 0) {
        message += `*📡 FREQUÊNCIA*\n`;
        frequencies.forEach(f => {
          const unit = formatValue(f.value, 'Hz');
          message += `  ${f.code}: *${unit}*\n`;
        });
        message += `\n`;
      }
      
      // Temperatura
      if (temperatures.length > 0) {
        message += `*🌡️ TEMPERATURA*\n`;
        temperatures.forEach(t => {
          const unit = formatValue(t.value, '°C', t.code);
          message += `  ${t.code}: *${unit}*\n`;
        });
        message += `\n`;
      }
      
      // Outros valores
      if (others.length > 0) {
        message += `*⚙️ OUTROS*\n`;
        others.forEach(o => {
          message += `  ${o.code}: *${o.value}*\n`;
        });
      }
      
    } else {
      // Formatação padrão para outros dispositivos
      message += `*Status:* ${poweredOn ? '🟢 LIGADO' : '🔴 DESLIGADO'}\n\n`;
      message += `*Propriedades:*\n`;
      status.forEach(s => {
        const code = s.code || 'N/A';
        const value = s.value;
        const emoji = (code.toLowerCase().includes('switch') || code.toLowerCase().includes('power')) 
          ? (value === true || value === 1 || value === 'true' || value === 'on' ? '🟢' : '🔴')
          : '⚙️';
        message += `${emoji} *${code}:* ${value}\n`;
      });
    }
    
    return message;
  }
  
  /**
   * Extrai a fase (A, B, C) do código DP
   * Suporta diferentes formatos: CurrentA, CurrentB, CurrentC, current_a, etc.
   */
  function getPhase(code) {
    if (!code) return null;
    
    // Primeiro tenta detectar maiúscula no final (CurrentA, VoltageB, etc.)
    const upperMatch = code.match(/([ABC])$/);
    if (upperMatch) return upperMatch[1];
    
    // Depois tenta lowercase
    const codeLower = code.toLowerCase();
    
    // Padrões com underscore ou hífen: current_a, voltage-b, etc.
    if (codeLower.match(/[_-]a$/) || codeLower.includes('phasea')) return 'A';
    if (codeLower.match(/[_-]b$/) || codeLower.includes('phaseb')) return 'B';
    if (codeLower.match(/[_-]c$/) || codeLower.includes('phasec')) return 'C';
    
    // Padrões que terminam com 'a', 'b' ou 'c' (mas não fazem parte de outra palavra)
    // Ex: CurrentA -> currenta (detecta 'a' no final)
    if (codeLower.endsWith('a') && codeLower.length > 1) {
      const beforeLast = codeLower[codeLower.length - 2];
      // Se o caractere antes do 'a' não é uma letra minúscula, provavelmente é uma fase
      if (!/[a-z]/.test(beforeLast)) {
        return 'A';
      }
    }
    if (codeLower.endsWith('b') && codeLower.length > 1) {
      const beforeLast = codeLower[codeLower.length - 2];
      if (!/[a-z]/.test(beforeLast)) {
        return 'B';
      }
    }
    if (codeLower.endsWith('c') && codeLower.length > 1) {
      const beforeLast = codeLower[codeLower.length - 2];
      if (!/[a-z]/.test(beforeLast)) {
        return 'C';
      }
    }
    
    return null;
  }
  
  /**
   * Formata valor numérico com unidade apropriada
   * Detecta automaticamente a escala baseada no código DP
   */
  function formatValue(value, unit, code = '') {
    if (value === null || value === undefined) return 'N/A';
    
    const num = parseFloat(value);
    if (isNaN(num)) return String(value);
    
    const codeLower = (code || '').toLowerCase();
    
    // Detecta se o valor está em mA (miliamperes) ou V/10 (décimos de volt)
    // Códigos como cur_current geralmente vêm em mA
    // Códigos como cur_voltage geralmente vêm em V/10 (décimos de volt)
    
    if (unit === 'A') {
      // Detecta códigos de corrente que estão em mA (miliamperes)
      // Exemplos:
      // - cur_current: 1282 → 1.282A
      // - CurrentA, CurrentB, CurrentC, Current: 3544 → 3.544A
      const isCurrentInMilliamps = 
        // cur_current (com underscore)
        codeLower === 'cur_current' || codeLower.includes('cur_current') ||
        // curcurrent (sem underscore)
        codeLower === 'curcurrent' || codeLower.includes('curcurrent') ||
        // CurrentA, CurrentB, CurrentC, Current (começa com Current)
        codeLower.startsWith('current') ||
        // Qualquer código que contenha 'current' (exceto powerfactor)
        (codeLower.includes('current') && !codeLower.includes('power'));
      
      if (isCurrentInMilliamps) {
        // Converte de mA para A (divide por 1000)
        const amps = num / 1000;
        log(`[FORMAT-VALUE] Corrente detectada (mA): ${num} → ${amps}A (código: ${code})`);
        return `${amps.toFixed(3)} ${unit}`;
      }
      // Caso contrário, assume que já está em A
      return `${num.toFixed(2)} ${unit}`;
    }
    
    if (unit === 'V') {
      // Detecta códigos de tensão que estão em V/10 (décimos de volt)
      // Exemplos:
      // - cur_voltage: 2231 → 223.1V
      // - VoltageA, VoltageB, VoltageC: 2232 → 223.2V
      // - voltage (qualquer variação): divide por 10
      const isVoltageInTenths = 
        // cur_voltage (com underscore)
        codeLower === 'cur_voltage' || codeLower.includes('cur_voltage') ||
        // curvoltage (sem underscore)
        codeLower === 'curvoltage' || codeLower.includes('curvoltage') ||
        // VoltageA, VoltageB, VoltageC (começa com Voltage e termina com A/B/C ou sem sufixo)
        (codeLower.startsWith('voltage') && (codeLower.endsWith('a') || codeLower.endsWith('b') || codeLower.endsWith('c') || codeLower === 'voltage')) ||
        // Qualquer código que contenha 'voltage' (exceto voltage_phase_seq que é string)
        (codeLower.includes('voltage') && !codeLower.includes('phase_seq'));
      
      if (isVoltageInTenths) {
        // Converte de V/10 para V (divide por 10)
        const volts = num / 10;
        log(`[FORMAT-VALUE] Tensão detectada (V/10): ${num} → ${volts}V (código: ${code})`);
        return `${volts.toFixed(1)} ${unit}`;
      }
      // Caso contrário, assume que já está em V
      log(`[FORMAT-VALUE] Tensão sem conversão: ${num}V (código: ${code})`);
      return `${num.toFixed(1)} ${unit}`;
    }
    
    if (unit === 'W') {
      // Detecta códigos de potência que podem estar em W ou W/10
      // Exemplos:
      // - cur_power: 2821 → 282.1W (W/10)
      // - ActivePowerA, ActivePower: 711 → 711W (já está em W)
      const isPowerInTenths = 
        // cur_power (com underscore) - geralmente está em W/10
        codeLower === 'cur_power' || codeLower.includes('cur_power') ||
        // curpower (sem underscore)
        codeLower === 'curpower' || codeLower.includes('curpower') ||
        (codeLower.startsWith('cur_') && codeLower.includes('power'));
      
      if (isPowerInTenths) {
        // Converte de W/10 para W (divide por 10)
        const watts = num / 10;
        // Se for muito grande, converte para kW
        if (watts >= 1000) {
          return `${(watts / 1000).toFixed(2)} kW`;
        }
        log(`[FORMAT-VALUE] Potência detectada (W/10): ${num} → ${watts}W (código: ${code})`);
        return `${watts.toFixed(1)} ${unit}`;
      }
      // Para ActivePower, ActivePowerA, etc., assume que já está em W
      // Se for muito grande, converte para kW
      if (num >= 1000) {
        return `${(num / 1000).toFixed(2)} kW`;
      }
      return `${num.toFixed(1)} ${unit}`;
    }
    
    if (unit === 'VAR' && num >= 1000) {
      return `${(num / 1000).toFixed(2)} kVAR`;
    }
    
    if (unit === '°C') {
      // Temperatura geralmente vem em °C/10 (décimos de grau)
      // Exemplo: 368 → 36.8°C
      // Se o valor for > 100, provavelmente está em °C/10
      if (num > 100) {
        const celsius = num / 10;
        log(`[FORMAT-VALUE] Temperatura detectada (°C/10): ${num} → ${celsius}°C (código: ${code})`);
        return `${celsius.toFixed(1)} ${unit}`;
      }
      // Caso contrário, assume que já está em °C
      return `${num.toFixed(1)} ${unit}`;
    }
    
    if (unit === 'kWh') {
      // Detecta códigos de energia consumida
      // Exemplos:
      // - add_ele: 100 → 0.10 kWh (se < 1000, assume Wh)
      // - EnergyConsumedA: 413983 → 413.98 kWh (se >= 1000, assume Wh e converte)
      // - EnergyConsumed: 1111288 → 1111.29 kWh
      const isEnergyInWh = 
        codeLower.includes('add_ele') ||
        codeLower.includes('energyconsumed') ||
        codeLower.includes('energy_consumed') ||
        (codeLower.includes('energy') && !codeLower.includes('power'));
      
      if (isEnergyInWh) {
        // Se o valor for >= 1000, provavelmente está em Wh, converte para kWh
        if (num >= 1000) {
          const kwh = num / 1000;
          // Se for muito grande, converte para MWh
          if (kwh >= 1000) {
            return `${(kwh / 1000).toFixed(2)} MWh`;
          }
          log(`[FORMAT-VALUE] Energia detectada (Wh): ${num} → ${kwh}kWh (código: ${code})`);
          return `${kwh.toFixed(2)} ${unit}`;
        }
        // Se for < 1000, assume que já está em Wh, converte para kWh
        const kwh = num / 1000;
        log(`[FORMAT-VALUE] Energia detectada (Wh): ${num} → ${kwh}kWh (código: ${code})`);
        return `${kwh.toFixed(2)} ${unit}`;
      }
      // Caso contrário, assume que já está em kWh
      if (num >= 1000) {
        return `${(num / 1000).toFixed(2)} MWh`;
      }
      return `${num.toFixed(2)} ${unit}`;
    }
    
    // Formata com 2 casas decimais se for número
    return `${num.toFixed(2)} ${unit}`;
  }
  
  /**
   * Formata mensagem de lista de dispositivos
   */
  function formatDevicesListMessage(devices) {
    if (!devices || devices.length === 0) {
      return `*📱 Dispositivos Tuya*\n\nNenhum dispositivo encontrado.`;
    }
    
    let message = `*📱 Seus Dispositivos Tuya*\n\n`;
    message += `*Total:* ${devices.length}\n`;
    
    const poweredOnCount = devices.filter(d => d.poweredOn).length;
    message += `*Ligados:* ${poweredOnCount}\n\n`;
    message += `*Para consultar status, use:*\n`;
    message += `\`!tuya status 1\` (número da lista)\n`;
    message += `\`!tuya status Nome do Dispositivo\` (nome)\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━━\n\n`;
    
    devices.forEach((device, index) => {
      const statusEmoji = device.poweredOn ? '🟢' : '🔴';
      const onlineEmoji = device.online ? '🟢' : '🔴';
      message += `${index + 1}. ${statusEmoji} *${device.name || device.id}*\n`;
      message += `   ${onlineEmoji} Online: ${device.online ? 'Sim' : 'Não'}\n`;
      if (device.category) {
        message += `   📦 Categoria: ${device.category}\n`;
      }
      if (device.poweredOnCount > 0) {
        message += `   ⚡ ${device.poweredOnCount} propriedade(s) ligada(s)\n`;
      }
      message += `\n`;
    });
    
    return message;
  }
  
  /**
   * Formata mensagem de ajuda Tuya
   */
  function formatHelpMessage() {
    let message = `*🤖 Comandos Tuya*\n\n`;
    message += `*Comandos disponíveis:*\n\n`;
    message += `*!tuya list*\n`;
    message += `Lista todos os seus dispositivos\n`;
    message += `Exemplo: !tuya list\n\n`;
    message += `*!tuya status <número ou nome>*\n`;
    message += `Consulta o status de um dispositivo\n`;
    message += `Você pode usar:\n`;
    message += `- Número da lista: !tuya status 1\n`;
    message += `- Nome do dispositivo: !tuya status Lâmpada Sala\n`;
    message += `- ID completo: !tuya status bf1234567890abcdef\n\n`;
    message += `*!tuya on <número ou nome>*\n`;
    message += `Liga um dispositivo\n`;
    message += `Exemplo: !tuya on 1 ou !tuya on Lâmpada Sala\n\n`;
    message += `*!tuya off <número ou nome>*\n`;
    message += `Desliga um dispositivo\n`;
    message += `Exemplo: !tuya off 1 ou !tuya off Lâmpada Sala\n\n`;
    message += `*!tuya toggle <número ou nome>*\n`;
    message += `Alterna o estado de um dispositivo (liga se estiver desligado, desliga se estiver ligado)\n`;
    message += `Exemplo: !tuya toggle 1\n\n`;
    message += `*!tuya help*\n`;
    message += `Mostra esta mensagem de ajuda\n\n`;
    message += `*Dica:* Use \`!tuya list\` para ver todos os dispositivos disponíveis.`;
    
    return message;
  }
  
  // Retorna API pública do módulo
  return {
    getAccessToken,
    getDeviceStatus,
    getDevices,
    sendCommand,
    findSwitchCode,
    getCachedDevices,
    findDeviceByIdentifier,
    formatDeviceStatusMessage,
    formatDevicesListMessage,
    formatHelpMessage,
    // Configuração (read-only)
    get config() {
      return {
        clientId: TUYA_CLIENT_ID,
        region: TUYA_REGION,
        uid: TUYA_UID,
        baseUrl: TUYA_BASE_URL
      };
    }
  };
}

module.exports = { initTuyaModule };

