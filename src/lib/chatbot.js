'use strict';
/**
 * Chatbot WhatsApp com estado por número de telefone.
 * Identifica o remetente via api-porteiro e exibe menus diferentes
 * por tipo de pessoa (aluno / morador / desconhecido).
 * Usa botões interativos do WhatsApp; aceita texto ("1","2") como fallback.
 *
 * Estados:
 *   idle          → identifica e mostra menu
 *   wait_aluno    → aguarda escolha do aluno
 *   wait_morador  → aguarda escolha do morador
 *   transferred   → humano assumiu; chatbot silencia até TTL expirar
 */

const axios = require('axios');
const { getPublicSettings } = require('./settings');
const chatbotEvents = require('./chatbot-events');

function emit(type, phone, extra = {}) {
  chatbotEvents.emit('flow', { type, phone: phone ? `...${String(phone).slice(-4)}` : '?', phoneRaw: phone, ts: Date.now(), ...extra });
}

// Palavras-chave que disparam transferência para atendente humano
const HUMAN_KEYWORDS = [
  'humano', 'atendente', 'atendimento', 'suporte', 'help',
  'ajuda', 'socorro', 'falar com', 'quero falar', 'preciso de ajuda',
  'quero atendimento', 'atendente humano', 'pessoa real',
];

function isHumanRequest(input) {
  // IDs de botões interativos (ex: aluno_ajuda, morador_portao) nunca ativam transferência
  if (/^(aluno|morador|visitante|funcionario|prestador)_\w+$/.test(input)) return false;
  return HUMAN_KEYWORDS.some((k) => input === k || input.includes(k));
}

function isCancelRequest(input) {
  return input === 'sair' || input === 'cancelar' || input === '0'
      || input === 'voltar' || input === 'menu';
}

function parseSupportPhones(str) {
  if (!str) return [];
  return String(str)
    .split(/[\n,;]+/)
    .map((s) => s.trim().replace(/\D/g, ''))
    .filter((s) => s.length >= 10);
}

// ── Lock por telefone (evita execuções concorrentes para o mesmo número) ────
const _phoneLocks = new Map();
async function withPhoneLock(phone, fn) {
  const prev = _phoneLocks.get(phone);
  if (prev) await prev.catch(() => {});
  let resolve;
  const lock = new Promise((r) => { resolve = r; });
  _phoneLocks.set(phone, lock);
  try {
    return await fn();
  } finally {
    resolve();
    if (_phoneLocks.get(phone) === lock) _phoneLocks.delete(phone);
  }
}

