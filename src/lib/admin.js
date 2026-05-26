const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');

const { verifyPassword } = require('./utils');
const chatbotEvents = require('./chatbot-events');

function readTemplate(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'admin', 'templates', name), 'utf8');
}

function renderLogin(loginHtml, message = '') {
  return loginHtml
    .replace('{{ERROR}}', message)
    .replace('{{ERROR_CLASS}}', message ? 'show' : '');
}

function registerAdminRoutes(app, deps) {
  const { db, security, whatsapp, getPublicSettings, saveSettings, maskSettings } = deps;
  const loginHtml = readTemplate('login.html');
  const dashboardHtml = readTemplate('dashboard.html');
  const asyncHandler = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

  app.use('/admin/static', express.static(path.join(__dirname, '..', 'admin', 'static')));

  async function requireAdmin(req, res, next) {
    await db.purgeExpiredSessions();
    const rawToken = req.cookies.admin_session || '';
    if (!rawToken) {
      return res.redirect('/admin/login');
    }
    const session = await db.getAdminSession(rawToken);
    if (!session || session.user_status !== 'active' || session.expires_at < new Date().toISOString()) {
      res.clearCookie('admin_session');
      return res.redirect('/admin/login');
    }
    req.adminUser = {
      id: session.user_id,
      username: session.username,
    };
    next();
  }

  app.get('/admin', (req, res) => res.redirect('/admin/dashboard'));
  app.get('/admin/login', (req, res) => res.type('html').send(renderLogin(loginHtml)));

  app.post('/admin/login', asyncHandler(async (req, res) => {
    const { username, password } = req.body || {};
    const user = await db.findAdminUserByUsername(String(username || '').trim());
    if (!user || user.status !== 'active' || !verifyPassword(password, user.password_hash)) {
      return res.status(401).type('html').send(renderLogin(loginHtml, 'Credenciais inválidas.'));
    }
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const sessionHours = (await getPublicSettings(db)).admin.session_hours;
    const expiresAt = new Date(Date.now() + sessionHours * 3600000).toISOString();
    await db.createAdminSession(user.id, sessionToken, expiresAt);
    await db.markAdminLogin(user.id);
    res.cookie('admin_session', sessionToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      expires: new Date(expiresAt),
    });
    res.redirect('/admin/dashboard');
  }));

  app.post('/admin/logout', requireAdmin, asyncHandler(async (req, res) => {
    await db.deleteAdminSession(req.cookies.admin_session);
    res.clearCookie('admin_session');
    res.redirect('/admin/login');
  }));

  app.get('/admin/dashboard', requireAdmin, (req, res) => {
    res.type('html').send(dashboardHtml);
  });

  app.get('/admin/api/bootstrap', requireAdmin, asyncHandler(async (req, res) => {
    const settings = await getPublicSettings(db);
    res.json({
      admin: req.adminUser,
      settings: maskSettings(settings),
      clients: await db.listApiClients(),
      blocked_ips: await db.listBlockedIps(),
      ip_reputation: await db.listIpReputations(50),
      messages: await db.listMessageAudit(50),
      webhooks: await db.listWebhookEvents(50),
      auto_replies: await db.listAutoReplies(),
      actions: await db.listAdminActions(50),
    });
  }));

  app.get('/admin/api/settings', requireAdmin, asyncHandler(async (req, res) => {
    const settings = await getPublicSettings(db);
    res.json({ data: maskSettings(settings) });
  }));

  app.post('/admin/api/settings', requireAdmin, asyncHandler(async (req, res) => {
    const next = await saveSettings(db, req.body || {}, req.adminUser.username);
    await db.createAdminAction({
      adminUserId: req.adminUser.id,
      action: 'update_settings',
      targetType: 'settings',
      targetId: 'global',
      details: req.body,
    });
    res.json({ data: maskSettings(next) });
  }));

  app.get('/admin/api/clients', requireAdmin, asyncHandler(async (req, res) => {
    res.json({ data: await db.listApiClients() });
  }));

  app.post('/admin/api/clients', requireAdmin, asyncHandler(async (req, res) => {
    const token = crypto.randomBytes(24).toString('hex');
    const id = await db.createApiClient({
      name: req.body?.name,
      description: req.body?.description,
      notes: req.body?.notes,
      rateLimitPerMinute: req.body?.rate_limit_per_minute,
      token,
    });
    await db.createAdminAction({
      adminUserId: req.adminUser.id,
      action: 'create_client',
      targetType: 'api_client',
      targetId: String(id),
      details: req.body,
    });
    res.status(201).json({
      data: await db.getApiClientById(id),
      plain_token: token,
    });
  }));

  app.post('/admin/api/clients/:id', requireAdmin, asyncHandler(async (req, res) => {
    const updated = await db.updateApiClient(req.params.id, {
      name: req.body?.name,
      status: req.body?.status,
      description: req.body?.description,
      notes: req.body?.notes,
      rateLimitPerMinute: req.body?.rate_limit_per_minute,
    });
    await db.createAdminAction({
      adminUserId: req.adminUser.id,
      action: 'update_client',
      targetType: 'api_client',
      targetId: String(req.params.id),
      details: req.body,
    });
    res.json({ data: updated });
  }));

  app.post('/admin/api/clients/:id/regenerate-token', requireAdmin, asyncHandler(async (req, res) => {
    const token = crypto.randomBytes(24).toString('hex');
    await db.regenerateApiClientToken(req.params.id, token);
    await db.createAdminAction({
      adminUserId: req.adminUser.id,
      action: 'regenerate_client_token',
      targetType: 'api_client',
      targetId: String(req.params.id),
      details: {},
    });
    res.json({ plain_token: token });
  }));

  app.delete('/admin/api/clients/:id', requireAdmin, asyncHandler(async (req, res) => {
    await db.deleteApiClient(req.params.id);
    await db.createAdminAction({
      adminUserId: req.adminUser.id,
      action: 'delete_client',
      targetType: 'api_client',
      targetId: String(req.params.id),
      details: {},
    });
    res.json({ ok: true });
  }));

  app.post('/admin/api/clients/:id/allow-ip', requireAdmin, asyncHandler(async (req, res) => {
    await security.allowIpForClient({
      clientId: Number(req.params.id),
      ip: req.body?.ip_or_cidr,
      notes: req.body?.notes,
    });
    await db.createAdminAction({
      adminUserId: req.adminUser.id,
      action: 'allow_ip_for_client',
      targetType: 'api_client',
      targetId: String(req.params.id),
      details: req.body,
    });
    res.json({ ok: true });
  }));

  app.delete('/admin/api/client-ip/:id', requireAdmin, asyncHandler(async (req, res) => {
    await db.removeClientAllowedIp(req.params.id);
    await db.createAdminAction({
      adminUserId: req.adminUser.id,
      action: 'remove_client_ip',
      targetType: 'client_ip',
      targetId: String(req.params.id),
      details: {},
    });
    res.json({ ok: true });
  }));

  app.get('/admin/api/security/ips', requireAdmin, asyncHandler(async (req, res) => {
    res.json({
      blocked_ips: await db.listBlockedIps(),
      ip_reputation: await db.listIpReputations(100),
    });
  }));

  app.post('/admin/api/security/ip/recheck', requireAdmin, asyncHandler(async (req, res) => {
    const data = await security.recheckIp(req.body?.ip);
    await db.createAdminAction({
      adminUserId: req.adminUser.id,
      action: 'recheck_ip',
      targetType: 'ip',
      targetId: req.body?.ip,
      details: req.body,
    });
    res.json({ data });
  }));

  app.post('/admin/api/security/ip/block', requireAdmin, asyncHandler(async (req, res) => {
    await security.blockIp({
      ip: req.body?.ip,
      reason: req.body?.reason,
      source: 'admin',
    });
    await db.createAdminAction({
      adminUserId: req.adminUser.id,
      action: 'block_ip',
      targetType: 'ip',
      targetId: req.body?.ip,
      details: req.body,
    });
    res.json({ ok: true });
  }));

  app.post('/admin/api/security/ip/unblock', requireAdmin, asyncHandler(async (req, res) => {
    await db.unblockIp(req.body?.ip);
    await db.createAdminAction({
      adminUserId: req.adminUser.id,
      action: 'unblock_ip',
      targetType: 'ip',
      targetId: req.body?.ip,
      details: req.body,
    });
    res.json({ ok: true });
  }));

  app.get('/admin/api/messages', requireAdmin, asyncHandler(async (req, res) => {
    res.json({ data: await db.listMessageAudit(100) });
  }));

  app.get('/admin/api/webhooks', requireAdmin, asyncHandler(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const [data, total] = await Promise.all([
      db.listWebhookEvents(limit, offset),
      db.countWebhookEvents(),
    ]);
    res.json({ data, total, limit, offset });
  }));

  app.get('/admin/api/audit/conversations', requireAdmin, asyncHandler(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const [data, total] = await Promise.all([
      db.listConversationSummaries(limit, offset),
      db.countConversations(),
    ]);
    res.json({ data, total, limit, offset });
  }));

  app.get('/admin/api/audit/conversation/:phone', requireAdmin, asyncHandler(async (req, res) => {
    const thread = await db.getConversationThread(decodeURIComponent(req.params.phone));
    res.json(thread);
  }));

  app.get('/admin/api/chatbot/flow', requireAdmin, asyncHandler(async (req, res) => {
    const settings = await getPublicSettings(db);
    res.json({ data: settings.chatbot.flow || {} });
  }));

  app.post('/admin/api/chatbot/flow', requireAdmin, asyncHandler(async (req, res) => {
    const flow = req.body?.flow;
    if (!flow || typeof flow !== 'object') {
      throw Object.assign(new Error('flow inválido'), { status: 400 });
    }
    const nodeCount = (flow.nodes || []).length;
    const snapshot = JSON.stringify(flow);
    await saveSettings(db, { chatbot: { flow: snapshot } }, req.adminUser.username);
    await db.saveFlowVersion({
      label: `${nodeCount} nó${nodeCount !== 1 ? 's' : ''}`,
      nodeCount,
      snapshot,
      createdBy: req.adminUser.username,
    });
    await db.createAdminAction({
      adminUserId: req.adminUser.id,
      action: 'save_chatbot_flow',
      targetType: 'settings',
      targetId: 'chatbot.flow',
      details: { node_count: nodeCount },
    });
    res.json({ ok: true });
  }));

  app.get('/admin/api/chatbot/flow/versions', requireAdmin, asyncHandler(async (req, res) => {
    const versions = await db.listFlowVersions();
    res.json({ data: versions });
  }));

  app.post('/admin/api/chatbot/flow/versions/:id/restore', requireAdmin, asyncHandler(async (req, res) => {
    const version = await db.getFlowVersion(Number(req.params.id));
    if (!version) throw Object.assign(new Error('Versão não encontrada'), { status: 404 });
    let flow;
    try { flow = JSON.parse(version.snapshot); } catch { throw Object.assign(new Error('Snapshot corrompido'), { status: 500 }); }
    await saveSettings(db, { chatbot: { flow: version.snapshot } }, req.adminUser.username);
    await db.saveFlowVersion({
      label: `Restaurado: ${version.label} (${version.created_at.slice(0, 16)})`,
      nodeCount: (flow.nodes || []).length,
      snapshot: version.snapshot,
      createdBy: req.adminUser.username,
    });
    await db.createAdminAction({
      adminUserId: req.adminUser.id,
      action: 'restore_chatbot_flow',
      targetType: 'settings',
      targetId: 'chatbot.flow',
      details: { restored_version_id: version.id, label: version.label },
    });
    res.json({ ok: true, flow });
  }));

  app.delete('/admin/api/chatbot/session/:phone', requireAdmin, asyncHandler(async (req, res) => {
    const phone = req.params.phone;
    await db.deleteChatbotSession(phone);
    await db.createAdminAction({
      adminUserId: req.adminUser.id,
      action: 'clear_chatbot_session',
      targetType: 'chatbot_session',
      targetId: phone,
      details: {},
    });
    res.json({ ok: true });
  }));

  // Proxy para simulador de fluxo — resolve templates server-side (token real) e chama API externa
  app.post('/admin/api/chatbot/proxy', requireAdmin, asyncHandler(async (req, res) => {
    const { method = 'GET', url, headers = {}, body, templateVars = {} } = req.body || {};
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ ok: false, error: 'URL obrigatória' });
    }

    // Resolve {{vars}} usando settings reais do banco + vars fornecidas pelo simulador
    const settings = await getPublicSettings(db);
    const cfg = settings.chatbot;
    const vars = {
      porteiro_url:    cfg.porteiro_url    || '',
      porteiro_token:  cfg.porteiro_token  || '',
      relay_device_id: String(cfg.relay_device_id || ''),
      relay_door_num:  String(cfg.relay_door_num  || '1'),
      relay_delay:     String(cfg.relay_delay     || '5'),
      unknown_message: cfg.unknown_message || '',
      ...templateVars,
    };
    const resolve = (text) =>
      String(text || '').replace(/\{\{(\w[\w.]*)\}\}/g, (_, k) => vars[k] ?? '');

    const resolvedUrl     = resolve(url);
    const resolvedHeaders = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, resolve(String(v))]));
    const resolvedBody    = body && typeof body === 'object'
      ? Object.fromEntries(Object.entries(body).map(([k, v]) => [k, resolve(String(v))]))
      : null;

    if (!resolvedUrl.startsWith('http')) {
      return res.status(400).json({ ok: false, error: `URL inválida após resolução: "${resolvedUrl}"` });
    }

    const m = method.toUpperCase();
    try {
      const r = await axios({
        method: m,
        url: resolvedUrl,
        headers: resolvedHeaders,
        ...(m === 'GET' ? { params: resolvedBody } : { data: resolvedBody }),
        timeout: 12000,
        validateStatus: () => true,
      });
      res.json({ ok: r.status < 400, status: r.status, data: r.data });
    } catch (e) {
      res.json({ ok: false, status: null, data: null, error: e.message });
    }
  }));

  // SSE — streaming live de eventos do chatbot
  app.get('/admin/api/chatbot/live', requireAdmin, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (res.socket) res.socket.setNoDelay(true);
    res.flushHeaders();

    const send = (event) => {
      try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch {}
    };

    send({ type: 'connected', ts: Date.now() });

    const heartbeat = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch {}
    }, 20000);

    chatbotEvents.on('flow', send);

    req.on('close', () => {
      chatbotEvents.off('flow', send);
      clearInterval(heartbeat);
    });
  });

  app.get('/admin/api/templates', requireAdmin, asyncHandler(async (req, res) => {
    const data = await whatsapp.listTemplates({
      name: req.query.name,
      status: req.query.status,
      category: req.query.category,
      language: req.query.language,
      limit: req.query.limit,
    });
    res.json({ data });
  }));

  app.get('/admin/api/auto-replies', requireAdmin, asyncHandler(async (req, res) => {
    res.json({ data: await db.listAutoReplies() });
  }));

  app.post('/admin/api/auto-replies', requireAdmin, asyncHandler(async (req, res) => {
    const id = await db.upsertAutoReply({
      id: req.body?.id,
      name: req.body?.name,
      matchType: req.body?.match_type || 'contains',
      keyword: req.body?.keyword,
      replyType: req.body?.reply_type || 'text',
      replyText: req.body?.reply_text || '',
      templateName: req.body?.template_name || '',
      templateLanguage: req.body?.template_language || '',
      templateComponents: req.body?.template_components || [],
      status: req.body?.status || 'active',
    });
    await db.createAdminAction({
      adminUserId: req.adminUser.id,
      action: 'save_auto_reply',
      targetType: 'auto_reply',
      targetId: String(id),
      details: req.body,
    });
    res.json({ data: await db.listAutoReplies() });
  }));

  app.post('/admin/api/send/test/text', requireAdmin, asyncHandler(async (req, res) => {
    const result = await whatsapp.sendText({
      clientId: null,
      requestId: req.ctx.requestId,
      ip: req.ctx.clientIp,
      to: req.body?.to,
      text: req.body?.text,
      clientReference: 'admin:test:text',
    });
    await db.createAdminAction({
      adminUserId: req.adminUser.id,
      action: 'test_send_text',
      targetType: 'message',
      targetId: String(result.auditId),
      details: req.body,
    });
    res.json({ data: result });
  }));

  app.post('/admin/api/send/test/template', requireAdmin, asyncHandler(async (req, res) => {
    const result = await whatsapp.sendTemplate({
      clientId: null,
      requestId: req.ctx.requestId,
      ip: req.ctx.clientIp,
      to: req.body?.to,
      templateName: req.body?.template_name,
      languageCode: req.body?.language_code,
      components: Array.isArray(req.body?.components) ? req.body.components : [],
      clientReference: 'admin:test:template',
    });
    await db.createAdminAction({
      adminUserId: req.adminUser.id,
      action: 'test_send_template',
      targetType: 'message',
      targetId: String(result.auditId),
      details: req.body,
    });
    res.json({ data: result });
  }));

  // ── Gerenciamento de usuários admin ───────────────────────────────────────

  app.get('/admin/api/users', requireAdmin, asyncHandler(async (req, res) => {
    res.json({ data: await db.listAdminUsers() });
  }));

  app.post('/admin/api/users', requireAdmin, asyncHandler(async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) throw Object.assign(new Error('username e password obrigatórios'), { status: 400 });
    if (password.length < 8) throw Object.assign(new Error('Senha deve ter ao menos 8 caracteres'), { status: 400 });
    const user = await db.createAdminUser(username, password);
    await db.createAdminAction({ adminUserId: req.adminUser.id, action: 'create_admin_user', targetType: 'admin_user', targetId: String(user.id), details: { username } });
    res.json({ data: { id: user.id, username: user.username } });
  }));

  app.post('/admin/api/users/:id/password', requireAdmin, asyncHandler(async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    const { new_password } = req.body || {};
    if (!new_password || new_password.length < 8) throw Object.assign(new Error('Senha deve ter ao menos 8 caracteres'), { status: 400 });
    const target = await db.findAdminUserById(userId);
    if (!target) throw Object.assign(new Error('Usuário não encontrado'), { status: 404 });
    await db.updateAdminPassword(userId, new_password);
    await db.createAdminAction({ adminUserId: req.adminUser.id, action: 'change_user_password', targetType: 'admin_user', targetId: String(userId), details: { username: target.username } });
    res.json({ data: { ok: true } });
  }));

  app.post('/admin/api/profile/password', requireAdmin, asyncHandler(async (req, res) => {
    const { current_password, new_password } = req.body || {};
    if (!current_password || !new_password) throw Object.assign(new Error('Preencha todos os campos'), { status: 400 });
    if (new_password.length < 8) throw Object.assign(new Error('Nova senha deve ter ao menos 8 caracteres'), { status: 400 });
    const user = await db.findAdminUserById(req.adminUser.id);
    if (!verifyPassword(current_password, user.password_hash)) throw Object.assign(new Error('Senha atual incorreta'), { status: 400 });
    await db.updateAdminPassword(req.adminUser.id, new_password);
    await db.createAdminAction({ adminUserId: req.adminUser.id, action: 'change_own_password', targetType: 'admin_user', targetId: String(req.adminUser.id), details: {} });
    res.json({ data: { ok: true } });
  }));

  app.post('/admin/api/users/:id/status', requireAdmin, asyncHandler(async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    if (userId === req.adminUser.id) throw Object.assign(new Error('Não é possível alterar o status da sua própria conta'), { status: 400 });
    const target = await db.findAdminUserById(userId);
    if (!target) throw Object.assign(new Error('Usuário não encontrado'), { status: 404 });
    const newStatus = target.status === 'active' ? 'inactive' : 'active';
    await db.setAdminUserStatus(userId, newStatus);
    await db.createAdminAction({ adminUserId: req.adminUser.id, action: 'set_user_status', targetType: 'admin_user', targetId: String(userId), details: { username: target.username, status: newStatus } });
    res.json({ data: { status: newStatus } });
  }));

  app.delete('/admin/api/users/:id', requireAdmin, asyncHandler(async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    if (userId === req.adminUser.id) throw Object.assign(new Error('Não é possível excluir sua própria conta'), { status: 400 });
    const target = await db.findAdminUserById(userId);
    if (!target) throw Object.assign(new Error('Usuário não encontrado'), { status: 404 });
    await db.deleteAdminUser(userId);
    await db.createAdminAction({ adminUserId: req.adminUser.id, action: 'delete_admin_user', targetType: 'admin_user', targetId: String(userId), details: { username: target.username } });
    res.json({ data: { ok: true } });
  }));
}

module.exports = {
  registerAdminRoutes,
};
