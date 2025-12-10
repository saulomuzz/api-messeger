# Verificar e Iniciar Servidor Node.js

## Problema

O erro `Connection refused` indica que o servidor Node.js não está rodando na porta 3000.

## Verificação

### 1. Verificar se o servidor está rodando

```bash
# No servidor onde roda o app.js
ps aux | grep node
# ou
systemctl status api-messeger  # se usar systemd
```

### 2. Verificar se a porta 3000 está em uso

```bash
# No servidor onde roda o app.js
netstat -tlnp | grep 3000
# ou
ss -tlnp | grep 3000
# ou
lsof -i :3000
```

### 3. Verificar se o WebSocket está configurado

O servidor precisa estar rodando e o módulo WebSocket precisa estar inicializado.

## Iniciar o Servidor

### Opção 1: Manualmente

```bash
# No servidor onde roda o app.js
cd /opt/whatsapp-api  # ou onde está o projeto
npm start
# ou
node src/app.js
```

### Opção 2: Com PM2 (recomendado)

```bash
# Instalar PM2 se não tiver
npm install -g pm2

# Iniciar aplicação
pm2 start src/app.js --name api-messeger

# Ver status
pm2 status

# Ver logs
pm2 logs api-messeger

# Configurar para iniciar automaticamente
pm2 startup
pm2 save
```

### Opção 3: Com systemd

Crie um serviço systemd:

```bash
sudo nano /etc/systemd/system/api-messeger.service
```

Conteúdo:

```ini
[Unit]
Description=API WhatsApp Messenger
After=network.target

[Service]
Type=simple
User=seu-usuario
WorkingDirectory=/opt/whatsapp-api
Environment="NODE_ENV=production"
Environment="PORT=3000"
ExecStart=/usr/bin/node /opt/whatsapp-api/src/app.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Depois:

```bash
sudo systemctl daemon-reload
sudo systemctl enable api-messeger
sudo systemctl start api-messeger
sudo systemctl status api-messeger
```

## Verificar Logs

### Se usar PM2:
```bash
pm2 logs api-messeger
```

### Se usar systemd:
```bash
sudo journalctl -u api-messeger -f
```

### Se rodar manualmente:
Os logs aparecem no terminal onde você iniciou.

## Verificar se WebSocket está funcionando

Após iniciar o servidor, você deve ver nos logs:

```
[WS-ESP32] Servidor WebSocket inicializado em /ws/esp32
```

## Testar Conexão

### Do servidor nginx:
```bash
curl http://10.0.0.10:3000/health
```

### Do servidor nginx proxy:
```bash
curl http://10.0.0.10:3000/health
```

Deve retornar:
```json
{"ok":true,"ready":true}
```

## Troubleshooting

### Porta 3000 já em uso

Se outro processo estiver usando a porta 3000:

```bash
# Ver qual processo está usando
lsof -i :3000

# Matar o processo (substitua PID pelo número)
kill -9 PID
```

### Erro de permissão

Se der erro de permissão:

```bash
# Verificar permissões do diretório
ls -la /opt/whatsapp-api

# Dar permissão se necessário
sudo chown -R seu-usuario:seu-usuario /opt/whatsapp-api
```

### Variáveis de ambiente

Verifique se o arquivo `.env` existe e está configurado:

```bash
cat /opt/whatsapp-api/.env
```

### Firewall

Verifique se o firewall permite conexão na porta 3000:

```bash
# UFW
sudo ufw allow 3000/tcp

# firewalld
sudo firewall-cmd --add-port=3000/tcp --permanent
sudo firewall-cmd --reload
```

