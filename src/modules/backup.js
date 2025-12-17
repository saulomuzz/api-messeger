/**
 * Módulo de Backup Automático
 * Realiza backups periódicos do banco de dados SQLite
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

/**
 * Inicializa o módulo de backup
 * @param {Object} config - Configuração do módulo
 * @param {string} config.appRoot - Diretório raiz da aplicação
 * @param {Object} config.logger - Objeto com funções de log
 * @param {number} config.intervalHours - Intervalo entre backups em horas (padrão: 24)
 * @param {number} config.maxBackups - Número máximo de backups a manter (padrão: 7)
 * @param {boolean} config.enabled - Se o backup automático está habilitado (padrão: true)
 * @returns {Object} API do módulo
 */
function initBackupModule({ 
  appRoot, 
  logger, 
  intervalHours = 24, 
  maxBackups = 7,
  enabled = true 
}) {
  const { log, dbg, warn, err } = logger;
  
  if (!appRoot) {
    throw new Error('appRoot é obrigatório');
  }
  
  // Diretórios
  const DB_PATH = path.join(appRoot, 'blocked_ips.db');
  const BACKUP_DIR = path.join(appRoot, 'backups');
  
  // Cria diretório de backups se não existir
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    log(`[BACKUP] Diretório de backups criado: ${BACKUP_DIR}`);
  }
  
  let backupInterval = null;
  
  /**
   * Formata data para nome de arquivo
   * @returns {string} Data formatada
   */
  function formatDateForFilename() {
    const now = new Date();
    return now.toISOString()
      .replace(/:/g, '-')
      .replace(/\./g, '-')
      .replace('T', '_')
      .replace('Z', '');
  }
  
  /**
   * Lista arquivos de backup existentes
   * @returns {string[]} Lista de arquivos de backup ordenados por data (mais antigo primeiro)
   */
  function listBackups() {
    try {
      if (!fs.existsSync(BACKUP_DIR)) {
        return [];
      }
      
      return fs.readdirSync(BACKUP_DIR)
        .filter(file => file.startsWith('backup_') && file.endsWith('.db'))
        .map(file => ({
          name: file,
          path: path.join(BACKUP_DIR, file),
          created: fs.statSync(path.join(BACKUP_DIR, file)).mtime
        }))
        .sort((a, b) => a.created - b.created); // Mais antigo primeiro
    } catch (error) {
      err(`[BACKUP] Erro ao listar backups:`, error.message);
      return [];
    }
  }
  
  /**
   * Remove backups antigos mantendo apenas os N mais recentes
   * @param {number} keepCount - Número de backups a manter
   */
  function cleanOldBackups(keepCount = maxBackups) {
    try {
      const backups = listBackups();
      
      if (backups.length <= keepCount) {
        dbg(`[BACKUP] Nenhum backup antigo para remover (${backups.length}/${keepCount})`);
        return { removed: 0, kept: backups.length };
      }
      
      const toRemove = backups.slice(0, backups.length - keepCount);
      let removed = 0;
      
      for (const backup of toRemove) {
        try {
          fs.unlinkSync(backup.path);
          removed++;
          dbg(`[BACKUP] Backup removido: ${backup.name}`);
        } catch (e) {
          warn(`[BACKUP] Erro ao remover backup ${backup.name}:`, e.message);
        }
      }
      
      log(`[BACKUP] Limpeza concluída: ${removed} backups removidos, ${backups.length - removed} mantidos`);
      return { removed, kept: backups.length - removed };
    } catch (error) {
      err(`[BACKUP] Erro na limpeza de backups:`, error.message);
      return { removed: 0, kept: 0, error: error.message };
    }
  }
  
  /**
   * Realiza o backup do banco de dados
   * @returns {Promise<{success: boolean, path: string, size: number}>}
   */
  async function createBackup() {
    return new Promise((resolve, reject) => {
      try {
        // Verifica se o banco existe
        if (!fs.existsSync(DB_PATH)) {
          warn(`[BACKUP] Banco de dados não encontrado: ${DB_PATH}`);
          resolve({ success: false, error: 'Banco de dados não encontrado' });
          return;
        }
        
        const timestamp = formatDateForFilename();
        const backupFileName = `backup_${timestamp}.db`;
        const backupPath = path.join(BACKUP_DIR, backupFileName);
        
        // Copia o arquivo de banco de dados
        // Usando copyFileSync para garantir cópia completa
        fs.copyFileSync(DB_PATH, backupPath);
        
        // Verifica se a cópia foi bem sucedida
        if (!fs.existsSync(backupPath)) {
          reject(new Error('Falha ao criar arquivo de backup'));
          return;
        }
        
        const stats = fs.statSync(backupPath);
        const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
        
        log(`[BACKUP] ✅ Backup criado: ${backupFileName} (${sizeMB} MB)`);
        
        // Limpa backups antigos
        cleanOldBackups();
        
        resolve({
          success: true,
          path: backupPath,
          filename: backupFileName,
          size: stats.size,
          sizeMB: parseFloat(sizeMB),
          created: new Date().toISOString()
        });
      } catch (error) {
        err(`[BACKUP] Erro ao criar backup:`, error.message);
        reject(error);
      }
    });
  }
  
  /**
   * Restaura um backup específico
   * @param {string} backupName - Nome do arquivo de backup
   * @returns {Promise<{success: boolean}>}
   */
  async function restoreBackup(backupName) {
    return new Promise((resolve, reject) => {
      try {
        const backupPath = path.join(BACKUP_DIR, backupName);
        
        if (!fs.existsSync(backupPath)) {
          reject(new Error(`Backup não encontrado: ${backupName}`));
          return;
        }
        
        // Cria backup do banco atual antes de restaurar
        const currentBackupName = `pre_restore_${formatDateForFilename()}.db`;
        const currentBackupPath = path.join(BACKUP_DIR, currentBackupName);
        
        if (fs.existsSync(DB_PATH)) {
          fs.copyFileSync(DB_PATH, currentBackupPath);
          log(`[BACKUP] Backup pré-restauração criado: ${currentBackupName}`);
        }
        
        // Restaura o backup
        fs.copyFileSync(backupPath, DB_PATH);
        
        log(`[BACKUP] ✅ Backup restaurado: ${backupName}`);
        
        resolve({
          success: true,
          restoredFrom: backupName,
          preRestoreBackup: currentBackupName
        });
      } catch (error) {
        err(`[BACKUP] Erro ao restaurar backup:`, error.message);
        reject(error);
      }
    });
  }
  
  /**
   * Obtém informações sobre os backups
   * @returns {Object} Informações sobre backups
   */
  function getBackupInfo() {
    const backups = listBackups();
    const latestBackup = backups.length > 0 ? backups[backups.length - 1] : null;
    
    let dbSize = 0;
    if (fs.existsSync(DB_PATH)) {
      dbSize = fs.statSync(DB_PATH).size;
    }
    
    return {
      enabled,
      intervalHours,
      maxBackups,
      backupDir: BACKUP_DIR,
      dbPath: DB_PATH,
      dbSizeMB: (dbSize / (1024 * 1024)).toFixed(2),
      backupCount: backups.length,
      backups: backups.map(b => ({
        name: b.name,
        sizeMB: (fs.statSync(b.path).size / (1024 * 1024)).toFixed(2),
        created: b.created.toISOString()
      })),
      latestBackup: latestBackup ? {
        name: latestBackup.name,
        created: latestBackup.created.toISOString()
      } : null
    };
  }
  
  /**
   * Inicia o backup automático
   */
  function startAutoBackup() {
    if (!enabled) {
      log(`[BACKUP] Backup automático desabilitado`);
      return;
    }
    
    if (backupInterval) {
      clearInterval(backupInterval);
    }
    
    const intervalMs = intervalHours * 60 * 60 * 1000;
    
    // Faz um backup inicial após 1 minuto (para não atrasar a inicialização)
    setTimeout(async () => {
      try {
        await createBackup();
      } catch (error) {
        err(`[BACKUP] Erro no backup inicial:`, error.message);
      }
    }, 60 * 1000);
    
    // Configura o intervalo de backup
    backupInterval = setInterval(async () => {
      try {
        await createBackup();
      } catch (error) {
        err(`[BACKUP] Erro no backup automático:`, error.message);
      }
    }, intervalMs);
    
    log(`[BACKUP] ✅ Backup automático iniciado (intervalo: ${intervalHours}h, máximo: ${maxBackups} backups)`);
  }
  
  /**
   * Para o backup automático
   */
  function stopAutoBackup() {
    if (backupInterval) {
      clearInterval(backupInterval);
      backupInterval = null;
      log(`[BACKUP] Backup automático parado`);
    }
  }
  
  // Inicia backup automático se habilitado
  startAutoBackup();
  
  return {
    createBackup,
    restoreBackup,
    listBackups: () => listBackups().map(b => ({ name: b.name, created: b.created.toISOString() })),
    cleanOldBackups,
    getBackupInfo,
    startAutoBackup,
    stopAutoBackup
  };
}

module.exports = { initBackupModule };
