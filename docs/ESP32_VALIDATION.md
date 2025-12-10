# Validação de Autorização ESP32

O ESP32 pode verificar se está autorizado antes de enviar o snapshot usando o endpoint de validação.

## Endpoint de Validação

**GET** `/esp32/validate`

Verifica se o ESP32 está autorizado (token e/ou IP) sem fazer o processamento completo do snapshot.

## Uso no ESP32

### Exemplo Completo (Arduino/PlatformIO)

```cpp
#include <WiFi.h>
#include <HTTPClient.h>

const char* ssid = "SEU_WIFI";
const char* password = "SUA_SENHA";
const char* serverUrl = "https://seu-servidor.com.br";
const char* esp32Token = "seu_token_secreto_aqui";

bool validateAuthorization() {
  HTTPClient http;
  http.begin(String(serverUrl) + "/esp32/validate");
  http.addHeader("X-ESP32-Token", esp32Token);
  
  int httpResponseCode = http.GET();
  
  if (httpResponseCode > 0) {
    String response = http.getString();
    Serial.println("Resposta de validação: " + response);
    
    // Verifica se está autorizado
    if (response.indexOf("\"authorized\":true") > 0) {
      http.end();
      return true;
    }
  } else {
    Serial.println("Erro na validação: " + String(httpResponseCode));
  }
  
  http.end();
  return false;
}

void triggerSnapshot() {
  // Primeiro valida a autorização
  if (!validateAuthorization()) {
    Serial.println("ESP32 não autorizado! Abortando...");
    return;
  }
  
  Serial.println("ESP32 autorizado! Enviando snapshot...");
  
  // Agora envia o snapshot
  HTTPClient http;
  http.begin(String(serverUrl) + "/trigger-snapshot");
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-ESP32-Token", esp32Token);
  
  String payload = "{\"message\":\"Alerta de movimento!\"}";
  int httpResponseCode = http.POST(payload);
  
  if (httpResponseCode > 0) {
    String response = http.getString();
    Serial.println("Resposta: " + response);
  } else {
    Serial.println("Erro: " + String(httpResponseCode));
  }
  
  http.end();
}

void setup() {
  Serial.begin(115200);
  WiFi.begin(ssid, password);
  
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  
  Serial.println("\nWiFi conectado!");
  Serial.println("IP: " + WiFi.localIP().toString());
}

void loop() {
  // Exemplo: validar e enviar a cada 60 segundos
  triggerSnapshot();
  delay(60000);
}
```

## Respostas do Endpoint

### Autorizado (200 OK):
```json
{
  "ok": true,
  "authorized": true,
  "message": "ESP32 autorizado",
  "ip": "10.10.0.4",
  "checks": {
    "ip": {
      "passed": true,
      "message": "IP 10.10.0.4 autorizado"
    },
    "token": {
      "passed": true,
      "message": "Token válido"
    }
  },
  "timestamp": "2025-12-01T18:00:00.000Z"
}
```

### Não Autorizado - Token Inválido (401):
```json
{
  "ok": false,
  "authorized": false,
  "error": "invalid_token",
  "message": "Token inválido ou não fornecido",
  "ip": "10.10.0.4",
  "checks": {
    "ip": {
      "passed": true,
      "message": "IP 10.10.0.4 autorizado"
    },
    "token": {
      "passed": false,
      "message": "Token inválido ou não fornecido"
    }
  },
  "timestamp": "2025-12-01T18:00:00.000Z"
}
```

### Não Autorizado - IP Bloqueado (401):
```json
{
  "ok": false,
  "authorized": false,
  "error": "ip_not_allowed",
  "message": "IP 192.168.1.100 não está na whitelist. Permitidos: 10.10.0.4",
  "ip": "192.168.1.100",
  "checks": {
    "ip": {
      "passed": false,
      "message": "IP 192.168.1.100 não está na whitelist. Permitidos: 10.10.0.4"
    },
    "token": {
      "passed": true,
      "message": "Token válido"
    }
  },
  "timestamp": "2025-12-01T18:00:00.000Z"
}
```

## Teste com cURL

```bash
# Validação com token no header
curl -X GET https://seu-servidor.com.br/esp32/validate \
  -H "X-ESP32-Token: seu_token_secreto_aqui"

# Validação com token na query string
curl -X GET "https://seu-servidor.com.br/esp32/validate?token=seu_token_secreto_aqui"
```

## Vantagens

1. **Economia de recursos**: O ESP32 não precisa fazer o processamento completo se não estiver autorizado
2. **Feedback rápido**: Descobre imediatamente se há problema de autorização
3. **Debug facilitado**: Pode verificar autorização sem enviar snapshot
4. **Monitoramento**: Pode validar periodicamente se ainda está autorizado

## Configuração no Servidor

No arquivo `.env`:

```bash
# Token obrigatório
ESP32_TOKEN=seu_token_secreto_aqui

# Whitelist de IPs (opcional)
ESP32_ALLOWED_IPS=10.10.0.4,10.10.0.0/24
```

