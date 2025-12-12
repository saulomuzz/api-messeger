// Dashboard JavaScript
let currentTab = 'overview';
let statsData = null;

// Estado de paginação e ordenação
const pagination = {
  blocked: { offset: 0, limit: 20 },
  whitelist: { offset: 0, limit: 20 },
  yellowlist: { offset: 0, limit: 20 },
  migrations: { offset: 0, limit: 20 }
};

const sortState = {
  blocked: { field: 'blocked_at', order: 'desc' },
  whitelist: { field: 'last_seen', order: 'desc' },
  yellowlist: { field: 'last_seen', order: 'desc' },
  migrations: { field: 'created_at', order: 'desc' }
};

// Alterna entre abas
function switchTab(tabName, event) {
  // Remove active de todas as abas
  document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
  
  // Ativa aba selecionada
  if (event && event.target) {
    event.target.classList.add('active');
  } else {
    // Fallback: encontra a aba pelo nome
    document.querySelectorAll('.tab').forEach(tab => {
      if (tab.textContent.includes(tabName === 'ips' ? 'Bloqueados' : 
                                    tabName === 'overview' ? 'Visão' :
                                    tabName === 'whitelist' ? 'Whitelist' :
                                    tabName === 'yellowlist' ? 'Yellowlist' :
                                    tabName === 'devices' ? 'Dispositivos' :
                                    tabName === 'migrations' ? 'Migrações' : '')) {
        tab.classList.add('active');
      }
    });
  }
  document.getElementById(`tab-${tabName}`).classList.add('active');
  currentTab = tabName;
  
  // Carrega dados da aba
  loadTabData(tabName);
}

// Carrega dados da aba
function loadTabData(tabName) {
  switch(tabName) {
    case 'overview':
      loadOverview();
      break;
    case 'ips':
      loadBlocked();
      break;
    case 'whitelist':
      loadWhitelist();
      break;
    case 'yellowlist':
      loadYellowlist();
      break;
    case 'devices':
      loadDevices();
      break;
    case 'migrations':
      loadMigrations();
      break;
    case 'server':
      loadServerMetrics();
      break;
  }
}

// Carrega visão geral
async function loadOverview() {
  try {
    const response = await fetch('/admin/api/dashboard/stats');
    const data = await response.json();
    
    console.log('Dados recebidos do dashboard:', data);
    
    if (data.success) {
      statsData = data.stats;
      console.log('Estatísticas carregadas:', {
        messages: data.stats.messages,
        routes: data.stats.routes,
        topIPs: data.stats.topIPs,
        hourly: data.stats.hourly?.length
      });
      renderOverviewStats(data.stats);
      renderCharts(data.stats);
      renderSystemInfo(data.stats);
    } else {
      console.error('Erro ao carregar estatísticas:', data.error);
    }
  } catch (error) {
    console.error('Erro ao carregar visão geral:', error);
  }
}

