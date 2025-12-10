# Segurança da API

Este documento descreve as medidas de segurança implementadas na API.

## Proteções Implementadas

### 1. Rate Limiting (Limitação de Taxa)

#### Rate Limit Global
- **Configuração**: `RATE_LIMIT_WINDOW_MS` e `RATE_LIMIT_MAX_REQUESTS`
- **Padrão**: 100 requisições por minuto (60 segundos)
- **Aplicado a**: Todas as rotas
- **Comportamento**: Retorna HTTP 429 quando excedido

#### Rate Limit Estrito (Endpoints Críticos)
- **Configuração**: `RATE_LIMIT_STRICT_WINDOW_MS` e `RATE_LIMIT_STRICT_MAX`
- **Padrão**: 10 requisições por minuto
- **Aplicado a**: `/send`, `/trigger-snapshot`
- **Comportamento**: Proteção adicional contra abuso

### 2. Autenticação e Autorização

#### API Token
- **Header**: `X-API-Token`
- **Configuração**: `API_TOKEN` no `.env`
- **Proteção**: Bloqueio automático após 5 tentativas falhadas em 15 minutos

#### ESP32 Token
- **Header**: `X-ESP32-Token`
- **Configuração**: `ESP32_TOKEN` e `ESP32_ALLOWED_IPS` no `.env`
- **Proteção**: Whitelist de IPs + Token

### 3. Bloqueio Automático de IPs

- **Mecanismo**: Sistema de contagem de tentativas falhadas
- **Limite**: 5 tentativas com token inválido em 15 minutos
- **Ação**: IP bloqueado automaticamente
- **Persistência**: Salvo em `blocked_ips.json`
- **Limpeza**: Tentativas antigas (>1 hora) são removidas automaticamente

### 4. Whitelist Global de IPs (Opcional)

- **Configuração**: `ENABLE_IP_WHITELIST=true` e `IP_WHITELIST`
- **Formato**: IPs separados por vírgula, suporta CIDR (ex: `10.10.0.0/23`)
- **Comportamento**: Quando habilitado, apenas IPs na lista podem acessar a API
- **Exceções**: IPs na whitelist não são afetados por rate limiting

### 5. Validação de Entrada

#### Endpoint `/send`
- Validação de campos obrigatórios (`phone`, `message`)
- Limite de tamanho de mensagem: 4096 caracteres
- Validação de formato de telefone (10-15 dígitos)
- Validação de tamanho de payload: máximo 256KB

#### Endpoint `/trigger-snapshot`
- Validação de tamanho de body: máximo 1024 bytes
- Validação de token e IP (ESP32)

### 6. Timeout de Requisições

- **Configuração**: `ENABLE_REQUEST_TIMEOUT` e `REQUEST_TIMEOUT_MS`
- **Padrão**: Habilitado, 30 segundos
- **Comportamento**: Requisições que excedem o timeout retornam HTTP 408

### 7. Helmet.js (Headers de Segurança)

- **Content Security Policy**: Configurado para APIs
- **HSTS**: Habilitado (1 ano, inclui subdomínios)
- **X-Frame-Options**: Proteção contra clickjacking
- **X-Content-Type-Options**: Previne MIME sniffing

### 8. CORS (Cross-Origin Resource Sharing)

- **Configuração**: `CORS_ORIGIN` no `.env`
- **Padrão**: `*` (permitir todas as origens)
- **Recomendação**: Configure origens específicas em produção

### 9. Logs de Segurança

Todos os eventos de segurança são registrados:
- Tentativas de acesso com token inválido
- Rate limit excedido
- IPs bloqueados
- Requisições suspeitas
- Timeouts

## Variáveis de Ambiente

