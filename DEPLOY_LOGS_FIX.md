# Instruções para Deploy e Verificação dos Logs

## Alterações Realizadas

### 1. Logs de SQL nas Consultas
- ✅ `listBlockedIPs` - Já tinha logs, mantido
- ✅ `listWhitelistIPs` - Adicionados logs detalhados do SQL
- ✅ `listYellowlistIPs` - Adicionados logs detalhados do SQL  
- ✅ `listMigrationLogs` - Adicionados logs detalhados do SQL
- ✅ `countMigrationLogs` - Adicionados logs detalhados do SQL

### 2. Listagem de IPs na Inicialização
- ✅ Contagem de IPs em cada tabela
- ✅ Listagem dos primeiros 50 IPs de cada tabela com detalhes completos

### 3. Logs no Módulo Admin
- ✅ Logs nas rotas `/admin/api/blocked` e `/admin/api/migrations`
- ✅ Novo endpoint `/admin/api/logs` para acessar logs via API

## Como Fazer o Deploy

### Opção 1: Usando WinSCP ou FileZilla
1. Conecte ao servidor:
   - Host: `10.10.0.3`
   - Usuário: `root`
   - Senha: `91288279`
   - Pasta remota: `/opt/whatsapp-api/src/modules/`

2. Faça upload dos arquivos:
   - `src/modules/ip-blocker.js`
   - `src/modules/admin.js`

3. Reinicie o serviço:
   ```bash
   ssh root@10.10.0.3
   # Senha: 91288279
   systemctl restart whatsapp-api.service
   ```

### Opção 2: Usando SCP (se tiver chaves SSH configuradas)
```bash
scp src/modules/ip-blocker.js root@10.10.0.3:/opt/whatsapp-api/src/modules/
scp src/modules/admin.js root@10.10.0.3:/opt/whatsapp-api/src/modules/
```

## Como Verificar os Logs

### Via SSH
```bash
ssh root@10.10.0.3
# Senha: 91288279

# Ver logs recentes com filtro
tail -n 300 /opt/whatsapp-api/logs/app.log | grep -E '(IP-BLOCKER|ADMIN|SQL|INIT|Blocked IPs|Migrations)'

# Verificar IPs no banco
sqlite3 /opt/whatsapp-api/blocked_ips.db "SELECT COUNT(*) FROM blocked_ips;"
sqlite3 /opt/whatsapp-api/blocked_ips.db "SELECT ip, reason, blocked_at FROM blocked_ips LIMIT 10;"
```

### Via Interface Web (após login)
1. Acesse: `http://10.10.0.3:3000/admin`
2. Faça login com o número: `+5542999219594`
3. Acesse o dashboard
4. Os logs aparecerão automaticamente quando você acessar as páginas de IPs bloqueados

### Via API (após login)
```bash
# Primeiro, obtenha o cookie de sessão fazendo login na interface web
# Depois, acesse:
curl -b "admin_session=SEU_SESSION_ID" http://10.10.0.3:3000/admin/api/logs?lines=200&filter=IP-BLOCKER
```

## O que Procurar nos Logs

### Na Inicialização
Procure por:
- `[IP-BLOCKER] 🔍 [INIT] SQL:` - Mostra os SELECTs executados na inicialização
- `[IP-BLOCKER] 📋 [INIT] IPs Bloqueados` - Lista os IPs bloqueados
- `[IP-BLOCKER] 📋 [INIT] IPs Whitelist` - Lista os IPs na whitelist
- `[IP-BLOCKER] 📋 [INIT] IPs Yellowlist` - Lista os IPs na yellowlist

### Nas Consultas da Interface
Procure por:
- `[IP-BLOCKER] 🔍 SQL:` - Mostra o SELECT executado
- `[IP-BLOCKER] 🔍 Parâmetros:` - Mostra os parâmetros da query
- `[IP-BLOCKER] ✅ Resultado:` - Mostra quantas linhas foram retornadas
- `[ADMIN] 🔍 Consultando blocked IPs:` - Mostra quando a interface faz a consulta

## Troubleshooting

Se os IPs não aparecerem mesmo existindo no banco:

1. Verifique se o banco tem dados:
   ```bash
   sqlite3 /opt/whatsapp-api/blocked_ips.db "SELECT COUNT(*) FROM blocked_ips;"
   ```

2. Verifique os logs para ver se há erros:
   ```bash
   tail -n 100 /opt/whatsapp-api/logs/app.log | grep ERROR
   ```

3. Verifique se o módulo está inicializado:
   ```bash
   tail -n 100 /opt/whatsapp-api/logs/app.log | grep "IP-BLOCKER.*inicializado"
   ```

4. Teste a consulta diretamente:
   ```bash
   sqlite3 /opt/whatsapp-api/blocked_ips.db "SELECT ip, reason, blocked_at FROM blocked_ips LIMIT 5;"
   ```

