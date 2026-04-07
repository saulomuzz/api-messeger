const sqlite3 = require('/opt/whatsapp-api/node_modules/sqlite3').verbose();
const sessionId = 'codex-wa-test';
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

  const headers = { Cookie: `admin_session=${sessionId}` };
  const configResponse = await fetch('http://127.0.0.1:3000/admin/api/whatsapp/config', { headers });
  const configData = await configResponse.json();
  console.log('CONFIG', JSON.stringify(configData));

  const templatesResponse = await fetch('http://127.0.0.1:3000/admin/api/whatsapp/templates?limit=10', { headers });
  const templatesData = await templatesResponse.json();
  console.log('TEMPLATES', JSON.stringify({ success: templatesData.success, count: (templatesData.templates || []).length, sample: (templatesData.templates || []).slice(0, 3).map(t => ({ name: t.name, status: t.status, category: t.category, language: t.language })) }));

  await run('DELETE FROM admin_sessions WHERE session_id = ?', [sessionId]);
  db.close();
})().catch((error) => {
  console.error(error);
  db.close();
  process.exit(1);
});
