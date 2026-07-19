const axios = require('axios');
const crypto = require('crypto');

const { getPublicSettings } = require('./settings');
const { sanitizePayload } = require('./utils');
const { createChatbotService } = require('./chatbot');

function createWhatsAppService({ db }) {
  const chatbot = createChatbotService({ db });
  async function getConfig() {
    const settings = await getPublicSettings(db);
    return settings.whatsapp;
  }

  /**
   * Retorna o destinatário real considerando o modo desenvolvedor.
   * Quando dev.mode_enabled=true e dev.test_phone está preenchido,
   * TODOS os envios são redirecionados para o número de teste.
   * Retorna também um flag para prefixar mensagens de texto.
   */
  async function resolveRecipient(originalTo) {
    const settings = await getPublicSettings(db);
    if (settings.dev.mode_enabled && settings.dev.test_phone) {
      return { to: settings.dev.test_phone, devMode: true, originalTo };
    }
    return { to: originalTo, devMode: false, originalTo };
  }

async function graphRequest({ method, path, data, params }) {
  const config = await getConfig();
  if (!config.access_token || !config.phone_number_id || !config.api_version) {
    throw new Error('WhatsApp configuration is incomplete.');
  }
  try {
    const response = await axios({
      method,
      url: `https://graph.facebook.com/${config.api_version}${path}`,
      headers: {
        Authorization: `Bearer ${config.access_token}`,
        'Content-Type': 'application/json',
      },
      data,
      params,
      timeout: 20000,
    });

    return response.data;
  } catch (error) {
    throw createGraphApiError(error);
  }
}

  async function sendText({ clientId, requestId, ip, to, text, clientReference }) {
    const recipient = await resolveRecipient(to);
    const body = recipient.devMode
      ? `[DEV → ${recipient.originalTo}] ${text}`
      : text;
    const payload = {
      messaging_product: 'whatsapp',
      to: recipient.to,
      type: 'text',
      text: { body },
    };
    const auditId = await db.createMessageAudit({
      requestId,
      clientId,
      clientReference,
      toNumber: to,
      devRedirectedTo: recipient.devMode ? recipient.to : '',
      messageType: 'text',
      status: 'pending',
      payload,
      sourceIp: ip,
    });
    try {
      const config = await getConfig();
      const response = await graphRequest({
        method: 'post',
        path: `/${config.phone_number_id}/messages`,
        data: payload,
      });
      const metaMessageId = response.messages?.[0]?.id || '';
      await db.updateMessageAudit(auditId, {
        status: 'sent',
        metaMessageId,
        response,
      });
      return { auditId, metaMessageId };
    } catch (error) {
      await db.updateMessageAudit(auditId, {
        status: 'failed',
        error: extractAxiosError(error),
      });
      throw error;
    }
  }

  async function sendInteractive({ clientId, requestId, ip, to, interactive, clientReference }) {
    const recipient = await resolveRecipient(to);
    const payload = {
      messaging_product: 'whatsapp',
      to: recipient.to,
      type: 'interactive',
      interactive,
    };
    const auditId = await db.createMessageAudit({
      requestId,
      clientId,
      clientReference,
      toNumber: to,
      devRedirectedTo: recipient.devMode ? recipient.to : '',
      messageType: 'interactive',
      status: 'pending',
      payload,
      sourceIp: ip,
    });
    try {
      const config = await getConfig();
      const response = await graphRequest({
        method: 'post',
        path: `/${config.phone_number_id}/messages`,
        data: payload,
      });
      const metaMessageId = response.messages?.[0]?.id || '';
      await db.updateMessageAudit(auditId, { status: 'sent', metaMessageId, response });
      return { auditId, metaMessageId };
    } catch (error) {
      await db.updateMessageAudit(auditId, { status: 'failed', error: extractAxiosError(error) });
      throw error;
    }
  }

  async function sendTemplate({ clientId, requestId, ip, to, templateName, languageCode, components, clientReference }) {
    const recipient = await resolveRecipient(to);
    const payload = {
      messaging_product: 'whatsapp',
      to: recipient.to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        components: components || [],
      },
    };
    const auditId = await db.createMessageAudit({
      requestId,
      clientId,
      clientReference,
      toNumber: to,
      devRedirectedTo: recipient.devMode ? recipient.to : '',
      messageType: 'template',
      status: 'pending',
      payload,
      sourceIp: ip,
    });
    try {
      const config = await getConfig();
      const response = await graphRequest({
        method: 'post',
        path: `/${config.phone_number_id}/messages`,
        data: payload,
      });
      const metaMessageId = response.messages?.[0]?.id || '';
      await db.updateMessageAudit(auditId, {
        status: 'sent',
        metaMessageId,
        response,
      });
      return { auditId, metaMessageId };
    } catch (error) {
      await db.updateMessageAudit(auditId, {
        status: 'failed',
        error: extractAxiosError(error),
      });
      throw error;
    }
  }

  async function sendMedia({ clientId, requestId, ip, to, mediaType, link, mediaId, caption, filename, clientReference }) {
    const recipient = await resolveRecipient(to);
    const payload = {
      messaging_product: 'whatsapp',
      to: recipient.to,
      type: mediaType,
      [mediaType]: {
        ...(link ? { link } : {}),
        ...(mediaId ? { id: mediaId } : {}),
        ...(caption ? { caption } : {}),
        ...(filename ? { filename } : {}),
      },
    };
    const auditId = await db.createMessageAudit({
      requestId,
      clientId,
      clientReference,
      toNumber: to,
      devRedirectedTo: recipient.devMode ? recipient.to : '',
      messageType: mediaType,
      status: 'pending',
      payload,
      sourceIp: ip,
    });
    try {
      const config = await getConfig();
      const response = await graphRequest({
        method: 'post',
        path: `/${config.phone_number_id}/messages`,
        data: payload,
      });
      const metaMessageId = response.messages?.[0]?.id || '';
      await db.updateMessageAudit(auditId, {
        status: 'sent',
        metaMessageId,
        response,
      });
      return { auditId, metaMessageId };
    } catch (error) {
      await db.updateMessageAudit(auditId, {
        status: 'failed',
        error: extractAxiosError(error),
      });
      throw error;
    }
  }

  async function listTemplates(filters = {}) {
    const config = await getConfig();
    if (!config.business_account_id) {
      throw new Error('Business Account ID is not configured.');
    }
    const response = await graphRequest({
      method: 'get',
      path: `/${config.business_account_id}/message_templates`,
      params: filters.limit ? { limit: filters.limit } : undefined,
    });

    let data = response.data || [];
    if (filters.name) {
      data = data.filter((item) => String(item.name || '').toLowerCase().includes(String(filters.name).toLowerCase()));
    }
    if (filters.status) {
      data = data.filter((item) => String(item.status || '').toLowerCase() === String(filters.status).toLowerCase());
    }
    if (filters.language) {
      data = data.filter((item) => String(item.language || '').toLowerCase() === String(filters.language).toLowerCase());
    }
    if (filters.category) {
      data = data.filter((item) => String(item.category || '').toLowerCase() === String(filters.category).toLowerCase());
    }
    return data;
  }

  async function verifyWebhook(mode, token) {
    if (mode !== 'subscribe') return false;
    const config = await getConfig();
    return Boolean(config.webhook_verify_token) && token === config.webhook_verify_token;
  }

  /**
   * Valida a assinatura X-Hub-Signature-256 que a Meta envia em todo POST
   * de webhook, calculada com o App Secret sobre o corpo bruto da requisição.
   * Sem isso, qualquer requisicao POST para /webhook/whatsapp e aceita e
   * processada (dispara auto-replies) sem confirmar que veio da Meta.
   *
   * Enquanto WHATSAPP_APP_SECRET nao estiver configurado, retorna true (nao
   * quebra producao que ainda nao configurou o secret) mas avisa no log.
   */
  async function verifyWebhookSignature(rawBody, signatureHeader) {
    const config = await getConfig();
    const secret = config.app_secret;
    if (!secret) {
      console.warn('[whatsapp] WHATSAPP_APP_SECRET nao configurado — assinatura do webhook NAO esta sendo validada');
      return true;
    }
    if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
      return false;
    }
    const provided = signatureHeader.slice('sha256='.length);
    let providedBuf;
    let expectedBuf;
    try {
      providedBuf = Buffer.from(provided, 'hex');
      expectedBuf = Buffer.from(
        crypto.createHmac('sha256', secret).update(rawBody || Buffer.alloc(0)).digest('hex'),
        'hex'
      );
    } catch {
      return false;
    }
    if (providedBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(providedBuf, expectedBuf);
  }

  async function handleWebhook({ requestId, sourceIp, payload }) {
    const entry = payload.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value || {};
    const message = value.messages?.[0];
    const fromNumber = message?.from || '';
    const eventType = message?.type || change?.field || 'unknown';
    const messageId = message?.id || '';
    const result = {
      matched_rule_id: null,
      action: null,
    };

    // Deduplicação: ignora webhook duplicado (retry da Meta após crash)
    if (messageId && await db.webhookMessageProcessed(messageId)) {
      result.action = 'duplicate_skipped';
      return { webhookEventId: null, result };
    }

    // Botão interativo clicado pelo usuário
    if (message?.type === 'interactive') {
      const buttonId = message.interactive?.button_reply?.id || '';
      const chatbotHandled = await chatbot.handle(fromNumber, buttonId, { sendText, sendInteractive });
      if (chatbotHandled) {
        result.action = 'chatbot';
      }
    }

    if (message?.type === 'text') {
      // Chatbot tem prioridade sobre auto-replies
      const chatbotHandled = await chatbot.handle(fromNumber, message.text?.body || '', { sendText, sendInteractive });
      if (chatbotHandled) {
        result.action = 'chatbot';
      }

      if (!chatbotHandled) {
      const autoReply = await findAutoReply(message.text?.body || '');
      if (autoReply) {
        result.matched_rule_id = autoReply.id;
        if (autoReply.reply_type === 'text' && autoReply.reply_text) {
          result.action = 'send_text';
          await sendText({
            clientId: null,
            requestId,
            ip: sourceIp,
            to: fromNumber,
            text: autoReply.reply_text,
            clientReference: `webhook:auto-reply:${autoReply.id}`,
          });
        } else if (autoReply.reply_type === 'template' && autoReply.template_name && autoReply.template_language) {
          result.action = 'send_template';
          await sendTemplate({
            clientId: null,
            requestId,
            ip: sourceIp,
            to: fromNumber,
            templateName: autoReply.template_name,
            languageCode: autoReply.template_language,
            components: autoReply.template_components || [],
            clientReference: `webhook:auto-reply:${autoReply.id}`,
          });
        }
      }
      } // end !chatbotHandled
    }

    const webhookEventId = await db.insertWebhookEvent({
      requestId,
      eventType,
      fromNumber,
      messageId,
      payload,
      result,
      sourceIp,
    });

    return { webhookEventId, result };
  }

  async function findAutoReply(text) {
    const rules = await db.listAutoReplies();
    const normalized = String(text || '').trim().toLowerCase();
    return rules.find((rule) => {
      if (rule.status !== 'active') return false;
      const keyword = String(rule.keyword || '').trim().toLowerCase();
      if (!keyword) return false;
      if (rule.match_type === 'exact') return normalized === keyword;
      return normalized.includes(keyword);
    }) || null;
  }

  async function uploadMedia({ buffer, mimeType }) {
    const config = await getConfig();
    if (!config.access_token || !config.phone_number_id || !config.api_version) {
      throw new Error('WhatsApp configuration is incomplete.');
    }
    const FormData = require('form-data');
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('file', buffer, { contentType: mimeType, filename: 'image.png' });
    try {
      const response = await axios({
        method: 'post',
        url: `https://graph.facebook.com/${config.api_version}/${config.phone_number_id}/media`,
        headers: {
          Authorization: `Bearer ${config.access_token}`,
          ...form.getHeaders(),
        },
        data: form,
        timeout: 30000,
      });
      return response.data.id;
    } catch (error) {
      throw createGraphApiError(error);
    }
  }

  return {
    getConfig,
    handleWebhook,
    listTemplates,
    sendInteractive,
    sendMedia,
    sendTemplate,
    sendText,
    uploadMedia,
    verifyWebhook,
    verifyWebhookSignature,
  };
}

function extractAxiosError(error) {
  if (error.response) {
    return {
      status: error.response.status,
      data: sanitizePayload(error.response.data),
    };
  }
  return {
    message: error.message,
  };
}

function createGraphApiError(error) {
  const extracted = extractAxiosError(error);
  const apiMessage = extracted.data?.error?.message || extracted.message || error.message || 'Graph API request failed.';
  const wrapped = new Error(apiMessage);
  wrapped.httpStatus = extracted.status || error.statusCode || 502;
  wrapped.code = extracted.status && extracted.status < 500 ? 'GRAPH_API_BAD_REQUEST' : 'GRAPH_API_ERROR';
  wrapped.details = extracted.data?.error || extracted.data || null;
  return wrapped;
}

module.exports = {
  createWhatsAppService,
};
