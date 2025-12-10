# Correções Necessárias no .env

## ❌ Problemas Encontrados

1. **`REQUIRE_SIGNED_REQUESTS` duplicado:**
   - Linha 9: `REQUIRE_SIGNED_REQUESTS=false`
   - Linha 15: `REQUIRE_SIGNED_REQUESTS=true` ⚠️ **CONFLITO!**

2. **`ESP32_ALLOWED_IPS` duplicado:**
   - Linha 25: `ESP32_ALLOWED_IPS=192.168.1.42`
   - Linha 30: `ESP32_ALLOWED_IPS=192.168.1.100,192.168.1.0/24` ⚠️ **CONFLITO!**

3. **Espaço antes de `REQUIRE_SIGNED_REQUESTS`:**
   - Linha 9 tem um espaço: ` REQUIRE_SIGNED_REQUESTS=false` ⚠️ **ERRO!**

4. **Comentários desnecessários e organização**

## ✅ Versão Otimizada

Use o arquivo `.env.otimizado` como referência ou faça estas correções:

### 1. Remova a duplicata de `REQUIRE_SIGNED_REQUESTS`

**Mantenha apenas:**
```env
REQUIRE_SIGNED_REQUESTS=false
```

**Remova:**
- A linha 9 com espaço: ` REQUIRE_SIGNED_REQUESTS=false`
- A linha 15: `REQUIRE_SIGNED_REQUESTS=true`

### 2. Remova a duplicata de `ESP32_ALLOWED_IPS`

**Mantenha apenas:**
```env
ESP32_ALLOWED_IPS=192.168.1.100,192.168.1.0/24
```

**Remova:**
- A linha 25: `ESP32_ALLOWED_IPS=192.168.1.42`

### 3. Adicione `WHATSAPP_API_VERSION` (opcional)

```env
WHATSAPP_API_VERSION=v21.0
```

## 📋 Checklist de Correção

- [ ] Remover espaço antes de `REQUIRE_SIGNED_REQUESTS` na linha 9
- [ ] Remover linha duplicada `REQUIRE_SIGNED_REQUESTS=true` (linha 15)
- [ ] Manter apenas `REQUIRE_SIGNED_REQUESTS=false`
- [ ] Remover `ESP32_ALLOWED_IPS=192.168.1.42` (linha 25)
- [ ] Manter apenas `ESP32_ALLOWED_IPS=192.168.1.100,192.168.1.0/24`
- [ ] Adicionar `WHATSAPP_API_VERSION=v21.0` (opcional)

## 🚀 Após Correções

1. Salve o arquivo `.env`
2. Reinicie o serviço: `node src/app.js`
3. Teste o envio de mensagens

## 📝 Versão Final Recomendada

Veja o arquivo `.env.otimizado` para a versão completa e organizada!

