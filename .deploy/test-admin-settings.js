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
  console.log('GET', JSON.stringify(getData));

  const payload = { settings: getData.settings || {} };
  const postResponse = await fetch('http://127.0.0.1:3000/admin/api/settings', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
  const postData = await postResponse.json();
  console.log('POST', JSON.stringify(postData));

  const saved = await all("SELECT key, value, category FROM app_settings WHERE category = 'admin' ORDER BY key");
  console.log('DB', JSON.stringify(saved));

  db.close();
})().catch((error) => {
  console.error(error);
  db.close();
  process.exit(1);
});
