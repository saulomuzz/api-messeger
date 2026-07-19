const { maskSecret, parseList, parsePositiveInt } = require('./utils');

const SETTING_DEFINITIONS = {
  'dev.mode_enabled': { env: 'DEV_MODE_ENABLED', secret: false, defaultValue: 'false' },
  'dev.test_phone':   { env: 'DEV_TEST_PHONE',   secret: false, defaultValue: '' },
  'whatsapp.access_token': { env: 'WHATSAPP_ACCESS_TOKEN', secret: true, defaultValue: '' },
  'whatsapp.phone_number_id': { env: 'WHATSAPP_PHONE_NUMBER_ID', secret: false, defaultValue: '' },
  'whatsapp.business_account_id': { env: 'WHATSAPP_BUSINESS_ACCOUNT_ID', secret: false, defaultValue: '' },
  'whatsapp.webhook_verify_token': { env: 'WHATSAPP_WEBHOOK_VERIFY_TOKEN', secret: true, defaultValue: '' },
  'whatsapp.app_secret': { env: 'WHATSAPP_APP_SECRET', secret: true, defaultValue: '' },
  'whatsapp.api_version': { env: 'WHATSAPP_API_VERSION', secret: false, defaultValue: 'v21.0' },
  'whatsapp.webhook_domain': { env: 'WHATSAPP_WEBHOOK_DOMAIN', secret: false, defaultValue: '' },
  'abuseipdb.api_key': { env: 'ABUSEIPDB_API_KEY', secret: true, defaultValue: '' },
  'security.global_allowlist': { env: 'GLOBAL_IP_ALLOWLIST', secret: false, defaultValue: '' },
  'security.yellow_threshold': { env: 'SECURITY_YELLOW_THRESHOLD', secret: false, defaultValue: '25' },
  'security.block_threshold': { env: 'SECURITY_BLOCK_THRESHOLD', secret: false, defaultValue: '75' },
  'security.reputation_ttl_minutes': { env: 'SECURITY_REPUTATION_TTL_MINUTES', secret: false, defaultValue: '1440' },
  'security.global_rate_limit_per_minute': { env: 'SECURITY_GLOBAL_RATE_LIMIT_PER_MINUTE', secret: false, defaultValue: '120' },
  'security.admin_session_hours': { env: 'ADMIN_SESSION_HOURS', secret: false, defaultValue: '24' },
  'esp32.token':               { env: 'ESP32_TOKEN',               secret: true,  defaultValue: '' },
  'esp32.camera_snapshot_url': { env: 'ESP32_CAMERA_SNAPSHOT_URL', secret: false, defaultValue: '' },
  'esp32.notify_phones':       { env: 'ESP32_NOTIFY_PHONES',       secret: false, defaultValue: '' },
  'esp32.template_name':       { env: 'ESP32_TEMPLATE_NAME',       secret: false, defaultValue: 'status_portao' },
  'esp32.template_language':   { env: 'ESP32_TEMPLATE_LANGUAGE',   secret: false, defaultValue: 'pt_BR' },
  'chatbot.enabled':               { env: 'CHATBOT_ENABLED',               secret: false, defaultValue: 'false' },
  'chatbot.porteiro_url':          { env: 'CHATBOT_PORTEIRO_URL',          secret: false, defaultValue: '' },
  'chatbot.porteiro_token':        { env: 'CHATBOT_PORTEIRO_TOKEN',        secret: true,  defaultValue: '' },
  'chatbot.unknown_message':       { env: 'CHATBOT_UNKNOWN_MESSAGE',       secret: false, defaultValue: 'Olá! Seu número não está cadastrado em nosso sistema. Para mais informações, entre em contato com a administração.' },
  'chatbot.session_ttl_min':       { env: 'CHATBOT_SESSION_TTL_MIN',       secret: false, defaultValue: '5' },
  'chatbot.relay_device_id':       { env: 'CHATBOT_RELAY_DEVICE_ID',       secret: false, defaultValue: '' },
  'chatbot.relay_door_num':        { env: 'CHATBOT_RELAY_DOOR_NUM',        secret: false, defaultValue: '1' },
  'chatbot.relay_delay':           { env: 'CHATBOT_RELAY_DELAY',           secret: false, defaultValue: '5' },
  'chatbot.support_phones':        { env: 'CHATBOT_SUPPORT_PHONES',        secret: false, defaultValue: '' },
  'chatbot.support_forward_unknown': { env: 'CHATBOT_SUPPORT_FORWARD_UNKNOWN', secret: false, defaultValue: 'false' },
  'chatbot.debug_errors':          { env: 'CHATBOT_DEBUG_ERRORS',          secret: false, defaultValue: 'false' },
  'chatbot.flow':                  { env: 'CHATBOT_FLOW',                  secret: false, defaultValue: '' },
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
    dev: {
      mode_enabled: values['dev.mode_enabled'] === 'true',
      test_phone: values['dev.test_phone'] || '',
    },
    whatsapp: {
      access_token: values['whatsapp.access_token'],
      phone_number_id: values['whatsapp.phone_number_id'],
      business_account_id: values['whatsapp.business_account_id'],
      webhook_verify_token: values['whatsapp.webhook_verify_token'],
      app_secret: values['whatsapp.app_secret'],
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
    esp32: {
      token: values['esp32.token'] || '',
      camera_snapshot_url: values['esp32.camera_snapshot_url'] || '',
      notify_phones: parseList(values['esp32.notify_phones']),
      template_name: values['esp32.template_name'] || 'status_portao',
      template_language: values['esp32.template_language'] || 'pt_BR',
    },
    chatbot: {
      enabled: values['chatbot.enabled'] === 'true',
      porteiro_url: values['chatbot.porteiro_url'] || '',
      porteiro_token: values['chatbot.porteiro_token'] || '',
      unknown_message: values['chatbot.unknown_message'] || '',
      session_ttl_min: parsePositiveInt(values['chatbot.session_ttl_min'], 5),
      relay_device_id: values['chatbot.relay_device_id'] || '',
      relay_door_num: parsePositiveInt(values['chatbot.relay_door_num'], 1),
      relay_delay: parsePositiveInt(values['chatbot.relay_delay'], 5),
      support_phones: values['chatbot.support_phones'] || '',
      support_forward_unknown: values['chatbot.support_forward_unknown'] === 'true',
      debug_errors: values['chatbot.debug_errors'] === 'true',
      flow: (() => { try { return JSON.parse(values['chatbot.flow'] || '{}'); } catch { return {}; } })(),
    },
  };
}

