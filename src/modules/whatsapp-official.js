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
 * @param {Object} config.ipBlocker - Módulo de bloqueio de IPs
 * @param {string} config.numbersFile - Arquivo com números autorizados
 * @param {string} config.recordDurationSec - Duração padrão de gravação
 * @param {number} config.videoViewHours - Tempo de visualização de vídeos (horas)
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
  whatsappMaxVideoSizeMB = 16,
  videoViewHours = 24
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
  let listVideosFunction = null; // Função para listar histórico de vídeos
  let getVideoIdByMessageIdFunction = null; // Função para resolver vídeo via messageId
  let addPendingVideoRequestFunction = null; // Função para registrar pedido pendente
  let triggerSnapshotFunction = null; // Função para disparar snapshot manualmente
  const VIDEO_VIEW_HOURS = Number.isFinite(Number(videoViewHours)) && Number(videoViewHours) > 0 ? Number(videoViewHours) : 24;
  
  /**
   * Divide mensagem longa em partes menores (limite do WhatsApp: 4096 caracteres)
   * @param {string} message - Mensagem completa
   * @param {number} maxLength - Tamanho máximo por parte (padrão: 4000 para margem de segurança)
   * @returns {Array<string>} Array com partes da mensagem
   */
  function splitLongMessage(message, maxLength = 4000) {
    if (message.length <= maxLength) {
      return [message];
    }
    
    const parts = [];
    let currentPart = '';
    const lines = message.split('\n');
    
    for (const line of lines) {
      // Se a linha sozinha excede o limite, quebra ela também
      if (line.length > maxLength) {
        // Se já tem conteúdo na parte atual, salva ela primeiro
        if (currentPart) {
          parts.push(currentPart.trim());
          currentPart = '';
        }
        // Quebra a linha longa em pedaços
        for (let i = 0; i < line.length; i += maxLength) {
          parts.push(line.substring(i, i + maxLength));
        }
      } else if ((currentPart + line + '\n').length > maxLength) {
        // Se adicionar esta linha excederia o limite, salva a parte atual e começa nova
        if (currentPart) {
          parts.push(currentPart.trim());
        }
        currentPart = line + '\n';
      } else {
        currentPart += line + '\n';
      }
    }
    
    // Adiciona a última parte se houver
    if (currentPart.trim()) {
      parts.push(currentPart.trim());
    }
    
    return parts;
  }

  function sanitizePayload(payload) {
    if (!payload) return null;
    const clone = JSON.parse(JSON.stringify(payload));
    if (clone.base64) delete clone.base64;
    if (clone.file) delete clone.file;
    if (clone.buffer) delete clone.buffer;
    return clone;
  }

  function normalizeAuditPhone(phone) {
    if (!phone) return null;
    let digits = String(phone).replace(/\D/g, '');
    if (digits.startsWith('55') && digits.length === 13 && digits[4] === '9') {
      digits = `${digits.slice(0, 4)}${digits.slice(5)}`;
    }
    return digits;
  }

  async function logAuditEvent({
    direction,
    phone,
    messageId,
    type,
    status,
    timestamp,
    payload,
    errorCode,
    errorMessage
  }) {
    if (!ipBlocker || !ipBlocker.logWhatsappAudit) return;
    try {
      const normalizedPhone = normalizeAuditPhone(phone);
      await ipBlocker.logWhatsappAudit({
        direction,
        phone: normalizedPhone,
        messageId,
        type,
        status,
        timestamp,
        payload: sanitizePayload(payload),
        errorCode,
        errorMessage
      });
    } catch (e) {
      dbg(`[WHATSAPP-API] Erro ao registrar auditoria:`, e.message);
    }
  }

  function buildInboundPayload(message) {
    if (!message) return null;
    const base = {
      id: message.id,
      type: message.type,
      timestamp: message.timestamp,
      context: message.context || null
    };
    if (message.text?.body) {
      base.text = { body: message.text.body };
    }
    if (message.button) {
      base.button = { text: message.button.text, payload: message.button.payload };
    }
    if (message.interactive) {
      base.interactive = message.interactive;
    }
    if (message.image) {
      base.image = { id: message.image.id, mime_type: message.image.mime_type, caption: message.image.caption };
    }
    if (message.video) {
      base.video = { id: message.video.id, mime_type: message.video.mime_type, caption: message.video.caption };
    }
    if (message.audio) {
      base.audio = { id: message.audio.id, mime_type: message.audio.mime_type };
    }
    if (message.document) {
      base.document = { id: message.document.id, mime_type: message.document.mime_type, filename: message.document.filename, caption: message.document.caption };
    }
    return base;
  }
  
  /**
   * Envia mensagem de texto (divide automaticamente se muito longa)
   */
  async function sendTextMessage(to, message) {
    try {
      const normalized = normalizeBR(to);
      const toNumber = normalized.replace(/^\+/, ''); // Remove o + para a API
      
      // Divide mensagem se muito longa
      const parts = splitLongMessage(message);
      
      if (parts.length > 1) {
        log(`[WHATSAPP-API] Mensagem muito longa (${message.length} chars), dividindo em ${parts.length} parte(s) para ${toNumber}...`);
      }
      
      // Envia cada parte
      const results = [];
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const partNumber = parts.length > 1 ? ` (${i + 1}/${parts.length})` : '';
        
        log(`[WHATSAPP-API] Enviando mensagem${partNumber} para ${toNumber}...`);
        
        const response = await axios.post(
          `${BASE_URL}/${PHONE_NUMBER_ID}/messages`,
          {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: toNumber,
            type: 'text',
            text: {
              preview_url: false,
              body: part
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
        log(`[WHATSAPP-API] ✅ Mensagem${partNumber} enviada com sucesso para ${toNumber}: ${messageId}`);
        
        await logAuditEvent({
          direction: 'out',
          phone: toNumber,
          messageId,
          type: 'text',
          status: 'sent',
          payload: {
            text: part,
            partIndex: i + 1,
            totalParts: parts.length
          }
        });
        
        // Incrementa estatística de mensagem enviada
        if (global.statisticsModel) {
          global.statisticsModel.incrementSent();
        }
        
        results.push({
          id: {
            _serialized: messageId
          },
          ...response.data
        });
        
        // Pequeno delay entre partes para não sobrecarregar
        if (i < parts.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      
      // Retorna o primeiro resultado (compatibilidade)
      return results[0] || {
        id: { _serialized: 'unknown' }
      };
    } catch (error) {
      // Incrementa estatística de mensagem falhada
      if (global.statisticsModel) {
        global.statisticsModel.incrementFailed();
      }
      
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
        await logAuditEvent({
          direction: 'out',
          phone: String(to).replace(/^\+/, ''),
          messageId: null,
          type: 'text',
          status: 'failed',
          payload: { text: message },
          errorCode: errorData.error?.code,
          errorMessage: errorData.error?.message
        });
      } else {
        err(`[WHATSAPP-API] ❌ Erro ao enviar mensagem para ${to}:`, error.message);
        await logAuditEvent({
          direction: 'out',
          phone: String(to).replace(/^\+/, ''),
          messageId: null,
          type: 'text',
          status: 'failed',
          payload: { text: message },
          errorMessage: error.message
        });
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
      await logAuditEvent({
        direction: 'out',
        phone: toNumber,
        messageId: response.data.messages?.[0]?.id || null,
        type: 'interactive',
        status: 'sent',
        payload: { text, buttons, footer }
      });
      return response.data;
    } catch (error) {
      err(`[WHATSAPP-API] Erro ao enviar botões interativos:`, error.response?.data || error.message);
      await logAuditEvent({
        direction: 'out',
        phone: String(to).replace(/^\+/, ''),
        messageId: null,
        type: 'interactive',
        status: 'failed',
        payload: { text, buttons, footer },
        errorCode: error.response?.data?.error?.code,
        errorMessage: error.response?.data?.error?.message || error.message
      });
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
      await logAuditEvent({
        direction: 'out',
        phone: toNumber,
        messageId: response.data.messages?.[0]?.id || null,
        type: 'interactive_list',
        status: 'sent',
        payload: { title, description, buttonText, sections }
      });
      return response.data;
    } catch (error) {
      err(`[WHATSAPP-API] Erro ao enviar List Message:`, error.response?.data || error.message);
      await logAuditEvent({
        direction: 'out',
        phone: String(to).replace(/^\+/, ''),
        messageId: null,
        type: 'interactive_list',
        status: 'failed',
        payload: { title, description, buttonText },
        errorCode: error.response?.data?.error?.code,
        errorMessage: error.response?.data?.error?.message || error.message
      });
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
      await logAuditEvent({
        direction: 'out',
        phone: toNumber,
        messageId: response.data.messages?.[0]?.id || null,
        type: mediaType,
        status: 'sent',
        payload: { mediaUrl, caption }
      });
      return response.data;
    } catch (error) {
      err(`[WHATSAPP-API] Erro ao enviar mídia:`, error.response?.data || error.message);
      await logAuditEvent({
        direction: 'out',
        phone: String(to).replace(/^\+/, ''),
        messageId: null,
        type: mediaType,
        status: 'failed',
        payload: { mediaUrl, caption },
        errorCode: error.response?.data?.error?.code,
        errorMessage: error.response?.data?.error?.message || error.message
      });
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
      await logAuditEvent({
        direction: 'out',
        phone: toNumber,
        messageId: response.data.messages?.[0]?.id || null,
        type: mediaType,
        status: 'sent',
        payload: { mediaId, caption }
      });
      
      // Retorna formato compatível com whatsapp-web.js
      return {
        id: {
          _serialized: response.data.messages?.[0]?.id || 'unknown'
        },
        ...response.data
      };
    } catch (error) {
      err(`[WHATSAPP-API] Erro ao enviar mídia por ID:`, error.response?.data || error.message);
      await logAuditEvent({
        direction: 'out',
        phone: String(to).replace(/^\+/, ''),
        messageId: null,
        type: mediaType,
        status: 'failed',
        payload: { mediaId, caption },
        errorCode: error.response?.data?.error?.code,
        errorMessage: error.response?.data?.error?.message || error.message
      });
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
   * Envia mensagem usando template aprovado pelo Meta
   * @param {string} to - Número de destino
   * @param {string} templateName - Nome do template (ex: "status")
   * @param {string} languageCode - Código do idioma (ex: "pt_BR")
   * @param {Array} components - Componentes/variáveis do template
   * @returns {Promise<Object>} Resposta da API
   */
  async function sendTemplateMessage(to, templateName, languageCode = 'pt_BR', components = []) {
    try {
      const normalized = normalizeBR(to);
      const toNumber = normalized.replace(/^\+/, '');
      
      // Lista de templates MARKETING que requerem opt-in
      const marketingTemplates = [];
      
      // Verifica opt-in para templates MARKETING
      if (marketingTemplates.includes(templateName)) {
        if (ipBlocker && ipBlocker.hasOptIn) {
          try {
            const optInStatus = await ipBlocker.hasOptIn(toNumber);
            if (!optInStatus.optedIn) {
              warn(`[WHATSAPP-API] ⚠️ Template MARKETING "${templateName}" não enviado para ${toNumber}: opt-out ativo`);
              throw new Error(`Usuário ${toNumber} não tem opt-in ativo para receber mensagens MARKETING`);
            }
            dbg(`[WHATSAPP-API] ✅ Opt-in verificado para ${toNumber}: ativo`);
          } catch (optInError) {
            // Se houver erro ao verificar opt-in, loga mas continua (comportamento seguro)
            warn(`[WHATSAPP-API] ⚠️ Erro ao verificar opt-in para ${toNumber}:`, optInError.message);
            // Se o erro for explicitamente de opt-out, não envia
            if (optInError.message && optInError.message.includes('opt-out')) {
              throw optInError;
            }
          }
        }
      }
      
      log(`[WHATSAPP-API] Enviando template "${templateName}" para ${toNumber}...`);
      
      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: toNumber,
        type: 'template',
        template: {
          name: templateName,
          language: { code: languageCode }
        }
      };
      
      // Adiciona components apenas se fornecidos
      if (components && components.length > 0) {
        payload.template.components = components;
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
      
      const messageId = response.data.messages?.[0]?.id || 'unknown';
      log(`[WHATSAPP-API] ✅ Template "${templateName}" enviado para ${toNumber}: ${messageId}`);
      
      await logAuditEvent({
        direction: 'out',
        phone: toNumber,
        messageId,
        type: 'template',
        status: 'sent',
        payload: { templateName, languageCode, components }
      });
      
      // Incrementa estatística de mensagem enviada
      if (global.statisticsModel) {
        global.statisticsModel.incrementSent();
      }
      
      return {
        id: {
          _serialized: messageId
        },
        ...response.data
      };
    } catch (error) {
      // Incrementa estatística de mensagem falhada
      if (global.statisticsModel) {
        global.statisticsModel.incrementFailed();
      }
      
      if (error.response?.data) {
        const errorData = error.response.data;
        err(`[WHATSAPP-API] ❌ Erro ao enviar template "${templateName}" para ${to}:`, errorData);
        
        if (errorData.error) {
          const errorCode = errorData.error.code;
          const errorMessage = errorData.error.message;
          
          if (errorCode === 132001) {
            err(`[WHATSAPP-API] ⚠️ Template "${templateName}" não encontrado ou não aprovado`);
          } else if (errorCode === 132000) {
            err(`[WHATSAPP-API] ⚠️ Número de parâmetros incorreto para o template`);
          } else if (errorCode === 131047) {
            err(`[WHATSAPP-API] ⚠️ Número não está no WhatsApp ou formato inválido`);
          }
          
          dbg(`[WHATSAPP-API] Código de erro: ${errorCode}, Mensagem: ${errorMessage}`);
        }
        await logAuditEvent({
          direction: 'out',
          phone: String(to).replace(/^\+/, ''),
          messageId: null,
          type: 'template',
          status: 'failed',
          payload: { templateName, languageCode },
          errorCode: errorData.error?.code,
          errorMessage: errorData.error?.message
        });
      } else {
        err(`[WHATSAPP-API] ❌ Erro ao enviar template "${templateName}":`, error.message);
        await logAuditEvent({
          direction: 'out',
          phone: String(to).replace(/^\+/, ''),
          messageId: null,
          type: 'template',
          status: 'failed',
          payload: { templateName, languageCode },
          errorMessage: error.message
        });
      }
      throw error;
    }
  }
  
  /**
   * Envia código de autenticação usando o template "login_web_app"
   *
   * Payload equivalente ao curl fornecido:
   * - type=template
   * - template.name=login_web_app
   * - components:
   *   - body: 1 parâmetro text (código)
   *   - button url index 0: 1 parâmetro text (código)
   *
   * @param {string} to - Número de destino
   * @param {string|number} code - Código a inserir no body e no botão URL
   * @param {string} languageCode - Código do idioma (padrão: pt_BR)
   * @returns {Promise<Object>}
   */
  async function sendLoginWebAppCode(to, code, languageCode = 'pt_BR') {
    const token = String(code);
    const components = [
      {
        type: 'body',
        parameters: [{ type: 'text', text: token }]
      },
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: token }]
      }
    ];
    return await sendTemplateMessage(to, 'login_web_app', languageCode, components);
  }

  /**
   * Envia código/status usando o template "status"
   * Função auxiliar para facilitar o envio de códigos
   * @param {string} to - Número de destino
   * @param {string} code - O código/status a ser enviado
   * @param {string} languageCode - Código do idioma (padrão: "pt_BR")
   * @param {string} paramLocation - Onde colocar o parâmetro: 'body', 'header', 'none' (padrão: tenta sem parâmetros primeiro)
   * @returns {Promise<Object>} Resposta da API
   */
  async function sendStatusCode(to, code, languageCode = 'pt_BR', paramLocation = 'auto') {
    // Se paramLocation é 'auto', tenta enviar sem parâmetros primeiro
    // (o template pode não ter variáveis, apenas texto fixo)
    if (paramLocation === 'auto' || paramLocation === 'none') {
      try {
        // Primeiro tenta sem parâmetros
        return await sendTemplateMessage(to, 'status', languageCode, []);
      } catch (error) {
        // Se falhar com erro de parâmetros, tenta com parâmetros no header
        if (error.response?.data?.error?.code === 132000) {
          dbg(`[WHATSAPP-API] Template sem parâmetros falhou, tentando com header...`);
          paramLocation = 'header';
        } else {
          throw error;
        }
      }
    }
    
    let components = [];
    
    if (paramLocation === 'header') {
      // Variável no header
      components = [
        {
          type: 'header',
          parameters: [
            { type: 'text', text: String(code) }
          ]
        }
      ];
    } else if (paramLocation === 'body') {
      // Variável no body
      components = [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: String(code) }
          ]
        }
      ];
    }
    
    return await sendTemplateMessage(to, 'status', languageCode, components);
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
        // Processa status de entrega de mensagens
        if (change.value?.statuses) {
          for (const status of change.value.statuses) {
            const messageId = status.id;
            const recipientId = status.recipient_id;
            const statusType = status.status; // sent, delivered, read, failed
            const timestamp = status.timestamp;
            
            log(`[WHATSAPP-API] Status de entrega: ${statusType} para ${recipientId} (msgId: ${messageId})`);
            
            await logAuditEvent({
              direction: 'status',
              phone: recipientId,
              messageId,
              type: 'status',
              status: statusType,
              timestamp,
              payload: { status }
            });
            
            if (statusType === 'sent') {
              dbg(`[WHATSAPP-API] ✅ Mensagem ${messageId} enviada para ${recipientId}`);
            } else if (statusType === 'delivered') {
              log(`[WHATSAPP-API] ✅ Mensagem ${messageId} entregue para ${recipientId}`);
            } else if (statusType === 'read') {
              log(`[WHATSAPP-API] ✅ Mensagem ${messageId} lida por ${recipientId}`);
            } else if (statusType === 'failed') {
              const error = status.errors?.[0];
              const errorCode = error?.code;
              const errorMessage = error?.message;
              const errorDetails = error?.error_data;
              
              await logAuditEvent({
                direction: 'status',
                phone: recipientId,
                messageId,
                type: 'status',
                status: statusType,
                timestamp,
                payload: { errorDetails },
                errorCode,
                errorMessage
              });
              
              err(`[WHATSAPP-API] ❌ Mensagem ${messageId} falhou para ${recipientId}`);
              err(`[WHATSAPP-API] Código: ${errorCode}, Mensagem: ${errorMessage}`);
              
              if (errorDetails) {
                err(`[WHATSAPP-API] Detalhes:`, JSON.stringify(errorDetails, null, 2));
              }
              
              // Tratamento específico para erros comuns
              if (errorCode === 131047) {
                warn(`[WHATSAPP-API] ⚠️ Número ${recipientId} inválido ou não está no WhatsApp`);
              } else if (errorCode === 131026) {
                warn(`[WHATSAPP-API] ⚠️ Número ${recipientId} bloqueou ou não tem opt-in para MARKETING`);
                // Se for erro de opt-in, registra opt-out automaticamente
                if (ipBlocker && ipBlocker.removeOptIn) {
                  try {
                    await ipBlocker.removeOptIn(recipientId);
                    log(`[WHATSAPP-API] Opt-out registrado automaticamente para ${recipientId} devido a erro 131026`);
                  } catch (e) {
                    dbg(`[WHATSAPP-API] Erro ao registrar opt-out automático:`, e.message);
                  }
                }
              } else if (errorCode === 132012) {
                warn(`[WHATSAPP-API] ⚠️ Erro de formato do template para ${recipientId}`);
              }
            }
          }
          continue; // Pula processamento de mensagens se for apenas status
        }
        
        if (change.value?.messages) {
          for (const message of change.value.messages) {
            const from = message.from;
            const messageType = message.type;
            const messageId = message.id;
            
            log(`[WHATSAPP-API] Processando mensagem tipo: ${messageType} de ${from} (ID: ${messageId})`);
            dbg(`[WHATSAPP-API] Mensagem completa:`, JSON.stringify(message, null, 2));
            
            await logAuditEvent({
              direction: 'in',
              phone: from,
              messageId,
              type: messageType,
              status: 'received',
              timestamp: message.timestamp,
              payload: buildInboundPayload(message)
            });
            
            // Incrementa estatística de mensagem recebida
            if (global.statisticsModel) {
              global.statisticsModel.incrementReceived();
            }
            
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
            
            // Processa mensagens de botão (quick reply de template)
            if (messageType === 'button') {
              const buttonText = message.button?.text || message.button?.payload || '';
              log(`[WHATSAPP-API] Botão quick reply recebido de ${from}: "${buttonText}"`);
              const contextMessageId = message.context?.id || message.context?.message_id || message.context?.messageId || null;
              const buttonLower = String(buttonText || '').toLowerCase().trim();
              if (buttonLower === 'ver gravação' || buttonLower === 'ver gravacao' || buttonLower === 'ver gravaçao' || buttonLower === 'vergravacao' || buttonLower === 'vergravação') {
                await handleVideoRequest(from, contextMessageId, false);
              } else if (buttonLower === 'mais opções' || buttonLower === 'mais opcoes' || buttonLower === 'mais opção' || buttonLower === 'mais opcao') {
                await sendOptionsMenu(from);
              } else if (buttonText) {
                await handleTextMessage(from, buttonText, messageId);
              } else {
                warn(`[WHATSAPP-API] Botão quick reply sem texto/payload de ${from}`);
              }
              continue;
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
                const contextMessageId = message.context?.id || message.context?.message_id || message.context?.messageId || null;
                // Se o texto corresponde a um ID de botão conhecido, trata como resposta interativa
                if (
                  text === 'btn_ver_opcoes' ||
                  text.toLowerCase().includes('ver opções') ||
                  text.toLowerCase().includes('ver opcoes') ||
                  text.toLowerCase().includes('mais opções') ||
                  text.toLowerCase().includes('mais opcoes')
                ) {
                  log(`[WHATSAPP-API] Texto parece ser resposta de botão: "${text}"`);
                  await handleInteractiveResponse(from, 'btn_ver_opcoes', text);
                  continue;
                }
                if (text.toLowerCase().includes('ver grava')) {
                  log(`[WHATSAPP-API] Texto parece ser resposta de "Ver Gravação": "${text}"`);
                  await handleVideoRequest(from, contextMessageId, false);
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
   * Envia histórico de vídeos para o usuário
   * Função utilitária para evitar duplicação de código
   * @param {string} to - Número de destino
   * @returns {Promise<void>}
   */
  async function sendVideoHistory(to) {
    log(`[CMD] Enviando histórico de vídeos para ${to}`);
    
    if (!listVideosFunction) {
      await sendTextMessage(to, '❌ Sistema de histórico não disponível.');
      return;
    }
    
    try {
      const videos = listVideosFunction(to);
      
      if (videos.length === 0) {
        await sendTextMessage(to, '📹 *Histórico de Vídeos*\n\nNenhum vídeo disponível no momento.\n\n💡 Vídeos são gravados automaticamente quando a campainha é tocada.');
        return;
      }
      
      // Limita a 10 vídeos mais recentes para não sobrecarregar
      const displayVideos = videos.slice(0, 10);
      const remainingCount = videos.length - displayVideos.length;
      
      // Formata lista de vídeos com informações detalhadas
      let message = `📹 *Histórico de Vídeos*\n\n`;
      message += `📊 *Total:* ${videos.length} vídeo(s) disponível(is)\n`;
      message += `⏰ *Válidos por:* ${VIDEO_VIEW_HOURS} hora(s) após gravação\n\n`;
      message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
      
      displayVideos.forEach((video, index) => {
        const date = new Date(video.createdAt);
        const dateStr = date.toLocaleString('pt-BR', { 
          day: '2-digit', 
          month: '2-digit', 
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        });
        
        // Calcula tempo restante
        const now = Date.now();
        const expiresAt = video.expiresAt || (video.createdAt + (VIDEO_VIEW_HOURS * 60 * 60 * 1000));
        const timeRemaining = expiresAt - now;
        const hoursRemaining = Math.floor(timeRemaining / (60 * 60 * 1000));
        const minutesRemaining = Math.floor((timeRemaining % (60 * 60 * 1000)) / (60 * 1000));
        
        // Obtém tamanho do arquivo
        let fileSize = 'N/A';
        if (video.fileExists && video.filePath) {
          try {
            const stats = fs.statSync(video.filePath);
            const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
            fileSize = `${sizeMB} MB`;
          } catch (e) {
            fileSize = 'Erro';
          }
        }
        
        const status = video.fileExists ? '✅' : '❌';
        const timeStatus = timeRemaining > 0 ? `⏳ ${hoursRemaining}h ${minutesRemaining}min` : '⏰ Expirado';
        
        message += `${index + 1}. ${status} *${dateStr}*\n`;
        message += `   📁 Tamanho: ${fileSize}\n`;
        message += `   ${timeStatus} restante\n`;
        message += `   🆔 ID: \`${video.videoId.substring(0, 20)}...\`\n`;
        message += `   👁️ Ver: \`!video ${video.videoId}\`\n\n`;
      });
      
      if (remainingCount > 0) {
        message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        message += `📋 *E mais ${remainingCount} vídeo(s) disponível(is)*\n`;
      }
      
      message += `\n💡 *Como usar:*\n`;
      message += `• Digite \`!video <ID>\` para ver um vídeo\n`;
      message += `• Ou clique no botão "Ver Vídeo" quando receber a notificação\n`;
      message += `• Vídeos expiram automaticamente após ${VIDEO_VIEW_HOURS} hora(s)`;
      
      // Tenta enviar com List Message (permite mais opções que botões)
      if (displayVideos.length > 0 && sendListMessage) {
        try {
          const sections = [{
            title: 'Vídeos Disponíveis',
            rows: displayVideos.map((video, index) => {
              const date = new Date(video.createdAt);
              const timeStr = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
              const dateStr = date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
              
              // Obtém tamanho do arquivo
              let fileSize = 'N/A';
              if (video.fileExists && video.filePath) {
                try {
                  const stats = fs.statSync(video.filePath);
                  const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
                  fileSize = `${sizeMB}MB`;
                } catch (e) {
                  fileSize = 'N/A';
                }
              }
              
              return {
                id: `view_video_${video.videoId}`,
                title: `🎥 ${dateStr} ${timeStr}`,
                description: `${fileSize} | ${video.fileExists ? 'Disponível' : 'Indisponível'}`
              };
            })
          }];
          
          await sendListMessage(
            to,
            '📹 Histórico de Vídeos',
            'Selecione um vídeo para visualizar:',
            'Ver Vídeos',
            sections
          );
          log(`[CMD] Histórico enviado como List Message com ${displayVideos.length} opção(ões) para ${to}`);
          return;
        } catch (listError) {
          dbg(`[CMD] Erro ao enviar List Message, tentando botões:`, listError.message);
          // Continua para botões interativos
        }
      }
      
      // Fallback: Tenta enviar com botões interativos (máximo 3 por limitação da API)
      if (displayVideos.length > 0 && sendInteractiveButtons) {
        try {
          // Limita a 3 botões por vez (limitação da API do WhatsApp)
          const maxButtons = Math.min(displayVideos.length, 3);
          const buttons = displayVideos.slice(0, maxButtons).map((video, index) => {
            const date = new Date(video.createdAt);
            const timeStr = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
            return {
              id: `view_video_${video.videoId}`,
              title: `🎥 ${timeStr}`
            };
          });
          
          // Adiciona botão "Ver Mais" se houver mais vídeos
          if (videos.length > maxButtons) {
            buttons.push({
              id: 'opt_videos_list',
              title: '📋 Ver Todos'
            });
          }
          
          await sendInteractiveButtons(
            to,
            message,
            buttons,
            'Histórico de Vídeos'
          );
          log(`[CMD] Histórico enviado com ${buttons.length} botão(ões) interativo(s) para ${to}`);
          return;
        } catch (buttonError) {
          dbg(`[CMD] Erro ao enviar botões, usando texto:`, buttonError.message);
          // Continua para enviar como texto
        }
      }
      
      await sendTextMessage(to, message);
    } catch (e) {
      err(`[CMD] Erro ao listar histórico:`, e.message);
      await sendTextMessage(to, `❌ Erro ao listar histórico: ${e.message}`);
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
            description: 'Listar e gerenciar seus dispositivos (com status)'
          },
          {
            id: 'opt_tuya_count',
            title: '💡 Luzes Ligadas',
            description: 'Ver quantas luzes estão ligadas (lâmpadas e interruptores)'
          },
          {
            id: 'opt_snapshot',
            title: '📸 Snapshot da Câmera',
            description: 'Tirar foto instantânea da câmera'
          },
          {
            id: 'opt_record',
            title: '🎥 Gravar Vídeo',
            description: 'Gravar vídeo da câmera (padrão: 30 segundos)'
          },
          {
            id: 'opt_videos',
            title: '📹 Histórico de Vídeos',
            description: `Ver vídeos gravados recentemente (últimas ${VIDEO_VIEW_HOURS}h)`
          },
          {
            id: 'opt_blocked_ips',
            title: '🛡️ IPs Bloqueados',
            description: 'Ver lista de IPs bloqueados por segurança'
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
        const listErrorMsg = listError.message || String(listError) || 'Erro desconhecido';
        dbg(`[MENU] List Message não suportado, usando botões: ${listErrorMsg}`);
        // Verifica se é erro de lista de transmissão (não suporta mensagens interativas)
        if (listErrorMsg.includes('Invalid value') || listErrorMsg.includes('invalid') || listErrorMsg.includes('Evaluation failed')) {
          warn(`[MENU] Lista de transmissão não suporta mensagens interativas, usando texto simples`);
          // Pula botões e vai direto para texto
          const textMenu = '🏠 *Menu Principal*\n\n' +
            '📋 *1. Dispositivos Tuya*\n   Clique no botão ou digite: `!tuya list`\n\n' +
            '💡 *2. Luzes Ligadas*\n   Clique no botão ou digite: `!tuya count`\n\n' +
            '📸 *3. Snapshot da Câmera*\n   Clique no botão ou digite: `!snapshot`\n\n' +
            '🎥 *4. Gravar Vídeo*\n   Clique no botão ou digite: `!record`\n\n' +
            '📹 *5. Histórico de Vídeos*\n   Clique no botão ou digite: `!videos`\n\n' +
            '🛡️ *6. IPs Bloqueados*\n   Clique no botão ou digite: `!blocked`\n\n' +
            '❓ *7. Ajuda*\n   Clique no botão ou digite: `!tuya help`\n\n' +
            '💡 *Dica:* Clique nos botões acima para interagir sem digitar!';
          await sendTextMessage(to, textMenu);
          log(`[MENU] Menu de opções enviado como texto para ${to}`);
          return;
        }
        // Fallback: botões interativos
        try {
          await sendInteractiveButtons(
            to,
            '🏠 *Menu Principal*\n\n*Selecione uma opção:*\n\n' +
            '📋 *Dispositivos Tuya*\n   Listar dispositivos com status completo\n\n' +
            '💡 *Luzes Ligadas*\n   Ver quantas luzes estão ligadas\n\n' +
            '📸 *Snapshot da Câmera*\n   Tirar foto instantânea\n\n' +
            '🎥 *Gravar Vídeo*\n   Gravar vídeo da câmera\n\n' +
            `📹 *Histórico de Vídeos*\n   Ver vídeos recentes (${VIDEO_VIEW_HOURS}h)\n\n` +
            '🛡️ *IPs Bloqueados*\n   Ver lista de IPs bloqueados\n\n' +
            '❓ *Ajuda*\n   Ver comandos disponíveis',
            [
              { id: 'opt_tuya_list', title: '📋 Dispositivos' },
              { id: 'opt_tuya_count', title: '💡 Lâmpadas' },
              { id: 'opt_snapshot', title: '📸 Foto' },
              { id: 'opt_record', title: '🎥 Gravar' },
              { id: 'opt_videos', title: '📹 Vídeos' },
              { id: 'opt_blocked_ips', title: '🛡️ IPs' },
              { id: 'opt_help', title: '❓ Ajuda' }
            ],
            'WhatsApp API - Controle Inteligente'
          );
          log(`[MENU] Menu de opções enviado como botões para ${to}`);
          return;
        } catch (buttonError) {
          const errorMsg = buttonError.message || String(buttonError) || 'Erro desconhecido';
          dbg(`[MENU] Botões não suportados, usando texto: ${errorMsg}`);
          // Verifica se é erro de lista de transmissão
          if (errorMsg.includes('Invalid value') || errorMsg.includes('invalid') || errorMsg.includes('Evaluation failed')) {
            warn(`[MENU] Lista de transmissão não suporta mensagens interativas`);
          }
          // Fallback final: texto
          const textMenu = '🏠 *Menu Principal*\n\n' +
            '📋 *1. Dispositivos Tuya*\n   Clique no botão ou digite: `!tuya list`\n\n' +
            '💡 *2. Luzes Ligadas*\n   Clique no botão ou digite: `!tuya count`\n\n' +
            '📸 *3. Snapshot da Câmera*\n   Clique no botão ou digite: `!snapshot`\n\n' +
            '🎥 *4. Gravar Vídeo*\n   Clique no botão ou digite: `!record`\n\n' +
            '📹 *5. Histórico de Vídeos*\n   Clique no botão ou digite: `!videos`\n\n' +
            '🛡️ *6. IPs Bloqueados*\n   Clique no botão ou digite: `!blocked`\n\n' +
            '❓ *7. Ajuda*\n   Clique no botão ou digite: `!tuya help`\n\n' +
            '💡 *Dica:* Clique nos botões acima para interagir sem digitar!';
          await sendTextMessage(to, textMenu);
          log(`[MENU] Menu de opções enviado como texto para ${to}`);
        }
      }
    } catch (e) {
      err(`[MENU] Erro ao enviar menu de opções:`, e.message);
      // Último fallback
      try {
        await sendTextMessage(to, '🏠 Menu Principal\n\nClique nos botões ou digite:\n- !tuya list (dispositivos)\n- !tuya count (luzes)\n- !snapshot (foto)\n- !record (vídeo)\n- !videos (histórico)\n- !blocked (IPs bloqueados)\n- !tuya help');
      } catch (e2) {
        err(`[MENU] Erro no fallback final:`, e2.message);
      }
    }
  }
  
  /**
   * Envia lista de dispositivos Tuya
   */
  async function sendDevicesList(to, devices, page = 0) {
    try {
      if (!devices || devices.length === 0) {
        await sendTextMessage(to, '❌ Nenhum dispositivo encontrado.');
        return;
      }
      
      // Ordena dispositivos: online primeiro, depois offline
      const sortedDevices = [...devices].sort((a, b) => {
        const aOnline = a.online ? 1 : 0;
        const bOnline = b.online ? 1 : 0;
        // Online primeiro (ordem decrescente: 1 antes de 0)
        if (bOnline !== aOnline) {
          return bOnline - aOnline;
        }
        // Se ambos têm o mesmo status, ordena por nome
        const aName = (a.name || '').toLowerCase();
        const bName = (b.name || '').toLowerCase();
        return aName.localeCompare(bName);
      });
      
      const ITEMS_PER_PAGE = 10;
      const totalPages = Math.ceil(sortedDevices.length / ITEMS_PER_PAGE);
      const startIndex = page * ITEMS_PER_PAGE;
      const endIndex = startIndex + ITEMS_PER_PAGE;
      const pageDevices = sortedDevices.slice(startIndex, endIndex);
      const hasMore = endIndex < sortedDevices.length;
      
      // Tenta enviar como List Message (sempre tenta primeiro)
      try {
        // Limita a 10 itens por seção (limitação da API do WhatsApp)
        const maxItemsPerSection = 10;
        const deviceRows = pageDevices.slice(0, maxItemsPerSection).map((device, index) => {
          const status = device.online ? '🟢' : '🔴';
          const powered = device.poweredOn ? '⚡' : '⚫';
          const onlineStatus = device.online ? 'Online' : 'Offline';
          const deviceName = device.name || `Dispositivo ${startIndex + index + 1}`;
          
          // Limita tamanho do título e descrição (limitações da API)
          const title = `${status} ${deviceName.substring(0, 20)}`; // Máximo ~24 caracteres
          const description = `${powered} ${onlineStatus} | ${(device.category || 'Sem categoria').substring(0, 50)}`; // Máximo ~60 caracteres
          
          return {
            id: `device_${device.id}`,
            title: title,
            description: description
          };
        });
        
        // Adiciona opção "Ver Mais" se houver mais páginas (dentro do limite de 10 itens)
        if (hasMore && deviceRows.length < maxItemsPerSection) {
          deviceRows.push({
            id: `devices_page_${page + 1}`,
            title: '📄 Ver Próxima Página',
            description: `Mostrar mais ${Math.min(ITEMS_PER_PAGE, sortedDevices.length - endIndex)} dispositivo(s)`
          });
        }
        
        const sections = [{
          title: hasMore ? `Dispositivos (Página ${page + 1}/${totalPages})` : 'Dispositivos Disponíveis',
          rows: deviceRows
        }];
        
        dbg(`[MENU] Tentando enviar List Message com ${deviceRows.length} item(ns) para ${to}`);
        
        await sendListMessage(
          to,
          '📋 Dispositivos Tuya',
          `Selecione um dispositivo (${startIndex + 1}-${Math.min(endIndex, sortedDevices.length)} de ${sortedDevices.length}):`,
          'Ver Dispositivos',
          sections
        );
        log(`[MENU] ✅ Lista de ${pageDevices.length} dispositivo(s) (página ${page + 1}/${totalPages}) enviada como List Message para ${to}`);
        return;
      } catch (listError) {
        const errorMsg = listError.response?.data || listError.message || String(listError);
        err(`[MENU] ❌ Erro ao enviar List Message:`, errorMsg);
        if (listError.response?.data) {
          err(`[MENU] Detalhes do erro:`, JSON.stringify(listError.response.data, null, 2));
        }
        dbg(`[MENU] List Message falhou, usando texto como fallback`);
      }
      
      // Fallback: mensagem de texto formatada
      if (tuya && tuya.formatDevicesListMessage) {
        // Ordena dispositivos: online primeiro
        const sortedDevices = [...devices].sort((a, b) => {
          const aOnline = a.online ? 1 : 0;
          const bOnline = b.online ? 1 : 0;
          if (bOnline !== aOnline) {
            return bOnline - aOnline;
          }
          const aName = (a.name || '').toLowerCase();
          const bName = (b.name || '').toLowerCase();
          return aName.localeCompare(bName);
        });
        
        const ITEMS_PER_PAGE = 10;
        const startIndex = page * ITEMS_PER_PAGE;
        const endIndex = startIndex + ITEMS_PER_PAGE;
        const pageDevices = sortedDevices.slice(startIndex, endIndex);
        const hasMore = endIndex < sortedDevices.length;
        const totalPages = Math.ceil(sortedDevices.length / ITEMS_PER_PAGE);
        
        let textList = `📋 *Dispositivos Tuya*\n\n`;
        textList += `*Total:* ${sortedDevices.length} dispositivo(s)\n`;
        textList += `*Página:* ${page + 1}/${totalPages}\n\n`;
        textList += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        
        // Agrupa por status
        const onlineDevices = pageDevices.filter(d => d.online);
        const offlineDevices = pageDevices.filter(d => !d.online);
        
        if (onlineDevices.length > 0) {
          textList += `🟢 *ONLINE (${onlineDevices.length})*\n\n`;
          onlineDevices.forEach((device, index) => {
            const powered = device.poweredOn ? '⚡ Ligado' : '⚫ Desligado';
            textList += `${startIndex + index + 1}. ${device.name || `Dispositivo ${startIndex + index + 1}`}\n`;
            textList += `   ${powered} | ${device.category || 'Sem categoria'}\n`;
            textList += `   ID: \`device_${device.id}\`\n\n`;
          });
        }
        
        if (offlineDevices.length > 0) {
          if (onlineDevices.length > 0) {
            textList += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
          }
          textList += `🔴 *OFFLINE (${offlineDevices.length})*\n\n`;
          offlineDevices.forEach((device, index) => {
            const powered = device.poweredOn ? '⚡ Ligado' : '⚫ Desligado';
            textList += `${startIndex + onlineDevices.length + index + 1}. ${device.name || `Dispositivo ${startIndex + onlineDevices.length + index + 1}`}\n`;
            textList += `   ${powered} | ${device.category || 'Sem categoria'}\n`;
            textList += `   ID: \`device_${device.id}\`\n\n`;
          });
        }
        
        if (hasMore) {
          textList += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
          textList += `📄 *Mais ${Math.min(ITEMS_PER_PAGE, sortedDevices.length - endIndex)} dispositivo(s) disponível(is)*\n`;
          textList += `💡 Digite \`!tuya list page ${page + 1}\` para ver a próxima página`;
        }
        
        await sendTextMessage(to, textList);
        log(`[MENU] Lista de ${pageDevices.length} dispositivo(s) (página ${page + 1}/${totalPages}) enviada como texto para ${to}`);
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
              
              // Não deleta imediatamente - deixa o sistema de expiração cuidar
              // camera.cleanupVideoFile(partFile, `após envio da parte ${i + 1}`);
            } catch (sendError) {
              err(`[CMD] Erro ao enviar parte ${i + 1}/${videoParts.length}:`, sendError.message);
              await sendTextMessage(to, `❌ Erro ao enviar parte ${i + 1}/${videoParts.length}: ${sendError.message}`);
              // Não deleta em caso de erro também - pode ser útil para debug
            // camera.cleanupVideoFile(partFile, 'após erro no envio');
              // Continua tentando enviar as outras partes
            }
          }
          
          // Não deleta imediatamente - deixa o sistema de expiração cuidar
          // if (originalFilePath !== finalVideoPath && fs.existsSync(originalFilePath)) {
          //   camera.cleanupVideoFile(originalFilePath, 'após envio (arquivo original)');
          // }
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
  function formatVideoError(errorCode) {
    switch (errorCode) {
      case 'processing':
        return '⏳ Vídeo em processamento. Assim que pronto lhe será enviado.';
      case 'expired':
        return '⏰ Este vídeo expirou e não está mais disponível.';
      case 'not_found':
        return '⏰ Este vídeo expirou ou foi removido.';
      case 'failed':
        return '❌ Falha ao gerar o vídeo. Tente novamente mais tarde.';
      default:
        return `❌ ${errorCode || 'Erro ao processar vídeo'}`;
    }
  }

  async function handleVideoRequest(from, contextMessageId = null, fallbackToLatest = true) {
    // Busca vídeo associado ao messageId do template (quando disponível)
    let videoId = null;
    if (contextMessageId && getVideoIdByMessageIdFunction) {
      try {
        videoId = getVideoIdByMessageIdFunction(contextMessageId, from);
      } catch (e) {
        dbg(`[WHATSAPP-API] Erro ao resolver vídeo por messageId:`, e.message);
      }
    }
    
    // Fallback: vídeo mais recente do usuário
    if (!videoId && fallbackToLatest) {
      if (!listVideosFunction) {
        await sendTextMessage(from, '❌ Sistema de vídeos não disponível.');
        return;
      }
      const videos = listVideosFunction(from);
      if (videos.length === 0) {
        await sendTextMessage(from, '❌ Nenhum vídeo disponível no momento.');
        return;
      }
      videoId = videos[0].videoId;
    }
    
    if (!videoId) {
      await sendTextMessage(from, formatVideoError('not_found'));
      return;
    }
    
    if (!tempVideoProcessor) {
      await sendTextMessage(from, '❌ Sistema de vídeos temporários não disponível.');
      return;
    }
    
    const result = tempVideoProcessor(videoId, from);
    if (!result.success) {
      if (result.error === 'processing' && addPendingVideoRequestFunction) {
        addPendingVideoRequestFunction(videoId, from);
      }
      await sendTextMessage(from, formatVideoError(result.error));
      return;
    }
    
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
      const partNumber = videoParts.length > 1 ? ` (Parte ${i + 1}/${videoParts.length})` : '';
      const caption = `🎥 Vídeo da campainha${partNumber}`;
      
      try {
        await sendTextMessage(from, `⏳ Enviando vídeo${partNumber}...`);
        const videoBase64 = partBuffer.toString('base64');
        await sendMediaFromBase64(from, videoBase64, 'video/mp4', caption);
        log(`[WHATSAPP-API] Parte ${i + 1}/${videoParts.length} do vídeo ${videoId} enviada para ${from}`);
        
        if (i < videoParts.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      } catch (sendError) {
        err(`[WHATSAPP-API] Erro ao enviar parte ${i + 1}/${videoParts.length}:`, sendError.message);
        await sendTextMessage(from, `❌ Erro ao enviar parte ${i + 1}/${videoParts.length}: ${sendError.message}`);
      }
    }
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
    
    // Auto opt-in: quando usuário envia mensagem, registra opt-in automaticamente
    if (ipBlocker && ipBlocker.updateLastMessageTime) {
      try {
        await ipBlocker.updateLastMessageTime(from);
        dbg(`[OPT-IN] Auto opt-in registrado para ${from}`);
      } catch (e) {
        dbg(`[OPT-IN] Erro ao registrar auto opt-in:`, e.message);
      }
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
    
    // Processa resposta "Ver Gravação" do template status_portao
    if (msgLower === 'ver gravação' || msgLower === 'ver gravacao' || msgLower === 'ver gravaçao' || msgLower === 'vergravação' || msgLower === 'vergravacao') {
      log(`[WHATSAPP-API] Resposta "Ver Gravação" recebida de ${from}`);
      try {
        await handleVideoRequest(from);
      } catch (e) {
        err(`[WHATSAPP-API] Erro ao processar "Ver Gravação":`, e.message);
        await sendTextMessage(from, `❌ Erro ao processar vídeo: ${e.message}`);
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
    
    // Processa botão "Ver opções"/"Mais opções"
    if (
      text === 'btn_ver_opcoes' ||
      msgLower === 'ver opções' ||
      msgLower === 'ver opcoes' ||
      msgLower === 'ver opção' ||
      msgLower === 'ver opcao' ||
      msgLower === 'mais opções' ||
      msgLower === 'mais opcoes' ||
      msgLower === 'mais opção' ||
      msgLower === 'mais opcao'
    ) {
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
    
    // Comando !optin - Ativa opt-in para receber mensagens MARKETING
    if (msgLower === '!optin' || msgLower === 'optin' || msgLower === 'ativar notificações' || msgLower === 'ativar notificacoes') {
      log(`[WHATSAPP-API] Comando !optin recebido de ${from}`);
      try {
        if (!ipBlocker || !ipBlocker.addOptIn) {
          await sendTextMessage(from, '❌ Sistema de opt-in não disponível.');
          return;
        }
        
        const result = await ipBlocker.addOptIn(from);
        if (result.success) {
          await sendTextMessage(from, '✅ *Opt-in ativado!*\n\nVocê agora receberá notificações de campainha e outras mensagens promocionais.\n\nPara desativar, envie: !optout');
        } else {
          await sendTextMessage(from, `❌ Erro ao ativar opt-in: ${result.message}`);
        }
      } catch (e) {
        err(`[WHATSAPP-API] Falha ao processar !optin:`, e.message);
        await sendTextMessage(from, `❌ Erro: ${e.message}`);
      }
      return;
    }
    
    // Comando !optout - Desativa opt-in (opt-out)
    if (msgLower === '!optout' || msgLower === 'optout' || msgLower === 'desativar notificações' || msgLower === 'desativar notificacoes') {
      log(`[WHATSAPP-API] Comando !optout recebido de ${from}`);
      try {
        if (!ipBlocker || !ipBlocker.removeOptIn) {
          await sendTextMessage(from, '❌ Sistema de opt-out não disponível.');
          return;
        }
        
        const result = await ipBlocker.removeOptIn(from);
        if (result.success) {
          await sendTextMessage(from, '❌ *Opt-out ativado!*\n\nVocê não receberá mais notificações de campainha e mensagens promocionais.\n\nPara reativar, envie: !optin');
        } else {
          await sendTextMessage(from, `❌ Erro ao processar opt-out: ${result.message}`);
        }
      } catch (e) {
        err(`[WHATSAPP-API] Falha ao processar !optout:`, e.message);
        await sendTextMessage(from, `❌ Erro: ${e.message}`);
      }
      return;
    }
    
    // Comando !optstatus - Verifica status de opt-in
    if (msgLower === '!optstatus' || msgLower === 'optstatus' || msgLower === 'status notificações' || msgLower === 'status notificacoes') {
      log(`[WHATSAPP-API] Comando !optstatus recebido de ${from}`);
      try {
        if (!ipBlocker || !ipBlocker.hasOptIn) {
          await sendTextMessage(from, '❌ Sistema de opt-in não disponível.');
          return;
        }
        
        const status = await ipBlocker.hasOptIn(from);
        const statusText = status.optedIn ? '✅ *ATIVO*' : '❌ *INATIVO*';
        const optedInDate = status.optedInAt ? new Date(status.optedInAt * 1000).toLocaleString('pt-BR') : 'N/A';
        const optedOutDate = status.optedOutAt ? new Date(status.optedOutAt * 1000).toLocaleString('pt-BR') : 'N/A';
        
        let message = `📊 *Status de Notificações*\n\n`;
        message += `Status: ${statusText}\n`;
        if (status.optedIn) {
          message += `Ativado em: ${optedInDate}\n`;
        } else {
          message += `Desativado em: ${optedOutDate}\n`;
        }
        message += `\nPara alterar, envie:\n`;
        message += `• !optin - Ativar notificações\n`;
        message += `• !optout - Desativar notificações`;
        
        await sendTextMessage(from, message);
      } catch (e) {
        err(`[WHATSAPP-API] Falha ao processar !optstatus:`, e.message);
        await sendTextMessage(from, `❌ Erro: ${e.message}`);
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
        if (result.error === 'processing' && addPendingVideoRequestFunction) {
          addPendingVideoRequestFunction(videoId, from);
        }
        await sendTextMessage(from, formatVideoError(result.error));
        return;
      }
        
        // Lê o arquivo de vídeo
        
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
            
            // Não deleta imediatamente - deixa o sistema de expiração cuidar
            // camera.cleanupVideoFile(partFile, `após envio da parte ${i + 1}`);
          } catch (sendError) {
            err(`[WHATSAPP-API] Erro ao enviar parte ${i + 1}/${videoParts.length}:`, sendError.message);
            await sendTextMessage(from, `❌ Erro ao enviar parte ${i + 1}/${videoParts.length}: ${sendError.message}`);
            // Não deleta em caso de erro também - pode ser útil para debug
            // camera.cleanupVideoFile(partFile, 'após erro no envio');
          }
        }
      } catch (e) {
        err(`[WHATSAPP-API] Erro ao enviar vídeo via comando:`, e.message);
        await sendTextMessage(from, `❌ Erro ao enviar vídeo: ${e.message}`);
      }
      return;
    }
    
    // Comandos de histórico de vídeos
    // Comando !snapshot ou !foto
    if (msgLower === '!snapshot' || msgLower === '!foto' || msgLower === '!photo') {
      log(`[CMD] Comando de snapshot recebido de ${from}`);
      try {
        if (triggerSnapshotFunction) {
          await sendTextMessage(from, '⏳ Tirando foto da câmera...');
          const result = await triggerSnapshotFunction('📸 Snapshot solicitado manualmente', from);
          if (result && result.ok) {
            await sendTextMessage(from, `✅ Foto enviada com sucesso para ${result.successCount || 0} número(s)!`);
          } else {
            await sendTextMessage(from, `❌ Erro ao tirar foto: ${result?.error || 'Erro desconhecido'}`);
          }
        } else {
          await sendTextMessage(from, '❌ Função de snapshot não disponível. Configure a câmera.');
        }
      } catch (e) {
        err(`[CMD] Erro ao processar snapshot:`, e.message);
        await sendTextMessage(from, `❌ Erro: ${e.message}`);
      }
      return;
    }
    
    if (msgLower === '!historico' || msgLower === '!histórico' || msgLower === '!videos' || msgLower === '!hist') {
      log(`[CMD] Comando de histórico recebido de ${from}`);
      await sendVideoHistory(from);
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
          await sendTextMessage(from, '⏳ Buscando informações de IPs...');
          
          // Busca todas as listas em paralelo (limita a 10 IPs por lista para evitar mensagem muito longa)
          const [blockedIPs, whitelistIPs, yellowlistIPs, totalBlocked, totalWhitelist, totalYellowlist] = await Promise.all([
            ipBlocker.listBlockedIPs(10, 0),
            ipBlocker.listWhitelistIPs ? ipBlocker.listWhitelistIPs(10, 0) : Promise.resolve([]),
            ipBlocker.listYellowlistIPs ? ipBlocker.listYellowlistIPs(10, 0) : Promise.resolve([]),
            ipBlocker.countBlockedIPs(),
            ipBlocker.countWhitelistIPs ? ipBlocker.countWhitelistIPs() : Promise.resolve(0),
            ipBlocker.countYellowlistIPs ? ipBlocker.countYellowlistIPs() : Promise.resolve(0)
          ]);
          
          // Formata data de forma mais curta
          const formatShortDate = (timestamp) => {
            if (!timestamp) return 'Nunca';
            const date = new Date(timestamp * 1000);
            return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
          };
          
          // Envia resumo primeiro
          const summary = `🛡️ *Status de IPs*\n\n` +
            `📊 *Resumo:*\n` +
            `🔴 Bloqueados: ${totalBlocked}\n` +
            `🟡 Monitorados: ${totalYellowlist}\n` +
            `🟢 Permitidos: ${totalWhitelist}\n` +
            `📈 *Total:* ${totalBlocked + totalYellowlist + totalWhitelist} IP(s)\n\n` +
            `💡 Mostrando últimos 10 IPs de cada lista.`;
          
          await sendTextMessage(from, summary);
          
          // Blacklist (Bloqueados)
          if (blockedIPs.length > 0) {
            let blacklistMsg = `🔴 *Blacklist (${totalBlocked} bloqueado${totalBlocked !== 1 ? 's' : ''})*\n\n`;
            blockedIPs.forEach((ipData, index) => {
              const blockedDate = formatShortDate(ipData.blocked_at);
              blacklistMsg += `${index + 1}. *${ipData.ip}*\n`;
              blacklistMsg += `   📅 ${blockedDate} | 🔢 ${ipData.request_count || 0} tentativa${(ipData.request_count || 0) !== 1 ? 's' : ''}\n`;
              // Trunca motivo se muito longo
              const reason = (ipData.reason || 'Não especificado').substring(0, 50);
              if ((ipData.reason || '').length > 50) {
                blacklistMsg += `   📝 ${reason}...\n\n`;
              } else {
                blacklistMsg += `   📝 ${reason}\n\n`;
              }
            });
            if (totalBlocked > blockedIPs.length) {
              blacklistMsg += `💡 +${totalBlocked - blockedIPs.length} outro(s) bloqueado(s).`;
            }
            await sendTextMessage(from, blacklistMsg);
          }
          
          // Yellowlist (Monitorados)
          if (yellowlistIPs.length > 0) {
            let yellowlistMsg = `🟡 *Yellowlist (${totalYellowlist} monitorado${totalYellowlist !== 1 ? 's' : ''})*\n\n`;
            yellowlistIPs.forEach((ipData, index) => {
              const expiresDate = formatShortDate(ipData.expires_at);
              const lastSeenDate = ipData.last_seen ? formatShortDate(ipData.last_seen) : 'Nunca';
              yellowlistMsg += `${index + 1}. *${ipData.ip}*\n`;
              yellowlistMsg += `   ⚠️ ${ipData.abuse_confidence}% | 📊 ${ipData.reports || 0} report${(ipData.reports || 0) !== 1 ? 's' : ''}\n`;
              yellowlistMsg += `   🔢 ${ipData.request_count || 0} tentativa${(ipData.request_count || 0) !== 1 ? 's' : ''} | 👁️ Última: ${lastSeenDate}\n`;
              yellowlistMsg += `   ⏰ Expira: ${expiresDate}\n\n`;
            });
            if (totalYellowlist > yellowlistIPs.length) {
              yellowlistMsg += `💡 +${totalYellowlist - yellowlistIPs.length} outro(s) monitorado(s).`;
            }
            await sendTextMessage(from, yellowlistMsg);
          }
          
          // Whitelist (Permitidos)
          if (whitelistIPs.length > 0) {
            let whitelistMsg = `🟢 *Whitelist (${totalWhitelist} permitido${totalWhitelist !== 1 ? 's' : ''})*\n\n`;
            whitelistIPs.forEach((ipData, index) => {
              const expiresDate = formatShortDate(ipData.expires_at);
              const lastSeenDate = ipData.last_seen ? formatShortDate(ipData.last_seen) : 'Nunca';
              whitelistMsg += `${index + 1}. *${ipData.ip}*\n`;
              whitelistMsg += `   ✅ ${ipData.abuse_confidence}% | 📊 ${ipData.reports || 0} report${(ipData.reports || 0) !== 1 ? 's' : ''}\n`;
              whitelistMsg += `   🔢 ${ipData.request_count || 0} tentativa${(ipData.request_count || 0) !== 1 ? 's' : ''} | 👁️ Última: ${lastSeenDate}\n`;
              whitelistMsg += `   ⏰ Expira: ${expiresDate}\n\n`;
            });
            if (totalWhitelist > whitelistIPs.length) {
              whitelistMsg += `💡 +${totalWhitelist - whitelistIPs.length} outro(s) permitido(s).`;
            }
            await sendTextMessage(from, whitelistMsg);
          }
          
          // Se todas as listas estão vazias
          if (blockedIPs.length === 0 && yellowlistIPs.length === 0 && whitelistIPs.length === 0) {
            await sendTextMessage(from, '✅ Nenhum IP nas listas no momento.');
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
    
    if (responseId === 'opt_snapshot') {
      log(`[WHATSAPP-API] Opção "Snapshot" selecionada por ${from}`);
      try {
        if (triggerSnapshotFunction) {
          await sendTextMessage(from, '⏳ Tirando foto da câmera...');
          const result = await triggerSnapshotFunction('📸 Snapshot solicitado manualmente', from);
          if (result && result.ok) {
            await sendTextMessage(from, `✅ Foto enviada com sucesso para ${result.successCount || 0} número(s)!`);
          } else {
            await sendTextMessage(from, `❌ Erro ao tirar foto: ${result?.error || 'Erro desconhecido'}`);
          }
        } else {
          await sendTextMessage(from, '❌ Função de snapshot não disponível. Configure a câmera.');
        }
      } catch (e) {
        err(`[WHATSAPP-API] Erro ao processar opt_snapshot:`, e.message);
        await sendTextMessage(from, `❌ Erro: ${e.message}`);
      }
      return;
    }
    
    if (responseId === 'opt_videos') {
      log(`[WHATSAPP-API] Opção "Histórico de Vídeos" selecionada por ${from}`);
      await sendVideoHistory(from);
      return;
    }
    
    // Processa botão "Ver Todos" do histórico
    if (responseId === 'opt_videos_list') {
      log(`[WHATSAPP-API] Botão "Ver Todos" do histórico clicado por ${from}`);
      // Reenvia o histórico de vídeos completo
      await sendVideoHistory(from);
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
        // Normaliza o número do remetente para verificação
        // O 'from' pode vir em diferentes formatos da API do WhatsApp
        let normalizedFrom = from;
        
        // Remove prefixo do WhatsApp se existir
        if (normalizedFrom.includes('@')) {
          normalizedFrom = normalizedFrom.split('@')[0];
        }
        
        // Normaliza usando a função normalizeBR
        normalizedFrom = normalizeBR(normalizedFrom);
        
        log(`[WHATSAPP-API] Processando vídeo ${videoId} para ${from} (normalizado: ${normalizedFrom})`);
        
        const result = tempVideoProcessor(videoId, normalizedFrom);
        
        if (!result.success) {
          err(`[WHATSAPP-API] Erro ao processar vídeo ${videoId}: ${result.error}`);
          if (result.error === 'processing' && addPendingVideoRequestFunction) {
            addPendingVideoRequestFunction(videoId, normalizedFrom);
          }
          await sendTextMessage(from, formatVideoError(result.error));
          return;
        }
        
        // Lê o arquivo de vídeo
        
        if (!fs.existsSync(result.filePath)) {
          err(`[WHATSAPP-API] Arquivo não encontrado: ${result.filePath}`);
          await sendTextMessage(from, '❌ Arquivo de vídeo não encontrado no servidor.');
          return;
        }
        
        log(`[WHATSAPP-API] Arquivo encontrado: ${result.filePath}`);
        
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
            
            // Não deleta imediatamente - deixa o sistema de expiração cuidar
            // camera.cleanupVideoFile(partFile, `após envio da parte ${i + 1}`);
          } catch (sendError) {
            err(`[WHATSAPP-API] Erro ao enviar parte ${i + 1}/${videoParts.length}:`, sendError.message);
            await sendTextMessage(from, `❌ Erro ao enviar parte ${i + 1}/${videoParts.length}: ${sendError.message}`);
            // Não deleta em caso de erro também - pode ser útil para debug
            // camera.cleanupVideoFile(partFile, 'após erro no envio');
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
    
    // Processa ações de dispositivo (action_on_*, action_off_*, action_toggle_*)
    if (responseId.startsWith('action_on_') || responseId.startsWith('action_off_') || responseId.startsWith('action_toggle_')) {
      const parts = responseId.split('_');
      const action = parts[1]; // 'on', 'off' ou 'toggle'
      const deviceId = parts.slice(2).join('_'); // Pega o resto (pode ter _ no ID)
      
      log(`[WHATSAPP-API] Ação ${action} solicitada para dispositivo ${deviceId} por ${from}`);
      
      try {
        if (!tuya) {
          await sendTextMessage(from, '❌ Módulo Tuya não configurado.');
          return;
        }
        
        const devices = await tuya.getCachedDevices();
        const device = devices.find(d => d.id === deviceId);
        
        if (!device) {
          await sendTextMessage(from, '❌ Dispositivo não encontrado.');
          return;
        }
        
        await sendTextMessage(from, `⏳ ${action === 'on' ? 'Ligando' : action === 'off' ? 'Desligando' : 'Alternando'} ${device.name}...`);
        
        let newStatus;
        if (action === 'on') {
          await tuya.turnOnDevice(device.id);
          newStatus = await tuya.getDeviceStatus(device.id);
        } else if (action === 'off') {
          await tuya.turnOffDevice(device.id);
          newStatus = await tuya.getDeviceStatus(device.id);
        } else if (action === 'toggle') {
          await tuya.toggleDevice(device.id);
          newStatus = await tuya.getDeviceStatus(device.id);
        }
        
        const poweredOn = newStatus.filter(s => {
          const code = s.code?.toLowerCase() || '';
          const value = s.value;
          if (code.includes('switch') || code.includes('power')) {
            return value === true || value === 1 || value === 'true' || value === 'on';
          }
          return false;
        }).length > 0;
        
        const statusMsg = tuya.formatDeviceStatusMessage(device.name, newStatus, poweredOn);
        
        // Reenvia status atualizado com botões de ação
        try {
          await sendInteractiveButtons(
            from,
            `✅ *Ação executada com sucesso!*\n\n${statusMsg}`,
            [
              { id: `action_on_${device.id}`, title: '⚡ Ligar' },
              { id: `action_off_${device.id}`, title: '⚫ Desligar' },
              { id: `action_toggle_${device.id}`, title: '🔄 Alternar' },
              { id: 'opt_tuya_list', title: '📋 Voltar' }
            ],
            `Dispositivo: ${device.name}`
          );
        } catch (buttonError) {
          await sendTextMessage(from, `✅ *Ação executada com sucesso!*\n\n${statusMsg}`);
        }
        
      } catch (e) {
        err(`[WHATSAPP-API] Erro ao processar ação ${action}:`, e.message);
        await sendTextMessage(from, `❌ Erro ao ${action === 'on' ? 'ligar' : action === 'off' ? 'desligar' : 'alternar'} dispositivo: ${e.message}`);
      }
      return;
    }
    
    if (responseId === 'opt_help') {
      log(`[WHATSAPP-API] Opção "Ajuda" selecionada por ${from}`);
      try {
        if (tuya && tuya.formatHelpMessage) {
          const helpMsg = tuya.formatHelpMessage();
          await sendTextMessage(from, helpMsg);
        } else {
          await sendTextMessage(from, '❓ *Ajuda*\n\nComandos disponíveis:\n- `!menu` - Menu principal\n- `!tuya list` - Listar dispositivos\n- `!tuya on <nome>` - Ligar dispositivo\n- `!tuya off <nome>` - Desligar dispositivo\n- `!tuya toggle <nome>` - Alternar dispositivo\n- `!record` - Gravar vídeo\n- `!ping` - Teste de conexão');
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
    
    // Templates
    sendTemplateMessage,
    sendLoginWebAppCode,
    sendStatusCode,
    
    // Webhook
    verifyWebhook,
    processWebhookMessage,
    
    // Configuração
    setTempVideoProcessor: (processor) => {
      tempVideoProcessor = processor;
      log(`[WHATSAPP-API] Processador de vídeos temporários configurado`);
    },
    setListVideosFunction: (listFunction) => {
      listVideosFunction = listFunction;
      log(`[WHATSAPP-API] Função de listagem de vídeos configurada`);
    },
    setGetVideoIdByMessageIdFunction: (getter) => {
      getVideoIdByMessageIdFunction = getter;
      log(`[WHATSAPP-API] Função de resolução de vídeo por messageId configurada`);
    },
    setAddPendingVideoRequestFunction: (adder) => {
      addPendingVideoRequestFunction = adder;
      log(`[WHATSAPP-API] Função de pedidos pendentes configurada`);
    },
    setTriggerSnapshotFunction: (triggerFunction) => {
      triggerSnapshotFunction = triggerFunction;
      log(`[WHATSAPP-API] Função de trigger de snapshot configurada`);
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

