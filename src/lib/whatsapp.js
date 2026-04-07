const axios = require('axios');

const { getPublicSettings } = require('./settings');
const { sanitizePayload } = require('./utils');

function createWhatsAppService({ db }) {
  async function getConfig() {
    const settings = await getPublicSettings(db);
    return settings.whatsapp;
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
    const payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    };
    const auditId = await db.createMessageAudit({
      requestId,
      clientId,
      clientReference,
      toNumber: to,
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

  async function sendTemplate({ clientId, requestId, ip, to, templateName, languageCode, components, clientReference }) {
    const payload = {
      messaging_product: 'whatsapp',
      to,
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
    const payload = {
      messaging_product: 'whatsapp',
      to,
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

    if (message?.type === 'text') {
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

  return {
    getConfig,
    handleWebhook,
    listTemplates,
    sendMedia,
    sendTemplate,
    sendText,
    verifyWebhook,
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
