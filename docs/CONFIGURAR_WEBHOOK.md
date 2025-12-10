# Como Configurar o Webhook do WhatsApp Business API

## Problema: 404 Not Found

O erro 404 indica que o **nginx não está roteando** as requisições para o serviço Node.js na porta 4000.

## Solução

### 1. Configure o Nginx

Adicione esta configuração ao seu nginx (geralmente em `/etc/nginx/sites-available/default` ou `/etc/nginx/conf.d/default.conf`):

```nginx
server {
    listen 80;
    server_name seu-dominio.com.br;

    location /webhook/whatsapp {
        proxy_pass http://localhost:4000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # Timeout aumentado para webhooks
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
}
```

**Se usar HTTPS**, adicione também:

```nginx
server {
    listen 443 ssl http2;
    server_name seu-dominio.com.br;

    # Seus certificados SSL aqui
    # ssl_certificate /caminho/para/certificado.pem;
    # ssl_certificate_key /caminho/para/chave.pem;

    location /webhook/whatsapp {
        proxy_pass http://localhost:4000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
}
```

### 2. Recarregue o Nginx

```bash
sudo nginx -t  # Testa a configuração
sudo systemctl reload nginx  # Recarrega o nginx
```

### 3. Verifique se o Endpoint Funciona

Teste localmente primeiro:

```bash
curl http://localhost:4000/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=seu_token_secreto&hub.challenge=test123
```

Deve retornar: `test123`

### 4. Configure no Meta for Developers

No campo **"Verify token"**, coloque o **mesmo valor** que está no seu `.env`:

```env
WHATSAPP_WEBHOOK_VERIFY_TOKEN=seu_token_secreto
```

**Exemplo:**
- Se no `.env` você tem: `WHATSAPP_WEBHOOK_VERIFY_TOKEN=minha_chave_secreta_123`
- No Meta, coloque: `minha_chave_secreta_123`

### 5. Campos de Assinatura (Webhook Fields)

No Meta, selecione os seguintes campos:
- ✅ `messages`
- ✅ `messaging_postbacks`
- ✅ `message_status` (opcional, para status de entrega)

### 6. Teste a Configuração

1. Clique em **"Verify and save"** no Meta
2. Se tudo estiver correto, você verá uma mensagem de sucesso
3. O webhook será verificado e ativado

## Troubleshooting

### Erro: "The callback URL or verify token couldn't be validated"

**Causas possíveis:**
1. ❌ Nginx não está roteando corretamente
2. ❌ Token de verificação não confere
3. ❌ Serviço Node.js não está rodando na porta 4000
4. ❌ Firewall bloqueando a porta 4000

**Soluções:**
1. Verifique se o nginx está configurado corretamente
2. Verifique se o token no `.env` é o mesmo do Meta
3. Verifique se o serviço está rodando: `ps aux | grep node`
4. Teste o endpoint diretamente: `curl http://localhost:4000/webhook/whatsapp?...`

### Verificar Logs

```bash
# Logs do nginx
sudo tail -f /var/log/nginx/error.log

# Logs da aplicação
tail -f /var/log/whatsapp-api.log
```

## Checklist Final

- [ ] Nginx configurado com proxy_pass para porta 4000
- [ ] Nginx recarregado (`sudo systemctl reload nginx`)
- [ ] Serviço Node.js rodando na porta 4000
- [ ] Token de verificação no `.env` igual ao do Meta
- [ ] Endpoint testado localmente
- [ ] Webhook verificado no Meta

