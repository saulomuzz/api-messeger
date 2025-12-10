/**
 * Módulo WhatsApp Business API Oficial (Meta)
 * Usa a API oficial do WhatsApp Business para envio e recebimento de mensagens
 */

const axios = require('axios');
const crypto = require('crypto');

/**
 * Inicializa o módulo WhatsApp Business API Oficial
 * @param {Object} config - Configuração do módulo
 * @param {string} config.accessToken - Access Token do Meta
 * @param {string} config.phoneNumberId - Phone Number ID
 * @param {string} config.businessAccountId - Business Account ID (opcional)
 * @param {string} config.webhookVerifyToken - Token para verificação do webhook
 * @param {string} config.apiVersion - Versão da API (padrão: v21.0)
 * @param {Object} config.logger - Objeto com funções de log (log, dbg, warn, err)
 * @param {Object} config.tuya - Módulo Tuya
 * @param {Object} config.camera - Módulo de câmera
 * @param {Object} config.utils - Módulo utils
 * @param {Object} config.ipBlocker - Módulo de bloqueio de IPs
 * @param {string} config.numbersFile - Arquivo com números autorizados
 * @param {string} config.recordDurationSec - Duração padrão de gravação
 * @returns {Object} API do módulo WhatsApp Business
 */
function initWhatsAppOfficialModule({
  accessToken,
  phoneNumberId,
  businessAccountId,
  webhookVerifyToken,
  apiVersion = 'v21.0',
  logger,
  tuya,
  camera,
  utils,
  ipBlocker,
  numbersFile,
  recordDurationSec,
  whatsappMaxVideoSizeMB = 16
}) {
  const { log, dbg, warn, err } = logger;
  const { normalizeBR, isNumberAuthorized } = utils;
  
  if (!accessToken || !phoneNumberId) {
    throw new Error('WHATSAPP_ACCESS_TOKEN e WHATSAPP_PHONE_NUMBER_ID são obrigatórios para usar a API oficial');
  }
  
  const BASE_URL = `https://graph.facebook.com/${apiVersion}`;
  const PHONE_NUMBER_ID = phoneNumberId;
  const ACCESS_TOKEN = accessToken;
  
  let isReady = true; // API oficial sempre está "pronta" (não precisa de QR)
  let tempVideoProcessor = null; // Função para processar vídeos temporários
  
  /**
   * Envia mensagem de texto
   */
  async function sendTextMessage(to, message) {
    try {
      const normalized = normalizeBR(to);
      const toNumber = normalized.replace(/^\+/, ''); // Remove o + para a API
      
      log(`[WHATSAPP-API] Enviando mensagem para ${toNumber}...`);
      
      const response = await axios.post(
        `${BASE_URL}/${PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: toNumber,
          type: 'text',
          text: {
            preview_url: false,
            body: message
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      const messageId = response.data.messages?.[0]?.id || 'unknown';
      log(`[WHATSAPP-API] ✅ Mensagem enviada com sucesso para ${toNumber}: ${messageId}`);
      
      // Retorna formato compatível com whatsapp-web.js
      return {
        id: {
          _serialized: messageId
        },
        ...response.data
      };
    } catch (error) {
      // Log detalhado do erro
      if (error.response?.data) {
        const errorData = error.response.data;
        err(`[WHATSAPP-API] ❌ Erro ao enviar mensagem para ${to}:`, errorData);
        
        // Erros comuns do WhatsApp Business API
        if (errorData.error) {
          const errorCode = errorData.error.code;
          const errorMessage = errorData.error.message;
          
          if (errorCode === 131047) {
            err(`[WHATSAPP-API] ⚠️ Número não está no WhatsApp ou formato inválido`);
          } else if (errorCode === 131026) {
            err(`[WHATSAPP-API] ⚠️ Janela de 24h expirada. Use template message ou aguarde o usuário iniciar conversa.`);
          } else if (errorCode === 131031) {
            err(`[WHATSAPP-API] ⚠️ Número bloqueado ou não autorizado`);
          }
          
          dbg(`[WHATSAPP-API] Código de erro: ${errorCode}, Mensagem: ${errorMessage}`);
        }
        
        dbg(`[WHATSAPP-API] Detalhes completos:`, JSON.stringify(errorData, null, 2));
      } else {
        err(`[WHATSAPP-API] ❌ Erro ao enviar mensagem para ${to}:`, error.message);
      }
      throw error;
    }
  }
  
  /**
   * Envia mensagem com botões interativos
   */
  async function sendInteractiveButtons(to, text, buttons, footer = null) {
    try {
      const normalized = normalizeBR(to);
      const toNumber = normalized.replace(/^\+/, '');
      
      const interactive = {
        type: 'button',
        body: {
          text: text
        },
        action: {
          buttons: buttons.map((btn, index) => ({
            type: 'reply',
            reply: {
              id: btn.id || `btn_${index}`,
              title: btn.title || btn.body
            }
          }))
        }
      };
      
      if (footer) {
        interactive.footer = { text: footer };
      }
      
      const response = await axios.post(
        `${BASE_URL}/${PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: toNumber,
          type: 'interactive',
          interactive: interactive
        },
        {
          headers: {
            'Authorization': `Bearer ${ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      log(`[WHATSAPP-API] Mensagem interativa enviada para ${toNumber}`);
      return response.data;
    } catch (error) {
      err(`[WHATSAPP-API] Erro ao enviar botões interativos:`, error.response?.data || error.message);
      throw error;
    }
  }
  
  /**
   * Envia mensagem com lista interativa (List Message)
   */
  async function sendListMessage(to, title, description, buttonText, sections) {
    try {
      const normalized = normalizeBR(to);
      const toNumber = normalized.replace(/^\+/, '');
      
      const interactive = {
        type: 'list',
        body: {
          text: description
        },
        action: {
          button: buttonText,
          sections: sections
        },
        header: {
          type: 'text',
          text: title
        }
      };
      
      const response = await axios.post(
        `${BASE_URL}/${PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: toNumber,
          type: 'interactive',
          interactive: interactive
        },
        {
          headers: {
            'Authorization': `Bearer ${ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      log(`[WHATSAPP-API] List Message enviada para ${toNumber}`);
      return response.data;
    } catch (error) {
      err(`[WHATSAPP-API] Erro ao enviar List Message:`, error.response?.data || error.message);
      throw error;
    }
  }
  
  /**
   * Faz upload de mídia (base64) para a API do WhatsApp e retorna o media ID
   */
  async function uploadMedia(base64Data, mimeType) {
    try {
      // Converte base64 para buffer
      const buffer = Buffer.from(base64Data, 'base64');
      
      // Determina o tipo de mídia baseado no mimeType
      let mediaType = 'image';
      if (mimeType.startsWith('video/')) {
        mediaType = 'video';
      } else if (mimeType.startsWith('application/') || mimeType.includes('document')) {
        mediaType = 'document';
      }
      
      // Faz upload usando FormData
      const FormData = require('form-data');
      const form = new FormData();
      form.append('messaging_product', 'whatsapp');
      form.append('type', mediaType);
      
      // Determina extensão do arquivo
      let extension = 'jpg';
      if (mimeType.includes('jpeg') || mimeType.includes('jpg')) {
        extension = 'jpg';
      } else if (mimeType.includes('png')) {
        extension = 'png';
      } else if (mimeType.includes('gif')) {
        extension = 'gif';
      } else if (mimeType.includes('webp')) {
        extension = 'webp';
      } else {
        const parts = mimeType.split('/');
        if (parts.length > 1) {
          extension = parts[1].split(';')[0]; // Remove parâmetros como 'charset=utf-8'
        }
      }
      
      form.append('file', buffer, {
        filename: `media.${extension}`,
        contentType: mimeType
      });
      
      const response = await axios.post(
        `${BASE_URL}/${PHONE_NUMBER_ID}/media`,
        form,
        {
          headers: {
            'Authorization': `Bearer ${ACCESS_TOKEN}`,
            ...form.getHeaders()
          }
        }
      );
      
      const mediaId = response.data.id;
      log(`[WHATSAPP-API] Mídia enviada com sucesso, media ID: ${mediaId}`);
      return mediaId;
    } catch (error) {
      err(`[WHATSAPP-API] Erro ao fazer upload de mídia:`, error.response?.data || error.message);
      throw error;
    }
  }
  
  /**
   * Envia mídia (imagem, vídeo, documento) usando URL ou media ID
   */
  async function sendMedia(to, mediaUrl, mediaType, caption = null) {
    try {
      const normalized = normalizeBR(to);
      const toNumber = normalized.replace(/^\+/, '');
      
      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: toNumber,
        type: mediaType
      };
      
      if (mediaType === 'image') {
        payload.image = { link: mediaUrl };
        if (caption) payload.image.caption = caption;
      } else if (mediaType === 'video') {
        payload.video = { link: mediaUrl };
        if (caption) payload.video.caption = caption;
      } else if (mediaType === 'document') {
        payload.document = { link: mediaUrl };
        if (caption) payload.document.caption = caption;
      }
      
      const response = await axios.post(
        `${BASE_URL}/${PHONE_NUMBER_ID}/messages`,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      log(`[WHATSAPP-API] Mídia ${mediaType} enviada para ${toNumber}`);
      return response.data;
    } catch (error) {
      err(`[WHATSAPP-API] Erro ao enviar mídia:`, error.response?.data || error.message);
      throw error;
    }
  }
  
  /**
   * Envia mídia usando media ID (após upload)
   */
  async function sendMediaById(to, mediaId, mediaType, caption = null) {
    try {
      const normalized = normalizeBR(to);
      const toNumber = normalized.replace(/^\+/, '');
      
      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: toNumber,
        type: mediaType
      };
      
      if (mediaType === 'image') {
        payload.image = { id: mediaId };
        if (caption) payload.image.caption = caption;
      } else if (mediaType === 'video') {
        payload.video = { id: mediaId };
        if (caption) payload.video.caption = caption;
      } else if (mediaType === 'document') {
        payload.document = { id: mediaId };
        if (caption) payload.document.caption = caption;
      }
      
      const response = await axios.post(
        `${BASE_URL}/${PHONE_NUMBER_ID}/messages`,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      log(`[WHATSAPP-API] Mídia ${mediaType} (ID: ${mediaId}) enviada para ${toNumber}`);
      
      // Retorna formato compatível com whatsapp-web.js
      return {
        id: {
          _serialized: response.data.messages?.[0]?.id || 'unknown'
        },
        ...response.data
      };
    } catch (error) {
      err(`[WHATSAPP-API] Erro ao enviar mídia por ID:`, error.response?.data || error.message);
      throw error;
    }
  }
  
  /**
   * Envia mídia a partir de base64 (faz upload e envia)
   */
  async function sendMediaFromBase64(to, base64Data, mimeType, caption = null) {
    try {
      // Determina o tipo de mídia
      let mediaType = 'image';
      if (mimeType.startsWith('video/')) {
        mediaType = 'video';
      } else if (mimeType.startsWith('application/') || mimeType.includes('document')) {
        mediaType = 'document';
      }
      
      // Faz upload da mídia
      const mediaId = await uploadMedia(base64Data, mimeType);
      
      // Envia usando o media ID
      return await sendMediaById(to, mediaId, mediaType, caption);
    } catch (error) {
      err(`[WHATSAPP-API] Erro ao enviar mídia de base64:`, error.message);
      throw error;
    }
  }
  
  /**
   * Verifica assinatura do webhook (para validação inicial)
   */
  function verifyWebhook(mode, token, signature) {
    if (mode === 'subscribe' && token === webhookVerifyToken) {
      return true;
    }
    
    // Verifica assinatura HMAC
    if (signature) {
      const expectedSignature = crypto
        .createHmac('sha256', webhookVerifyToken)
        .update(JSON.stringify(signature))
        .digest('hex');
      
      return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature)
      );
    }
    
    return false;
  }
  
  /**
   * Processa mensagem recebida do webhook
   */
  async function processWebhookMessage(entry) {
    try {
      for (const change of entry.changes || []) {
        if (change.value?.messages) {
          for (const message of change.value.messages) {
            const from = message.from;
            const messageType = message.type;
            const messageId = message.id;
            
            log(`[WHATSAPP-API] Processando mensagem tipo: ${messageType} de ${from} (ID: ${messageId})`);
            dbg(`[WHATSAPP-API] Mensagem completa:`, JSON.stringify(message, null, 2));
            
            // Processa mensagens interativas (botões e listas)
            if (messageType === 'interactive') {
              const interactiveResponse = message.interactive;
              
              log(`[WHATSAPP-API] Mensagem interativa detectada: tipo=${interactiveResponse?.type}`);
              
              // Resposta de botão interativo
              if (interactiveResponse?.type === 'button_reply') {
                const buttonId = interactiveResponse.button_reply?.id;
                const buttonTitle = interactiveResponse.button_reply?.title || '';
                log(`[WHATSAPP-API] Botão clicado: ID="${buttonId}", Título="${buttonTitle}" por ${from}`);
                await handleInteractiveResponse(from, buttonId, buttonTitle);
                continue;
              }
              
              // Resposta de lista
              if (interactiveResponse?.type === 'list_reply') {
                const listId = interactiveResponse.list_reply?.id;
                const listTitle = interactiveResponse.list_reply?.title || '';
                log(`[WHATSAPP-API] Item de lista selecionado: ID="${listId}", Título="${listTitle}" por ${from}`);
                await handleInteractiveResponse(from, listId, listTitle);
                continue;
              }
              
              warn(`[WHATSAPP-API] Tipo interativo desconhecido: ${interactiveResponse?.type}`);
            }
            
            // Processa mensagens de texto
            if (messageType === 'text') {
              const text = message.text?.body || '';
              
              // Verifica se há resposta interativa dentro da mensagem de texto (compatibilidade)
              const interactiveResponse = message.interactive;
              if (interactiveResponse?.type === 'button_reply') {
                const buttonId = interactiveResponse.button_reply?.id;
                log(`[WHATSAPP-API] Resposta de botão detectada em mensagem de texto: ID="${buttonId}" por ${from}`);
                await handleInteractiveResponse(from, buttonId, text);
                continue;
              }
              if (interactiveResponse?.type === 'list_reply') {
                const listId = interactiveResponse.list_reply?.id;
                log(`[WHATSAPP-API] Resposta de lista detectada em mensagem de texto: ID="${listId}" por ${from}`);
                await handleInteractiveResponse(from, listId, text);
                continue;
              }
              
              // Verifica se há context (pode indicar resposta a botão)
              if (message.context) {
                log(`[WHATSAPP-API] Mensagem de texto com context detectada de ${from}. Context:`, JSON.stringify(message.context));
                // Se o texto corresponde a um ID de botão conhecido, trata como resposta interativa
                if (text === 'btn_ver_opcoes' || text.toLowerCase().includes('ver opções') || text.toLowerCase().includes('ver opcoes')) {
                  log(`[WHATSAPP-API] Texto parece ser resposta de botão: "${text}"`);
                  await handleInteractiveResponse(from, 'btn_ver_opcoes', text);
                  continue;
                }
              }
              
              // Mensagem de texto normal
              await handleTextMessage(from, text, messageId);
              continue;
            }
            
            dbg(`[WHATSAPP-API] Tipo de mensagem não processado: ${messageType}`);
          }
        }
      }
    } catch (error) {
      err(`[WHATSAPP-API] Erro ao processar webhook:`, error.message);
      dbg(`[WHATSAPP-API] Stack trace:`, error.stack);
    }
  }
  
  /**
   * Envia menu principal (agora envia diretamente o menu completo)
   */
  async function sendMainMenu(to) {
    // Envia diretamente o menu completo de opções
    await sendOptionsMenu(to);
  }
  
  /**
   * Envia menu de duração de vídeo
   */
  async function sendVideoDurationMenu(to) {
    try {
      const sections = [{
        title: 'Duração da Gravação',
        rows: [
          {
            id: 'record_10',
            title: '⏱️ 10 segundos',
            description: 'Gravação rápida'
          },
          {
            id: 'record_30',
            title: '⏱️ 30 segundos',
            description: 'Duração padrão'
          },
          {
            id: 'record_60',
            title: '⏱️ 60 segundos',
            description: '1 minuto'
          },
          {
            id: 'record_90',
            title: '⏱️ 90 segundos',
            description: '1 minuto e meio'
          },
          {
            id: 'record_120',
            title: '⏱️ 120 segundos',
            description: '2 minutos (máximo)'
          }
        ]
      }];
      
      // Tenta enviar como List Message
      try {
        await sendListMessage(
          to,
          '🎥 Gravar Vídeo',
          'Selecione a duração da gravação:',
          'Escolher Duração',
          sections
        );
        log(`[MENU] Menu de duração de vídeo enviado como List Message para ${to}`);
        return;
      } catch (listError) {
        dbg(`[MENU] List Message não suportado, usando botões: ${listError.message}`);
        // Fallback: botões interativos
        try {
          await sendInteractiveButtons(
            to,
            '🎥 *Gravar Vídeo*\n\n*Selecione a duração:*\n\n' +
            '⏱️ *10 segundos* - Gravação rápida\n\n' +
            '⏱️ *30 segundos* - Duração padrão\n\n' +
            '⏱️ *60 segundos* - 1 minuto\n\n' +
            '⏱️ *90 segundos* - 1 minuto e meio\n\n' +
            '⏱️ *120 segundos* - 2 minutos (máximo)',
            [
              { id: 'record_10', title: '⏱️ 10s' },
              { id: 'record_30', title: '⏱️ 30s' },
              { id: 'record_60', title: '⏱️ 60s' },
              { id: 'record_90', title: '⏱️ 90s' },
              { id: 'record_120', title: '⏱️ 120s' }
            ],
            'WhatsApp API - Controle Inteligente'
          );
          log(`[MENU] Menu de duração de vídeo enviado como botões para ${to}`);
          return;
        } catch (buttonError) {
          dbg(`[MENU] Botões não suportados, usando texto: ${buttonError.message}`);
        }
      }
      
      // Fallback final: texto
      const textMenu = '🎥 *Gravar Vídeo*\n\n' +
        'Selecione a duração:\n\n' +
        '⏱️ *10 segundos* - Digite: `!record 10`\n' +
        '⏱️ *30 segundos* - Digite: `!record 30`\n' +
        '⏱️ *60 segundos* - Digite: `!record 60`\n' +
        '⏱️ *90 segundos* - Digite: `!record 90`\n' +
        '⏱️ *120 segundos* - Digite: `!record 120`\n\n' +
        '💡 *Dica:* Você também pode usar `!record` para gravar 30 segundos (padrão).';
      await sendTextMessage(to, textMenu);
      log(`[MENU] Menu de duração de vídeo enviado como texto para ${to}`);
    } catch (e) {
      err(`[MENU] Erro ao enviar menu de duração de vídeo:`, e.message);
      try {
        await sendTextMessage(to, '🎥 Gravar Vídeo\n\nDigite: `!record` ou `!record 30` para gravar vídeo.');
      } catch (e2) {
        err(`[MENU] Erro no fallback final:`, e2.message);
      }
    }
  }
  
  /**
   * Envia menu de opções (List Message)
   */
  async function sendOptionsMenu(to) {
    try {
      const sections = [{
        title: 'Opções Disponíveis',
        rows: [
          {
            id: 'opt_tuya_list',
            title: '📋 Dispositivos Tuya',
            description: 'Listar e gerenciar seus dispositivos Tuya'
          },
          {
            id: 'opt_tuya_status',
            title: '⚡ Status do Dispositivo',
            description: 'Consultar status de um dispositivo específico'
          },
          {
            id: 'opt_tuya_count',
            title: '💡 Luzes Ligadas',
            description: 'Ver quantas luzes estão ligadas (lâmpadas e interruptores)'
          },
          {
            id: 'opt_blocked_ips',
            title: '🛡️ IPs Bloqueados',
            description: 'Ver lista de IPs bloqueados por segurança'
          },
          {
            id: 'opt_record',
            title: '🎥 Gravar Vídeo',
            description: 'Gravar vídeo da câmera (padrão: 30 segundos)'
          },
          {
            id: 'opt_help',
            title: '❓ Ajuda',
            description: 'Ver comandos disponíveis e ajuda'
          }
        ]
      }];
      
      // Tenta enviar como List Message
      try {
        await sendListMessage(
          to,
          '🏠 Menu Principal',
          'Selecione uma opção para continuar:',
          'Ver opções',
          sections
        );
        log(`[MENU] Menu de opções enviado como List Message para ${to}`);
        return;
      } catch (listError) {
        dbg(`[MENU] List Message não suportado, usando botões: ${listError.message}`);
        // Fallback: botões interativos
        try {
          await sendInteractiveButtons(
            to,
            '🏠 *Menu Principal*\n\n*Selecione uma opção:*\n\n' +
            '📋 *Dispositivos Tuya*\n   Listar e gerenciar dispositivos\n\n' +
            '⚡ *Status do Dispositivo*\n   Consultar status específico\n\n' +
            '💡 *Luzes Ligadas*\n   Ver quantas luzes estão ligadas (lâmpadas e interruptores)\n\n' +
            '🛡️ *IPs Bloqueados*\n   Ver lista de IPs bloqueados por segurança\n\n' +
            '🎥 *Gravar Vídeo*\n   Gravar vídeo da câmera\n\n' +
            '❓ *Ajuda*\n   Ver comandos disponíveis',
            [
              { id: 'opt_tuya_list', title: '📋 Dispositivos' },
              { id: 'opt_tuya_status', title: '⚡ Status' },
              { id: 'opt_tuya_count', title: '💡 Lâmpadas' },
              { id: 'opt_blocked_ips', title: '🛡️ IPs' },
              { id: 'opt_record', title: '🎥 Gravar' },
              { id: 'opt_help', title: '❓ Ajuda' }
            ],
            'WhatsApp API - Controle Inteligente'
          );
          log(`[MENU] Menu de opções enviado como botões para ${to}`);
          return;
        } catch (buttonError) {
          dbg(`[MENU] Botões não suportados, usando texto: ${buttonError.message}`);
          // Fallback final: texto
          const textMenu = '🏠 *Menu Principal*\n\n' +
            '📋 *1. Dispositivos Tuya*\n   Digite: `!tuya list`\n\n' +
            '⚡ *2. Status do Dispositivo*\n   Digite: `!tuya status <nome>`\n\n' +
            '💡 *3. Luzes Ligadas*\n   Digite: `!tuya count`\n\n' +
            '🛡️ *4. IPs Bloqueados*\n   Digite: `!blocked` ou `!ips`\n\n' +
            '🎥 *5. Gravar Vídeo*\n   Digite: `!record` ou `!record 30`\n\n' +
            '❓ *6. Ajuda*\n   Digite: `!tuya help`\n\n' +
            '💡 *Dica:* Você também pode clicar nos botões acima (se disponível).';
          await sendTextMessage(to, textMenu);
          log(`[MENU] Menu de opções enviado como texto para ${to}`);
        }
      }
    } catch (e) {
      err(`[MENU] Erro ao enviar menu de opções:`, e.message);
      // Último fallback
      try {
        await sendTextMessage(to, '🏠 Menu Principal\n\nDigite:\n- !tuya list\n- !tuya status <nome>\n- !tuya count\n- !blocked (IPs bloqueados)\n- !record\n- !tuya help');
      } catch (e2) {
        err(`[MENU] Erro no fallback final:`, e2.message);
      }
    }
  }
  
  /**
   * Envia lista de dispositivos Tuya
   */
  async function sendDevicesList(to, devices) {
    try {
      if (!devices || devices.length === 0) {
        await sendTextMessage(to, '❌ Nenhum dispositivo encontrado.');
        return;
      }
      
      // Tenta enviar como List Message
      try {
        const limitedDevices = devices.slice(0, 10);
        const sections = [{
          title: 'Dispositivos Disponíveis',
          rows: limitedDevices.map((device, index) => {
            const status = device.online ? '🟢' : '🔴';
            const powered = device.poweredOn ? '⚡' : '⚫';
            return {
              id: `device_${device.id}`,
              title: `${status} ${device.name || `Dispositivo ${index + 1}`}`,
              description: `${powered} ${device.category || 'Sem categoria'}`
            };
          })
        }];
        
        await sendListMessage(
          to,
          '📋 Dispositivos Tuya',
          `Selecione um dispositivo (${limitedDevices.length} de ${devices.length}):`,
          'Ver Dispositivos',
          sections
        );
        log(`[MENU] Lista de ${limitedDevices.length} dispositivo(s) enviada como List Message para ${to}`);
        return;
      } catch (listError) {
        dbg(`[MENU] List Message não suportado, usando texto: ${listError.message}`);
      }
      
      // Fallback: mensagem de texto formatada
      if (tuya && tuya.formatDevicesListMessage) {
        const textList = tuya.formatDevicesListMessage(devices);
        await sendTextMessage(to, textList);
        log(`[MENU] Lista de ${devices.length} dispositivo(s) enviada como texto para ${to}`);
      } else {
        await sendTextMessage(to, `📋 *Dispositivos Tuya*\n\n${devices.length} dispositivo(s) encontrado(s).`);
      }
    } catch (e) {
      err(`[MENU] Erro ao enviar lista de dispositivos:`, e.message);
      try {
        await sendTextMessage(to, `❌ Erro ao listar dispositivos: ${e.message}`);
      } catch (e2) {
        err(`[MENU] Erro no fallback final:`, e2.message);
      }
    }
  }
  
  /**
   * Processa gravação de vídeo RTSP
   */
  async function processVideoRecording(to, duration = 30) {
    if (!camera) {
      await sendTextMessage(to, '❌ Módulo de câmera não configurado.');
      return;
    }
    
    const rtspUrl = camera.buildRTSPUrl();
    if (!rtspUrl) {
      await sendTextMessage(to, '❌ Gravação não configurada. Configure CAMERA_RTSP_URL ou CAMERA_USER/CAMERA_PASS.');
      return;
    }
    
    const finalDuration = Math.min(Math.max(5, duration), 120);
    
    if (duration > 120) {
      await sendTextMessage(to, `⚠️ Duração limitada a 120 segundos (solicitado: ${duration}s)`);
    }
    
    log(`[CMD] Iniciando gravação de ${finalDuration} segundos para ${to}`);
    await sendTextMessage(to, `⏳ Iniciando gravação de ${finalDuration} segundos...`);
    
    // Processa gravação em background
    (async () => {
      try {
        const fakeMessage = {
          from: to,
          reply: async (text) => {
            await sendTextMessage(to, text);
          }
        };
        
        const result = await camera.recordRTSPVideo(rtspUrl, finalDuration, fakeMessage);
        
        log(`[RECORD] Resultado da gravação: success=${result.success}, filePath=${result.filePath}, error=${result.error || 'none'}`);
        
        if (!result.success) {
          err(`[RECORD] Gravação falhou: ${result.error || 'Erro desconhecido'}`);
          await sendTextMessage(to, `❌ Erro na gravação: ${result.error || 'Erro desconhecido'}`);
          return;
        }
        
        if (!result.filePath) {
          err(`[RECORD] Gravação concluída mas sem caminho do arquivo`);
          await sendTextMessage(to, `❌ Erro: Arquivo de vídeo não foi gerado`);
          return;
        }
        
        const fs = require('fs');
        if (!fs.existsSync(result.filePath)) {
          err(`[RECORD] Arquivo não encontrado: ${result.filePath}`);
          await sendTextMessage(to, `❌ Erro: Arquivo de vídeo não encontrado`);
          return;
        }
        
        const originalFilePath = result.filePath;
        const fileStats = fs.statSync(originalFilePath);
        log(`[RECORD] Arquivo gerado: ${originalFilePath} (${(fileStats.size / 1024 / 1024).toFixed(2)} MB)`);
        
        if (fileStats.size === 0) {
          err(`[RECORD] Arquivo de vídeo está vazio (0 bytes)`);
          await sendTextMessage(to, `❌ Erro: Arquivo de vídeo está vazio`);
          return;
        }
        
        try {
          const finalVideoPath = await camera.compressVideoIfNeeded(originalFilePath, fakeMessage);
          const finalStats = fs.statSync(finalVideoPath);
          log(`[RECORD] Arquivo final para envio: ${finalVideoPath} (${(finalStats.size / 1024 / 1024).toFixed(2)} MB)`);
          
          // Divide vídeo em partes se necessário
          let videoParts;
          if (camera && camera.splitVideoIfNeeded) {
            videoParts = await camera.splitVideoIfNeeded(finalVideoPath);
            log(`[RECORD] Vídeo dividido em ${videoParts.length} parte(s)`);
          } else {
            // Fallback: usa o arquivo original se a função não estiver disponível
            warn(`[RECORD] Função splitVideoIfNeeded não disponível, usando arquivo original`);
            videoParts = [finalVideoPath];
          }
          
          // Envia cada parte
          for (let i = 0; i < videoParts.length; i++) {
            const partFile = videoParts[i];
            const partBuffer = fs.readFileSync(partFile);
            const partSizeMB = partBuffer.length / 1024 / 1024;
            
            const partNumber = videoParts.length > 1 ? ` (Parte ${i + 1}/${videoParts.length})` : '';
            const caption = `🎥 Gravação de ${finalDuration} segundos${partNumber}`;
            
            try {
              log(`[RECORD] Enviando parte ${i + 1}/${videoParts.length} para ${to} (${partSizeMB.toFixed(2)} MB)...`);
              const videoBase64 = partBuffer.toString('base64');
              await sendMediaFromBase64(to, videoBase64, 'video/mp4', caption);
              log(`[CMD] Parte ${i + 1}/${videoParts.length} enviada com sucesso para ${to}`);
              
              // Aguarda um pouco entre envios para não sobrecarregar
              if (i < videoParts.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 2000));
              }
              
              camera.cleanupVideoFile(partFile, `após envio da parte ${i + 1}`);
            } catch (sendError) {
              err(`[CMD] Erro ao enviar parte ${i + 1}/${videoParts.length}:`, sendError.message);
              await sendTextMessage(to, `❌ Erro ao enviar parte ${i + 1}/${videoParts.length}: ${sendError.message}`);
              camera.cleanupVideoFile(partFile, 'após erro no envio');
              // Continua tentando enviar as outras partes
            }
          }
          
          // Limpa arquivo original se ainda existir
          if (originalFilePath !== finalVideoPath && fs.existsSync(originalFilePath)) {
            camera.cleanupVideoFile(originalFilePath, 'após envio (arquivo original)');
          }
        } catch (sendError) {
          err(`[CMD] Erro ao processar/enviar vídeo:`, sendError.message);
          err(`[CMD] Stack trace:`, sendError.stack);
          await sendTextMessage(to, `❌ Erro ao enviar vídeo: ${sendError.message}`);
          if (fs.existsSync(originalFilePath)) {
            camera.cleanupVideoFile(originalFilePath, 'após erro no envio');
          }
        }
      } catch (e) {
        err(`[CMD] Erro ao processar gravação:`, e.message);
        await sendTextMessage(to, `❌ Erro ao processar gravação: ${e.message}`);
      }
    })();
  }
  
  /**
   * Processa mensagem de texto recebida
   */
  async function handleTextMessage(from, text, messageId) {
    dbg(`[WHATSAPP-API] Mensagem recebida de ${from}: "${text}"`);
    
    // Verifica autorização
    const isAuthorized = isNumberAuthorized(from, numbersFile, dbg);
    if (!isAuthorized) {
      dbg(`[WHATSAPP-API] Número ${from} não autorizado. Ignorando.`);
      return;
    }
    
    const msgLower = text.toLowerCase().trim();
    const msgBody = text.trim();
    
    // Processa saudações e envia menu principal
    const greetings = ['oi', 'olá', 'ola', 'hey', 'hi', 'hello', 'bom dia', 'boa tarde', 'boa noite', 'start', 'começar', 'comecar'];
    if (greetings.includes(msgLower)) {
      log(`[WHATSAPP-API] Saudação recebida de ${from}, enviando menu principal`);
      try {
        await sendMainMenu(from);
      } catch (e) {
        err(`[WHATSAPP-API] Falha ao enviar menu após saudação:`, e.message);
      }
      return;
    }
    
    // Processa comando !menu ou "menu"
    if (msgLower === '!menu' || msgLower === 'menu' || msgLower === 'início' || msgLower === 'inicio') {
      log(`[WHATSAPP-API] Comando !menu recebido de ${from}`);
      try {
        await sendMainMenu(from);
      } catch (e) {
        err(`[WHATSAPP-API] Falha ao enviar menu:`, e.message);
      }
      return;
    }
    
    // Processa botão "Ver opções" (mantido para compatibilidade, mas agora envia menu completo diretamente)
    if (text === 'btn_ver_opcoes' || msgLower === 'ver opções' || msgLower === 'ver opcoes' || msgLower === 'ver opção' || msgLower === 'ver opcao') {
      log(`[WHATSAPP-API] Botão "Ver opções" detectado de ${from}`);
      try {
        await sendOptionsMenu(from); // Agora envia menu completo diretamente
      } catch (e) {
        err(`[WHATSAPP-API] Erro ao processar "ver opções":`, e.message);
        await sendTextMessage(from, `❌ Erro: ${e.message}`);
      }
      return;
    }
    
    // Processa !ping
    if (msgLower === '!ping') {
      log(`[WHATSAPP-API] Comando !ping recebido de ${from}`);
      try {
        await sendTextMessage(from, 'pong');
      } catch (e) {
        err(`[WHATSAPP-API] Falha ao responder 'pong':`, e.message);
      }
      return;
    }
    
    // Comando !record - Grava vídeo RTSP
    const recordMatch = msgBody.match(/^!record(?:\s+(\d+))?$/i);
    if (recordMatch) {
      log(`[CMD] Comando !record recebido de ${from}`);
      const duration = recordMatch[1] ? parseInt(recordMatch[1], 10) : recordDurationSec;
      await processVideoRecording(from, duration);
      return;
    }
    
    // Comando !video <videoId> - Solicita vídeo temporário
    const videoMatch = msgBody.match(/^!video\s+(.+)$/i);
    if (videoMatch) {
      const videoId = videoMatch[1].trim();
      log(`[CMD] Comando !video recebido de ${from} para videoId: ${videoId}`);
      
      if (!tempVideoProcessor) {
        await sendTextMessage(from, '❌ Sistema de vídeos temporários não disponível.');
        return;
      }
      
      try {
        const result = tempVideoProcessor(videoId, from);
        
        if (!result.success) {
          await sendTextMessage(from, `❌ ${result.error || 'Erro ao processar vídeo'}`);
          return;
        }
        
        // Lê o arquivo de vídeo
        const fs = require('fs');
        if (!fs.existsSync(result.filePath)) {
          await sendTextMessage(from, '❌ Arquivo de vídeo não encontrado.');
          return;
        }
        
        // Divide vídeo em partes se necessário
        let videoParts;
        if (camera && camera.splitVideoIfNeeded) {
          videoParts = await camera.splitVideoIfNeeded(result.filePath);
          log(`[WHATSAPP-API] Vídeo dividido em ${videoParts.length} parte(s)`);
        } else {
          warn(`[WHATSAPP-API] Função splitVideoIfNeeded não disponível, usando arquivo original`);
          videoParts = [result.filePath];
        }
        
        // Envia cada parte
        for (let i = 0; i < videoParts.length; i++) {
          const partFile = videoParts[i];
          const partBuffer = fs.readFileSync(partFile);
          const partSizeMB = partBuffer.length / 1024 / 1024;
          
          const partNumber = videoParts.length > 1 ? ` (Parte ${i + 1}/${videoParts.length})` : '';
          const caption = `🎥 Vídeo da campainha (15 segundos)${partNumber}`;
          
          try {
            await sendTextMessage(from, `⏳ Enviando vídeo${partNumber}...`);
            const videoBase64 = partBuffer.toString('base64');
            await sendMediaFromBase64(from, videoBase64, 'video/mp4', caption);
            log(`[WHATSAPP-API] Parte ${i + 1}/${videoParts.length} do vídeo ${videoId} enviada via comando !video para ${from}`);
            
            // Aguarda entre envios
            if (i < videoParts.length - 1) {
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
            
            camera.cleanupVideoFile(partFile, `após envio da parte ${i + 1}`);
          } catch (sendError) {
            err(`[WHATSAPP-API] Erro ao enviar parte ${i + 1}/${videoParts.length}:`, sendError.message);
            await sendTextMessage(from, `❌ Erro ao enviar parte ${i + 1}/${videoParts.length}: ${sendError.message}`);
            camera.cleanupVideoFile(partFile, 'após erro no envio');
          }
        }
      } catch (e) {
        err(`[WHATSAPP-API] Erro ao enviar vídeo via comando:`, e.message);
        await sendTextMessage(from, `❌ Erro ao enviar vídeo: ${e.message}`);
      }
      return;
    }
    
    // Comandos Tuya
    if (tuya && tuya.formatHelpMessage) {
      // !tuya help
      if (msgLower === '!tuya help' || msgLower === '!tuya') {
        log(`[CMD-TUYA] Comando help recebido de ${from}`);
        try {
          const helpMsg = tuya.formatHelpMessage();
          await sendTextMessage(from, helpMsg);
        } catch (e) {
          err(`[CMD-TUYA] Falha ao enviar ajuda:`, e.message);
        }
        return;
      }
      
      // !tuya list
      if (msgLower === '!tuya list') {
        log(`[CMD-TUYA] Comando list recebido de ${from}`);
        try {
          await sendTextMessage(from, '⏳ Buscando seus dispositivos...');
          const devices = await tuya.getCachedDevices();
          await sendDevicesList(from, devices);
        } catch (e) {
          err(`[CMD-TUYA] Erro ao listar dispositivos:`, e.message);
          await sendTextMessage(from, `❌ *Erro ao listar dispositivos:*\n${e.message}`);
        }
        return;
      }
      
      // !tuya count
      if (msgLower === '!tuya count') {
        log(`[CMD-TUYA] Comando count recebido de ${from}`);
        try {
          await sendTextMessage(from, '⏳ Contando luzes ligadas...');
          const countData = await tuya.countPoweredOnDevices(null, true); // null = usa UID padrão, true = apenas luzes (lâmpadas e interruptores)
          const message = tuya.formatCountMessage(countData, true);
          await sendTextMessage(from, message);
        } catch (e) {
          err(`[CMD-TUYA] Erro ao contar dispositivos:`, e.message);
          await sendTextMessage(from, `❌ *Erro ao contar dispositivos:*\n${e.message}`);
        }
        return;
      }
      
      // !blocked ou !ips - Lista IPs bloqueados
      if (msgLower === '!blocked' || msgLower === '!ips' || msgLower === '!blocked ips') {
        log(`[CMD] Comando blocked/ips recebido de ${from}`);
        try {
          if (ipBlocker && ipBlocker.listBlockedIPs) {
            await sendTextMessage(from, '⏳ Buscando IPs bloqueados...');
            const blockedIPs = await ipBlocker.listBlockedIPs(50, 0); // Limite de 50 IPs
            const total = await ipBlocker.countBlockedIPs();
            
            if (blockedIPs.length === 0) {
              await sendTextMessage(from, '✅ *IPs Bloqueados*\n\nNenhum IP bloqueado no momento.');
            } else {
              let message = `🛡️ *IPs Bloqueados*\n\n`;
              message += `*Total:* ${total} IP(s) bloqueado(s)\n\n`;
              message += `*Últimos ${blockedIPs.length} bloqueios:*\n\n`;
              
              blockedIPs.forEach((ipData, index) => {
                const blockedDate = new Date(ipData.blocked_at * 1000).toLocaleString('pt-BR');
                const lastSeen = ipData.last_seen ? new Date(ipData.last_seen * 1000).toLocaleString('pt-BR') : 'Nunca';
                message += `${index + 1}. *${ipData.ip}*\n`;
                message += `   📅 Bloqueado: ${blockedDate}\n`;
                message += `   👁️ Última tentativa: ${lastSeen}\n`;
                message += `   🔢 Tentativas: ${ipData.request_count || 0}\n`;
                message += `   📝 Motivo: ${ipData.reason || 'Não especificado'}\n\n`;
              });
              
              if (total > blockedIPs.length) {
                message += `\n💡 Mostrando ${blockedIPs.length} de ${total} IP(s) bloqueado(s).`;
              }
              
              await sendTextMessage(from, message);
            }
          } else {
            await sendTextMessage(from, '❌ Módulo de bloqueio de IPs não configurado.');
          }
        } catch (e) {
          err(`[CMD] Erro ao listar IPs bloqueados:`, e.message);
          await sendTextMessage(from, `❌ *Erro ao listar IPs bloqueados:*\n${e.message}`);
        }
        return;
      }
      
      // !tuya status <identificador>
      if (msgLower.startsWith('!tuya status ')) {
        const identifier = msgBody.substring(13).trim();
        if (!identifier) {
          await sendTextMessage(from, '❌ *Erro:* Identificador não fornecido.\nUse: `!tuya status 1` ou `!tuya status Nome do Dispositivo`');
          return;
        }
        
        log(`[CMD-TUYA] Comando status recebido de ${from} para: ${identifier}`);
        try {
          await sendTextMessage(from, '⏳ Consultando dispositivo...');
          
          let device = null;
          let deviceId = identifier;
          
          try {
            const devices = await tuya.getCachedDevices();
            device = tuya.findDeviceByIdentifier(identifier, devices);
            if (device) {
              deviceId = device.id;
              log(`[CMD-TUYA] Dispositivo encontrado: ${device.name} (${deviceId})`);
            }
          } catch (e) {
            dbg(`[CMD-TUYA] Não foi possível buscar na lista, tentando diretamente com ID: ${e.message}`);
          }
          
          const status = await tuya.getDeviceStatus(deviceId);
          const poweredOn = status.filter(s => {
            const code = s.code?.toLowerCase() || '';
            const value = s.value;
            if (code.includes('switch') || code.includes('power')) {
              return value === true || value === 1 || value === 'true' || value === 'on';
            }
            return false;
          }).length > 0;
          
          const deviceName = device ? device.name : deviceId;
          const responseMsg = tuya.formatDeviceStatusMessage(deviceName, status, poweredOn);
          await sendTextMessage(from, responseMsg);
        } catch (e) {
          err(`[CMD-TUYA] Erro ao consultar status:`, e.message);
          await sendTextMessage(from, `❌ *Erro ao consultar dispositivo:*\n${e.message}`);
        }
        return;
      }
      
      // !tuya on <identificador>
      if (msgLower.startsWith('!tuya on ')) {
        const identifier = msgBody.substring(9).trim();
        if (!identifier) {
          await sendTextMessage(from, '❌ *Erro:* Identificador não fornecido.\nUse: `!tuya on 1` ou `!tuya on Nome do Dispositivo`');
          return;
        }
        
        log(`[CMD-TUYA] Comando on recebido de ${from} para: ${identifier}`);
        try {
          await sendTextMessage(from, '⏳ Ligando dispositivo...');
          const devices = await tuya.getCachedDevices();
          const device = tuya.findDeviceByIdentifier(identifier, devices);
          
          if (!device) {
            await sendTextMessage(from, `❌ *Dispositivo não encontrado:* "${identifier}"\n\n💡 Use \`!tuya list\` para ver todos os dispositivos disponíveis.`);
            return;
          }
          
          const status = await tuya.getDeviceStatus(device.id);
          const switchCode = tuya.findSwitchCode(status);
          
          if (!switchCode) {
            await sendTextMessage(from, `❌ *Erro:* Não foi possível encontrar o código de switch/power para este dispositivo.`);
            return;
          }
          
          await tuya.sendCommand(device.id, [{ code: switchCode, value: true }]);
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          await sendTextMessage(from, `✅ *Dispositivo ligado!*\n\n*Nome:* ${device.name}`);
        } catch (e) {
          err(`[CMD-TUYA] Erro ao ligar dispositivo:`, e.message);
          await sendTextMessage(from, `❌ *Erro ao ligar dispositivo:*\n${e.message}`);
        }
        return;
      }
      
      // !tuya off <identificador>
      if (msgLower.startsWith('!tuya off ')) {
        const identifier = msgBody.substring(10).trim();
        if (!identifier) {
          await sendTextMessage(from, '❌ *Erro:* Identificador não fornecido.\nUse: `!tuya off 1` ou `!tuya off Nome do Dispositivo`');
          return;
        }
        
        log(`[CMD-TUYA] Comando off recebido de ${from} para: ${identifier}`);
        try {
          await sendTextMessage(from, '⏳ Desligando dispositivo...');
          const devices = await tuya.getCachedDevices();
          const device = tuya.findDeviceByIdentifier(identifier, devices);
          
          if (!device) {
            await sendTextMessage(from, `❌ *Dispositivo não encontrado:* "${identifier}"\n\n💡 Use \`!tuya list\` para ver todos os dispositivos disponíveis.`);
            return;
          }
          
          const status = await tuya.getDeviceStatus(device.id);
          const switchCode = tuya.findSwitchCode(status);
          
          if (!switchCode) {
            await sendTextMessage(from, `❌ *Erro:* Não foi possível encontrar o código de switch/power para este dispositivo.`);
            return;
          }
          
          await tuya.sendCommand(device.id, [{ code: switchCode, value: false }]);
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          await sendTextMessage(from, `✅ *Dispositivo desligado!*\n\n*Nome:* ${device.name}`);
        } catch (e) {
          err(`[CMD-TUYA] Erro ao desligar dispositivo:`, e.message);
          await sendTextMessage(from, `❌ *Erro ao desligar dispositivo:*\n${e.message}`);
        }
        return;
      }
      
      // !tuya toggle <identificador>
      if (msgLower.startsWith('!tuya toggle ')) {
        const identifier = msgBody.substring(13).trim();
        if (!identifier) {
          await sendTextMessage(from, '❌ *Erro:* Identificador não fornecido.\nUse: `!tuya toggle 1` ou `!tuya toggle Nome do Dispositivo`');
          return;
        }
        
        log(`[CMD-TUYA] Comando toggle recebido de ${from} para: ${identifier}`);
        try {
          await sendTextMessage(from, '⏳ Alternando estado do dispositivo...');
          const devices = await tuya.getCachedDevices();
          const device = tuya.findDeviceByIdentifier(identifier, devices);
          
          if (!device) {
            await sendTextMessage(from, `❌ *Dispositivo não encontrado:* "${identifier}"\n\n💡 Use \`!tuya list\` para ver todos os dispositivos disponíveis.`);
            return;
          }
          
          const status = await tuya.getDeviceStatus(device.id);
          const switchCode = tuya.findSwitchCode(status);
          
          if (!switchCode) {
            await sendTextMessage(from, `❌ *Erro:* Não foi possível encontrar o código de switch/power para este dispositivo.`);
            return;
          }
          
          const currentSwitch = status.find(s => s.code?.toLowerCase() === switchCode.toLowerCase());
          const currentValue = currentSwitch?.value;
          const isOn = currentValue === true || currentValue === 1 || currentValue === 'true' || currentValue === 'on';
          
          await tuya.sendCommand(device.id, [{ code: switchCode, value: !isOn }]);
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          await sendTextMessage(from, `✅ *Estado alternado!*\n\n*Nome:* ${device.name}`);
        } catch (e) {
          err(`[CMD-TUYA] Erro ao alternar dispositivo:`, e.message);
          await sendTextMessage(from, `❌ *Erro ao alternar dispositivo:*\n${e.message}`);
        }
        return;
      }
    }
    
    log(`[WHATSAPP-API] Mensagem não processada de ${from}: ${text}`);
  }
  
  /**
   * Processa resposta de botão/lista interativa
   */
  async function handleInteractiveResponse(from, responseId, text) {
    log(`[WHATSAPP-API] Resposta interativa recebida de ${from}: ID="${responseId}", Texto="${text}"`);
    
    const isAuthorized = isNumberAuthorized(from, numbersFile, dbg);
    if (!isAuthorized) {
      warn(`[WHATSAPP-API] Número ${from} não autorizado para resposta interativa`);
      return;
    }
    
    // Processa botão "Ver opções"
    if (responseId === 'btn_ver_opcoes') {
      log(`[WHATSAPP-API] Botão "Ver opções" clicado por ${from}`);
      try {
        await sendOptionsMenu(from);
      } catch (e) {
        err(`[WHATSAPP-API] Erro ao processar btn_ver_opcoes:`, e.message);
        await sendTextMessage(from, `❌ Erro: ${e.message}`);
      }
      return;
    }
    
    // Processa opções do menu
    if (responseId === 'opt_tuya_list') {
      log(`[WHATSAPP-API] Opção "Dispositivos Tuya" selecionada por ${from}`);
      try {
        await sendTextMessage(from, '⏳ Buscando seus dispositivos...');
        if (tuya) {
          const devices = await tuya.getCachedDevices();
          await sendDevicesList(from, devices);
        } else {
          await sendTextMessage(from, '❌ Módulo Tuya não configurado.');
        }
      } catch (e) {
        err(`[WHATSAPP-API] Erro ao processar opt_tuya_list:`, e.message);
        await sendTextMessage(from, `❌ Erro: ${e.message}`);
      }
      return;
    }
    
    if (responseId === 'opt_tuya_status') {
      log(`[WHATSAPP-API] Opção "Status do Dispositivo" selecionada por ${from}`);
      try {
        await sendTextMessage(from, '⏳ Buscando seus dispositivos...');
        if (tuya) {
          const devices = await tuya.getCachedDevices();
          if (devices && devices.length > 0) {
            await sendTextMessage(from, '📋 *Status do Dispositivo*\n\nSelecione um dispositivo para ver o status completo:');
            await sendDevicesList(from, devices);
          } else {
            await sendTextMessage(from, '❌ Nenhum dispositivo encontrado.\n\nDigite: `!tuya list` para listar dispositivos.');
          }
        } else {
          await sendTextMessage(from, '❌ Módulo Tuya não configurado.');
        }
      } catch (e) {
        err(`[WHATSAPP-API] Erro ao processar opt_tuya_status:`, e.message);
        await sendTextMessage(from, `❌ Erro: ${e.message}`);
      }
      return;
    }
    
    if (responseId === 'opt_tuya_count') {
      log(`[WHATSAPP-API] Opção "Luzes Ligadas" selecionada por ${from}`);
      try {
        if (tuya && tuya.countPoweredOnDevices) {
          await sendTextMessage(from, '⏳ Contando luzes ligadas...');
          const countData = await tuya.countPoweredOnDevices(null, true); // null = usa UID padrão, true = apenas luzes (lâmpadas e interruptores)
          const message = tuya.formatCountMessage(countData, true);
          await sendTextMessage(from, message);
        } else {
          await sendTextMessage(from, '❌ Módulo Tuya não configurado ou função de contagem não disponível.');
        }
      } catch (e) {
        err(`[WHATSAPP-API] Erro ao processar opt_tuya_count:`, e.message);
        await sendTextMessage(from, `❌ Erro: ${e.message}`);
      }
      return;
    }
    
    if (responseId === 'opt_blocked_ips') {
      log(`[WHATSAPP-API] Opção "IPs Bloqueados" selecionada por ${from}`);
      try {
        if (ipBlocker && ipBlocker.listBlockedIPs) {
          await sendTextMessage(from, '⏳ Buscando IPs bloqueados...');
          const blockedIPs = await ipBlocker.listBlockedIPs(50, 0); // Limite de 50 IPs
          const total = await ipBlocker.countBlockedIPs();
          
          if (blockedIPs.length === 0) {
            await sendTextMessage(from, '✅ *IPs Bloqueados*\n\nNenhum IP bloqueado no momento.');
          } else {
            let message = `🛡️ *IPs Bloqueados*\n\n`;
            message += `*Total:* ${total} IP(s) bloqueado(s)\n\n`;
            message += `*Últimos ${blockedIPs.length} bloqueios:*\n\n`;
            
            blockedIPs.forEach((ipData, index) => {
              const blockedDate = new Date(ipData.blocked_at * 1000).toLocaleString('pt-BR');
              const lastSeen = ipData.last_seen ? new Date(ipData.last_seen * 1000).toLocaleString('pt-BR') : 'Nunca';
              message += `${index + 1}. *${ipData.ip}*\n`;
              message += `   📅 Bloqueado: ${blockedDate}\n`;
              message += `   👁️ Última tentativa: ${lastSeen}\n`;
              message += `   🔢 Tentativas: ${ipData.request_count || 0}\n`;
              message += `   📝 Motivo: ${ipData.reason || 'Não especificado'}\n\n`;
            });
            
            if (total > blockedIPs.length) {
              message += `\n💡 Mostrando ${blockedIPs.length} de ${total} IP(s) bloqueado(s).`;
            }
            
            await sendTextMessage(from, message);
          }
        } else {
          await sendTextMessage(from, '❌ Módulo de bloqueio de IPs não configurado.');
        }
      } catch (e) {
        err(`[WHATSAPP-API] Erro ao processar opt_blocked_ips:`, e.message);
        await sendTextMessage(from, `❌ Erro: ${e.message}`);
      }
      return;
    }
    
    if (responseId === 'opt_record') {
      log(`[WHATSAPP-API] Opção "Gravar Vídeo" selecionada por ${from}`);
      try {
        // Envia menu de opções de tempo
        await sendVideoDurationMenu(from);
      } catch (e) {
        err(`[WHATSAPP-API] Erro ao processar opt_record:`, e.message);
        await sendTextMessage(from, `❌ Erro: ${e.message}`);
      }
      return;
    }
    
    // Processa seleção de duração de vídeo (record_*)
    if (responseId.startsWith('record_')) {
      const durationStr = responseId.replace('record_', '');
      const duration = parseInt(durationStr, 10);
      
      if (isNaN(duration) || duration < 5 || duration > 120) {
        await sendTextMessage(from, '❌ Duração inválida. Use entre 5 e 120 segundos.');
        return;
      }
      
      log(`[WHATSAPP-API] Gravação solicitada: ${duration} segundos por ${from}`);
      try {
        await processVideoRecording(from, duration);
      } catch (e) {
        err(`[WHATSAPP-API] Erro ao processar gravação:`, e.message);
        await sendTextMessage(from, `❌ Erro: ${e.message}`);
      }
      return;
    }
    
    // Processa botão "Ver Vídeo" (view_video_*)
    if (responseId.startsWith('view_video_')) {
      const videoId = responseId.replace('view_video_', '');
      log(`[WHATSAPP-API] Solicitação de vídeo: ${videoId} por ${from}`);
      
      if (!tempVideoProcessor) {
        await sendTextMessage(from, '❌ Sistema de vídeos temporários não disponível.');
        return;
      }
      
      try {
        const result = tempVideoProcessor(videoId, from);
        
        if (!result.success) {
          await sendTextMessage(from, `❌ ${result.error || 'Erro ao processar vídeo'}`);
          return;
        }
        
        // Lê o arquivo de vídeo
        const fs = require('fs');
        if (!fs.existsSync(result.filePath)) {
          await sendTextMessage(from, '❌ Arquivo de vídeo não encontrado.');
          return;
        }
        
        // Divide vídeo em partes se necessário
        let videoParts;
        if (camera && camera.splitVideoIfNeeded) {
          videoParts = await camera.splitVideoIfNeeded(result.filePath);
          log(`[WHATSAPP-API] Vídeo dividido em ${videoParts.length} parte(s)`);
        } else {
          warn(`[WHATSAPP-API] Função splitVideoIfNeeded não disponível, usando arquivo original`);
          videoParts = [result.filePath];
        }
        
        // Envia cada parte
        for (let i = 0; i < videoParts.length; i++) {
          const partFile = videoParts[i];
          const partBuffer = fs.readFileSync(partFile);
          const partSizeMB = partBuffer.length / 1024 / 1024;
          
          const partNumber = videoParts.length > 1 ? ` (Parte ${i + 1}/${videoParts.length})` : '';
          const caption = `🎥 Vídeo da campainha (15 segundos)${partNumber}`;
          
          try {
            await sendTextMessage(from, `⏳ Enviando vídeo${partNumber}...`);
            const videoBase64 = partBuffer.toString('base64');
            await sendMediaFromBase64(from, videoBase64, 'video/mp4', caption);
            log(`[WHATSAPP-API] Parte ${i + 1}/${videoParts.length} do vídeo ${videoId} enviada com sucesso para ${from}`);
            
            // Aguarda entre envios
            if (i < videoParts.length - 1) {
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
            
            camera.cleanupVideoFile(partFile, `após envio da parte ${i + 1}`);
          } catch (sendError) {
            err(`[WHATSAPP-API] Erro ao enviar parte ${i + 1}/${videoParts.length}:`, sendError.message);
            await sendTextMessage(from, `❌ Erro ao enviar parte ${i + 1}/${videoParts.length}: ${sendError.message}`);
            camera.cleanupVideoFile(partFile, 'após erro no envio');
          }
        }
      } catch (e) {
        err(`[WHATSAPP-API] Erro ao enviar vídeo:`, e.message);
        await sendTextMessage(from, `❌ Erro ao enviar vídeo: ${e.message}`);
      }
      return;
    }
    
    // Processa botão "Pular" (skip_video)
    if (responseId === 'skip_video') {
      log(`[WHATSAPP-API] Usuário optou por pular o vídeo: ${from}`);
      // Não precisa fazer nada, apenas logar
      return;
    }
    
    if (responseId === 'opt_help') {
      log(`[WHATSAPP-API] Opção "Ajuda" selecionada por ${from}`);
      try {
        if (tuya && tuya.formatHelpMessage) {
          const helpMsg = tuya.formatHelpMessage();
          await sendTextMessage(from, helpMsg);
        } else {
          await sendTextMessage(from, '❓ *Ajuda*\n\nComandos disponíveis:\n- `!menu` - Menu principal\n- `!tuya list` - Listar dispositivos\n- `!tuya status <nome>` - Status do dispositivo\n- `!tuya on <nome>` - Ligar dispositivo\n- `!tuya off <nome>` - Desligar dispositivo\n- `!tuya toggle <nome>` - Alternar dispositivo\n- `!record` - Gravar vídeo\n- `!ping` - Teste de conexão');
        }
      } catch (e) {
        err(`[WHATSAPP-API] Erro ao processar opt_help:`, e.message);
        await sendTextMessage(from, `❌ Erro: ${e.message}`);
      }
      return;
    }
    
    // Processa seleção de dispositivo (device_*)
    if (responseId.startsWith('device_')) {
      const deviceId = responseId.replace('device_', '');
      log(`[WHATSAPP-API] Dispositivo selecionado: ${deviceId} por ${from}`);
      try {
        if (tuya) {
          const devices = await tuya.getCachedDevices();
          const device = devices.find(d => d.id === deviceId);
          
          if (device) {
            const status = await tuya.getDeviceStatus(device.id);
            const poweredOn = status.filter(s => {
              const code = s.code?.toLowerCase() || '';
              const value = s.value;
              if (code.includes('switch') || code.includes('power')) {
                return value === true || value === 1 || value === 'true' || value === 'on';
              }
              return false;
            }).length > 0;
            
            const responseMsg = tuya.formatDeviceStatusMessage(device.name, status, poweredOn);
            await sendTextMessage(from, responseMsg);
          } else {
            await sendTextMessage(from, '❌ Dispositivo não encontrado.');
          }
        } else {
          await sendTextMessage(from, '❌ Módulo Tuya não configurado.');
        }
      } catch (e) {
        err(`[WHATSAPP-API] Erro ao processar seleção de dispositivo:`, e.message);
        await sendTextMessage(from, `❌ Erro: ${e.message}`);
      }
      return;
    }
    
    log(`[WHATSAPP-API] Resposta interativa desconhecida de ${from}: ${responseId}`);
  }
  
  return {
    // Estado
    isReady: () => isReady,
    getLastQR: () => null, // API oficial não usa QR
    
    // Envio de mensagens
    sendTextMessage,
    sendInteractiveButtons,
    sendListMessage,
    sendMedia,
    sendMediaFromBase64,
    uploadMedia,
    sendMediaById,
    
    // Webhook
    verifyWebhook,
    processWebhookMessage,
    
    // Configuração
    setTempVideoProcessor: (processor) => {
      tempVideoProcessor = processor;
      log(`[WHATSAPP-API] Processador de vídeos temporários configurado`);
    },
    
    // Resolver número (para compatibilidade)
    resolveWhatsAppNumber: async (e164) => {
      // API oficial não precisa resolver, apenas normaliza
      const normalized = normalizeBR(e164);
      return { id: { _serialized: normalized.replace(/^\+/, '') }, tried: [normalized] };
    }
  };
}

module.exports = { initWhatsAppOfficialModule };

