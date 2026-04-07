const state = {
  bootstrap: null,
  selectedConversationKey: null,
  activeScreen: 'overview',
  toastTimer: null,
  loadedTemplates: [],
};

async function api(url, options) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error?.message || data.message || `HTTP ${response.status}`);
  }
  return data;
}

const byId = (id) => document.getElementById(id);
const getValue = (id) => byId(id)?.value.trim() || '';

function setValue(id, value) {
  const el = byId(id);
  if (el) el.value = value ?? '';
}

function setSecret(id, maskedValue) {
  const el = byId(id);
  if (!el) return;
  el.value = '';
  el.placeholder = maskedValue || 'not configured';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('pt-BR');
}

function showMessage(text, type = 'success', title) {
  const toast = byId('app-toast');
  if (!toast) return;
  byId('app-toast-title').textContent = title || (type === 'error' ? 'Action failed' : 'Action completed');
  byId('app-toast-text').textContent = text;
  toast.className = `app-toast show ${type === 'error' ? 'app-toast-error' : 'app-toast-success'}`;
  if (state.toastTimer) clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove('show'), 4200);
}

function chip(label, variant) {
  return `<span class="status-chip ${variant}"><span class="dot"></span>${escapeHtml(label)}</span>`;
}

function applyChip(id, active, truthyLabel, falsyLabel) {
  const el = byId(id);
  if (!el) return;
  el.className = `status-chip ${active ? 'status-ok' : 'status-warn'}`;
  el.innerHTML = `<span class="dot"></span>${escapeHtml(active ? truthyLabel : falsyLabel)}`;
}

function renderTableBody(id, rowsHtml, colspan) {
  const tbody = document.querySelector(`#${id} tbody`);
  if (!tbody) return;
  tbody.innerHTML = rowsHtml || `<tr><td colspan="${colspan}" class="text-center text-muted py-4">No data.</td></tr>`;
}

function switchScreen(screen) {
  state.activeScreen = screen;
  document.querySelectorAll('[data-screen]').forEach((panel) => {
    panel.classList.toggle('active', panel.getAttribute('data-screen') === screen);
  });
  document.querySelectorAll('.nxl-navbar .nxl-item').forEach((item) => item.classList.remove('active'));
  document.querySelectorAll('[data-screen-nav]').forEach((link) => {
    const active = link.getAttribute('data-screen-nav') === screen;
    link.closest('.nxl-item')?.classList.toggle('active', active);
  });
  byId('breadcrumb-current').textContent = (screen || 'overview').replace(/-/g, ' ');
}

function setSendTestMode(mode) {
  const textMode = mode !== 'template';
  const textPanel = byId('test-text-panel');
  const templatePanel = byId('test-template-panel');
  const textButton = byId('send-test-text');
  const templateButton = byId('send-test-template');
  if (textPanel) textPanel.style.display = textMode ? '' : 'none';
  if (templatePanel) templatePanel.style.display = textMode ? 'none' : '';
  if (textButton) textButton.style.display = textMode ? '' : 'none';
  if (templateButton) templateButton.style.display = textMode ? 'none' : '';
  setValue('test_mode', textMode ? 'text' : 'template');
}

function fillSettings(settings) {
  setSecret('w_access_token', settings.whatsapp.access_token);
  setValue('w_phone_number_id', settings.whatsapp.phone_number_id);
  setValue('w_business_account_id', settings.whatsapp.business_account_id);
  setSecret('w_webhook_verify_token', settings.whatsapp.webhook_verify_token);
  setValue('w_api_version', settings.whatsapp.api_version);
  setValue('w_webhook_domain', settings.whatsapp.webhook_domain);
  setSecret('abuse_key', settings.abuseipdb.api_key);
  setValue('global_allowlist', (settings.security.global_allowlist || []).join('\n'));
  setValue('yellow_threshold', settings.security.yellow_threshold);
  setValue('block_threshold', settings.security.block_threshold);
  setValue('ttl_minutes', settings.security.reputation_ttl_minutes);
  setValue('global_rate_limit', settings.security.global_rate_limit_per_minute);
}