```env
# Rate Limiting
RATE_LIMIT_WINDOW_MS=60000          # Janela de tempo em ms (padrão: 60000 = 1 minuto)
RATE_LIMIT_MAX_REQUESTS=100         # Máximo de requisições por janela (padrão: 100)
RATE_LIMIT_STRICT_WINDOW_MS=60000   # Janela para endpoints críticos (padrão: 60000)
RATE_LIMIT_STRICT_MAX=10            # Máximo para endpoints críticos (padrão: 10)

# Whitelist Global de IPs
ENABLE_IP_WHITELIST=false           # Habilitar whitelist global (padrão: false)
IP_WHITELIST=10.10.0.0/23,192.168.1.1  # IPs permitidos (separados por vírgula, suporta CIDR)

# Timeout
ENABLE_REQUEST_TIMEOUT=true         # Habilitar timeout (padrão: true)
REQUEST_TIMEOUT_MS=30000            # Timeout em ms (padrão: 30000 = 30s)

# CORS
CORS_ORIGIN=*                       # Origem permitida (use * para todas, ou URL específica)

# Autenticação
API_TOKEN=seu_token_aqui            # Token para autenticação geral
ESP32_TOKEN=seu_token_esp32         # Token para ESP32
ESP32_ALLOWED_IPS=10.10.0.0/23      # IPs permitidos para ESP32 (separados por vírgula)
```

## Recomendações de Segurança

### Produção

1. **Configure CORS específico**: Não use `*` em produção
   ```env
   CORS_ORIGIN=https://seu-dominio.com
   ```

2. **Use HTTPS**: Configure um proxy reverso (nginx/Apache) com SSL/TLS

3. **Habilite Whitelist de IPs**: Se possível, restrinja acesso por IP
   ```env
   ENABLE_IP_WHITELIST=true
   IP_WHITELIST=10.10.0.0/23,192.168.1.100
   ```

4. **Tokens Fortes**: Use tokens longos e aleatórios
   ```bash
   # Gerar token seguro
   openssl rand -hex 32
   ```

5. **Monitore Logs**: Revise regularmente os logs de segurança

6. **Firewall**: Configure firewall no servidor para bloquear portas desnecessárias

7. **Atualizações**: Mantenha dependências atualizadas
   ```bash
   npm audit
   npm update
   ```

### Desenvolvimento

- Use `DEBUG=true` apenas em desenvolvimento
- Configure `CORS_ORIGIN=*` apenas para testes locais
- Desabilite `ENABLE_IP_WHITELIST` durante desenvolvimento

## Monitoramento

### Verificar IPs Bloqueados

Os IPs bloqueados são salvos em `blocked_ips.db` (SQLite) ou `blocked_ips.json` (legado):

```json
{
  "blockedIPs": ["192.168.1.100", "10.0.0.50"],
  "updatedAt": "2025-12-09T12:00:00.000Z"
}
```

### Logs de Segurança

Procure por `[SECURITY]` nos logs:

```bash
# Exemplo de log
[SECURITY] IP 192.168.1.100 bloqueado após 5 tentativas falhadas
[SECURITY] Rate limit excedido para IP 10.0.0.50 em /send
[SECURITY] Tentativa de acesso de IP bloqueado: 192.168.1.100
```

## Desbloqueio Manual de IPs

Para desbloquear um IP manualmente:

### Via Banco de Dados SQLite (Recomendado)
```bash
sqlite3 blocked_ips.db "DELETE FROM blocked_ips WHERE ip = 'IP_A_DESBLOQUEAR';"
```

### Via Arquivo JSON (Legado)
1. Edite `blocked_ips.json` e remova o IP da lista
2. Ou delete o arquivo para desbloquear todos os IPs
3. Reinicie a aplicação

### Via WhatsApp (se disponível)
Use o comando `!unblock <ip>` no WhatsApp (se implementado)

## Testes de Segurança

### Teste de Rate Limit

```bash
# Deve retornar 429 após exceder o limite
for i in {1..15}; do
  curl -X POST http://localhost:3000/send \
    -H "X-API-Token: seu_token" \
    -H "Content-Type: application/json" \
    -d '{"phone":"+5511999999999","message":"teste"}'
done
```

### Teste de Bloqueio de IP

```bash
# 5 tentativas com token inválido devem bloquear o IP
for i in {1..6}; do
  curl -X POST http://localhost:3000/send \
    -H "X-API-Token: token_invalido" \
    -H "Content-Type: application/json" \
    -d '{"phone":"+5511999999999","message":"teste"}'
done
```

## Suporte

Para questões de segurança, revise os logs e verifique as configurações no `.env`.