function maskSettings(settings) {
  return {
    dev: settings.dev,
    whatsapp: {
      access_token: settings.whatsapp.access_token ? maskSecret(settings.whatsapp.access_token) : '',
      phone_number_id: settings.whatsapp.phone_number_id || '',
      business_account_id: settings.whatsapp.business_account_id || '',
      webhook_verify_token: settings.whatsapp.webhook_verify_token ? maskSecret(settings.whatsapp.webhook_verify_token) : '',
      app_secret: settings.whatsapp.app_secret ? maskSecret(settings.whatsapp.app_secret) : '',
      api_version: settings.whatsapp.api_version || '',
      webhook_domain: settings.whatsapp.webhook_domain || '',
    },
    abuseipdb: {
      api_key: settings.abuseipdb.api_key ? maskSecret(settings.abuseipdb.api_key) : '',
    },
    security: settings.security,
    admin: settings.admin,
    esp32: {
      token: settings.esp32.token ? maskSecret(settings.esp32.token) : '',
      camera_snapshot_url: settings.esp32.camera_snapshot_url,
      notify_phones: settings.esp32.notify_phones,
      template_name: settings.esp32.template_name,
      template_language: settings.esp32.template_language,
    },
    chatbot: {
      enabled: settings.chatbot.enabled,
      porteiro_url: settings.chatbot.porteiro_url,
      porteiro_token: settings.chatbot.porteiro_token ? maskSecret(settings.chatbot.porteiro_token) : '',
      unknown_message: settings.chatbot.unknown_message,
      session_ttl_min: settings.chatbot.session_ttl_min,
      relay_device_id: settings.chatbot.relay_device_id,
      relay_door_num: settings.chatbot.relay_door_num,
      relay_delay: settings.chatbot.relay_delay,
      support_phones: settings.chatbot.support_phones,
      support_forward_unknown: settings.chatbot.support_forward_unknown,
      debug_errors: settings.chatbot.debug_errors,
      flow: settings.chatbot.flow,
    },
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
    dev: {
      ...current.dev,
      ...(payload.dev || {}),
    },
  };

  const updates = {
    'dev.mode_enabled': String(merged.dev?.mode_enabled ?? false),
    'dev.test_phone': merged.dev?.test_phone || '',
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
  if (Object.prototype.hasOwnProperty.call(payload.whatsapp || {}, 'app_secret') && payload.whatsapp.app_secret) {
    updates['whatsapp.app_secret'] = payload.whatsapp.app_secret;
  }
  if (Object.prototype.hasOwnProperty.call(payload.abuseipdb || {}, 'api_key') && payload.abuseipdb.api_key) {
    updates['abuseipdb.api_key'] = payload.abuseipdb.api_key;
  }

  const esp32Payload = payload.esp32 || {};
  if (esp32Payload.camera_snapshot_url !== undefined) updates['esp32.camera_snapshot_url'] = esp32Payload.camera_snapshot_url || '';
  if (esp32Payload.notify_phones !== undefined) {
    updates['esp32.notify_phones'] = Array.isArray(esp32Payload.notify_phones)
      ? esp32Payload.notify_phones.join('\n')
      : String(esp32Payload.notify_phones || '');
  }
  if (esp32Payload.template_name !== undefined) updates['esp32.template_name'] = esp32Payload.template_name || 'status_portao';
  if (esp32Payload.template_language !== undefined) updates['esp32.template_language'] = esp32Payload.template_language || 'pt_BR';
  if (Object.prototype.hasOwnProperty.call(esp32Payload, 'token') && esp32Payload.token) {
    updates['esp32.token'] = esp32Payload.token;
  }

  const chatbotPayload = payload.chatbot || {};
  if (chatbotPayload.enabled !== undefined) updates['chatbot.enabled'] = String(chatbotPayload.enabled ?? false);
  if (chatbotPayload.porteiro_url !== undefined) updates['chatbot.porteiro_url'] = chatbotPayload.porteiro_url || '';
  if (chatbotPayload.unknown_message !== undefined) updates['chatbot.unknown_message'] = chatbotPayload.unknown_message || '';
  if (chatbotPayload.session_ttl_min !== undefined) updates['chatbot.session_ttl_min'] = String(chatbotPayload.session_ttl_min || 5);
  if (chatbotPayload.relay_device_id !== undefined) updates['chatbot.relay_device_id'] = chatbotPayload.relay_device_id || '';
  if (chatbotPayload.relay_door_num !== undefined) updates['chatbot.relay_door_num'] = String(chatbotPayload.relay_door_num || 1);
  if (chatbotPayload.relay_delay !== undefined) updates['chatbot.relay_delay'] = String(chatbotPayload.relay_delay || 5);
  if (chatbotPayload.support_phones !== undefined) updates['chatbot.support_phones'] = chatbotPayload.support_phones || '';
  if (chatbotPayload.support_forward_unknown !== undefined) updates['chatbot.support_forward_unknown'] = String(chatbotPayload.support_forward_unknown ?? false);
  if (chatbotPayload.debug_errors !== undefined) updates['chatbot.debug_errors'] = String(chatbotPayload.debug_errors ?? false);
  if (Object.prototype.hasOwnProperty.call(chatbotPayload, 'porteiro_token') && chatbotPayload.porteiro_token) {
    updates['chatbot.porteiro_token'] = chatbotPayload.porteiro_token;
  }
  if (chatbotPayload.flow !== undefined) {
    updates['chatbot.flow'] = typeof chatbotPayload.flow === 'string'
      ? chatbotPayload.flow
      : JSON.stringify(chatbotPayload.flow);
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