function renderOverview(data) {
  const clients = data.clients || [];
  const globalAllowlist = data.settings.security.global_allowlist || [];
  const clientAllowlistCount = clients.reduce((sum, client) => sum + ((client.allowed_ips || []).length), 0);

  byId('metric-clients').textContent = String(clients.length);
  byId('metric-blocked').textContent = String((data.blocked_ips || []).length);
  byId('metric-messages').textContent = String((data.messages || []).length);
  byId('metric-webhooks').textContent = String((data.webhooks || []).length);
  byId('overview-phone-id').textContent = data.settings.whatsapp.phone_number_id || '-';
  byId('overview-webhook-domain').textContent = data.settings.whatsapp.webhook_domain || '-';
  byId('overview-allowlist-count').textContent = String(globalAllowlist.length + clientAllowlistCount);

  applyChip('status-whatsapp-chip', Boolean(data.settings.whatsapp.phone_number_id && data.settings.whatsapp.api_version), 'WhatsApp ready', 'WhatsApp incomplete');
  applyChip('status-abuse-chip', Boolean(data.settings.abuseipdb.api_key), 'AbuseIPDB active', 'AbuseIPDB missing key');
  applyChip('status-business-chip', Boolean(data.settings.whatsapp.business_account_id), 'Business ID set', 'Business ID missing');
}

function renderClientSelect(clients) {
  const select = byId('allow_client_id');
  if (!select) return;
  const options = clients.map((client) => `<option value="${client.id}">${escapeHtml(client.name)}</option>`).join('');
  select.innerHTML = options || '<option value="">No clients</option>';
}

function renderClients(clients) {
  renderClientSelect(clients);
  const rows = clients.map((client) => `
    <tr>
      <td>
        <div class="fw-semibold">${escapeHtml(client.name)}</div>
        <div class="text-muted small">${escapeHtml(client.description || '')}</div>
      </td>
      <td>${client.status === 'active' ? chip('active', 'status-ok') : chip(client.status || 'inactive', 'status-warn')}</td>
      <td>${escapeHtml(String(client.rate_limit_per_minute || '-'))}/min</td>
      <td>${escapeHtml(formatDate(client.last_used_at))}</td>
      <td class="text-wrap">${(client.allowed_ips || []).length ? (client.allowed_ips || []).map((item) => `<div class="small mono">${escapeHtml(item.ip_or_cidr)}</div>`).join('') : '<span class="text-muted small">No allowlist</span>'}</td>
    </tr>
  `).join('');
  renderTableBody('clients-table', rows, 5);
}

function renderSecurity(data) {
  const blockedRows = (data.blocked_ips || []).map((item) => `
    <tr>
      <td class="mono">${escapeHtml(item.ip)}</td>
      <td>${escapeHtml(item.reason || '-')}</td>
      <td>${escapeHtml(item.source || '-')}</td>
      <td>${escapeHtml(formatDate(item.updated_at))}</td>
    </tr>
  `).join('');
  renderTableBody('blocked-table', blockedRows, 4);

  const reputationRows = (data.ip_reputation || []).map((item) => `
    <tr>
      <td class="mono">${escapeHtml(item.ip)}</td>
      <td>${item.category === 'blacklist' ? chip('blacklist', 'status-warn') : item.category === 'yellowlist' ? chip('yellowlist', 'status-warn') : chip(item.category || 'whitelist', 'status-ok')}</td>
      <td>${escapeHtml(String(item.abuse_score ?? '-'))}</td>
      <td>${escapeHtml(formatDate(item.expires_at))}</td>
    </tr>
  `).join('');
  renderTableBody('reputation-table', reputationRows, 4);
}

