# WebSocket ESP32 - Guia de Implementação

## Visão Geral

O sistema foi atualizado para suportar comunicação via WebSocket entre o ESP32 e a API, oferecendo:
- **Comunicação mais rápida**: Conexão persistente elimina overhead de handshake SSL/TLS
- **Menor latência**: Mensagens instantâneas sem necessidade de estabelecer nova conexão
- **Melhor eficiência**: Reduz uso de recursos e bateria no ESP32

## Configuração do Servidor

O servidor WebSocket está disponível em: `wss://seu-dominio.com/ws/esp32`

### Autenticação

O ESP32 deve enviar uma mensagem de autenticação na primeira conexão:

```json
{
  "type": "auth",
  "token": "seu_token_esp32"
}
```

Resposta de sucesso:
```json
{
  "type": "auth_success",
  "message": "Autenticado com sucesso",
  "timestamp": 1234567890
}
```

## Protocolo de Mensagens

### Mensagens do ESP32 para o Servidor

#### 1. Ping (manter conexão viva)
```json
{
  "type": "ping"
}
```

#### 2. Verificar Status da API
```json
{
  "type": "check_status"
}
```

Resposta:
```json
{
  "type": "status",
  "ready": true,
  "timestamp": 1234567890
}
```

#### 3. Disparar Snapshot
```json
{
  "type": "trigger_snapshot",
  "message": "*Campainha Tocando*"
}
```

Resposta imediata (acknowledgment):
```json
{
  "type": "snapshot_ack",
  "message": "Snapshot em processamento",
  "timestamp": 1234567890
}
```

Resposta final (quando processamento terminar):
```json
{
  "type": "snapshot_result",
  "success": true,
  "message": "Snapshot enviado com sucesso"
}
```

### Mensagens do Servidor para o ESP32

#### 1. Pong (resposta ao ping)
```json
{
  "type": "pong",
  "timestamp": 1234567890
}
```

#### 2. Connected (ao conectar)
```json
{
  "type": "connected",
  "message": "Conectado ao servidor WebSocket",
  "requiresAuth": true,
  "timestamp": 1234567890
}
```

#### 3. Error
```json
{
  "type": "error",
  "message": "Descrição do erro",
  "timestamp": 1234567890
}
```

## Implementação no ESP32

### Bibliotecas Necessárias

Adicione ao `platformio.ini`:
```ini
lib_deps =
  heltecautomation/Heltec ESP32 Dev-Boards @ ^1.1.0
  links2004/WebSockets @ ^2.4.1
  bblanchon/ArduinoJson @ ^6.21.3
```

### Exemplo de Código

```cpp
#include <WebSocketsClient.h>
#include <ArduinoJson.h>

WebSocketsClient webSocket;

void webSocketEvent(WStype_t type, uint8_t * payload, size_t length) {
  switch(type) {
    case WStype_DISCONNECTED:
      Serial.println("[WS] Desconectado");
      break;
      
    case WStype_CONNECTED:
      Serial.println("[WS] Conectado");
      // Envia autenticação
      {
        StaticJsonDocument<200> doc;
        doc["type"] = "auth";
        doc["token"] = ESP32_TOKEN;
        String authMsg;
        serializeJson(doc, authMsg);
        webSocket.sendTXT(authMsg);
      }
      break;
      
    case WStype_TEXT:
      {
        StaticJsonDocument<512> doc;
        deserializeJson(doc, payload);
        String msgType = doc["type"];
        
        if (msgType == "auth_success") {
          Serial.println("[WS] Autenticado com sucesso");
        } else if (msgType == "status") {
          bool ready = doc["ready"];
          Serial.printf("[WS] API Status: %s\n", ready ? "Pronto" : "Não pronto");
        } else if (msgType == "snapshot_result") {
          bool success = doc["success"];
          Serial.printf("[WS] Snapshot: %s\n", success ? "Sucesso" : "Falha");
        } else if (msgType == "pong") {
          // Resposta ao ping
        }
      }
      break;
  }
}

void setup() {
  // ... código de inicialização ...
  
  // Conecta WebSocket
  String wsUrl = String(SERVER_URL).substring(8); // Remove "https://"
  webSocket.beginSSL(wsUrl, 443, "/ws/esp32");
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(5000);
}

void loop() {
  webSocket.loop();
  
  // Envia ping a cada 30 segundos
  static unsigned long lastPing = 0;
  if (millis() - lastPing > 30000) {
    lastPing = millis();
    StaticJsonDocument<100> doc;
    doc["type"] = "ping";
    String pingMsg;
    serializeJson(doc, pingMsg);
    webSocket.sendTXT(pingMsg);
  }
  
  // Detecta trigger e envia snapshot
  if (triggerDetected) {
    StaticJsonDocument<200> doc;
    doc["type"] = "trigger_snapshot";
    doc["message"] = snapshotMessage;
    String triggerMsg;
    serializeJson(doc, triggerMsg);
    webSocket.sendTXT(triggerMsg);
  }
}
```

## Migração de HTTP para WebSocket

### Vantagens

1. **Velocidade**: Comunicação instantânea sem overhead de conexão
2. **Eficiência**: Menor uso de recursos (CPU, memória, rede)
3. **Confiabilidade**: Reconexão automática em caso de queda
4. **Bidirecional**: Servidor pode enviar comandos para o ESP32

### Compatibilidade

O sistema mantém compatibilidade com HTTP para transição gradual:
- Endpoints HTTP continuam funcionando
- WebSocket é opcional
- Pode usar ambos simultaneamente durante migração

## Troubleshooting

### Conexão não estabelece

1. Verifique se o servidor está rodando
2. Confirme que a URL está correta (wss:// para SSL)
3. Verifique firewall/proxy
4. Confirme que o token está correto

### Autenticação falha

1. Verifique `ESP32_TOKEN` no servidor
2. Confirme que o token enviado está correto
3. Verifique logs do servidor para detalhes

### Mensagens não chegam

1. Verifique se está autenticado (deve receber `auth_success`)
2. Confirme formato JSON correto
3. Verifique tamanho da mensagem (limite de 512 bytes recomendado)

