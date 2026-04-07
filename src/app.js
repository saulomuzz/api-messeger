require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');

const { createDatabase } = require('./lib/db');
const { getPublicSettings, saveSettings, maskSettings } = require('./lib/settings');
const { createSecurityService } = require('./lib/security');
const { createWhatsAppService } = require('./lib/whatsapp');
const { registerAdminRoutes } = require('./lib/admin');
const {
  requestId,
  getClientIp,
  normalizeIp,
  safeJsonParse,
  sanitizePayload,
} = require('./lib/utils');

const PORT = Number(process.env.PORT || 3000);
const APP_ROOT = path.resolve(__dirname, '..');
const DB_PATH = process.env.SQLITE_PATH || path.join(APP_ROOT, 'data', 'app.sqlite');
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const LEGACY_API_TOKEN = process.env.API_TOKEN || '';

function createJsonError(res, requestIdValue, status, code, message, details) {
  return res.status(status).json({
    request_id: requestIdValue,
    status: 'error',
    error: {
      code,
      message,
      details: details || null,
    },
  });
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

async function main() {
  const db = await createDatabase({ dbPath: DB_PATH });
  const security = createSecurityService({ db });
  const whatsapp = createWhatsAppService({ db });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use((req, res, next) => {
    req.ctx = {
      requestId: requestId(),
      startedAt: Date.now(),
      clientIp: normalizeIp(getClientIp(req)),
      area: req.path.startsWith('/admin') ? 'admin' : req.path.startsWith('/webhook') ? 'webhook' : 'public',
      clientId: null,
      authStatus: 'anonymous',
      securityDecision: 'n/a',
    };

    res.setHeader('X-Request-Id', req.ctx.requestId);
    res.on('finish', async () => {
      try {
        await db.insertAccessLog({
          requestId: req.ctx.requestId,
          area: req.ctx.area,
          method: req.method,
          path: req.originalUrl,
          clientIp: req.ctx.clientIp,
          clientId: req.ctx.clientId,
          authStatus: req.ctx.authStatus,
          securityDecision: req.ctx.securityDecision,
          statusCode: res.statusCode,
          latencyMs: Date.now() - req.ctx.startedAt,
          userAgent: req.get('user-agent') || '',
          requestBody: req.ctx.area === 'webhook' ? null : sanitizePayload(req.body),
          responseBody: safeJsonParse(res.locals.auditResponseBody),
        });
      } catch (error) {
        console.error('access log error', error.message);
      }
    });
    next();
  });

  app.use(helmet({ crossOriginResourcePolicy: false }));
  app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN, credentials: true }));
  app.use(compression());
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());

  app.get('/v1/health', asyncRoute(async (req, res) => {
    const settings = await getPublicSettings(db);
    const runtime = await security.getRuntimeSettings();
    const body = {
      request_id: req.ctx.requestId,
      status: 'ok',
      ready: true,
      uptime_seconds: Math.round(process.uptime()),
      now: new Date().toISOString(),
      whatsapp: {
        configured: Boolean(settings.whatsapp.phone_number_id && settings.whatsapp.api_version),
        business_account_id_configured: Boolean(settings.whatsapp.business_account_id),
      },
      security: {
        abuseipdb_enabled: Boolean(settings.abuseipdb.api_key),
        yellow_threshold: runtime.yellowThreshold,
        block_threshold: runtime.blockThreshold,
      },
    };
    res.locals.auditResponseBody = JSON.stringify(body);
    res.json(body);
  }));

  function legacyError(res, requestIdValue, status, message, extra = {}) {
    return res.status(status).json({
      ok: false,
      request_id: requestIdValue,
      error: message,
      ...extra,
    });
  }

  function requireLegacyToken(req, res, next) {
    const token = req.get('x-api-token') || '';
    req.ctx.authStatus = token ? 'legacy_token' : 'legacy_missing_token';
    if (!LEGACY_API_TOKEN || token !== LEGACY_API_TOKEN) {
      req.ctx.securityDecision = 'deny_legacy_invalid_token';
      return legacyError(res, req.ctx.requestId, 401, 'invalid_api_token');
    }
    req.ctx.securityDecision = 'allow_legacy_token';
    next();
  }

  async function authenticateApiRequest(req, res, next) {
    const header = req.get('authorization') || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      req.ctx.authStatus = 'missing_bearer';
      req.ctx.securityDecision = 'deny_missing_token';
      return createJsonError(res, req.ctx.requestId, 401, 'AUTH_REQUIRED', 'Bearer token is required.');
    }

    const token = match[1].trim();
    const auth = await security.authenticateClient({ token, ip: req.ctx.clientIp, path: req.path });
    req.ctx.clientId = auth.client ? auth.client.id : null;
    req.ctx.authStatus = auth.authStatus;
    req.ctx.securityDecision = auth.securityDecision;

    if (!auth.ok) {
      return createJsonError(
        res,
        req.ctx.requestId,
        auth.httpStatus,
        auth.errorCode,
        auth.message,
        auth.details
      );
    }

    req.apiClient = auth.client;
    req.ipDecision = auth.ipDecision;
    next();
  }

  app.post('/v1/messages/text', authenticateApiRequest, asyncRoute(async (req, res) => {
    const { to, text, client_reference: clientReference } = req.body || {};
    if (!to || !text) {
      return createJsonError(res, req.ctx.requestId, 400, 'VALIDATION_ERROR', '`to` and `text` are required.');
    }

    const result = await whatsapp.sendText({
      clientId: req.apiClient.id,
      requestId: req.ctx.requestId,
      ip: req.ctx.clientIp,
      to,
      text,
      clientReference,
    });

    const body = {
      request_id: req.ctx.requestId,
      client_id: req.apiClient.id,
      status: 'accepted',
      message_id: result.auditId,
      meta_message_id: result.metaMessageId,
    };
    res.locals.auditResponseBody = JSON.stringify(body);
    res.status(202).json(body);
  }));

  app.post('/send', requireLegacyToken, asyncRoute(async (req, res) => {
    const { phone, message } = req.body || {};
    if (!phone || !message) {
      return legacyError(res, req.ctx.requestId, 400, 'phone and message are required');
    }

    try {
      const result = await whatsapp.sendText({
        clientId: null,
        requestId: req.ctx.requestId,
        ip: req.ctx.clientIp,
        to: String(phone),
        text: String(message),
        clientReference: 'legacy:/send',
      });
      const body = {
        ok: true,
        request_id: req.ctx.requestId,
        id: result.auditId,
        messageId: result.metaMessageId,
      };
      res.locals.auditResponseBody = JSON.stringify(body);
      return res.json(body);
    } catch (error) {
      return legacyError(res, req.ctx.requestId, 502, error.message || 'send_failed');
    }
  }));

  app.post('/v1/messages/template', authenticateApiRequest, asyncRoute(async (req, res) => {
    const { to, template_name: templateName, language_code: languageCode, components, client_reference: clientReference } = req.body || {};
    if (!to || !templateName || !languageCode) {
      return createJsonError(
        res,
        req.ctx.requestId,
        400,
        'VALIDATION_ERROR',
        '`to`, `template_name` and `language_code` are required.'
      );
    }

    const result = await whatsapp.sendTemplate({
      clientId: req.apiClient.id,
      requestId: req.ctx.requestId,
      ip: req.ctx.clientIp,
      to,
      templateName,
      languageCode,
      components: Array.isArray(components) ? components : [],
      clientReference,
    });

    const body = {
      request_id: req.ctx.requestId,
      client_id: req.apiClient.id,
      status: 'accepted',
      message_id: result.auditId,
      meta_message_id: result.metaMessageId,
    };
    res.locals.auditResponseBody = JSON.stringify(body);
    res.status(202).json(body);
  }));

  app.post('/send/template', requireLegacyToken, asyncRoute(async (req, res) => {
    const { phone, template, language, components } = req.body || {};
    if (!phone || !template) {
      return legacyError(res, req.ctx.requestId, 400, 'phone and template are required');
    }

    try {
      const result = await whatsapp.sendTemplate({
        clientId: null,
        requestId: req.ctx.requestId,
        ip: req.ctx.clientIp,
        to: String(phone),
        templateName: String(template),
        languageCode: String(language || 'pt_BR'),
        components: Array.isArray(components) ? components : [],
        clientReference: 'legacy:/send/template',
      });
      const body = {
        ok: true,
        request_id: req.ctx.requestId,
        id: result.auditId,
        messageId: result.metaMessageId,
      };
      res.locals.auditResponseBody = JSON.stringify(body);
      return res.json(body);
    } catch (error) {
      return legacyError(res, req.ctx.requestId, 502, error.message || 'send_template_failed');
    }
  }));

  app.post('/send-template', requireLegacyToken, asyncRoute(async (req, res) => {
    req.url = '/send/template';
    req.path = '/send/template';
    const { phone, template, language, components } = req.body || {};
    if (!phone || !template) {
      return legacyError(res, req.ctx.requestId, 400, 'phone and template are required');
    }

    try {
      const result = await whatsapp.sendTemplate({
        clientId: null,
        requestId: req.ctx.requestId,
        ip: req.ctx.clientIp,
        to: String(phone),
        templateName: String(template),
        languageCode: String(language || 'pt_BR'),
        components: Array.isArray(components) ? components : [],
        clientReference: 'legacy:/send-template',
      });
      const body = {
        ok: true,
        request_id: req.ctx.requestId,
        id: result.auditId,
        messageId: result.metaMessageId,
      };
      res.locals.auditResponseBody = JSON.stringify(body);
      return res.json(body);
    } catch (error) {
      return legacyError(res, req.ctx.requestId, 502, error.message || 'send_template_failed');
    }
  }));

  app.post('/v1/messages/media', authenticateApiRequest, asyncRoute(async (req, res) => {
    const { to, media_type: mediaType, link, media_id: mediaId, caption, filename, client_reference: clientReference } = req.body || {};
    if (!to || !mediaType || (!link && !mediaId)) {
      return createJsonError(
        res,
        req.ctx.requestId,
        400,
        'VALIDATION_ERROR',
        '`to`, `media_type` and one of `link` or `media_id` are required.'
      );
    }

    const result = await whatsapp.sendMedia({
      clientId: req.apiClient.id,
      requestId: req.ctx.requestId,
      ip: req.ctx.clientIp,
      to,
      mediaType,
      link,
      mediaId,
      caption,
      filename,
      clientReference,
    });

    const body = {
      request_id: req.ctx.requestId,
      client_id: req.apiClient.id,
      status: 'accepted',
      message_id: result.auditId,
      meta_message_id: result.metaMessageId,
    };
    res.locals.auditResponseBody = JSON.stringify(body);
    res.status(202).json(body);
  }));

  app.get('/v1/messages/:id', authenticateApiRequest, asyncRoute(async (req, res) => {
    const message = await db.getMessageAuditById(req.params.id, req.apiClient.id);
    if (!message) {
      return createJsonError(res, req.ctx.requestId, 404, 'NOT_FOUND', 'Message audit record not found.');
    }

    const body = {
      request_id: req.ctx.requestId,
      status: 'ok',
      data: message,
    };
    res.locals.auditResponseBody = JSON.stringify(body);
    res.json(body);
  }));

  app.get('/v1/security/ip/:ip', authenticateApiRequest, asyncRoute(async (req, res) => {
    const data = await security.lookupIp(req.params.ip);
    const body = {
      request_id: req.ctx.requestId,
      status: 'ok',
      data,
    };
    res.locals.auditResponseBody = JSON.stringify(body);
    res.json(body);
  }));

  app.post('/v1/security/ip/recheck', authenticateApiRequest, asyncRoute(async (req, res) => {
    const { ip } = req.body || {};
    if (!ip) {
      return createJsonError(res, req.ctx.requestId, 400, 'VALIDATION_ERROR', '`ip` is required.');
    }

    const data = await security.recheckIp(ip);
    const body = {
      request_id: req.ctx.requestId,
      status: 'ok',
      data,
    };
    res.locals.auditResponseBody = JSON.stringify(body);
    res.json(body);
  }));

  app.post('/v1/security/ip/allow', authenticateApiRequest, asyncRoute(async (req, res) => {
    const { ip, notes } = req.body || {};
    if (!ip) {
      return createJsonError(res, req.ctx.requestId, 400, 'VALIDATION_ERROR', '`ip` is required.');
    }

    await security.allowIpForClient({ clientId: req.apiClient.id, ip, notes: notes || 'Allowed by API client endpoint.' });
    const body = {
      request_id: req.ctx.requestId,
      status: 'ok',
    };
    res.locals.auditResponseBody = JSON.stringify(body);
    res.json(body);
  }));

  app.post('/v1/security/ip/block', authenticateApiRequest, asyncRoute(async (req, res) => {
    const { ip, reason } = req.body || {};
    if (!ip) {
      return createJsonError(res, req.ctx.requestId, 400, 'VALIDATION_ERROR', '`ip` is required.');
    }

    await security.blockIp({ ip, reason: reason || 'Blocked by API client endpoint.', source: 'api' });
    const body = {
      request_id: req.ctx.requestId,
      status: 'ok',
    };
    res.locals.auditResponseBody = JSON.stringify(body);
    res.json(body);
  }));

  app.get('/webhook/whatsapp', asyncRoute(async (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    const isValid = await whatsapp.verifyWebhook(mode, token);
    if (!isValid) {
      req.ctx.securityDecision = 'deny_invalid_verify_token';
      return res.status(403).send('Forbidden');
    }

    req.ctx.securityDecision = 'allow_verify_token';
    res.send(challenge || '');
  }));

  app.post('/webhook/whatsapp', asyncRoute(async (req, res) => {
    req.ctx.securityDecision = 'allow_webhook';
    const result = await whatsapp.handleWebhook({
      requestId: req.ctx.requestId,
      sourceIp: req.ctx.clientIp,
      payload: req.body || {},
    });
    res.locals.auditResponseBody = JSON.stringify({ processed: true, webhook_event_id: result.webhookEventId });
    res.status(200).json({ success: true });
  }));

  registerAdminRoutes(app, { db, security, whatsapp, getPublicSettings, saveSettings, maskSettings });

  app.use((error, req, res, next) => {
    console.error('unhandled error', error);
    const currentRequestId = req && req.ctx ? req.ctx.requestId : requestId();
    if (req && req.ctx) {
      req.ctx.securityDecision = req.ctx.securityDecision || 'error';
    }
    const httpStatus = Number(error.httpStatus || error.statusCode || error.status || 500);
    const body = {
      request_id: currentRequestId,
      status: 'error',
      error: {
        code: httpStatus >= 400 && httpStatus < 500 ? (error.code || 'BAD_REQUEST') : (error.code || 'INTERNAL_ERROR'),
        message: error.message || 'Unexpected error.',
        details: error.details || null,
      },
    };
    if (!res.headersSent) {
      res.locals.auditResponseBody = JSON.stringify(body);
      res.status(httpStatus >= 400 && httpStatus < 600 ? httpStatus : 500).json(body);
    } else {
      next(error);
    }
  });

  app.listen(PORT, () => {
    console.log(`api-messeger listening on ${PORT}`);
  });
}

main().catch((error) => {
  console.error('bootstrap error', error);
  process.exit(1);
});
