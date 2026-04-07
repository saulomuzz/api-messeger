const sqlite3 = require('/opt/whatsapp-api/node_modules/sqlite3').verbose();
const db = new sqlite3.Database('/opt/whatsapp-api/blocked_ips.db');
db.run('DELETE FROM admin_sessions WHERE session_id = ?', ['codex-settings-test'], (err) => {
  if (err) {
    console.error(err.message);
    process.exit(1);
  }
  console.log('cleanup-ok');
  db.close();
});
