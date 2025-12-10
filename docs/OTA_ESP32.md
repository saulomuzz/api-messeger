# OTA (Over-The-Air) para ESP32

## Visão Geral

Sistema de atualização de firmware sem necessidade de desmontar o dispositivo ou conectar via USB.

## Configuração do Servidor

### Endpoint OTA

O servidor expõe um endpoint para upload de firmware:

```
POST /esp32/ota
Headers:
  X-API-Token: seu_token_api
  Content-Type: multipart/form-data
Body:
  firmware: (arquivo .bin)
```

### Segurança

- Requer token de API válido
- Validação de IP (se configurado)
- Limite de tamanho de arquivo (padrão: 2MB)

## Implementação no ESP32

### Bibliotecas Necessárias

Adicione ao `platformio.ini`:
```ini
lib_deps =
  heltecautomation/Heltec ESP32 Dev-Boards @ ^1.1.0
  links2004/WebSockets @ ^2.4.1
  bblanchon/ArduinoJson @ ^6.21.3
```

### Código de Exemplo

```cpp
#include <ArduinoOTA.h>
#include <HTTPUpdate.h>
#include <WiFiClientSecure.h>

// Configuração OTA
const char* OTA_HOST = "seu-dominio.com.br";
const char* OTA_PATH = "/esp32/ota";
const char* OTA_TOKEN = "seu_token_api";

void setupOTA() {
  // Configura OTA via HTTP Update
  // Não usar ArduinoOTA (requer mDNS, mais complexo)
}

void checkOTAUpdate() {
  WiFiClientSecure client;
  client.setInsecure(); // Para desenvolvimento - use certificado em produção
  
  httpUpdate.setLedPin(LED, LOW);
  
  t_httpUpdate_return ret = httpUpdate.update(
    client,
    String("https://") + OTA_HOST + OTA_PATH,
    String("Bearer ") + OTA_TOKEN
  );
  
  switch (ret) {
    case HTTP_UPDATE_FAILED:
      Serial.printf("OTA falhou: %s\n", httpUpdate.getLastErrorString().c_str());
      break;
    case HTTP_UPDATE_NO_UPDATES:
      Serial.println("Nenhuma atualização disponível");
      break;
    case HTTP_UPDATE_OK:
      Serial.println("OTA concluído, reiniciando...");
      ESP.restart();
      break;
  }
}

void loop() {
  // Verifica atualização OTA a cada hora (ou quando solicitado)
  static unsigned long lastOTACheck = 0;
  if (millis() - lastOTACheck > 3600000) { // 1 hora
    lastOTACheck = millis();
    checkOTAUpdate();
  }
}
```

## Upload de Firmware

### Via API

```bash
curl -X POST https://seu-dominio.com/esp32/ota \
  -H "X-API-Token: seu_token" \
  -F "firmware=@firmware.bin"
```

### Via PlatformIO

Adicione script customizado ao `platformio.ini`:

```ini
[env:esp32doit-devkit-v1]
; ... outras configurações ...

extra_scripts = 
    scripts/ota_upload.py
```

Crie `scripts/ota_upload.py`:

```python
Import("env")
import requests

def upload_ota(source, target, env):
    firmware_path = str(source[0])
    api_url = "https://seu-dominio.com/esp32/ota"
    api_token = "seu_token"
    
    with open(firmware_path, 'rb') as f:
        files = {'firmware': f}
        headers = {'X-API-Token': api_token}
        response = requests.post(api_url, files=files, headers=headers)
        print(f"OTA Upload: {response.status_code} - {response.text}")

env.AddPostAction("buildprog", upload_ota)
```

## Endpoint OTA no Servidor

O endpoint será implementado no módulo `routes.js`:

```javascript
app.post('/esp32/ota', auth, async (req, res) => {
  // Valida token
  // Recebe arquivo .bin
  // Salva temporariamente
  // Retorna URL para download
  // ESP32 baixa e atualiza
});
```

## Segurança

1. **Autenticação**: Token obrigatório
2. **Validação de IP**: Whitelist configurável
3. **Tamanho máximo**: Limite de 2MB (configurável)
4. **Validação de arquivo**: Verifica extensão .bin
5. **Rate limiting**: Previne uploads excessivos

## Processo de Atualização

1. **Upload**: Firmware enviado para servidor
2. **Armazenamento**: Salvo temporariamente (24h)
3. **Notificação**: ESP32 verifica periodicamente ou recebe comando
4. **Download**: ESP32 baixa firmware
5. **Validação**: Verifica checksum (opcional)
6. **Instalação**: Atualiza partição OTA
7. **Reinício**: ESP32 reinicia com novo firmware

## Troubleshooting

### Upload falha

- Verifique tamanho do arquivo (máx 2MB)
- Confirme token de API
- Verifique logs do servidor

### ESP32 não atualiza

- Verifique conexão WiFi
- Confirme que partição OTA está configurada
- Verifique espaço disponível na flash
- Veja logs seriais do ESP32

### Firmware corrompido

- Refaça upload
- Verifique integridade do arquivo .bin
- Use checksum para validação