function createChatbotService({ db }) {
  // ── Helpers ────────────────────────────────────────────────────────────────

  async function getCfg() {
    const s = await getPublicSettings(db);
    return s.chatbot;
  }

  async function getSession(phone) {
    const row = await db.getChatbotSession(phone);
    if (!row) return null;
    return {
      ...row,
      data: (() => { try { return JSON.parse(row.data_json || '{}'); } catch { return {}; } })(),
    };
  }

  async function saveSession(phone, state, personType, personName, data) {
    await db.upsertChatbotSession(phone, state, personType, personName, data);
  }

  async function clearSession(phone) {
    await db.deleteChatbotSession(phone);
  }

  function isExpired(session, ttlMin) {
    if (!session) return true;
    const age = (Date.now() - (session.updated_at || 0)) / 60000;
    return age > ttlMin;
  }

  // ── Chamadas ao api-porteiro ───────────────────────────────────────────────

  async function porteiro(cfg, method, path, params) {
    const base = (cfg.porteiro_url || '').replace(/\/$/, '');
    if (!base || !cfg.porteiro_token) return null;
    try {
      const r = await axios({
        method,
        url: `${base}/api/v1/chatbot${path}`,
        headers: { Authorization: `Bearer ${cfg.porteiro_token}` },
        params: method === 'GET' ? params : undefined,
        data:   method !== 'GET' ? params : undefined,
        timeout: 10000,
      });
      return r.data;
    } catch (e) {
      console.error('[chatbot] porteiro error', path, e?.response?.data || e.message);
      return null;
    }
  }

  // ── Envio de mensagens ─────────────────────────────────────────────────────

  async function reply(whatsapp, phone, text) {
    await whatsapp.sendText({
      clientId: null,
      requestId: `chatbot-${Date.now()}`,
      ip: '127.0.0.1',
      to: phone,
      text,
      clientReference: 'chatbot',
    });
  }

  async function replyButtons(whatsapp, phone, bodyText, buttons) {
    try {
      await whatsapp.sendInteractive({
        clientId: null,
        requestId: `chatbot-${Date.now()}`,
        ip: '127.0.0.1',
        to: phone,
        interactive: {
          type: 'button',
          body: { text: bodyText },
          action: {
            buttons: buttons.map((b) => ({
              type: 'reply',
              reply: { id: b.id, title: b.title.substring(0, 20) },
            })),
          },
        },
        clientReference: 'chatbot',
      });
    } catch (e) {
      console.error('[chatbot] interactive failed, falling back to text', e.message);
      await reply(whatsapp, phone, bodyText);
    }
  }

  // ── Encaminhamento para suporte humano ────────────────────────────────────

  async function forwardToSupport(whatsapp, cfg, fromPhone, messageText, personType, personName) {
    const phones = parseSupportPhones(cfg.support_phones || '');
    if (!phones.length) return;

    const TYPE_LABEL = {
      unknown:     '🔴 Número desconhecido',
      aluno:       '🎓 Aluno',
      morador:     '🏠 Morador',
      funcionario: '👔 Funcionário',
      visitante:   '👤 Visitante',
      prestador:   '🔧 Prestador',
    };
    const typeLabel = TYPE_LABEL[personType] || `👤 ${personType || 'desconhecido'}`;
    const nameStr  = personName ? `: *${personName}*` : '';

    const text =
      `📬 *Chatbot — encaminhamento de atendimento*\n\n` +
      `📱 De: ${fromPhone}\n` +
      `${typeLabel}${nameStr}\n\n` +
      `💬 "${(messageText || '').substring(0, 300)}"`;

    for (const phone of phones) {
      try {
        await reply(whatsapp, phone, text);
      } catch (e) {
        console.error('[chatbot] forward to support failed', phone, e.message);
      }
    }
  }

  // ── Menus ─────────────────────────────────────────────────────────────────

  async function showMenuAluno(whatsapp, phone, name) {
    await replyButtons(
      whatsapp,
      phone,
      `Olá, ${name}! Sou o assistente da portaria. Como posso ajudar?`,
      [
        { id: 'aluno_qr',       title: '🎫 Receber QR Code'  },
        { id: 'aluno_horarios', title: '📅 Meus horários'    },
        { id: 'aluno_ajuda',    title: '🆘 Preciso de ajuda' },
      ]
    );
  }

  async function showMenuMorador(whatsapp, phone, name) {
    await replyButtons(
      whatsapp,
      phone,
      `Olá, ${name}! Como posso ajudar?`,
      [
        { id: 'morador_portao', title: '🚪 Abrir portão'    },
        { id: 'morador_qr',     title: '🎫 Receber QR Code' },
      ]
    );
  }

  // ── Normalização de input ──────────────────────────────────────────────────

  function normalizeInput(raw) {
    return (raw || '').trim().toLowerCase();
  }

  function isOption1(input, state) {
    if (state === 'wait_aluno')   return input === '1' || input === 'aluno_qr';
    if (state === 'wait_morador') return input === '1' || input === 'morador_portao';
    return false;
  }

  function isOption2(input, state) {
    if (state === 'wait_aluno')   return input === '2' || input === 'aluno_horarios';
    if (state === 'wait_morador') return input === '2' || input === 'morador_qr';
    return false;
  }

  function isOption3(input, state) {
    if (state === 'wait_aluno') return input === '3' || input === 'aluno_ajuda';
    return false;
  }

  // ── Motor de fluxo customizado ────────────────────────────────────────────

  function getSessionValue(ctx, path) {
    let val = ctx.data;
    for (const part of path.split('.')) {
      if (val === null || val === undefined) return undefined;
      val = val[part];
    }
    return val;
  }

  function resolveFlowTemplate(text, ctx) {
    return String(text || '').replace(/\{\{(\w[\w.]*)\}\}/g, (_, key) => {
      if (key.startsWith('session.')) return String(getSessionValue(ctx, key.slice(8)) ?? '');
      return String(ctx[key] ?? '');
    });
  }

  async function sendFlowMenu(whatsapp, phone, node, ctx) {
    const resolve = (t) => resolveFlowTemplate(t, ctx);
    const bodyText = resolve(node.body || '') || 'Selecione uma opção:';
    const buttons = (node.buttons || [])
      .map((b) => ({ id: b.id, title: resolve(b.title || '').slice(0, 20) }))
      .filter((b) => b.id && b.title);
    if (!buttons.length) {
      await reply(whatsapp, phone, bodyText);
      return;
    }
    await replyButtons(whatsapp, phone, bodyText, buttons);
  }

  async function executeFlowNode(node, ctx, whatsapp, phone, cfg) {
    const resolve = (t) => resolveFlowTemplate(t, ctx);

    switch (node.type) {
      case 'identify': {
        const info = await porteiro(cfg, 'GET', '/identify', { phone });
        if (!info) return '__abort__';
        ctx.person_name = info.name || 'visitante';
        ctx.person_type = info.type || 'unknown';
        if (info.type === 'unknown') {
          if (!node.next_unknown) {
            if (cfg.unknown_message) await reply(whatsapp, phone, cfg.unknown_message);
            if (cfg.support_forward_unknown) await forwardToSupport(whatsapp, cfg, phone, '', 'unknown', null);
          }
          return node.next_unknown || '__end__';
        }
        if (info.type === 'aluno') return node.next_aluno || node.next_known || '__end__';
        return node.next_morador || node.next_known || '__end__';
      }

      case 'menu':
        await sendFlowMenu(whatsapp, phone, node, ctx);
        return '__wait__';

      case 'message':
        await reply(whatsapp, phone, resolve(node.text));
        return node.next || '__end__';

      case 'input':
        await reply(whatsapp, phone, resolve(node.prompt || ''));
        return '__wait_input__';

      case 'api_call': {
        const url = resolve(node.url || '');
        if (!url) return node.on_error || node.next || '__end__';
        const method = (node.method || 'GET').toUpperCase();
        let reqBody;
        let reqParams;
        if (node.body) {
          try {
            const raw = typeof node.body === 'string' ? node.body : JSON.stringify(node.body);
            const parsed = JSON.parse(resolve(raw));
            if (method === 'GET') reqParams = parsed;
            else reqBody = parsed;
          } catch { /* ignore malformed body */ }
        }
        let reqHeaders = {};
        if (node.headers) {
          try {
            const raw = typeof node.headers === 'string' ? node.headers : JSON.stringify(node.headers);
            reqHeaders = JSON.parse(resolve(raw));
          } catch { reqHeaders = {}; }
        }
        try {
          const r = await axios({ method, url, headers: reqHeaders, params: reqParams, data: reqBody, timeout: 10000 });
          const val = node.response_path ? r.data?.[node.response_path] : r.data;
          if (node.store_as) ctx.data[node.store_as] = val;
          const ok = val !== null && val !== undefined && val !== false && val !== '';
          return ok ? (node.next || '__end__') : (node.on_error || node.next || '__end__');
        } catch (e) {
          console.error('[chatbot/flow] api_call error', url, e.message);
          if (node.store_as) ctx.data[node.store_as] = null;
          return node.on_error || node.next || '__end__';
        }
      }

      case 'condition': {
        const val = String(getSessionValue(ctx, node.variable || '') ?? '');
        return val === String(node.equals ?? '')
          ? (node.next_true || '__end__')
          : (node.next_false || '__end__');
      }

      case 'transfer':
        if (node.message) await reply(whatsapp, phone, resolve(node.message));
        await forwardToSupport(whatsapp, cfg, phone, '', ctx.person_type, ctx.person_name);
        return '__transfer__';

      case 'encaminhar': {
        if (node.message_user) await reply(whatsapp, phone, resolve(node.message_user));
        if (node.destination === 'custom_phone' && node.custom_phone) {
          const targetPhone = resolve(node.custom_phone).replace(/\D/g, '');
          if (targetPhone) {
            const agentMsg = resolve(node.message_agent || `📬 Mensagem de *${ctx.person_name || phone}* (${phone})`);
            try { await reply(whatsapp, targetPhone, agentMsg); } catch (e) { console.error('[chatbot/encaminhar]', e.message); }
          }
          return node.next || '__end__';
        }
        const agentMsg = resolve(node.message_agent || '');
        await forwardToSupport(whatsapp, cfg, phone, agentMsg, ctx.person_type, ctx.person_name);
        return node.next || '__transfer__';
      }

      case 'horario': {
        const now = new Date();
        const cur = now.getHours() * 60 + now.getMinutes();
        const from = (parseInt(node.hour_from ?? 8) * 60) + parseInt(node.min_from ?? 0);
        const to   = (parseInt(node.hour_to ?? 18) * 60) + parseInt(node.min_to ?? 0);
        const inside = from <= to ? (cur >= from && cur < to) : (cur >= from || cur < to);
        if (!inside && node.message_outside) await reply(whatsapp, phone, resolve(node.message_outside));
        return inside ? (node.next_inside || '__end__') : (node.next_outside || '__end__');
      }

      case 'end':
        if (node.farewell) await reply(whatsapp, phone, resolve(node.farewell));
        return '__end__';

      default:
        return '__end__';
    }
  }

  async function handleFlow(phone, text, whatsapp, cfg) {
    const input = normalizeInput(text);
    let session = await getSession(phone);

    if (isExpired(session, cfg.session_ttl_min)) {
      if (session) await clearSession(phone);
      session = null;
    }

    const sessState = session?.state || 'idle';

    emit('session', phone, { sessState });

    if (sessState === 'transferred') {
      if (isCancelRequest(input)) {
        await clearSession(phone);
        emit('end', phone, { reason: 'cancelado pelo usuário (transferred)' });
        await reply(whatsapp, phone, '👋 Atendimento encerrado. Envie qualquer mensagem para ver o menu novamente.');
      } else if (input) {
        // Usuário continua enviando mensagens enquanto aguarda atendimento humano — reencaminhar ao suporte
        await forwardToSupport(whatsapp, cfg, phone, text, session?.person_type, session?.person_name);
        emit('result', phone, { nodeId: 'transferred', nodeType: 'transfer', outcome: 'relayed_to_support', nextNodeId: null });
      }
      return true;
    }

    // Ignora mensagens vazias (status webhooks, echoes) — não disparar o fluxo
    if (!input && sessState !== 'idle') return true;
    if (!input && !phone) return false;

    if (sessState !== 'idle' && isCancelRequest(input)) {
      await clearSession(phone);
      emit('end', phone, { reason: 'sessão cancelada pelo usuário' });
      await reply(whatsapp, phone, '👋 Sessão encerrada. Envie qualquer mensagem para recomeçar.');
      return true;
    }

    if (sessState !== 'idle' && isHumanRequest(input)) {
      emit('end', phone, { reason: 'transferido para suporte humano' });
      await reply(whatsapp, phone, '👨‍💼 Vou conectar você com nossa equipe. Aguarde um momento.');
      await forwardToSupport(whatsapp, cfg, phone, text, session?.person_type, session?.person_name);
      await saveSession(phone, 'transferred', session?.person_type, session?.person_name, session?.data || {});
      return true;
    }

    const nodeMap = {};
    for (const n of (cfg.flow.nodes || [])) nodeMap[n.id] = n;

    const ctx = {
      phone,
      person_name: session?.person_name || '',
      person_type: session?.person_type || '',
      porteiro_url: cfg.porteiro_url || '',
      porteiro_token: cfg.porteiro_token || '',
      bianca_url: cfg.bianca_url || '',
      bianca_token: cfg.bianca_token || '',
      relay_device_id: String(cfg.relay_device_id || ''),
      relay_door_num: String(cfg.relay_door_num || '1'),
      relay_delay: String(cfg.relay_delay || '5'),
      unknown_message: cfg.unknown_message || '',
      saudacao: (() => {
        const h = new Date().getHours();
        if (h >= 5 && h < 12) return 'Bom dia';
        if (h >= 12 && h < 18) return 'Boa tarde';
        if (h >= 18 && h < 22) return 'Boa noite';
        return 'Boa madrugada';
      })(),
      saudacao_despedida: (() => {
        const h = new Date().getHours();
        if (h >= 5 && h < 12) return 'um Bom dia';
        if (h >= 12 && h < 18) return 'uma Boa tarde';
        if (h >= 18 && h < 22) return 'uma Boa noite';
        return 'uma Boa madrugada';
      })(),
      data: { ...(session?.data || {}) },
    };

    let currentNodeId;

    if (sessState === 'idle') {
      currentNodeId = cfg.flow.entry;
      emit('start', phone, { entry: currentNodeId });
    } else if (sessState.startsWith('wait_menu_')) {
      const menuNodeId = sessState.slice('wait_menu_'.length);
      const menuNode = nodeMap[menuNodeId];
      if (!menuNode) { await clearSession(phone); return false; }

      // Ignora input vazio (webhook de status/echo) sem re-enviar o menu
      if (!input) return true;

      const buttons = menuNode.buttons || [];
      let selectedNext = null;
      const byId = buttons.find((b) => normalizeInput(b.id) === input);
      if (byId) selectedNext = byId.next;
      if (!selectedNext) {
        const idx = parseInt(input, 10) - 1;
        if (!isNaN(idx) && idx >= 0 && idx < buttons.length) selectedNext = buttons[idx].next;
      }
      if (!selectedNext) {
        emit('menu_retry', phone, { nodeId: menuNodeId, input });
        await sendFlowMenu(whatsapp, phone, menuNode, ctx);
        await saveSession(phone, sessState, session?.person_type, session?.person_name, ctx.data);
        return true;
      }
      emit('menu_select', phone, { nodeId: menuNodeId, input, next: selectedNext });
      currentNodeId = selectedNext;
    } else if (sessState.startsWith('wait_input_')) {
      const inputNodeId = sessState.slice('wait_input_'.length);
      const inputNode = nodeMap[inputNodeId];
      if (!inputNode) { await clearSession(phone); return false; }

      // Ignora input vazio (webhook de status/echo) sem re-perguntar
      if (!input) return true;

      if (inputNode.store_as) ctx.data[inputNode.store_as] = (text || '').trim();
      emit('input_captured', phone, { nodeId: inputNodeId, storeAs: inputNode.store_as });
      currentNodeId = inputNode.next || '__end__';
    } else {
      await clearSession(phone);
      currentNodeId = cfg.flow.entry;
      emit('start', phone, { entry: currentNodeId, reason: 'estado inválido — reiniciando' });
    }

    let depth = 0;
    const visitedNodes = new Set();
    while (currentNodeId && depth < 20) {
      depth++;
      // Detecção de ciclo: nó visitado duas vezes na mesma execução
      if (visitedNodes.has(currentNodeId)) {
        emit('error', phone, { error: `Ciclo detectado no nó "${currentNodeId}"` });
        console.error('[chatbot/flow] ciclo detectado no nó', currentNodeId, '— abortando');
        await reply(whatsapp, phone, '⚠️ Erro interno no fluxo (ciclo detectado). Sessão encerrada. Fale com o suporte.');
        await clearSession(phone);
        return true;
      }
      visitedNodes.add(currentNodeId);
      const node = nodeMap[currentNodeId];
      if (!node) {
        emit('error', phone, { error: `Nó "${currentNodeId}" não encontrado no fluxo` });
        break;
      }

      emit('node', phone, { nodeId: currentNodeId, nodeType: node.type, nodeLabel: node.label || currentNodeId });

      const result = await executeFlowNode(node, ctx, whatsapp, phone, cfg);

      emit('result', phone, { nodeId: currentNodeId, outcome: result, nextNodeId: (result && !result.startsWith('__')) ? result : null });

      if (result === '__wait__') {
        emit('wait', phone, { nodeId: currentNodeId, nodeLabel: node.label || currentNodeId });
        await saveSession(phone, `wait_menu_${node.id}`, ctx.person_type, ctx.person_name, ctx.data);
        return true;
      }
      if (result === '__wait_input__') {
        emit('wait', phone, { nodeId: currentNodeId, nodeLabel: node.label || currentNodeId });
        await saveSession(phone, `wait_input_${node.id}`, ctx.person_type, ctx.person_name, ctx.data);
        return true;
      }
      if (result === '__end__') {
        emit('end', phone, { reason: 'fluxo concluído' });
        await clearSession(phone);
        return true;
      }
      if (result === '__transfer__') {
        emit('end', phone, { reason: 'transferido para suporte' });
        await saveSession(phone, 'transferred', ctx.person_type, ctx.person_name, ctx.data);
        return true;
      }
      if (result === '__abort__') {
        emit('end', phone, { reason: 'abortado (erro de identificação)' });
        return false;
      }

      currentNodeId = result || null;
    }

    emit('end', phone, { reason: depth >= 20 ? 'limite de profundidade atingido' : 'sem próximo nó' });
    await clearSession(phone);
    return true;
  }

  // ── Máquina de estados embutida ───────────────────────────────────────────

  async function handleBuiltin(phone, text, whatsapp, cfg) {
    const input = normalizeInput(text);
    let session = await getSession(phone);

    if (isExpired(session, cfg.session_ttl_min)) {
      if (session) await clearSession(phone);
      session = null;
    }

    const state = session?.state || 'idle';

    if (state === 'transferred') {
      if (isCancelRequest(input)) {
        await clearSession(phone);
        await reply(whatsapp, phone, '👋 Atendimento encerrado. Envie qualquer mensagem para ver o menu novamente.');
      }
      return true;
    }

    if (state !== 'idle' && isCancelRequest(input)) {
      await clearSession(phone);
      await reply(whatsapp, phone, '👋 Sessão encerrada. Envie qualquer mensagem para recomeçar.');
      return true;
    }

    if (state !== 'idle' && isHumanRequest(input)) {
      await reply(whatsapp, phone, '👨‍💼 Vou conectar você com nossa equipe. Aguarde um momento.');
      await forwardToSupport(whatsapp, cfg, phone, text, session?.person_type, session?.person_name);
      await saveSession(phone, 'transferred', session?.person_type, session?.person_name, {});
      return true;
    }

    if (state === 'idle') {
      const info = await porteiro(cfg, 'GET', '/identify', { phone });
      if (!info) return false;

      if (info.type === 'unknown') {
        if (cfg.unknown_message) await reply(whatsapp, phone, cfg.unknown_message);
        if (cfg.support_forward_unknown) await forwardToSupport(whatsapp, cfg, phone, text, 'unknown', null);
        return true;
      }

      const name       = info.name || 'visitante';
      const personType = info.type;

      if (personType === 'aluno') {
        await showMenuAluno(whatsapp, phone, name);
        await saveSession(phone, 'wait_aluno', personType, name, { info });
      } else {
        await showMenuMorador(whatsapp, phone, name);
        await saveSession(phone, 'wait_morador', personType, name, { info });
      }
      return true;
    }

    if (state === 'wait_aluno') {
      if (isOption1(input, state)) {
        await clearSession(phone);
        const res = await porteiro(cfg, 'POST', '/send-qr', { phone });
        if (res?.sent) {
          await reply(whatsapp, phone, '✅ Seu QR Code foi enviado! Apresente-o na entrada.');
        } else {
          const detail = cfg.debug_errors && res?.reason ? `\n_${res.reason}_` : '';
          await reply(whatsapp, phone, `❌ Não consegui enviar seu QR Code. Tente novamente mais tarde.${detail}`);
        }
        return true;
      }
      if (isOption2(input, state)) {
        await clearSession(phone);
        const res = await porteiro(cfg, 'GET', '/schedule', { phone });
        if (res?.text) {
          await reply(whatsapp, phone, res.text);
        } else {
          const detail = cfg.debug_errors && res?.reason ? `\n_${res.reason}_` : '';
          await reply(whatsapp, phone, `❌ Não consegui buscar seus horários. Tente novamente mais tarde.${detail}`);
        }
        return true;
      }
      if (isOption3(input, state)) {
        await clearSession(phone);
        await reply(whatsapp, phone, '🆘 Sua mensagem foi encaminhada para nossa equipe. Em breve entraremos em contato!');
        await forwardToSupport(whatsapp, cfg, phone, 'Pedido de ajuda via chatbot', session?.person_type, session?.person_name);
        return true;
      }
      await showMenuAluno(whatsapp, phone, session.person_name || '');
      await saveSession(phone, 'wait_aluno', session.person_type, session.person_name, session.data);
      return true;
    }

    if (state === 'wait_morador') {
      if (isOption1(input, state)) {
        await clearSession(phone);
        const res = await porteiro(cfg, 'POST', '/open-gate', {
          phone,
          device_id: parseInt(cfg.relay_device_id) || 0,
          door_num: cfg.relay_door_num || 1,
          delay: cfg.relay_delay || 5,
        });
        if (res?.opened) {
          await reply(whatsapp, phone, '✅ Portão acionado!');
        } else {
          const detail = cfg.debug_errors && res?.reason ? `\n_${res.reason}_` : '';
          await reply(whatsapp, phone, `❌ Não foi possível acionar o portão. Tente pelo interfone.${detail}`);
        }
        return true;
      }
      if (isOption2(input, state)) {
        await clearSession(phone);
        const res = await porteiro(cfg, 'POST', '/send-qr', { phone });
        if (res?.sent) {
          await reply(whatsapp, phone, '✅ Seu QR Code foi enviado!');
        } else {
          const detail = cfg.debug_errors && res?.reason ? `\n_${res.reason}_` : '';
          await reply(whatsapp, phone, `❌ Não consegui enviar seu QR Code. Tente novamente mais tarde.${detail}`);
        }
        return true;
      }
      await showMenuMorador(whatsapp, phone, session.person_name || '');
      await saveSession(phone, 'wait_morador', session.person_type, session.person_name, session.data);
      return true;
    }

    return false;
  }

  // ── Dispatcher principal ──────────────────────────────────────────────────

  async function handle(phone, text, whatsapp) {
    if (!phone) return false;
    return withPhoneLock(phone, async () => {
      const cfg = await getCfg();
      if (!cfg.enabled) return false;
      emit('message', phone, { text: (text || '').slice(0, 120), mode: (cfg.flow?.nodes?.length > 0) ? 'flow' : 'builtin' });
      if (cfg.flow && Array.isArray(cfg.flow.nodes) && cfg.flow.nodes.length > 0) {
        return handleFlow(phone, text, whatsapp, cfg);
      }
      return handleBuiltin(phone, text, whatsapp, cfg);
    });
  }

  return { handle };
}

module.exports = { createChatbotService };
