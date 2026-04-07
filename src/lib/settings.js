const { maskSecret, parseList, parsePositiveInt } = require('./utils');

const SETTING_DEFINITIONS = {
  'whatsapp.access_token': { env: 'WHATSAPP_ACCESS_TOKEN', secret: true, defaultValue: '' },
  'whatsapp.phone_number_id': { env: 'WHATSAPP_PHONE_NUMBER_ID', secret: false, defaultValue: '' },
  'whatsapp.business_account_id': { env: 'WHATSAPP_BUSINESS_ACCOUNT_ID', secret: false, defaultValue: '' },
  'whatsapp.webhook_verify_token': { env: 'WHATSAPP_WEBHOOK_VERIFY_TOKEN', secret: true, defaultValue: '' },
  'whatsapp.api_version': { env: 'WHATSAPP_API_VERSION', secret: false, defaultValue: 'v21.0' },
  'whatsapp.webhook_domain': { env: 'WHATSAPP_WEBHOOK_DOMAIN', secret: false, defaultValue: '' },
  'abuseipdb.api_key': { env: 'ABUSEIPDB_API_KEY', secret: true, defaultValue: '' },
  'security.global_allowlist': { env: 'GLOBAL_IP_ALLOWLIST', secret: false, defaultValue: '' },
  'security.yellow_threshold': { env: 'SECURITY_YELLOW_THRESHOLD', secret: false, defaultValue: '25' },
  'security.block_threshold': { env: 'SECURITY_BLOCK_THRESHOLD', secret: false, defaultValue: '75' },
  'security.reputation_ttl_minutes': { env: 'SECURITY_REPUTATION_TTL_MINUTES', secret: false, defaultValue: '1440' },
  'security.global_rate_limit_per_minute': { env: 'SECURITY_GLOBAL_RATE_LIMIT_PER_MINUTE', secret: false, defaultValue: '120' },
  'security.admin_session_hours': { env: 'ADMIN_SESSION_HOURS', secret: false, defaultValue: '24' },
};

async function resolveSettingValue(db, key) {
  const def = SETTING_DEFINITIONS[key];
  const row = await db.getSetting(key);
  if (row && row.value !== null && row.value !== undefined) {
    return row.value;
  }
  return process.env[def.env] ?? def.defaultValue;
}

async function getPublicSettings(db) {
  const values = {};
  for (const key of Object.keys(SETTING_DEFINITIONS)) {
    values[key] = await resolveSettingValue(db, key);
  }
  return {
    whatsapp: {
      access_token: values['whatsapp.access_token'],
      phone_number_id: values['whatsapp.phone_number_id'],
      business_account_id: values['whatsapp.business_account_id'],
      webhook_verify_token: values['whatsapp.webhook_verify_token'],
      api_version: values['whatsapp.api_version'],
      webhook_domain: values['whatsapp.webhook_domain'],
    },
    abuseipdb: {
      api_key: values['abuseipdb.api_key'],
    },
    security: {
      global_allowlist: parseList(values['security.global_allowlist']),
      yellow_threshold: parsePositiveInt(values['security.yellow_threshold'], 25),
      block_threshold: parsePositiveInt(values['security.block_threshold'], 75),
      reputation_ttl_minutes: parsePositiveInt(values['security.reputation_ttl_minutes'], 1440),
      global_rate_limit_per_minute: parsePositiveInt(values['security.global_rate_limit_per_minute'], 120),
    },
    admin: {
      session_hours: parsePositiveInt(values['security.admin_session_hours'], 24),
    },
  };
}

function maskSettings(settings) {
  return {
    whatsapp: {
      access_token: settings.whatsapp.access_token ? maskSecret(settings.whatsapp.access_token) : '',
      phone_number_id: settings.whatsapp.phone_number_id || '',
      business_account_id: settings.whatsapp.business_account_id || '',
      webhook_verify_token: settings.whatsapp.webhook_verify_token ? maskSecret(settings.whatsapp.webhook_verify_token) : '',
      api_version: settings.whatsapp.api_version || '',
      webhook_domain: settings.whatsapp.webhook_domain || '',
    },
    abuseipdb: {
      api_key: settings.abuseipdb.api_key ? maskSecret(settings.abuseipdb.api_key) : '',
    },
    security: settings.security,
    admin: settings.admin,
  };
}

async function saveSettings(db, payload, updatedBy) {
  const current = await getPublicSettings(db);
  const merged = {
    whatsapp: {
      ...current.whatsapp,
      ...(payload.whatsapp || {}),
    },
    abuseipdb: {
      ...current.abuseipdb,
      ...(payload.abuseipdb || {}),
    },
    security: {
      ...current.security,
      ...(payload.security || {}),
    },
    admin: {
      ...current.admin,
      ...(payload.admin || {}),
    },
  };

  const updates = {
    'whatsapp.phone_number_id': merged.whatsapp.phone_number_id || '',
    'whatsapp.business_account_id': merged.whatsapp.business_account_id || '',
    'whatsapp.api_version': merged.whatsapp.api_version || 'v21.0',
    'whatsapp.webhook_domain': merged.whatsapp.webhook_domain || '',
    'security.global_allowlist': Array.isArray(merged.security.global_allowlist)
      ? merged.security.global_allowlist.join('\n')
      : String(merged.security.global_allowlist || ''),
    'security.yellow_threshold': String(merged.security.yellow_threshold || 25),
    'security.block_threshold': String(merged.security.block_threshold || 75),
    'security.reputation_ttl_minutes': String(merged.security.reputation_ttl_minutes || 1440),
    'security.global_rate_limit_per_minute': String(merged.security.global_rate_limit_per_minute || 120),
    'security.admin_session_hours': String(merged.admin.session_hours || 24),
  };

  if (Object.prototype.hasOwnProperty.call(payload.whatsapp || {}, 'access_token') && payload.whatsapp.access_token) {
    updates['whatsapp.access_token'] = payload.whatsapp.access_token;
  }
  if (Object.prototype.hasOwnProperty.call(payload.whatsapp || {}, 'webhook_verify_token') && payload.whatsapp.webhook_verify_token) {
    updates['whatsapp.webhook_verify_token'] = payload.whatsapp.webhook_verify_token;
  }
  if (Object.prototype.hasOwnProperty.call(payload.abuseipdb || {}, 'api_key') && payload.abuseipdb.api_key) {
    updates['abuseipdb.api_key'] = payload.abuseipdb.api_key;
  }

  for (const [key, value] of Object.entries(updates)) {
    const definition = SETTING_DEFINITIONS[key];
    await db.setSetting(key, String(value ?? ''), {
      isSecret: definition.secret,
      updatedBy,
    });
  }

  return getPublicSettings(db);
}

module.exports = {
  getPublicSettings,
  maskSettings,
  saveSettings,
};
