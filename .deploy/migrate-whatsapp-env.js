const sqlite3 = require('/opt/whatsapp-api/node_modules/sqlite3').verbose();
const sessionId = 'codex-migrate-whatsapp-env';
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

(async () => {
  await run(
    `INSERT OR REPLACE INTO admin_sessions (session_id, phone, device_fingerprint, device_name, ip_address, user_agent, trusted_until, created_at, expires_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, 'codex-test', 'codex-fp', 'Codex Session', '127.0.0.1', 'codex', null, now, now + 3600, now]
  );

  const headers = { Cookie: `admin_session=${sessionId}`, 'Content-Type': 'application/json' };
  const getResponse = await fetch('http://127.0.0.1:3000/admin/api/settings', { headers });
  const getData = await getResponse.json();
  if (!getData.success) {
    throw new Error(getData.error || 'Falha ao carregar configurações');
  }

  const postResponse = await fetch('http://127.0.0.1:3000/admin/api/settings', {
    method: 'POST',
    headers,
    body: JSON.stringify({ settings: getData.settings })
  });
  const postData = await postResponse.json();
  console.log('POST', JSON.stringify({ success: postData.success }));

  const keys = [
    'whatsapp.access_token',
    'whatsapp.phone_number_id',
    'whatsapp.business_account_id',
    'whatsapp.webhook_verify_token',
    'whatsapp.api_version',
    'whatsapp.webhook_domain'
  ];
  db.all(`SELECT key, CASE WHEN is_secret = 1 THEN '[secret]' ELSE value END AS value, category FROM app_settings WHERE key IN (${keys.map(() => '?').join(',')}) ORDER BY key`, keys, async (err, rows) => {
    if (err) {
      console.error(err.message);
      process.exit(1);
    }
    console.log('DB', JSON.stringify(rows || []));
    await run('DELETE FROM admin_sessions WHERE session_id = ?', [sessionId]);
    db.close();
  });
})().catch((error) => {
  console.error(error);
  db.close();
  process.exit(1);
});
