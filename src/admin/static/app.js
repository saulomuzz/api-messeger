const state = {
  bootstrap: null,
  selectedConversationKey: null,
  activeScreen: 'overview',
  toastTimer: null,
  loadedTemplates: [],
  auditFilter: 'all',
  expandedBubble: null,
  auditAutoRefreshTimer: null,
  auditLastRefresh: null,
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

function setCheckbox(id, value) {
  const el = byId(id);
  if (el) el.checked = Boolean(value);
}

function getCheckbox(id) {
  return Boolean(byId(id)?.checked);
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

function relativeTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffH = Math.floor(diffMin / 60);
  const diffD = Math.floor(diffH / 24);
  if (diffMin < 1) return 'agora';
  if (diffMin < 60) return `há ${diffMin} min`;
  if (diffH < 24) return `há ${diffH}h`;
  if (diffD === 1) return 'ontem';
  if (diffD < 7) return `há ${diffD} dias`;
  return date.toLocaleDateString('pt-BR');
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

function applyPhoneMask(digits) {
  const d = String(digits || '').replace(/\D/g, '').slice(0, 13);
  if (d.length > 9) return `${d.slice(0,2)} (${d.slice(2,4)}) ${d.slice(4,9)}-${d.slice(9)}`;
  if (d.length > 4) return `${d.slice(0,2)} (${d.slice(2,4)}) ${d.slice(4)}`;
  if (d.length > 2) return `${d.slice(0,2)} (${d.slice(2)}`;
  return d;
}

function fillSettings(settings) {
  // Dev / Test Mode
  setCheckbox('dev_mode_enabled', settings.dev?.mode_enabled);
  setValue('dev_test_phone', applyPhoneMask(settings.dev?.test_phone));
  const devChip = byId('status-dev-chip');
  if (devChip) devChip.style.display = settings.dev?.mode_enabled ? '' : 'none';

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

  // Chatbot
  if (settings.chatbot) {
    setCheckbox('chatbot_enabled', settings.chatbot.enabled);
    setValue('chatbot_porteiro_url', settings.chatbot.porteiro_url);
    setSecret('chatbot_porteiro_token', settings.chatbot.porteiro_token);
    setValue('chatbot_unknown_message', settings.chatbot.unknown_message);
    setValue('chatbot_session_ttl_min', settings.chatbot.session_ttl_min);
    setValue('chatbot_relay_device_id', settings.chatbot.relay_device_id);
    setValue('chatbot_relay_door_num', settings.chatbot.relay_door_num);
    setValue('chatbot_relay_delay', settings.chatbot.relay_delay);
    setValue('chatbot_support_phones', settings.chatbot.support_phones);
    setCheckbox('chatbot_support_forward_unknown', settings.chatbot.support_forward_unknown);
    setCheckbox('chatbot_debug_errors', settings.chatbot.debug_errors);
  }
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
      <td>
        <div class="d-flex gap-2">
          <button class="btn btn-sm btn-light-brand" onclick="regenerateToken(${client.id},'${escapeHtml(client.name)}')">Regenerar token</button>
          <button class="btn btn-sm btn-danger" onclick="deleteClient(${client.id},'${escapeHtml(client.name)}')">Excluir</button>
        </div>
      </td>
    </tr>
  `).join('');
  renderTableBody('clients-table', rows, 6);
}

async function regenerateToken(id, name) {
  if (!confirm(`Regenerar token do cliente "${name}"?\nO token atual será invalidado imediatamente.`)) return;
  const data = await api(`/admin/api/clients/${id}/regenerate-token`, { method: 'POST', body: JSON.stringify({}) });
  const box = byId('token-reveal-box');
  const clientEl = byId('token-reveal-client');
  const tokenEl = byId('token-reveal-value');
  if (box && tokenEl) {
    if (clientEl) clientEl.textContent = name;
    tokenEl.textContent = data.plain_token;
    box.style.display = 'block';
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  await loadBootstrap();
  switchScreen('clients');
}

async function deleteClient(id, name) {
  if (!confirm(`Excluir cliente "${name}"?\nTodos os IPs permitidos também serão removidos.`)) return;
  await api(`/admin/api/clients/${id}`, { method: 'DELETE' });
  const box = byId('token-reveal-box');
  if (box) box.style.display = 'none';
  await loadBootstrap();
  showMessage(`Cliente "${name}" excluído.`);
  switchScreen('clients');
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

// ── Audit helpers ─────────────────────────────────────────────────────────────

function normalizeConversationKey(value) {
  return String(value || '').trim() || 'unknown';
}

function formatConversationName(key) {
  if (!key || key === 'unknown') return 'Desconhecido';
  // Brazilian number: 55 + 2-digit area + 8-9 digit number
  const m = key.match(/^55(\d{2})9?(\d{8})$/);
  if (m) return `(${m[1]}) ${m[2].slice(0, 4)}-${m[2].slice(4)}`;
  return key;
}

function conversationInitials(key) {
  const digits = key.replace(/\D/g, '');
  if (digits.length >= 4) return digits.slice(-4, -2);
  const name = formatConversationName(key).replace(/[^a-zA-Z0-9]/g, '');
  return (name.slice(0, 2) || 'WA').toUpperCase();
}

const MSG_TYPE_ICON = {
  text: '💬',
  template: '📋',
  image: '🖼️',
  video: '🎥',
  audio: '🎵',
  document: '📄',
  sticker: '🪄',
};

function msgTypeIcon(type) {
  return MSG_TYPE_ICON[type] || '📨';
}

function statusChip(status) {
  if (status === 'sent') return '<span class="audit-chip chip-sent">✓ enviado</span>';
  if (status === 'failed') return '<span class="audit-chip chip-failed">✗ falha</span>';
  if (status === 'pending') return '<span class="audit-chip chip-pending">⏳ pendente</span>';
  return `<span class="audit-chip chip-muted">${escapeHtml(status)}</span>`;
}

function describeOutboundMessage(item) {
  if (item.message_type === 'text') return item.payload?.text?.body || 'Mensagem de texto';
  if (item.message_type === 'template') {
    const name = item.payload?.template?.name || 'template';
    const bodyParam = item.payload?.template?.components
      ?.find((c) => c.type === 'body')?.parameters?.[0]?.text;
    return bodyParam ? `${name} — ${bodyParam}` : name;
  }
  const mediaObj = item.payload?.[item.message_type];
  const caption = mediaObj?.caption;
  const filename = mediaObj?.filename;
  const label = caption || filename || '';
  return label ? `${item.message_type}: ${label}` : `${item.message_type}`;
}

function describeWebhookMessage(item) {
  const value = item.payload?.entry?.[0]?.changes?.[0]?.value || {};
  const message = value.messages?.[0];
  if (message?.type === 'text') return message.text?.body || 'Texto recebido';
  if (message?.type === 'button') return `↩️ ${message.button?.text || message.button?.payload || 'Botão'}`.trim();
  if (message?.type === 'interactive') {
    const reply = message.interactive?.button_reply || message.interactive?.list_reply;
    const txt = reply?.title || reply?.id || '';
    return txt ? `↩️ ${txt}` : '↩️ Resposta interativa';
  }
  if (message?.type === 'image') return '🖼️ Imagem recebida';
  if (message?.type === 'document') return '📄 Documento recebido';
  if (message?.type === 'audio') return '🎵 Áudio recebido';
  if (message?.type === 'video') return '🎥 Vídeo recebido';
  const statuses = value.statuses;
  if (statuses?.length) {
    const s = statuses[0];
    const st = s.status;
    const icon = st === 'delivered' ? '✓✓' : st === 'read' ? '👁️' : st === 'sent' ? '✓' : st === 'failed' ? '✗' : '';
    return `${icon} ${st}`.trim();
  }
  return item.event_type || 'Webhook';
}

function isStatusEvent(item) {
  const value = item.payload?.entry?.[0]?.changes?.[0]?.value || {};
  return Boolean(value.statuses?.length) && !value.messages?.length;
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
        failedCount: 0,
      });
    }
    return map.get(normalizedKey);
  };

  for (const item of data.messages || []) {
    const conversation = ensureConversation(item.to_number);
    const isDevRedirected = item.dev_redirected_to && item.dev_redirected_to !== item.to_number;
    conversation.items.push({
      id: `out-${item.id}`,
      rawId: item.id,
      direction: 'outbound',
      timestamp: item.created_at,
      status: item.status || 'pending',
      text: describeOutboundMessage(item),
      sublabel: item.message_type || 'message',
      devMode: isDevRedirected,
      devRedirectedTo: item.dev_redirected_to,
      clientRef: item.client_reference || '',
      metaId: item.meta_message_id || '',
      payload: item.payload,
      error: item.error,
    });
    conversation.outboundCount += 1;
    if (item.status === 'failed') conversation.failedCount += 1;
    if (!conversation.lastAt || conversation.lastAt < item.created_at) conversation.lastAt = item.created_at;
  }

  for (const item of data.webhooks || []) {
    if (isStatusEvent(item)) continue; // filter delivery status noise
    const conversation = ensureConversation(item.from_number || item.source_ip || 'unknown');
    conversation.items.push({
      id: `in-${item.id}`,
      rawId: item.id,
      direction: 'inbound',
      timestamp: item.created_at,
      status: item.event_type || 'received',
      text: describeWebhookMessage(item),
      sublabel: item.event_type || 'webhook',
      payload: item.payload,
    });
    conversation.inboundCount += 1;
    if (!conversation.lastAt || conversation.lastAt < item.created_at) conversation.lastAt = item.created_at;
  }

  return Array.from(map.values())
    .map((conversation) => {
      conversation.items.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
      const last = conversation.items[conversation.items.length - 1];
      conversation.preview = last?.text || 'Sem mensagens';
      conversation.previewStatus = last?.status;
      return conversation;
    })
    .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
}

function applyAuditFilter(conversations) {
  const f = state.auditFilter;
  if (f === 'all') return conversations;
  return conversations
    .map((conv) => {
      const items = conv.items.filter((it) => it.status === f);
      if (!items.length) return null;
      return { ...conv, items };
    })
    .filter(Boolean);
}

function renderConversationList(conversations) {
  const container = byId('conversation-list');
  if (!container) return;
  const filtered = applyAuditFilter(conversations);
  if (!filtered.length) {
    container.innerHTML = '<div class="conversation-empty">Nenhum log encontrado.</div>';
    return;
  }
  if (!state.selectedConversationKey || !filtered.some((item) => item.key === state.selectedConversationKey)) {
    state.selectedConversationKey = filtered[0].key;
  }
  container.innerHTML = filtered.map((conversation) => {
    const failBadge = conversation.failedCount
      ? `<span class="conv-fail-badge">${conversation.failedCount}</span>`
      : '';
    const previewStatusClass = conversation.previewStatus === 'failed' ? ' preview-failed' : '';
    return `
    <div class="conversation-item ${conversation.key === state.selectedConversationKey ? 'active' : ''}" data-conversation-key="${escapeHtml(conversation.key)}">
      <div class="conversation-avatar">${escapeHtml(conversationInitials(conversation.key))}</div>
      <div class="flex-grow-1 min-w-0">
        <div class="conversation-item-title">
          <span class="text-truncate">${escapeHtml(conversation.title)}</span>
          <span class="conv-time">${escapeHtml(relativeTime(conversation.lastAt))}</span>
        </div>
        <div class="conversation-item-preview text-truncate${previewStatusClass}">${escapeHtml(conversation.preview)}</div>
      </div>
      ${failBadge}
    </div>`;
  }).join('');
  container.querySelectorAll('[data-conversation-key]').forEach((item) => {
    item.addEventListener('click', () => {
      state.selectedConversationKey = item.getAttribute('data-conversation-key');
      state.expandedBubble = null;
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
  const filtered = applyAuditFilter(conversations);
  const conversation = filtered.find((item) => item.key === state.selectedConversationKey);
  if (!conversation) {
    title.textContent = 'Nenhuma conversa selecionada';
    subtitle.textContent = 'Selecione um número à esquerda para inspecionar o histórico.';
    meta.textContent = '';
    thread.innerHTML = '<div class="conversation-empty">Nenhuma conversa disponível.</div>';
    return;
  }
  title.textContent = conversation.title;
  subtitle.textContent = conversation.isGroup
    ? 'Timeline agrupada para um grupo WhatsApp.'
    : `${conversation.outboundCount} enviadas · ${conversation.inboundCount} recebidas${conversation.failedCount ? ` · <span style="color:#ef4444">${conversation.failedCount} falhas</span>` : ''}`;
  meta.innerHTML = `<div class="small text-muted">${conversation.items.length} eventos</div>`;

  thread.innerHTML = conversation.items.map((item) => {
    const isExpanded = state.expandedBubble === item.id;
    const isFailed = item.status === 'failed';
    const extraClasses = [
      item.devMode ? 'bubble-dev' : '',
      isFailed ? 'bubble-failed' : '',
    ].filter(Boolean).join(' ');

    const payloadHtml = isExpanded && item.payload
      ? `<div class="bubble-payload"><pre>${escapeHtml(JSON.stringify(item.payload, null, 2))}</pre></div>`
      : '';
    const errorHtml = isExpanded && item.error
      ? `<div class="bubble-error-detail">Erro: ${escapeHtml(JSON.stringify(item.error))}</div>`
      : '';

    const metaIdHtml = item.metaId
      ? `<span class="mono" title="${escapeHtml(item.metaId)}">${escapeHtml(item.metaId.slice(-12))}</span>`
      : '';
    const clientRefHtml = item.clientRef
      ? `<span class="bubble-ref" title="${escapeHtml(item.clientRef)}">${escapeHtml(item.clientRef.slice(0, 28))}</span>`
      : '';

    return `
    <div class="bubble-row ${item.direction}" data-bubble-id="${escapeHtml(item.id)}">
      <div class="bubble ${item.direction} ${extraClasses}">
        ${item.devMode ? `<div class="dev-badge">DEV → ${escapeHtml(item.devRedirectedTo || '')}</div>` : ''}
        <div class="bubble-text">${
          item.direction === 'inbound' && (item.sublabel === 'messages' || item.sublabel === 'webhook') && item.text.startsWith('↩️')
            ? `<span class="bubble-btn-reply">${escapeHtml(item.text)}</span>`
            : `${msgTypeIcon(item.sublabel)} ${escapeHtml(item.text)}`
        }</div>
        <div class="bubble-meta">
          <span>${statusChip(item.status)} ${escapeHtml(item.sublabel)}</span>
          <span title="${escapeHtml(formatDate(item.timestamp))}">${escapeHtml(relativeTime(item.timestamp))} ${metaIdHtml}</span>
        </div>
        ${clientRefHtml ? `<div class="bubble-ref-row">${clientRefHtml}</div>` : ''}
        ${payloadHtml}${errorHtml}
        <button class="bubble-expand-btn" data-bid="${escapeHtml(item.id)}">${isExpanded ? '▲ ocultar' : '▾ detalhes'}</button>
      </div>
    </div>`;
  }).join('');

  thread.querySelectorAll('.bubble-expand-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const bid = btn.getAttribute('data-bid');
      state.expandedBubble = state.expandedBubble === bid ? null : bid;
      renderConversationThread(conversations);
    });
  });
}

function renderAudit(data) {
  const conversations = buildConversations(data);

  // Filter bar
  const filterBar = byId('audit-filter-bar');
  if (filterBar && !filterBar.dataset.bound) {
    filterBar.dataset.bound = '1';
    filterBar.querySelectorAll('[data-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.auditFilter = btn.getAttribute('data-filter');
        state.expandedBubble = null;
        filterBar.querySelectorAll('[data-filter]').forEach((b) => b.classList.toggle('active', b === btn));
        renderConversationList(conversations);
        renderConversationThread(conversations);
      });
    });
  }

  // Refresh button
  const refreshBtn = byId('audit-refresh-btn');
  if (refreshBtn && !refreshBtn.dataset.bound) {
    refreshBtn.dataset.bound = '1';
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      refreshBtn.textContent = '↻ carregando…';
      await loadBootstrap(false);
      refreshBtn.disabled = false;
      refreshBtn.textContent = '↻ atualizar';
    });
  }

  // Auto-refresh toggle
  const autoRefreshBtn = byId('audit-auto-refresh-btn');
  const autoRefreshLabel = byId('audit-last-refresh');
  if (autoRefreshBtn && !autoRefreshBtn.dataset.bound) {
    autoRefreshBtn.dataset.bound = '1';

    function updateAutoRefreshLabel() {
      if (autoRefreshLabel && state.auditLastRefresh) {
        autoRefreshLabel.textContent = `Atualizado: ${state.auditLastRefresh.toLocaleTimeString('pt-BR')}`;
      }
    }

    function startAutoRefresh() {
      if (state.auditAutoRefreshTimer) return;
      state.auditAutoRefreshTimer = setInterval(async () => {
        await loadBootstrap(false);
        state.auditLastRefresh = new Date();
        updateAutoRefreshLabel();
      }, 30000);
      autoRefreshBtn.classList.add('active');
      autoRefreshBtn.title = 'Auto-atualização ativa (30s) — clique para desativar';
    }

    function stopAutoRefresh() {
      if (state.auditAutoRefreshTimer) {
        clearInterval(state.auditAutoRefreshTimer);
        state.auditAutoRefreshTimer = null;
      }
      autoRefreshBtn.classList.remove('active');
      if (autoRefreshLabel) autoRefreshLabel.textContent = '';
      autoRefreshBtn.title = 'Ativar auto-atualização a cada 30s';
    }

    autoRefreshBtn.addEventListener('click', () => {
      if (state.auditAutoRefreshTimer) stopAutoRefresh(); else startAutoRefresh();
    });
  }

  renderConversationList(conversations);
  renderConversationThread(conversations);

  const actionRows = (data.actions || []).map((item) => `
    <tr>
      <td>${escapeHtml(item.action)}</td>
      <td>${escapeHtml(item.target_type)}:${escapeHtml(item.target_id || '-')}</td>
      <td title="${escapeHtml(formatDate(item.created_at))}">${escapeHtml(relativeTime(item.created_at))}</td>
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
    dev: {
      mode_enabled: getCheckbox('dev_mode_enabled'),
      test_phone: getValue('dev_test_phone'),
    },
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
  const devEnabled = getCheckbox('dev_mode_enabled');
  const devPhone = getValue('dev_test_phone').replace(/\D/g, '');
  if (devEnabled) {
    if (!devPhone) {
      showMessage('Informe o número de teste antes de ativar o Dev Mode.', 'error', 'Campo obrigatório');
      byId('dev_test_phone')?.focus();
      return;
    }
    if (devPhone.length < 10 || devPhone.length > 15) {
      showMessage('Número de teste inválido. Use o formato com DDI (ex: 5542999999999).', 'error', 'Número inválido');
      byId('dev_test_phone')?.focus();
      return;
    }
  }
  // Garante que só dígitos são enviados
  if (byId('dev_test_phone')) byId('dev_test_phone').value = devPhone;
  await api('/admin/api/settings', { method: 'POST', body: JSON.stringify(buildSettingsPayload()) });
  await loadBootstrap();
  showMessage('Settings saved.');
}

async function onCreateClient() {
  const name = getValue('client_name');
  const data = await api('/admin/api/clients', {
    method: 'POST',
    body: JSON.stringify({
      name,
      description: getValue('client_description'),
      rate_limit_per_minute: Number(getValue('client_rate_limit') || 60),
    }),
  });
  await loadBootstrap();
  // Exibe token no box persistente
  const box = byId('token-reveal-box');
  const clientEl = byId('token-reveal-client');
  const tokenEl = byId('token-reveal-value');
  if (box && tokenEl) {
    if (clientEl) clientEl.textContent = name;
    tokenEl.textContent = data.plain_token;
    box.style.display = 'block';
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  // Limpa formulário
  setValue('client_name', '');
  setValue('client_description', '');
  setValue('client_rate_limit', '60');
  switchScreen('clients');
}

function copyToken() {
  const token = byId('token-reveal-value')?.textContent || '';
  if (!token) return;
  navigator.clipboard.writeText(token).then(() => {
    showMessage('Token copiado para a área de transferência!');
  }).catch(() => {
    prompt('Copie o token manualmente:', token);
  });
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

async function onSaveChatbot() {
  const payload = {
    chatbot: {
      enabled: getCheckbox('chatbot_enabled'),
      porteiro_url: getValue('chatbot_porteiro_url'),
      porteiro_token: getValue('chatbot_porteiro_token'),
      unknown_message: getValue('chatbot_unknown_message'),
      session_ttl_min: Number(getValue('chatbot_session_ttl_min') || 5),
      relay_device_id: getValue('chatbot_relay_device_id'),
      relay_door_num: Number(getValue('chatbot_relay_door_num') || 1),
      relay_delay: Number(getValue('chatbot_relay_delay') || 5),
      support_phones: getValue('chatbot_support_phones'),
      support_forward_unknown: getCheckbox('chatbot_support_forward_unknown'),
      debug_errors: getCheckbox('chatbot_debug_errors'),
    },
  };
  await api('/admin/api/settings', { method: 'POST', body: JSON.stringify(payload) });
  showMessage('Configurações do chatbot salvas!');
}

function bindEvents() {
  byId('save-settings')?.addEventListener('click', () => runAction(onSaveSettings));
  byId('save-chatbot')?.addEventListener('click', () => runAction(onSaveChatbot));
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
  byId('dev_test_phone')?.addEventListener('input', () => {
    const el = byId('dev_test_phone');
    const digits = el.value.replace(/\D/g, '').slice(0, 13);
    // Máscara: 55 (42) 99999-9999
    let masked = digits;
    if (digits.length > 9) {
      masked = `${digits.slice(0,2)} (${digits.slice(2,4)}) ${digits.slice(4,9)}-${digits.slice(9)}`;
    } else if (digits.length > 4) {
      masked = `${digits.slice(0,2)} (${digits.slice(2,4)}) ${digits.slice(4)}`;
    } else if (digits.length > 2) {
      masked = `${digits.slice(0,2)} (${digits.slice(2)}`;
    }
    el.value = masked;
  });
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
