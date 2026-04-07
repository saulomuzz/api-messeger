const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const { hashPassword, nowIso, safeJsonParse, sanitizePayload, sha256 } = require('./utils');

function openDatabase(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve(db);
      }
    });
  });
}

function promisifyDb(db) {
  return {
    run(sql, params = []) {
      return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(error) {
          if (error) {
            reject(error);
          } else {
            resolve({ lastID: this.lastID, changes: this.changes });
          }
        });
      });
    },
    get(sql, params = []) {
      return new Promise((resolve, reject) => {
        db.get(sql, params, (error, row) => {
          if (error) {
            reject(error);
          } else {
            resolve(row || null);
          }
        });
      });
    },
    all(sql, params = []) {
      return new Promise((resolve, reject) => {
        db.all(sql, params, (error, rows) => {
          if (error) {
            reject(error);
          } else {
            resolve(rows || []);
          }
        });
      });
    },
    exec(sql) {
      return new Promise((resolve, reject) => {
        db.exec(sql, (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  };
}

function parseMessageAuditRow(row) {
  return {
    ...row,
    payload: safeJsonParse(row.payload_json),
    response: safeJsonParse(row.response_json),
    error: safeJsonParse(row.error_json),
  };
}

function parseWebhookRow(row) {
  return {
    ...row,
    payload: safeJsonParse(row.payload_json),
    result: safeJsonParse(row.processed_result_json),
  };
}

async function createDatabase({ dbPath }) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const rawDb = await openDatabase(dbPath);
  const db = promisifyDb(rawDb);

  await db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      is_secret INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    );

    CREATE TABLE IF NOT EXISTS api_clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      token_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      description TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      rate_limit_per_minute INTEGER NOT NULL DEFAULT 60,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS api_client_ips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      ip_or_cidr TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(client_id, ip_or_cidr),
      FOREIGN KEY(client_id) REFERENCES api_clients(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ip_reputation (
      ip TEXT PRIMARY KEY,
      abuse_score INTEGER NOT NULL DEFAULT 0,
      country_code TEXT DEFAULT '',
      usage_type TEXT DEFAULT '',
      isp TEXT DEFAULT '',
      domain TEXT DEFAULT '',
      total_reports INTEGER NOT NULL DEFAULT 0,
      category TEXT NOT NULL DEFAULT 'unknown',
      source TEXT NOT NULL DEFAULT 'local',
      payload_json TEXT,
      checked_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS blocked_ips (
      ip TEXT PRIMARY KEY,
      reason TEXT DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS access_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL,
      area TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      client_ip TEXT DEFAULT '',
      client_id INTEGER,
      auth_status TEXT DEFAULT '',
      security_decision TEXT DEFAULT '',
      status_code INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      user_agent TEXT DEFAULT '',
      request_body_json TEXT,
      response_body_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS message_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL,
      client_id INTEGER,
      client_reference TEXT DEFAULT '',
      to_number TEXT NOT NULL,
      message_type TEXT NOT NULL,
      status TEXT NOT NULL,
      meta_message_id TEXT DEFAULT '',
      payload_json TEXT,
      response_json TEXT,
      error_json TEXT,
      source_ip TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS webhook_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      from_number TEXT DEFAULT '',
      message_id TEXT DEFAULT '',
      payload_json TEXT,
      processed_result_json TEXT,
      source_ip TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS admin_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      session_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES admin_users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS admin_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_user_id INTEGER,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT DEFAULT '',
      details_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS webhook_auto_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      match_type TEXT NOT NULL DEFAULT 'contains',
      keyword TEXT NOT NULL,
      reply_type TEXT NOT NULL DEFAULT 'text',
      reply_text TEXT DEFAULT '',
      template_name TEXT DEFAULT '',
      template_language TEXT DEFAULT '',
      template_components_json TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_api_clients_token_hash ON api_clients(token_hash);
    CREATE INDEX IF NOT EXISTS idx_api_client_ips_client_id ON api_client_ips(client_id);
    CREATE INDEX IF NOT EXISTS idx_ip_reputation_category ON ip_reputation(category);
    CREATE INDEX IF NOT EXISTS idx_access_logs_created_at ON access_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_access_logs_client_id ON access_logs(client_id);
    CREATE INDEX IF NOT EXISTS idx_message_audit_client_id ON message_audit(client_id);
    CREATE INDEX IF NOT EXISTS idx_message_audit_meta_message_id ON message_audit(meta_message_id);
    CREATE INDEX IF NOT EXISTS idx_webhook_events_created_at ON webhook_events(created_at);
  `);

  const api = {
    db,
    async getSetting(key) {
      return db.get('SELECT key, value, is_secret, updated_at, updated_by FROM app_settings WHERE key = ?', [key]);
    },
    async setSetting(key, value, options = {}) {
      const now = nowIso();
      await db.run(
        `INSERT INTO app_settings (key, value, is_secret, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, is_secret = excluded.is_secret, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        [key, value, options.isSecret ? 1 : 0, now, options.updatedBy || null]
      );
    },
    async insertAccessLog(entry) {
      await db.run(
        `INSERT INTO access_logs (
          request_id, area, method, path, client_ip, client_id, auth_status, security_decision,
          status_code, latency_ms, user_agent, request_body_json, response_body_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.requestId,
          entry.area,
          entry.method,
          entry.path,
          entry.clientIp,
          entry.clientId || null,
          entry.authStatus || '',
          entry.securityDecision || '',
          entry.statusCode,
          entry.latencyMs || 0,
          entry.userAgent || '',
          entry.requestBody ? JSON.stringify(sanitizePayload(entry.requestBody)) : null,
          entry.responseBody ? JSON.stringify(sanitizePayload(entry.responseBody)) : null,
          nowIso(),
        ]
      );
    },
    async createApiClient({ name, description, notes, rateLimitPerMinute, token }) {
      const now = nowIso();
      const result = await db.run(
        `INSERT INTO api_clients (name, token_hash, status, description, notes, rate_limit_per_minute, created_at, updated_at)
         VALUES (?, ?, 'active', ?, ?, ?, ?, ?)`,
        [name, sha256(token), description || '', notes || '', rateLimitPerMinute || 60, now, now]
      );
      return result.lastID;
    },
    async updateApiClient(id, payload) {
      const current = await db.get('SELECT * FROM api_clients WHERE id = ?', [id]);
      if (!current) return null;
      const next = {
        name: payload.name ?? current.name,
        status: payload.status ?? current.status,
        description: payload.description ?? current.description,
        notes: payload.notes ?? current.notes,
        rate_limit_per_minute: payload.rateLimitPerMinute ?? current.rate_limit_per_minute,
      };
      await db.run(
        `UPDATE api_clients SET name = ?, status = ?, description = ?, notes = ?, rate_limit_per_minute = ?, updated_at = ? WHERE id = ?`,
        [next.name, next.status, next.description, next.notes, next.rate_limit_per_minute, nowIso(), id]
      );
      return this.getApiClientById(id);
    },
    async regenerateApiClientToken(id, token) {
      await db.run('UPDATE api_clients SET token_hash = ?, updated_at = ? WHERE id = ?', [sha256(token), nowIso(), id]);
    },
    async listApiClients() {
      const clients = await db.all(
        `SELECT id, name, status, description, notes, rate_limit_per_minute, created_at, updated_at, last_used_at
         FROM api_clients ORDER BY name`
      );
      for (const client of clients) {
        client.allowed_ips = await db.all(
          `SELECT id, ip_or_cidr, status, notes, created_at, updated_at
           FROM api_client_ips WHERE client_id = ? ORDER BY ip_or_cidr`,
          [client.id]
        );
      }
      return clients;
    },
    async getApiClientById(id) {
      const row = await db.get(
        `SELECT id, name, status, description, notes, rate_limit_per_minute, created_at, updated_at, last_used_at
         FROM api_clients WHERE id = ?`,
        [id]
      );
      if (!row) return null;
      row.allowed_ips = await db.all(
        `SELECT id, ip_or_cidr, status, notes, created_at, updated_at
         FROM api_client_ips WHERE client_id = ? ORDER BY ip_or_cidr`,
        [row.id]
      );
      return row;
    },
    async findApiClientByTokenHash(tokenHash) {
      return db.get('SELECT * FROM api_clients WHERE token_hash = ?', [tokenHash]);
    },
    async touchApiClient(id) {
      await db.run('UPDATE api_clients SET last_used_at = ?, updated_at = ? WHERE id = ?', [nowIso(), nowIso(), id]);
    },
    async setClientAllowedIp({ clientId, ipOrCidr, notes }) {
      const now = nowIso();
      await db.run(
        `INSERT INTO api_client_ips (client_id, ip_or_cidr, status, notes, created_at, updated_at)
         VALUES (?, ?, 'active', ?, ?, ?)
         ON CONFLICT(client_id, ip_or_cidr) DO UPDATE SET status = 'active', notes = excluded.notes, updated_at = excluded.updated_at`,
        [clientId, ipOrCidr, notes || '', now, now]
      );
    },
    async removeClientAllowedIp(id) {
      await db.run('DELETE FROM api_client_ips WHERE id = ?', [id]);
    },
    async listClientAllowedIps(clientId) {
      return db.all('SELECT * FROM api_client_ips WHERE client_id = ? AND status = \'active\' ORDER BY ip_or_cidr', [clientId]);
    },
    async getBlockedIp(ip) {
      return db.get('SELECT * FROM blocked_ips WHERE ip = ?', [ip]);
    },
    async blockIp({ ip, reason, source }) {
      const now = nowIso();
      await db.run(
        `INSERT INTO blocked_ips (ip, reason, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(ip) DO UPDATE SET reason = excluded.reason, source = excluded.source, updated_at = excluded.updated_at`,
        [ip, reason || '', source || 'manual', now, now]
      );
    },
    async unblockIp(ip) {
      await db.run('DELETE FROM blocked_ips WHERE ip = ?', [ip]);
    },
    async listBlockedIps() {
      return db.all('SELECT * FROM blocked_ips ORDER BY updated_at DESC');
    },
    async getIpReputation(ip) {
      return db.get('SELECT * FROM ip_reputation WHERE ip = ?', [ip]);
    },
    async upsertIpReputation(payload) {
      await db.run(
        `INSERT INTO ip_reputation (
          ip, abuse_score, country_code, usage_type, isp, domain, total_reports, category,
          source, payload_json, checked_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ip) DO UPDATE SET
          abuse_score = excluded.abuse_score,
          country_code = excluded.country_code,
          usage_type = excluded.usage_type,
          isp = excluded.isp,
          domain = excluded.domain,
          total_reports = excluded.total_reports,
          category = excluded.category,
          source = excluded.source,
          payload_json = excluded.payload_json,
          checked_at = excluded.checked_at,
          expires_at = excluded.expires_at`,
        [
          payload.ip,
          payload.abuseScore,
          payload.countryCode || '',
          payload.usageType || '',
          payload.isp || '',
          payload.domain || '',
          payload.totalReports || 0,
          payload.category,
          payload.source || 'local',
          JSON.stringify(sanitizePayload(payload.payload || {})),
          payload.checkedAt,
          payload.expiresAt,
        ]
      );
    },
    async listIpReputations(limit = 100) {
      return db.all('SELECT * FROM ip_reputation ORDER BY checked_at DESC LIMIT ?', [limit]);
    },
    async createMessageAudit(entry) {
      const now = nowIso();
      const result = await db.run(
        `INSERT INTO message_audit (
          request_id, client_id, client_reference, to_number, message_type, status, meta_message_id,
          payload_json, response_json, error_json, source_ip, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.requestId,
          entry.clientId || null,
          entry.clientReference || '',
          entry.toNumber,
          entry.messageType,
          entry.status,
          entry.metaMessageId || '',
          JSON.stringify(sanitizePayload(entry.payload || {})),
          entry.response ? JSON.stringify(sanitizePayload(entry.response)) : null,
          entry.error ? JSON.stringify(sanitizePayload(entry.error)) : null,
          entry.sourceIp || '',
          now,
          now,
        ]
      );
      return result.lastID;
    },
    async updateMessageAudit(id, entry) {
      await db.run(
        `UPDATE message_audit SET status = ?, meta_message_id = ?, response_json = ?, error_json = ?, updated_at = ? WHERE id = ?`,
        [
          entry.status,
          entry.metaMessageId || '',
          entry.response ? JSON.stringify(sanitizePayload(entry.response)) : null,
          entry.error ? JSON.stringify(sanitizePayload(entry.error)) : null,
          nowIso(),
          id,
        ]
      );
    },
    async listMessageAudit(limit = 100) {
      const rows = await db.all('SELECT * FROM message_audit ORDER BY created_at DESC LIMIT ?', [limit]);
      return rows.map(parseMessageAuditRow);
    },
    async getMessageAuditById(id, clientId) {
      const row = await db.get('SELECT * FROM message_audit WHERE id = ? AND client_id = ?', [id, clientId]);
      return row ? parseMessageAuditRow(row) : null;
    },
    async insertWebhookEvent(entry) {
      const result = await db.run(
        `INSERT INTO webhook_events (
          request_id, event_type, from_number, message_id, payload_json, processed_result_json, source_ip, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.requestId,
          entry.eventType,
          entry.fromNumber || '',
          entry.messageId || '',
          JSON.stringify(sanitizePayload(entry.payload || {})),
          entry.result ? JSON.stringify(sanitizePayload(entry.result)) : null,
          entry.sourceIp || '',
          nowIso(),
        ]
      );
      return result.lastID;
    },
    async listWebhookEvents(limit = 100) {
      const rows = await db.all('SELECT * FROM webhook_events ORDER BY created_at DESC LIMIT ?', [limit]);
      return rows.map(parseWebhookRow);
    },
    async listAutoReplies() {
      const rows = await db.all('SELECT * FROM webhook_auto_replies ORDER BY updated_at DESC');
      return rows.map((row) => ({
        ...row,
        template_components: safeJsonParse(row.template_components_json) || [],
      }));
    },
    async upsertAutoReply(payload) {
      const now = nowIso();
      if (payload.id) {
        await db.run(
          `UPDATE webhook_auto_replies
           SET name = ?, match_type = ?, keyword = ?, reply_type = ?, reply_text = ?, template_name = ?,
               template_language = ?, template_components_json = ?, status = ?, updated_at = ?
           WHERE id = ?`,
          [
            payload.name,
            payload.matchType,
            payload.keyword,
            payload.replyType,
            payload.replyText || '',
            payload.templateName || '',
            payload.templateLanguage || '',
            JSON.stringify(payload.templateComponents || []),
            payload.status || 'active',
            now,
            payload.id,
          ]
        );
        return payload.id;
      }
      const result = await db.run(
        `INSERT INTO webhook_auto_replies (
          name, match_type, keyword, reply_type, reply_text, template_name,
          template_language, template_components_json, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          payload.name,
          payload.matchType,
          payload.keyword,
          payload.replyType,
          payload.replyText || '',
          payload.templateName || '',
          payload.templateLanguage || '',
          JSON.stringify(payload.templateComponents || []),
          payload.status || 'active',
          now,
          now,
        ]
      );
      return result.lastID;
    },
    async createAdminAction(entry) {
      await db.run(
        `INSERT INTO admin_actions (admin_user_id, action, target_type, target_id, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          entry.adminUserId || null,
          entry.action,
          entry.targetType,
          entry.targetId || '',
          JSON.stringify(sanitizePayload(entry.details || {})),
          nowIso(),
        ]
      );
    },
    async listAdminActions(limit = 100) {
      const rows = await db.all('SELECT * FROM admin_actions ORDER BY created_at DESC LIMIT ?', [limit]);
      return rows.map((row) => ({
        ...row,
        details: safeJsonParse(row.details_json),
      }));
    },
    async findAdminUserByUsername(username) {
      return db.get('SELECT * FROM admin_users WHERE username = ?', [username]);
    },
    async findAdminUserById(id) {
      return db.get('SELECT * FROM admin_users WHERE id = ?', [id]);
    },
    async ensureAdminUser() {
      const existing = await db.get('SELECT * FROM admin_users LIMIT 1');
      if (existing) return existing;
      const username = process.env.ADMIN_USERNAME || 'admin';
      const password = process.env.ADMIN_PASSWORD || 'change-me-now';
      const now = nowIso();
      const result = await db.run(
        `INSERT INTO admin_users (username, password_hash, status, created_at, updated_at)
         VALUES (?, ?, 'active', ?, ?)`,
        [username, hashPassword(password), now, now]
      );
      return this.findAdminUserById(result.lastID);
    },
    async createAdminSession(userId, rawToken, expiresAt) {
      const now = nowIso();
      await db.run(
        `INSERT INTO admin_sessions (user_id, session_hash, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [userId, sha256(rawToken), expiresAt, now, now]
      );
    },
    async getAdminSession(rawToken) {
      return db.get(
        `SELECT s.*, u.username, u.status AS user_status
         FROM admin_sessions s
         JOIN admin_users u ON u.id = s.user_id
         WHERE s.session_hash = ?`,
        [sha256(rawToken)]
      );
    },
    async deleteAdminSession(rawToken) {
      await db.run('DELETE FROM admin_sessions WHERE session_hash = ?', [sha256(rawToken)]);
    },
    async purgeExpiredSessions() {
      await db.run('DELETE FROM admin_sessions WHERE expires_at < ?', [nowIso()]);
    },
    async markAdminLogin(userId) {
      await db.run('UPDATE admin_users SET last_login_at = ?, updated_at = ? WHERE id = ?', [nowIso(), nowIso(), userId]);
    },
  };

  await api.ensureAdminUser();
  return api;
}

module.exports = {
  createDatabase,
};
