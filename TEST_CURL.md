# Guia de Testes com cURL

## Testes Básicos

### 1. Health Check
```bash
curl http://localhost:3000/health
```

### 2. Status do WhatsApp
```bash
# Sem autenticação (se API_TOKEN não estiver configurado)
curl http://localhost:3000/status

# Com autenticação (se API_TOKEN estiver configurado)
curl -H "X-API-Token: seu-token-aqui" http://localhost:3000/status
```

### 3. QR Code (imagem PNG)
```bash
curl http://localhost:3000/qr.png -o qr.png
```

### 4. Trigger Snapshot (sem mensagem personalizada)
```bash
curl -X POST http://localhost:3000/trigger-snapshot \
  -H "Content-Type: application/json"
```

### 5. Trigger Snapshot (com mensagem personalizada)
```bash
curl -X POST http://localhost:3000/trigger-snapshot \
  -H "Content-Type: application/json" \
  -d '{"message": "🚨 Alerta de movimento detectado!"}'
```

## Testes no Servidor Remoto

### Substitua `localhost:3000` pelo IP/domínio do seu servidor:

```bash
# Exemplo com IP
curl -X POST http://10.10.0.100:3000/trigger-snapshot \
  -H "Content-Type: application/json" \
  -d '{"message": "Teste do ESP32"}'
```

## Testes com Verbose (para debug)

```bash
curl -v -X POST http://localhost:3000/trigger-snapshot \
  -H "Content-Type: application/json" \
  -d '{"message": "Teste com verbose"}'
```

## Resposta Esperada

### Sucesso:
```json
{
  "ok": true,
  "requestId": "abc123...",
  "total": 3,
  "success": 2,
  "failed": 1,
  "results": [
    {
      "phone": "+5511999999999",
      "success": true,
      "to": "5511999999999@c.us",
      "msgId": "3EB0..."
    },
    {
      "phone": "+5511888888888",
      "success": true,
      "to": "5511888888888@c.us",
      "msgId": "3EB1..."
    },
    {
      "phone": "+5511777777777",
      "success": false,
      "error": "not_on_whatsapp",
      "tried": ["+5511777777777", "+551177777777"]
    }
  ]
}
```

### Erro (WhatsApp não pronto):
```json
{
  "ok": false,
  "error": "whatsapp not ready",
  "requestId": "abc123..."
}
```

### Erro (Nenhum número no arquivo):
```json
{
  "ok": false,
  "error": "no numbers found in file",
  "requestId": "abc123..."
}
```

## Exemplo para ESP32 (Arduino/PlatformIO)

```cpp
#include <WiFi.h>
#include <HTTPClient.h>

void triggerSnapshot() {
  HTTPClient http;
  http.begin("http://10.10.0.100:3000/trigger-snapshot");
  http.addHeader("Content-Type", "application/json");
  
  String payload = "{\"message\":\"Alerta de movimento!\"}";
  int httpResponseCode = http.POST(payload);
  
  if (httpResponseCode > 0) {
    String response = http.getString();
    Serial.println("Resposta: " + response);
  } else {
    Serial.println("Erro na requisição");
  }
  
  http.end();
}
```

