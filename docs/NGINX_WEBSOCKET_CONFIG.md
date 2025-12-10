# Configuração Nginx para WebSocket

## Problema

O nginx está retornando 502 (Bad Gateway) para requisições WebSocket porque a configuração não está adequada para upgrade de conexão HTTP para WebSocket.

## Solução

Adicione uma `location` específica para o endpoint WebSocket `/ws/esp32` com as configurações corretas.

## Configuração Completa

```nginx
server {
    server_name seu-dominio.com.br;
    
    client_max_body_size 20m;
    
    # Location específica para WebSocket
    location /ws/esp32 {
        proxy_pass http://10.0.0.10:3000;
        
        # Headers essenciais para WebSocket
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        
        # Headers padrão
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # Timeouts aumentados para WebSocket (conexão persistente)
        proxy_connect_timeout 7d;
        proxy_send_timeout 7d;
        proxy_read_timeout 7d;
        
        # Buffer settings para WebSocket
        proxy_buffering off;
    }
    
    # Location padrão para outras requisições
    location / {
        proxy_pass http://10.0.0.10:3000;
        
        # Headers de encaminhamento
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # Suporte básico a conexões persistentes
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $http_connection;
        
        # Timeouts
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
    
    access_log /var/log/nginx/seu-dominio.com.br.log;
    error_log  /var/log/nginx/seu-dominio.com.br_error.log;
    
    listen 443 ssl;
    ssl_certificate /etc/letsencrypt/live/seu-dominio.com.br/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/seu-dominio.com.br/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
}

server {
    if ($host = seu-dominio.com.br) {
        return 301 https://$host$request_uri;
    }
    
    listen 80;
    server_name seu-dominio.com.br;
    return 404;
}
```

## Diferenças Importantes

### Para WebSocket (`/ws/esp32`):

1. **`Connection "upgrade"`** - Fixo, não usa variável `$http_connection`
2. **Timeouts muito longos** - `7d` (7 dias) porque WebSocket mantém conexão aberta
3. **`proxy_buffering off`** - Desabilita buffering para comunicação em tempo real
4. **Location específica** - Antes da location `/` para ter prioridade

### Para HTTP normal (`/`):

1. **`Connection $http_connection`** - Usa variável para compatibilidade
2. **Timeouts normais** - 60 segundos
3. **Buffering habilitado** - Melhor para requisições HTTP normais

## Como Aplicar

1. Edite o arquivo de configuração:
   ```bash
   sudo nano /etc/nginx/sites-available/seu-dominio.com.br
   ```

2. Substitua a configuração atual pela configuração acima

3. Teste a configuração:
   ```bash
   sudo nginx -t
   ```

4. Recarregue o nginx:
   ```bash
   sudo systemctl reload nginx
   ```

## Verificação

Após aplicar, verifique os logs:
```bash
tail -f /var/log/nginx/seu-dominio.com.br_error.log
```

As requisições WebSocket devem retornar `101 Switching Protocols` ao invés de `502 Bad Gateway`.

## Troubleshooting

### Se ainda retornar 502:

1. Verifique se o servidor Node.js está rodando:
   ```bash
   curl http://10.0.0.10:3000/health
   ```

2. Verifique se o servidor WebSocket está escutando:
   ```bash
   netstat -tlnp | grep 3000
   ```

3. Verifique os logs do Node.js para erros de WebSocket

### Se retornar 400:

- Verifique se o header `Upgrade: websocket` está sendo enviado
- Verifique se o header `Connection: Upgrade` está correto