function populateTemplateTestSelect() {
  const select = byId('test_template_name');
  if (!select) return;
  const options = state.loadedTemplates.map((item) => `<option value="${escapeHtml(item.name)}">${escapeHtml(item.name)}${item.language ? ` (${escapeHtml(item.language)})` : ''}</option>`).join('');
  select.innerHTML = options || '<option value="">Load templates first</option>';
}

function getSelectedTemplate() {
  const selectedName = getValue('test_template_name');
  return state.loadedTemplates.find((item) => item.name === selectedName) || null;
}

function extractTemplateVariables(text) {
  const matches = String(text || '').match(/{{\d+}}/g) || [];
  return Array.from(new Set(matches.map((item) => Number(item.replace(/[{}]/g, ''))))).sort((a, b) => a - b);
}

function buildTemplateComponentsFromInputs(template) {
  if (!template) return [];
  const components = [];
  const bodyComponent = (template.components || []).find((item) => String(item.type || '').toUpperCase() === 'BODY');
  const bodyVariables = extractTemplateVariables(bodyComponent?.text);
  if (bodyVariables.length) {
    components.push({
      type: 'body',
      parameters: bodyVariables.map((index) => ({
        type: 'text',
        text: getValue(`builder-body-${index}`),
      })),
    });
  }

  const buttonsComponent = (template.components || []).find((item) => String(item.type || '').toUpperCase() === 'BUTTONS');
  (buttonsComponent?.buttons || []).forEach((button, index) => {
    const kind = String(button.type || '').toUpperCase();
    if (kind === 'URL') {
      const value = getValue(`builder-button-${index}`);
      if (value) {
        components.push({
          type: 'button',
          sub_type: 'url',
          index: String(index),
          parameters: [{ type: 'text', text: value }],
        });
      }
    }
  });

  return components.filter((item) => (item.parameters || []).length > 0);
}

function syncTemplateComponentsJson() {
  const template = getSelectedTemplate();
  if (!template) return;
  const generated = buildTemplateComponentsFromInputs(template);
  setValue('test_template_components', generated.length ? JSON.stringify(generated, null, 2) : '[]');
}

function renderTemplateBuilder(template) {
  const container = byId('test-template-builder');
  if (!container) return;
  if (!template) {
    container.innerHTML = '<div class="col-12 text-muted small">Load templates and select one to generate helper fields.</div>';
    setValue('test_template_components', '');
    return;
  }

  const fields = [];
  const bodyComponent = (template.components || []).find((item) => String(item.type || '').toUpperCase() === 'BODY');
  const bodyVariables = extractTemplateVariables(bodyComponent?.text);
  bodyVariables.forEach((index) => {
    fields.push(`
      <div class="col-lg-6">
        <label class="form-label">Body variable ${index}</label>
        <input id="builder-body-${index}" class="form-control template-builder-input" data-builder-kind="body" data-builder-index="${index}" placeholder="Value for {{${index}}}">
      </div>
    `);
  });

  const buttonsComponent = (template.components || []).find((item) => String(item.type || '').toUpperCase() === 'BUTTONS');
  (buttonsComponent?.buttons || []).forEach((button, index) => {
    const kind = String(button.type || '').toUpperCase();
    if (kind === 'URL') {
      fields.push(`
        <div class="col-lg-6">
          <label class="form-label">Button URL variable ${index + 1}</label>
          <input id="builder-button-${index}" class="form-control template-builder-input" data-builder-kind="button" data-builder-index="${index}" placeholder="URL suffix or variable">
        </div>
      `);
    }
  });

  if (!fields.length) {
    container.innerHTML = '<div class="col-12 text-muted small">This template does not expose simple positional text variables. You can still edit the JSON manually below.</div>';
    setValue('test_template_components', '[]');
    return;
  }

  container.innerHTML = fields.join('');
  container.querySelectorAll('.template-builder-input').forEach((input) => {
    input.addEventListener('input', syncTemplateComponentsJson);
  });
  syncTemplateComponentsJson();
}

