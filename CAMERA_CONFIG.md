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

## Exemplo de Configuração Completa

```bash
# .env
PORT=3000
APP_ROOT=/opt/whatsapp-api
CAMERA_SNAPSHOT_URL=http://192.168.1.100/cgi-bin/snapshot.cgi?channel=1
CAMERA_USER=admin
CAMERA_PASS=sua_senha_aqui
NUMBERS_FILE=/opt/whatsapp-api/numbers.txt
DEBUG=false
```

## Teste Manual

Após configurar, teste com:
```bash
curl -X POST http://localhost:3000/trigger-snapshot \
  -H "Content-Type: application/json" \
  -d '{"message": "Teste"}'
```

