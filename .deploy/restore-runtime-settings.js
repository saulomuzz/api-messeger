const sqlite3 = require('/opt/whatsapp-api/node_modules/sqlite3').verbose();
const sessionId = 'codex-settings-test';
const db = new sqlite3.Database('/opt/whatsapp-api/blocked_ips.db');

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

(async () => {
  const rows = [
    ['security.enable_ip_whitelist', 'false', 'boolean', 'security', 0, 'Ativa a whitelist principal para as rotas protegidas.'],
    ['security.ip_whitelist', '10.10.0.0/23 # IPs permitidos', 'multiline', 'security', 0, 'IPs ou CIDRs liberados nas rotas principais.'],
    ['security.global_ip_whitelist', '', 'multiline', 'security', 0, 'IPs ou CIDRs adicionais ignorados pela validação global.'],
    ['esp32.allowed_ips', '10.10.0.4\n10.10.0.0/23', 'multiline', 'esp32', 0, 'Lista de IPs ou CIDRs autorizados para ESP32 e WebSocket.'],
    ['whatsapp.require_signed_requests', 'false', 'boolean', 'whatsapp', 0, 'Obriga validação RSA nas rotas assinadas do WhatsApp.'],
    ['whatsapp.webhook_domain', 'api.biancavolken.com.br', 'string', 'whatsapp', 0, 'Domínio base usado para montar a URL de webhook do WhatsApp.']
  ];

  for (const row of rows) {
    await run(
      `INSERT INTO app_settings (key, value, value_type, category, is_secret, description, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, strftime('%s','now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         value_type = excluded.value_type,
         category = excluded.category,
         is_secret = excluded.is_secret,
         description = excluded.description,
         updated_at = excluded.updated_at`,
      row
    );
  }

  await run('DELETE FROM admin_sessions WHERE session_id = ?', [sessionId]);
  console.log('restore-ok');
  db.close();
})().catch((error) => {
  console.error(error);
  db.close();
  process.exit(1);
});