// Renderiza estatísticas principais
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
    <div class="stat-card messages-sent">
      <div class="stat-label">Mensagens Enviadas</div>
      <div class="stat-value">${stats.messages?.totalSent || 0}</div>
      <div class="stat-subtitle">Últimas 24h: ${stats.messages?.last24h?.sent || 0}</div>
    </div>
    <div class="stat-card messages-received">
      <div class="stat-label">Mensagens Recebidas</div>
      <div class="stat-value">${stats.messages?.totalReceived || 0}</div>
      <div class="stat-subtitle">Últimas 24h: ${stats.messages?.last24h?.received || 0}</div>
    </div>
    <div class="stat-card devices">
      <div class="stat-label">Dispositivos Conectados</div>
      <div class="stat-value">${stats.devices?.active || 0}</div>
      <div class="stat-subtitle">Total: ${stats.devices?.total || 0}</div>
    </div>
    <div class="stat-card routes">
      <div class="stat-label">Rotas Ativas</div>
      <div class="stat-value">${stats.routes?.total || 0}</div>
    </div>
    <div class="stat-card migrations">
      <div class="stat-label">Migrações</div>
      <div class="stat-value">${stats.ips?.migrations || 0}</div>
    </div>
  `;
  
  document.getElementById('overviewStats').innerHTML = html;
}

// Renderiza gráficos
function renderCharts(stats) {
  // Gráfico de mensagens
  // Se não houver dados horários, mostra mensagem
  if (!stats.hourly || stats.hourly.length === 0 || stats.hourly.every(h => h.sent === 0 && h.received === 0)) {
    document.getElementById('messagesChart').innerHTML = '<div style="text-align: center; color: #666; padding: 20px;">Nenhuma mensagem registrada nas últimas 24h</div>';
  } else {
    const messagesHtml = `
      <div style="display: flex; flex-direction: column; gap: 10px;">
        ${stats.hourly.map((h, i) => {
          const hour = String(i).padStart(2, '0') + ':00';
          const max = Math.max(...stats.hourly.map(h => h.sent + h.received), 1);
          const sentHeight = (h.sent / max) * 100;
          const receivedHeight = (h.received / max) * 100;
          return `
            <div style="display: flex; align-items: flex-end; gap: 4px; height: 40px;">
              <div style="flex: 1; background: #9b59b6; height: ${sentHeight}%; border-radius: 4px 4px 0 0;" title="Enviadas: ${h.sent}"></div>
              <div style="flex: 1; background: #1abc9c; height: ${receivedHeight}%; border-radius: 4px 4px 0 0;" title="Recebidas: ${h.received}"></div>
              <div style="width: 40px; text-align: center; font-size: 11px; color: #666;">${hour}</div>
            </div>
          `;
        }).join('')}
      </div>
    `;
    document.getElementById('messagesChart').innerHTML = messagesHtml;
  }
  
  // Top 5 rotas
  const top5Routes = (stats.routes?.topRoutes || []).slice(0, 5);
  console.log('Top 5 rotas:', top5Routes);
  const routesHtml = `
    <div style="display: flex; flex-direction: column; gap: 8px;">
      ${top5Routes.length > 0 ? top5Routes.map((route, index) => {
        const maxCount = top5Routes[0]?.count || 1;
        const width = (route.count / maxCount) * 100;
        return `
          <div style="padding: 8px; background: #f8f9fa; border-radius: 4px;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
              <span style="font-family: monospace; font-size: 12px; font-weight: 600;">#${index + 1} ${route.route || 'N/A'}</span>
              <span style="font-weight: 600; color: #667eea;">${route.count || 0}</span>
            </div>
            <div style="height: 6px; background: #e0e0e0; border-radius: 3px; overflow: hidden;">
              <div style="height: 100%; background: linear-gradient(90deg, #667eea 0%, #764ba2 100%); width: ${width}%; transition: width 0.3s;"></div>
            </div>
          </div>
        `;
      }).join('') : '<div style="text-align: center; color: #666; padding: 20px;">Nenhuma rota registrada</div>'}
    </div>
  `;
  document.getElementById('routesChart').innerHTML = routesHtml;
  
  // Top 5 IPs
  const top5IPs = (stats.topIPs || []).slice(0, 5);
  console.log('Top 5 IPs:', top5IPs);
  const ipsHtml = `
    <div style="display: flex; flex-direction: column; gap: 8px;">
      ${top5IPs.length > 0 ? top5IPs.map((ipData, index) => {
        const maxCount = top5IPs[0]?.count || 1;
        const width = (ipData.count / maxCount) * 100;
        return `
          <div style="padding: 8px; background: #f8f9fa; border-radius: 4px;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
              <span style="font-family: monospace; font-size: 12px; font-weight: 600;">#${index + 1} ${ipData.ip || 'N/A'}</span>
              <span style="font-weight: 600; color: #e74c3c;">${ipData.count || 0}</span>
            </div>
            <div style="height: 6px; background: #e0e0e0; border-radius: 3px; overflow: hidden;">
              <div style="height: 100%; background: linear-gradient(90deg, #e74c3c 0%, #c0392b 100%); width: ${width}%; transition: width 0.3s;"></div>
            </div>
          </div>
        `;
      }).join('') : '<div style="text-align: center; color: #666; padding: 20px;">Nenhum IP registrado</div>'}
    </div>
  `;
  document.getElementById('topIPsChart').innerHTML = ipsHtml;
}

// Renderiza informações do sistema
function renderSystemInfo(stats) {
  const uptime = stats.system?.uptime || 0;
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const whatsappStatus = stats.whatsapp?.ready ? 'online' : 'offline';
  
  const html = `
    <div class="info-card">
      <div class="info-label">Uptime</div>
      <div class="info-value">${hours}h ${minutes}m</div>
    </div>
    <div class="info-card">
      <div class="info-label">WhatsApp Status</div>
      <div class="info-value">
        <span class="status-indicator status-${whatsappStatus}"></span>
        ${whatsappStatus === 'online' ? 'Online' : 'Offline'}
      </div>
    </div>
    <div class="info-card">
      <div class="info-label">Mensagens Falhadas</div>
      <div class="info-value">${stats.messages?.totalFailed || 0}</div>
    </div>
    <div class="info-card">
      <div class="info-label">ESP32 Conectados</div>
      <div class="info-value">${stats.esp32?.connected || 0}</div>
    </div>
  `;
  
  document.getElementById('systemInfo').innerHTML = html;
}

// Carrega IPs bloqueados
async function loadBlocked() {
  try {
    const { offset, limit } = pagination.blocked;
    const response = await fetch(`/admin/api/blocked?limit=${limit}&offset=${offset}`);
    const data = await response.json();
    
    if (data.success) {
      renderBlockedTable(data.data, data.pagination);
    }
  } catch (error) {
    console.error('Erro ao carregar IPs bloqueados:', error);
    document.getElementById('blockedTable').innerHTML = '<div class="loading">Erro ao carregar dados</div>';
  }
}

// Renderiza tabela de IPs bloqueados
function renderBlockedTable(ips, pagination) {
  if (!ips || ips.length === 0) {
    document.getElementById('blockedTable').innerHTML = '<div class="loading">Nenhum IP bloqueado</div>';
    return;
  }
  
  const sorted = sortData(ips, sortState.blocked.field, sortState.blocked.order);
  
  const html = `
    <table>
      <thead>
        <tr>
          ${createSortableHeader('IP', 'ip', 'blocked')}
          ${createSortableHeader('Motivo', 'reason', 'blocked')}
          ${createSortableHeader('Tentativas', 'request_count', 'blocked')}
          ${createSortableHeader('Bloqueado em', 'blocked_at', 'blocked')}
          ${createSortableHeader('Última tentativa', 'last_seen', 'blocked')}
          <th>Ações</th>
        </tr>
      </thead>
      <tbody>
        ${sorted.map(ip => {
          const blockedDate = ip.blocked_at ? new Date(ip.blocked_at * 1000).toLocaleString('pt-BR') : 'N/A';
          const lastSeen = ip.last_seen ? new Date(ip.last_seen * 1000).toLocaleString('pt-BR') : 'Nunca';
          return `
            <tr>
              <td><strong>${ip.ip}</strong></td>
              <td>${ip.reason || 'Não especificado'}</td>
              <td>${ip.request_count || 0}</td>
              <td>${blockedDate}</td>
              <td>${lastSeen}</td>
              <td>
                <button class="btn-action btn-unblock" onclick="unblockIP('${ip.ip}')" title="Desbloquear">🔓</button>
                <button class="btn-action btn-whitelist" onclick="migrateIP('${ip.ip}', 'blocked', 'whitelist')" title="Mover para Whitelist">✅</button>
                <button class="btn-action btn-yellowlist" onclick="migrateIP('${ip.ip}', 'blocked', 'yellowlist')" title="Mover para Yellowlist">⚠️</button>
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
    ${renderPagination('blocked', pagination)}
  `;
  
  document.getElementById('blockedTable').innerHTML = html;
}

// Carrega whitelist
async function loadWhitelist() {
  try {
    const { offset, limit } = pagination.whitelist;
    const response = await fetch(`/admin/api/whitelist?limit=${limit}&offset=${offset}`);
    const data = await response.json();
    
    if (data.success) {
      renderWhitelistTable(data.data, data.pagination);
    }
  } catch (error) {
    console.error('Erro ao carregar whitelist:', error);
    document.getElementById('whitelistTable').innerHTML = '<div class="loading">Erro ao carregar dados</div>';
  }
}

// Renderiza tabela de whitelist
function renderWhitelistTable(ips, pagination) {
  if (!ips || ips.length === 0) {
    document.getElementById('whitelistTable').innerHTML = '<div class="loading">Nenhum IP na whitelist</div>';
    return;
  }
  
  const sorted = sortData(ips, sortState.whitelist.field, sortState.whitelist.order);
  
  const html = `
    <table>
      <thead>
        <tr>
          ${createSortableHeader('IP', 'ip', 'whitelist')}
          ${createSortableHeader('Confiança', 'abuse_confidence', 'whitelist')}
          ${createSortableHeader('Reports', 'reports', 'whitelist')}
          ${createSortableHeader('Tentativas', 'request_count', 'whitelist')}
          ${createSortableHeader('Criado em', 'created_at', 'whitelist')}
          ${createSortableHeader('Expira em', 'expires_at', 'whitelist')}
          ${createSortableHeader('Última atualização', 'last_seen', 'whitelist')}
          <th>Ações</th>
        </tr>
      </thead>
      <tbody>
        ${sorted.map(ip => {
          const createdDate = ip.created_at ? new Date(ip.created_at * 1000).toLocaleString('pt-BR') : 'N/A';
          const expiresDate = ip.expires_at ? new Date(ip.expires_at * 1000).toLocaleString('pt-BR') : 'N/A';
          const lastSeen = ip.last_seen ? new Date(ip.last_seen * 1000).toLocaleString('pt-BR') : 'Nunca';
          return `
            <tr>
              <td><strong>${ip.ip}</strong></td>
              <td>${ip.abuse_confidence !== null ? ip.abuse_confidence + '%' : 'N/A'}</td>
              <td>${ip.reports || 0}</td>
              <td>${ip.request_count || 0}</td>
              <td>${createdDate}</td>
              <td>${expiresDate}</td>
              <td>${lastSeen}</td>
              <td>
                <button class="btn-action btn-remove" onclick="removeFromList('${ip.ip}', 'whitelist')" title="Remover">🗑️</button>
                <button class="btn-action btn-block" onclick="migrateIP('${ip.ip}', 'whitelist', 'blocked')" title="Bloquear">🚫</button>
                <button class="btn-action btn-yellowlist" onclick="migrateIP('${ip.ip}', 'whitelist', 'yellowlist')" title="Mover para Yellowlist">⚠️</button>
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
    ${renderPagination('whitelist', pagination)}
  `;
  
  document.getElementById('whitelistTable').innerHTML = html;
}

// Carrega yellowlist
async function loadYellowlist() {
  try {
    const { offset, limit } = pagination.yellowlist;
    const response = await fetch(`/admin/api/yellowlist?limit=${limit}&offset=${offset}`);
    const data = await response.json();
    
    if (data.success) {
      renderYellowlistTable(data.data, data.pagination);
    }
  } catch (error) {
    console.error('Erro ao carregar yellowlist:', error);
    document.getElementById('yellowlistTable').innerHTML = '<div class="loading">Erro ao carregar dados</div>';
  }
}

// Renderiza tabela de yellowlist
function renderYellowlistTable(ips, pagination) {
  if (!ips || ips.length === 0) {
    document.getElementById('yellowlistTable').innerHTML = '<div class="loading">Nenhum IP na yellowlist</div>';
    return;
  }
  
  const sorted = sortData(ips, sortState.yellowlist.field, sortState.yellowlist.order);
  
  const html = `
    <table>
      <thead>
        <tr>
          ${createSortableHeader('IP', 'ip', 'yellowlist')}
          ${createSortableHeader('Confiança', 'abuse_confidence', 'yellowlist')}
          ${createSortableHeader('Reports', 'reports', 'yellowlist')}
          ${createSortableHeader('Tentativas', 'request_count', 'yellowlist')}
          ${createSortableHeader('Criado em', 'created_at', 'yellowlist')}
          ${createSortableHeader('Expira em', 'expires_at', 'yellowlist')}
          ${createSortableHeader('Última atualização', 'last_seen', 'yellowlist')}
          <th>Ações</th>
        </tr>
      </thead>
      <tbody>
        ${sorted.map(ip => {
          const createdDate = ip.created_at ? new Date(ip.created_at * 1000).toLocaleString('pt-BR') : 'N/A';
          const expiresDate = ip.expires_at ? new Date(ip.expires_at * 1000).toLocaleString('pt-BR') : 'N/A';
          const lastSeen = ip.last_seen ? new Date(ip.last_seen * 1000).toLocaleString('pt-BR') : 'Nunca';
          return `
            <tr>
              <td><strong>${ip.ip}</strong></td>
              <td>${ip.abuse_confidence !== null ? ip.abuse_confidence + '%' : 'N/A'}</td>
              <td>${ip.reports || 0}</td>
              <td>${ip.request_count || 0}</td>
              <td>${createdDate}</td>
              <td>${expiresDate}</td>
              <td>${lastSeen}</td>
              <td>
                <button class="btn-action btn-remove" onclick="removeFromList('${ip.ip}', 'yellowlist')" title="Remover">🗑️</button>
                <button class="btn-action btn-whitelist" onclick="migrateIP('${ip.ip}', 'yellowlist', 'whitelist')" title="Mover para Whitelist">✅</button>
                <button class="btn-action btn-block" onclick="migrateIP('${ip.ip}', 'yellowlist', 'blocked')" title="Bloquear">🚫</button>
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
    ${renderPagination('yellowlist', pagination)}
  `;
  
  document.getElementById('yellowlistTable').innerHTML = html;
}

// Carrega dispositivos
async function loadDevices() {
  try {
    const response = await fetch('/admin/api/dashboard/stats');
    const data = await response.json();
    
    if (data.success && data.stats.devices) {
      renderDevicesTable(data.stats.devices.list || []);
    }
  } catch (error) {
    console.error('Erro ao carregar dispositivos:', error);
    document.getElementById('devicesTable').innerHTML = '<div class="loading">Erro ao carregar dados</div>';
  }
}

// Renderiza tabela de dispositivos
function renderDevicesTable(devices) {
  if (!devices || devices.length === 0) {
    document.getElementById('devicesTable').innerHTML = '<div class="loading">Nenhum dispositivo conectado</div>';
    return;
  }
  
  const html = `
    <table>
      <thead>
        <tr>
          <th>IP</th>
          <th>Tipo</th>
          <th>Última Atividade</th>
          <th>Conectado em</th>
        </tr>
      </thead>
      <tbody>
        ${devices.map(device => {
          const lastSeen = device.lastSeen ? new Date(device.lastSeen).toLocaleString('pt-BR') : 'N/A';
          const connectedAt = device.metadata?.connectedAt ? new Date(device.metadata.connectedAt).toLocaleString('pt-BR') : 'N/A';
          return `
            <tr>
              <td><strong>${device.ip}</strong></td>
              <td><span class="badge ${device.connectionType}">${device.connectionType}</span></td>
              <td>${lastSeen}</td>
              <td>${connectedAt}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
  
  document.getElementById('devicesTable').innerHTML = html;
}

// Carrega migrações
async function loadMigrations() {
  try {
    const { offset, limit } = pagination.migrations;
    const response = await fetch(`/admin/api/migrations?limit=${limit}&offset=${offset}`);
    const data = await response.json();
    
    if (data.success) {
      renderMigrationsTable(data.data, data.pagination);
    }
  } catch (error) {
    console.error('Erro ao carregar migrações:', error);
    document.getElementById('migrationsTable').innerHTML = '<div class="loading">Erro ao carregar dados</div>';
  }
}

// Renderiza tabela de migrações
function renderMigrationsTable(logs, pagination) {
  if (!logs || logs.length === 0) {
    document.getElementById('migrationsTable').innerHTML = '<div class="loading">Nenhuma migração encontrada</div>';
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
          ${createSortableHeader('Reports', 'new_reports', 'migrations')}
          ${createSortableHeader('Data', 'created_at', 'migrations')}
        </tr>
      </thead>
      <tbody>
        ${sorted.map(log => {
          const date = new Date(log.created_at * 1000).toLocaleString('pt-BR');
          return `
            <tr>
              <td><strong>${log.ip}</strong></td>
              <td><span class="badge ${log.from_list || 'none'}">${log.from_list || 'Nenhuma'}</span></td>
              <td><span class="badge ${log.to_list}">${log.to_list}</span></td>
              <td>${log.old_confidence !== null ? log.old_confidence + '%' : '-'} → ${log.new_confidence !== null ? log.new_confidence + '%' : '-'}</td>
              <td>${log.old_reports !== null ? log.old_reports : '-'} → ${log.new_reports !== null ? log.new_reports : '-'}</td>
              <td>${date}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
    ${renderPagination('migrations', pagination)}
  `;
  
  document.getElementById('migrationsTable').innerHTML = html;
}

// Funções auxiliares
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
  loadTabData(tableType);
}

function renderPagination(type, pagination) {
  if (pagination.total <= pagination.limit) return '';
  
  const currentPage = Math.floor(pagination.offset / pagination.limit) + 1;
  const totalPages = Math.ceil(pagination.total / pagination.limit);
  
  return `
    <div class="pagination">
      <button onclick="prevPage('${type}')" ${pagination.offset === 0 ? 'disabled' : ''}>Anterior</button>
      <span>Página ${currentPage} de ${totalPages} (Total: ${pagination.total})</span>
      <button onclick="nextPage('${type}')" ${!pagination.hasMore ? 'disabled' : ''}>Próxima</button>
    </div>
  `;
}

function prevPage(type) {
  pagination[type].offset = Math.max(0, pagination[type].offset - pagination[type].limit);
  loadTabData(type === 'blocked' ? 'ips' : type);
}

function nextPage(type) {
  pagination[type].offset += pagination[type].limit;
  loadTabData(type === 'blocked' ? 'ips' : type);
}

// Logout
async function logout() {
  try {
    await fetch('/admin/logout', { method: 'POST' });
    window.location.href = '/admin';
  } catch (error) {
    console.error('Erro ao fazer logout:', error);
  }
}

// Funções de gerenciamento de IPs
async function unblockIP(ip) {
  if (!confirm(`Deseja realmente desbloquear o IP ${ip}?`)) return;
  
  try {
    const response = await fetch(`/admin/api/ip/unblock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip })
    });
    const data = await response.json();
    
    if (data.success) {
      alert(`IP ${ip} desbloqueado com sucesso!`);
      loadBlocked();
    } else {
      alert(`Erro: ${data.error || 'Falha ao desbloquear IP'}`);
    }
  } catch (error) {
    alert(`Erro ao desbloquear IP: ${error.message}`);
  }
}

async function removeFromList(ip, listType) {
  if (!confirm(`Deseja realmente remover o IP ${ip} da ${listType}?`)) return;
  
  try {
    const response = await fetch(`/admin/api/ip/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip, listType })
    });
    const data = await response.json();
    
    if (data.success) {
      alert(`IP ${ip} removido da ${listType} com sucesso!`);
      if (listType === 'whitelist') loadWhitelist();
      else if (listType === 'yellowlist') loadYellowlist();
    } else {
      alert(`Erro: ${data.error || 'Falha ao remover IP'}`);
    }
  } catch (error) {
    alert(`Erro ao remover IP: ${error.message}`);
  }
}

async function migrateIP(ip, fromList, toList) {
  const listNames = { blocked: 'Bloqueados', whitelist: 'Whitelist', yellowlist: 'Yellowlist' };
  if (!confirm(`Deseja mover o IP ${ip} de ${listNames[fromList]} para ${listNames[toList]}?`)) return;
  
  try {
    const response = await fetch(`/admin/api/ip/migrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip, fromList, toList })
    });
    const data = await response.json();
    
    if (data.success) {
      alert(`IP ${ip} movido para ${listNames[toList]} com sucesso!`);
      // Recarrega as tabelas afetadas
      if (fromList === 'blocked' || toList === 'blocked') loadBlocked();
      if (fromList === 'whitelist' || toList === 'whitelist') loadWhitelist();
      if (fromList === 'yellowlist' || toList === 'yellowlist') loadYellowlist();
      loadOverview(); // Atualiza estatísticas
    } else {
      alert(`Erro: ${data.error || 'Falha ao migrar IP'}`);
    }
  } catch (error) {
    alert(`Erro ao migrar IP: ${error.message}`);
  }
}

// Carrega métricas do servidor
async function loadServerMetrics() {
  try {
    const response = await fetch('/admin/api/server/metrics');
    const data = await response.json();
    
    if (data.success) {
      renderServerMetrics(data.metrics);
    }
  } catch (error) {
    console.error('Erro ao carregar métricas do servidor:', error);
    document.getElementById('tab-server').innerHTML = '<div class="loading">Erro ao carregar métricas</div>';
  }
}

// Renderiza métricas do servidor
function renderServerMetrics(metrics) {
  // CPU
  const cpu1min = metrics.cpu?.load1min || 0;
  const cpu5min = metrics.cpu?.load5min || 0;
  const cpu15min = metrics.cpu?.load15min || 0;
  
  document.getElementById('cpu1min').textContent = cpu1min.toFixed(2) + '%';
  document.getElementById('cpu1minBar').style.width = cpu1min + '%';
  document.getElementById('cpu5min').textContent = cpu5min.toFixed(2) + '%';
  document.getElementById('cpu5minBar').style.width = cpu5min + '%';
  document.getElementById('cpu15min').textContent = cpu15min.toFixed(2) + '%';
  document.getElementById('cpu15minBar').style.width = cpu15min + '%';
  
  // Memória
  const memTotal = formatBytes(metrics.memory?.total || 0);
  const memUsed = formatBytes(metrics.memory?.used || 0);
  const memFree = formatBytes(metrics.memory?.free || 0);
  const memUsedPercent = metrics.memory?.total > 0 ? (metrics.memory.used / metrics.memory.total) * 100 : 0;
  const memFreePercent = metrics.memory?.total > 0 ? (metrics.memory.free / metrics.memory.total) * 100 : 0;
  
  document.getElementById('memTotal').textContent = memTotal;
  document.getElementById('memUsed').textContent = memUsed;
  document.getElementById('memUsedBar').style.width = memUsedPercent + '%';
  document.getElementById('memFree').textContent = memFree;
  document.getElementById('memFreeBar').style.width = memFreePercent + '%';
  
  // Disco
  const diskTotal = formatBytes(metrics.disk?.total || 0);
  const diskUsed = formatBytes(metrics.disk?.used || 0);
  const diskFree = formatBytes(metrics.disk?.free || 0);
  const diskUsedPercent = metrics.disk?.total > 0 ? (metrics.disk.used / metrics.disk.total) * 100 : 0;
  const diskFreePercent = metrics.disk?.total > 0 ? (metrics.disk.free / metrics.disk.total) * 100 : 0;
  
  document.getElementById('diskTotal').textContent = diskTotal;
  document.getElementById('diskUsed').textContent = diskUsed;
  document.getElementById('diskUsedBar').style.width = diskUsedPercent + '%';
  document.getElementById('diskFree').textContent = diskFree;
  document.getElementById('diskFreeBar').style.width = diskFreePercent + '%';
  
  // Informações do sistema
  document.getElementById('sysOS').textContent = metrics.system?.platform || '-';
  document.getElementById('sysArch').textContent = metrics.system?.arch || '-';
  document.getElementById('sysUptime').textContent = formatUptime(metrics.system?.uptime || 0);
  document.getElementById('sysPlatform').textContent = metrics.system?.type || '-';
}

// Formata bytes para formato legível
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Formata uptime
function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  
  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  } else if (hours > 0) {
    return `${hours}h ${minutes}m`;
  } else {
    return `${minutes}m`;
  }
}

// Inicialização
document.addEventListener('DOMContentLoaded', () => {
  loadOverview();
  
  // Atualiza visão geral a cada 30 segundos
  setInterval(() => {
    if (currentTab === 'overview') {
      loadOverview();
    }
  }, 30000);
  
  // Atualiza dispositivos a cada 10 segundos
  setInterval(() => {
    if (currentTab === 'devices') {
      loadDevices();
    }
  }, 10000);
  
  // Atualiza métricas do servidor a cada 5 segundos
  setInterval(() => {
    if (currentTab === 'server') {
      loadServerMetrics();
    }
  }, 5000);
});

