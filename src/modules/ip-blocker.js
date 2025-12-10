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
        
        // Cria tabela se não existir
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
            err(`[IP-BLOCKER] Erro ao criar tabela:`, error.message);
            reject(error);
            return;
          }
          
          // Cria índice para busca rápida
          db.run(`
            CREATE INDEX IF NOT EXISTS idx_blocked_ips_ip ON blocked_ips(ip)
          `, (error) => {
            if (error) {
              warn(`[IP-BLOCKER] Erro ao criar índice:`, error.message);
            }
            resolve();
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
  
  return {
    isBlocked,
    blockIP,
    unblockIP,
    recordBlockedAttempt,
    listBlockedIPs,
    countBlockedIPs,
    close
  };
}

module.exports = { initIPBlockerModule };

