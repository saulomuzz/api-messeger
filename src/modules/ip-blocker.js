/**
 * Módulo de Bloqueio de IPs
 * Gerencia bloqueio de IPs usando SQLite com cache em memória
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

/**
 * Classe de Cache com TTL (Time-To-Live)
 * Cache em memória para melhorar performance de consultas frequentes
 */
class IPCache {
  constructor(ttlMs = 60000, maxSize = 10000) {
    this.cache = new Map();
    this.ttlMs = ttlMs; // Tempo de vida padrão: 60 segundos
    this.maxSize = maxSize; // Tamanho máximo do cache
    this.stats = { hits: 0, misses: 0 };
  }
  
  /**
   * Obtém valor do cache
   * @param {string} key - Chave do cache
   * @returns {*} Valor ou undefined se expirado/não existir
   */
  get(key) {
    const entry = this.cache.get(key);
    if (!entry) {
      this.stats.misses++;
      return undefined;
    }
    
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.stats.misses++;
      return undefined;
    }
    
    this.stats.hits++;
    return entry.value;
  }
  
  /**
   * Define valor no cache
   * @param {string} key - Chave
   * @param {*} value - Valor
   * @param {number} [ttlMs] - TTL específico (opcional)
   */
  set(key, value, ttlMs = this.ttlMs) {
    // Limpa entradas antigas se o cache estiver cheio
    if (this.cache.size >= this.maxSize) {
      this.evictExpired();
      // Se ainda estiver cheio, remove as mais antigas
      if (this.cache.size >= this.maxSize) {
        const keysToDelete = Array.from(this.cache.keys()).slice(0, Math.floor(this.maxSize * 0.1));
        keysToDelete.forEach(k => this.cache.delete(k));
      }
    }
    
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + ttlMs
    });
  }
  
  /**
   * Remove entrada do cache
   * @param {string} key - Chave
   */
  delete(key) {
    this.cache.delete(key);
  }
  
  /**
   * Limpa todo o cache
   */
  clear() {
    this.cache.clear();
    this.stats = { hits: 0, misses: 0 };
  }
  
  /**
   * Remove entradas expiradas
   */
  evictExpired() {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }
  
  /**
   * Obtém estatísticas do cache
   * @returns {Object} Estatísticas
   */
  getStats() {
    return {
      ...this.stats,
      size: this.cache.size,
      hitRate: this.stats.hits + this.stats.misses > 0 
        ? (this.stats.hits / (this.stats.hits + this.stats.misses) * 100).toFixed(2) + '%'
        : '0%'
    };
  }
}

/**
 * Inicializa o módulo de bloqueio de IPs
 * @param {Object} config - Configuração do módulo
 * @param {string} config.appRoot - Diretório raiz da aplicação
 * @param {Object} config.logger - Objeto com funções de log
 * @returns {Object} API do módulo
 */