function syncSelectedTemplateMeta() {
  const selected = getSelectedTemplate();
  if (!selected) return;
  setValue('test_template_language', selected.language || '');
  renderTemplateBuilder(selected);
}

function renderTemplates(templates) {
  state.loadedTemplates = templates || [];
  populateTemplateTestSelect();
  syncSelectedTemplateMeta();
  const rows = (templates || []).map((item) => `
    <tr>
      <td>
        <div class="fw-semibold">${escapeHtml(item.name)}</div>
        <div class="small text-muted">${escapeHtml(item.category || '-')}</div>
      </td>
      <td>${escapeHtml(item.status || '-')}</td>
      <td>${escapeHtml(item.language || '-')}</td>
    </tr>
  `).join('');
  renderTableBody('templates-table', rows, 3);
}

function renderAutoReplies(autoReplies) {
  const container = byId('auto-replies-list');
  if (!container) return;
  if (!autoReplies.length) {
    container.innerHTML = '<div class="mini-item text-muted">No rules configured.</div>';
    return;
  }
  container.innerHTML = autoReplies.map((item) => `
    <div class="mini-item">
      <strong>${escapeHtml(item.name)}</strong>
      <div class="small text-muted mb-1">Match: ${escapeHtml(item.match_type)} | Status: ${escapeHtml(item.status)}</div>
      <div class="small">Keyword: <span class="mono">${escapeHtml(item.keyword)}</span></div>
      <div class="small mt-1">${escapeHtml(item.reply_text || item.template_name || '-')}</div>
    </div>
  `).join('');
}

function normalizeConversationKey(value) {
  return String(value || '').trim() || 'unknown';
}

function formatConversationName(key) {
  return !key || key === 'unknown' ? 'Unknown' : key;
}

function conversationInitials(key) {
  const name = formatConversationName(key).replace(/[^a-zA-Z0-9]/g, '');
  return (name.slice(0, 2) || 'WA').toUpperCase();
}

function describeOutboundMessage(item) {
  if (item.message_type === 'text') return item.payload?.text?.body || 'Text message';
  if (item.message_type === 'template') return `Template: ${item.payload?.template?.name || 'template'}`;
  return item.message_type ? `${item.message_type} message` : 'Outbound message';
}

function describeWebhookMessage(item) {
  const message = item.payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (message?.type === 'text') return message.text?.body || 'Inbound text';
  if (message?.type === 'button') return `Button: ${message.button?.text || message.button?.payload || ''}`.trim();
  if (message?.type === 'interactive') return 'Interactive reply';
  if (message?.type === 'image') return 'Inbound image';
  if (message?.type === 'document') return 'Inbound document';
  if (message?.type === 'audio') return 'Inbound audio';
  if (message?.type === 'video') return 'Inbound video';
  if (item.event_type === 'statuses') return 'Delivery status update';
  return item.event_type || 'Webhook event';
}

function buildConversations(data) {
  const map = new Map();
  const ensureConversation = (key) => {
    const normalizedKey = normalizeConversationKey(key);
    if (!map.has(normalizedKey)) {
      map.set(normalizedKey, {
        key: normalizedKey,
        title: formatConversationName(normalizedKey),
        isGroup: normalizedKey.includes('@g.us'),
        items: [],
        lastAt: '',
        outboundCount: 0,
        inboundCount: 0,
      });
    }
    return map.get(normalizedKey);
  };

  for (const item of data.messages || []) {
    const conversation = ensureConversation(item.to_number);
    conversation.items.push({
      id: `out-${item.id}`,
      direction: 'outbound',
      timestamp: item.created_at,
      status: item.status || 'pending',
      text: describeOutboundMessage(item),
      sublabel: item.message_type || 'message',
    });
    conversation.outboundCount += 1;
    if (!conversation.lastAt || conversation.lastAt < item.created_at) conversation.lastAt = item.created_at;
  }

  for (const item of data.webhooks || []) {
    const conversation = ensureConversation(item.from_number || item.source_ip || 'unknown');
    conversation.items.push({
      id: `in-${item.id}`,
      direction: 'inbound',
      timestamp: item.created_at,
      status: item.event_type || 'received',
      text: describeWebhookMessage(item),
      sublabel: item.event_type || 'webhook',
    });
    conversation.inboundCount += 1;
    if (!conversation.lastAt || conversation.lastAt < item.created_at) conversation.lastAt = item.created_at;
  }

  return Array.from(map.values())
    .map((conversation) => {
      conversation.items.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
      conversation.preview = conversation.items[conversation.items.length - 1]?.text || 'No messages';
      return conversation;
    })
    .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
}

