const sqlite3 = require('/opt/whatsapp-api/node_modules/sqlite3').verbose();
const sessionId = 'codex-settings-test';
const db = new sqlite3.Database('/opt/whatsapp-api/blocked_ips.db');
const now = Math.floor(Date.now() / 1000);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

(async () => {
  await run(
    `INSERT OR REPLACE INTO admin_sessions (session_id, phone, device_fingerprint, device_name, ip_address, user_agent, trusted_until, created_at, expires_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, 'codex-test', 'codex-fp', 'Codex Session', '127.0.0.1', 'codex', null, now, now + 3600, now]
  );

  const headers = { Cookie: `admin_session=${sessionId}`, 'Content-Type': 'application/json' };

  const getResponse = await fetch('http://127.0.0.1:3000/admin/api/settings', { headers });
  const getData = await getResponse.json();
  console.log('GET', JSON.stringify({
    success: getData.success,
    sample: {
      enableIpWhitelist: getData.settings?.enableIpWhitelist,
      requireSignedRequests: getData.settings?.requireSignedRequests,
      whatsappWebhookDomain: getData.settings?.whatsappWebhookDomain,
      ipWhitelist: getData.settings?.ipWhitelist,
      globalIpWhitelist: getData.settings?.globalIpWhitelist,
      esp32AllowedIps: getData.settings?.esp32AllowedIps
    }
  }));

  const payload = {
    settings: {
      ...getData.settings,
      enableIpWhitelist: true,
      requireSignedRequests: false,
      whatsappWebhookDomain: getData.settings?.whatsappWebhookDomain || 'wpp-api.muzzolon.com.br',
      ipWhitelist: '10.10.0.3\n127.0.0.1',
      globalIpWhitelist: '127.0.0.1\n10.10.0.0/24',
      esp32AllowedIps: '10.10.0.3\n10.10.0.4'
    }
  };

  const postResponse = await fetch('http://127.0.0.1:3000/admin/api/settings', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
  const postData = await postResponse.json();
  console.log('POST', JSON.stringify({ success: postData.success, sample: {
    enableIpWhitelist: postData.settings?.enableIpWhitelist,
    requireSignedRequests: postData.settings?.requireSignedRequests,
    whatsappWebhookDomain: postData.settings?.whatsappWebhookDomain
  }}));

  const saved = await all("SELECT key, value, category FROM app_settings WHERE key IN ('security.enable_ip_whitelist','security.ip_whitelist','security.global_ip_whitelist','esp32.allowed_ips','whatsapp.require_signed_requests','whatsapp.webhook_domain') ORDER BY key");
  console.log('DB', JSON.stringify(saved));

  db.close();
})().catch((error) => {
  console.error(error);
  db.close();
  process.exit(1);
});
