/**
 * Módulo de Bloqueio de IPs
 * Gerencia bloqueio de IPs usando SQLite
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

/**
 * Inicializa o módulo de bloqueio de IPs
 * @param {Object} config - Configuração do módulo
 * @param {string} config.appRoot - Diretório raiz da aplicação
 * @param {Object} config.logger - Objeto com funções de log
 * @returns {Object} API do módulo
 */
function initIPBlockerModule({ appRoot, logger }) {
  try {
    const { log, dbg, warn, err } = logger;
    
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
  }
  
  /**
   * Verifica se um IP está bloqueado
   * @param {string} ip - Endereço IP
   * @returns {Promise<boolean>} true se estiver bloqueado
   */
  function isBlocked(ip) {
    return new Promise((resolve, reject) => {
      if (!db) {
        resolve(false);
        return;
      }
      
      db.get('SELECT ip FROM blocked_ips WHERE ip = ?', [ip], (error, row) => {
        if (error) {
          err(`[IP-BLOCKER] Erro ao verificar IP:`, error.message);
          resolve(false); // Em caso de erro, permite acesso
          return;
        }
        
        resolve(!!row);
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
        SELECT ip, reason, blocked_at, last_seen, request_count, created_at
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
        SELECT ip, abuse_confidence, reports, request_count, last_seen, created_at, expires_at
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
        SELECT ip, abuse_confidence, reports, request_count, last_seen, created_at, expires_at
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
   * @returns {Promise<boolean>} true se adicionado com sucesso
   */
  function addToWhitelist(ip, abuseConfidence, reports = 0, ttlDays = 15) {
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
        
        // Se o IP já existe, mantém request_count e last_seen, apenas atualiza outros campos
        // Se não existe, cria com request_count=1 e last_seen=now
        db.run(`
          INSERT INTO ip_whitelist (ip, abuse_confidence, reports, request_count, last_seen, created_at, expires_at)
          VALUES (?, ?, ?, 1, ?, ?, ?)
          ON CONFLICT(ip) DO UPDATE SET
            abuse_confidence = excluded.abuse_confidence,
            reports = excluded.reports,
            expires_at = excluded.expires_at,
            last_seen = excluded.last_seen,
            request_count = request_count + 1
        `, [ip, abuseConfidence, reports, now, now, expiresAt], function(error) {
          if (error) {
            err(`[IP-BLOCKER] Erro ao adicionar à whitelist:`, error.message);
            reject(error);
            return;
          }
          
          // Registra migração se mudou de lista
          if (fromList && fromList !== 'whitelist') {
            logMigration(ip, fromList, 'whitelist', oldConfidence, abuseConfidence, oldReports, reports, 'Classificação automática pelo AbuseIPDB');
          }
          
          dbg(`[IP-BLOCKER] IP adicionado à whitelist: ${ip} (${abuseConfidence}% confiança, válido até ${new Date(expiresAt * 1000).toISOString()})`);
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
   * @returns {Promise<boolean>} true se adicionado com sucesso
   */
  function addToYellowlist(ip, abuseConfidence, reports = 0, ttlDays = 7) {
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
        
        // Se o IP já existe, mantém request_count e last_seen, apenas atualiza outros campos
        // Se não existe, cria com request_count=1 e last_seen=now
        db.run(`
          INSERT INTO ip_yellowlist (ip, abuse_confidence, reports, request_count, last_seen, created_at, expires_at)
          VALUES (?, ?, ?, 1, ?, ?, ?)
          ON CONFLICT(ip) DO UPDATE SET
            abuse_confidence = excluded.abuse_confidence,
            reports = excluded.reports,
            expires_at = excluded.expires_at,
            last_seen = excluded.last_seen,
            request_count = request_count + 1
        `, [ip, abuseConfidence, reports, now, now, expiresAt], function(error) {
          if (error) {
            err(`[IP-BLOCKER] Erro ao adicionar à yellowlist:`, error.message);
            reject(error);
            return;
          }
          
          // Registra migração se mudou de lista
          if (fromList && fromList !== 'yellowlist') {
            logMigration(ip, fromList, 'yellowlist', oldConfidence, abuseConfidence, oldReports, reports, 'Classificação automática pelo AbuseIPDB');
          }
          
          dbg(`[IP-BLOCKER] IP adicionado à yellowlist: ${ip} (${abuseConfidence}% confiança, válido até ${new Date(expiresAt * 1000).toISOString()})`);
          resolve(true);
        });
      } catch (e) {
        reject(e);
      }
    });
  }
  
  /**
   * Verifica se IP está na whitelist e ainda válido
   * @param {string} ip - Endereço IP
   * @returns {Promise<{inWhitelist: boolean, abuseConfidence: number, expiresAt: number}>}
   */
  function isInWhitelist(ip) {
    return new Promise((resolve) => {
      if (!db) {
        resolve({ inWhitelist: false });
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
          resolve({
            inWhitelist: true,
            abuseConfidence: row.abuse_confidence,
            expiresAt: row.expires_at,
            requestCount: row.request_count || 0,
            lastSeen: row.last_seen
          });
        } else {
          // Verifica se o IP existe mas está expirado
          db.get(`SELECT ip, expires_at FROM ip_whitelist WHERE ip = ?`, [ip], (err, expiredRow) => {
            if (expiredRow) {
              dbg(`[IP-BLOCKER] IP ${ip} existe na whitelist mas está EXPIRADO: expires_at=${expiredRow.expires_at}, now=${now}`);
            }
            resolve({ inWhitelist: false });
          });
        }
      });
    });
  }
  
  /**
   * Verifica se IP está na yellowlist e ainda válido
   * @param {string} ip - Endereço IP
   * @returns {Promise<{inYellowlist: boolean, abuseConfidence: number, expiresAt: number}>}
   */
  function isInYellowlist(ip) {
    return new Promise((resolve) => {
      if (!db) {
        resolve({ inYellowlist: false });
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
          resolve({
            inYellowlist: true,
            abuseConfidence: row.abuse_confidence,
            expiresAt: row.expires_at,
            requestCount: row.request_count || 0,
            lastSeen: row.last_seen
          });
        } else {
          resolve({ inYellowlist: false });
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
      close,
      // Estatísticas
      saveStatistic,
      loadStatistic,
      incrementRouteStat,
      incrementIPStat,
      getAllRoutes,
      getAllIPs,
      getTopRoutes,
      getTopIPs,
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
  
  // Limpa e verifica duplicidades na inicialização
  Promise.all([
    cleanExpiredEntries().catch(err => {
      warn(`[IP-BLOCKER] Erro ao limpar entradas expiradas na inicialização:`, err.message);
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
      close: () => Promise.resolve()
    };
  }
}

module.exports = { initIPBlockerModule };

