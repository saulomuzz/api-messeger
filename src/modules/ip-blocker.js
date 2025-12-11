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
  const { log, dbg, warn, err } = logger;
  
  const DB_PATH = path.join(appRoot, 'blocked_ips.db');
  let db = null;
  
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
                created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
                expires_at INTEGER NOT NULL
              )
            `, (error) => {
              if (error) {
                err(`[IP-BLOCKER] Erro ao criar tabela ip_yellowlist:`, error.message);
                reject(error);
                return;
              }
              
              // Cria índices para busca rápida
              db.run(`
                CREATE INDEX IF NOT EXISTS idx_blocked_ips_ip ON blocked_ips(ip);
                CREATE INDEX IF NOT EXISTS idx_whitelist_ip ON ip_whitelist(ip);
                CREATE INDEX IF NOT EXISTS idx_whitelist_expires ON ip_whitelist(expires_at);
                CREATE INDEX IF NOT EXISTS idx_yellowlist_ip ON ip_yellowlist(ip);
                CREATE INDEX IF NOT EXISTS idx_yellowlist_expires ON ip_yellowlist(expires_at)
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
   * Bloqueia um IP
   * @param {string} ip - Endereço IP
   * @param {string} reason - Motivo do bloqueio
   * @returns {Promise<boolean>} true se bloqueado com sucesso
   */
  function blockIP(ip, reason = 'Atividade suspeita') {
    return new Promise((resolve, reject) => {
      if (!db) {
        reject(new Error('Banco de dados não inicializado'));
        return;
      }
      
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
   * Lista todos os IPs bloqueados
   * @param {number} limit - Limite de resultados
   * @param {number} offset - Offset para paginação
   * @returns {Promise<Array>} Lista de IPs bloqueados
   */
  function listBlockedIPs(limit = 100, offset = 0) {
    return new Promise((resolve, reject) => {
      if (!db) {
        resolve([]);
        return;
      }
      
      db.all(`
        SELECT ip, reason, blocked_at, last_seen, request_count, created_at
        FROM blocked_ips
        ORDER BY blocked_at DESC
        LIMIT ? OFFSET ?
      `, [limit, offset], (error, rows) => {
        if (error) {
          err(`[IP-BLOCKER] Erro ao listar IPs bloqueados:`, error.message);
          reject(error);
          return;
        }
        
        resolve(rows);
      });
    });
  }
  
  /**
   * Conta total de IPs bloqueados
   * @returns {Promise<number>} Número de IPs bloqueados
   */
  function countBlockedIPs() {
    return new Promise((resolve) => {
      if (!db) {
        resolve(0);
        return;
      }
      
      db.get('SELECT COUNT(*) as count FROM blocked_ips', [], (error, row) => {
        if (error) {
          err(`[IP-BLOCKER] Erro ao contar IPs bloqueados:`, error.message);
          resolve(0);
          return;
        }
        
        resolve(row ? row.count : 0);
      });
    });
  }
  
  /**
   * Adiciona IP à whitelist
   * @param {string} ip - Endereço IP
   * @param {number} abuseConfidence - Confiança de abuso (0-100)
   * @param {number} reports - Número de reports
   * @param {number} ttlDays - Tempo de vida em dias (padrão: 15)
   * @returns {Promise<boolean>} true se adicionado com sucesso
   */
  function addToWhitelist(ip, abuseConfidence, reports = 0, ttlDays = 15) {
    return new Promise((resolve, reject) => {
      if (!db) {
        reject(new Error('Banco de dados não inicializado'));
        return;
      }
      
      const now = Math.floor(Date.now() / 1000);
      const expiresAt = now + (ttlDays * 24 * 60 * 60);
      
      db.run(`
        INSERT OR REPLACE INTO ip_whitelist (ip, abuse_confidence, reports, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?)
      `, [ip, abuseConfidence, reports, now, expiresAt], function(error) {
        if (error) {
          err(`[IP-BLOCKER] Erro ao adicionar à whitelist:`, error.message);
          reject(error);
          return;
        }
        
        dbg(`[IP-BLOCKER] IP adicionado à whitelist: ${ip} (${abuseConfidence}% confiança, válido até ${new Date(expiresAt * 1000).toISOString()})`);
        resolve(true);
      });
    });
  }
  
  /**
   * Adiciona IP à yellowlist
   * @param {string} ip - Endereço IP
   * @param {number} abuseConfidence - Confiança de abuso (0-100)
   * @param {number} reports - Número de reports
   * @param {number} ttlDays - Tempo de vida em dias (padrão: 7)
   * @returns {Promise<boolean>} true se adicionado com sucesso
   */
  function addToYellowlist(ip, abuseConfidence, reports = 0, ttlDays = 7) {
    return new Promise((resolve, reject) => {
      if (!db) {
        reject(new Error('Banco de dados não inicializado'));
        return;
      }
      
      const now = Math.floor(Date.now() / 1000);
      const expiresAt = now + (ttlDays * 24 * 60 * 60);
      
      db.run(`
        INSERT OR REPLACE INTO ip_yellowlist (ip, abuse_confidence, reports, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?)
      `, [ip, abuseConfidence, reports, now, expiresAt], function(error) {
        if (error) {
          err(`[IP-BLOCKER] Erro ao adicionar à yellowlist:`, error.message);
          reject(error);
          return;
        }
        
        dbg(`[IP-BLOCKER] IP adicionado à yellowlist: ${ip} (${abuseConfidence}% confiança, válido até ${new Date(expiresAt * 1000).toISOString()})`);
        resolve(true);
      });
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
        SELECT ip, abuse_confidence, expires_at 
        FROM ip_whitelist 
        WHERE ip = ? AND expires_at > ?
      `, [ip, now], (error, row) => {
        if (error) {
          dbg(`[IP-BLOCKER] Erro ao verificar whitelist:`, error.message);
          resolve({ inWhitelist: false });
          return;
        }
        
        if (row) {
          resolve({
            inWhitelist: true,
            abuseConfidence: row.abuse_confidence,
            expiresAt: row.expires_at
          });
        } else {
          resolve({ inWhitelist: false });
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
        SELECT ip, abuse_confidence, expires_at 
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
            expiresAt: row.expires_at
          });
        } else {
          resolve({ inYellowlist: false });
        }
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
   */
  async function migrateFromJSON(jsonFilePath) {
    try {
      if (!fs.existsSync(jsonFilePath)) {
        return;
      }
      
      const data = JSON.parse(fs.readFileSync(jsonFilePath, 'utf8'));
      const ips = data.blockedIPs || [];
      
      if (ips.length === 0) {
        return;
      }
      
      log(`[IP-BLOCKER] Migrando ${ips.length} IP(s) do arquivo JSON para o banco...`);
      
      for (const ip of ips) {
        try {
          await blockIP(ip, 'Migrado do arquivo JSON');
        } catch (e) {
          warn(`[IP-BLOCKER] Erro ao migrar IP ${ip}:`, e.message);
        }
      }
      
      log(`[IP-BLOCKER] Migração concluída`);
    } catch (e) {
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
  
  // Inicializa o banco
  initDatabase()
    .then(() => {
      // Migra dados do JSON se existir
      const jsonFile = path.join(appRoot, 'blocked_ips.json');
      migrateFromJSON(jsonFile);
    })
    .catch((error) => {
      err(`[IP-BLOCKER] Erro ao inicializar banco de dados:`, error.message);
    });
  
  // Limpa entradas expiradas a cada hora
  setInterval(() => {
    cleanExpiredEntries().catch(err => {
      warn(`[IP-BLOCKER] Erro ao limpar entradas expiradas:`, err.message);
    });
  }, 60 * 60 * 1000);
  
  // Limpa na inicialização
  cleanExpiredEntries().catch(err => {
    warn(`[IP-BLOCKER] Erro ao limpar entradas expiradas na inicialização:`, err.message);
  });
  
  return {
    isBlocked,
    blockIP,
    unblockIP,
    recordBlockedAttempt,
    listBlockedIPs,
    countBlockedIPs,
    addToWhitelist,
    addToYellowlist,
    isInWhitelist,
    isInYellowlist,
    cleanExpiredEntries,
    close
  };
}

module.exports = { initIPBlockerModule };

