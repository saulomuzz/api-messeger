# Plano de Deploy e Teste - Correção de Logs

## ✅ Arquivos Modificados

1. **src/modules/ip-blocker.js**
   - Adicionados logs detalhados de SQL em todas as consultas
   - Adicionada listagem de IPs na inicialização
   - Logs mostram: SQL executado, parâmetros, resultados

2. **src/modules/admin.js**
   - Adicionados logs nas rotas de API
   - Novo endpoint `/admin/api/logs` (requer autenticação)
   - Novo endpoint `/admin/debug/info` (SEM autenticação - para debug)

## 📋 Passos para Deploy

### 1. Fazer Upload dos Arquivos

**Opção A - WinSCP/FileZilla:**
- Host: `10.10.0.3`
- Usuário: `root`
- Senha: `91288279`
- Upload para: `/opt/whatsapp-api/src/modules/`
- Arquivos:
  - `ip-blocker.js`
  - `admin.js`

**Opção B - SCP (se tiver chaves configuradas):**
```bash
scp src/modules/ip-blocker.js root@10.10.0.3:/opt/whatsapp-api/src/modules/
scp src/modules/admin.js root@10.10.0.3:/opt/whatsapp-api/src/modules/
```

### 2. Reiniciar o Serviço

```bash
ssh root@10.10.0.3
# Senha: 91288279
systemctl restart whatsapp-api.service
```

### 3. Verificar se Funcionou

**A) Verificar endpoint de debug (SEM precisar de login):**
```
http://10.10.0.3:3000/admin/debug/info
```

Este endpoint mostra:
- Se os arquivos foram atualizados (data de modificação)
- Se as funções de log estão presentes
- Quantos IPs existem no banco
- Exemplos de IPs bloqueados
- Últimos logs relacionados

**B) Verificar logs no servidor:**
```bash
# Ver logs de inicialização
tail -n 500 /opt/whatsapp-api/logs/app.log | grep -E '(IP-BLOCKER.*INIT|IP-BLOCKER.*inicializado)' | tail -n 20

# Ver logs de SQL
tail -n 300 /opt/whatsapp-api/logs/app.log | grep -E '(IP-BLOCKER.*SQL|IP-BLOCKER.*Parâmetros|IP-BLOCKER.*Resultado)' | tail -n 50

# Verificar IPs no banco
sqlite3 /opt/whatsapp-api/blocked_ips.db "SELECT COUNT(*) FROM blocked_ips;"
sqlite3 /opt/whatsapp-api/blocked_ips.db "SELECT ip, reason, blocked_at FROM blocked_ips LIMIT 10;"
```

**C) Testar interface web:**
1. Acesse: `http://10.10.0.3:3000/admin`
2. Faça login com: `+5542999219594`
3. Acesse o dashboard
4. Vá para a página de IPs bloqueados
5. Os logs devem aparecer mostrando:
   - `[ADMIN] 🔍 Consultando blocked IPs: limit=X, offset=Y`
   - `[IP-BLOCKER] 🔍 SQL: SELECT ...`
   - `[IP-BLOCKER] 🔍 Parâmetros: [...]`
   - `[IP-BLOCKER] ✅ Resultado: X linha(s) retornada(s)`

## 🔍 O que Procurar nos Logs

### Na Inicialização (após reiniciar):
```
[IP-BLOCKER] 🔍 [INIT] SQL: SELECT COUNT(*) as count FROM blocked_ips
[IP-BLOCKER] ✅ [INIT] Blocked count: X
[IP-BLOCKER] 📋 [INIT] IPs Bloqueados (X):
[IP-BLOCKER]   1. IP: xxx.xxx.xxx.xxx, Reason: ..., Blocked at: ..., Requests: ...
```

### Nas Consultas da Interface:
```
[ADMIN] 🔍 Consultando blocked IPs: limit=20, offset=0
[IP-BLOCKER] 🔍 SQL: SELECT ip, reason, blocked_at ...
[IP-BLOCKER] 🔍 Parâmetros: [20, 0]
[IP-BLOCKER] ✅ SQL executado com sucesso
[IP-BLOCKER] ✅ Resultado: X linha(s) retornada(s)
[ADMIN] ✅ Blocked IPs: X de Y
```

## 🐛 Troubleshooting

### Se os IPs não aparecerem na interface:

1. **Verifique se há IPs no banco:**
   ```bash
   sqlite3 /opt/whatsapp-api/blocked_ips.db "SELECT COUNT(*) FROM blocked_ips;"
   ```

2. **Verifique os logs de erro:**
   ```bash
   tail -n 100 /opt/whatsapp-api/logs/app.log | grep ERROR
   ```

3. **Verifique se o módulo está inicializado:**
   ```bash
   tail -n 100 /opt/whatsapp-api/logs/app.log | grep "IP-BLOCKER.*inicializado"
   ```

4. **Teste a consulta diretamente:**
   ```bash
   sqlite3 /opt/whatsapp-api/blocked_ips.db "SELECT ip, reason, blocked_at FROM blocked_ips LIMIT 5;"
   ```

5. **Verifique se os arquivos foram atualizados:**
   ```bash
   ls -lh /opt/whatsapp-api/src/modules/ip-blocker.js
   ls -lh /opt/whatsapp-api/src/modules/admin.js
   # Verifique a data de modificação
   ```

6. **Verifique se o serviço reiniciou:**
   ```bash
   systemctl status whatsapp-api.service
   # OU
   ps aux | grep "node.*app.js"
   ```

## 📝 Notas Importantes

- O endpoint `/admin/debug/info` é temporário e NÃO requer autenticação. **REMOVA em produção!**
- Os logs agora são muito mais detalhados e ajudarão a identificar problemas
- Se os IPs existem no banco mas não aparecem na interface, os logs mostrarão exatamente o que está acontecendo

