// Dashboard JavaScript - Versão 2.0
let currentTab = 'overview';
let statsData = null;

// Estado de paginação e ordenação
const pagination = {
  blocked: { offset: 0, limit: 20 },
  whitelist: { offset: 0, limit: 20 },
  yellowlist: { offset: 0, limit: 20 },
  migrations: { offset: 0, limit: 20 },
  trusted: { offset: 0, limit: 50 }
};

const sortState = {
  blocked: { field: 'blocked_at', order: 'desc' },
  whitelist: { field: 'last_seen', order: 'desc' },
  yellowlist: { field: 'last_seen', order: 'desc' },
  migrations: { field: 'created_at', order: 'desc' },
  trusted: { field: 'category', order: 'asc' }
};

// Estado de filtros
const filterState = {
  blocked: { ip: '', reason: '' },
  whitelist: { ip: '', confidence: '' },
  yellowlist: { ip: '', confidence: '' },
  migrations: { ip: '', toList: '' },
  trusted: { category: '', enabled: '' }
};

// ===== UTILIDADES =====

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `${type === 'success' ? '✅' : type === 'error' ? '❌' : '⚠️'} ${message}`;
  container.appendChild(toast);
  
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function formatDate(timestamp) {
  if (!timestamp) return 'N/A';
  const date = new Date(typeof timestamp === 'number' && timestamp < 1e12 ? timestamp * 1000 : timestamp);
  return date.toLocaleString('pt-BR');
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function getFlagEmoji(countryCode) {
  if (!countryCode || countryCode.length !== 2) return '🌐';
  const codePoints = countryCode
    .toUpperCase()
    .split('')
    .map(char => 127397 + char.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

function updateLastUpdateTime() {
  document.getElementById('lastUpdate').textContent = `Atualizado: ${new Date().toLocaleTimeString('pt-BR')}`;
}

// ===== NAVEGAÇÃO =====

function switchTab(tabName, event) {
  document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
  
  if (event && event.target) {
    event.target.classList.add('active');
  }
  document.getElementById(`tab-${tabName}`).classList.add('active');
  currentTab = tabName;
  
  loadTabData(tabName);
}

function loadTabData(tabName) {
  switch(tabName) {
    case 'overview': loadOverview(); break;
    case 'lookup': break; // Não carrega nada automaticamente
    case 'ips': loadBlocked(); break;
    case 'whitelist': loadWhitelist(); break;
    case 'yellowlist': loadYellowlist(); break;
    case 'trusted': loadTrustedRanges(); break;
    case 'tuya': loadTuyaDevices(); break;
    case 'access': loadAccessLogs(); break;
    case 'devices': loadDevices(); break;
    case 'migrations': loadMigrations(); break;
    case 'server': loadServerMetrics(); loadAbuseIPDBStats(); loadTrustedDevices(); break;
    case 'send': break; // Formulário manual, não carrega nada
    case 'comedor': 
      if (typeof loadComedorTab === 'function') loadComedorTab(); 
      break;
  }
}

// ===== VISÃO GERAL =====

async function loadOverview() {
  try {
    const response = await fetch('/admin/api/dashboard/stats');
    const data = await response.json();
    
    if (data.success) {
      statsData = data.stats;
      renderOverviewStats(data.stats);
      renderCharts(data.stats);
      renderSystemInfo(data.stats);
      updateLastUpdateTime();
    }
  } catch (error) {
    console.error('Erro ao carregar visão geral:', error);
    showToast('Erro ao carregar estatísticas', 'error');
  }
}

function renderOverviewStats(stats) {
  const html = `
    <div class="stat-card blocked">
      <div class="stat-label">IPs Bloqueados</div>
      <div class="stat-value">${stats.ips?.blocked || 0}</div>
    </div>
    <div class="stat-card whitelist">
      <div class="stat-label">Whitelist</div>
      <div class="stat-value">${stats.ips?.whitelist || 0}</div>
    </div>
    <div class="stat-card yellowlist">
      <div class="stat-label">Yellowlist</div>
      <div class="stat-value">${stats.ips?.yellowlist || 0}</div>
    </div>
    <div class="stat-card trusted">
      <div class="stat-label">IPs Confiáveis</div>
      <div class="stat-value">${stats.ips?.trusted || '-'}</div>
    </div>
    <div class="stat-card messages-sent">
      <div class="stat-label">Mensagens Enviadas</div>
      <div class="stat-value">${stats.messages?.totalSent || 0}</div>
      <div class="stat-subtitle">24h: ${stats.messages?.last24h?.sent || 0}</div>
    </div>
    <div class="stat-card messages-received">
      <div class="stat-label">Mensagens Recebidas</div>
      <div class="stat-value">${stats.messages?.totalReceived || 0}</div>
      <div class="stat-subtitle">24h: ${stats.messages?.last24h?.received || 0}</div>
    </div>
    <div class="stat-card devices">
      <div class="stat-label">Dispositivos</div>
      <div class="stat-value">${stats.devices?.active || 0}</div>
      <div class="stat-subtitle">Total: ${stats.devices?.total || 0}</div>
    </div>
    <div class="stat-card migrations">
      <div class="stat-label">Migrações</div>
      <div class="stat-value">${stats.ips?.migrations || 0}</div>
    </div>
  `;
  document.getElementById('overviewStats').innerHTML = html;
}

function renderCharts(stats) {
  // Gráfico de mensagens
  if (!stats.hourly || stats.hourly.length === 0 || stats.hourly.every(h => h.sent === 0 && h.received === 0)) {
    document.getElementById('messagesChart').innerHTML = '<div class="empty-state"><div class="empty-state-icon">📭</div>Nenhuma mensagem nas últimas 24h</div>';
  } else {
    const maxValue = Math.max(...stats.hourly.map(h => Math.max(h.sent, h.received)), 1);
    const chartHtml = `
      <div style="display: flex; align-items: flex-end; height: 150px; gap: 2px; padding: 10px 0;">
        ${stats.hourly.map((h, i) => {
          const sentHeight = (h.sent / maxValue) * 100;
          const receivedHeight = (h.received / maxValue) * 100;
          const hour = String(i).padStart(2, '0');
          return `
            <div style="flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px; height: 100%;">
              <div style="flex: 1; display: flex; align-items: flex-end; gap: 1px; width: 100%;">
                <div style="flex: 1; background: linear-gradient(to top, #9b59b6, #8e44ad); height: ${sentHeight}%; border-radius: 2px 2px 0 0;" title="Enviadas: ${h.sent}"></div>
                <div style="flex: 1; background: linear-gradient(to top, #1abc9c, #16a085); height: ${receivedHeight}%; border-radius: 2px 2px 0 0;" title="Recebidas: ${h.received}"></div>
              </div>
              ${i % 4 === 0 ? `<div style="font-size: 9px; color: #999;">${hour}h</div>` : ''}
            </div>
          `;
        }).join('')}
      </div>
      <div style="display: flex; justify-content: center; gap: 20px; margin-top: 8px; font-size: 12px;">
        <span><span style="display: inline-block; width: 12px; height: 12px; background: #9b59b6; border-radius: 2px; margin-right: 4px;"></span>Enviadas</span>
        <span><span style="display: inline-block; width: 12px; height: 12px; background: #1abc9c; border-radius: 2px; margin-right: 4px;"></span>Recebidas</span>
      </div>
    `;
    document.getElementById('messagesChart').innerHTML = chartHtml;
  }
  
  // Top 5 rotas
  const top5Routes = (stats.routes?.topRoutes || []).slice(0, 5);
  const routesHtml = top5Routes.length > 0 ? `
    <div style="display: flex; flex-direction: column; gap: 8px;">
      ${top5Routes.map((route, index) => {
        const maxCount = top5Routes[0]?.count || 1;
        const width = (route.count / maxCount) * 100;
        return `
          <div style="padding: 10px; background: white; border-radius: 6px; border: 1px solid #e9ecef;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
              <span style="font-family: monospace; font-size: 12px; color: #333;">${route.route || 'N/A'}</span>
              <span style="font-weight: 600; color: #667eea;">${route.count || 0}</span>
            </div>
            <div style="height: 4px; background: #e9ecef; border-radius: 2px; overflow: hidden;">
              <div style="height: 100%; background: linear-gradient(90deg, #667eea, #764ba2); width: ${width}%;"></div>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  ` : '<div class="empty-state"><div class="empty-state-icon">🛤️</div>Nenhuma rota registrada</div>';
  document.getElementById('routesChart').innerHTML = routesHtml;
  
  // Top 5 IPs
  const top5IPs = (stats.topIPs || []).slice(0, 5);
  const ipsHtml = top5IPs.length > 0 ? `
    <div style="display: flex; flex-direction: column; gap: 8px;">
      ${top5IPs.map((ipData, index) => {
        const maxCount = top5IPs[0]?.count || 1;
        const width = (ipData.count / maxCount) * 100;
        return `
          <div style="padding: 10px; background: white; border-radius: 6px; border: 1px solid #e9ecef;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
              <span style="font-family: monospace; font-size: 12px; color: #333;">${ipData.ip || 'N/A'}</span>
              <div style="display: flex; align-items: center; gap: 8px;">
                <span style="font-weight: 600; color: #e74c3c;">${ipData.count || 0}</span>
                <button class="btn-action btn-lookup" onclick="quickLookup('${ipData.ip}')" title="Consultar">🔍</button>
              </div>
            </div>
            <div style="height: 4px; background: #e9ecef; border-radius: 2px; overflow: hidden;">
              <div style="height: 100%; background: linear-gradient(90deg, #e74c3c, #c0392b); width: ${width}%;"></div>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  ` : '<div class="empty-state"><div class="empty-state-icon">🌐</div>Nenhum IP registrado</div>';
  document.getElementById('topIPsChart').innerHTML = ipsHtml;
}

function renderSystemInfo(stats) {
  const uptime = stats.system?.uptime || 0;
  const whatsappStatus = stats.whatsapp?.ready ? 'online' : 'offline';
  
  const html = `
    <div class="info-card">
      <div class="info-label">Uptime</div>
      <div class="info-value">${formatUptime(uptime)}</div>
    </div>
    <div class="info-card" style="border-left-color: ${whatsappStatus === 'online' ? '#27ae60' : '#e74c3c'};">
      <div class="info-label">WhatsApp</div>
      <div class="info-value">
        <span class="status-indicator status-${whatsappStatus}"></span>
        ${whatsappStatus === 'online' ? 'Conectado' : 'Desconectado'}
      </div>
    </div>
    <div class="info-card" style="border-left-color: #e74c3c;">
      <div class="info-label">Mensagens Falhadas</div>
      <div class="info-value">${stats.messages?.totalFailed || 0}</div>
    </div>
    <div class="info-card" style="border-left-color: #9b59b6;">
      <div class="info-label">ESP32 Conectados</div>
      <div class="info-value">${stats.esp32?.connected || 0}</div>
    </div>
  `;
  document.getElementById('systemInfo').innerHTML = html;
}

// ===== IP LOOKUP =====

function quickLookup(ip) {
  document.getElementById('ipLookupInput').value = ip;
  switchTab('lookup');
  lookupIP();
}

async function lookupIP() {
  const ip = document.getElementById('ipLookupInput').value.trim();
  const checkAbuse = document.getElementById('checkAbuseFlag').checked;
  
  if (!ip) {
    showToast('Digite um endereço IP', 'warning');
    return;
  }
  
  const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (!ipRegex.test(ip)) {
    showToast('Formato de IP inválido', 'error');
    return;
  }
  
  const btn = document.getElementById('lookupBtn');
  btn.disabled = true;
  btn.innerHTML = '⏳ Consultando...';
  
  try {
    const response = await fetch(`/admin/api/ip/lookup?ip=${ip}&checkAbuse=${checkAbuse}`);
    const data = await response.json();
    
    if (data.success) {
      renderLookupResult(data);
      showToast('Consulta realizada com sucesso', 'success');
    } else {
      showToast(data.error || 'Erro ao consultar IP', 'error');
    }
  } catch (error) {
    console.error('Erro ao consultar IP:', error);
    showToast('Erro ao consultar IP', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '🔍 Consultar';
  }
}

function renderLookupResult(data) {
  const resultDiv = document.getElementById('lookupResult');
  resultDiv.classList.add('visible');
  
  const { ip, status, abuse, migrations } = data;
  
  // Determina badges de status
  const badges = [];
  if (status.currentList === 'blocked') badges.push('<span class="badge blocked">Bloqueado</span>');
  else if (status.currentList === 'whitelist') badges.push('<span class="badge whitelist">Whitelist</span>');
  else if (status.currentList === 'yellowlist') badges.push('<span class="badge yellowlist">Yellowlist</span>');
  else badges.push('<span class="badge none">Não classificado</span>');
  
  if (status.trusted) {
    badges.push(`<span class="badge trusted">Confiável (${status.trusted.category})</span>`);
  }
  
  let html = `
    <div class="lookup-result-card">
      <div class="lookup-result-header">
        <div class="lookup-ip">${ip}</div>
        <div class="lookup-status-badges">${badges.join('')}</div>
      </div>
      
      <div class="lookup-details">
  `;
  
  // Detalhes da lista atual
  if (status.listDetails) {
    html += `
      <div class="lookup-detail-card">
        <div class="lookup-detail-title">📋 Detalhes da Lista</div>
        <div class="lookup-detail-row">
          <span class="label">Confiança AbuseIPDB:</span>
          <span class="value">${status.listDetails.abuseConfidence || 0}%</span>
        </div>
        <div class="lookup-detail-row">
          <span class="label">Expira em:</span>
          <span class="value">${formatDate(status.listDetails.expiresAt)}</span>
        </div>
      </div>
    `;
  }
  
  // Dados do AbuseIPDB
  if (abuse) {
    if (abuse.error) {
      html += `
        <div class="lookup-detail-card abuse">
          <div class="lookup-detail-title">🔍 AbuseIPDB</div>
          <div class="lookup-detail-row">
            <span class="label">Erro:</span>
            <span class="value" style="color: #e74c3c;">${abuse.error}</span>
          </div>
        </div>
      `;
    } else {
      const confidenceColor = abuse.abuseConfidence >= 70 ? '#e74c3c' : 
                              abuse.abuseConfidence >= 30 ? '#f39c12' : '#27ae60';
      
      // Mapeamento de códigos de país para bandeiras emoji
      const countryFlag = abuse.countryCode ? getFlagEmoji(abuse.countryCode) : '🌐';
      const countryName = abuse.countryCode || 'Desconhecido';
      
      html += `
        <div class="lookup-detail-card abuse">
          <div class="lookup-detail-title">🔍 AbuseIPDB</div>
          <div class="lookup-detail-row">
            <span class="label">Confiança de Abuso:</span>
            <span class="value" style="color: ${confidenceColor}; font-size: 18px; font-weight: bold;">${abuse.abuseConfidence || 0}%</span>
          </div>
          <div class="lookup-detail-row">
            <span class="label">Reports:</span>
            <span class="value">${abuse.reports || 0} ${abuse.numDistinctUsers ? `(${abuse.numDistinctUsers} usuários)` : ''}</span>
          </div>
          <div class="lookup-detail-row">
            <span class="label">País:</span>
            <span class="value">${countryFlag} ${countryName}</span>
          </div>
          ${abuse.isp ? `
          <div class="lookup-detail-row">
            <span class="label">ISP:</span>
            <span class="value">${abuse.isp}</span>
          </div>
          ` : ''}
          ${abuse.domain ? `
          <div class="lookup-detail-row">
            <span class="label">Domínio:</span>
            <span class="value">${abuse.domain}</span>
          </div>
          ` : ''}
          <div class="lookup-detail-row">
            <span class="label">Tipo de Uso:</span>
            <span class="value">${abuse.usageType || 'Desconhecido'}</span>
          </div>
          ${abuse.isTor ? `
          <div class="lookup-detail-row">
            <span class="label">Tor:</span>
            <span class="value" style="color: #e74c3c;">🧅 Sim (nó Tor)</span>
          </div>
          ` : ''}
          ${abuse.lastReportedAt ? `
          <div class="lookup-detail-row">
            <span class="label">Último Report:</span>
            <span class="value">${formatDate(abuse.lastReportedAt)}</span>
          </div>
          ` : ''}
          ${abuse.fromCache ? `
          <div class="lookup-detail-row">
            <span class="label">Fonte:</span>
            <span class="value">${abuse.fromCache}</span>
          </div>
          ` : ''}
        </div>
      `;
    }
  }
  
  // IP Confiável
  if (status.trusted) {
    html += `
      <div class="lookup-detail-card trusted">
        <div class="lookup-detail-title">🛡️ IP Confiável</div>
        <div class="lookup-detail-row">
          <span class="label">Categoria:</span>
          <span class="value">${status.trusted.category}</span>
        </div>
        <div class="lookup-detail-row">
          <span class="label">Status:</span>
          <span class="value" style="color: #27ae60;">✅ Permitido automaticamente</span>
        </div>
      </div>
    `;
  }
  
  html += '</div>';
  
  // Histórico de migrações
  if (migrations && migrations.length > 0) {
    html += `
      <div style="margin-top: 20px;">
        <div class="section-title">🔄 Histórico de Migrações</div>
        <table>
          <thead>
            <tr>
              <th>De</th>
              <th>Para</th>
              <th>Confiança</th>
              <th>Data</th>
            </tr>
          </thead>
          <tbody>
            ${migrations.map(m => `
              <tr>
                <td><span class="badge ${m.from_list || 'none'}">${m.from_list || 'Nenhuma'}</span></td>
                <td><span class="badge ${m.to_list}">${m.to_list}</span></td>
                <td>${m.old_confidence || '-'}% → ${m.new_confidence || '-'}%</td>
                <td>${formatDate(m.created_at)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }
  
  // Ações
  html += `
    <div style="margin-top: 20px; display: flex; gap: 10px; flex-wrap: wrap;">
      ${status.currentList === 'blocked' ? `
        <button class="btn-success" onclick="unblockIP('${ip}')">🔓 Desbloquear</button>
      ` : status.currentList !== 'none' ? `
        <button class="btn-danger" onclick="migrateIP('${ip}', '${status.currentList}', 'blocked')">🚫 Bloquear</button>
      ` : ''}
      ${status.currentList !== 'whitelist' ? `
        <button class="btn-success" onclick="migrateIP('${ip}', '${status.currentList}', 'whitelist')">✅ Adicionar à Whitelist</button>
      ` : ''}
    </div>
  `;
  
  html += '</div>';
  resultDiv.innerHTML = html;
}

// ===== TRUSTED RANGES =====

async function loadTrustedRanges() {
  const category = document.getElementById('filterTrustedCategory')?.value || '';
  const enabledOnly = document.getElementById('filterTrustedEnabled')?.value || '';
  
  try {
    let url = '/admin/api/trusted-ranges?';
    if (category) url += `category=${category}&`;
    if (enabledOnly) url += `enabledOnly=${enabledOnly}`;
    
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.success) {
      renderTrustedCategories(data.counts);
      renderTrustedTable(data.ranges);
    }
  } catch (error) {
    console.error('Erro ao carregar trusted ranges:', error);
    document.getElementById('trustedTable').innerHTML = '<div class="empty-state">Erro ao carregar dados</div>';
  }
}

function renderTrustedCategories(counts) {
  const categoryIcons = {
    meta: '📘',
    cloudflare: '☁️',
    esp32: '📡',
    custom: '⚙️'
  };
  
  const html = Object.entries(counts || {}).map(([category, data]) => `
    <div class="category-card">
      <div class="category-icon">${categoryIcons[category] || '📦'}</div>
      <div class="category-name">${category}</div>
      <div class="category-count">${data.total}</div>
      <div class="category-enabled">${data.enabled} habilitados</div>
    </div>
  `).join('') || '<div class="empty-state">Nenhuma categoria encontrada</div>';
  
  document.getElementById('trustedCategories').innerHTML = html;
}

function renderTrustedTable(ranges) {
  if (!ranges || ranges.length === 0) {
    document.getElementById('trustedTable').innerHTML = '<div class="empty-state"><div class="empty-state-icon">🛡️</div>Nenhum range configurado</div>';
    return;
  }
  
  const html = `
    <table>
      <thead>
        <tr>
          <th>CIDR</th>
          <th>Categoria</th>
          <th>Descrição</th>
          <th>Status</th>
          <th>Criado em</th>
          <th class="no-sort">Ações</th>
        </tr>
      </thead>
      <tbody>
        ${ranges.map(range => `
          <tr>
            <td class="ip-cell">${range.cidr}</td>
            <td><span class="badge ${range.category}">${range.category}</span></td>
            <td>${range.description || '-'}</td>
            <td>
              <span class="badge ${range.enabled ? 'enabled' : 'disabled'}">
                ${range.enabled ? 'Habilitado' : 'Desabilitado'}
              </span>
            </td>
            <td>${formatDate(range.created_at)}</td>
            <td>
              <button class="btn-action btn-toggle" onclick="toggleTrustedRange(${range.id}, ${!range.enabled})" 
                      title="${range.enabled ? 'Desabilitar' : 'Habilitar'}">
                ${range.enabled ? '🔴' : '🟢'}
              </button>
              <button class="btn-action btn-remove" onclick="removeTrustedRange(${range.id})" title="Remover">🗑️</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  
  document.getElementById('trustedTable').innerHTML = html;
}

async function addTrustedRange() {
  const cidr = document.getElementById('newRangeCIDR').value.trim();
  const category = document.getElementById('newRangeCategory').value;
  const description = document.getElementById('newRangeDescription').value.trim();
  
  if (!cidr) {
    showToast('CIDR é obrigatório', 'warning');
    return;
  }
  
  const cidrRegex = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
  if (!cidrRegex.test(cidr)) {
    showToast('Formato CIDR inválido (ex: 192.168.1.0/24)', 'error');
    return;
  }
  
  try {
    const response = await fetch('/admin/api/trusted-ranges', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cidr, category, description })
    });
    
    const data = await response.json();
    
    if (data.success) {
      showToast('Range adicionado com sucesso', 'success');
      document.getElementById('newRangeCIDR').value = '';
      document.getElementById('newRangeDescription').value = '';
      loadTrustedRanges();
    } else {
      showToast(data.error || 'Erro ao adicionar range', 'error');
    }
  } catch (error) {
    showToast('Erro ao adicionar range', 'error');
  }
}

async function removeTrustedRange(id) {
  if (!confirm('Deseja realmente remover este range?')) return;
  
  try {
    const response = await fetch(`/admin/api/trusted-ranges/${id}`, { method: 'DELETE' });
    const data = await response.json();
    
    if (data.success) {
      showToast('Range removido com sucesso', 'success');
      loadTrustedRanges();
    } else {
      showToast(data.error || 'Erro ao remover range', 'error');
    }
  } catch (error) {
    showToast('Erro ao remover range', 'error');
  }
}

async function toggleTrustedRange(id, enabled) {
  try {
    const response = await fetch(`/admin/api/trusted-ranges/${id}/toggle`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    
    const data = await response.json();
    
    if (data.success) {
      showToast(`Range ${enabled ? 'habilitado' : 'desabilitado'}`, 'success');
      loadTrustedRanges();
    } else {
      showToast(data.error || 'Erro ao atualizar range', 'error');
    }
  } catch (error) {
    showToast('Erro ao atualizar range', 'error');
  }
}

async function importMetaRanges() {
  if (!confirm('Importar/atualizar ranges do Meta/Facebook?')) return;
  
  try {
    const response = await fetch('/admin/api/trusted-ranges/import-meta', { method: 'POST' });
    const data = await response.json();
    
    if (data.success) {
      showToast(`${data.imported} ranges importados, ${data.skipped} já existentes`, 'success');
      loadTrustedRanges();
    } else {
      showToast(data.error || 'Erro ao importar ranges', 'error');
    }
  } catch (error) {
    showToast('Erro ao importar ranges', 'error');
  }
}

// ===== TABELAS COM FILTRO =====

function applyFilter(tableType) {
  switch(tableType) {
    case 'blocked':
      filterState.blocked.ip = document.getElementById('filterBlockedIP')?.value || '';
      filterState.blocked.reason = document.getElementById('filterBlockedReason')?.value || '';
      pagination.blocked.offset = 0;
      loadBlocked();
      break;
    case 'whitelist':
      filterState.whitelist.ip = document.getElementById('filterWhitelistIP')?.value || '';
      filterState.whitelist.confidence = document.getElementById('filterWhitelistConfidence')?.value || '';
      pagination.whitelist.offset = 0;
      loadWhitelist();
      break;
    case 'yellowlist':
      filterState.yellowlist.ip = document.getElementById('filterYellowlistIP')?.value || '';
      filterState.yellowlist.confidence = document.getElementById('filterYellowlistConfidence')?.value || '';
      pagination.yellowlist.offset = 0;
      loadYellowlist();
      break;
    case 'migrations':
      filterState.migrations.ip = document.getElementById('filterMigrationsIP')?.value || '';
      filterState.migrations.toList = document.getElementById('filterMigrationsToList')?.value || '';
      pagination.migrations.offset = 0;
      loadMigrations();
      break;
  }
}

function clearFilter(tableType) {
  switch(tableType) {
    case 'blocked':
      document.getElementById('filterBlockedIP').value = '';
      document.getElementById('filterBlockedReason').value = '';
      filterState.blocked = { ip: '', reason: '' };
      break;
    case 'whitelist':
      document.getElementById('filterWhitelistIP').value = '';
      document.getElementById('filterWhitelistConfidence').value = '';
      filterState.whitelist = { ip: '', confidence: '' };
      break;
    case 'yellowlist':
      document.getElementById('filterYellowlistIP').value = '';
      document.getElementById('filterYellowlistConfidence').value = '';
      filterState.yellowlist = { ip: '', confidence: '' };
      break;
    case 'migrations':
      document.getElementById('filterMigrationsIP').value = '';
      document.getElementById('filterMigrationsToList').value = '';
      filterState.migrations = { ip: '', toList: '' };
      break;
  }
  applyFilter(tableType);
}

// ===== IPs BLOQUEADOS =====

async function loadBlocked() {
  try {
    const { offset, limit } = pagination.blocked;
    const response = await fetch(`/admin/api/blocked?limit=${limit}&offset=${offset}`);
    const data = await response.json();
    
    if (data.success) {
      let ips = data.data || [];
      
      // Aplica filtros client-side
      if (filterState.blocked.ip) {
        ips = ips.filter(ip => ip.ip.includes(filterState.blocked.ip));
      }
      if (filterState.blocked.reason) {
        ips = ips.filter(ip => (ip.reason || '').toLowerCase().includes(filterState.blocked.reason.toLowerCase()));
      }
      
      renderBlockedTable(ips, data.pagination);
    }
  } catch (error) {
    console.error('Erro ao carregar IPs bloqueados:', error);
    document.getElementById('blockedTable').innerHTML = '<div class="empty-state">Erro ao carregar dados</div>';
  }
}

function renderBlockedTable(ips, paginationData) {
  if (!ips || ips.length === 0) {
    document.getElementById('blockedTable').innerHTML = '<div class="empty-state"><div class="empty-state-icon">🚫</div>Nenhum IP bloqueado</div>';
    return;
  }
  
  const sorted = sortData(ips, sortState.blocked.field, sortState.blocked.order);
  
  const html = `
    <table>
      <thead>
        <tr>
          ${createSortableHeader('IP', 'ip', 'blocked')}
          ${createSortableHeader('País', 'country_code', 'blocked')}
          ${createSortableHeader('Confiança', 'abuse_confidence', 'blocked')}
          ${createSortableHeader('Reports', 'reports', 'blocked')}
          ${createSortableHeader('Motivo', 'reason', 'blocked')}
          ${createSortableHeader('ISP/Tipo', 'isp', 'blocked')}
          ${createSortableHeader('Tentativas', 'request_count', 'blocked')}
          ${createSortableHeader('Última tentativa', 'last_seen', 'blocked')}
          ${createSortableHeader('Bloqueado em', 'blocked_at', 'blocked')}
          <th class="no-sort">Ações</th>
        </tr>
      </thead>
      <tbody>
        ${sorted.map(ip => {
          const flag = ip.country_code ? getFlagEmoji(ip.country_code) : '🌐';
          const ispInfo = ip.isp || ip.usage_type || '-';
          const torBadge = ip.is_tor ? '<span class="badge-tor">🧅</span>' : '';
          const confidence = ip.abuse_confidence !== undefined && ip.abuse_confidence !== null 
            ? ip.abuse_confidence + '%' : '-';
          const confidenceColor = (ip.abuse_confidence || 0) >= 70 ? '#e74c3c' : 
                                  (ip.abuse_confidence || 0) >= 30 ? '#f39c12' : '#27ae60';
          return `
          <tr>
            <td class="ip-cell">${ip.ip} ${torBadge}</td>
            <td>${flag} ${ip.country_code || '-'}</td>
            <td style="color: ${confidenceColor}; font-weight: 600;">${confidence}</td>
            <td>${ip.reports || 0}</td>
            <td title="${ip.reason || ''}">${(ip.reason || 'Não especificado').substring(0, 30)}${(ip.reason || '').length > 30 ? '...' : ''}</td>
            <td class="isp-cell" title="${ispInfo}">${ispInfo.substring(0, 20)}${ispInfo.length > 20 ? '...' : ''}</td>
            <td>${ip.request_count || 0}</td>
            <td>${formatDate(ip.last_seen)}</td>
            <td>${formatDate(ip.blocked_at)}</td>
            <td>
              <button class="btn-action btn-lookup" onclick="quickLookup('${ip.ip}')" title="Consultar">🔍</button>
              <button class="btn-action btn-unblock" onclick="unblockIP('${ip.ip}')" title="Desbloquear">🔓</button>
              <button class="btn-action btn-whitelist" onclick="migrateIP('${ip.ip}', 'blocked', 'whitelist')" title="Whitelist">✅</button>
            </td>
          </tr>
        `}).join('')}
      </tbody>
    </table>
    ${renderPagination('blocked', paginationData)}
  `;
  
  document.getElementById('blockedTable').innerHTML = html;
}

// ===== WHITELIST =====

async function loadWhitelist() {
  try {
    const { offset, limit } = pagination.whitelist;
    const response = await fetch(`/admin/api/whitelist?limit=${limit}&offset=${offset}`);
    const data = await response.json();
    
    if (data.success) {
      let ips = data.data || [];
      
      // Aplica filtros client-side
      if (filterState.whitelist.ip) {
        ips = ips.filter(ip => ip.ip.includes(filterState.whitelist.ip));
      }
      if (filterState.whitelist.confidence) {
        const maxConf = parseFloat(filterState.whitelist.confidence);
        ips = ips.filter(ip => (ip.abuse_confidence || 0) <= maxConf);
      }
      
      renderWhitelistTable(ips, data.pagination);
    }
  } catch (error) {
    console.error('Erro ao carregar whitelist:', error);
    document.getElementById('whitelistTable').innerHTML = '<div class="empty-state">Erro ao carregar dados</div>';
  }
}

function renderWhitelistTable(ips, paginationData) {
  if (!ips || ips.length === 0) {
    document.getElementById('whitelistTable').innerHTML = '<div class="empty-state"><div class="empty-state-icon">✅</div>Nenhum IP na whitelist</div>';
    return;
  }
  
  const sorted = sortData(ips, sortState.whitelist.field, sortState.whitelist.order);
  
  const html = `
    <table>
      <thead>
        <tr>
          ${createSortableHeader('IP', 'ip', 'whitelist')}
          ${createSortableHeader('País', 'country_code', 'whitelist')}
          ${createSortableHeader('Confiança', 'abuse_confidence', 'whitelist')}
          ${createSortableHeader('Reports', 'reports', 'whitelist')}
          ${createSortableHeader('ISP/Tipo', 'isp', 'whitelist')}
          ${createSortableHeader('Tentativas', 'request_count', 'whitelist')}
          ${createSortableHeader('Última tentativa', 'last_seen', 'whitelist')}
          ${createSortableHeader('Expira em', 'expires_at', 'whitelist')}
          <th class="no-sort">Ações</th>
        </tr>
      </thead>
      <tbody>
        ${sorted.map(ip => {
          const flag = ip.country_code ? getFlagEmoji(ip.country_code) : '🌐';
          const ispInfo = ip.isp || ip.usage_type || '-';
          const torBadge = ip.is_tor ? '<span class="badge-tor">🧅</span>' : '';
          const confidence = ip.abuse_confidence !== undefined && ip.abuse_confidence !== null 
            ? ip.abuse_confidence + '%' : '-';
          const confidenceColor = (ip.abuse_confidence || 0) >= 70 ? '#e74c3c' : 
                                  (ip.abuse_confidence || 0) >= 30 ? '#f39c12' : '#27ae60';
          return `
          <tr>
            <td class="ip-cell">${ip.ip} ${torBadge}</td>
            <td>${flag} ${ip.country_code || '-'}</td>
            <td style="color: ${confidenceColor}; font-weight: 600;">${confidence}</td>
            <td>${ip.reports || 0}</td>
            <td class="isp-cell" title="${ispInfo}">${ispInfo.substring(0, 20)}${ispInfo.length > 20 ? '...' : ''}</td>
            <td>${ip.request_count || 0}</td>
            <td>${formatDate(ip.last_seen)}</td>
            <td>${formatDate(ip.expires_at)}</td>
            <td>
              <button class="btn-action btn-lookup" onclick="quickLookup('${ip.ip}')" title="Consultar">🔍</button>
              <button class="btn-action btn-remove" onclick="removeFromList('${ip.ip}', 'whitelist')" title="Remover">🗑️</button>
              <button class="btn-action btn-block" onclick="migrateIP('${ip.ip}', 'whitelist', 'blocked')" title="Bloquear">🚫</button>
            </td>
          </tr>
        `}).join('')}
      </tbody>
    </table>
    ${renderPagination('whitelist', paginationData)}
  `;
  
  document.getElementById('whitelistTable').innerHTML = html;
}

// ===== YELLOWLIST =====

async function loadYellowlist() {
  try {
    const { offset, limit } = pagination.yellowlist;
    const response = await fetch(`/admin/api/yellowlist?limit=${limit}&offset=${offset}`);
    const data = await response.json();
    
    if (data.success) {
      let ips = data.data || [];
      
      // Aplica filtros client-side
      if (filterState.yellowlist.ip) {
        ips = ips.filter(ip => ip.ip.includes(filterState.yellowlist.ip));
      }
      if (filterState.yellowlist.confidence) {
        const minConf = parseFloat(filterState.yellowlist.confidence);
        ips = ips.filter(ip => (ip.abuse_confidence || 0) >= minConf);
      }
      
      renderYellowlistTable(ips, data.pagination);
    }
  } catch (error) {
    console.error('Erro ao carregar yellowlist:', error);
    document.getElementById('yellowlistTable').innerHTML = '<div class="empty-state">Erro ao carregar dados</div>';
  }
}

function renderYellowlistTable(ips, paginationData) {
  if (!ips || ips.length === 0) {
    document.getElementById('yellowlistTable').innerHTML = '<div class="empty-state"><div class="empty-state-icon">⚠️</div>Nenhum IP na yellowlist</div>';
    return;
  }
  
  const sorted = sortData(ips, sortState.yellowlist.field, sortState.yellowlist.order);
  
  const html = `
    <table>
      <thead>
        <tr>
          ${createSortableHeader('IP', 'ip', 'yellowlist')}
          ${createSortableHeader('País', 'country_code', 'yellowlist')}
          ${createSortableHeader('Confiança', 'abuse_confidence', 'yellowlist')}
          ${createSortableHeader('Reports', 'reports', 'yellowlist')}
          ${createSortableHeader('ISP/Tipo', 'isp', 'yellowlist')}
          ${createSortableHeader('Tentativas', 'request_count', 'yellowlist')}
          ${createSortableHeader('Última tentativa', 'last_seen', 'yellowlist')}
          ${createSortableHeader('Expira em', 'expires_at', 'yellowlist')}
          <th class="no-sort">Ações</th>
        </tr>
      </thead>
      <tbody>
        ${sorted.map(ip => {
          const flag = ip.country_code ? getFlagEmoji(ip.country_code) : '🌐';
          const ispInfo = ip.isp || ip.usage_type || '-';
          const torBadge = ip.is_tor ? '<span class="badge-tor">🧅</span>' : '';
          const confidence = ip.abuse_confidence !== undefined && ip.abuse_confidence !== null 
            ? ip.abuse_confidence + '%' : '-';
          const confidenceColor = (ip.abuse_confidence || 0) >= 70 ? '#e74c3c' : 
                                  (ip.abuse_confidence || 0) >= 30 ? '#f39c12' : '#27ae60';
          return `
          <tr>
            <td class="ip-cell">${ip.ip} ${torBadge}</td>
            <td>${flag} ${ip.country_code || '-'}</td>
            <td style="color: ${confidenceColor}; font-weight: 600;">${confidence}</td>
            <td>${ip.reports || 0}</td>
            <td class="isp-cell" title="${ispInfo}">${ispInfo.substring(0, 20)}${ispInfo.length > 20 ? '...' : ''}</td>
            <td>${ip.request_count || 0}</td>
            <td>${formatDate(ip.last_seen)}</td>
            <td>${formatDate(ip.expires_at)}</td>
            <td>
              <button class="btn-action btn-lookup" onclick="quickLookup('${ip.ip}')" title="Consultar">🔍</button>
              <button class="btn-action btn-whitelist" onclick="migrateIP('${ip.ip}', 'yellowlist', 'whitelist')" title="Whitelist">✅</button>
              <button class="btn-action btn-block" onclick="migrateIP('${ip.ip}', 'yellowlist', 'blocked')" title="Bloquear">🚫</button>
            </td>
          </tr>
        `}).join('')}
      </tbody>
    </table>
    ${renderPagination('yellowlist', paginationData)}
  `;
  
  document.getElementById('yellowlistTable').innerHTML = html;
}

// ===== DISPOSITIVOS =====

async function loadDevices() {
  try {
    const response = await fetch('/admin/api/dashboard/stats');
    const data = await response.json();
    
    if (data.success && data.stats.devices) {
      renderDevicesTable(data.stats.devices.list || []);
    }
  } catch (error) {
    console.error('Erro ao carregar dispositivos:', error);
    document.getElementById('devicesTable').innerHTML = '<div class="empty-state">Erro ao carregar dados</div>';
  }
}

function renderDevicesTable(devices) {
  if (!devices || devices.length === 0) {
    document.getElementById('devicesTable').innerHTML = '<div class="empty-state"><div class="empty-state-icon">📱</div>Nenhum dispositivo conectado</div>';
    return;
  }
  
  const html = `
    <table>
      <thead>
        <tr>
          <th>IP</th>
          <th>Nome</th>
          <th>Tipo</th>
          <th>Status</th>
          <th>Última Atividade</th>
          <th>Conectado em</th>
          <th>Requisições</th>
          <th class="no-sort">Ações</th>
        </tr>
      </thead>
      <tbody>
        ${devices.map(device => {
          const onlineIcon = (device.connectionType === 'websocket' || device.isOnline) ? '🟢' : '🔴';
          const onlineText = (device.connectionType === 'websocket' || device.isOnline) ? 'Online' : 'Offline';
          const connectionType = device.connectionType || 'unknown';
          const connectionTypeText = connectionType === 'websocket' ? 'WebSocket' : connectionType === 'http' ? 'HTTP' : connectionType;
          
          return `
          <tr>
            <td class="ip-cell">${device.ip}</td>
            <td>${device.deviceName || '-'}</td>
            <td><span class="badge ${connectionType === 'websocket' ? 'whitelist' : 'yellowlist'}">${connectionTypeText}</span></td>
            <td>${onlineIcon} ${onlineText}</td>
            <td>${formatDate(device.lastPing || device.lastSeen)}</td>
            <td>${formatDate(device.connectedAt)}</td>
            <td>${device.requestCount || '-'}</td>
            <td>
              <button class="btn-action btn-lookup" onclick="quickLookup('${device.ip}')" title="Consultar">🔍</button>
            </td>
          </tr>
        `;
        }).join('')}
      </tbody>
    </table>
  `;
  
  document.getElementById('devicesTable').innerHTML = html;
}

// ===== MIGRAÇÕES =====

async function loadMigrations() {
  try {
    const { offset, limit } = pagination.migrations;
    const response = await fetch(`/admin/api/migrations?limit=${limit}&offset=${offset}`);
    const data = await response.json();
    
    if (data.success) {
      let logs = data.data || [];
      
      // Aplica filtros client-side
      if (filterState.migrations.ip) {
        logs = logs.filter(log => log.ip.includes(filterState.migrations.ip));
      }
      if (filterState.migrations.toList) {
        logs = logs.filter(log => log.to_list === filterState.migrations.toList);
      }
      
      renderMigrationsTable(logs, data.pagination);
    }
  } catch (error) {
    console.error('Erro ao carregar migrações:', error);
    document.getElementById('migrationsTable').innerHTML = '<div class="empty-state">Erro ao carregar dados</div>';
  }
}

function renderMigrationsTable(logs, paginationData) {
  if (!logs || logs.length === 0) {
    document.getElementById('migrationsTable').innerHTML = '<div class="empty-state"><div class="empty-state-icon">🔄</div>Nenhuma migração encontrada</div>';
    return;
  }
  
  const sorted = sortData(logs, sortState.migrations.field, sortState.migrations.order);
  
  const html = `
    <table>
      <thead>
        <tr>
          ${createSortableHeader('IP', 'ip', 'migrations')}
          ${createSortableHeader('De', 'from_list', 'migrations')}
          ${createSortableHeader('Para', 'to_list', 'migrations')}
          ${createSortableHeader('Confiança', 'new_confidence', 'migrations')}
          ${createSortableHeader('Data', 'created_at', 'migrations')}
          <th class="no-sort">Ações</th>
        </tr>
      </thead>
      <tbody>
        ${sorted.map(log => `
          <tr>
            <td class="ip-cell">${log.ip}</td>
            <td><span class="badge ${log.from_list || 'none'}">${log.from_list || 'Nenhuma'}</span></td>
            <td><span class="badge ${log.to_list}">${log.to_list}</span></td>
            <td>${log.old_confidence || '-'}% → ${log.new_confidence || '-'}%</td>
            <td>${formatDate(log.created_at)}</td>
            <td>
              <button class="btn-action btn-lookup" onclick="quickLookup('${log.ip}')" title="Consultar">🔍</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    ${renderPagination('migrations', paginationData)}
  `;
  
  document.getElementById('migrationsTable').innerHTML = html;
}

// ===== DISPOSITIVOS CONFIÁVEIS =====

async function loadTrustedDevices() {
  const container = document.getElementById('trustedDevicesTable');
  
  try {
    const response = await fetch('/admin/api/trusted-devices');
    const data = await response.json();
    
    if (data.success && data.devices.length > 0) {
      container.innerHTML = `
        <table>
          <thead>
            <tr>
              <th>Dispositivo</th>
              <th>IP</th>
              <th>Confiável até</th>
              <th>Último uso</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            ${data.devices.map(device => {
              const trustedUntil = new Date(device.trustedUntil * 1000).toLocaleDateString('pt-BR');
              const lastUsed = device.lastUsedAt ? formatDate(device.lastUsedAt) : '-';
              const currentBadge = device.isCurrent ? '<span class="badge whitelist">ATUAL</span>' : '';
              
              return `
                <tr>
                  <td>${device.name} ${currentBadge}</td>
                  <td>${device.ip || '-'}</td>
                  <td>${trustedUntil}</td>
                  <td>${lastUsed}</td>
                  <td>
                    <button class="btn-action btn-block" 
                            onclick="revokeTrustedDevice('${device.id}')"
                            title="Revogar confiança"
                            ${device.isCurrent ? 'disabled' : ''}>
                      🚫
                    </button>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      `;
    } else {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🔐</div>
          Nenhum dispositivo confiável registrado
        </div>
      `;
    }
  } catch (error) {
    console.error('Erro ao carregar dispositivos confiáveis:', error);
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">❌</div>
        Erro ao carregar dispositivos
      </div>
    `;
  }
}

async function revokeTrustedDevice(sessionId) {
  if (!confirm('Tem certeza que deseja revogar a confiança deste dispositivo?')) {
    return;
  }
  
  try {
    const response = await fetch(`/admin/api/trusted-devices/${sessionId}/revoke`, {
      method: 'POST'
    });
    
    const data = await response.json();
    
    if (data.success) {
      showToast('Dispositivo revogado com sucesso', 'success');
      loadTrustedDevices();
    } else {
      showToast(data.error || 'Erro ao revogar dispositivo', 'error');
    }
  } catch (error) {
    console.error('Erro ao revogar dispositivo:', error);
    showToast('Erro ao revogar dispositivo', 'error');
  }
}

async function revokeAllDevices() {
  if (!confirm('Tem certeza que deseja revogar TODOS os dispositivos confiáveis (exceto o atual)?')) {
    return;
  }
  
  try {
    const response = await fetch('/admin/api/trusted-devices/revoke-all', {
      method: 'POST'
    });
    
    const data = await response.json();
    
    if (data.success) {
      showToast(`${data.revoked} dispositivo(s) revogado(s)`, 'success');
      loadTrustedDevices();
    } else {
      showToast(data.error || 'Erro ao revogar dispositivos', 'error');
    }
  } catch (error) {
    console.error('Erro ao revogar dispositivos:', error);
    showToast('Erro ao revogar dispositivos', 'error');
  }
}

// ===== SERVIDOR =====

async function loadServerMetrics() {
  try {
    const response = await fetch('/admin/api/server/metrics');
    const data = await response.json();
    
    if (data.success) {
      renderServerMetrics(data.metrics);
    }
  } catch (error) {
    console.error('Erro ao carregar métricas do servidor:', error);
  }
}

function renderServerMetrics(metrics) {
  // CPU
  const cpu1min = Math.min(100, metrics.cpu?.load1min || 0);
  const cpu5min = Math.min(100, metrics.cpu?.load5min || 0);
  const cpu15min = Math.min(100, metrics.cpu?.load15min || 0);
  
  document.getElementById('cpu1min').textContent = cpu1min.toFixed(1) + '%';
  document.getElementById('cpu1minBar').style.width = cpu1min + '%';
  document.getElementById('cpu5min').textContent = cpu5min.toFixed(1) + '%';
  document.getElementById('cpu5minBar').style.width = cpu5min + '%';
  document.getElementById('cpu15min').textContent = cpu15min.toFixed(1) + '%';
  document.getElementById('cpu15minBar').style.width = cpu15min + '%';
  
  // Memória
  const memPercent = metrics.memory?.percent || 0;
  document.getElementById('memTotal').textContent = formatBytes(metrics.memory?.total || 0);
  document.getElementById('memUsed').textContent = formatBytes(metrics.memory?.used || 0);
  document.getElementById('memUsedBar').style.width = memPercent + '%';
  document.getElementById('memFree').textContent = formatBytes(metrics.memory?.free || 0);
  
  // Disco
  const diskPercent = metrics.disk?.percent || 0;
  document.getElementById('diskTotal').textContent = formatBytes(metrics.disk?.total || 0);
  document.getElementById('diskUsed').textContent = formatBytes(metrics.disk?.used || 0);
  document.getElementById('diskUsedBar').style.width = diskPercent + '%';
  document.getElementById('diskFree').textContent = formatBytes(metrics.disk?.free || 0);
  
  // Sistema
  document.getElementById('sysOS').textContent = metrics.system?.platform || '-';
  document.getElementById('sysArch').textContent = metrics.system?.arch || '-';
  document.getElementById('sysUptime').textContent = formatUptime(metrics.system?.uptime || 0);
  document.getElementById('sysPlatform').textContent = metrics.system?.type || '-';
  document.getElementById('sysHostname').textContent = metrics.system?.hostname || '-';
  document.getElementById('sysCores').textContent = metrics.cpu?.cores || '-';
}

async function loadAbuseIPDBStats() {
  try {
    const response = await fetch('/admin/api/abuseipdb/stats');
    const data = await response.json();
    
    if (data.success) {
      renderAbuseIPDBStats(data.stats);
    }
  } catch (error) {
    console.error('Erro ao carregar stats AbuseIPDB:', error);
    document.getElementById('abuseipdbStats').innerHTML = '<div class="empty-state">Erro ao carregar dados</div>';
  }
}

function renderAbuseIPDBStats(stats) {
  if (!stats || Object.keys(stats).length === 0) {
    document.getElementById('abuseipdbStats').innerHTML = '<div class="empty-state">Nenhum dado disponível</div>';
    return;
  }
  
  const html = Object.entries(stats).map(([endpoint, data]) => {
    const percent = (data.used / data.limit) * 100;
    const color = percent >= 80 ? '#e74c3c' : percent >= 50 ? '#f39c12' : '#27ae60';
    return `
      <div class="abuse-stat-card">
        <div class="abuse-stat-name">${endpoint}</div>
        <div class="abuse-stat-value">${data.used} / ${data.limit}</div>
        <div class="abuse-stat-bar">
          <div class="abuse-stat-bar-fill" style="width: ${percent}%; background: ${color};"></div>
        </div>
      </div>
    `;
  }).join('');
  
  document.getElementById('abuseipdbStats').innerHTML = html;
}

// ===== FUNÇÕES AUXILIARES =====

function sortData(data, field, order) {
  return [...data].sort((a, b) => {
    let aVal = a[field];
    let bVal = b[field];
    
    if (typeof aVal === 'number' && typeof bVal === 'number') {
      return order === 'asc' ? aVal - bVal : bVal - aVal;
    }
    
    aVal = String(aVal || '').toLowerCase();
    bVal = String(bVal || '').toLowerCase();
    
    return order === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
  });
}

function createSortableHeader(text, field, tableType) {
  const currentSort = sortState[tableType];
  const isActive = currentSort.field === field;
  const sortClass = isActive ? (currentSort.order === 'asc' ? 'sort-asc' : 'sort-desc') : '';
  return `<th class="sortable ${sortClass}" onclick="sortTable('${tableType}', '${field}')">${text}</th>`;
}

function sortTable(tableType, field) {
  const current = sortState[tableType];
  if (current.field === field) {
    current.order = current.order === 'asc' ? 'desc' : 'asc';
  } else {
    current.field = field;
    current.order = 'desc';
  }
  
  const tabMapping = { blocked: 'ips', trusted: 'trusted' };
  loadTabData(tabMapping[tableType] || tableType);
}

function renderPagination(type, paginationData) {
  if (!paginationData || paginationData.total <= paginationData.limit) return '';
  
  const currentPage = Math.floor(paginationData.offset / paginationData.limit) + 1;
  const totalPages = Math.ceil(paginationData.total / paginationData.limit);
  
  return `
    <div class="pagination">
      <div class="pagination-info">Página ${currentPage} de ${totalPages} (Total: ${paginationData.total})</div>
      <div class="pagination-buttons">
        <button onclick="prevPage('${type}')" ${paginationData.offset === 0 ? 'disabled' : ''}>← Anterior</button>
        <button onclick="nextPage('${type}')" ${!paginationData.hasMore ? 'disabled' : ''}>Próxima →</button>
      </div>
    </div>
  `;
}

function prevPage(type) {
  pagination[type].offset = Math.max(0, pagination[type].offset - pagination[type].limit);
  const tabMapping = { blocked: 'ips' };
  loadTabData(tabMapping[type] || type);
}

function nextPage(type) {
  pagination[type].offset += pagination[type].limit;
  const tabMapping = { blocked: 'ips' };
  loadTabData(tabMapping[type] || type);
}

// ===== AÇÕES DE IP =====

async function unblockIP(ip) {
  if (!confirm(`Deseja realmente desbloquear o IP ${ip}?`)) return;
  
  try {
    const response = await fetch('/admin/api/ip/unblock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip })
    });
    const data = await response.json();
    
    if (data.success) {
      showToast(`IP ${ip} desbloqueado com sucesso`, 'success');
      loadBlocked();
      loadOverview();
    } else {
      showToast(data.error || 'Erro ao desbloquear IP', 'error');
    }
  } catch (error) {
    showToast('Erro ao desbloquear IP', 'error');
  }
}

async function removeFromList(ip, listType) {
  if (!confirm(`Deseja realmente remover o IP ${ip} da ${listType}?`)) return;
  
  try {
    const response = await fetch('/admin/api/ip/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip, listType })
    });
    const data = await response.json();
    
    if (data.success) {
      showToast(`IP ${ip} removido da ${listType}`, 'success');
      if (listType === 'whitelist') loadWhitelist();
      else if (listType === 'yellowlist') loadYellowlist();
      loadOverview();
    } else {
      showToast(data.error || 'Erro ao remover IP', 'error');
    }
  } catch (error) {
    showToast('Erro ao remover IP', 'error');
  }
}

async function migrateIP(ip, fromList, toList) {
  const listNames = { blocked: 'Bloqueados', whitelist: 'Whitelist', yellowlist: 'Yellowlist', none: 'Nenhuma' };
  if (!confirm(`Mover IP ${ip} de ${listNames[fromList] || fromList} para ${listNames[toList]}?`)) return;
  
  try {
    const response = await fetch('/admin/api/ip/migrate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip, fromList, toList })
    });
    const data = await response.json();
    
    if (data.success) {
      showToast(`IP ${ip} movido para ${listNames[toList]}`, 'success');
      loadBlocked();
      loadWhitelist();
      loadYellowlist();
      loadOverview();
    } else {
      showToast(data.error || 'Erro ao migrar IP', 'error');
    }
  } catch (error) {
    showToast('Erro ao migrar IP', 'error');
  }
}

// ===== LOGOUT =====

async function logout() {
  try {
    await fetch('/admin/logout', { method: 'POST' });
    window.location.href = '/admin';
  } catch (error) {
    console.error('Erro ao fazer logout:', error);
    window.location.href = '/admin';
  }
}

// ===== ENVIO DE MENSAGENS =====

// Histórico de envios (sessão)
const sendHistory = [];

function switchSendType(type) {
  document.querySelectorAll('.send-type-btn').forEach(btn => btn.classList.remove('active'));
  document.getElementById(type === 'template' ? 'btnTypeTemplate' : 'btnTypeText').classList.add('active');
  
  document.getElementById('sendFormTemplate').style.display = type === 'template' ? 'block' : 'none';
  document.getElementById('sendFormText').style.display = type === 'text' ? 'block' : 'none';
  
  // Limpa resultado anterior
  document.getElementById('sendResult').style.display = 'none';
}

async function sendTemplateMessage() {
  const phone = document.getElementById('templatePhone').value.trim();
  const code = document.getElementById('templateCode').value.trim();
  const template = document.getElementById('templateName').value.trim();
  const language = document.getElementById('templateLang').value;
  const paramLocation = document.getElementById('templateParamLocation').value;
  
  if (!phone) {
    showToast('Informe o número de telefone', 'error');
    return;
  }
  
  // Se o local é 'none', não precisa de código
  if (paramLocation !== 'none' && !code) {
    showToast('Informe o código a enviar', 'error');
    return;
  }
  
  const btn = document.getElementById('btnSendTemplate');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ Enviando...';
  
  // Monta os components baseado no local selecionado
  let components = [];
  if (paramLocation === 'header' && code) {
    components = [{ type: 'header', parameters: [{ type: 'text', text: code }] }];
  } else if (paramLocation === 'body' && code) {
    components = [{ type: 'body', parameters: [{ type: 'text', text: code }] }];
  }
  // Se 'none', components fica vazio
  
  try {
    const response = await fetch('/admin/api/send/template', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone,
        template,
        language,
        components
      })
    });
    
    const data = await response.json();
    
    if (data.ok) {
      showSendResult(true, {
        phone: data.to || phone,
        type: 'Template',
        template: template,
        code: code,
        msgId: data.msgId
      });
      showToast('Template enviado com sucesso!', 'success');
      
      // Adiciona ao histórico
      addToHistory({
        phone: data.to || phone,
        type: 'template',
        template: template,
        code: code,
        success: true,
        time: new Date()
      });
      
      // Limpa campos
      document.getElementById('templateCode').value = '';
    } else {
      showSendResult(false, { error: data.error || 'Erro desconhecido' });
      showToast(data.error || 'Erro ao enviar template', 'error');
      
      addToHistory({
        phone,
        type: 'template',
        success: false,
        error: data.error,
        time: new Date()
      });
    }
  } catch (error) {
    showSendResult(false, { error: error.message });
    showToast('Erro ao enviar template', 'error');
    
    addToHistory({
      phone,
      type: 'template',
      success: false,
      error: error.message,
      time: new Date()
    });
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

async function sendTextMessageForm() {
  const phone = document.getElementById('textPhone').value.trim();
  const subject = document.getElementById('textSubject').value.trim();
  const message = document.getElementById('textMessage').value.trim();
  
  if (!phone) {
    showToast('Informe o número de telefone', 'error');
    return;
  }
  
  if (!message) {
    showToast('Informe a mensagem', 'error');
    return;
  }
  
  const btn = document.getElementById('btnSendText');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ Enviando...';
  
  try {
    const response = await fetch('/admin/api/send/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, subject, message })
    });
    
    const data = await response.json();
    
    if (data.ok) {
      showSendResult(true, {
        phone: data.to || phone,
        type: 'Texto',
        message: message.substring(0, 50) + (message.length > 50 ? '...' : ''),
        msgId: data.msgId
      });
      showToast('Mensagem enviada com sucesso!', 'success');
      
      addToHistory({
        phone: data.to || phone,
        type: 'text',
        message: message.substring(0, 30),
        success: true,
        time: new Date()
      });
      
      // Limpa campos
      document.getElementById('textMessage').value = '';
      document.getElementById('textSubject').value = '';
    } else {
      showSendResult(false, { error: data.error || 'Erro desconhecido' });
      showToast(data.error || 'Erro ao enviar mensagem', 'error');
      
      addToHistory({
        phone,
        type: 'text',
        success: false,
        error: data.error,
        time: new Date()
      });
    }
  } catch (error) {
    showSendResult(false, { error: error.message });
    showToast('Erro ao enviar mensagem', 'error');
    
    addToHistory({
      phone,
      type: 'text',
      success: false,
      error: error.message,
      time: new Date()
    });
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

function showSendResult(success, data) {
  const container = document.getElementById('sendResult');
  container.style.display = 'block';
  container.className = `send-result ${success ? 'success' : 'error'}`;
  
  if (success) {
    container.innerHTML = `
      <h4>${success ? '✅' : '❌'} ${success ? 'Enviado com sucesso!' : 'Falha no envio'}</h4>
      <div class="details">
        <p><strong>Telefone:</strong> <code>${data.phone}</code></p>
        <p><strong>Tipo:</strong> ${data.type}</p>
        ${data.template ? `<p><strong>Template:</strong> ${data.template}</p>` : ''}
        ${data.code ? `<p><strong>Código:</strong> <code>${data.code}</code></p>` : ''}
        ${data.message ? `<p><strong>Mensagem:</strong> ${data.message}</p>` : ''}
        ${data.msgId ? `<p><strong>ID:</strong> <code>${data.msgId}</code></p>` : ''}
      </div>
    `;
  } else {
    container.innerHTML = `
      <h4>❌ Falha no envio</h4>
      <div class="details">
        <p><strong>Erro:</strong> ${data.error}</p>
      </div>
    `;
  }
}

function addToHistory(item) {
  sendHistory.unshift(item);
  if (sendHistory.length > 20) sendHistory.pop(); // Mantém apenas 20 últimos
  
  renderSendHistory();
}

function renderSendHistory() {
  const container = document.getElementById('sendHistory');
  
  if (sendHistory.length === 0) {
    container.innerHTML = `<p style="color: #888; text-align: center; padding: 20px;">
      Nenhum envio realizado nesta sessão.
    </p>`;
    return;
  }
  
  container.innerHTML = sendHistory.map(item => {
    const timeStr = item.time.toLocaleTimeString('pt-BR');
    const typeIcon = item.type === 'template' ? '📋' : '💬';
    const typeText = item.type === 'template' ? `Template (${item.code || '-'})` : `Texto`;
    
    return `
      <div class="history-item ${item.success ? 'success' : 'error'}">
        <div class="info">
          <div class="phone">${typeIcon} ${item.phone}</div>
          <div class="type">${typeText} ${item.success ? '✅' : `❌ ${item.error || ''}`}</div>
        </div>
        <div class="time">${timeStr}</div>
      </div>
    `;
  }).join('');
}

// ===== TUYA =====

async function loadTuyaDevices() {
  try {
    const response = await fetch('/admin/api/tuya/devices');
    const data = await response.json();
    
    if (data.success) {
      // Atualiza stats
      document.getElementById('tuyaTotal').textContent = data.stats.total;
      document.getElementById('tuyaOnline').textContent = data.stats.online;
      document.getElementById('tuyaPoweredOn').textContent = data.stats.poweredOn;
      document.getElementById('tuyaOffline').textContent = data.stats.offline;
      
      renderTuyaDevicesTable(data.devices);
    } else {
      document.getElementById('tuyaDevicesTable').innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">❌</div>
          ${data.error || 'Erro ao carregar dispositivos'}
        </div>
      `;
    }
  } catch (error) {
    console.error('Erro ao carregar dispositivos Tuya:', error);
    document.getElementById('tuyaDevicesTable').innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">❌</div>
        Erro ao conectar com a API Tuya
      </div>
    `;
  }
}

function renderTuyaDevicesTable(devices) {
  const container = document.getElementById('tuyaDevicesTable');
  
  if (!devices || devices.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🏠</div>
        Nenhum dispositivo Tuya encontrado
      </div>
    `;
    return;
  }
  
  container.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Nome</th>
          <th>Categoria</th>
          <th>Online</th>
          <th>Estado</th>
          <th>Ações</th>
        </tr>
      </thead>
      <tbody>
        ${devices.map(device => {
          const onlineIcon = device.online ? '🟢' : '🔴';
          const onlineText = device.online ? 'Online' : 'Offline';
          const powerIcon = device.poweredOn ? '💡' : '⚫';
          const powerText = device.poweredOn ? 'Ligado' : 'Desligado';
          const categoryIcon = getCategoryIcon(device.category);
          
          return `
            <tr>
              <td><strong>${device.name || device.id}</strong></td>
              <td>${categoryIcon} ${device.category || 'other'}</td>
              <td>${onlineIcon} ${onlineText}</td>
              <td>
                <span class="badge ${device.poweredOn ? 'whitelist' : 'none'}">
                  ${powerIcon} ${powerText}
                </span>
              </td>
              <td>
                <button class="btn-action ${device.poweredOn ? 'btn-block' : 'btn-whitelist'}" 
                        onclick="toggleTuyaDevice('${device.id}', ${device.poweredOn})"
                        title="${device.poweredOn ? 'Desligar' : 'Ligar'}"
                        ${!device.online ? 'disabled' : ''}>
                  ${device.poweredOn ? '🔴 OFF' : '🟢 ON'}
                </button>
                <button class="btn-action btn-lookup" 
                        onclick="viewTuyaDeviceDetails('${device.id}')"
                        title="Ver detalhes">
                  🔍
                </button>
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

function getCategoryIcon(category) {
  const icons = {
    'light': '💡',
    'switch': '🔌',
    'socket': '🔌',
    'lamp': '💡',
    'fan': '🌀',
    'curtain': '🪟',
    'sensor': '📡',
    'thermostat': '🌡️',
    'camera': '📷'
  };
  return icons[category] || '📱';
}

async function toggleTuyaDevice(deviceId, currentState) {
  try {
    const response = await fetch(`/admin/api/tuya/device/${deviceId}/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    
    const data = await response.json();
    
    if (data.success) {
      showToast(`Dispositivo ${data.newState ? 'ligado' : 'desligado'} com sucesso`, 'success');
      loadTuyaDevices(); // Recarrega a lista
    } else {
      showToast(data.error || 'Erro ao alternar dispositivo', 'error');
    }
  } catch (error) {
    console.error('Erro ao alternar dispositivo:', error);
    showToast('Erro ao conectar com a API', 'error');
  }
}

async function viewTuyaDeviceDetails(deviceId) {
  const modal = document.getElementById('tuyaDeviceModal');
  const modalBody = document.getElementById('tuyaDeviceModalBody');
  
  modal.style.display = 'block';
  modalBody.innerHTML = '<div class="loading"><div class="loading-spinner"></div><br>Carregando detalhes...</div>';
  
  try {
    const response = await fetch(`/admin/api/tuya/device/${deviceId}/status`);
    const data = await response.json();
    
    if (data.success && data.status) {
      // Formata os dados do dispositivo
      let html = `
        <div class="device-detail-item">
          <span class="device-detail-label">ID do Dispositivo:</span>
          <span class="device-detail-value"><code>${deviceId}</code></span>
        </div>
      `;
      
      // Organiza dados por fases (A, B, C) e totais
      const phases = { A: [], B: [], C: [] };
      const totals = [];
      const sensors = [];
      const others = [];
      
      // Função para detectar fase
      const getPhase = (code) => {
        const upperCode = code.toUpperCase();
        if (upperCode.endsWith('A') || (upperCode.includes('A') && !upperCode.includes('B') && !upperCode.includes('C'))) return 'A';
        if (upperCode.endsWith('B') || (upperCode.includes('B') && !upperCode.includes('C'))) return 'B';
        if (upperCode.endsWith('C')) return 'C';
        return null;
      };
      
      data.status.forEach(s => {
        const code = (s.code || '').toLowerCase();
        const codeOriginal = s.code || '';
        const phase = getPhase(codeOriginal);
        
        // Dados importantes de energia
        if (code.includes('voltage') || code.includes('current') || code.includes('activepower') || 
            code.includes('energyconsumed') || code.includes('powerfactor') || code.includes('reactivepower')) {
          if (phase) {
            phases[phase].push(s);
          } else {
            totals.push(s);
          }
        } else if (code.includes('temp') || code.includes('humidity') || code.includes('sensor')) {
          sensors.push(s);
        } else {
          others.push(s);
        }
      });
      
      // Renderiza dados totais primeiro (se houver)
      if (totals.length > 0) {
        html += '<h3 style="margin-top: 20px; margin-bottom: 10px; color: #667eea; font-size: 16px;">⚡ Resumo Geral</h3>';
        html += '<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; margin-bottom: 15px;">';
        totals.forEach(s => {
          const code = (s.code || '').toLowerCase();
          if (code.includes('activepower') || code.includes('energyconsumed') || 
              (code.includes('current') && !code.includes('active')) || code.includes('voltage')) {
            html += `
              <div style="background: #f8f9fa; padding: 12px; border-radius: 8px; border-left: 3px solid #667eea;">
                <div style="font-size: 12px; color: #666; margin-bottom: 4px;">${s.code}</div>
                <div style="font-size: 18px; font-weight: bold; color: #333;">${formatStatusValue(s.value, s.code)}</div>
              </div>
            `;
          }
        });
        html += '</div>';
      }
      
      // Renderiza dados por fase
      const phasesWithData = ['A', 'B', 'C'].filter(p => phases[p].length > 0);
      if (phasesWithData.length > 0) {
        html += `<h3 style="margin-top: 20px; margin-bottom: 15px; color: #667eea; font-size: 16px;">📊 Dados por Fase</h3>`;
        phasesWithData.forEach(phase => {
          html += `<div style="margin-bottom: 20px; background: #f8f9fa; padding: 15px; border-radius: 8px; border-left: 4px solid #667eea;">`;
          html += `<h4 style="margin: 0 0 12px 0; color: #333; font-size: 14px;">Fase ${phase}</h4>`;
          html += '<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px;">';
          
          // Ordena: tensão, corrente, potência ativa, energia, fator de potência
          const order = ['voltage', 'current', 'activepower', 'energyconsumed', 'powerfactor', 'reactivepower'];
          const sorted = phases[phase].sort((a, b) => {
            const aCode = (a.code || '').toLowerCase();
            const bCode = (b.code || '').toLowerCase();
            const aIdx = order.findIndex(o => aCode.includes(o));
            const bIdx = order.findIndex(o => bCode.includes(o));
            return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
          });
          
          sorted.forEach(s => {
            const code = (s.code || '').toLowerCase();
            const label = s.code.replace(phase, '').replace(/^_+|_+$/g, '') || s.code;
            html += `
              <div style="background: white; padding: 10px; border-radius: 6px;">
                <div style="font-size: 11px; color: #666; margin-bottom: 4px;">${label}</div>
                <div style="font-size: 16px; font-weight: 600; color: #333;">${formatStatusValue(s.value, s.code)}</div>
              </div>
            `;
          });
          html += '</div></div>';
        });
      }
      
      // Renderiza outros dados de energia (se não foram organizados por fase)
      if (totals.length === 0 && phasesWithData.length === 0) {
        const energyData = data.status.filter(s => {
          const code = (s.code || '').toLowerCase();
          return code.includes('voltage') || code.includes('current') || code.includes('power') || code.includes('energy');
        });
        if (energyData.length > 0) {
          html += '<h3 style="margin-top: 20px; margin-bottom: 10px; color: #667eea;">📊 Medição de Energia</h3>';
          energyData.forEach(s => {
            html += `
              <div class="device-detail-item">
                <span class="device-detail-label">${s.code}:</span>
                <span class="device-detail-value"><code>${formatStatusValue(s.value, s.code)}</code></span>
              </div>
            `;
          });
        }
      }
      
      if (statusByCategory.sensor.length > 0) {
        html += '<h3 style="margin-top: 20px; margin-bottom: 10px; color: #667eea;">🌡️ Sensores</h3>';
        statusByCategory.sensor.forEach(s => {
          html += `
            <div class="device-detail-item">
              <span class="device-detail-label">${s.code}:</span>
              <span class="device-detail-value"><code>${formatStatusValue(s.value, s.code)}</code></span>
            </div>
          `;
        });
      }
      
      if (statusByCategory.other.length > 0) {
        html += '<h3 style="margin-top: 20px; margin-bottom: 10px; color: #667eea;">📋 Outros</h3>';
        statusByCategory.other.forEach(s => {
          html += `
            <div class="device-detail-item">
              <span class="device-detail-label">${s.code}:</span>
              <span class="device-detail-value"><code>${formatStatusValue(s.value, s.code)}</code></span>
            </div>
          `;
        });
      }
      
      modalBody.innerHTML = html;
    } else {
      modalBody.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">❌</div>
          ${data.error || 'Erro ao carregar detalhes do dispositivo'}
        </div>
      `;
    }
  } catch (error) {
    console.error('Erro ao obter status:', error);
    modalBody.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">❌</div>
        Erro ao conectar com a API: ${error.message}
      </div>
    `;
  }
}

function formatStatusValue(value, code) {
  if (typeof value === 'boolean') {
    return value ? 'Ligado' : 'Desligado';
  }
  if (typeof value === 'number') {
    const codeLower = (code || '').toLowerCase();
    // Formata valores de energia
    if (codeLower.includes('voltage')) {
      return value > 1000 ? (value / 10).toFixed(1) + ' V' : value + ' V';
    }
    if (codeLower.includes('current')) {
      return value > 100 ? (value / 1000).toFixed(3) + ' A' : value + ' A';
    }
    if (codeLower.includes('power') && !codeLower.includes('factor')) {
      return value > 10000 ? (value / 10).toFixed(1) + ' W' : value + ' W';
    }
    if (codeLower.includes('energy')) {
      return (value / 1000).toFixed(2) + ' kWh';
    }
  }
  return JSON.stringify(value);
}

function closeTuyaDeviceModal() {
  document.getElementById('tuyaDeviceModal').style.display = 'none';
}

// Fecha modal ao clicar fora
window.onclick = function(event) {
  const modal = document.getElementById('tuyaDeviceModal');
  if (event.target === modal) {
    closeTuyaDeviceModal();
  }
}

async function showEnergySection() {
  const section = document.getElementById('tuyaEnergySection');
  section.style.display = 'block';
  
  // Carrega lista de dispositivos com dados de energia
  await loadEnergyDevices();
}

async function forceEnergyCollection() {
  try {
    showToast('Iniciando coleta de energia...', 'info');
    console.log('[ENERGY] Iniciando coleta manual...');
    
    const response = await fetch('/admin/api/tuya/energy/collect-now', {
      method: 'POST',
      credentials: 'include' // Inclui cookies de sessão
    });
    
    console.log('[ENERGY] Resposta recebida:', response.status, response.statusText);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('[ENERGY] Erro HTTP:', response.status, errorText);
      showToast(`Erro HTTP ${response.status}: ${errorText}`, 'error');
      return;
    }
    
    const data = await response.json();
    console.log('[ENERGY] Dados recebidos:', data);
    
    if (data.success) {
      showToast(`✅ Coleta concluída: ${data.collected} dispositivo(s) registrado(s) de ${data.hasEnergyButNoData} medidor(es) encontrado(s)`, 'success');
      // Recarrega lista de dispositivos
      await loadEnergyDevices();
    } else {
      showToast(data.error || 'Erro na coleta', 'error');
      console.error('[ENERGY] Erro na coleta:', data);
    }
  } catch (error) {
    console.error('[ENERGY] Erro ao forçar coleta:', error);
    showToast(`Erro ao conectar com a API: ${error.message}`, 'error');
  }
}

async function loadEnergyDevices() {
  try {
    const response = await fetch('/admin/api/tuya/energy-devices');
    const data = await response.json();
    
    const select = document.getElementById('energyDeviceSelect');
    select.innerHTML = '<option value="">Selecione um dispositivo...</option>';
    
    if (data.success && data.data.length > 0) {
      // Separa dispositivos com e sem leituras
      const withReadings = data.data.filter(d => d.hasReadings !== false && d.readingsCount > 0);
      const withoutReadings = data.data.filter(d => !d.hasReadings || d.readingsCount === 0);
      
      // Adiciona dispositivos com leituras primeiro
      for (const device of withReadings) {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = `${device.deviceName || device.deviceId} (${device.readingsCount} leituras)`;
        select.appendChild(option);
      }
      
      // Adiciona dispositivos sem leituras (mas detectados como medidores)
      if (withoutReadings.length > 0) {
        const optgroup = document.createElement('optgroup');
        optgroup.label = 'Medidores (sem leituras ainda)';
        for (const device of withoutReadings) {
          const option = document.createElement('option');
          option.value = device.deviceId;
          option.textContent = `${device.deviceName || device.deviceId} (medidor detectado)`;
          optgroup.appendChild(option);
        }
        select.appendChild(optgroup);
      }
    } else {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'Nenhum medidor encontrado - clique em "Coletar Agora"';
      option.disabled = true;
      select.appendChild(option);
    }
  } catch (error) {
    console.error('Erro ao carregar dispositivos de energia:', error);
    showToast('Erro ao carregar dispositivos', 'error');
  }
}

async function loadEnergyChart() {
  const deviceId = document.getElementById('energyDeviceSelect').value;
  const hours = document.getElementById('energyPeriodSelect').value;
  
  if (!deviceId) {
    showToast('Selecione um dispositivo', 'error');
    return;
  }
  
  const container = document.getElementById('energyChartContainer');
  container.innerHTML = '<div class="loading"><div class="loading-spinner"></div><br>Carregando dados...</div>';
  
  try {
    // Busca estatísticas e dados por hora
    const [statsRes, hourlyRes] = await Promise.all([
      fetch(`/admin/api/tuya/energy/${deviceId}/stats?hours=${hours}`),
      fetch(`/admin/api/tuya/energy/${deviceId}/hourly?hours=${hours}`)
    ]);
    
    const stats = await statsRes.json();
    const hourly = await hourlyRes.json();
    
    // Atualiza estatísticas
    if (stats.success && stats.data) {
      document.getElementById('energyAvgPower').textContent = 
        stats.data.avg_power ? Math.round(stats.data.avg_power) : '-';
      document.getElementById('energyMaxPower').textContent = 
        stats.data.max_power ? Math.round(stats.data.max_power) : '-';
      document.getElementById('energyConsumed').textContent = 
        stats.data.energy_consumed ? stats.data.energy_consumed.toFixed(2) : '-';
      document.getElementById('energyReadings').textContent = 
        stats.data.readings_count || '-';
    }
    
    // Renderiza gráfico
    if (hourly.success && hourly.data.length > 0) {
      renderEnergyChart(hourly.data);
    } else {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📊</div>
          Nenhum dado de energia disponível para este período
        </div>
      `;
    }
  } catch (error) {
    console.error('Erro ao carregar dados de energia:', error);
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">❌</div>
        Erro ao carregar dados
      </div>
    `;
  }
}

function renderEnergyChart(data) {
  const container = document.getElementById('energyChartContainer');
  
  // Detecta se há dados de múltiplas fases
  const hasPhases = data.some(d => d.phases && Object.keys(d.phases).length > 0);
  
  // Calcula máximo de potência (incluindo fases)
  let maxPower = Math.max(...data.map(d => {
    let max = d.avg_power || 0;
    if (d.phases) {
      Object.values(d.phases).forEach(p => {
        if (p.power > max) max = p.power;
      });
    }
    return max;
  }));
  
  const phaseColors = {
    A: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    B: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
    C: 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)'
  };
  
  let html = `
    <div style="overflow-x: auto;">
      <div style="display: flex; align-items: flex-end; gap: 3px; min-height: 200px; padding: 10px 0;">
        ${data.map(d => {
          const hour = d.hour.split(' ')[1] || d.hour.split('T')[1]?.substring(0, 5) || d.hour;
          
          if (hasPhases && d.phases) {
            // Gráfico com múltiplas fases (barras empilhadas)
            const phases = Object.keys(d.phases).sort();
            let totalPower = 0;
            phases.forEach(p => totalPower += (d.phases[p].power || 0));
            
            return `
              <div style="flex: 1; min-width: 40px; max-width: 80px; text-align: center; position: relative;">
                <div style="display: flex; flex-direction: column-reverse; align-items: center; height: 180px;">
                  ${phases.map((phase, idx) => {
                    const phasePower = d.phases[phase].power || 0;
                    const height = maxPower > 0 ? (phasePower / maxPower * 180) : 0;
                    return `
                      <div style="
                        width: 100%;
                        height: ${height}px;
                        background: ${phaseColors[phase] || '#667eea'};
                        border-radius: ${idx === phases.length - 1 ? '4px 4px 0 0' : '0'};
                        min-height: ${height > 0 ? '2px' : '0'};
                        margin-bottom: 1px;
                      " title="Fase ${phase}: ${Math.round(phasePower)}W"></div>
                    `;
                  }).join('')}
                </div>
                <div style="font-size: 10px; color: #666; margin-top: 5px; writing-mode: vertical-rl; text-orientation: mixed; height: 50px;">
                  ${hour}
                </div>
                <div style="font-size: 9px; color: #999; margin-top: 2px;">
                  ${Math.round(totalPower)}W
                </div>
              </div>
            `;
          } else {
            // Gráfico simples (sem fases)
            const height = maxPower > 0 ? ((d.avg_power || 0) / maxPower * 180) : 0;
            return `
              <div style="flex: 1; min-width: 30px; max-width: 60px; text-align: center;">
                <div style="
                  height: ${height}px; 
                  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                  border-radius: 4px 4px 0 0;
                  min-height: 2px;
                " title="Potência: ${Math.round(d.avg_power || 0)}W"></div>
                <div style="font-size: 10px; color: #666; margin-top: 5px; writing-mode: vertical-rl; text-orientation: mixed; height: 50px;">
                  ${hour}
                </div>
                <div style="font-size: 9px; color: #999; margin-top: 2px;">
                  ${Math.round(d.avg_power || 0)}W
                </div>
              </div>
            `;
          }
        }).join('')}
      </div>
    </div>
    <div style="text-align: center; color: #666; font-size: 12px; margin-top: 10px;">
      ${hasPhases ? 'Potência por Fase (W) por Hora' : 'Potência Média (W) por Hora'} | Máximo: ${Math.round(maxPower)}W
      ${hasPhases ? '<div style="margin-top: 8px; font-size: 11px;"><span style="color: #667eea;">■</span> Fase A <span style="color: #f5576c; margin-left: 10px;">■</span> Fase B <span style="color: #00f2fe; margin-left: 10px;">■</span> Fase C</div>' : ''}
    </div>
  `;
  
  container.innerHTML = html;
}

async function loadTuyaEvents() {
  const container = document.getElementById('tuyaEventsTable');
  const section = document.getElementById('tuyaEventsSection');
  section.style.display = 'block';
  
  try {
    const response = await fetch('/admin/api/tuya/events?limit=50');
    const data = await response.json();
    
    if (data.success && data.data.length > 0) {
      container.innerHTML = `
        <table>
          <thead>
            <tr>
              <th>Data/Hora</th>
              <th>Dispositivo</th>
              <th>Evento</th>
              <th>Mudança</th>
              <th>Fonte</th>
            </tr>
          </thead>
          <tbody>
            ${data.data.map(event => `
              <tr>
                <td>${formatDate(event.created_at)}</td>
                <td>${event.device_name || event.device_id}</td>
                <td>${event.event_type}</td>
                <td>${event.old_value || '-'} → ${event.new_value || '-'}</td>
                <td>${event.source || '-'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
    } else {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📜</div>
          Nenhum evento registrado
        </div>
      `;
    }
  } catch (error) {
    console.error('Erro ao carregar eventos Tuya:', error);
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">❌</div>
        Erro ao carregar eventos
      </div>
    `;
  }
}

// ===== ACCESS LOGS =====

let currentAccessView = 'logs';

async function loadAccessLogs() {
  const container = document.getElementById('accessLogsView');
  
  try {
    const ip = document.getElementById('accessFilterIP')?.value || '';
    const route = document.getElementById('accessFilterRoute')?.value || '';
    const method = document.getElementById('accessFilterMethod')?.value || '';
    
    let url = `/admin/api/access-logs?limit=100`;
    if (ip) url += `&ip=${encodeURIComponent(ip)}`;
    if (route) url += `&route=${encodeURIComponent(route)}`;
    if (method) url += `&method=${encodeURIComponent(method)}`;
    
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.success) {
      // Atualiza stats
      document.getElementById('accessTotal').textContent = data.pagination.total;
      
      if (data.data.length > 0) {
        container.innerHTML = `
          <table>
            <thead>
              <tr>
                <th>Data/Hora</th>
                <th>IP</th>
                <th>Método</th>
                <th>Rota</th>
                <th>Status</th>
                <th>Tempo (ms)</th>
              </tr>
            </thead>
            <tbody>
              ${data.data.map(log => {
                const statusColor = log.status_code >= 400 ? '#e74c3c' : 
                                    log.status_code >= 300 ? '#f39c12' : '#27ae60';
                return `
                  <tr>
                    <td>${formatDate(log.created_at)}</td>
                    <td class="ip-cell">${log.ip}</td>
                    <td><span class="badge">${log.method}</span></td>
                    <td style="max-width: 300px; overflow: hidden; text-overflow: ellipsis;">${log.route}</td>
                    <td style="color: ${statusColor}; font-weight: 600;">${log.status_code || '-'}</td>
                    <td>${log.response_time_ms || '-'}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        `;
      } else {
        container.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">📋</div>
            Nenhum log de acesso encontrado
          </div>
        `;
      }
    }
  } catch (error) {
    console.error('Erro ao carregar access logs:', error);
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">❌</div>
        Erro ao carregar logs
      </div>
    `;
  }
}

async function loadAccessStatsByRoutes() {
  const container = document.getElementById('accessRoutesView');
  
  try {
    const response = await fetch('/admin/api/access-logs/stats/routes');
    const data = await response.json();
    
    if (data.success && data.data.length > 0) {
      document.getElementById('accessUniqueRoutes').textContent = data.data.length;
      
      container.innerHTML = `
        <table>
          <thead>
            <tr>
              <th>Rota</th>
              <th>Método</th>
              <th>Acessos</th>
              <th>Tempo Médio (ms)</th>
              <th>Último Acesso</th>
            </tr>
          </thead>
          <tbody>
            ${data.data.map(stat => `
              <tr>
                <td style="max-width: 400px; overflow: hidden; text-overflow: ellipsis;">${stat.route}</td>
                <td><span class="badge">${stat.method}</span></td>
                <td><strong>${stat.count}</strong></td>
                <td>${Math.round(stat.avg_response_time || 0)}</td>
                <td>${formatDate(stat.last_access)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
    } else {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🛤️</div>
          Nenhuma estatística de rota disponível
        </div>
      `;
    }
  } catch (error) {
    console.error('Erro ao carregar stats por rota:', error);
  }
}

async function loadAccessStatsByIPs() {
  const container = document.getElementById('accessIPsView');
  
  try {
    const response = await fetch('/admin/api/access-logs/stats/ips');
    const data = await response.json();
    
    if (data.success && data.data.length > 0) {
      document.getElementById('accessUniqueIPs').textContent = data.data.length;
      
      container.innerHTML = `
        <table>
          <thead>
            <tr>
              <th>IP</th>
              <th>Total de Acessos</th>
              <th>Rotas Únicas</th>
              <th>Último Acesso</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            ${data.data.map(stat => `
              <tr>
                <td class="ip-cell">${stat.ip}</td>
                <td><strong>${stat.count}</strong></td>
                <td>${stat.unique_routes}</td>
                <td>${formatDate(stat.last_access)}</td>
                <td>
                  <button class="btn-action btn-lookup" onclick="quickLookup('${stat.ip}')" title="Consultar">🔍</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
    } else {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🌐</div>
          Nenhuma estatística de IP disponível
        </div>
      `;
    }
  } catch (error) {
    console.error('Erro ao carregar stats por IP:', error);
  }
}

function showAccessView(view) {
  currentAccessView = view;
  
  document.getElementById('accessLogsView').style.display = view === 'logs' ? 'block' : 'none';
  document.getElementById('accessRoutesView').style.display = view === 'routes' ? 'block' : 'none';
  document.getElementById('accessIPsView').style.display = view === 'ips' ? 'block' : 'none';
  
  if (view === 'logs') loadAccessLogs();
  else if (view === 'routes') loadAccessStatsByRoutes();
  else if (view === 'ips') loadAccessStatsByIPs();
}

// ===== INICIALIZAÇÃO =====

document.addEventListener('DOMContentLoaded', () => {
  loadOverview();
  
  // Atualiza visão geral a cada 30 segundos
  setInterval(() => {
    if (currentTab === 'overview') loadOverview();
  }, 30000);
  
  // Atualiza dispositivos a cada 10 segundos
  setInterval(() => {
    if (currentTab === 'devices') loadDevices();
  }, 10000);
  
  // Atualiza métricas do servidor a cada 5 segundos
  setInterval(() => {
    if (currentTab === 'server') {
      loadServerMetrics();
      loadAbuseIPDBStats();
    }
  }, 5000);
  
  // Atualiza dispositivos Tuya a cada 30 segundos
  setInterval(() => {
    if (currentTab === 'tuya') loadTuyaDevices();
  }, 30000);
});
