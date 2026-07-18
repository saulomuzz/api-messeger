const axios = require('axios');

const { getPublicSettings } = require('./settings');

const RESOLVE_TTL_MS = 60 * 60 * 1000; // 60 min — evita bater no api-porteiro a cada render

function createContactsService({ db }) {
  async function fetchFromPorteiro(phone) {
    const settings = await getPublicSettings(db);
    const cfg = settings.chatbot;
    const base = (cfg.porteiro_url || '').replace(/\/$/, '');
    if (!base || !cfg.porteiro_token) return null;
    try {
      const response = await axios({
        method: 'get',
        url: `${base}/api/v1/chatbot/identify`,
        headers: { Authorization: `Bearer ${cfg.porteiro_token}` },
        params: { phone },
        timeout: 10000,
      });
      return response.data;
    } catch (error) {
      console.error('[contacts] porteiro identify error', error?.response?.data || error.message);
      return null;
    }
  }

  function isStale(contact) {
    if (!contact) return true;
    if (contact.manual_override) return false;
    if (!contact.resolved_at) return true;
    return Date.now() - new Date(contact.resolved_at).getTime() > RESOLVE_TTL_MS;
  }

  async function resolveContact(phone) {
    if (!phone) return null;
    const existing = await db.getContact(phone);
    if (!isStale(existing)) return existing;

    const identified = await fetchFromPorteiro(phone);
    await db.upsertResolvedContact({
      phone,
      name: identified?.name || null,
      personType: identified?.type || null,
      personId: identified?.person_id || null,
      alunoId: identified?.aluno_id || null,
      source: 'porteiro',
    });
    return db.getContact(phone);
  }

  async function resolveContacts(phones) {
    const unique = [...new Set((phones || []).filter(Boolean))];
    const results = {};
    const concurrency = 4;
    let cursor = 0;
    async function worker() {
      while (cursor < unique.length) {
        const phone = unique[cursor++];
        results[phone] = await resolveContact(phone);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, worker));
    return results;
  }

  async function setManualName(phone, name) {
    await db.setManualContactName(phone, name);
    return db.getContact(phone);
  }

  return { resolveContact, resolveContacts, setManualName };
}

module.exports = { createContactsService };
