# Troubleshooting Nginx - Erro "location directive is not allowed here"

## Erro

```
"location" directive is not allowed here in /etc/nginx/sites-enabled/seu-dominio.com.br.conf:44
```

## Causa

A diretiva `location` está fora do bloco `server` ou há um fechamento de chave `}` incorreto antes dela.

## Solução

### 1. Verifique a estrutura do arquivo

```bash
sudo cat /etc/nginx/sites-available/seu-dominio.com.br.conf
```

### 2. Estrutura correta

Todas as diretivas `location` DEVEM estar dentro do bloco `server`:

```nginx
server {
    server_name seu-dominio.com.br;
    
    # Todas as locations aqui dentro
    location /ws/esp32 {
        # ...
    }
    
    location / {
        # ...
    }
    
    # Outras diretivas do server
    listen 443 ssl;
    # ...
}
```

### 3. Problemas comuns

#### ❌ ERRADO - location fora do server:
```nginx
server {
    server_name example.com;
    listen 443 ssl;
}  # ← Fechamento prematuro

location / {  # ← ERRO! Está fora do server
    # ...
}
```

#### ✅ CORRETO - location dentro do server:
```nginx
server {
    server_name example.com;
    listen 443 ssl;
    
    location / {  # ← CORRETO! Está dentro do server
        # ...
    }
}
```

### 4. Como corrigir

1. **Abra o arquivo:**
   ```bash
   sudo nano /etc/nginx/sites-available/seu-dominio.com.br.conf
   ```

2. **Verifique se todas as `location` estão dentro do bloco `server { ... }`**

3. **Use o arquivo de exemplo** (`docs/NGINX_CONFIG_FIXED.conf`) como referência

4. **Teste a configuração:**
   ```bash
   sudo nginx -t
   ```

5. **Se o teste passar, recarregue:**
   ```bash
   sudo systemctl reload nginx
   ```

### 5. Verificar sintaxe

Use este comando para verificar onde está o erro:
```bash
sudo nginx -t -c /etc/nginx/nginx.conf
```

### 6. Verificar linha 44

Para ver o que está na linha 44:
```bash
sudo sed -n '40,50p' /etc/nginx/sites-available/seu-dominio.com.br.conf
```

## Estrutura completa correta

Veja o arquivo `docs/NGINX_CONFIG_FIXED.conf` para a estrutura completa e correta.

