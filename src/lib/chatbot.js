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

// Palavras-chave que disparam transferência para atendente humano
const HUMAN_KEYWORDS = [
  'humano', 'atendente', 'atendimento', 'suporte', 'help',
  'ajuda', 'socorro', 'falar com', 'quero falar', 'preciso de ajuda',
  'quero atendimento', 'atendente humano', 'pessoa real',
];

function isHumanRequest(input) {
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
        { id: 'aluno_qr',       title: '🎫 Receber QR Code' },
        { id: 'aluno_horarios', title: '📅 Meus horários'   },
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

  // ── Máquina de estados ────────────────────────────────────────────────────

  async function handle(phone, text, whatsapp) {
    const cfg = await getCfg();
    if (!cfg.enabled) return false;

    const input = normalizeInput(text);
    let session = await getSession(phone);

    // Sessão expirada → volta para idle
    if (isExpired(session, cfg.session_ttl_min)) {
      if (session) await clearSession(phone);
      session = null;
    }

    const state = session?.state || 'idle';

    // Estado transferred: humano assumiu, chatbot silencia até TTL expirar
    if (state === 'transferred') return true;

    // Cancelamento global (qualquer estado ativo)
    if (state !== 'idle' && isCancelRequest(input)) {
      await clearSession(phone);
      await reply(whatsapp, phone, '👋 Sessão encerrada. Envie qualquer mensagem para recomeçar.');
      return true;
    }

    // Transferência para humano (qualquer estado ativo)
    if (state !== 'idle' && isHumanRequest(input)) {
      await reply(whatsapp, phone, '👨‍💼 Vou conectar você com nossa equipe. Aguarde um momento.');
      await forwardToSupport(whatsapp, cfg, phone, text, session?.person_type, session?.person_name);
      await saveSession(phone, 'transferred', session?.person_type, session?.person_name, {});
      return true;
    }

    // ── IDLE: identifica e exibe menu ─────────────────────────────────────
    if (state === 'idle') {
      const info = await porteiro(cfg, 'GET', '/identify', { phone });
      if (!info) return false; // porteiro indisponível — deixa auto-replies agirem

      if (info.type === 'unknown') {
        if (cfg.unknown_message) {
          await reply(whatsapp, phone, cfg.unknown_message);
        }
        if (cfg.support_forward_unknown) {
          await forwardToSupport(whatsapp, cfg, phone, text, 'unknown', null);
        }
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

    // ── WAIT_ALUNO ─────────────────────────────────────────────────────────
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

      // Opção inválida → reenvia menu
      await showMenuAluno(whatsapp, phone, session.person_name || '');
      await saveSession(phone, 'wait_aluno', session.person_type, session.person_name, session.data);
      return true;
    }

    // ── WAIT_MORADOR ───────────────────────────────────────────────────────
    if (state === 'wait_morador') {
      if (isOption1(input, state)) {
        await clearSession(phone);
        const res = await porteiro(cfg, 'POST', '/open-gate', { phone });
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

      // Opção inválida → reenvia menu
      await showMenuMorador(whatsapp, phone, session.person_name || '');
      await saveSession(phone, 'wait_morador', session.person_type, session.person_name, session.data);
      return true;
    }

    return false;
  }

  return { handle };
}

module.exports = { createChatbotService };