function renderConversationList(conversations) {
  const container = byId('conversation-list');
  if (!container) return;
  if (!conversations.length) {
    container.innerHTML = '<div class="conversation-empty">No WhatsApp logs available yet.</div>';
    return;
  }
  if (!state.selectedConversationKey || !conversations.some((item) => item.key === state.selectedConversationKey)) {
    state.selectedConversationKey = conversations[0].key;
  }
  container.innerHTML = conversations.map((conversation) => `
    <div class="conversation-item ${conversation.key === state.selectedConversationKey ? 'active' : ''}" data-conversation-key="${escapeHtml(conversation.key)}">
      <div class="conversation-avatar">${escapeHtml(conversationInitials(conversation.key))}</div>
      <div class="flex-grow-1 min-w-0">
        <div class="conversation-item-title">
          <span class="text-truncate">${escapeHtml(conversation.title)}</span>
          <span class="small text-muted">${escapeHtml(formatDate(conversation.lastAt))}</span>
        </div>
        <div class="conversation-item-preview text-truncate">${escapeHtml(conversation.preview)}</div>
      </div>
    </div>
  `).join('');
  container.querySelectorAll('[data-conversation-key]').forEach((item) => {
    item.addEventListener('click', () => {
      state.selectedConversationKey = item.getAttribute('data-conversation-key');
      renderConversationList(conversations);
      renderConversationThread(conversations);
    });
  });
}

function renderConversationThread(conversations) {
  const thread = byId('conversation-thread');
  const title = byId('conversation-title');
  const subtitle = byId('conversation-subtitle');
  const meta = byId('conversation-meta');
  if (!thread || !title || !subtitle || !meta) return;
  const conversation = conversations.find((item) => item.key === state.selectedConversationKey);
  if (!conversation) {
    title.textContent = 'No conversation selected';
    subtitle.textContent = 'Pick a number on the left to inspect the WhatsApp history.';
    meta.textContent = '';
    thread.innerHTML = '<div class="conversation-empty">No conversation available yet.</div>';
    return;
  }
  title.textContent = conversation.title;
  subtitle.textContent = conversation.isGroup ? 'Grouped timeline for a WhatsApp group.' : 'Grouped timeline for a WhatsApp contact.';
  meta.innerHTML = `<div>${escapeHtml(String(conversation.items.length))} events</div><div>${escapeHtml(String(conversation.inboundCount))} inbound / ${escapeHtml(String(conversation.outboundCount))} outbound</div>`;
  thread.innerHTML = conversation.items.map((item) => `
    <div class="bubble-row ${item.direction}">
      <div class="bubble ${item.direction}">
        <div class="bubble-text">${escapeHtml(item.text)}</div>
        <div class="bubble-meta">
          <span>${escapeHtml(item.sublabel)}</span>
          <span>${escapeHtml(formatDate(item.timestamp))} | ${escapeHtml(item.status)}</span>
        </div>
      </div>
    </div>
  `).join('');
}