function initIPBlockerModule({ appRoot, logger, whatsappAuditRetentionDays = 180 }) {
  try {
  const { log, dbg, warn, err } = logger;
  const AUDIT_RETENTION_DAYS = Number(whatsappAuditRetentionDays) > 0 ? Number(whatsappAuditRetentionDays) : 180;
    
    if (!appRoot) {
      err(`[IP-BLOCKER] ❌ appRoot não fornecido`);
      throw new Error('appRoot is required');
    }
    
    if (!logger) {
      err(`[IP-BLOCKER] ❌ logger não fornecido`);
      throw new Error('logger is required');
    }
    
    log(`[IP-BLOCKER] Inicializando módulo...`);
    log(`[IP-BLOCKER] appRoot: ${appRoot}`);
    
    const DB_PATH = path.join(appRoot, 'blocked_ips.db');
    let db = null;
    
    // Cache de IPs em memória (TTL: 60 segundos, max: 10000 IPs)
    const CACHE_TTL_MS = parseInt(process.env.IP_CACHE_TTL_MS || '60000', 10);
    const CACHE_MAX_SIZE = parseInt(process.env.IP_CACHE_MAX_SIZE || '10000', 10);
    const blockedCache = new IPCache(CACHE_TTL_MS, CACHE_MAX_SIZE);
    const whitelistCache = new IPCache(CACHE_TTL_MS, CACHE_MAX_SIZE);
    const yellowlistCache = new IPCache(CACHE_TTL_MS, CACHE_MAX_SIZE);
    
    // Intervalo de limpeza automática do cache (a cada 5 minutos)
    setInterval(() => {
      blockedCache.evictExpired();
      whitelistCache.evictExpired();
      yellowlistCache.evictExpired();
      dbg(`[IP-BLOCKER] Cache limpo. Stats: blocked=${JSON.stringify(blockedCache.getStats())}`);
    }, 5 * 60 * 1000);
    
  // Flag para indicar se o banco está pronto (definido ANTES das funções para estar no escopo)
  let dbReady = false;
  let dbReadyPromise = null;
  let moduleAPI = null; // Será criado após inicialização do banco
  
  /**
   * Inicializa o banco de dados
   */
  function initDatabase() {
    return new Promise((resolve, reject) => {
      db = new sqlite3.Database(DB_PATH, (error) => {
        if (error) {
          err(`[IP-BLOCKER] Erro ao abrir banco de dados:`, error.message);
          reject(error);
          return;
        }
        
        log(`[IP-BLOCKER] Banco de dados conectado: ${DB_PATH}`);
        
        // Cria tabela de IPs bloqueados (blacklist)
        db.run(`
          CREATE TABLE IF NOT EXISTS blocked_ips (
            ip TEXT PRIMARY KEY,
            reason TEXT,
            blocked_at INTEGER NOT NULL,
            last_seen INTEGER,
            request_count INTEGER DEFAULT 0,
            created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
          )
        `, (error) => {
          if (error) {
            err(`[IP-BLOCKER] Erro ao criar tabela blocked_ips:`, error.message);
            reject(error);
            return;
          }
          
          // Cria tabela de whitelist (IPs com < 50% confiança, válido por 15 dias)
          db.run(`
            CREATE TABLE IF NOT EXISTS ip_whitelist (
              ip TEXT PRIMARY KEY,
              abuse_confidence REAL NOT NULL,
              reports INTEGER DEFAULT 0,
              request_count INTEGER DEFAULT 0,
              last_seen INTEGER,
              created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
              expires_at INTEGER NOT NULL
            )
          `, (error) => {
            if (error) {
              err(`[IP-BLOCKER] Erro ao criar tabela ip_whitelist:`, error.message);
              reject(error);
              return;
            }
            
            // Cria tabela de yellowlist (IPs com 50-80% confiança, válido por 7 dias)
            db.run(`
              CREATE TABLE IF NOT EXISTS ip_yellowlist (
                ip TEXT PRIMARY KEY,
                abuse_confidence REAL NOT NULL,
                reports INTEGER DEFAULT 0,
                request_count INTEGER DEFAULT 0,
                last_seen INTEGER,
                created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
                expires_at INTEGER NOT NULL
              )
            `, (error) => {
              if (error) {
                err(`[IP-BLOCKER] Erro ao criar tabela ip_yellowlist:`, error.message);
                reject(error);
                return;
              }
              
              // Adiciona colunas request_count e last_seen se não existirem (migração)
              db.run(`
                ALTER TABLE ip_whitelist ADD COLUMN request_count INTEGER DEFAULT 0
              `, () => {
                // Ignora erro se coluna já existe
              });
              
              db.run(`
                ALTER TABLE ip_whitelist ADD COLUMN last_seen INTEGER
              `, () => {
                // Ignora erro se coluna já existe
              });
              
              db.run(`
                ALTER TABLE ip_yellowlist ADD COLUMN request_count INTEGER DEFAULT 0
              `, () => {
                // Ignora erro se coluna já existe
              });
              
              db.run(`
                ALTER TABLE ip_yellowlist ADD COLUMN last_seen INTEGER
              `, () => {
                // Ignora erro se coluna já existe
              });
              
              // Adiciona colunas para dados do AbuseIPDB (migração v2)
              const abuseColumns = [
                { table: 'ip_whitelist', column: 'country_code', type: 'TEXT DEFAULT ""' },
                { table: 'ip_whitelist', column: 'isp', type: 'TEXT DEFAULT ""' },
                { table: 'ip_whitelist', column: 'domain', type: 'TEXT DEFAULT ""' },
                { table: 'ip_whitelist', column: 'usage_type', type: 'TEXT DEFAULT ""' },
                { table: 'ip_whitelist', column: 'is_tor', type: 'INTEGER DEFAULT 0' },
                { table: 'ip_whitelist', column: 'num_distinct_users', type: 'INTEGER DEFAULT 0' },
                { table: 'ip_yellowlist', column: 'country_code', type: 'TEXT DEFAULT ""' },
                { table: 'ip_yellowlist', column: 'isp', type: 'TEXT DEFAULT ""' },
                { table: 'ip_yellowlist', column: 'domain', type: 'TEXT DEFAULT ""' },
                { table: 'ip_yellowlist', column: 'usage_type', type: 'TEXT DEFAULT ""' },
                { table: 'ip_yellowlist', column: 'is_tor', type: 'INTEGER DEFAULT 0' },
                { table: 'ip_yellowlist', column: 'num_distinct_users', type: 'INTEGER DEFAULT 0' },
                // Campos para padronizar blocked_ips com as outras listas
                { table: 'blocked_ips', column: 'abuse_confidence', type: 'REAL DEFAULT 0' },
                { table: 'blocked_ips', column: 'reports', type: 'INTEGER DEFAULT 0' },
                { table: 'blocked_ips', column: 'country_code', type: 'TEXT DEFAULT ""' },
                { table: 'blocked_ips', column: 'isp', type: 'TEXT DEFAULT ""' },
                { table: 'blocked_ips', column: 'domain', type: 'TEXT DEFAULT ""' },
                { table: 'blocked_ips', column: 'usage_type', type: 'TEXT DEFAULT ""' },
                { table: 'blocked_ips', column: 'is_tor', type: 'INTEGER DEFAULT 0' },
                { table: 'blocked_ips', column: 'num_distinct_users', type: 'INTEGER DEFAULT 0' }
              ];
              
              abuseColumns.forEach(({ table, column, type }) => {
                db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`, () => {
                  // Ignora erro se coluna já existe
                });
              });
              
              // Cria tabela de log de acesso (IP + Rota)
              db.run(`
                CREATE TABLE IF NOT EXISTS access_log (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  ip TEXT NOT NULL,
                  route TEXT NOT NULL,
                  method TEXT NOT NULL,
                  status_code INTEGER,
                  response_time_ms INTEGER,
                  user_agent TEXT,
                  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
                )
              `, () => {});
              
              db.run(`CREATE INDEX IF NOT EXISTS idx_access_log_ip ON access_log(ip)`, () => {});
              db.run(`CREATE INDEX IF NOT EXISTS idx_access_log_route ON access_log(route)`, () => {});
              db.run(`CREATE INDEX IF NOT EXISTS idx_access_log_created ON access_log(created_at)`, () => {});
              
              // Cria tabela de eventos Tuya
              db.run(`
                CREATE TABLE IF NOT EXISTS tuya_events (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  device_id TEXT NOT NULL,
                  device_name TEXT,
                  event_type TEXT NOT NULL,
                  old_value TEXT,
                  new_value TEXT,
                  source TEXT,
                  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
                )
              `, () => {});
              
              db.run(`CREATE INDEX IF NOT EXISTS idx_tuya_events_device ON tuya_events(device_id)`, () => {});
              db.run(`CREATE INDEX IF NOT EXISTS idx_tuya_events_created ON tuya_events(created_at)`, () => {});
              
              // Cria tabela de sessões admin (persistentes)
              db.run(`
                CREATE TABLE IF NOT EXISTS admin_sessions (
                  session_id TEXT PRIMARY KEY,
                  phone TEXT NOT NULL,
                  device_fingerprint TEXT,
                  device_name TEXT,
                  ip_address TEXT,
                  user_agent TEXT,
                  trusted_until INTEGER,
                  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
                  expires_at INTEGER NOT NULL,
                  last_used_at INTEGER
                )
              `, () => {});
              
              db.run(`CREATE INDEX IF NOT EXISTS idx_admin_sessions_phone ON admin_sessions(phone)`, () => {});
              db.run(`CREATE INDEX IF NOT EXISTS idx_admin_sessions_fingerprint ON admin_sessions(device_fingerprint)`, () => {});
              db.run(`CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions(expires_at)`, () => {});
              
              // Cria tabela de leituras de energia Tuya
              db.run(`
                CREATE TABLE IF NOT EXISTS tuya_energy_readings (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  device_id TEXT NOT NULL,
                  device_name TEXT,
                  voltage REAL,
                  current_a REAL,
                  power_w REAL,
                  energy_kwh REAL,
                  power_factor REAL,
                  frequency REAL,
                  phases_data TEXT,
                  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
                )
              `, () => {});
              
              db.run(`CREATE INDEX IF NOT EXISTS idx_tuya_energy_device ON tuya_energy_readings(device_id)`, () => {});
              db.run(`CREATE INDEX IF NOT EXISTS idx_tuya_energy_created ON tuya_energy_readings(created_at)`, () => {});
              
              // Migração: adiciona coluna phases_data se não existir
              db.run(`ALTER TABLE tuya_energy_readings ADD COLUMN phases_data TEXT`, (err) => {
                if (err && !err.message.includes('duplicate column')) {
                  // Ignora erro se coluna já existe
                }
              });
              
              // Cria tabela de dispositivos ESP32 (HTTP polling)
              db.run(`
                CREATE TABLE IF NOT EXISTS esp32_devices (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  ip TEXT NOT NULL UNIQUE,
                  device_name TEXT,
                  last_seen INTEGER NOT NULL,
                  first_seen INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
                  request_count INTEGER DEFAULT 1
                )
              `, () => {});
              
              db.run(`CREATE INDEX IF NOT EXISTS idx_esp32_devices_ip ON esp32_devices(ip)`, () => {});
              db.run(`CREATE INDEX IF NOT EXISTS idx_esp32_devices_last_seen ON esp32_devices(last_seen)`, () => {});
              
              // Cria tabela de log de migrações entre listas
              db.run(`
                CREATE TABLE IF NOT EXISTS ip_migration_log (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  ip TEXT NOT NULL,
                  from_list TEXT,
                  to_list TEXT NOT NULL,
                  old_confidence REAL,
                  new_confidence REAL,
                  old_reports INTEGER,
                  new_reports INTEGER,
                  reason TEXT,
                  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
                )
              `, (error) => {
                if (error) {
                  warn(`[IP-BLOCKER] Erro ao criar tabela ip_migration_log:`, error.message);
                }
                
                // Cria tabela de estatísticas do sistema
                db.run(`
                  CREATE TABLE IF NOT EXISTS system_statistics (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    stat_key TEXT UNIQUE NOT NULL,
                    stat_value INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
                  )
                `, (error) => {
                  if (error) {
                    warn(`[IP-BLOCKER] Erro ao criar tabela system_statistics:`, error.message);
                  }
                  
                  // Cria tabela de contadores de rotas
                  db.run(`
                    CREATE TABLE IF NOT EXISTS route_statistics (
                      route TEXT PRIMARY KEY,
                      request_count INTEGER NOT NULL DEFAULT 0,
                      last_seen INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
                    )
                  `, (error) => {
                    if (error) {
                      warn(`[IP-BLOCKER] Erro ao criar tabela route_statistics:`, error.message);
                    }
                    
                    // Cria tabela de contadores de IPs
                    db.run(`
                      CREATE TABLE IF NOT EXISTS ip_request_statistics (
                        ip TEXT PRIMARY KEY,
                        request_count INTEGER NOT NULL DEFAULT 0,
                        last_seen INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
                      )
                    `, (error) => {
                      if (error) {
                        warn(`[IP-BLOCKER] Erro ao criar tabela ip_request_statistics:`, error.message);
                      }
                      
                      // Cria índices para busca rápida
                      db.run(`
                        CREATE INDEX IF NOT EXISTS idx_blocked_ips_ip ON blocked_ips(ip);
                        CREATE INDEX IF NOT EXISTS idx_whitelist_ip ON ip_whitelist(ip);
                        CREATE INDEX IF NOT EXISTS idx_whitelist_expires ON ip_whitelist(expires_at);
                        CREATE INDEX IF NOT EXISTS idx_yellowlist_ip ON ip_yellowlist(ip);
                        CREATE INDEX IF NOT EXISTS idx_yellowlist_expires ON ip_yellowlist(expires_at);
                        CREATE INDEX IF NOT EXISTS idx_migration_log_ip ON ip_migration_log(ip);
                        CREATE INDEX IF NOT EXISTS idx_migration_log_created ON ip_migration_log(created_at);
                        CREATE INDEX IF NOT EXISTS idx_route_statistics_route ON route_statistics(route);
                        CREATE INDEX IF NOT EXISTS idx_ip_request_statistics_ip ON ip_request_statistics(ip)
                      `, (error) => {
                        if (error) {
                          warn(`[IP-BLOCKER] Erro ao criar índices:`, error.message);
                        }
                        
                        // Cria tabela de ranges IP confiáveis (para Meta, Cloudflare, ESP32, etc.)
                        db.run(`
                          CREATE TABLE IF NOT EXISTS trusted_ip_ranges (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            cidr TEXT NOT NULL,
                            category TEXT NOT NULL,
                            description TEXT,
                            enabled INTEGER DEFAULT 1,
                            created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
                            updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
                          )
                        `, (error) => {
                          if (error) {
                            warn(`[IP-BLOCKER] Erro ao criar tabela trusted_ip_ranges:`, error.message);
                          }
                          
                          // Cria índice para busca por categoria
                          db.run(`
                            CREATE INDEX IF NOT EXISTS idx_trusted_ip_ranges_category ON trusted_ip_ranges(category);
                            CREATE INDEX IF NOT EXISTS idx_trusted_ip_ranges_enabled ON trusted_ip_ranges(enabled)
                          `, (error) => {
                            if (error) {
                              warn(`[IP-BLOCKER] Erro ao criar índices de trusted_ip_ranges:`, error.message);
                            }
                            
                            // Cria tabela de controle de rate limit da API AbuseIPDB
                            db.run(`
                              CREATE TABLE IF NOT EXISTS abuseipdb_rate_limit (
                                endpoint TEXT PRIMARY KEY,
                                daily_limit INTEGER NOT NULL,
                                daily_used INTEGER DEFAULT 0,
                                last_reset INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
                                updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
                              )
                            `, (error) => {
                              if (error) {
                                warn(`[IP-BLOCKER] Erro ao criar tabela abuseipdb_rate_limit:`, error.message);
                              }
                              
                              // Cria tabela de opt-in/opt-out do WhatsApp
                              db.run(`
                                CREATE TABLE IF NOT EXISTS whatsapp_opt_in (
                                  phone TEXT PRIMARY KEY,
                                  opted_in INTEGER NOT NULL DEFAULT 1,
                                  opted_in_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
                                  opted_out_at INTEGER,
                                  last_message_at INTEGER,
                                  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
                                )
                              `, (error) => {
                                if (error) {
                                  warn(`[IP-BLOCKER] Erro ao criar tabela whatsapp_opt_in:`, error.message);
                                }
                                
                                db.run(`CREATE INDEX IF NOT EXISTS idx_whatsapp_opt_in_phone ON whatsapp_opt_in(phone)`, () => {});
                                db.run(`CREATE INDEX IF NOT EXISTS idx_whatsapp_opt_in_status ON whatsapp_opt_in(opted_in)`, () => {});

                                // Cria tabela de auditoria de mensagens WhatsApp
                                db.run(`
                                  CREATE TABLE IF NOT EXISTS whatsapp_message_audit (
                                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                                    direction TEXT NOT NULL,
                                    phone TEXT,
                                    message_id TEXT,
                                    type TEXT,
                                    status TEXT,
                                    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
                                    payload_json TEXT,
                                    error_code TEXT,
                                    error_message TEXT
                                  )
                                `, (error) => {
                                  if (error) {
                                    warn(`[IP-BLOCKER] Erro ao criar tabela whatsapp_message_audit:`, error.message);
                                  }
                                  
                                  db.run(`CREATE INDEX IF NOT EXISTS idx_whatsapp_audit_phone ON whatsapp_message_audit(phone)`, () => {});
                                  db.run(`CREATE INDEX IF NOT EXISTS idx_whatsapp_audit_created ON whatsapp_message_audit(created_at)`, () => {});
                                  db.run(`CREATE INDEX IF NOT EXISTS idx_whatsapp_audit_message_id ON whatsapp_message_audit(message_id)`, () => {});
                                  
                                  resolve();
                                });
                              });
                            });
                          });
                        });
                      });
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  }
  
  /**
   * Verifica se um IP está bloqueado (com cache)
   * @param {string} ip - Endereço IP
   * @returns {Promise<boolean>} true se estiver bloqueado
   */
  function isBlocked(ip) {
    return new Promise((resolve, reject) => {
      if (!db) {
        resolve(false);
        return;
      }
      
      // Verifica cache primeiro
      const cached = blockedCache.get(`blocked:${ip}`);
      if (cached !== undefined) {
        resolve(cached);
        return;
      }
      
      db.get('SELECT ip FROM blocked_ips WHERE ip = ?', [ip], (error, row) => {
        if (error) {
          err(`[IP-BLOCKER] Erro ao verificar IP:`, error.message);
          resolve(false); // Em caso de erro, permite acesso
          return;
        }
        
        const isBlocked = !!row;
        // Armazena no cache
        blockedCache.set(`blocked:${ip}`, isBlocked);
        resolve(isBlocked);
      });
    });
  }
  
  /**
   * Remove IP de outras listas (evita duplicidade)
   * @param {string} ip - Endereço IP
   * @param {string} currentList - Lista atual ('whitelist', 'yellowlist', 'blacklist')
   * @returns {Promise<void>}
   */
  function removeFromOtherLists(ip, currentList) {
    return new Promise((resolve, reject) => {
      if (!db) {
        resolve();
        return;
      }
      
      const promises = [];
      
      // Remove de whitelist se não for a lista atual
      if (currentList !== 'whitelist') {
        promises.push(new Promise((res) => {
          db.run('DELETE FROM ip_whitelist WHERE ip = ?', [ip], function(err) {
            if (err) {
              dbg(`[IP-BLOCKER] Erro ao remover da whitelist:`, err.message);
            } else if (this.changes > 0) {
              dbg(`[IP-BLOCKER] IP ${ip} removido da whitelist (movido para ${currentList})`);
            }
            res();
          });
        }));
      }
      
      // Remove de yellowlist se não for a lista atual
      if (currentList !== 'yellowlist') {
        promises.push(new Promise((res) => {
          db.run('DELETE FROM ip_yellowlist WHERE ip = ?', [ip], function(err) {
            if (err) {
              dbg(`[IP-BLOCKER] Erro ao remover da yellowlist:`, err.message);
            } else if (this.changes > 0) {
              dbg(`[IP-BLOCKER] IP ${ip} removido da yellowlist (movido para ${currentList})`);
            }
            res();
          });
        }));
      }
      
      // Remove de blacklist se não for a lista atual
      if (currentList !== 'blacklist') {
        promises.push(new Promise((res) => {
          db.run('DELETE FROM blocked_ips WHERE ip = ?', [ip], function(err) {
            if (err) {
              dbg(`[IP-BLOCKER] Erro ao remover da blacklist:`, err.message);
            } else if (this.changes > 0) {
              dbg(`[IP-BLOCKER] IP ${ip} removido da blacklist (movido para ${currentList})`);
            }
            res();
          });
        }));
      }
      
      Promise.all(promises).then(() => resolve()).catch(reject);
    });
  }
  
  /**
   * Bloqueia um IP
   * Remove o IP de outras listas primeiro para evitar duplicidade
   * @param {string} ip - Endereço IP
   * @param {string} reason - Motivo do bloqueio
   * @returns {Promise<boolean>} true se bloqueado com sucesso
   */
  function blockIP(ip, reason = 'Atividade suspeita') {
    return new Promise(async (resolve, reject) => {
      if (!db) {
        reject(new Error('Banco de dados não inicializado'));
        return;
      }
      
      try {
        // NÃO bloqueia IPs privados
        const { isLocalIP } = require('./ip-utils');
        if (isLocalIP(ip)) {
          warn(`[IP-BLOCKER] Tentativa de bloquear IP privado ${ip} ignorada (motivo: ${reason})`);
          resolve(false); // Retorna false mas não rejeita (comportamento normal)
          return;
        }
        
        // Remove de outras listas primeiro (evita duplicidade)
        await removeFromOtherLists(ip, 'blacklist');
        
        const now = Math.floor(Date.now() / 1000);
        
        db.run(`
          INSERT OR REPLACE INTO blocked_ips (ip, reason, blocked_at, last_seen, request_count, created_at)
          VALUES (?, ?, ?, ?, 0, COALESCE((SELECT created_at FROM blocked_ips WHERE ip = ?), ?))
        `, [ip, reason, now, now, ip, now], function(error) {
          if (error) {
            err(`[IP-BLOCKER] Erro ao bloquear IP:`, error.message);
            reject(error);
            return;
          }
          
          // Invalida caches para este IP
          blockedCache.delete(`blocked:${ip}`);
          whitelistCache.delete(`whitelist:${ip}`);
          yellowlistCache.delete(`yellowlist:${ip}`);
          
          log(`[IP-BLOCKER] IP bloqueado: ${ip} (motivo: ${reason})`);
          resolve(true);
        });
      } catch (e) {
        reject(e);
      }
    });
  }
  
  /**
   * Desbloqueia um IP
   * @param {string} ip - Endereço IP
   * @returns {Promise<boolean>} true se desbloqueado com sucesso
   */
  function unblockIP(ip) {
    return new Promise((resolve, reject) => {
      if (!db) {
        reject(new Error('Banco de dados não inicializado'));
        return;
      }
      
      db.run('DELETE FROM blocked_ips WHERE ip = ?', [ip], function(error) {
        if (error) {
          err(`[IP-BLOCKER] Erro ao desbloquear IP:`, error.message);
          reject(error);
          return;
        }
        
        // Invalida cache
        blockedCache.delete(`blocked:${ip}`);
        
        if (this.changes > 0) {
          log(`[IP-BLOCKER] IP desbloqueado: ${ip}`);
          resolve(true);
        } else {
          resolve(false); // IP não estava bloqueado
        }
      });
    });
  }
  
  /**
   * Registra tentativa de acesso de IP bloqueado
   * @param {string} ip - Endereço IP
   * @returns {Promise<void>}
   */
  function recordBlockedAttempt(ip) {
    return new Promise((resolve) => {
      if (!db) {
        resolve();
        return;
      }
      
      const now = Math.floor(Date.now() / 1000);
      
      db.run(`
        UPDATE blocked_ips 
        SET last_seen = ?, request_count = request_count + 1 
        WHERE ip = ?
      `, [now, ip], (error) => {
        if (error) {
          dbg(`[IP-BLOCKER] Erro ao registrar tentativa:`, error.message);
        }
        resolve();
      });
    });
  }
  
  /**
   * Registra tentativa de acesso de IP na whitelist
   * @param {string} ip - Endereço IP
   * @returns {Promise<void>}
   */
  function recordWhitelistAttempt(ip) {
    return new Promise((resolve) => {
      if (!db) {
        resolve();
        return;
      }
      
      const now = Math.floor(Date.now() / 1000);
      
      db.run(`
        UPDATE ip_whitelist 
        SET last_seen = ?, request_count = request_count + 1 
        WHERE ip = ? AND expires_at > ?
      `, [now, ip, now], (error) => {
        if (error) {
          dbg(`[IP-BLOCKER] Erro ao registrar tentativa whitelist:`, error.message);
        }
        resolve();
      });
    });
  }
  
  /**
   * Registra tentativa de acesso de IP na yellowlist
   * @param {string} ip - Endereço IP
   * @returns {Promise<void>}
   */
  function recordYellowlistAttempt(ip) {
    return new Promise((resolve) => {
      if (!db) {
        resolve();
        return;
      }
      
      const now = Math.floor(Date.now() / 1000);
      
      db.run(`
        UPDATE ip_yellowlist 
        SET last_seen = ?, request_count = request_count + 1 
        WHERE ip = ? AND expires_at > ?
      `, [now, ip, now], (error) => {
        if (error) {
          dbg(`[IP-BLOCKER] Erro ao registrar tentativa yellowlist:`, error.message);
        }
        resolve();
      });
    });
  }
  
  /**
   * Registra tentativa de acesso e determina em qual lista o IP está
   * @param {string} ip - Endereço IP
   * @returns {Promise<{listType: string|null, updated: boolean}>}
   */
  function recordIPAttempt(ip) {
    return new Promise(async (resolve) => {
      if (!db) {
        resolve({ listType: null, updated: false });
        return;
      }
      
      const now = Math.floor(Date.now() / 1000);
      
      // Verifica se está bloqueado
      db.get('SELECT ip FROM blocked_ips WHERE ip = ?', [ip], async (error, row) => {
        if (error) {
          resolve({ listType: null, updated: false });
          return;
        }
        
        if (row) {
          await recordBlockedAttempt(ip);
          resolve({ listType: 'blocked', updated: true });
          return;
        }
        
        // Verifica se está na whitelist
        db.get('SELECT ip FROM ip_whitelist WHERE ip = ? AND expires_at > ?', [ip, now], async (error, row) => {
          if (error) {
            resolve({ listType: null, updated: false });
            return;
          }
          
          if (row) {
            await recordWhitelistAttempt(ip);
            resolve({ listType: 'whitelist', updated: true });
            return;
          }
          
          // Verifica se está na yellowlist
          db.get('SELECT ip FROM ip_yellowlist WHERE ip = ? AND expires_at > ?', [ip, now], async (error, row) => {
            if (error) {
              resolve({ listType: null, updated: false });
              return;
            }
            
            if (row) {
              await recordYellowlistAttempt(ip);
              resolve({ listType: 'yellowlist', updated: true });
              return;
            }
            
            resolve({ listType: null, updated: false });
          });
        });
      });
    });
  }
  
  /**
   * Lista todos os IPs bloqueados
   * @param {number} limit - Limite de resultados
   * @param {number} offset - Offset para paginação
   * @returns {Promise<Array>} Lista de IPs bloqueados
   */
  function listBlockedIPs(limit = 100, offset = 0) {
    return new Promise(async (resolve, reject) => {
      dbg(`[IP-BLOCKER] listBlockedIPs chamado - db é ${db ? 'disponível' : 'null'}, dbReady=${dbReady}`);
      
      // Aguarda o banco estar pronto se ainda não estiver
      if (!dbReady) {
        dbg(`[IP-BLOCKER] Aguardando inicialização do banco...`);
        try {
          await dbReadyPromise;
        } catch (e) {
          err(`[IP-BLOCKER] Erro ao aguardar inicialização:`, e.message);
          resolve([]);
          return;
        }
      }
      
      if (!db) {
        err(`[IP-BLOCKER] ⚠️ Banco de dados não inicializado ao listar IPs bloqueados`);
        resolve([]);
        return;
      }
      
      const sql = `
        SELECT ip, reason, blocked_at, last_seen, request_count, created_at,
               abuse_confidence, reports, country_code, isp, domain, usage_type, is_tor, num_distinct_users
        FROM blocked_ips
        ORDER BY blocked_at DESC
        LIMIT ? OFFSET ?
      `;
      log(`[IP-BLOCKER] 🔍 SQL: ${sql.trim()}`);
      log(`[IP-BLOCKER] 🔍 Parâmetros: [${limit}, ${offset}]`);
      log(`[IP-BLOCKER] Listando IPs bloqueados: limit=${limit}, offset=${offset}`);
      
      db.all(sql, [limit, offset], (error, rows) => {
        if (error) {
          err(`[IP-BLOCKER] ❌ Erro ao listar IPs bloqueados:`, error.message);
          err(`[IP-BLOCKER] ❌ SQL: ${sql.trim()}`);
          err(`[IP-BLOCKER] ❌ Parâmetros: [${limit}, ${offset}]`);
          err(`[IP-BLOCKER] Stack:`, error.stack);
          reject(error);
          return;
        }
        
        log(`[IP-BLOCKER] ✅ SQL executado com sucesso`);
        log(`[IP-BLOCKER] ✅ Resultado: ${rows ? rows.length : 0} linha(s) retornada(s)`);
        if (rows && rows.length > 0) {
          log(`[IP-BLOCKER] ✅ Primeiro IP: ${JSON.stringify(rows[0])}`);
        }
        resolve(rows || []);
      });
    });
  }
  
  /**
   * Conta total de IPs bloqueados
   * @returns {Promise<number>} Número de IPs bloqueados
   */
  function countBlockedIPs() {
    return new Promise(async (resolve) => {
      log(`[IP-BLOCKER] 🔍 countBlockedIPs CHAMADO - db é ${db ? 'disponível' : 'null'}, dbReady=${dbReady}`);
      
      // Aguarda o banco estar pronto se ainda não estiver
      if (!dbReady) {
        log(`[IP-BLOCKER] ⏳ Aguardando inicialização do banco...`);
        try {
          await dbReadyPromise;
          log(`[IP-BLOCKER] ✅ Banco inicializado, continuando...`);
        } catch (e) {
          err(`[IP-BLOCKER] ❌ Erro ao aguardar inicialização:`, e.message);
          resolve(0);
          return;
        }
      }
      
      if (!db) {
        err(`[IP-BLOCKER] ⚠️ Banco de dados não inicializado ao contar IPs bloqueados`);
        err(`[IP-BLOCKER] ⚠️ DB_PATH: ${DB_PATH}`);
        resolve(0);
        return;
      }
      
      const sql = 'SELECT COUNT(*) as count FROM blocked_ips';
      log(`[IP-BLOCKER] 🔍 SQL: ${sql}`);
      log(`[IP-BLOCKER] 🔍 Executando SELECT COUNT(*) FROM blocked_ips`);
      
      db.get(sql, [], (error, row) => {
        if (error) {
          err(`[IP-BLOCKER] ❌ Erro ao contar IPs bloqueados:`, error.message);
          err(`[IP-BLOCKER] ❌ SQL: ${sql}`);
          err(`[IP-BLOCKER] Stack:`, error.stack);
          resolve(0);
          return;
        }
        
        const count = row ? row.count : 0;
        log(`[IP-BLOCKER] ✅ SQL executado com sucesso`);
        log(`[IP-BLOCKER] ✅ Resultado: row=${JSON.stringify(row)}, count=${count}`);
        log(`[IP-BLOCKER] ✅ Total de IPs bloqueados: ${count}`);
        resolve(count);
      });
    });
  }
  
  /**
   * Lista IPs na whitelist
   * @param {number} limit - Limite de resultados
   * @param {number} offset - Offset para paginação
   * @returns {Promise<Array>} Lista de IPs na whitelist
   */
  function listWhitelistIPs(limit = 100, offset = 0) {
    return new Promise(async (resolve, reject) => {
      dbg(`[IP-BLOCKER] listWhitelistIPs chamado - db é ${db ? 'disponível' : 'null'}, dbReady=${dbReady}`);
      
      // Aguarda o banco estar pronto se ainda não estiver
      if (!dbReady) {
        dbg(`[IP-BLOCKER] Aguardando inicialização do banco...`);
        try {
          await dbReadyPromise;
        } catch (e) {
          err(`[IP-BLOCKER] Erro ao aguardar inicialização:`, e.message);
          resolve([]);
          return;
        }
      }
      
      if (!db) {
        err(`[IP-BLOCKER] ⚠️ Banco de dados não inicializado ao listar whitelist`);
        resolve([]);
        return;
      }
      
      const now = Math.floor(Date.now() / 1000);
      const sql = `
        SELECT ip, abuse_confidence, reports, request_count, last_seen, created_at, expires_at,
               country_code, isp, domain, usage_type, is_tor, num_distinct_users
        FROM ip_whitelist
        WHERE expires_at > ?
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `;
      log(`[IP-BLOCKER] 🔍 SQL: ${sql.trim()}`);
      log(`[IP-BLOCKER] 🔍 Parâmetros: [${now}, ${limit}, ${offset}]`);
      log(`[IP-BLOCKER] Listando whitelist: limit=${limit}, offset=${offset}, now=${now}`);
      
      db.all(sql, [now, limit, offset], (error, rows) => {
        if (error) {
          err(`[IP-BLOCKER] ❌ Erro ao listar whitelist:`, error.message);
          err(`[IP-BLOCKER] ❌ SQL: ${sql.trim()}`);
          err(`[IP-BLOCKER] ❌ Parâmetros: [${now}, ${limit}, ${offset}]`);
          err(`[IP-BLOCKER] Stack:`, error.stack);
          reject(error);
          return;
        }
        
        log(`[IP-BLOCKER] ✅ SQL executado com sucesso`);
        log(`[IP-BLOCKER] ✅ Resultado: ${rows ? rows.length : 0} linha(s) retornada(s)`);
        if (rows && rows.length > 0) {
          log(`[IP-BLOCKER] ✅ Primeiro IP whitelist: ${JSON.stringify(rows[0])}`);
          // Log detalhado do primeiro IP para debug
          const first = rows[0];
          const nowCheck = Math.floor(Date.now() / 1000);
          log(`[IP-BLOCKER] ✅ Debug primeiro IP: ip=${first.ip}, expires_at=${first.expires_at}, now=${nowCheck}, válido=${first.expires_at > nowCheck}`);
          
          // Verifica se o IP 177.30.183.227 está na lista
          const targetIP = rows.find(r => r.ip === '177.30.183.227');
          if (targetIP) {
            log(`[IP-BLOCKER] ✅ IP 177.30.183.227 ENCONTRADO na lista: expires_at=${targetIP.expires_at}, now=${nowCheck}, válido=${targetIP.expires_at > nowCheck}`);
          } else {
            log(`[IP-BLOCKER] ⚠️ IP 177.30.183.227 NÃO encontrado na lista retornada (${rows.length} IPs retornados)`);
            // Lista todos os IPs retornados para debug
            log(`[IP-BLOCKER] 📋 IPs retornados: ${rows.map(r => r.ip).join(', ')}`);
          }
        } else {
          log(`[IP-BLOCKER] ⚠️ Nenhuma linha retornada da query whitelist`);
        }
        resolve(rows || []);
      });
    });
  }
  
  /**
   * Lista IPs na yellowlist
   * @param {number} limit - Limite de resultados
   * @param {number} offset - Offset para paginação
   * @returns {Promise<Array>} Lista de IPs na yellowlist
   */
  function listYellowlistIPs(limit = 100, offset = 0) {
    return new Promise(async (resolve, reject) => {
      dbg(`[IP-BLOCKER] listYellowlistIPs chamado - db é ${db ? 'disponível' : 'null'}, dbReady=${dbReady}`);
      
      // Aguarda o banco estar pronto se ainda não estiver
      if (!dbReady) {
        dbg(`[IP-BLOCKER] Aguardando inicialização do banco...`);
        try {
          await dbReadyPromise;
        } catch (e) {
          err(`[IP-BLOCKER] Erro ao aguardar inicialização:`, e.message);
          resolve([]);
          return;
        }
      }
      
      if (!db) {
        err(`[IP-BLOCKER] ⚠️ Banco de dados não inicializado ao listar yellowlist`);
        resolve([]);
        return;
      }
      
      const now = Math.floor(Date.now() / 1000);
      const sql = `
        SELECT ip, abuse_confidence, reports, request_count, last_seen, created_at, expires_at,
               country_code, isp, domain, usage_type, is_tor, num_distinct_users
        FROM ip_yellowlist
        WHERE expires_at > ?
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `;
      log(`[IP-BLOCKER] 🔍 SQL: ${sql.trim()}`);
      log(`[IP-BLOCKER] 🔍 Parâmetros: [${now}, ${limit}, ${offset}]`);
      log(`[IP-BLOCKER] Listando yellowlist: limit=${limit}, offset=${offset}, now=${now}`);
      
      db.all(sql, [now, limit, offset], (error, rows) => {
        if (error) {
          err(`[IP-BLOCKER] ❌ Erro ao listar yellowlist:`, error.message);
          err(`[IP-BLOCKER] ❌ SQL: ${sql.trim()}`);
          err(`[IP-BLOCKER] ❌ Parâmetros: [${now}, ${limit}, ${offset}]`);
          err(`[IP-BLOCKER] Stack:`, error.stack);
          reject(error);
          return;
        }
        
        log(`[IP-BLOCKER] ✅ SQL executado com sucesso`);
        log(`[IP-BLOCKER] ✅ Resultado: ${rows ? rows.length : 0} linha(s) retornada(s)`);
        if (rows && rows.length > 0) {
          log(`[IP-BLOCKER] ✅ Primeiro IP yellowlist: ${JSON.stringify(rows[0])}`);
        }
        resolve(rows || []);
      });
    });
  }
  
  /**
   * Conta total de IPs na whitelist
   * @returns {Promise<number>} Número de IPs na whitelist
   */
  function countWhitelistIPs() {
    return new Promise(async (resolve) => {
      log(`[IP-BLOCKER] 🔍 countWhitelistIPs CHAMADO - db é ${db ? 'disponível' : 'null'}, dbReady=${dbReady}`);
      
      // Aguarda o banco estar pronto se ainda não estiver
      if (!dbReady) {
        log(`[IP-BLOCKER] ⏳ Aguardando inicialização do banco...`);
        try {
          await dbReadyPromise;
          log(`[IP-BLOCKER] ✅ Banco inicializado, continuando...`);
        } catch (e) {
          err(`[IP-BLOCKER] ❌ Erro ao aguardar inicialização:`, e.message);
          resolve(0);
          return;
        }
      }
      
      if (!db) {
        err(`[IP-BLOCKER] ⚠️ Banco de dados não inicializado ao contar whitelist`);
        err(`[IP-BLOCKER] ⚠️ DB_PATH: ${DB_PATH}`);
        resolve(0);
        return;
      }
      
      const now = Math.floor(Date.now() / 1000);
      const sql = 'SELECT COUNT(*) as count FROM ip_whitelist WHERE expires_at > ?';
      log(`[IP-BLOCKER] 🔍 SQL: ${sql}`);
      log(`[IP-BLOCKER] 🔍 Parâmetros: [${now}]`);
      log(`[IP-BLOCKER] 🔍 Executando SELECT COUNT(*) FROM ip_whitelist WHERE expires_at > ${now}`);
      
      db.get(sql, [now], (error, row) => {
        if (error) {
          err(`[IP-BLOCKER] ❌ Erro ao contar whitelist:`, error.message);
          err(`[IP-BLOCKER] ❌ SQL: ${sql}`);
          err(`[IP-BLOCKER] ❌ Parâmetros: [${now}]`);
          err(`[IP-BLOCKER] Stack:`, error.stack);
          resolve(0);
          return;
        }
        
        const count = row ? row.count : 0;
        log(`[IP-BLOCKER] ✅ SQL executado com sucesso`);
        log(`[IP-BLOCKER] ✅ Resultado: row=${JSON.stringify(row)}, count=${count}`);
        log(`[IP-BLOCKER] ✅ Total na whitelist: ${count}`);
        resolve(count);
      });
    });
  }
  
  /**
   * Conta total de IPs na yellowlist
   * @returns {Promise<number>} Número de IPs na yellowlist
   */
  function countYellowlistIPs() {
    return new Promise(async (resolve) => {
      log(`[IP-BLOCKER] 🔍 countYellowlistIPs CHAMADO - db é ${db ? 'disponível' : 'null'}, dbReady=${dbReady}`);
      
      // Aguarda o banco estar pronto se ainda não estiver
      if (!dbReady) {
        log(`[IP-BLOCKER] ⏳ Aguardando inicialização do banco...`);
        try {
          await dbReadyPromise;
          log(`[IP-BLOCKER] ✅ Banco inicializado, continuando...`);
        } catch (e) {
          err(`[IP-BLOCKER] ❌ Erro ao aguardar inicialização:`, e.message);
          resolve(0);
          return;
        }
      }
      
      if (!db) {
        err(`[IP-BLOCKER] ⚠️ Banco de dados não inicializado ao contar yellowlist`);
        err(`[IP-BLOCKER] ⚠️ DB_PATH: ${DB_PATH}`);
        resolve(0);
        return;
      }
      
      const now = Math.floor(Date.now() / 1000);
      const sql = 'SELECT COUNT(*) as count FROM ip_yellowlist WHERE expires_at > ?';
      log(`[IP-BLOCKER] 🔍 SQL: ${sql}`);
      log(`[IP-BLOCKER] 🔍 Parâmetros: [${now}]`);
      log(`[IP-BLOCKER] 🔍 Executando SELECT COUNT(*) FROM ip_yellowlist WHERE expires_at > ${now}`);
      
      db.get(sql, [now], (error, row) => {
        if (error) {
          err(`[IP-BLOCKER] ❌ Erro ao contar yellowlist:`, error.message);
          err(`[IP-BLOCKER] ❌ SQL: ${sql}`);
          err(`[IP-BLOCKER] ❌ Parâmetros: [${now}]`);
          err(`[IP-BLOCKER] Stack:`, error.stack);
          resolve(0);
          return;
        }
        
        const count = row ? row.count : 0;
        log(`[IP-BLOCKER] ✅ SQL executado com sucesso`);
        log(`[IP-BLOCKER] ✅ Resultado: row=${JSON.stringify(row)}, count=${count}`);
        log(`[IP-BLOCKER] ✅ Total na yellowlist: ${count}`);
        resolve(count);
      });
    });
  }
  
  /**
   * Verifica e corrige duplicidades no banco de dados
   * Um IP não pode estar em múltiplas listas simultaneamente
   * Prioridade: blacklist > yellowlist > whitelist
   * @returns {Promise<{removed: number, duplicates: Array}>} Número de duplicidades removidas
   */
  function checkAndFixDuplicates() {
    return new Promise((resolve, reject) => {
      if (!db) {
        resolve({ removed: 0, duplicates: [] });
        return;
      }
      
      const now = Math.floor(Date.now() / 1000);
      let totalRemoved = 0;
      const duplicates = [];
      
      // Busca IPs que estão em múltiplas listas
      db.all(`
        SELECT 
          w.ip as whitelist_ip,
          y.ip as yellowlist_ip,
          b.ip as blacklist_ip
        FROM 
          (SELECT ip FROM ip_whitelist WHERE expires_at > ?) w
        LEFT JOIN 
          (SELECT ip FROM ip_yellowlist WHERE expires_at > ?) y ON w.ip = y.ip
        LEFT JOIN 
          (SELECT ip FROM blocked_ips) b ON w.ip = b.ip OR y.ip = b.ip
        WHERE y.ip IS NOT NULL OR b.ip IS NOT NULL
        
        UNION
        
        SELECT 
          w.ip as whitelist_ip,
          y.ip as yellowlist_ip,
          b.ip as blacklist_ip
        FROM 
          (SELECT ip FROM ip_yellowlist WHERE expires_at > ?) y
        LEFT JOIN 
          (SELECT ip FROM ip_whitelist WHERE expires_at > ?) w ON y.ip = w.ip
        LEFT JOIN 
          (SELECT ip FROM blocked_ips) b ON y.ip = b.ip
        WHERE w.ip IS NOT NULL OR b.ip IS NOT NULL
        
        UNION
        
        SELECT 
          w.ip as whitelist_ip,
          y.ip as yellowlist_ip,
          b.ip as blacklist_ip
        FROM 
          (SELECT ip FROM blocked_ips) b
        LEFT JOIN 
          (SELECT ip FROM ip_whitelist WHERE expires_at > ?) w ON b.ip = w.ip
        LEFT JOIN 
          (SELECT ip FROM ip_yellowlist WHERE expires_at > ?) y ON b.ip = y.ip
        WHERE w.ip IS NOT NULL OR y.ip IS NOT NULL
      `, [now, now, now, now, now, now], (error, rows) => {
        if (error) {
          err(`[IP-BLOCKER] Erro ao verificar duplicidades:`, error.message);
          reject(error);
          return;
        }
        
        if (rows.length === 0) {
          log(`[IP-BLOCKER] Nenhuma duplicidade encontrada`);
          resolve({ removed: 0, duplicates: [] });
          return;
        }
        
        // Processa duplicidades com prioridade: blacklist > yellowlist > whitelist
        const promises = rows.map(row => {
          const ip = row.blacklist_ip || row.yellowlist_ip || row.whitelist_ip;
          if (!ip) return Promise.resolve();
          
          duplicates.push({
            ip,
            inBlacklist: !!row.blacklist_ip,
            inYellowlist: !!row.yellowlist_ip,
            inWhitelist: !!row.whitelist_ip
          });
          
          // Se está na blacklist, remove das outras
          if (row.blacklist_ip) {
            return new Promise((res) => {
              let removed = 0;
              db.run('DELETE FROM ip_whitelist WHERE ip = ?', [ip], function(err) {
                if (err) {
                  dbg(`[IP-BLOCKER] Erro ao remover da whitelist:`, err.message);
                } else {
                  removed += this.changes || 0;
                }
                db.run('DELETE FROM ip_yellowlist WHERE ip = ?', [ip], function(err2) {
                  if (err2) {
                    dbg(`[IP-BLOCKER] Erro ao remover da yellowlist:`, err2.message);
                  } else {
                    removed += this.changes || 0;
                  }
                  totalRemoved += removed;
                  if (removed > 0) {
                    dbg(`[IP-BLOCKER] Removido IP ${ip} de whitelist/yellowlist (já está na blacklist)`);
                  }
                  res();
                });
              });
            });
          }
          
          // Se está na yellowlist, remove da whitelist
          if (row.yellowlist_ip && !row.blacklist_ip) {
            return new Promise((res) => {
              db.run('DELETE FROM ip_whitelist WHERE ip = ?', [ip], function(err) {
                if (err) {
                  dbg(`[IP-BLOCKER] Erro ao remover da whitelist:`, err.message);
                } else {
                  const removed = this.changes || 0;
                  totalRemoved += removed;
                  if (removed > 0) {
                    dbg(`[IP-BLOCKER] Removido IP ${ip} da whitelist (já está na yellowlist)`);
                  }
                }
                res();
              });
            });
          }
          
          return Promise.resolve();
        });
        
        Promise.all(promises).then(() => {
          if (totalRemoved > 0) {
            log(`[IP-BLOCKER] ${totalRemoved} duplicidade(s) corrigida(s)`);
          }
          resolve({ removed: totalRemoved, duplicates });
        }).catch(reject);
      });
    });
  }
  
  /**
   * Adiciona IP à whitelist
   * Remove o IP de outras listas primeiro para evitar duplicidade
   * @param {string} ip - Endereço IP
   * @param {number} abuseConfidence - Confiança de abuso (0-100)
   * @param {number} reports - Número de reports
   * @param {number} ttlDays - Tempo de vida em dias (padrão: 15)
   * @param {Object} extraData - Dados extras do AbuseIPDB (opcional)
   * @returns {Promise<boolean>} true se adicionado com sucesso
   */
  function addToWhitelist(ip, abuseConfidence, reports = 0, ttlDays = 15, extraData = {}) {
    return new Promise(async (resolve, reject) => {
      if (!db) {
        reject(new Error('Banco de dados não inicializado'));
        return;
      }
      
      try {
        // Verifica se o IP já está em outra lista para registrar migração
        const wasBlocked = await isBlocked(ip);
        const wasInYellowlist = await isInYellowlist(ip);
        const wasInWhitelist = await isInWhitelist(ip);
        
        let fromList = null;
        let oldConfidence = null;
        let oldReports = null;
        
        if (wasBlocked) {
          fromList = 'blacklist';
        } else if (wasInYellowlist.inYellowlist) {
          fromList = 'yellowlist';
          oldConfidence = wasInYellowlist.abuseConfidence;
          // Busca reports antigos
          await new Promise((res) => {
            db.get('SELECT reports FROM ip_yellowlist WHERE ip = ?', [ip], (err, row) => {
              if (row) oldReports = row.reports;
              res();
            });
          });
        } else if (wasInWhitelist.inWhitelist) {
          fromList = 'whitelist';
          oldConfidence = wasInWhitelist.abuseConfidence;
          // Busca reports antigos
          await new Promise((res) => {
            db.get('SELECT reports FROM ip_whitelist WHERE ip = ?', [ip], (err, row) => {
              if (row) oldReports = row.reports;
              res();
            });
          });
        }
        
        // Remove de outras listas primeiro (evita duplicidade)
        await removeFromOtherLists(ip, 'whitelist');
        
        const now = Math.floor(Date.now() / 1000);
        const expiresAt = now + (ttlDays * 24 * 60 * 60);
        
        // Extrai dados extras
        const countryCode = extraData.countryCode || '';
        const isp = extraData.isp || '';
        const domain = extraData.domain || '';
        const usageType = extraData.usageType || '';
        const isTor = extraData.isTor ? 1 : 0;
        const numDistinctUsers = extraData.numDistinctUsers || 0;
        
        // Se o IP já existe, mantém request_count e last_seen, apenas atualiza outros campos
        // Se não existe, cria com request_count=1 e last_seen=now
        db.run(`
          INSERT INTO ip_whitelist (ip, abuse_confidence, reports, request_count, last_seen, created_at, expires_at, country_code, isp, domain, usage_type, is_tor, num_distinct_users)
          VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(ip) DO UPDATE SET
            abuse_confidence = excluded.abuse_confidence,
            reports = excluded.reports,
            expires_at = excluded.expires_at,
            last_seen = excluded.last_seen,
            request_count = request_count + 1,
            country_code = excluded.country_code,
            isp = excluded.isp,
            domain = excluded.domain,
            usage_type = excluded.usage_type,
            is_tor = excluded.is_tor,
            num_distinct_users = excluded.num_distinct_users
        `, [ip, abuseConfidence, reports, now, now, expiresAt, countryCode, isp, domain, usageType, isTor, numDistinctUsers], function(error) {
          if (error) {
            err(`[IP-BLOCKER] Erro ao adicionar à whitelist:`, error.message);
            reject(error);
            return;
          }
          
          // Registra migração se mudou de lista
          if (fromList && fromList !== 'whitelist') {
            logMigration(ip, fromList, 'whitelist', oldConfidence, abuseConfidence, oldReports, reports, 'Classificação automática pelo AbuseIPDB');
          }
          
          // Invalida caches para este IP
          blockedCache.delete(`blocked:${ip}`);
          whitelistCache.delete(`whitelist:${ip}`);
          yellowlistCache.delete(`yellowlist:${ip}`);
          
          dbg(`[IP-BLOCKER] IP adicionado à whitelist: ${ip} (${abuseConfidence}% confiança, ${countryCode || 'país desconhecido'}, válido até ${new Date(expiresAt * 1000).toISOString()})`);
          resolve(true);
        });
      } catch (e) {
        reject(e);
      }
    });
  }
  
  /**
   * Adiciona IP à yellowlist
   * Remove o IP de outras listas primeiro para evitar duplicidade
   * @param {string} ip - Endereço IP
   * @param {number} abuseConfidence - Confiança de abuso (0-100)
   * @param {number} reports - Número de reports
   * @param {number} ttlDays - Tempo de vida em dias (padrão: 7)
   * @param {Object} extraData - Dados extras do AbuseIPDB (opcional)
   * @returns {Promise<boolean>} true se adicionado com sucesso
   */
  function addToYellowlist(ip, abuseConfidence, reports = 0, ttlDays = 7, extraData = {}) {
    return new Promise(async (resolve, reject) => {
      if (!db) {
        reject(new Error('Banco de dados não inicializado'));
        return;
      }
      
      try {
        // Verifica se o IP já está em outra lista para registrar migração
        const wasBlocked = await isBlocked(ip);
        const wasInYellowlist = await isInYellowlist(ip);
        const wasInWhitelist = await isInWhitelist(ip);
        
        let fromList = null;
        let oldConfidence = null;
        let oldReports = null;
        
        if (wasBlocked) {
          fromList = 'blacklist';
        } else if (wasInYellowlist.inYellowlist) {
          fromList = 'yellowlist';
          oldConfidence = wasInYellowlist.abuseConfidence;
          // Busca reports antigos
          const yellowlistData = await new Promise((res) => {
            db.get('SELECT reports FROM ip_yellowlist WHERE ip = ?', [ip], (err, row) => {
              if (row) oldReports = row.reports;
              res();
            });
          });
        } else if (wasInWhitelist.inWhitelist) {
          fromList = 'whitelist';
          oldConfidence = wasInWhitelist.abuseConfidence;
          // Busca reports antigos
          const whitelistData = await new Promise((res) => {
            db.get('SELECT reports FROM ip_whitelist WHERE ip = ?', [ip], (err, row) => {
              if (row) oldReports = row.reports;
              res();
            });
          });
        }
        
        // Remove de outras listas primeiro (evita duplicidade)
        await removeFromOtherLists(ip, 'yellowlist');
        
        const now = Math.floor(Date.now() / 1000);
        const expiresAt = now + (ttlDays * 24 * 60 * 60);
        
        // Extrai dados extras
        const countryCode = extraData.countryCode || '';
        const isp = extraData.isp || '';
        const domain = extraData.domain || '';
        const usageType = extraData.usageType || '';
        const isTor = extraData.isTor ? 1 : 0;
        const numDistinctUsers = extraData.numDistinctUsers || 0;
        
        // Se o IP já existe, mantém request_count e last_seen, apenas atualiza outros campos
        // Se não existe, cria com request_count=1 e last_seen=now
        db.run(`
          INSERT INTO ip_yellowlist (ip, abuse_confidence, reports, request_count, last_seen, created_at, expires_at, country_code, isp, domain, usage_type, is_tor, num_distinct_users)
          VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(ip) DO UPDATE SET
            abuse_confidence = excluded.abuse_confidence,
            reports = excluded.reports,
            expires_at = excluded.expires_at,
            last_seen = excluded.last_seen,
            request_count = request_count + 1,
            country_code = excluded.country_code,
            isp = excluded.isp,
            domain = excluded.domain,
            usage_type = excluded.usage_type,
            is_tor = excluded.is_tor,
            num_distinct_users = excluded.num_distinct_users
        `, [ip, abuseConfidence, reports, now, now, expiresAt, countryCode, isp, domain, usageType, isTor, numDistinctUsers], function(error) {
          if (error) {
            err(`[IP-BLOCKER] Erro ao adicionar à yellowlist:`, error.message);
            reject(error);
            return;
          }
          
          // Registra migração se mudou de lista
          if (fromList && fromList !== 'yellowlist') {
            logMigration(ip, fromList, 'yellowlist', oldConfidence, abuseConfidence, oldReports, reports, 'Classificação automática pelo AbuseIPDB');
          }
          
          // Invalida caches para este IP
          blockedCache.delete(`blocked:${ip}`);
          whitelistCache.delete(`whitelist:${ip}`);
          yellowlistCache.delete(`yellowlist:${ip}`);
          
          dbg(`[IP-BLOCKER] IP adicionado à yellowlist: ${ip} (${abuseConfidence}% confiança, válido até ${new Date(expiresAt * 1000).toISOString()})`);
          resolve(true);
        });
      } catch (e) {
        reject(e);
      }
    });
  }
  
  /**
   * Verifica se IP está na whitelist e ainda válido (com cache)
   * @param {string} ip - Endereço IP
   * @returns {Promise<{inWhitelist: boolean, abuseConfidence: number, expiresAt: number}>}
   */
  function isInWhitelist(ip) {
    return new Promise((resolve) => {
      if (!db) {
        resolve({ inWhitelist: false });
        return;
      }
      
      // Verifica cache primeiro
      const cached = whitelistCache.get(`whitelist:${ip}`);
      if (cached !== undefined) {
        resolve(cached);
        return;
      }
      
      const now = Math.floor(Date.now() / 1000);
      
      db.get(`
        SELECT ip, abuse_confidence, expires_at, request_count, last_seen
        FROM ip_whitelist 
        WHERE ip = ? AND expires_at > ?
      `, [ip, now], (error, row) => {
        if (error) {
          dbg(`[IP-BLOCKER] Erro ao verificar whitelist:`, error.message);
          resolve({ inWhitelist: false });
          return;
        }
        
        if (row) {
          dbg(`[IP-BLOCKER] IP ${ip} encontrado na whitelist: expires_at=${row.expires_at}, now=${now}, válido=${row.expires_at > now}`);
          const result = {
            inWhitelist: true,
            abuseConfidence: row.abuse_confidence,
            expiresAt: row.expires_at,
            requestCount: row.request_count || 0,
            lastSeen: row.last_seen
          };
          whitelistCache.set(`whitelist:${ip}`, result);
          resolve(result);
        } else {
          // Verifica se o IP existe mas está expirado
          db.get(`SELECT ip, expires_at FROM ip_whitelist WHERE ip = ?`, [ip], (checkError, expiredRow) => {
            if (expiredRow) {
              dbg(`[IP-BLOCKER] IP ${ip} existe na whitelist mas está EXPIRADO: expires_at=${expiredRow.expires_at}, now=${now}`);
            }
            const result = { inWhitelist: false };
            whitelistCache.set(`whitelist:${ip}`, result);
            resolve(result);
          });
        }
      });
    });
  }
  
  /**
   * Verifica se IP está na yellowlist e ainda válido (com cache)
   * @param {string} ip - Endereço IP
   * @returns {Promise<{inYellowlist: boolean, abuseConfidence: number, expiresAt: number}>}
   */
  function isInYellowlist(ip) {
    return new Promise((resolve) => {
      if (!db) {
        resolve({ inYellowlist: false });
        return;
      }
      
      // Verifica cache primeiro
      const cached = yellowlistCache.get(`yellowlist:${ip}`);
      if (cached !== undefined) {
        resolve(cached);
        return;
      }
      
      const now = Math.floor(Date.now() / 1000);
      
      db.get(`
        SELECT ip, abuse_confidence, expires_at, request_count, last_seen
        FROM ip_yellowlist 
        WHERE ip = ? AND expires_at > ?
      `, [ip, now], (error, row) => {
        if (error) {
          dbg(`[IP-BLOCKER] Erro ao verificar yellowlist:`, error.message);
          resolve({ inYellowlist: false });
          return;
        }
        
        if (row) {
          const result = {
            inYellowlist: true,
            abuseConfidence: row.abuse_confidence,
            expiresAt: row.expires_at,
            requestCount: row.request_count || 0,
            lastSeen: row.last_seen
          };
          yellowlistCache.set(`yellowlist:${ip}`, result);
          resolve(result);
        } else {
          const result = { inYellowlist: false };
          yellowlistCache.set(`yellowlist:${ip}`, result);
          resolve(result);
        }
      });
    });
  }
  
  /**
   * Remove IP da whitelist
   * @param {string} ip - Endereço IP
   * @returns {Promise<boolean>}
   */
  function removeFromWhitelist(ip) {
    return new Promise((resolve, reject) => {
      if (!db) {
        reject(new Error('Banco de dados não inicializado'));
        return;
      }
      
      db.run('DELETE FROM ip_whitelist WHERE ip = ?', [ip], function(error) {
        if (error) {
          err(`[IP-BLOCKER] Erro ao remover da whitelist:`, error.message);
          reject(error);
          return;
        }
        
        // Invalida cache
        whitelistCache.delete(`whitelist:${ip}`);
        
        if (this.changes > 0) {
          log(`[IP-BLOCKER] IP ${ip} removido da whitelist`);
          resolve(true);
        } else {
          dbg(`[IP-BLOCKER] IP ${ip} não encontrado na whitelist`);
          resolve(false);
        }
      });
    });
  }
  
  /**
   * Remove IP da yellowlist
   * @param {string} ip - Endereço IP
   * @returns {Promise<boolean>}
   */
  function removeFromYellowlist(ip) {
    return new Promise((resolve, reject) => {
      if (!db) {
        reject(new Error('Banco de dados não inicializado'));
        return;
      }
      
      db.run('DELETE FROM ip_yellowlist WHERE ip = ?', [ip], function(error) {
        if (error) {
          err(`[IP-BLOCKER] Erro ao remover da yellowlist:`, error.message);
          reject(error);
          return;
        }
        
        // Invalida cache
        yellowlistCache.delete(`yellowlist:${ip}`);
        
        if (this.changes > 0) {
          log(`[IP-BLOCKER] IP ${ip} removido da yellowlist`);
          resolve(true);
        } else {
          dbg(`[IP-BLOCKER] IP ${ip} não encontrado na yellowlist`);
          resolve(false);
        }
      });
    });
  }
  
  /**
   * Registra migração de IP entre listas
   * @param {string} ip - Endereço IP
   * @param {string} fromList - Lista de origem (null se novo)
   * @param {string} toList - Lista de destino
   * @param {number} oldConfidence - Confiança anterior (opcional)
   * @param {number} newConfidence - Nova confiança
   * @param {number} oldReports - Reports anteriores (opcional)
   * @param {number} newReports - Novos reports
   * @param {string} reason - Motivo da migração
   * @returns {Promise<void>}
   */
  function logMigration(ip, fromList, toList, oldConfidence = null, newConfidence = null, oldReports = null, newReports = null, reason = '') {
    return new Promise((resolve) => {
      if (!db) {
        resolve();
        return;
      }
      
      const now = Math.floor(Date.now() / 1000);
      
      db.run(`
        INSERT INTO ip_migration_log (ip, from_list, to_list, old_confidence, new_confidence, old_reports, new_reports, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [ip, fromList, toList, oldConfidence, newConfidence, oldReports, newReports, reason, now], (error) => {
        if (error) {
          dbg(`[IP-BLOCKER] Erro ao registrar migração:`, error.message);
        } else {
          dbg(`[IP-BLOCKER] Migração registrada: ${ip} de ${fromList || 'nenhuma'} para ${toList}`);
        }
        resolve();
      });
    });
  }
  
  /**
   * Lista logs de migração
   * @param {number} limit - Limite de resultados
   * @param {number} offset - Offset para paginação
   * @param {string} ip - Filtrar por IP (opcional)
   * @returns {Promise<Array>} Lista de logs de migração
   */
  function listMigrationLogs(limit = 100, offset = 0, ip = null) {
    return new Promise((resolve, reject) => {
      if (!db) {
        resolve([]);
        return;
      }
      
      let query = `
        SELECT * FROM ip_migration_log
      `;
      const params = [];
      
      if (ip) {
        query += ` WHERE ip = ?`;
        params.push(ip);
      }
      
      query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
      params.push(limit, offset);
      
      log(`[IP-BLOCKER] 🔍 SQL: ${query.trim()}`);
      log(`[IP-BLOCKER] 🔍 Parâmetros: [${params.join(', ')}]`);
      log(`[IP-BLOCKER] Listando migration logs: limit=${limit}, offset=${offset}, ip=${ip || 'todos'}`);
      
      db.all(query, params, (error, rows) => {
        if (error) {
          err(`[IP-BLOCKER] ❌ Erro ao listar logs de migração:`, error.message);
          err(`[IP-BLOCKER] ❌ SQL: ${query.trim()}`);
          err(`[IP-BLOCKER] ❌ Parâmetros: [${params.join(', ')}]`);
          err(`[IP-BLOCKER] Stack:`, error.stack);
          reject(error);
          return;
        }
        
        log(`[IP-BLOCKER] ✅ SQL executado com sucesso`);
        log(`[IP-BLOCKER] ✅ Resultado: ${rows ? rows.length : 0} linha(s) retornada(s)`);
        if (rows && rows.length > 0) {
          log(`[IP-BLOCKER] ✅ Primeiro log: ${JSON.stringify(rows[0])}`);
        }
        resolve(rows || []);
      });
    });
  }
  
  /**
   * Conta total de logs de migração
   * @param {string} ip - Filtrar por IP (opcional)
   * @returns {Promise<number>} Número de logs
   */
  function countMigrationLogs(ip = null) {
    return new Promise((resolve) => {
      if (!db) {
        resolve(0);
        return;
      }
      
      let query = `SELECT COUNT(*) as count FROM ip_migration_log`;
      const params = [];
      
      if (ip) {
        query += ` WHERE ip = ?`;
        params.push(ip);
      }
      
      log(`[IP-BLOCKER] 🔍 SQL: ${query}`);
      log(`[IP-BLOCKER] 🔍 Parâmetros: [${params.join(', ')}]`);
      log(`[IP-BLOCKER] Contando migration logs: ip=${ip || 'todos'}`);
      
      db.get(query, params, (error, row) => {
        if (error) {
          err(`[IP-BLOCKER] ❌ Erro ao contar logs de migração:`, error.message);
          err(`[IP-BLOCKER] ❌ SQL: ${query}`);
          err(`[IP-BLOCKER] ❌ Parâmetros: [${params.join(', ')}]`);
          err(`[IP-BLOCKER] Stack:`, error.stack);
          resolve(0);
          return;
        }
        
        const count = row ? row.count : 0;
        log(`[IP-BLOCKER] ✅ SQL executado com sucesso`);
        log(`[IP-BLOCKER] ✅ Resultado: row=${JSON.stringify(row)}, count=${count}`);
        log(`[IP-BLOCKER] ✅ Total de migration logs: ${count}`);
        resolve(count);
      });
    });
  }
  
  // ===== ADMIN SESSIONS =====
  
  /**
   * Salva uma sessão admin no banco
   */
  function saveAdminSession(sessionId, data) {
    return new Promise((resolve, reject) => {
      if (!db || !dbReady) {
        reject(new Error('Database not ready'));
        return;
      }
      
      db.run(`
        INSERT OR REPLACE INTO admin_sessions 
        (session_id, phone, device_fingerprint, device_name, ip_address, user_agent, trusted_until, created_at, expires_at, last_used_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        sessionId,
        data.phone,
        data.deviceFingerprint || null,
        data.deviceName || null,
        data.ipAddress || null,
        data.userAgent || null,
        data.trustedUntil || null,
        data.createdAt || Math.floor(Date.now() / 1000),
        data.expiresAt,
        data.lastUsedAt || Math.floor(Date.now() / 1000)
      ], (error) => {
        if (error) {
          dbg(`[IP-BLOCKER] Erro ao salvar sessão admin:`, error.message);
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
  
  /**
   * Busca uma sessão admin pelo ID
   */
  function getAdminSession(sessionId) {
    return new Promise((resolve) => {
      if (!db || !dbReady) {
        resolve(null);
        return;
      }
      
      db.get(`SELECT * FROM admin_sessions WHERE session_id = ?`, [sessionId], (error, row) => {
        if (error) {
          dbg(`[IP-BLOCKER] Erro ao buscar sessão admin:`, error.message);
          resolve(null);
        } else {
          resolve(row || null);
        }
      });
    });
  }
  
  /**
   * Busca sessão por fingerprint de dispositivo confiável
   */
  function getAdminSessionByFingerprint(fingerprint) {
    return new Promise((resolve) => {
      if (!db || !dbReady) {
        resolve(null);
        return;
      }
      
      const now = Math.floor(Date.now() / 1000);
      db.get(`
        SELECT * FROM admin_sessions 
        WHERE device_fingerprint = ? AND trusted_until > ?
        ORDER BY last_used_at DESC LIMIT 1
      `, [fingerprint, now], (error, row) => {
        if (error) {
          resolve(null);
        } else {
          resolve(row || null);
        }
      });
    });
  }
  
  /**
   * Atualiza último uso da sessão
   */
  function updateAdminSessionLastUsed(sessionId) {
    return new Promise((resolve) => {
      if (!db || !dbReady) {
        resolve();
        return;
      }
      
      const now = Math.floor(Date.now() / 1000);
      db.run(`UPDATE admin_sessions SET last_used_at = ? WHERE session_id = ?`, [now, sessionId], () => resolve());
    });
  }
  
  /**
   * Remove uma sessão admin
   */
  function deleteAdminSession(sessionId) {
    return new Promise((resolve) => {
      if (!db || !dbReady) {
        resolve();
        return;
      }
      
      db.run(`DELETE FROM admin_sessions WHERE session_id = ?`, [sessionId], () => resolve());
    });
  }
  
  /**
   * Remove sessões expiradas
   */
  function cleanExpiredAdminSessions() {
    return new Promise((resolve) => {
      if (!db || !dbReady) {
        resolve(0);
        return;
      }
      
      const now = Math.floor(Date.now() / 1000);
      db.run(`DELETE FROM admin_sessions WHERE expires_at < ? AND (trusted_until IS NULL OR trusted_until < ?)`, 
        [now, now], function(error) {
          resolve(this?.changes || 0);
        });
    });
  }
  
  /**
   * Lista dispositivos confiáveis de um telefone
   */
  function listTrustedDevices(phone) {
    return new Promise((resolve) => {
      if (!db || !dbReady) {
        resolve([]);
        return;
      }
      
      const now = Math.floor(Date.now() / 1000);
      db.all(`
        SELECT session_id, device_name, ip_address, trusted_until, created_at, last_used_at
        FROM admin_sessions 
        WHERE phone = ? AND trusted_until > ?
        ORDER BY last_used_at DESC
      `, [phone, now], (error, rows) => {
        resolve(rows || []);
      });
    });
  }
  
  /**
   * Revoga confiança de um dispositivo
   */
  function revokeTrustedDevice(sessionId) {
    return new Promise((resolve) => {
      if (!db || !dbReady) {
        resolve();
        return;
      }
      
      db.run(`UPDATE admin_sessions SET trusted_until = NULL WHERE session_id = ?`, [sessionId], () => resolve());
    });
  }
  
  // ===== ESP32 DEVICES =====
  
  /**
   * Registra/atualiza dispositivo ESP32
   */
  function updateESP32Device(ip, deviceName = null) {
    return new Promise(async (resolve) => {
      // Aguarda banco estar pronto
      if (!dbReady) {
        try {
          await dbReadyPromise;
        } catch (e) {
          dbg(`[IP-BLOCKER] updateESP32Device: erro ao aguardar banco para IP ${ip}:`, e.message);
          resolve();
          return;
        }
      }
      
      if (!db) {
        dbg(`[IP-BLOCKER] updateESP32Device: banco não inicializado para IP ${ip}`);
        resolve();
        return;
      }
      
      const now = Math.floor(Date.now() / 1000);
      db.run(`
        INSERT INTO esp32_devices (ip, device_name, last_seen, first_seen, request_count)
        VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(ip) DO UPDATE SET 
          last_seen = ?,
          device_name = COALESCE(?, device_name),
          request_count = request_count + 1
      `, [ip, deviceName, now, now, now, deviceName], function(error) {
        if (error) {
          dbg(`[IP-BLOCKER] Erro ao atualizar ESP32 device ${ip}:`, error.message);
        } else {
          log(`[IP-BLOCKER] ESP32 device ${ip} atualizado: last_seen=${now}, request_count=${this.changes > 0 ? 'incrementado' : 'novo'}`);
        }
        resolve();
      });
    });
  }
  
  /**
   * Lista dispositivos ESP32 online (visto nos últimos X segundos)
   */
  function listESP32Devices(onlineThresholdSeconds = 120) {
    return new Promise((resolve) => {
      if (!db || !dbReady) {
        resolve([]);
        return;
      }
      
      const now = Math.floor(Date.now() / 1000);
      const threshold = now - onlineThresholdSeconds;
      
      db.all(`
        SELECT ip, device_name, last_seen, first_seen, request_count,
               CASE WHEN last_seen >= ? THEN 1 ELSE 0 END as is_online
        FROM esp32_devices
        ORDER BY last_seen DESC
      `, [threshold], (error, rows) => {
        resolve(rows || []);
      });
    });
  }
  
  // ===== TUYA ENERGY READINGS =====
  
  /**
   * Salva leitura de energia
   */
  function saveTuyaEnergyReading(deviceId, deviceName, data) {
    return new Promise((resolve) => {
      if (!db || !dbReady) {
        resolve();
        return;
      }
      
      // Prepara dados de fases (se disponível)
      const phasesData = data.phases ? JSON.stringify(data.phases) : null;
      
      // Calcula valores totais/gerais se não fornecidos
      const totalVoltage = data.voltage || (data.phases && data.phases.A && data.phases.A.voltage) || null;
      const totalCurrent = data.current || (data.phases && Object.values(data.phases).reduce((sum, p) => sum + (p.current || 0), 0)) || null;
      const totalPower = data.power || (data.phases && Object.values(data.phases).reduce((sum, p) => sum + (p.power || 0), 0)) || null;
      const totalEnergy = data.energy || (data.phases && Object.values(data.phases).reduce((sum, p) => sum + (p.energy || 0), 0)) || null;
      const avgPowerFactor = data.powerFactor || (data.phases && Object.values(data.phases).filter(p => p.powerFactor).reduce((sum, p, i, arr) => sum + (p.powerFactor || 0) / arr.length, 0)) || null;
      
      db.run(`
        INSERT INTO tuya_energy_readings (device_id, device_name, voltage, current_a, power_w, energy_kwh, power_factor, frequency, phases_data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        deviceId,
        deviceName,
        totalVoltage,
        totalCurrent,
        totalPower,
        totalEnergy,
        avgPowerFactor,
        data.frequency || null,
        phasesData
      ], () => resolve());
    });
  }
  
  /**
   * Lista leituras de energia de um dispositivo
   */
  function listTuyaEnergyReadings(deviceId, limit = 100, offset = 0) {
    return new Promise((resolve) => {
      if (!db || !dbReady) {
        resolve([]);
        return;
      }
      
      let query = `SELECT * FROM tuya_energy_readings`;
      const params = [];
      
      if (deviceId) {
        query += ` WHERE device_id = ?`;
        params.push(deviceId);
      }
      
      query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
      params.push(limit, offset);
      
      db.all(query, params, (error, rows) => {
        resolve(rows || []);
      });
    });
  }
  
  /**
   * Obtém estatísticas de energia por período
   */
  function getTuyaEnergyStats(deviceId, periodHours = 24) {
    return new Promise((resolve) => {
      if (!db || !dbReady) {
        resolve(null);
        return;
      }
      
      const since = Math.floor(Date.now() / 1000) - (periodHours * 3600);
      
      db.get(`
        SELECT 
          device_id,
          COUNT(*) as readings_count,
          AVG(voltage) as avg_voltage,
          AVG(current_a) as avg_current,
          AVG(power_w) as avg_power,
          MAX(power_w) as max_power,
          MIN(power_w) as min_power,
          MAX(energy_kwh) - MIN(energy_kwh) as energy_consumed,
          AVG(power_factor) as avg_power_factor
        FROM tuya_energy_readings
        WHERE device_id = ? AND created_at >= ?
        GROUP BY device_id
      `, [deviceId, since], (error, row) => {
        resolve(row || null);
      });
    });
  }
  
  /**
   * Obtém leituras agrupadas por hora para gráfico
   */
  function getTuyaEnergyByHour(deviceId, periodHours = 24) {
    return new Promise((resolve) => {
      if (!db || !dbReady) {
        resolve([]);
        return;
      }
      
      const since = Math.floor(Date.now() / 1000) - (periodHours * 3600);
      
      // Primeiro busca todas as leituras para processar fases
      db.all(`
        SELECT 
          created_at,
          power_w,
          voltage,
          current_a,
          phases_data
        FROM tuya_energy_readings
        WHERE device_id = ? AND created_at >= ?
        ORDER BY created_at ASC
      `, [deviceId, since], (error, allRows) => {
        if (error) {
          resolve([]);
          return;
        }
        
        // Agrupa por hora e processa fases
        const hourlyMap = new Map();
        
        (allRows || []).forEach(row => {
          const hour = new Date(row.created_at * 1000).toISOString().substring(0, 13) + ':00';
          
          if (!hourlyMap.has(hour)) {
            hourlyMap.set(hour, {
              hour,
              powers: [],
              maxPower: 0,
              voltages: [],
              currents: [],
              phasesData: []
            });
          }
          
          const hourData = hourlyMap.get(hour);
          if (row.power_w) hourData.powers.push(row.power_w);
          if (row.voltage) hourData.voltages.push(row.voltage);
          if (row.current_a) hourData.currents.push(row.current_a);
          if (row.power_w > hourData.maxPower) hourData.maxPower = row.power_w;
          if (row.phases_data) hourData.phasesData.push(row.phases_data);
        });
        
        // Processa cada hora
        const processedRows = Array.from(hourlyMap.values()).map(hourData => {
          const result = {
            hour: hourData.hour,
            avg_power: hourData.powers.length > 0 ? hourData.powers.reduce((a, b) => a + b, 0) / hourData.powers.length : 0,
            max_power: hourData.maxPower,
            avg_voltage: hourData.voltages.length > 0 ? hourData.voltages.reduce((a, b) => a + b, 0) / hourData.voltages.length : 0,
            avg_current: hourData.currents.length > 0 ? hourData.currents.reduce((a, b) => a + b, 0) / hourData.currents.length : 0,
            readings: hourData.powers.length
          };
          
          // Processa dados de fases (média das leituras da hora)
          if (hourData.phasesData.length > 0) {
            const phasesAccum = { A: { power: [], voltage: [], current: [], energy: [] }, 
                                  B: { power: [], voltage: [], current: [], energy: [] }, 
                                  C: { power: [], voltage: [], current: [], energy: [] } };
            
            hourData.phasesData.forEach(phasesJson => {
              try {
                const phases = JSON.parse(phasesJson);
                ['A', 'B', 'C'].forEach(phase => {
                  if (phases[phase]) {
                    if (phases[phase].power !== undefined) phasesAccum[phase].power.push(phases[phase].power);
                    if (phases[phase].voltage !== undefined) phasesAccum[phase].voltage.push(phases[phase].voltage);
                    if (phases[phase].current !== undefined) phasesAccum[phase].current.push(phases[phase].current);
                    if (phases[phase].energy !== undefined) phasesAccum[phase].energy.push(phases[phase].energy);
                  }
                });
              } catch (e) {
                // Ignora erro de parsing
              }
            });
            
            result.phases = {};
            ['A', 'B', 'C'].forEach(phase => {
              if (phasesAccum[phase].power.length > 0) {
                result.phases[phase] = {
                  power: phasesAccum[phase].power.reduce((a, b) => a + b, 0) / phasesAccum[phase].power.length,
                  voltage: phasesAccum[phase].voltage.length > 0 ? phasesAccum[phase].voltage.reduce((a, b) => a + b, 0) / phasesAccum[phase].voltage.length : null,
                  current: phasesAccum[phase].current.length > 0 ? phasesAccum[phase].current.reduce((a, b) => a + b, 0) / phasesAccum[phase].current.length : null,
                  energy: phasesAccum[phase].energy.length > 0 ? phasesAccum[phase].energy[phasesAccum[phase].energy.length - 1] : null // Última leitura
                };
              }
            });
            
            // Remove fases vazias
            Object.keys(result.phases).forEach(phase => {
              if (!result.phases[phase].power) delete result.phases[phase];
            });
            if (Object.keys(result.phases).length === 0) delete result.phases;
          }
          
          return result;
        });
        
        resolve(processedRows);
      });
    });
  }
  
  // ===== ACCESS LOG =====
  
  /**
   * Registra um acesso no log
   * @param {string} ip - IP do cliente
   * @param {string} route - Rota acessada
   * @param {string} method - Método HTTP
   * @param {number} statusCode - Código de resposta
   * @param {number} responseTimeMs - Tempo de resposta em ms
   * @param {string} userAgent - User-Agent do cliente
   */
  function logAccessRequest(ip, route, method, statusCode = 0, responseTimeMs = 0, userAgent = '') {
    return new Promise((resolve) => {
      if (!db || !dbReady) {
        resolve();
        return;
      }
      
      db.run(`
        INSERT INTO access_log (ip, route, method, status_code, response_time_ms, user_agent)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [ip, route, method, statusCode, responseTimeMs, userAgent], (error) => {
        if (error) {
          dbg(`[IP-BLOCKER] Erro ao registrar acesso:`, error.message);
        }
        resolve();
      });
    });
  }
  
  /**
   * Lista logs de acesso
   * @param {number} limit - Limite de resultados
   * @param {number} offset - Offset para paginação
   * @param {Object} filters - Filtros opcionais (ip, route, method)
   */
  function listAccessLogs(limit = 100, offset = 0, filters = {}) {
    return new Promise((resolve) => {
      if (!db || !dbReady) {
        resolve([]);
        return;
      }
      
      let query = 'SELECT * FROM access_log WHERE 1=1';
      const params = [];
      
      if (filters.ip) {
        query += ' AND ip LIKE ?';
        params.push(`%${filters.ip}%`);
      }
      if (filters.route) {
        query += ' AND route LIKE ?';
        params.push(`%${filters.route}%`);
      }
      if (filters.method) {
        query += ' AND method = ?';
        params.push(filters.method);
      }
      
      query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);
      
      db.all(query, params, (error, rows) => {
        if (error) {
          dbg(`[IP-BLOCKER] Erro ao listar access logs:`, error.message);
          resolve([]);
          return;
        }
        resolve(rows || []);
      });
    });
  }
  
  /**
   * Conta logs de acesso
   */
  function countAccessLogs(filters = {}) {
    return new Promise((resolve) => {
      if (!db || !dbReady) {
        resolve(0);
        return;
      }
      
      let query = 'SELECT COUNT(*) as count FROM access_log WHERE 1=1';
      const params = [];
      
      if (filters.ip) {
        query += ' AND ip LIKE ?';
        params.push(`%${filters.ip}%`);
      }
      if (filters.route) {
        query += ' AND route LIKE ?';
        params.push(`%${filters.route}%`);
      }
      
      db.get(query, params, (error, row) => {
        if (error) {
          resolve(0);
          return;
        }
        resolve(row?.count || 0);
      });
    });
  }
  
  /**
   * Obtém estatísticas de acesso por rota
   */
  function getAccessStatsByRoute(limit = 20) {
    return new Promise((resolve) => {
      if (!db || !dbReady) {
        resolve([]);
        return;
      }
      
      db.all(`
        SELECT route, method, COUNT(*) as count, 
               AVG(response_time_ms) as avg_response_time,
               MAX(created_at) as last_access
        FROM access_log 
        GROUP BY route, method 
        ORDER BY count DESC 
        LIMIT ?
      `, [limit], (error, rows) => {
        if (error) {
          resolve([]);
          return;
        }
        resolve(rows || []);
      });
    });
  }
  
  /**
   * Obtém estatísticas de acesso por IP
   */
  function getAccessStatsByIP(limit = 20) {
    return new Promise((resolve) => {
      if (!db || !dbReady) {
        resolve([]);
        return;
      }
      
      db.all(`
        SELECT ip, COUNT(*) as count, 
               COUNT(DISTINCT route) as unique_routes,
               MAX(created_at) as last_access
        FROM access_log 
        GROUP BY ip 
        ORDER BY count DESC 
        LIMIT ?
      `, [limit], (error, rows) => {
        if (error) {
          resolve([]);
          return;
        }
        resolve(rows || []);
      });
    });
  }
  
  // ===== WHATSAPP AUDIT =====
  
  function logWhatsappAudit({
    direction,
    phone,
    messageId,
    type,
    status,
    timestamp,
    payload,
    errorCode,
    errorMessage
  }) {
    return new Promise((resolve) => {
      if (!db || !dbReady) {
        resolve();
        return;
      }
      const createdAt = timestamp ? Math.floor(Number(timestamp)) : Math.floor(Date.now() / 1000);
      const payloadJson = payload ? JSON.stringify(payload) : null;
      db.run(`
        INSERT INTO whatsapp_message_audit (
          direction, phone, message_id, type, status, created_at, payload_json, error_code, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        direction || null,
        phone || null,
        messageId || null,
        type || null,
        status || null,
        createdAt,
        payloadJson,
        errorCode || null,
        errorMessage || null
      ], (error) => {
        if (error) {
          dbg(`[IP-BLOCKER] Erro ao registrar auditoria WhatsApp:`, error.message);
        }
        resolve();
      });
    });
  }
  
  function listWhatsappThreads(limit = 50, offset = 0, search = '') {
    return new Promise((resolve) => {
      if (!db || !dbReady) {
        resolve([]);
        return;
      }
      const phoneExpr = `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, '+', ''), ' ', ''), '-', ''), '(', ''), ')', '')`;
      const normalizedExpr = `CASE WHEN LENGTH(${phoneExpr}) = 13 AND SUBSTR(${phoneExpr}, 1, 2) = '55' AND SUBSTR(${phoneExpr}, 5, 1) = '9' THEN SUBSTR(${phoneExpr}, 1, 4) || SUBSTR(${phoneExpr}, 6) ELSE ${phoneExpr} END`;
      let query = `
        SELECT ${normalizedExpr} as phone, COUNT(*) as total, MAX(created_at) as last_at
        FROM whatsapp_message_audit
        WHERE phone IS NOT NULL
      `;
      const params = [];
      if (search) {
        query += ` AND ${normalizedExpr} LIKE ?`;
        params.push(`%${search.replace(/\D/g, '')}%`);
      }
      query += ` GROUP BY ${normalizedExpr} ORDER BY last_at DESC LIMIT ? OFFSET ?`;
      params.push(limit, offset);
      db.all(query, params, (error, rows) => {
        if (error) {
          dbg(`[IP-BLOCKER] Erro ao listar threads WhatsApp:`, error.message);
          resolve([]);
          return;
        }
        resolve(rows || []);
      });
    });
  }
  
  function listWhatsappMessages(phone, limit = 50, before = null) {
    return new Promise((resolve) => {
      if (!db || !dbReady || !phone) {
        resolve([]);
        return;
      }
      const phoneExpr = `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, '+', ''), ' ', ''), '-', ''), '(', ''), ')', '')`;
      const normalizedExpr = `CASE WHEN LENGTH(${phoneExpr}) = 13 AND SUBSTR(${phoneExpr}, 1, 2) = '55' AND SUBSTR(${phoneExpr}, 5, 1) = '9' THEN SUBSTR(${phoneExpr}, 1, 4) || SUBSTR(${phoneExpr}, 6) ELSE ${phoneExpr} END`;
      let normalized = String(phone).replace(/\D/g, '');
      if (normalized.startsWith('55') && normalized.length === 13 && normalized[4] === '9') {
        normalized = `${normalized.slice(0, 4)}${normalized.slice(5)}`;
      }
      let query = `
        SELECT * FROM whatsapp_message_audit
        WHERE ${normalizedExpr} = ?
      `;
      const params = [normalized];
      if (before) {
        query += ` AND created_at < ?`;
        params.push(Number(before));
      }
      query += ` ORDER BY created_at DESC LIMIT ?`;
      params.push(limit);
      db.all(query, params, (error, rows) => {
        if (error) {
          dbg(`[IP-BLOCKER] Erro ao listar mensagens WhatsApp:`, error.message);
          resolve([]);
          return;
        }
        resolve(rows || []);
      });
    });
  }
  
  function searchWhatsappMessages(q, limit = 50, offset = 0) {
    return new Promise((resolve) => {
      if (!db || !dbReady || !q) {
        resolve([]);
        return;
      }
      const like = `%${q}%`;
      db.all(`
        SELECT * FROM whatsapp_message_audit
        WHERE payload_json LIKE ? OR error_message LIKE ? OR message_id LIKE ? OR phone LIKE ?
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `, [like, like, like, like, limit, offset], (error, rows) => {
        if (error) {
          dbg(`[IP-BLOCKER] Erro ao buscar mensagens WhatsApp:`, error.message);
          resolve([]);
          return;
        }
        resolve(rows || []);
      });
    });
  }
  
  function cleanWhatsappAudit(retentionDays = 180) {
    return new Promise((resolve) => {
      if (!db || !dbReady) {
        resolve(0);
        return;
      }
      const days = Number(retentionDays) > 0 ? Number(retentionDays) : 180;
      const cutoff = Math.floor(Date.now() / 1000) - (days * 24 * 60 * 60);
      db.run(`DELETE FROM whatsapp_message_audit WHERE created_at < ?`, [cutoff], function(error) {
        if (error) {
          dbg(`[IP-BLOCKER] Erro ao limpar auditoria WhatsApp:`, error.message);
          resolve(0);
          return;
        }
        resolve(this.changes || 0);
      });
    });
  }

  // ===== TUYA EVENTS =====
  
  /**
   * Registra um evento Tuya
   * @param {string} deviceId - ID do dispositivo
   * @param {string} deviceName - Nome do dispositivo
   * @param {string} eventType - Tipo do evento (power_change, online_change, command)
   * @param {string} oldValue - Valor anterior
   * @param {string} newValue - Novo valor
   * @param {string} source - Fonte do evento (monitor, admin, whatsapp, api)
   */
  function logTuyaEvent(deviceId, deviceName, eventType, oldValue, newValue, source = 'system') {
    return new Promise((resolve) => {
      if (!db || !dbReady) {
        resolve();
        return;
      }
      
      db.run(`
        INSERT INTO tuya_events (device_id, device_name, event_type, old_value, new_value, source)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [deviceId, deviceName, eventType, oldValue, newValue, source], (error) => {
        if (error) {
          dbg(`[IP-BLOCKER] Erro ao registrar evento Tuya:`, error.message);
        }
        resolve();
      });
    });
  }
  
  /**
   * Lista eventos Tuya
   * @param {number} limit - Limite de resultados
   * @param {number} offset - Offset para paginação
   * @param {Object} filters - Filtros opcionais (deviceId, eventType)
   */
  function listTuyaEvents(limit = 100, offset = 0, filters = {}) {
    return new Promise((resolve) => {
      if (!db || !dbReady) {
        resolve([]);
        return;
      }
      
      let query = 'SELECT * FROM tuya_events WHERE 1=1';
      const params = [];
      
      if (filters.deviceId) {
        query += ' AND device_id = ?';
        params.push(filters.deviceId);
      }
      if (filters.eventType) {
        query += ' AND event_type = ?';
        params.push(filters.eventType);
      }
      
      query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);
      
      db.all(query, params, (error, rows) => {
        if (error) {
          dbg(`[IP-BLOCKER] Erro ao listar eventos Tuya:`, error.message);
          resolve([]);
          return;
        }
        resolve(rows || []);
      });
    });
  }
  
  /**
   * Conta eventos Tuya
   */
  function countTuyaEvents(filters = {}) {
    return new Promise((resolve) => {
      if (!db || !dbReady) {
        resolve(0);
        return;
      }
      
      let query = 'SELECT COUNT(*) as count FROM tuya_events WHERE 1=1';
      const params = [];
      
      if (filters.deviceId) {
        query += ' AND device_id = ?';
        params.push(filters.deviceId);
      }
      if (filters.eventType) {
        query += ' AND event_type = ?';
        params.push(filters.eventType);
      }
      
      db.get(query, params, (error, row) => {
        if (error) {
          resolve(0);
          return;
        }
        resolve(row?.count || 0);
      });
    });
  }
  
  /**
   * Remove entradas expiradas das listas
   * @returns {Promise<{whitelist: number, yellowlist: number}>} Número de entradas removidas
   */
  function cleanExpiredEntries() {
    return new Promise((resolve) => {
      if (!db) {
        resolve({ whitelist: 0, yellowlist: 0 });
        return;
      }
      
      const now = Math.floor(Date.now() / 1000);
      
      // Remove whitelist expirada
      db.run('DELETE FROM ip_whitelist WHERE expires_at <= ?', [now], function(whitelistError) {
        const whitelistRemoved = this.changes || 0;
        
        if (whitelistError) {
          warn(`[IP-BLOCKER] Erro ao limpar whitelist expirada:`, whitelistError.message);
        } else if (whitelistRemoved > 0) {
          dbg(`[IP-BLOCKER] ${whitelistRemoved} entrada(s) removida(s) da whitelist expirada`);
        }
        
        // Remove yellowlist expirada
        db.run('DELETE FROM ip_yellowlist WHERE expires_at <= ?', [now], function(yellowlistError) {
          const yellowlistRemoved = this.changes || 0;
          
          if (yellowlistError) {
            warn(`[IP-BLOCKER] Erro ao limpar yellowlist expirada:`, yellowlistError.message);
          } else if (yellowlistRemoved > 0) {
            dbg(`[IP-BLOCKER] ${yellowlistRemoved} entrada(s) removida(s) da yellowlist expirada`);
          }
          
          resolve({
            whitelist: whitelistRemoved,
            yellowlist: yellowlistRemoved
          });
        });
      });
    });
  }
  
  /**
   * Migra IPs do arquivo JSON para o banco (se existir)
   * Só migra uma vez - verifica se já foram migrados e remove/renomeia o arquivo após migração
   */
  async function migrateFromJSON(jsonFilePath) {
    try {
      if (!fs.existsSync(jsonFilePath)) {
        return;
      }
      
      // Verifica se já existe arquivo de migração concluída
      const migratedFile = jsonFilePath + '.migrated';
      if (fs.existsSync(migratedFile)) {
        dbg(`[IP-BLOCKER] Migração do JSON já foi concluída anteriormente (arquivo .migrated existe)`);
        return;
      }
      
      const data = JSON.parse(fs.readFileSync(jsonFilePath, 'utf8'));
      const ips = data.blockedIPs || [];
      
      if (ips.length === 0) {
        // Arquivo vazio - marca como migrado
        fs.renameSync(jsonFilePath, migratedFile);
        dbg(`[IP-BLOCKER] Arquivo JSON vazio, marcando como migrado`);
        return;
      }
      
      log(`[IP-BLOCKER] Migrando ${ips.length} IP(s) do arquivo JSON para o banco...`);
      
      let migratedCount = 0;
      let skippedCount = 0;
      
      for (const ip of ips) {
        try {
          // Verifica se o IP já está no banco antes de adicionar
          const alreadyBlocked = await isBlocked(ip);
          if (alreadyBlocked) {
            skippedCount++;
            dbg(`[IP-BLOCKER] IP ${ip} já está no banco, pulando migração`);
            continue;
          }
          
          await blockIP(ip, 'Migrado do arquivo JSON');
          migratedCount++;
        } catch (e) {
          warn(`[IP-BLOCKER] Erro ao migrar IP ${ip}:`, e.message);
        }
      }
      
      // Após migração bem-sucedida, renomeia o arquivo para indicar que foi migrado
      try {
        fs.renameSync(jsonFilePath, migratedFile);
        log(`[IP-BLOCKER] Migração concluída: ${migratedCount} IP(s) migrado(s), ${skippedCount} já existente(s)`);
        log(`[IP-BLOCKER] Arquivo JSON renomeado para ${path.basename(migratedFile)} (migração concluída)`);
      } catch (renameError) {
        warn(`[IP-BLOCKER] Erro ao renomear arquivo JSON após migração:`, renameError.message);
        // Tenta remover o arquivo como fallback
        try {
          fs.unlinkSync(jsonFilePath);
          log(`[IP-BLOCKER] Arquivo JSON removido após migração`);
        } catch (unlinkError) {
          warn(`[IP-BLOCKER] Erro ao remover arquivo JSON:`, unlinkError.message);
        }
      }
    } catch (e) {
      // Se o erro for porque o arquivo não existe mais, ignora
      if (e.code === 'ENOENT') {
        dbg(`[IP-BLOCKER] Arquivo JSON não encontrado (já foi migrado/removido)`);
        return;
      }
      warn(`[IP-BLOCKER] Erro ao migrar do JSON:`, e.message);
    }
  }
  
  /**
   * Fecha a conexão com o banco
   */
  function close() {
    return new Promise((resolve) => {
      if (!db) {
        resolve();
        return;
      }
      
      db.close((error) => {
        if (error) {
          err(`[IP-BLOCKER] Erro ao fechar banco:`, error.message);
        } else {
          log(`[IP-BLOCKER] Banco de dados fechado`);
        }
        resolve();
      });
    });
  }
  
  // Cria wrappers que garantem logs e verificações
  const wrappedCountBlockedIPs = function() {
    log(`[IP-BLOCKER] 🔍 WRAPPER countBlockedIPs CHAMADO`);
    return countBlockedIPs();
  };
  
  const wrappedCountWhitelistIPs = function() {
    log(`[IP-BLOCKER] 🔍 WRAPPER countWhitelistIPs CHAMADO`);
    return countWhitelistIPs();
  };
  
  const wrappedCountYellowlistIPs = function() {
    log(`[IP-BLOCKER] 🔍 WRAPPER countYellowlistIPs CHAMADO`);
    return countYellowlistIPs();
  };
  
  const wrappedListBlockedIPs = function(limit, offset) {
    log(`[IP-BLOCKER] 🔍 WRAPPER listBlockedIPs CHAMADO`);
    return listBlockedIPs(limit, offset);
  };
  
  /**
   * Salva estatística no banco
   * @param {string} key - Chave da estatística
   * @param {number} value - Valor da estatística
   */
  function saveStatistic(key, value) {
    return new Promise((resolve) => {
      if (!db || !dbReady) {
        dbg(`[IP-BLOCKER] Banco não disponível para salvar estatística ${key}`);
        resolve();
        return;
      }
      const now = Math.floor(Date.now() / 1000);
      db.run(`
        INSERT OR REPLACE INTO system_statistics (stat_key, stat_value, updated_at)
        VALUES (?, ?, ?)
      `, [key, value, now], (error) => {
        if (error) {
          err(`[IP-BLOCKER] Erro ao salvar estatística ${key}:`, error.message);
        } else {
          dbg(`[IP-BLOCKER] Estatística ${key} salva: ${value}`);
        }
        resolve();
      });
    });
  }
  
  /**
   * Carrega estatística do banco
   * @param {string} key - Chave da estatística
   * @returns {Promise<number>} Valor da estatística
   */
  function loadStatistic(key) {
    return new Promise(async (resolve) => {
      if (!db || !dbReady) {
        dbg(`[IP-BLOCKER] Banco não disponível para carregar estatística ${key}`);
        resolve(0);
        return;
      }
      
      // Aguarda banco estar pronto
      if (!dbReady) {
        try {
          await dbReadyPromise;
        } catch (e) {
          dbg(`[IP-BLOCKER] Erro ao aguardar banco para carregar ${key}:`, e.message);
          resolve(0);
          return;
        }
      }
      
      db.get('SELECT stat_value FROM system_statistics WHERE stat_key = ?', [key], (error, row) => {
        if (error) {
          err(`[IP-BLOCKER] Erro ao carregar estatística ${key}:`, error.message);
          resolve(0);
        } else {
          const value = row ? row.stat_value : 0;
          dbg(`[IP-BLOCKER] Estatística ${key} carregada: ${value}`);
          resolve(value);
        }
      });
    });
  }
  
  /**
   * Incrementa contador de rota no banco
   * @param {string} route - Rota
   */
  function incrementRouteStat(route) {
    return new Promise((resolve) => {
      if (!db || !dbReady || !route) {
        resolve();
        return;
      }
      const now = Math.floor(Date.now() / 1000);
      db.run(`
        INSERT INTO route_statistics (route, request_count, last_seen)
        VALUES (?, 1, ?)
        ON CONFLICT(route) DO UPDATE SET
          request_count = request_count + 1,
          last_seen = ?
      `, [route, now, now], (error) => {
        if (error) {
          dbg(`[IP-BLOCKER] Erro ao incrementar rota ${route}:`, error.message);
        }
        resolve();
      });
    });
  }
  
  /**
   * Incrementa contador de IP no banco
   * @param {string} ip - Endereço IP
   */
  function incrementIPStat(ip) {
    return new Promise((resolve) => {
      if (!db || !dbReady || !ip || ip === 'unknown') {
        resolve();
        return;
      }
      const now = Math.floor(Date.now() / 1000);
      db.run(`
        INSERT INTO ip_request_statistics (ip, request_count, last_seen)
        VALUES (?, 1, ?)
        ON CONFLICT(ip) DO UPDATE SET
          request_count = request_count + 1,
          last_seen = ?
      `, [ip, now, now], (error) => {
        if (error) {
          dbg(`[IP-BLOCKER] Erro ao incrementar IP ${ip}:`, error.message);
        }
        resolve();
      });
    });
  }
  
  /**
   * Obtém todas as rotas do banco (sem limite)
   * @returns {Promise<Array>} Lista de todas as rotas
   */
  function getAllRoutes() {
    return new Promise((resolve) => {
      if (!db || !dbReady) {
        resolve([]);
        return;
      }
      db.all(`
        SELECT route, request_count as count
        FROM route_statistics
        ORDER BY request_count DESC
      `, [], (error, rows) => {
        if (error) {
          dbg(`[IP-BLOCKER] Erro ao obter todas as rotas:`, error.message);
          resolve([]);
        } else {
          resolve(rows || []);
        }
      });
    });
  }
  
  /**
   * Obtém todos os IPs do banco (sem limite)
   * @returns {Promise<Array>} Lista de todos os IPs
   */
  function getAllIPs() {
    return new Promise((resolve) => {
      if (!db || !dbReady) {
        resolve([]);
        return;
      }
      db.all(`
        SELECT ip, request_count as count
        FROM ip_request_statistics
        ORDER BY request_count DESC
      `, [], (error, rows) => {
        if (error) {
          dbg(`[IP-BLOCKER] Erro ao obter todos os IPs:`, error.message);
          resolve([]);
        } else {
          resolve(rows || []);
        }
      });
    });
  }
  
  /**
   * Obtém top rotas do banco
   * @param {number} limit - Limite de resultados
   * @returns {Promise<Array>} Lista de rotas
   */
  function getTopRoutes(limit = 5) {
    return new Promise((resolve) => {
      if (!db || !dbReady) {
        resolve([]);
        return;
      }
      db.all(`
        SELECT route, request_count as count
        FROM route_statistics
        ORDER BY request_count DESC
        LIMIT ?
      `, [limit], (error, rows) => {
        if (error) {
          dbg(`[IP-BLOCKER] Erro ao obter top rotas:`, error.message);
          resolve([]);
        } else {
          resolve(rows || []);
        }
      });
    });
  }
  
  /**
   * Obtém top IPs do banco
   * @param {number} limit - Limite de resultados
   * @returns {Promise<Array>} Lista de IPs
   */
  function getTopIPs(limit = 5) {
    return new Promise((resolve) => {
      if (!db || !dbReady) {
        resolve([]);
        return;
      }
      db.all(`
        SELECT ip, request_count as count
        FROM ip_request_statistics
        ORDER BY request_count DESC
        LIMIT ?
      `, [limit], (error, rows) => {
        if (error) {
          dbg(`[IP-BLOCKER] Erro ao obter top IPs:`, error.message);
          resolve([]);
        } else {
          resolve(rows || []);
        }
      });
    });
  }
  
  // ===== TRUSTED IP RANGES =====
  
  // Cache para ranges confiáveis (atualizado a cada 5 minutos)
  let trustedRangesCache = null;
  let trustedRangesCacheTime = 0;
  const TRUSTED_RANGES_CACHE_TTL = 5 * 60 * 1000; // 5 minutos
  
  /**
   * Adiciona um range de IP confiável
   * @param {string} cidr - Range CIDR (ex: 157.240.0.0/16)
   * @param {string} category - Categoria (ex: 'meta', 'cloudflare', 'esp32')
   * @param {string} description - Descrição opcional
   * @returns {Promise<{success: boolean, id: number}>}
   */
  function addTrustedRange(cidr, category, description = '') {
    return new Promise((resolve, reject) => {
      if (!db) {
        reject(new Error('Banco de dados não inicializado'));
        return;
      }
      
      // Valida formato CIDR básico
      const cidrRegex = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
      if (!cidrRegex.test(cidr)) {
        reject(new Error(`Formato CIDR inválido: ${cidr}`));
        return;
      }
      
      const now = Math.floor(Date.now() / 1000);
      
      db.run(`
        INSERT INTO trusted_ip_ranges (cidr, category, description, enabled, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?)
      `, [cidr, category.toLowerCase(), description, now, now], function(error) {
        if (error) {
          err(`[IP-BLOCKER] Erro ao adicionar range confiável:`, error.message);
          reject(error);
          return;
        }
        
        // Invalida cache
        trustedRangesCache = null;
        
        log(`[IP-BLOCKER] Range confiável adicionado: ${cidr} (${category})`);
        resolve({ success: true, id: this.lastID });
      });
    });
  }
  
  /**
   * Remove um range de IP confiável
   * @param {number} id - ID do range
   * @returns {Promise<boolean>}
   */
  function removeTrustedRange(id) {
    return new Promise((resolve, reject) => {
      if (!db) {
        reject(new Error('Banco de dados não inicializado'));
        return;
      }
      
      db.run('DELETE FROM trusted_ip_ranges WHERE id = ?', [id], function(error) {
        if (error) {
          err(`[IP-BLOCKER] Erro ao remover range confiável:`, error.message);
          reject(error);
          return;
        }
        
        // Invalida cache
        trustedRangesCache = null;
        
        if (this.changes > 0) {
          log(`[IP-BLOCKER] Range confiável removido: ID ${id}`);
          resolve(true);
        } else {
          resolve(false);
        }
      });
    });
  }
  
  /**
   * Habilita/desabilita um range de IP confiável
   * @param {number} id - ID do range
   * @param {boolean} enabled - Se deve estar habilitado
   * @returns {Promise<boolean>}
   */
  function toggleTrustedRange(id, enabled) {
    return new Promise((resolve, reject) => {
      if (!db) {
        reject(new Error('Banco de dados não inicializado'));
        return;
      }
      
      const now = Math.floor(Date.now() / 1000);
      
      db.run(`
        UPDATE trusted_ip_ranges 
        SET enabled = ?, updated_at = ?
        WHERE id = ?
      `, [enabled ? 1 : 0, now, id], function(error) {
        if (error) {
          err(`[IP-BLOCKER] Erro ao atualizar range confiável:`, error.message);
          reject(error);
          return;
        }
        
        // Invalida cache
        trustedRangesCache = null;
        
        if (this.changes > 0) {
          log(`[IP-BLOCKER] Range confiável ${enabled ? 'habilitado' : 'desabilitado'}: ID ${id}`);
          resolve(true);
        } else {
          resolve(false);
        }
      });
    });
  }
  
  /**
   * Lista ranges de IP confiáveis
   * @param {string} category - Categoria para filtrar (opcional)
   * @param {boolean} enabledOnly - Se deve listar apenas habilitados (padrão: false)
   * @returns {Promise<Array>}
   */
  function listTrustedRanges(category = null, enabledOnly = false) {
    return new Promise((resolve, reject) => {
      if (!db) {
        resolve([]);
        return;
      }
      
      let query = 'SELECT * FROM trusted_ip_ranges WHERE 1=1';
      const params = [];
      
      if (category) {
        query += ' AND category = ?';
        params.push(category.toLowerCase());
      }
      
      if (enabledOnly) {
        query += ' AND enabled = 1';
      }
      
      query += ' ORDER BY category, cidr';
      
      db.all(query, params, (error, rows) => {
        if (error) {
          err(`[IP-BLOCKER] Erro ao listar ranges confiáveis:`, error.message);
          resolve([]);
          return;
        }
        resolve(rows || []);
      });
    });
  }
  
  /**
   * Obtém todos os ranges habilitados (com cache)
   * @returns {Promise<Array>}
   */
  async function getEnabledTrustedRanges() {
    const now = Date.now();
    
    // Retorna cache se ainda válido
    if (trustedRangesCache && (now - trustedRangesCacheTime) < TRUSTED_RANGES_CACHE_TTL) {
      return trustedRangesCache;
    }
    
    const ranges = await listTrustedRanges(null, true);
    trustedRangesCache = ranges;
    trustedRangesCacheTime = now;
    
    return ranges;
  }
  
  /**
   * Obtém ranges por categoria (com cache)
   * @param {string} category - Categoria
   * @returns {Promise<string[]>} Array de CIDRs
   */
  async function getTrustedRangesByCategory(category) {
    const ranges = await getEnabledTrustedRanges();
    return ranges
      .filter(r => r.category === category.toLowerCase())
      .map(r => r.cidr);
  }
  
  /**
   * Conta ranges por categoria
   * @returns {Promise<Object>} Contagem por categoria
   */
  function countTrustedRangesByCategory() {
    return new Promise((resolve) => {
      if (!db) {
        resolve({});
        return;
      }
      
      db.all(`
        SELECT category, 
               COUNT(*) as total,
               SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) as enabled
        FROM trusted_ip_ranges
        GROUP BY category
      `, [], (error, rows) => {
        if (error) {
          dbg(`[IP-BLOCKER] Erro ao contar ranges:`, error.message);
          resolve({});
          return;
        }
        
        const result = {};
        (rows || []).forEach(row => {
          result[row.category] = {
            total: row.total,
            enabled: row.enabled
          };
        });
        resolve(result);
      });
    });
  }
  
  /**
   * Importa ranges do Meta para a tabela (migração inicial)
   * @returns {Promise<{imported: number, skipped: number}>}
   */
  async function importMetaRanges() {
    const META_RANGES = [
      '173.252.64.0/18',
      '173.252.88.0/21',
      '66.220.144.0/20',
      '69.63.176.0/20',
      '69.171.224.0/19',
      '74.119.76.0/22',
      '103.4.96.0/22',
      '157.240.0.0/16',
      '179.60.192.0/22',
      '185.60.216.0/22',
      '204.15.20.0/22',
      '31.13.24.0/21',
      '31.13.64.0/18'
    ];
    
    let imported = 0;
    let skipped = 0;
    
    for (const cidr of META_RANGES) {
      try {
        // Verifica se já existe
        const existing = await new Promise((resolve) => {
          db.get('SELECT id FROM trusted_ip_ranges WHERE cidr = ? AND category = ?', 
            [cidr, 'meta'], (err, row) => resolve(row));
        });
        
        if (existing) {
          skipped++;
          continue;
        }
        
        await addTrustedRange(cidr, 'meta', 'Facebook/Meta IP range para webhooks');
        imported++;
      } catch (e) {
        warn(`[IP-BLOCKER] Erro ao importar range ${cidr}:`, e.message);
        skipped++;
      }
    }
    
    log(`[IP-BLOCKER] Importação Meta concluída: ${imported} importados, ${skipped} ignorados`);
    return { imported, skipped };
  }
  
  // ===== ABUSEIPDB RATE LIMIT =====
  
  /**
   * Inicializa/atualiza limites da API AbuseIPDB
   * @param {Object} limits - Limites por endpoint
   */
  function initAbuseIPDBLimits(limits = {}) {
    const defaultLimits = {
      'check': 1000,
      'check-block': 100,
      'report': 1000,
      'reports': 100,
      'blacklist': 5,
      'bulk-report': 5,
      'clear-address': 5
    };
    
    const finalLimits = { ...defaultLimits, ...limits };
    
    return new Promise((resolve) => {
      if (!db) {
        resolve();
        return;
      }
      
      const now = Math.floor(Date.now() / 1000);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayTimestamp = Math.floor(today.getTime() / 1000);
      
      const promises = Object.entries(finalLimits).map(([endpoint, limit]) => {
        return new Promise((res) => {
          db.run(`
            INSERT OR REPLACE INTO abuseipdb_rate_limit (endpoint, daily_limit, daily_used, last_reset, updated_at)
            VALUES (?, ?, 
              COALESCE((SELECT CASE WHEN last_reset < ? THEN 0 ELSE daily_used END FROM abuseipdb_rate_limit WHERE endpoint = ?), 0),
              ?, ?)
          `, [endpoint, limit, todayTimestamp, endpoint, todayTimestamp, now], res);
        });
      });
      
      Promise.all(promises).then(() => {
        dbg(`[IP-BLOCKER] Limites AbuseIPDB inicializados`);
        resolve();
      });
    });
  }
  
  /**
   * Verifica se pode fazer requisição para um endpoint
   * @param {string} endpoint - Nome do endpoint
   * @returns {Promise<{canUse: boolean, remaining: number, limit: number}>}
   */
  function canUseAbuseIPDBEndpoint(endpoint) {
    return new Promise((resolve) => {
      if (!db) {
        resolve({ canUse: true, remaining: 999, limit: 1000 });
        return;
      }
      
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayTimestamp = Math.floor(today.getTime() / 1000);
      
      db.get(`
        SELECT daily_limit, daily_used, last_reset
        FROM abuseipdb_rate_limit
        WHERE endpoint = ?
      `, [endpoint], (error, row) => {
        if (error || !row) {
          resolve({ canUse: true, remaining: 999, limit: 1000 });
          return;
        }
        
        // Se passou da meia-noite, reseta contador
        let used = row.daily_used;
        if (row.last_reset < todayTimestamp) {
          used = 0;
        }
        
        const remaining = row.daily_limit - used;
        resolve({
          canUse: remaining > 0,
          remaining: Math.max(0, remaining),
          limit: row.daily_limit
        });
      });
    });
  }
  
  /**
   * Registra uso de um endpoint da API AbuseIPDB
   * @param {string} endpoint - Nome do endpoint
   * @returns {Promise<void>}
   */
  function recordAbuseIPDBUsage(endpoint) {
    return new Promise((resolve) => {
      if (!db) {
        resolve();
        return;
      }
      
      const now = Math.floor(Date.now() / 1000);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayTimestamp = Math.floor(today.getTime() / 1000);
      
      db.run(`
        UPDATE abuseipdb_rate_limit
        SET daily_used = CASE WHEN last_reset < ? THEN 1 ELSE daily_used + 1 END,
            last_reset = CASE WHEN last_reset < ? THEN ? ELSE last_reset END,
            updated_at = ?
        WHERE endpoint = ?
      `, [todayTimestamp, todayTimestamp, todayTimestamp, now, endpoint], (error) => {
        if (error) {
          dbg(`[IP-BLOCKER] Erro ao registrar uso AbuseIPDB:`, error.message);
        }
        resolve();
      });
    });
  }
  
  /**
   * Obtém estatísticas de uso da API AbuseIPDB
   * @returns {Promise<Object>}
   */
  function getAbuseIPDBStats() {
    return new Promise((resolve) => {
      if (!db) {
        resolve({});
        return;
      }
      
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayTimestamp = Math.floor(today.getTime() / 1000);
      
      db.all(`
        SELECT endpoint, daily_limit, 
               CASE WHEN last_reset < ? THEN 0 ELSE daily_used END as daily_used,
               last_reset
        FROM abuseipdb_rate_limit
      `, [todayTimestamp], (error, rows) => {
        if (error) {
          dbg(`[IP-BLOCKER] Erro ao obter stats AbuseIPDB:`, error.message);
          resolve({});
          return;
        }
        
        const result = {};
        (rows || []).forEach(row => {
          result[row.endpoint] = {
            limit: row.daily_limit,
            used: row.daily_used,
            remaining: row.daily_limit - row.daily_used,
            utilizationRate: ((row.daily_used / row.daily_limit) * 100).toFixed(1) + '%'
          };
        });
        resolve(result);
      });
    });
  }
  
  /**
   * Obtém estatísticas dos caches em memória
   * @returns {Object} Estatísticas dos caches
   */
  function getCacheStats() {
    return {
      blocked: blockedCache.getStats(),
      whitelist: whitelistCache.getStats(),
      yellowlist: yellowlistCache.getStats()
    };
  }
  
  /**
   * Limpa todos os caches em memória
   */
  function clearAllCaches() {
    blockedCache.clear();
    whitelistCache.clear();
    yellowlistCache.clear();
    log(`[IP-BLOCKER] Todos os caches em memória foram limpos`);
  }
  
  /**
   * Adiciona ou atualiza opt-in de um número de telefone
   * @param {string} phone - Número de telefone (formato: 5511999999999)
   * @returns {Promise<{success: boolean, optedIn: boolean, message: string}>}
   */
  function addOptIn(phone) {
    return new Promise((resolve) => {
      if (!db) {
        resolve({ success: false, optedIn: false, message: 'Banco de dados não disponível' });
        return;
      }
      
      const normalizedPhone = phone.replace(/[^0-9]/g, '');
      if (!normalizedPhone || normalizedPhone.length < 10) {
        resolve({ success: false, optedIn: false, message: 'Número de telefone inválido' });
        return;
      }
      
      const now = Math.floor(Date.now() / 1000);
      
      db.run(`
        INSERT INTO whatsapp_opt_in (phone, opted_in, opted_in_at, updated_at, last_message_at)
        VALUES (?, 1, ?, ?, ?)
        ON CONFLICT(phone) DO UPDATE SET
          opted_in = 1,
          opted_in_at = ?,
          opted_out_at = NULL,
          updated_at = ?,
          last_message_at = COALESCE(?, last_message_at)
      `, [normalizedPhone, now, now, now, now, now, now], (error) => {
        if (error) {
          err(`[OPT-IN] Erro ao adicionar opt-in para ${normalizedPhone}:`, error.message);
          resolve({ success: false, optedIn: false, message: 'Erro ao processar opt-in' });
          return;
        }
        
        log(`[OPT-IN] ✅ Opt-in adicionado/atualizado para ${normalizedPhone}`);
        resolve({ success: true, optedIn: true, message: 'Opt-in registrado com sucesso' });
      });
    });
  }
  
  /**
   * Remove opt-in de um número de telefone (opt-out)
   * @param {string} phone - Número de telefone (formato: 5511999999999)
   * @returns {Promise<{success: boolean, optedIn: boolean, message: string}>}
   */
  function removeOptIn(phone) {
    return new Promise((resolve) => {
      if (!db) {
        resolve({ success: false, optedIn: true, message: 'Banco de dados não disponível' });
        return;
      }
      
      const normalizedPhone = phone.replace(/[^0-9]/g, '');
      if (!normalizedPhone || normalizedPhone.length < 10) {
        resolve({ success: false, optedIn: true, message: 'Número de telefone inválido' });
        return;
      }
      
      const now = Math.floor(Date.now() / 1000);
      
      db.run(`
        INSERT INTO whatsapp_opt_in (phone, opted_in, opted_out_at, updated_at)
        VALUES (?, 0, ?, ?)
        ON CONFLICT(phone) DO UPDATE SET
          opted_in = 0,
          opted_out_at = ?,
          updated_at = ?
      `, [normalizedPhone, now, now, now, now], (error) => {
        if (error) {
          err(`[OPT-IN] Erro ao remover opt-in para ${normalizedPhone}:`, error.message);
          resolve({ success: false, optedIn: true, message: 'Erro ao processar opt-out' });
          return;
        }
        
        log(`[OPT-IN] ❌ Opt-out registrado para ${normalizedPhone}`);
        resolve({ success: true, optedIn: false, message: 'Opt-out registrado com sucesso' });
      });
    });
  }
  
  /**
   * Verifica se um número tem opt-in ativo
   * @param {string} phone - Número de telefone (formato: 5511999999999)
   * @returns {Promise<{optedIn: boolean, optedInAt: number|null, optedOutAt: number|null}>}
   */
  function hasOptIn(phone) {
    return new Promise((resolve) => {
      if (!db) {
        // Por padrão, assume opt-in se banco não disponível (comportamento seguro)
        resolve({ optedIn: true, optedInAt: null, optedOutAt: null });
        return;
      }
      
      const normalizedPhone = phone.replace(/[^0-9]/g, '');
      if (!normalizedPhone || normalizedPhone.length < 10) {
        resolve({ optedIn: false, optedInAt: null, optedOutAt: null });
        return;
      }
      
      db.get(`
        SELECT opted_in, opted_in_at, opted_out_at
        FROM whatsapp_opt_in
        WHERE phone = ?
      `, [normalizedPhone], (error, row) => {
        if (error) {
          err(`[OPT-IN] Erro ao verificar opt-in para ${normalizedPhone}:`, error.message);
          // Em caso de erro, assume opt-in (comportamento seguro)
          resolve({ optedIn: true, optedInAt: null, optedOutAt: null });
          return;
        }
        
        if (!row) {
          // Se não existe registro, assume opt-in (comportamento padrão)
          resolve({ optedIn: true, optedInAt: null, optedOutAt: null });
          return;
        }
        
        resolve({
          optedIn: row.opted_in === 1,
          optedInAt: row.opted_in_at || null,
          optedOutAt: row.opted_out_at || null
        });
      });
    });
  }
  
  /**
   * Atualiza timestamp da última mensagem recebida (auto opt-in)
   * @param {string} phone - Número de telefone
   * @returns {Promise<void>}
   */
  function updateLastMessageTime(phone) {
    return new Promise((resolve) => {
      if (!db) {
        resolve();
        return;
      }
      
      const normalizedPhone = phone.replace(/[^0-9]/g, '');
      if (!normalizedPhone || normalizedPhone.length < 10) {
        resolve();
        return;
      }
      
      const now = Math.floor(Date.now() / 1000);
      
      // Se não existe registro, cria com opt-in ativo
      // Se existe, atualiza last_message_at e mantém opt_in se já estiver ativo
      db.run(`
        INSERT INTO whatsapp_opt_in (phone, opted_in, opted_in_at, updated_at, last_message_at)
        VALUES (?, 1, ?, ?, ?)
        ON CONFLICT(phone) DO UPDATE SET
          last_message_at = ?,
          updated_at = ?
      `, [normalizedPhone, now, now, now, now, now], (error) => {
        if (error) {
          dbg(`[OPT-IN] Erro ao atualizar last_message_at para ${normalizedPhone}:`, error.message);
        }
        resolve();
      });
    });
  }
  
  /**
   * Lista todos os opt-ins/opt-outs
   * @param {boolean} optedInOnly - Se true, retorna apenas opt-ins ativos
   * @param {number} limit - Limite de resultados
   * @param {number} offset - Offset para paginação
   * @returns {Promise<Array>}
   */
  function listOptIns(optedInOnly = false, limit = 100, offset = 0) {
    return new Promise((resolve) => {
      if (!db) {
        resolve([]);
        return;
      }
      
      const sql = optedInOnly
        ? `SELECT phone, opted_in, opted_in_at, opted_out_at, last_message_at, updated_at
           FROM whatsapp_opt_in
           WHERE opted_in = 1
           ORDER BY updated_at DESC
           LIMIT ? OFFSET ?`
        : `SELECT phone, opted_in, opted_in_at, opted_out_at, last_message_at, updated_at
           FROM whatsapp_opt_in
           ORDER BY updated_at DESC
           LIMIT ? OFFSET ?`;
      
      db.all(sql, [limit, offset], (error, rows) => {
        if (error) {
          err(`[OPT-IN] Erro ao listar opt-ins:`, error.message);
          resolve([]);
          return;
        }
        
        resolve(rows || []);
      });
    });
  }
  
  /**
   * Conta total de opt-ins/opt-outs
   * @param {boolean} optedInOnly - Se true, conta apenas opt-ins ativos
   * @returns {Promise<number>}
   */
  function countOptIns(optedInOnly = false) {
    return new Promise((resolve) => {
      if (!db) {
        resolve(0);
        return;
      }
      
      const sql = optedInOnly
        ? `SELECT COUNT(*) as count FROM whatsapp_opt_in WHERE opted_in = 1`
        : `SELECT COUNT(*) as count FROM whatsapp_opt_in`;
      
      db.get(sql, [], (error, row) => {
        if (error) {
          err(`[OPT-IN] Erro ao contar opt-ins:`, error.message);
          resolve(0);
          return;
        }
        
        resolve(row ? row.count : 0);
      });
    });
  }
  
  // Cria o objeto API (será retornado após inicialização)
  const createModuleAPI = () => {
    return {
      isBlocked,
      blockIP,
      unblockIP,
      recordBlockedAttempt,
      recordWhitelistAttempt,
      recordYellowlistAttempt,
      recordIPAttempt,
      listBlockedIPs: wrappedListBlockedIPs,
      countBlockedIPs: wrappedCountBlockedIPs,
      listWhitelistIPs,
      listYellowlistIPs,
      countWhitelistIPs: wrappedCountWhitelistIPs,
      countYellowlistIPs: wrappedCountYellowlistIPs,
      addToWhitelist,
      addToYellowlist,
      removeFromWhitelist,
      removeFromYellowlist,
      isInWhitelist,
      isInYellowlist,
      logMigration,
      listMigrationLogs,
      countMigrationLogs,
      checkAndFixDuplicates,
      cleanExpiredEntries,
      // Access Log
      logAccessRequest,
      listAccessLogs,
      countAccessLogs,
      getAccessStatsByRoute,
      getAccessStatsByIP,
      // WhatsApp Audit
      logWhatsappAudit,
      listWhatsappThreads,
      listWhatsappMessages,
      searchWhatsappMessages,
      cleanWhatsappAudit,
      // Tuya Events
      logTuyaEvent,
      listTuyaEvents,
      countTuyaEvents,
      // Admin Sessions
      saveAdminSession,
      getAdminSession,
      getAdminSessionByFingerprint,
      updateAdminSessionLastUsed,
      deleteAdminSession,
      cleanExpiredAdminSessions,
      listTrustedDevices,
      revokeTrustedDevice,
      // ESP32 Devices
      updateESP32Device,
      listESP32Devices,
      // Tuya Energy
      saveTuyaEnergyReading,
      listTuyaEnergyReadings,
      getTuyaEnergyStats,
      getTuyaEnergyByHour,
      // WhatsApp Opt-In/Opt-Out
      addOptIn,
      removeOptIn,
      hasOptIn,
      updateLastMessageTime,
      listOptIns,
      countOptIns,
      close,
      // Cache
      getCacheStats,
      clearAllCaches,
      // Estatísticas
      saveStatistic,
      loadStatistic,
      incrementRouteStat,
      incrementIPStat,
      getAllRoutes,
      getAllIPs,
      getTopRoutes,
      getTopIPs,
      // Trusted IP Ranges
      addTrustedRange,
      removeTrustedRange,
      toggleTrustedRange,
      listTrustedRanges,
      getEnabledTrustedRanges,
      getTrustedRangesByCategory,
      countTrustedRangesByCategory,
      importMetaRanges,
      // AbuseIPDB Rate Limit
      initAbuseIPDBLimits,
      canUseAbuseIPDBEndpoint,
      recordAbuseIPDBUsage,
      getAbuseIPDBStats,
      // Expõe promise para permitir aguardar banco estar pronto
      get _promise() { return dbReadyPromise; },
      _ready: () => dbReady
    };
  };
  
  // Cria o moduleAPI ANTES de inicializar o banco (para poder usar nos logs)
  moduleAPI = createModuleAPI();
  
  // Inicializa o banco PRIMEIRO
  dbReadyPromise = initDatabase()
    .then(() => {
      log(`[IP-BLOCKER] ✅ Banco de dados inicializado com sucesso`);
      dbReady = true;
      log(`[IP-BLOCKER] ✅ Módulo inicializado com sucesso - ${Object.keys(moduleAPI).length} funções exportadas`);
      log(`[IP-BLOCKER] ✅ countBlockedIPs tipo: ${typeof moduleAPI.countBlockedIPs}`);
      
      // Migra dados do JSON se existir
      const jsonFile = path.join(appRoot, 'blocked_ips.json');
      migrateFromJSON(jsonFile);
      
      // Verifica quantos IPs existem em cada tabela após inicialização e lista os IPs
      setTimeout(async () => {
        try {
          const sqlBlockedCount = 'SELECT COUNT(*) as count FROM blocked_ips';
          log(`[IP-BLOCKER] 🔍 [INIT] SQL: ${sqlBlockedCount}`);
          const blockedCount = await new Promise((res) => {
            if (!db) return res(0);
            db.get(sqlBlockedCount, [], (err, row) => {
              if (err) {
                err(`[IP-BLOCKER] ❌ [INIT] Erro ao contar blocked:`, err.message);
                res(0);
              } else {
                log(`[IP-BLOCKER] ✅ [INIT] Blocked count: ${row ? row.count : 0}`);
                res(err ? 0 : (row ? row.count : 0));
              }
            });
          });
          
          const now = Math.floor(Date.now() / 1000);
          const sqlWhitelistCount = 'SELECT COUNT(*) as count FROM ip_whitelist WHERE expires_at > ?';
          log(`[IP-BLOCKER] 🔍 [INIT] SQL: ${sqlWhitelistCount}`);
          log(`[IP-BLOCKER] 🔍 [INIT] Parâmetros: [${now}]`);
          const whitelistCount = await new Promise((res) => {
            if (!db) return res(0);
            db.get(sqlWhitelistCount, [now], (err, row) => {
              if (err) {
                err(`[IP-BLOCKER] ❌ [INIT] Erro ao contar whitelist:`, err.message);
                res(0);
              } else {
                log(`[IP-BLOCKER] ✅ [INIT] Whitelist count: ${row ? row.count : 0}`);
                res(err ? 0 : (row ? row.count : 0));
              }
            });
          });
          
          const sqlYellowlistCount = 'SELECT COUNT(*) as count FROM ip_yellowlist WHERE expires_at > ?';
          log(`[IP-BLOCKER] 🔍 [INIT] SQL: ${sqlYellowlistCount}`);
          log(`[IP-BLOCKER] 🔍 [INIT] Parâmetros: [${now}]`);
          const yellowlistCount = await new Promise((res) => {
            if (!db) return res(0);
            db.get(sqlYellowlistCount, [now], (err, row) => {
              if (err) {
                err(`[IP-BLOCKER] ❌ [INIT] Erro ao contar yellowlist:`, err.message);
                res(0);
              } else {
                log(`[IP-BLOCKER] ✅ [INIT] Yellowlist count: ${row ? row.count : 0}`);
                res(err ? 0 : (row ? row.count : 0));
              }
            });
          });
          
          log(`[IP-BLOCKER] 📊 Estatísticas do banco: ${blockedCount} bloqueado(s), ${whitelistCount} whitelist, ${yellowlistCount} yellowlist`);
          
          // Lista os IPs bloqueados
          if (blockedCount > 0) {
            const sqlBlockedList = 'SELECT ip, reason, blocked_at, last_seen, request_count, created_at FROM blocked_ips ORDER BY blocked_at DESC LIMIT 50';
            log(`[IP-BLOCKER] 🔍 [INIT] SQL: ${sqlBlockedList}`);
            db.all(sqlBlockedList, [], (err, rows) => {
              if (err) {
                err(`[IP-BLOCKER] ❌ [INIT] Erro ao listar blocked IPs:`, err.message);
              } else {
                log(`[IP-BLOCKER] 📋 [INIT] IPs Bloqueados (${rows ? rows.length : 0}):`);
                if (rows && rows.length > 0) {
                  rows.forEach((row, index) => {
                    log(`[IP-BLOCKER]   ${index + 1}. IP: ${row.ip}, Reason: ${row.reason || 'N/A'}, Blocked at: ${row.blocked_at}, Requests: ${row.request_count || 0}`);
                  });
                }
              }
            });
          }
          
          // Lista os IPs da whitelist
          if (whitelistCount > 0) {
            const sqlWhitelistList = 'SELECT ip, abuse_confidence, reports, request_count, last_seen, created_at, expires_at FROM ip_whitelist WHERE expires_at > ? ORDER BY created_at DESC LIMIT 50';
            log(`[IP-BLOCKER] 🔍 [INIT] SQL: ${sqlWhitelistList}`);
            log(`[IP-BLOCKER] 🔍 [INIT] Parâmetros: [${now}]`);
            db.all(sqlWhitelistList, [now], (err, rows) => {
              if (err) {
                err(`[IP-BLOCKER] ❌ [INIT] Erro ao listar whitelist IPs:`, err.message);
              } else {
                log(`[IP-BLOCKER] 📋 [INIT] IPs Whitelist (${rows ? rows.length : 0}):`);
                if (rows && rows.length > 0) {
                  rows.forEach((row, index) => {
                    const expiresDate = row.expires_at ? new Date(row.expires_at * 1000).toISOString() : 'N/A';
                    const now = Math.floor(Date.now() / 1000);
                    const isValid = row.expires_at > now;
                    log(`[IP-BLOCKER]   ${index + 1}. IP: ${row.ip}, Confidence: ${row.abuse_confidence || 'N/A'}, Reports: ${row.reports || 0}, Requests: ${row.request_count || 0}, Expires: ${expiresDate} (${isValid ? 'VÁLIDO' : 'EXPIRADO'}), Now: ${now}`);
                  });
                } else {
                  log(`[IP-BLOCKER] ⚠️ [INIT] Nenhum IP retornado da whitelist, mas countWhitelistIPs retornou ${whitelistCount}`);
                }
              }
            });
          }
          
          // Lista os IPs da yellowlist
          if (yellowlistCount > 0) {
            const sqlYellowlistList = 'SELECT ip, abuse_confidence, reports, request_count, last_seen, created_at, expires_at FROM ip_yellowlist WHERE expires_at > ? ORDER BY created_at DESC LIMIT 50';
            log(`[IP-BLOCKER] 🔍 [INIT] SQL: ${sqlYellowlistList}`);
            log(`[IP-BLOCKER] 🔍 [INIT] Parâmetros: [${now}]`);
            db.all(sqlYellowlistList, [now], (err, rows) => {
              if (err) {
                err(`[IP-BLOCKER] ❌ [INIT] Erro ao listar yellowlist IPs:`, err.message);
              } else {
                log(`[IP-BLOCKER] 📋 [INIT] IPs Yellowlist (${rows ? rows.length : 0}):`);
                if (rows && rows.length > 0) {
                  rows.forEach((row, index) => {
                    log(`[IP-BLOCKER]   ${index + 1}. IP: ${row.ip}, Confidence: ${row.abuse_confidence || 'N/A'}, Reports: ${row.reports || 0}, Requests: ${row.request_count || 0}, Expires: ${row.expires_at}`);
                  });
                }
              }
            });
          }
        } catch (e) {
          warn(`[IP-BLOCKER] Erro ao verificar estatísticas:`, e.message);
          warn(`[IP-BLOCKER] Stack:`, e.stack);
        }
      }, 1000);
    })
    .catch((error) => {
      err(`[IP-BLOCKER] ❌ Erro ao inicializar banco de dados:`, error.message);
      err(`[IP-BLOCKER] Stack:`, error.stack);
      dbReady = false;
    });
  
  // Limpa entradas expiradas a cada hora
  setInterval(() => {
    cleanExpiredEntries().catch(err => {
      warn(`[IP-BLOCKER] Erro ao limpar entradas expiradas:`, err.message);
    });
  }, 60 * 60 * 1000);
  
  // Verifica e corrige duplicidades a cada 6 horas
  setInterval(() => {
    checkAndFixDuplicates().catch(err => {
      warn(`[IP-BLOCKER] Erro ao verificar duplicidades:`, err.message);
    });
  }, 6 * 60 * 60 * 1000);
  
  // Limpa auditoria WhatsApp diariamente
  setInterval(() => {
    cleanWhatsappAudit(AUDIT_RETENTION_DAYS).catch(err => {
      warn(`[IP-BLOCKER] Erro ao limpar auditoria WhatsApp:`, err.message);
    });
  }, 24 * 60 * 60 * 1000);
  
  // Limpa e verifica duplicidades na inicialização
  Promise.all([
    cleanExpiredEntries().catch(err => {
      warn(`[IP-BLOCKER] Erro ao limpar entradas expiradas na inicialização:`, err.message);
    }),
    cleanWhatsappAudit(AUDIT_RETENTION_DAYS).catch(err => {
      warn(`[IP-BLOCKER] Erro ao limpar auditoria WhatsApp na inicialização:`, err.message);
    }),
    checkAndFixDuplicates().catch(err => {
      warn(`[IP-BLOCKER] Erro ao verificar duplicidades na inicialização:`, err.message);
    })
  ]).then(() => {
      log(`[IP-BLOCKER] Verificação de integridade concluída`);
  });
  
  log(`[IP-BLOCKER] ✅ Módulo criado - ${Object.keys(moduleAPI).length} funções exportadas`);
  log(`[IP-BLOCKER] ✅ countBlockedIPs tipo: ${typeof moduleAPI.countBlockedIPs}`);
  
  // Retorna o moduleAPI (as funções aguardarão o banco quando chamadas)
  return moduleAPI;
  } catch (error) {
    // Se houver erro na inicialização, loga mas ainda retorna um objeto básico
    if (logger && logger.err) {
      logger.err(`[IP-BLOCKER] ❌ Erro crítico na inicialização:`, error.message);
      logger.err(`[IP-BLOCKER] Stack:`, error.stack);
    }
    // Retorna um objeto vazio com funções que retornam erro
    return {
      isBlocked: () => Promise.resolve(false),
      blockIP: () => Promise.reject(new Error('IP Blocker não inicializado')),
      unblockIP: () => Promise.reject(new Error('IP Blocker não inicializado')),
      recordBlockedAttempt: () => Promise.resolve(),
      recordWhitelistAttempt: () => Promise.resolve(),
      recordYellowlistAttempt: () => Promise.resolve(),
      recordIPAttempt: () => Promise.resolve({ listType: null, updated: false }),
      listBlockedIPs: () => Promise.resolve([]),
      countBlockedIPs: () => Promise.resolve(0),
      listWhitelistIPs: () => Promise.resolve([]),
      listYellowlistIPs: () => Promise.resolve([]),
      countWhitelistIPs: () => Promise.resolve(0),
      countYellowlistIPs: () => Promise.resolve(0),
      addToWhitelist: () => Promise.reject(new Error('IP Blocker não inicializado')),
      addToYellowlist: () => Promise.reject(new Error('IP Blocker não inicializado')),
      isInWhitelist: () => Promise.resolve({ inWhitelist: false }),
      isInYellowlist: () => Promise.resolve({ inYellowlist: false }),
      logMigration: () => Promise.resolve(),
      listMigrationLogs: () => Promise.resolve([]),
      countMigrationLogs: () => Promise.resolve(0),
      checkAndFixDuplicates: () => Promise.resolve({ removed: 0, duplicates: [] }),
      cleanExpiredEntries: () => Promise.resolve({ whitelist: 0, yellowlist: 0 }),
      // Access Log fallbacks
      logAccessRequest: () => Promise.resolve(),
      listAccessLogs: () => Promise.resolve([]),
      countAccessLogs: () => Promise.resolve(0),
      getAccessStatsByRoute: () => Promise.resolve([]),
      getAccessStatsByIP: () => Promise.resolve([]),
      // WhatsApp Audit fallbacks
      logWhatsappAudit: () => Promise.resolve(),
      listWhatsappThreads: () => Promise.resolve([]),
      listWhatsappMessages: () => Promise.resolve([]),
      searchWhatsappMessages: () => Promise.resolve([]),
      cleanWhatsappAudit: () => Promise.resolve(0),
      // Tuya Events fallbacks
      logTuyaEvent: () => Promise.resolve(),
      listTuyaEvents: () => Promise.resolve([]),
      countTuyaEvents: () => Promise.resolve(0),
      // Admin Sessions fallbacks
      saveAdminSession: () => Promise.reject(new Error('Database not ready')),
      getAdminSession: () => Promise.resolve(null),
      getAdminSessionByFingerprint: () => Promise.resolve(null),
      updateAdminSessionLastUsed: () => Promise.resolve(),
      deleteAdminSession: () => Promise.resolve(),
      cleanExpiredAdminSessions: () => Promise.resolve(0),
      listTrustedDevices: () => Promise.resolve([]),
      revokeTrustedDevice: () => Promise.resolve(),
      // ESP32 Devices fallbacks
      updateESP32Device: () => Promise.resolve(),
      listESP32Devices: () => Promise.resolve([]),
      // Tuya Energy fallbacks
      saveTuyaEnergyReading: () => Promise.resolve(),
      listTuyaEnergyReadings: () => Promise.resolve([]),
      getTuyaEnergyStats: () => Promise.resolve(null),
      getTuyaEnergyByHour: () => Promise.resolve([]),
      close: () => Promise.resolve()
    };
  }
}

module.exports = { initIPBlockerModule };

