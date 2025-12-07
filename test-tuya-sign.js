#!/usr/bin/env node
/**
 * Script de teste para verificar a assinatura da API Tuya
 * 
 * Uso:
 *   node test-tuya-sign.js
 * 
 * Ou com variáveis de ambiente:
 *   TUYA_CLIENT_ID=xxx TUYA_CLIENT_SECRET=yyy node test-tuya-sign.js
 */

require('dotenv').config();
const crypto = require('crypto');

// Configuração
const CLIENT_ID = process.env.TUYA_CLIENT_ID || 'smu5nmy5cuueqvag5xty';
const CLIENT_SECRET = process.env.TUYA_CLIENT_SECRET || '8dc9e1576bb64b8c98bee0d4af2e8801';
const REGION = process.env.TUYA_REGION || 'us';

function generateTuyaSign(clientId, secret, timestamp, method, path, body = '') {
  const bodyStr = body || '';
  const bodyHash = crypto.createHash('sha256').update(bodyStr, 'utf8').digest('hex').toLowerCase();
  
  const stringToSign = method + '\n' + bodyHash + '\n\n' + path;
  const signStr = clientId + secret + timestamp + stringToSign;
  const sign = crypto.createHmac('sha256', secret).update(signStr, 'utf8').digest('hex').toUpperCase();
  
  return { sign, stringToSign, signStr: signStr.replace(secret, '***SECRET***') };
}

// Teste: Obter token
const timestamp = Date.now().toString();
const method = 'GET';
const path = '/v1.0/token?grant_type=1';

console.log('=== TESTE DE ASSINATURA TUYA ===\n');
console.log('Configuração:');
console.log(`CLIENT_ID: ${CLIENT_ID}`);
console.log(`CLIENT_SECRET: ${CLIENT_SECRET.substring(0, 10)}...${CLIENT_SECRET.substring(CLIENT_SECRET.length - 4)}`);
console.log(`REGION: ${REGION}`);
console.log(`\nTimestamp (atual): ${timestamp}`);
console.log(`Método: ${method}`);
console.log(`Path: ${path}`);

const result = generateTuyaSign(CLIENT_ID, CLIENT_SECRET, timestamp, method, path);

console.log(`\n--- Cálculo da Assinatura ---`);
console.log(`BodyHash (SHA256 de ""): e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`);
console.log(`\nStringToSign:`);
console.log(JSON.stringify(result.stringToSign));
console.log(`\nSignStr (com secret oculto):`);
console.log(result.signStr);
console.log(`\n✅ Assinatura gerada (HMAC-SHA256):`);
console.log(result.sign);

const baseUrl = `https://openapi.tuya${REGION === 'us' ? 'us' : REGION === 'eu' ? 'eu' : REGION === 'in' ? 'in' : 'cn'}.com`;
console.log(`\n=== COMANDO CURL PARA TESTAR (COPIE E EXECUTE) ===\n`);
console.log(`curl -X GET "${baseUrl}${path}" \\`);
console.log(`  -H "client_id: ${CLIENT_ID}" \\`);
console.log(`  -H "sign: ${result.sign}" \\`);
console.log(`  -H "t: ${timestamp}" \\`);
console.log(`  -H "sign_method: HMAC-SHA256"`);

console.log(`\n⚠️  IMPORTANTE: Execute o comando curl IMEDIATAMENTE após gerar!`);
console.log(`   O timestamp expira rapidamente. Se demorar, gere novamente.`);

// Teste automático se axios estiver disponível
try {
  const axios = require('axios');
  
  console.log(`\n=== TESTE AUTOMÁTICO ===\n`);
  console.log(`Fazendo requisição à API Tuya...\n`);
  
  axios.get(`${baseUrl}${path}`, {
    headers: {
      'client_id': CLIENT_ID,
      'sign': result.sign,
      't': timestamp,
      'sign_method': 'HMAC-SHA256'
    },
    timeout: 10000
  })
  .then(response => {
    console.log(`✅ SUCESSO! Resposta da API:`);
    console.log(JSON.stringify(response.data, null, 2));
    if (response.data.success && response.data.result) {
      console.log(`\n🎉 Access Token obtido com sucesso!`);
      console.log(`Token: ${response.data.result.access_token.substring(0, 30)}...`);
      console.log(`Expira em: ${response.data.result.expire_time} segundos (${Math.floor(response.data.result.expire_time / 60)} minutos)`);
      console.log(`\n✅ A autenticação está funcionando corretamente!`);
      console.log(`✅ As credenciais estão corretas!`);
    } else {
      console.log(`\n⚠️  Resposta recebida mas não contém token. Verifique a resposta acima.`);
    }
  })
  .catch(error => {
    console.log(`❌ ERRO na requisição:`);
    if (error.response) {
      console.log(`Status: ${error.response.status}`);
      console.log(`Resposta:`, JSON.stringify(error.response.data, null, 2));
      
      if (error.response.data.code === 1004) {
        console.log(`\n❌ Erro "sign invalid" (1004) - A assinatura foi rejeitada.`);
        console.log(`\n🔍 O formato da assinatura está correto, mas a Tuya está rejeitando.`);
        console.log(`   Isso indica que o problema está nas CREDENCIAIS ou REGIÃO.`);
        console.log(`\n📋 CHECKLIST DE VERIFICAÇÃO:`);
        console.log(`\n   1️⃣  Verifique TUYA_CLIENT_ID:`);
        console.log(`      - Acesse: https://iot.tuya.com/`);
        console.log(`      - Vá no seu projeto > Overview`);
        console.log(`      - Compare "Access ID" com: ${CLIENT_ID}`);
        console.log(`      - Devem ser EXATAMENTE iguais (sem espaços)`);
        console.log(`\n   2️⃣  Verifique TUYA_CLIENT_SECRET:`);
        console.log(`      - Na mesma página, clique no ícone do olho para revelar`);
        console.log(`      - Compare "Access Secret" completo com o .env`);
        console.log(`      - Deve ter 32 caracteres hexadecimais`);
        console.log(`      - Devem ser EXATAMENTE iguais (sem espaços)`);
        console.log(`\n   3️⃣  Verifique TUYA_REGION:`);
        console.log(`      - Na página Overview, veja "Data Center"`);
        console.log(`      - Atual no .env: ${REGION}`);
        console.log(`      - Mapeamento:`);
        console.log(`        • Western America Data Center → us`);
        console.log(`        • Eastern America Data Center → us`);
        console.log(`        • Central Europe Data Center → eu`);
        console.log(`        • Western Europe Data Center → eu`);
        console.log(`        • China Data Center → cn`);
        console.log(`        • India Data Center → in`);
        console.log(`\n   4️⃣  Após corrigir, teste novamente com:`);
        console.log(`      node test-tuya-sign.js`);
        console.log(`\n📄 Consulte também: VERIFICACAO_CREDENCIAIS.md`);
      } else if (error.response.data.code === 1013) {
        console.log(`\n⚠️  Erro "request time is invalid" (1013)`);
        console.log(`   O timestamp expirou. Execute o script novamente.`);
      }
    } else {
      console.log(`Erro de conexão: ${error.message}`);
    }
    process.exit(1);
  });
} catch (e) {
  // axios não disponível, apenas mostra o comando curl
  console.log(`\n💡 Dica: Para teste automático, instale axios: npm install axios`);
}
