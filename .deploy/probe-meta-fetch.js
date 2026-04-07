const sqlite3 = require('/opt/whatsapp-api/node_modules/sqlite3').verbose();
const db = new sqlite3.Database('/opt/whatsapp-api/blocked_ips.db');

function getSetting(key) {
  return new Promise((resolve, reject) => {
    db.get('SELECT value FROM app_settings WHERE key = ?', [key], (err, row) => {
      if (err) return reject(err);
      resolve(row ? row.value : '');
    });
  });
}

async function call(url, token) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { raw: text, status: response.status }; }
}

(async () => {
  const accessToken = String(await getSetting('whatsapp.access_token') || '').trim();
  const phoneNumberId = String(await getSetting('whatsapp.phone_number_id') || '').trim();
  const apiVersion = String(await getSetting('whatsapp.api_version') || 'v21.0').trim();
  const base = `https://graph.facebook.com/${apiVersion}`;

  const attempts = [
    { name: 'me', url: `${base}/me?fields=id,name` },
    { name: 'me_businesses', url: `${base}/me/businesses?fields=id,name` },
    { name: 'me_accounts', url: `${base}/me/accounts?fields=id,name` },
    { name: 'phone_basic', url: `${base}/${phoneNumberId}?fields=id,display_phone_number,verified_name` },
    { name: 'phone_extra', url: `${base}/${phoneNumberId}?fields=id,display_phone_number,verified_name,account_mode,name_status,quality_rating` }
  ];

  for (const attempt of attempts) {
    try {
      const data = await call(attempt.url, accessToken);
      console.log(attempt.name, JSON.stringify(data));
    } catch (error) {
      console.log(attempt.name, JSON.stringify({ message: error.message }));
    }
  }

  db.close();
})().catch((error) => {
  console.error(error);
  db.close();
  process.exit(1);
});