function renderAudit(data) {
  const conversations = buildConversations(data);
  renderConversationList(conversations);
  renderConversationThread(conversations);
  const actionRows = (data.actions || []).map((item) => `
    <tr>
      <td>${escapeHtml(item.action)}</td>
      <td>${escapeHtml(item.target_type)}:${escapeHtml(item.target_id || '-')}</td>
      <td>${escapeHtml(formatDate(item.created_at))}</td>
    </tr>
  `).join('');
  renderTableBody('actions-table', actionRows, 3);
}

function fillDashboard(data) {
  state.bootstrap = data;
  fillSettings(data.settings);
  renderOverview(data);
  renderClients(data.clients || []);
  renderSecurity(data);
  renderTemplates(state.loadedTemplates);
  renderAutoReplies(data.auto_replies || []);
  renderAudit(data);
}

async function loadBootstrap(showToast = false) {
  const data = await api('/admin/api/bootstrap');
  fillDashboard(data);
  if (showToast) showMessage('Dashboard refreshed.');
}

function buildSettingsPayload() {
  return {
    whatsapp: {
      access_token: getValue('w_access_token'),
      phone_number_id: getValue('w_phone_number_id'),
      business_account_id: getValue('w_business_account_id'),
      webhook_verify_token: getValue('w_webhook_verify_token'),
      api_version: getValue('w_api_version'),
      webhook_domain: getValue('w_webhook_domain'),
    },
    abuseipdb: { api_key: getValue('abuse_key') },
    security: {
      global_allowlist: getValue('global_allowlist').split('\n').map((item) => item.trim()).filter(Boolean),
      yellow_threshold: Number(getValue('yellow_threshold') || 25),
      block_threshold: Number(getValue('block_threshold') || 75),
      reputation_ttl_minutes: Number(getValue('ttl_minutes') || 1440),
      global_rate_limit_per_minute: Number(getValue('global_rate_limit') || 120),
    },
  };
}

async function onSaveSettings() {
  await api('/admin/api/settings', { method: 'POST', body: JSON.stringify(buildSettingsPayload()) });
  await loadBootstrap();
  showMessage('Settings saved.');
}

async function onCreateClient() {
  const data = await api('/admin/api/clients', {
    method: 'POST',
    body: JSON.stringify({
      name: getValue('client_name'),
      description: getValue('client_description'),
      rate_limit_per_minute: Number(getValue('client_rate_limit') || 60),
    }),
  });
  await loadBootstrap();
  showMessage(`Client created. Generated token: ${data.plain_token}`);
  switchScreen('clients');
}

async function onAllowClientIp() {
  const clientId = getValue('allow_client_id');
  if (!clientId) throw new Error('Select a client.');
  await api(`/admin/api/clients/${clientId}/allow-ip`, {
    method: 'POST',
    body: JSON.stringify({
      ip_or_cidr: getValue('allow_ip_or_cidr'),
      notes: getValue('allow_ip_notes'),
    }),
  });
  setValue('allow_ip_or_cidr', '');
  setValue('allow_ip_notes', '');
  await loadBootstrap();
  showMessage('Allowed IP added to client.');
}

async function onRecheckIp() {
  await api('/admin/api/security/ip/recheck', { method: 'POST', body: JSON.stringify({ ip: getValue('security_ip') }) });
  await loadBootstrap();
  showMessage('IP rechecked.');
  switchScreen('security');
}

async function onBlockIp() {
  await api('/admin/api/security/ip/block', {
    method: 'POST',
    body: JSON.stringify({ ip: getValue('security_ip'), reason: 'Manual block from admin dashboard.' }),
  });
  await loadBootstrap();
  showMessage('IP blocked.');
  switchScreen('security');
}

async function onUnblockIp() {
  await api('/admin/api/security/ip/unblock', { method: 'POST', body: JSON.stringify({ ip: getValue('security_ip') }) });
  await loadBootstrap();
  showMessage('IP unblocked.');
  switchScreen('security');
}

