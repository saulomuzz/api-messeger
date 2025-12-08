/**
 * Módulo WhatsApp Business API Oficial (Meta)
 * Usa a API oficial do WhatsApp Business para envio e recebimento de mensagens
 */

const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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
  numbersFile,
  recordDurationSec
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
  
  // Estado para rastrear usuários aguardando tempo de gravação
  const pendingRecordRequests = new Map(); // from -> { timestamp, timeout }
  
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
          
          if (errorCode === 190 || errorCode === 463) {
            err(`[WHATSAPP-API] ⚠️ TOKEN EXPIRADO!`);
            err(`[WHATSAPP-API] ⚠️ O access token expirou. Gere um novo token no Meta for Developers.`);
            err(`[WHATSAPP-API] ⚠️ Veja o arquivo RENOVAR_ACCESS_TOKEN.md para instruções.`);
            err(`[WHATSAPP-API] ⚠️ Mensagem: ${errorMessage}`);
          } else if (errorCode === 131047) {
            err(`[WHATSAPP-API] ⚠️ Número não está no WhatsApp ou formato inválido`);
          } else if (errorCode === 131026) {
            err(`[WHATSAPP-API] ⚠️ Janela de 24h expirada. Use template message ou aguarde o usuário iniciar conversa.`);
          } else if (errorCode === 131031) {
            err(`[WHATSAPP-API] ⚠️ Número bloqueado ou não autorizado`);
          } else {
            err(`[WHATSAPP-API] Código de erro: ${errorCode}, Mensagem: ${errorMessage}`);
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
   * Envia mídia (imagem, vídeo, documento)
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
      log(`[WEBHOOK] Processando entrada do webhook:`, JSON.stringify(entry, null, 2));
      
      for (const change of entry.changes || []) {
        log(`[WEBHOOK] Processando change:`, JSON.stringify(change, null, 2));
        
        if (change.value?.messages) {
          log(`[WEBHOOK] ${change.value.messages.length} mensagem(ns) encontrada(s)`);
          
          for (const message of change.value.messages) {
            const from = message.from;
            const messageType = message.type;
            const messageId = message.id;
            
            log(`[WEBHOOK] Mensagem recebida - De: ${from}, Tipo: ${messageType}, ID: ${messageId}`);
            
            // Processa mensagens de texto
            if (messageType === 'text') {
              const text = message.text?.body || '';
              log(`[WEBHOOK] Texto: "${text}"`);
              log(`[WEBHOOK] Mensagem de texto normal, chamando handleTextMessage`);
              await handleTextMessage(from, text, messageId);
            }
            // Processa mensagens interativas (botões e listas)
            else if (messageType === 'interactive') {
              const interactiveResponse = message.interactive;
              log(`[WEBHOOK] Mensagem interativa detectada:`, JSON.stringify(interactiveResponse));
              
              // Se for resposta de botão interativo
              if (interactiveResponse?.type === 'button_reply') {
                const buttonId = interactiveResponse.button_reply?.id;
                const buttonTitle = interactiveResponse.button_reply?.title || '';
                log(`[WEBHOOK] Resposta de botão detectada: ${buttonId} (${buttonTitle})`);
                await handleInteractiveResponse(from, buttonId, buttonTitle);
              }
              // Se for resposta de lista
              else if (interactiveResponse?.type === 'list_reply') {
                const listId = interactiveResponse.list_reply?.id;
                const listTitle = interactiveResponse.list_reply?.title || '';
                log(`[WEBHOOK] Resposta de lista detectada: ${listId} (${listTitle})`);
                await handleInteractiveResponse(from, listId, listTitle);
              }
              else {
                warn(`[WEBHOOK] Tipo de interação não suportado: ${interactiveResponse?.type}`);
              }
            } else {
              log(`[WEBHOOK] Tipo de mensagem não suportado: ${messageType}`);
            }
          }
        } else {
          log(`[WEBHOOK] Nenhuma mensagem encontrada em change.value`);
        }
      }
    } catch (error) {
      err(`[WHATSAPP-API] Erro ao processar webhook:`, error.message);
      err(`[WHATSAPP-API] Stack trace:`, error.stack);
    }
  }
  
  /**
   * Envia menu principal (compatível com API oficial)
   */
  async function sendMainMenu(chatId) {
    try {
      const welcomeMsg = '🏠 *Menu Principal*\n\n' +
        'Bem-vindo ao sistema de controle inteligente!\n\n' +
        'Para ver as opções disponíveis, clique no botão abaixo ou digite *"ver opções"*:';
      
      // Tenta enviar com botão "Ver opções" usando API oficial
      try {
        await sendInteractiveButtons(chatId, welcomeMsg, [
          { title: '👁️ Ver opções', id: 'btn_ver_opcoes' }
        ], 'WhatsApp API - Controle Inteligente');
        log(`[MENU] Menu principal com botão "Ver opções" enviado para ${chatId}`);
        return;
      } catch (buttonError) {
        dbg(`[MENU] Botão não suportado, usando fallback: ${buttonError.message}`);
        // Continua para o fallback
      }
      
      // Fallback: mensagem de texto
      const fallbackMsg = welcomeMsg + '\n\n' +
        '💡 *Digite:* `ver opções` ou `menu` para ver todas as opções disponíveis.';
      
      await sendTextMessage(chatId, fallbackMsg);
      log(`[MENU] Menu principal enviado como texto para ${chatId}`);
    } catch (e) {
      err(`[MENU] Erro ao enviar menu principal:`, e.message);
      try {
        await sendTextMessage(chatId, '🏠 Menu Principal\n\nDigite "ver opções" para ver as opções disponíveis.');
      } catch (e2) {
        err(`[MENU] Erro no fallback final:`, e2.message);
      }
    }
  }
  
  /**
   * Envia menu de opções (compatível com API oficial)
   */
  async function sendOptionsMenu(chatId) {
    try {
      // Tenta enviar como List Message (estilo modal do WhatsApp Business)
      try {
        await sendListMessage(
          chatId,
          '🏠 Menu Principal',
          'Selecione uma opção para continuar:',
          'Ver opções',
          [{
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
          }]
        );
        log(`[MENU] Menu de opções enviado como List Message para ${chatId}`);
        return;
      } catch (listError) {
        dbg(`[MENU] List Message não suportado, usando Reply Buttons: ${listError.message}`);
        // Continua para Reply Buttons
      }
      
      // Fallback: Reply Buttons
      try {
        await sendInteractiveButtons(chatId, 
          '🏠 *Menu Principal*\n\n*Selecione uma opção:*\n\n' +
          '📋 *Dispositivos Tuya*\n   Listar e gerenciar dispositivos\n\n' +
          '⚡ *Status do Dispositivo*\n   Consultar status específico\n\n' +
          '🎥 *Gravar Vídeo*\n   Gravar vídeo da câmera\n\n' +
          '❓ *Ajuda*\n   Ver comandos disponíveis',
          [
            { title: '📋 Dispositivos', id: 'opt_tuya_list' },
            { title: '⚡ Status', id: 'opt_tuya_status' },
            { title: '🎥 Gravar', id: 'opt_record' },
            { title: '❓ Ajuda', id: 'opt_help' }
          ],
          'WhatsApp API - Controle Inteligente'
        );
        log(`[MENU] Menu de opções enviado como Reply Buttons para ${chatId}`);
        return;
      } catch (buttonError) {
        dbg(`[MENU] Reply Buttons não suportado, usando texto: ${buttonError.message}`);
        // Continua para texto
      }
      
      // Fallback final: mensagem de texto formatada
      const textMenu = '🏠 *Menu Principal*\n\n' +
        '📋 *1. Dispositivos Tuya*\n   Digite: `!tuya list`\n\n' +
        '⚡ *2. Status do Dispositivo*\n   Digite: `!tuya status <nome>`\n\n' +
        '🎥 *3. Gravar Vídeo*\n   Digite: `!record` ou `!record 30`\n\n' +
        '❓ *4. Ajuda*\n   Digite: `!tuya help`\n\n' +
        '💡 *Dica:* Você também pode clicar nos botões acima (se disponível).';
      
      await sendTextMessage(chatId, textMenu);
      log(`[MENU] Menu de opções enviado como texto para ${chatId}`);
    } catch (e) {
      err(`[MENU] Erro ao enviar menu de opções:`, e.message);
      try {
        await sendTextMessage(chatId, '🏠 Menu Principal\n\nDigite:\n- !tuya list\n- !tuya status <nome>\n- !record\n- !tuya help');
      } catch (e2) {
        err(`[MENU] Erro no fallback final:`, e2.message);
      }
    }
  }
  
  /**
   * Processa mensagem de texto recebida
   */
  async function handleTextMessage(from, text, messageId) {
    log(`[WHATSAPP-API] Mensagem recebida de ${from}: "${text}"`);
    
    // Verifica autorização
    const isAuthorized = isNumberAuthorized(from, numbersFile, dbg);
    if (!isAuthorized) {
      dbg(`[WHATSAPP-API] Número ${from} não autorizado. Ignorando.`);
      return;
    }
    
    const msgLower = text.toLowerCase().trim();
    const msgBody = text.trim();
    
    // Comando !menu - Exibe menu principal
    if (msgLower === '!menu' || msgLower === 'menu' || msgLower === 'início' || msgLower === 'inicio') {
      log(`[CMD] Comando !menu recebido de ${from}`);
      try {
        await sendMainMenu(from);
        log(`[CMD] Menu principal enviado para ${from}`);
      } catch (e) {
        err(`[CMD] Falha ao enviar menu:`, e.message);
      }
      return;
    }
    
    // Responde a saudações com menu principal
    const greetings = ['oi', 'olá', 'ola', 'hey', 'hi', 'hello', 'bom dia', 'boa tarde', 'boa noite', 'start', 'começar', 'comecar'];
    if (greetings.includes(msgLower)) {
      log(`[CMD] Saudação recebida de ${from}, enviando menu principal`);
      try {
        await sendMainMenu(from);
      } catch (e) {
        err(`[CMD] Falha ao enviar menu após saudação:`, e.message);
      }
      return;
    }
    
    // Comando !ping
    if (msgLower === '!ping') {
      log(`[CMD] Comando !ping recebido de ${from}. Respondendo...`);
      try {
        await sendTextMessage(from, 'pong');
        log(`[CMD] Resposta 'pong' enviada para ${from}.`);
      } catch (e) {
        err(`[CMD] Falha ao responder 'pong' para ${from}:`, e.message);
      }
      return;
    }
    
    // Processa botão "Ver opções"
    if (msgBody === 'btn_ver_opcoes' || msgLower === 'ver opções' || msgLower === 'ver opcoes' || msgLower === 'ver opção' || msgLower === 'ver opcao') {
      log(`[MENU] Botão "Ver opções" detectado de ${from}`);
      try {
        await sendOptionsMenu(from);
      } catch (e) {
        err(`[MENU] Erro ao processar "ver opções":`, e.message);
        await sendTextMessage(from, `❌ Erro: ${e.message}`);
      }
      return;
    }
    
    // Processa seleções do menu de opções
    if (msgBody === 'opt_tuya_list' || msgLower.includes('dispositivos tuya') || msgLower === 'dispositivos' || msgLower === '📋 dispositivos') {
      log(`[MENU] Opção "Dispositivos Tuya" selecionada de ${from}`);
      try {
        await sendTextMessage(from, '⏳ Buscando seus dispositivos...');
        if (tuya && tuya.getCachedDevices) {
          const devices = await tuya.getCachedDevices();
          const devicesMsg = tuya.formatDevicesListMessage(devices);
          await sendTextMessage(from, devicesMsg);
        } else {
          await sendTextMessage(from, '❌ Módulo Tuya não configurado.');
        }
      } catch (e) {
        err(`[MENU] Erro ao processar opt_tuya_list:`, e.message);
        await sendTextMessage(from, `❌ Erro: ${e.message}`);
      }
      return;
    }
    
    if (msgBody === 'opt_help' || msgLower.includes('ajuda') || msgLower === 'help' || msgLower === '❓ ajuda') {
      log(`[MENU] Opção "Ajuda" selecionada de ${from}`);
      if (tuya && tuya.formatHelpMessage) {
        const helpMsg = tuya.formatHelpMessage();
        await sendTextMessage(from, helpMsg);
      }
      return;
    }
    
    // Verifica se o usuário está aguardando tempo de gravação
    if (pendingRecordRequests.has(from)) {
      const request = pendingRecordRequests.get(from);
      clearTimeout(request.timeout);
      pendingRecordRequests.delete(from);
      
      // Tenta extrair o número de segundos
      const durationMatch = text.match(/^(\d+)$/);
      let duration = durationMatch ? parseInt(durationMatch[1], 10) : recordDurationSec || 30;
      
      // Valida duração
      if (duration < 5) {
        await sendTextMessage(from, '⚠️ Duração mínima é 5 segundos. Usando 5 segundos.');
        duration = 5;
      } else if (duration > 120) {
        await sendTextMessage(from, '⚠️ Duração máxima é 120 segundos. Usando 120 segundos.');
        duration = 120;
      }
      
      log(`[RECORD] Iniciando gravação de ${duration} segundos para ${from}`);
      
      // Processa gravação em background
      (async () => {
        try {
          if (!camera || !camera.recordRTSPVideo) {
            throw new Error('Módulo de câmera não configurado');
          }
          
          const rtspUrl = camera.buildRTSPUrl();
          if (!rtspUrl) {
            throw new Error('CAMERA_RTSP_URL não configurada');
          }
          
          await sendTextMessage(from, `⏳ Iniciando gravação de ${duration} segundos...`);
          
          // Cria um objeto fake message para compatibilidade com camera.recordRTSPVideo
          const fakeMessage = {
            reply: async (msg) => {
              await sendTextMessage(from, msg);
            }
          };
          
          const result = await camera.recordRTSPVideo(rtspUrl, duration, fakeMessage);
          
          if (result.success && result.filePath && fs.existsSync(result.filePath)) {
            const originalFilePath = result.filePath;
            const fileStats = fs.statSync(originalFilePath);
            log(`[RECORD] Arquivo gerado: ${originalFilePath} (${(fileStats.size / 1024 / 1024).toFixed(2)} MB)`);
            
            // Comprime se necessário
            const finalVideoPath = await camera.compressVideoIfNeeded(originalFilePath, fakeMessage);
            const finalStats = fs.statSync(finalVideoPath);
            log(`[RECORD] Arquivo final: ${finalVideoPath} (${(finalStats.size / 1024 / 1024).toFixed(2)} MB)`);
            
            const videoBuffer = fs.readFileSync(finalVideoPath);
            const sizeMB = videoBuffer.length / 1024 / 1024;
            
            if (sizeMB > 16) {
              throw new Error(`Vídeo muito grande (${sizeMB.toFixed(2)} MB). Limite do WhatsApp: 16 MB`);
            }
            
            // Envia vídeo via API oficial
            await sendVideoFile(from, finalVideoPath, `🎥 Gravação de ${duration} segundos`);
            
            // Limpa arquivos
            camera.cleanupVideoFile(finalVideoPath, 'após envio bem-sucedido');
            if (originalFilePath !== finalVideoPath && fs.existsSync(originalFilePath)) {
              camera.cleanupVideoFile(originalFilePath, 'arquivo original restante');
            }
            
            log(`[RECORD] Vídeo enviado com sucesso para ${from}`);
          } else {
            throw new Error('Gravação falhou ou arquivo não foi gerado');
          }
        } catch (e) {
          err(`[RECORD] Erro ao processar gravação para ${from}:`, e.message);
          await sendTextMessage(from, `❌ Erro ao gravar vídeo: ${e.message}`);
        }
      })();
      
      return;
    }
    
    // TODO: Integrar outros comandos (Tuya, record, etc.)
    // Por enquanto, apenas responde que não entendeu
    log(`[WHATSAPP-API] Comando não reconhecido de ${from}: ${text}`);
    await sendTextMessage(from, '❓ Não entendi esse comando.\n\n💡 Digite `menu` ou `!menu` para ver as opções disponíveis.');
  }
  
  /**
   * Envia arquivo de vídeo via API oficial
   * Nota: A API oficial requer que o arquivo esteja acessível via URL pública
   * ou que seja feito upload primeiro. Por enquanto, vamos usar uma abordagem simplificada.
   */
  async function sendVideoFile(to, filePath, caption = null) {
    try {
      const normalized = normalizeBR(to);
      const toNumber = normalized.replace(/^\+/, '');
      
      // Lê o arquivo como buffer
      const videoBuffer = fs.readFileSync(filePath);
      const videoBase64 = videoBuffer.toString('base64');
      
      // Para a API oficial, precisamos fazer upload do arquivo primeiro
      // Usando multipart/form-data manualmente
      const boundary = `----WebKitFormBoundary${crypto.randomBytes(16).toString('hex')}`;
      const fileName = path.basename(filePath);
      
      // Cria o body multipart manualmente
      let formData = '';
      formData += `--${boundary}\r\n`;
      formData += `Content-Disposition: form-data; name="messaging_product"\r\n\r\n`;
      formData += `whatsapp\r\n`;
      formData += `--${boundary}\r\n`;
      formData += `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n`;
      formData += `Content-Type: video/mp4\r\n\r\n`;
      
      const formDataBuffer = Buffer.from(formData, 'utf8');
      const endBoundary = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
      const fullBody = Buffer.concat([formDataBuffer, videoBuffer, endBoundary]);
      
      // Faz upload do arquivo
      const uploadResponse = await axios.post(
        `${BASE_URL}/${PHONE_NUMBER_ID}/media`,
        fullBody,
        {
          headers: {
            'Authorization': `Bearer ${ACCESS_TOKEN}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`
          },
          maxContentLength: Infinity,
          maxBodyLength: Infinity
        }
      );
      
      const mediaId = uploadResponse.data.id;
      log(`[WHATSAPP-API] Mídia enviada para upload, ID: ${mediaId}`);
      
      // Envia mensagem com o vídeo
      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: toNumber,
        type: 'video',
        video: {
          id: mediaId
        }
      };
      
      if (caption) {
        payload.video.caption = caption;
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
      
      log(`[WHATSAPP-API] Vídeo enviado para ${toNumber}`);
      return response.data;
    } catch (error) {
      err(`[WHATSAPP-API] Erro ao enviar vídeo:`, error.response?.data || error.message);
      // Fallback: informa que precisa de URL pública
      await sendTextMessage(to, `❌ Erro ao enviar vídeo: ${error.message}\n\n💡 A API oficial requer que o arquivo esteja acessível via URL pública.`);
      throw error;
    }
  }
  
  /**
   * Processa resposta de botão/lista interativa
   */
  async function handleInteractiveResponse(from, responseId, text) {
    log(`[WHATSAPP-API] Resposta interativa de ${from}: ${responseId}`);
    
    const isAuthorized = isNumberAuthorized(from, numbersFile, dbg);
    if (!isAuthorized) {
      dbg(`[WHATSAPP-API] Número ${from} não autorizado. Ignorando.`);
      return;
    }
    
    const responseIdLower = responseId.toLowerCase();
    
    // Processa botão "Ver opções"
    if (responseId === 'btn_ver_opcoes' || responseIdLower === 'btn_ver_opcoes') {
      log(`[MENU] Botão "Ver opções" clicado por ${from}`);
      try {
        await sendOptionsMenu(from);
      } catch (e) {
        err(`[MENU] Erro ao processar "ver opções":`, e.message);
        await sendTextMessage(from, `❌ Erro: ${e.message}`);
      }
      return;
    }
    
    // Processa seleções do menu de opções
    if (responseId === 'opt_tuya_list' || responseIdLower === 'opt_tuya_list') {
      log(`[MENU] Opção "Dispositivos Tuya" selecionada de ${from}`);
      try {
        await sendTextMessage(from, '⏳ Buscando seus dispositivos...');
        if (tuya && tuya.getCachedDevices) {
          const devices = await tuya.getCachedDevices();
          const devicesMsg = tuya.formatDevicesListMessage(devices);
          await sendTextMessage(from, devicesMsg);
        } else {
          await sendTextMessage(from, '❌ Módulo Tuya não configurado.');
        }
      } catch (e) {
        err(`[MENU] Erro ao processar opt_tuya_list:`, e.message);
        await sendTextMessage(from, `❌ Erro: ${e.message}`);
      }
      return;
    }
    
    if (responseId === 'opt_tuya_status' || responseIdLower === 'opt_tuya_status') {
      log(`[MENU] Opção "Status do Dispositivo" selecionada de ${from}`);
      try {
        await sendTextMessage(from, '⏳ Consultando dispositivos online...');
        if (tuya && tuya.getCachedDevices) {
          const devices = await tuya.getCachedDevices();
          const onlineDevices = devices.filter(d => d.online);
          
          if (onlineDevices.length === 0) {
            await sendTextMessage(from, '⚡ *Status do Dispositivo*\n\n❌ Nenhum dispositivo online no momento.\n\n💡 Use `!tuya list` para ver todos os dispositivos.');
          } else {
            let message = `⚡ *Dispositivos Online*\n\n*Total:* ${onlineDevices.length} de ${devices.length}\n\n`;
            onlineDevices.forEach((device, index) => {
              const statusEmoji = device.poweredOn ? '🟢' : '🔴';
              message += `${index + 1}. ${statusEmoji} *${device.name || device.id}*\n`;
              if (device.category) {
                message += `   📦 ${device.category}\n`;
              }
              message += `\n`;
            });
            message += `💡 Para ver status detalhado, digite:\n\`!tuya status <número ou nome>\``;
            await sendTextMessage(from, message);
          }
        } else {
          await sendTextMessage(from, '❌ Módulo Tuya não configurado.');
        }
      } catch (e) {
        err(`[MENU] Erro ao processar opt_tuya_status:`, e.message);
        await sendTextMessage(from, `❌ Erro: ${e.message}`);
      }
      return;
    }
    
    if (responseId === 'opt_help' || responseIdLower === 'opt_help') {
      log(`[MENU] Opção "Ajuda" selecionada de ${from}`);
      if (tuya && tuya.formatHelpMessage) {
        const helpMsg = tuya.formatHelpMessage();
        await sendTextMessage(from, helpMsg);
      }
      return;
    }
    
    if (responseId === 'opt_record' || responseIdLower === 'opt_record') {
      log(`[MENU] Opção "Gravar Vídeo" selecionada de ${from}`);
      try {
        // Marca que este usuário está aguardando tempo de gravação
        pendingRecordRequests.set(from, {
          timestamp: Date.now(),
          timeout: setTimeout(() => {
            pendingRecordRequests.delete(from);
            log(`[RECORD] Timeout para solicitação de gravação de ${from}`);
          }, 5 * 60 * 1000) // 5 minutos
        });
        
        await sendTextMessage(from, '🎥 *Gravar Vídeo*\n\n⏱️ Por quantos segundos deseja gravar?\n\nDigite apenas o número (ex: 30, 60, 120)\n\n💡 *Limites:*\n• Mínimo: 5 segundos\n• Máximo: 120 segundos\n• Padrão: 30 segundos (se não informar)');
      } catch (e) {
        err(`[MENU] Erro ao processar opt_record:`, e.message);
        await sendTextMessage(from, `❌ Erro: ${e.message}`);
      }
      return;
    }
    
    // Se não reconheceu, trata como mensagem de texto normal
    log(`[WHATSAPP-API] Resposta interativa não reconhecida: ${responseId}, tratando como texto`);
    await handleTextMessage(from, responseId, null);
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
    
    // Webhook
    verifyWebhook,
    processWebhookMessage,
    
    // Resolver número (para compatibilidade)
    resolveWhatsAppNumber: async (e164) => {
      // API oficial não precisa resolver, apenas normaliza
      const normalized = normalizeBR(e164);
      return { id: { _serialized: normalized.replace(/^\+/, '') }, tried: [normalized] };
    }
  };
}

module.exports = { initWhatsAppOfficialModule };

