const sqlite3 = require('/opt/whatsapp-api/node_modules/sqlite3').verbose();
const db = new sqlite3.Database('/opt/whatsapp-api/blocked_ips.db');
const axios = require('/opt/whatsapp-api/node_modules/axios');

function getSetting(key) {
  return new Promise((resolve, reject) => {
    db.get('SELECT value FROM app_settings WHERE key = ?', [key], (err, row) => {
      if (err) return reject(err);
      resolve(row ? row.value : '');
    });
  });
}

(async () => {
  const accessToken = String(await getSetting('whatsapp.access_token') || '').trim();
  const phoneNumberId = String(await getSetting('whatsapp.phone_number_id') || '').trim();
  const apiVersion = String(await getSetting('whatsapp.api_version') || 'v21.0').trim();
  const base = `https://graph.facebook.com/${apiVersion}`;
  const headers = { Authorization: `Bearer ${accessToken}` };

  const attempts = [
    { name: 'me', url: `${base}/me`, params: { fields: 'id,name' } },
    { name: 'me_businesses', url: `${base}/me/businesses`, params: { fields: 'id,name' } },
    { name: 'me_accounts', url: `${base}/me/accounts`, params: { fields: 'id,name' } },
    { name: 'phone_basic', url: `${base}/${phoneNumberId}`, params: { fields: 'id,display_phone_number,verified_name' } },
    { name: 'phone_waba_candidate', url: `${base}/${phoneNumberId}`, params: { fields: 'id,display_phone_number,verified_name,account_mode,name_status,quality_rating' } }
  ];

  for (const attempt of attempts) {
    try {
      const response = await axios.get(attempt.url, { headers, params: attempt.params, timeout: 15000 });
      console.log(attempt.name, JSON.stringify(response.data));
    } catch (error) {
      const payload = error.response?.data || { message: error.message };
      console.log(attempt.name, JSON.stringify(payload));
    }
  }

  db.close();
})().catch((error) => {
  console.error(error);
  db.close();
  process.exit(1);
});