async function onLoadTemplates() {
  const query = new URLSearchParams();
  const filters = {
    name: getValue('template_name_filter'),
    status: getValue('template_status_filter'),
    language: getValue('template_language_filter'),
    category: getValue('template_category_filter'),
  };
  Object.entries(filters).forEach(([key, value]) => {
    if (value) query.set(key, value);
  });
  const suffix = query.toString() ? `?${query.toString()}` : '';
  const data = await api(`/admin/api/templates${suffix}`);
  renderTemplates(data.data || []);
  showMessage(`Templates loaded: ${(data.data || []).length}.`);
  switchScreen('templates');
}

async function onSendTestText() {
  const data = await api('/admin/api/send/test/text', {
    method: 'POST',
    body: JSON.stringify({
      to: getValue('test_to'),
      text: getValue('test_text'),
    }),
  });
  byId('send-output').textContent = JSON.stringify(data.data, null, 2);
  await loadBootstrap();
  showMessage('Text test completed.');
  switchScreen('send-test');
}

function parseTemplateComponents() {
  const raw = getValue('test_template_components');
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Components JSON is invalid.');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Components JSON must be an array.');
  }
  return parsed;
}

async function onSendTestTemplate() {
  const templateName = getValue('test_template_name');
  const languageCode = getValue('test_template_language');
  if (!templateName) throw new Error('Select a template first.');
  if (!languageCode) throw new Error('Template language is required.');
  const data = await api('/admin/api/send/test/template', {
    method: 'POST',
    body: JSON.stringify({
      to: getValue('test_to'),
      template_name: templateName,
      language_code: languageCode,
      components: parseTemplateComponents(),
    }),
  });
  byId('send-output').textContent = JSON.stringify(data.data, null, 2);
  await loadBootstrap();
  showMessage('Template test completed.');
  switchScreen('send-test');
}

async function onSaveAutoReply() {
  await api('/admin/api/auto-replies', {
    method: 'POST',
    body: JSON.stringify({
      name: getValue('reply_name'),
      keyword: getValue('reply_keyword'),
      match_type: getValue('reply_match_type'),
      reply_type: 'text',
      reply_text: getValue('reply_text'),
      status: 'active',
    }),
  });
  setValue('reply_name', '');
  setValue('reply_keyword', '');
  setValue('reply_text', '');
  await loadBootstrap();
  showMessage('Auto reply rule saved.');
  switchScreen('auto-replies');
}

function bindEvents() {
  byId('save-settings')?.addEventListener('click', () => runAction(onSaveSettings));
  byId('refresh-all')?.addEventListener('click', () => runAction(() => loadBootstrap(true)));
  byId('create-client')?.addEventListener('click', () => runAction(onCreateClient));
  byId('allow-client-ip')?.addEventListener('click', () => runAction(onAllowClientIp));
  byId('recheck-ip')?.addEventListener('click', () => runAction(onRecheckIp));
  byId('block-ip')?.addEventListener('click', () => runAction(onBlockIp));
  byId('unblock-ip')?.addEventListener('click', () => runAction(onUnblockIp));
  byId('load-templates')?.addEventListener('click', () => runAction(onLoadTemplates));
  byId('send-test-text')?.addEventListener('click', () => runAction(onSendTestText));
  byId('send-test-template')?.addEventListener('click', () => runAction(onSendTestTemplate));
  byId('save-auto-reply')?.addEventListener('click', () => runAction(onSaveAutoReply));
  byId('test_mode')?.addEventListener('change', () => setSendTestMode(getValue('test_mode')));
  byId('test_template_name')?.addEventListener('change', syncSelectedTemplateMeta);
  document.querySelectorAll('[data-screen-nav]').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      switchScreen(link.getAttribute('data-screen-nav'));
    });
  });
}

async function runAction(handler) {
  try {
    await handler();
  } catch (error) {
    showMessage(error.message, 'error');
  }
}

bindEvents();
setSendTestMode('text');
switchScreen('overview');
renderTemplateBuilder(null);
loadBootstrap().catch((error) => showMessage(error.message, 'error'));
