# Configuração da Câmera IP

## Variáveis de Ambiente

Configure no arquivo `.env` ou nas variáveis de ambiente do sistema:

```bash
# URL da câmera (sem credenciais na URL)
CAMERA_SNAPSHOT_URL=http://192.168.1.100/cgi-bin/snapshot.cgi?channel=1

# Credenciais separadas (recomendado)
CAMERA_USER=admin
CAMERA_PASS=sua_senha_aqui

# OU use URL completa com credenciais (alternativa)
# CAMERA_SNAPSHOT_URL=http://admin:senha@192.168.1.100/cgi-bin/snapshot.cgi?channel=1
```

## Troubleshooting - Erro 401

Se você receber erro 401 (não autorizado), verifique:

### 1. Credenciais Corretas
```bash
# Teste a URL diretamente no navegador ou curl
curl -u admin:senha http://192.168.1.100/cgi-bin/snapshot.cgi?channel=1 -o test.jpg
```

### 2. Formato da URL
- ✅ Correto: `http://192.168.1.100/cgi-bin/snapshot.cgi?channel=1`
- ❌ Evite: `http://admin:pass@192.168.1.100/...` (use variáveis separadas)

### 3. Câmeras que Requerem Autenticação Digest

Algumas câmeras IP usam autenticação Digest em vez de Basic. Se o erro 401 persistir:

1. Verifique a documentação da câmera
2. Teste manualmente com curl usando digest:
```bash
curl --digest -u admin:senha http://192.168.1.100/cgi-bin/snapshot.cgi?channel=1 -o test.jpg
```

### 4. Verificar Acessibilidade da Câmera

```bash
# Ping
ping 192.168.1.100

# Teste HTTP básico
curl -v http://192.168.1.100/cgi-bin/snapshot.cgi?channel=1
```

### 5. Logs Detalhados

Ative o modo DEBUG no `.env`:
```bash
DEBUG=true
```

Isso mostrará mais detalhes sobre a requisição HTTP.

## Configuração de Vídeo

### Parâmetros de Gravação e Compressão

Todas as configurações de vídeo podem ser ajustadas via variáveis de ambiente:

```bash
# Tamanho máximo do vídeo antes de comprimir (WhatsApp aceita até ~16MB)
MAX_VIDEO_SIZE_MB=8

# Tamanho máximo permitido pela API do WhatsApp (padrão: 16MB)
# Se o vídeo exceder este tamanho, será dividido automaticamente em partes
WHATSAPP_MAX_VIDEO_SIZE_MB=16

# CRF (Constant Rate Factor) - Qualidade do vídeo (0-51)
# Menor = melhor qualidade, maior arquivo
# Recomendado: 18-23 para qualidade muito boa
# Padrão: 23
VIDEO_CRF=23

# Preset FFmpeg - Velocidade de codificação vs qualidade
# Opções: ultrafast, fast, medium, slow, slower, veryslow
# Padrão: medium (bom equilíbrio)
VIDEO_PRESET=medium

# Perfil H.264 - Compatibilidade vs qualidade
# Opções: baseline (mais compatível), main, high (melhor qualidade)
# Padrão: high
VIDEO_PROFILE=high

# Nível H.264 - Limites de recursos
# Opções: 3.0, 3.1, 4.0, 4.1, etc
# Padrão: 4.0
VIDEO_LEVEL=4.0

# Bitrate máximo do vídeo
# Exemplos: 2M, 3M, 4M, 5M
# Padrão: 3M
VIDEO_MAXRATE=3M

# Tamanho do buffer de vídeo
# Deve ser ~2x o maxrate
# Padrão: 6M
VIDEO_BUFSIZE=6M

# GOP (Group of Pictures) size
# Valores maiores = melhor compressão, mas menos precisão em mudanças rápidas
# Padrão: 60
VIDEO_GOP=60

# Resolução máxima do vídeo
# Padrão: 1920x1080 (Full HD)
VIDEO_MAX_WIDTH=1920
VIDEO_MAX_HEIGHT=1080

# Bitrate de áudio
# Exemplos: 96k, 128k, 192k
# Padrão: 128k
VIDEO_AUDIO_BITRATE=128k
```

### Exemplos de Configuração

**Qualidade Máxima (arquivos maiores):**
```bash
VIDEO_CRF=18
VIDEO_PRESET=slow
VIDEO_PROFILE=high
VIDEO_LEVEL=4.0
VIDEO_MAXRATE=5M
VIDEO_BUFSIZE=10M
VIDEO_GOP=60
```

**Qualidade Balanceada (recomendado):**
```bash
VIDEO_CRF=23
VIDEO_PRESET=medium
VIDEO_PROFILE=high
VIDEO_LEVEL=4.0
VIDEO_MAXRATE=3M
VIDEO_BUFSIZE=6M
VIDEO_GOP=60
```

**Arquivos Menores (mais compressão):**
```bash
VIDEO_CRF=28
VIDEO_PRESET=fast
VIDEO_PROFILE=main
VIDEO_LEVEL=3.1
VIDEO_MAXRATE=2M
VIDEO_BUFSIZE=4M
VIDEO_GOP=30
```

## Exemplo de Configuração Completa

```bash
# .env
PORT=3000
APP_ROOT=/opt/whatsapp-api
CAMERA_SNAPSHOT_URL=http://192.168.1.100/cgi-bin/snapshot.cgi?channel=1
CAMERA_USER=admin
CAMERA_PASS=sua_senha_aqui
CAMERA_RTSP_URL=rtsp://admin:senha@192.168.1.100:554/stream1
NUMBERS_FILE=/opt/whatsapp-api/numbers.txt
DEBUG=false

# Configurações de vídeo (opcional - usa padrões se não especificado)
MAX_VIDEO_SIZE_MB=8
VIDEO_CRF=23
VIDEO_PRESET=medium
VIDEO_PROFILE=high
VIDEO_LEVEL=4.0
VIDEO_MAXRATE=3M
VIDEO_BUFSIZE=6M
VIDEO_GOP=60
VIDEO_MAX_WIDTH=1920
VIDEO_MAX_HEIGHT=1080
VIDEO_AUDIO_BITRATE=128k
```

## Teste Manual

Após configurar, teste com:
```bash
curl -X POST http://localhost:3000/trigger-snapshot \
  -H "Content-Type: application/json" \
  -d '{"message": "Teste"}'
```

