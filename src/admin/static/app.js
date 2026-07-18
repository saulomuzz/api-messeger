const state = {
  bootstrap: null,
  selectedConversationKey: null,
  activeScreen: 'overview',
  toastTimer: null,
  loadedTemplates: [],
  auditFilter: 'all',
  expandedBubble: null,
  auditAutoRefreshTimer: null,
  auditLastRefresh: null,
  readConversations: {}, // { [conversationKey]: lastAt visto pela última vez }
  conversationSummaries: [],
  conversationTotal: 0,
  conversationOffset: 0,
  conversationLoading: false,
  threadCache: {},
  threadLoading: false,
  contactNames: {},
  composerMode: 'text',
  auditStatsRange: 'all',
  auditLogOffset: 0,
  auditLogLimit: 50,
  auditLogTotal: 0,
  auditLogFilters: { status: '', phone: '' },
};

// ── Flow editor state ─────────────────────────────────────────────────────
let flowEditor = null;
let flowSelectedDfId = null;
let flowMoveTimer = null;
const flowUndoStack = [];
let flowUndoPointer = -1;
let flowUndoBusy = false;
let flowVersions = [];           // [{ts, label, snapshot}]  — até 10 versões

const FLOW_NODE_META = {
  identify: { color: '#3b82f6', icon: '🔍', label: 'Identificar',  inputs: 1, outputs: 3, outLabels: ['Aluno',    'Morador/Outros', 'Desconhecido'] },
  menu:     { color: '#10b981', icon: '📋', label: 'Menu',         inputs: 1, outputs: 1, outLabels: ['Botão 1'] },
  message:  { color: '#6b7280', icon: '💬', label: 'Mensagem',     inputs: 1, outputs: 1, outLabels: ['Próximo'] },
  api_call: { color: '#8b5cf6', icon: '🔌', label: 'API Call',     inputs: 1, outputs: 2, outLabels: ['Sucesso', 'Erro'] },
  condition:{ color: '#f59e0b', icon: '❓', label: 'Condição',     inputs: 1, outputs: 2, outLabels: ['Verdadeiro', 'Falso'] },
  transfer:   { color: '#ef4444', icon: '🧑‍💼', label: 'Suporte',     inputs: 1, outputs: 0, outLabels: [] },
  encaminhar: { color: '#0891b2', icon: '↗️',  label: 'Encaminhar',  inputs: 1, outputs: 1, outLabels: ['Próximo'] },
  horario:    { color: '#7c3aed', icon: '🕐',  label: 'Horário',     inputs: 1, outputs: 2, outLabels: ['No horário', 'Fora do horário'] },
  end:        { color: '#1e293b', icon: '🏁',  label: 'Fim',         inputs: 1, outputs: 0, outLabels: [] },
};

function flowNodeHtml(type, label) {
  const meta = FLOW_NODE_META[type] || FLOW_NODE_META.message;
  return `<div class="df-node-header" style="background:${meta.color}">${meta.icon} ${meta.label}</div><div class="df-node-body">${label || ''}</div>`;
}

function flowUpdateNodeLabel(dfId, label) {
  if (!flowEditor) return;
  const el = document.querySelector(`#node-${dfId} .df-node-body`);
  if (el) el.textContent = label || '';
}

function flowNodeOutputCount(nodeData) {
  const type = nodeData.type;
  if (type === 'menu') return Math.max(1, (nodeData.buttons || []).length);
  return (FLOW_NODE_META[type] || FLOW_NODE_META.message).outputs;
}

function initFlowEditor() {
  if (flowEditor) return;
  const el = document.getElementById('drawflow-canvas');
  if (!el || typeof Drawflow === 'undefined') return;
  flowEditor = new Drawflow(el);
  flowEditor.reroute = true;
  flowEditor.start();

  flowEditor.on('nodeSelected', (id) => { flowSelectedDfId = id; flowRenderProps(); });
  flowEditor.on('nodeUnselected', () => { flowSelectedDfId = null; flowRenderProps(); });
  flowEditor.on('nodeMoved', () => {
    clearTimeout(flowMoveTimer);
    flowMoveTimer = setTimeout(flowUndoPush, 600);
  });
  flowEditor.on('connectionCreated', (info) => { flowAutoWire(info); });
  flowEditor.on('connectionRemoved', (info) => { flowAutoUnwire(info); });

  // Load saved versions from localStorage
  flowVersionsLoad();

  // ── Keyboard shortcuts ──────────────────────────────────────────────────
  if (!document.getElementById('flow-kb-handler')) {
    const kbMarker = document.createElement('span');
    kbMarker.id = 'flow-kb-handler';
    kbMarker.style.display = 'none';
    document.body.appendChild(kbMarker);
    document.addEventListener('keydown', (e) => {
      if (!flowEditor) return;
      const inInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
      if (inInput) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); flowUndo(); }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { e.preventDefault(); flowRedo(); }
    });
  }

  // ── Inject toolbar buttons (undo/redo/versions/simular) ──────────────────
  const toolbarRight = document.querySelector('.flow-toolbar .ms-auto');
  if (toolbarRight && !document.getElementById('flow-sim-btn')) {
    // Undo
    const undoBtn = document.createElement('button');
    undoBtn.id = 'flow-undo-btn';
    undoBtn.className = 'btn btn-sm btn-outline-secondary';
    undoBtn.innerHTML = '↩';
    undoBtn.title = 'Desfazer (Ctrl+Z)';
    undoBtn.disabled = true;
    undoBtn.onclick = flowUndo;
    toolbarRight.insertBefore(undoBtn, toolbarRight.firstChild);

    // Redo
    const redoBtn = document.createElement('button');
    redoBtn.id = 'flow-redo-btn';
    redoBtn.className = 'btn btn-sm btn-outline-secondary';
    redoBtn.innerHTML = '↪';
    redoBtn.title = 'Refazer (Ctrl+Y)';
    redoBtn.disabled = true;
    redoBtn.onclick = flowRedo;
    toolbarRight.insertBefore(redoBtn, undoBtn.nextSibling);

    // Versions toggle
    const verBtn = document.createElement('button');
    verBtn.id = 'flow-ver-btn';
    verBtn.className = 'btn btn-sm btn-outline-secondary';
    verBtn.innerHTML = '📜';
    verBtn.title = 'Histórico de versões';
    verBtn.onclick = flowVersionsPanelToggle;
    toolbarRight.insertBefore(verBtn, redoBtn.nextSibling);

    // Simular
    const simBtn = document.createElement('button');
    simBtn.id = 'flow-sim-btn';
    simBtn.className = 'btn btn-sm btn-success';
    simBtn.innerHTML = '▶ Simular';
    simBtn.onclick = flowSimOpen;
    toolbarRight.insertBefore(simBtn, verBtn.nextSibling);

    // Live
    const liveBtn = document.createElement('button');
    liveBtn.id = 'flow-live-btn';
    liveBtn.className = 'btn btn-sm btn-danger';
    liveBtn.innerHTML = '🔴 Live';
    liveBtn.onclick = liveOpen;
    toolbarRight.insertBefore(liveBtn, simBtn.nextSibling);

    // Versions panel (injected below canvas)
    const canvas = document.getElementById('drawflow-canvas');
    if (canvas && !document.getElementById('flow-versions-panel')) {
      const vp = document.createElement('div');
      vp.id = 'flow-versions-panel';
      vp.style.cssText = 'display:none;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px;background:#fff;max-height:220px;overflow-y:auto';
      vp.innerHTML = '<div style="padding:6px 10px;font-size:12px;font-weight:700;border-bottom:1px solid #e2e8f0;background:#f8fafc">📜 Histórico de versões <span style="font-size:10px;font-weight:400;color:#94a3b8">(salvo localmente — últimas 10)</span></div><div id="flow-versions-list"></div>';
      canvas.parentNode.insertBefore(vp, canvas.nextSibling);
    }
  }
}

// ── Undo / Redo ───────────────────────────────────────────────────────────

function flowSnap() {
  if (!flowEditor) return null;
  return JSON.stringify(flowEditor.export());
}

function flowUndoPush() {
  if (flowUndoBusy) return;
  const snap = flowSnap();
  if (!snap) return;
  // Discard redos above pointer
  flowUndoStack.splice(flowUndoPointer + 1);
  flowUndoStack.push(snap);
  if (flowUndoStack.length > 30) flowUndoStack.shift();
  flowUndoPointer = flowUndoStack.length - 1;
  flowUpdateUndoButtons();
}

function flowUndoApply(snap) {
  if (!flowEditor || !snap) return;
  flowUndoBusy = true;
  try {
    const entry = document.getElementById('flow-entry-select')?.value || '';
    flowEditor.import(JSON.parse(snap));
    flowSelectedDfId = null;
    flowRenderProps();
    flowUpdateEntrySelect(entry);
  } finally {
    flowUndoBusy = false;
  }
}

function flowUndo() {
  if (flowUndoPointer <= 0) return;
  flowUndoPointer--;
  flowUndoApply(flowUndoStack[flowUndoPointer]);
  showMessage('Ação desfeita (Ctrl+Z)');
  flowUpdateUndoButtons();
}

function flowRedo() {
  if (flowUndoPointer >= flowUndoStack.length - 1) return;
  flowUndoPointer++;
  flowUndoApply(flowUndoStack[flowUndoPointer]);
  showMessage('Ação refeita (Ctrl+Y)');
  flowUpdateUndoButtons();
}

function flowUpdateUndoButtons() {
  const u = document.getElementById('flow-undo-btn');
  const r = document.getElementById('flow-redo-btn');
  if (u) u.disabled = flowUndoPointer <= 0;
  if (r) r.disabled = flowUndoPointer >= flowUndoStack.length - 1;
}

// ── Version history (servidor) ────────────────────────────────────────────

async function flowVersionsSave(label) {
  // Versão é salva automaticamente pelo servidor ao POST /admin/api/chatbot/flow
  // Esta função atualiza o painel se estiver aberto
  const panel = document.getElementById('flow-versions-panel');
  if (panel && panel.style.display !== 'none') await flowRenderVersionsList();
}

function flowVersionsLoad() {
  // Versões vêm do servidor — não há carregamento local
}

async function flowVersionRestore(versionId, label, createdAt) {
  if (!confirm(`Restaurar versão "${label}" de ${createdAt}?\nO fluxo atual será substituído (mas uma nova versão do estado atual será salva antes).`)) return;
  flowUndoPush();
  let resp;
  try {
    resp = await api(`/admin/api/chatbot/flow/versions/${versionId}/restore`, { method: 'POST' });
  } catch (e) {
    showMessage(`Erro ao restaurar: ${e.message}`, 'error');
    return;
  }
  const flow = resp.flow || {};
  if (flowEditor) {
    flowUndoBusy = true;
    try {
      flowEditor.clear();
      flowSelectedDfId = null;
      const dfIdMap = {};
      let xOffset = 80;
      for (const node of flow.nodes || []) {
        try {
          const numOut = Math.max(0, flowNodeOutputCount(node));
          const numIn = Math.max(1, (FLOW_NODE_META[node.type] || {}).inputs ?? 1);
          const dfId = flowEditor.addNode(node.type, numIn, numOut, node._pos_x ?? xOffset, node._pos_y ?? 80, node.type, { ...node }, flowNodeHtml(node.type, node.label || node.id));
          dfIdMap[node.id] = dfId;
        } catch {}
        xOffset += 240;
      }
      for (const node of flow.nodes || []) {
        const srcDf = dfIdMap[node.id];
        if (!srcDf) continue;
        for (const { outIdx, targetId } of flowExtractConnections(node)) {
          const dstDf = dfIdMap[targetId];
          if (dstDf) try { flowEditor.addConnection(srcDf, dstDf, `output_${outIdx}`, 'input_1'); } catch {}
        }
      }
      flowUpdateEntrySelect(flow.entry || '');
      flowRenderProps();
    } finally {
      flowUndoBusy = false;
    }
    flowUndoPush();
  }
  showMessage(`Versão "${label}" restaurada!`);
  await flowRenderVersionsList();
}

async function flowRenderVersionsList() {
  const el = document.getElementById('flow-versions-list');
  if (!el) return;
  el.innerHTML = '<p class="text-muted small mb-0 p-2">⏳ Carregando...</p>';
  let versions = [];
  try {
    const resp = await api('/admin/api/chatbot/flow/versions');
    versions = resp.data || [];
  } catch (e) {
    el.innerHTML = `<p class="text-danger small p-2">Erro ao carregar versões: ${e.message}</p>`;
    return;
  }
  if (!versions.length) {
    el.innerHTML = '<p class="text-muted small mb-0 p-2">Nenhuma versão salva ainda. Clique em "Salvar" para criar a primeira.</p>';
    return;
  }
  el.innerHTML = versions.map((v) => {
    const ts = v.created_at ? v.created_at.slice(0, 16).replace('T', ' ') : '';
    const by = v.created_by ? ` · ${v.created_by}` : '';
    return `<div class="d-flex justify-content-between align-items-center border-bottom py-2 px-2" style="font-size:12px">
      <span>
        <b>${escapeHtml(v.label)}</b>
        <br><span style="color:#94a3b8;font-size:10px">${ts}${by} · ${v.node_count} nós</span>
      </span>
      <button class="btn btn-xs btn-outline-primary py-0 px-2 ms-2" style="font-size:11px;white-space:nowrap"
        onclick="flowVersionRestore(${v.id}, ${JSON.stringify(escapeHtml(v.label))}, '${ts}')">↺ Restaurar</button>
    </div>`;
  }).join('');
}

async function flowVersionsPanelToggle() {
  const panel = document.getElementById('flow-versions-panel');
  if (!panel) return;
  const isHidden = panel.style.display === 'none' || !panel.style.display;
  panel.style.display = isHidden ? '' : 'none';
  if (isHidden) await flowRenderVersionsList();
}

// ── Auto-wire / Auto-unwire ───────────────────────────────────────────────

function flowAutoWire(info) {
  if (flowUndoBusy || !flowEditor) return;
  const dfData = flowEditor.export().drawflow.Home.data;
  const srcNode = dfData[info.output_id];
  if (!srcNode) return;
  const dstNode = dfData[info.input_id];
  if (!dstNode) return;
  const nd = { ...srcNode.data };
  const targetLogicalId = dstNode.data?.id || null;
  const outIdx = parseInt((info.output_class || 'output_1').replace('output_', ''), 10);

  if (nd.type === 'identify') {
    if (outIdx === 1) nd.next_aluno = targetLogicalId;
    else if (outIdx === 2) nd.next_morador = targetLogicalId;
    else if (outIdx === 3) nd.next_unknown = targetLogicalId;
  } else if (nd.type === 'menu') {
    const buttons = nd.buttons || [];
    if (buttons[outIdx - 1]) buttons[outIdx - 1].next = targetLogicalId;
    nd.buttons = buttons;
  } else if (nd.type === 'message') {
    nd.next = targetLogicalId;
  } else if (nd.type === 'api_call') {
    if (outIdx === 1) nd.next = targetLogicalId;
    else nd.on_error = targetLogicalId;
  } else if (nd.type === 'condition') {
    if (outIdx === 1) nd.next_true = targetLogicalId;
    else nd.next_false = targetLogicalId;
  } else if (nd.type === 'transfer') {
    nd.next = targetLogicalId;
  } else if (nd.type === 'encaminhar') {
    nd.next = targetLogicalId;
  } else if (nd.type === 'horario') {
    if (outIdx === 1) nd.next_inside = targetLogicalId;
    else nd.next_outside = targetLogicalId;
  }

  flowEditor.updateNodeDataFromId(info.output_id, nd);
  if (String(flowSelectedDfId) === String(info.output_id)) flowRenderProps();
  flowUndoPush();
}

function flowAutoUnwire(info) {
  if (flowUndoBusy || !flowEditor) return;
  const dfData = flowEditor.export().drawflow.Home.data;
  const srcNode = dfData[info.output_id];
  if (!srcNode) return;
  const nd = { ...srcNode.data };
  const outIdx = parseInt((info.output_class || 'output_1').replace('output_', ''), 10);

  if (nd.type === 'identify') {
    if (outIdx === 1) nd.next_aluno = null;
    else if (outIdx === 2) nd.next_morador = null;
    else if (outIdx === 3) nd.next_unknown = null;
  } else if (nd.type === 'menu') {
    const buttons = nd.buttons || [];
    if (buttons[outIdx - 1]) buttons[outIdx - 1].next = null;
    nd.buttons = buttons;
  } else if (nd.type === 'message') {
    nd.next = null;
  } else if (nd.type === 'api_call') {
    if (outIdx === 1) nd.next = null;
    else nd.on_error = null;
  } else if (nd.type === 'condition') {
    if (outIdx === 1) nd.next_true = null;
    else nd.next_false = null;
  } else if (nd.type === 'transfer') {
    nd.next = null;
  } else if (nd.type === 'encaminhar') {
    nd.next = null;
  } else if (nd.type === 'horario') {
    if (outIdx === 1) nd.next_inside = null;
    else nd.next_outside = null;
  }

  flowEditor.updateNodeDataFromId(info.output_id, nd);
  if (String(flowSelectedDfId) === String(info.output_id)) flowRenderProps();
  flowUndoPush();
  showMessage('Conexão removida — Ctrl+Z para desfazer');
}

// ── Duplicate node ────────────────────────────────────────────────────────

function flowDuplicateSelected() {
  if (!flowSelectedDfId || !flowEditor) return;
  const dfData = flowEditor.export().drawflow.Home.data;
  const src = dfData[flowSelectedDfId];
  if (!src) return;
  const nd = JSON.parse(JSON.stringify(src.data));
  nd.id = nd.id ? nd.id + '_copia' : `copia_${Date.now()}`;
  nd.label = nd.label ? nd.label + ' (cópia)' : nd.id;
  // Clear connections in copy
  ['next', 'on_error', 'next_aluno', 'next_morador', 'next_unknown', 'next_true', 'next_false'].forEach((k) => { if (nd[k]) nd[k] = null; });
  if (nd.buttons) nd.buttons = nd.buttons.map((b) => ({ ...b, next: null }));
  const meta = FLOW_NODE_META[nd.type] || FLOW_NODE_META.message;
  const numOut = nd.type === 'menu' ? Math.max(1, (nd.buttons || []).length) : meta.outputs;
  const newDfId = flowEditor.addNode(nd.type, meta.inputs, numOut, src.pos_x + 40, src.pos_y + 80, nd.type, nd, flowNodeHtml(nd.type, nd.label));
  flowSelectedDfId = newDfId;
  flowRenderProps();
  flowUpdateEntrySelect(document.getElementById('flow-entry-select')?.value || '');
  flowUndoPush();
  showMessage(`Nó duplicado: "${nd.id}"`);
}

function flowGetAllNodes() {
  if (!flowEditor) return [];
  const data = flowEditor.export().drawflow.Home.data;
  return Object.values(data || {});
}

function flowNodeIdToLabel(dfId) {
  if (!flowEditor) return '';
  const data = flowEditor.export().drawflow.Home.data;
  const n = data[dfId];
  return n ? (n.data.label || n.data.id || String(dfId)) : String(dfId);
}

function flowGetDfId(logicalId) {
  if (!flowEditor) return null;
  const data = flowEditor.export().drawflow.Home.data;
  for (const [dfId, n] of Object.entries(data)) {
    if (n.data.id === logicalId) return Number(dfId);
  }
  return null;
}

async function loadChatbotFlow() {
  if (typeof Drawflow === 'undefined') {
    showMessage('Biblioteca Drawflow não carregada — verifique a conexão com a internet e recarregue a página.', 'error');
    return;
  }
  initFlowEditor();
  if (!flowEditor) {
    showMessage('Não foi possível inicializar o editor de fluxo. Recarregue a página.', 'error');
    return;
  }

  let resp;
  try {
    resp = await api('/admin/api/chatbot/flow');
  } catch (e) {
    console.error('loadChatbotFlow api error:', e);
    throw e;
  }

  const flow = resp.data || {};
  flowEditor.clear();
  flowSelectedDfId = null;
  flowRenderProps();
  // Reset undo stack on fresh load
  flowUndoStack.length = 0;
  flowUndoPointer = -1;
  flowUpdateUndoButtons();

  if (!flow.nodes || !flow.nodes.length) {
    flowUpdateEntrySelect('');
    return;
  }

  const dfIdMap = {};
  let xOffset = 80;
  let loaded = 0;

  for (const node of flow.nodes) {
    try {
      const numOut = Math.max(0, flowNodeOutputCount(node));
      const numIn = Math.max(1, (FLOW_NODE_META[node.type] || {}).inputs ?? 1);
      const dfId = flowEditor.addNode(
        node.type, numIn, numOut,
        node._pos_x ?? xOffset, node._pos_y ?? 80,
        node.type, { ...node },
        flowNodeHtml(node.type, node.label || node.id)
      );
      dfIdMap[node.id] = dfId;
      loaded++;
    } catch (e) {
      console.error('loadChatbotFlow: falha ao adicionar nó', node.id, node.type, e);
    }
    xOffset += 240;
  }

  for (const node of flow.nodes) {
    const srcDf = dfIdMap[node.id];
    if (!srcDf) continue;
    const conns = flowExtractConnections(node);
    for (const { outIdx, targetId } of conns) {
      const dstDf = dfIdMap[targetId];
      if (dstDf) {
        try { flowEditor.addConnection(srcDf, dstDf, `output_${outIdx}`, 'input_1'); } catch (e) {
          console.error('loadChatbotFlow: falha na conexão', node.id, '->', targetId, 'out', outIdx, e);
        }
      }
    }
  }

  flowUpdateEntrySelect(flow.entry || '');

  if (loaded === 0) {
    showMessage(`Nenhum nó carregado (${flow.nodes.length} no DB). Verifique o console do navegador (F12).`, 'error');
  } else if (loaded < flow.nodes.length) {
    console.warn(`loadChatbotFlow: ${loaded}/${flow.nodes.length} nós carregados`);
  } else {
    console.log(`loadChatbotFlow: ${loaded} nós carregados OK`);
  }
  // Push initial snapshot so Ctrl+Z can restore loaded state
  flowUndoPush();
}

function flowExtractConnections(node) {
  const result = [];
  const push = (outIdx, targetId) => { if (targetId) result.push({ outIdx, targetId }); };
  switch (node.type) {
    case 'identify':
      push(1, node.next_aluno || node.next_known);
      push(2, node.next_morador || node.next_known);
      push(3, node.next_unknown);
      break;
    case 'menu':
      (node.buttons || []).forEach((b, i) => push(i + 1, b.next));
      break;
    case 'message':
      push(1, node.next);
      break;
    case 'api_call':
      push(1, node.next);
      push(2, node.on_error);
      break;
    case 'condition':
      push(1, node.next_true);
      push(2, node.next_false);
      break;
    case 'transfer':
      push(1, node.next);
      break;
    case 'encaminhar':
      push(1, node.next);
      break;
    case 'horario':
      push(1, node.next_inside);
      push(2, node.next_outside);
      break;
  }
  return result.filter((c) => c.targetId);
}

function flowUpdateEntrySelect(currentEntry) {
  const sel = document.getElementById('flow-entry-select');
  if (!sel) return;
  const nodes = flowGetAllNodes();
  sel.innerHTML = '<option value="">-- selecionar nó inicial --</option>' +
    nodes.map((n) => `<option value="${n.data.id || n.id}"${(n.data.id || '') === currentEntry ? ' selected' : ''}>${n.data.label || n.data.id || n.id}</option>`).join('');
}

function flowRenderProps() {
  const titleEl = document.getElementById('flow-props-title');
  const bodyEl = document.getElementById('flow-props-body');
  const footerEl = document.getElementById('flow-props-footer');
  const deleteBtn = document.getElementById('flow-delete-node-btn');
  if (!bodyEl) return;

  if (!flowSelectedDfId) {
    if (titleEl) titleEl.textContent = 'Propriedades';
    bodyEl.innerHTML = '<p class="text-muted small mt-3">Clique em um nó no canvas para editar suas propriedades.</p>';
    if (footerEl) footerEl.style.display = 'none';
    if (deleteBtn) deleteBtn.style.display = 'none';
    return;
  }

  const dfData = flowEditor.export().drawflow.Home.data;
  const dfNode = dfData[flowSelectedDfId];
  if (!dfNode) return;

  const nd = dfNode.data;
  const type = nd.type || 'message';
  const meta = FLOW_NODE_META[type] || FLOW_NODE_META.message;
  if (titleEl) titleEl.innerHTML = `<span style="color:${meta.color}">${meta.icon} ${meta.label}</span>`;
  if (deleteBtn) deleteBtn.style.display = '';

  const allNodes = flowGetAllNodes();
  const nodeOpts = (includeNull) =>
    (includeNull ? '<option value="">— nenhum (encerrar) —</option>' : '') +
    allNodes.filter((n) => (n.data.id || '') !== nd.id)
      .map((n) => `<option value="${n.data.id || ''}">${n.data.label || n.data.id || ''}</option>`).join('');

  let html = `<div class="mb-2"><label class="form-label small fw-semibold">ID do nó</label>
    <input id="fp_id" class="form-control form-control-sm" value="${nd.id || ''}"></div>
    <div class="mb-3"><label class="form-label small fw-semibold">Rótulo (exibido no canvas)</label>
    <input id="fp_label" class="form-control form-control-sm" value="${nd.label || ''}"></div>`;

  if (type === 'identify') {
    html += `<div class="mb-2"><label class="form-label small fw-semibold">🎓 Próximo: Aluno</label>
      <select id="fp_next_aluno" class="form-select form-select-sm">${nodeOpts(true)}</select></div>
      <div class="mb-2"><label class="form-label small fw-semibold">🏠 Próximo: Morador/Outros</label>
      <select id="fp_next_morador" class="form-select form-select-sm">${nodeOpts(true)}</select></div>
      <div class="mb-2"><label class="form-label small fw-semibold">❓ Próximo: Desconhecido</label>
      <select id="fp_next_unknown" class="form-select form-select-sm">${nodeOpts(true)}</select></div>`;
  } else if (type === 'menu') {
    const buttons = nd.buttons || [];
    html += `<div class="mb-2"><label class="form-label small fw-semibold">Texto do menu</label>
      <textarea id="fp_body" class="form-control form-control-sm" rows="3">${nd.body || ''}</textarea></div>
      <div class="mb-1"><label class="form-label small fw-semibold">Botões <button type="button" class="btn btn-xs btn-outline-secondary ms-2 py-0 px-2" style="font-size:11px" onclick="flowAddButton()">+ botão</button></label></div>
      <div id="fp_buttons_list">`;
    buttons.forEach((b, i) => {
      html += `<div class="flow-btn-row" id="fp_btn_${i}">
        <button type="button" class="flow-btn-del" onclick="flowRemoveButton(${i})" title="Remover botão">✕</button>
        <div class="fp-btn-label">ID do botão</div>
        <input placeholder="ex: btn_qr" value="${b.id || ''}" class="fp-btn-id">
        <div class="fp-btn-label">Texto exibido no WhatsApp</div>
        <input placeholder="ex: 🎫 Receber QR Code" value="${b.title || ''}" class="fp-btn-title">
        <div class="fp-btn-label">Próximo nó ao clicar</div>
        <select class="fp-btn-next">
          ${nodeOpts(true).replace(`value="${b.next || ''}"`, `value="${b.next || ''}" selected`)}
        </select>
      </div>`;
    });
    html += `</div>`;
  } else if (type === 'message') {
    html += `<div class="mb-2"><label class="form-label small fw-semibold">Texto da mensagem</label>
      <textarea id="fp_text" class="form-control form-control-sm" rows="4">${nd.text || ''}</textarea></div>
      <div class="mb-2"><label class="form-label small fw-semibold">Próximo nó</label>
      <select id="fp_next" class="form-select form-select-sm">${nodeOpts(true)}</select></div>`;
  } else if (type === 'api_call') {
    html += `<div class="mb-2"><label class="form-label small fw-semibold">Método</label>
      <select id="fp_method" class="form-select form-select-sm">
        ${['GET','POST','PUT','PATCH','DELETE'].map((m) => `<option${m === (nd.method || 'POST') ? ' selected' : ''}>${m}</option>`).join('')}
      </select></div>
      <div class="mb-2"><label class="form-label small fw-semibold">URL</label>
      <input id="fp_url" class="form-control form-control-sm" value="${nd.url || ''}" placeholder="{{porteiro_url}}/api/v1/..."></div>
      <div class="mb-2"><label class="form-label small fw-semibold">Headers (JSON)</label>
      <textarea id="fp_headers" class="form-control form-control-sm" rows="2" placeholder='{"Authorization":"Bearer {{porteiro_token}}"}' style="font-size:11px;font-family:monospace">${typeof nd.headers === 'object' ? JSON.stringify(nd.headers) : (nd.headers || '')}</textarea></div>
      <div class="mb-2"><label class="form-label small fw-semibold">Body (JSON)</label>
      <textarea id="fp_body_json" class="form-control form-control-sm" rows="2" placeholder='{"phone":"{{phone}}"}' style="font-size:11px;font-family:monospace">${typeof nd.body === 'object' ? JSON.stringify(nd.body) : (nd.body || '')}</textarea></div>
      <div class="mb-2"><label class="form-label small fw-semibold">Campo da resposta (response_path)</label>
      <input id="fp_response_path" class="form-control form-control-sm" value="${nd.response_path || ''}" placeholder="sent"></div>
      <div class="mb-2"><label class="form-label small fw-semibold">Salvar em (store_as)</label>
      <input id="fp_store_as" class="form-control form-control-sm" value="${nd.store_as || ''}"></div>
      <div class="mb-2"><label class="form-label small fw-semibold">Próximo (sucesso)</label>
      <select id="fp_next" class="form-select form-select-sm">${nodeOpts(true)}</select></div>
      <div class="mb-2"><label class="form-label small fw-semibold">Próximo (erro)</label>
      <select id="fp_on_error" class="form-select form-select-sm">${nodeOpts(true)}</select></div>`;
  } else if (type === 'condition') {
    html += `<div class="mb-2"><label class="form-label small fw-semibold">Variável (session.*)</label>
      <input id="fp_variable" class="form-control form-control-sm" value="${nd.variable || ''}" placeholder="qr_sent"></div>
      <div class="mb-2"><label class="form-label small fw-semibold">Igual a</label>
      <input id="fp_equals" class="form-control form-control-sm" value="${nd.equals ?? ''}"></div>
      <div class="mb-2"><label class="form-label small fw-semibold">Se verdadeiro</label>
      <select id="fp_next_true" class="form-select form-select-sm">${nodeOpts(true)}</select></div>
      <div class="mb-2"><label class="form-label small fw-semibold">Se falso</label>
      <select id="fp_next_false" class="form-select form-select-sm">${nodeOpts(true)}</select></div>`;
  } else if (type === 'transfer') {
    html += `<div class="mb-2"><label class="form-label small fw-semibold">Mensagem ao usuário</label>
      <textarea id="fp_message" class="form-control form-control-sm" rows="3">${nd.message || ''}</textarea></div>`;
  } else if (type === 'encaminhar') {
    html += `<div class="mb-2"><label class="form-label small fw-semibold">Destino</label>
      <select id="fp_destination" class="form-select form-select-sm" onchange="document.getElementById('fp_custom_phone_row').style.display=this.value==='custom_phone'?'':'none'">
        <option value="support" ${nd.destination !== 'custom_phone' ? 'selected' : ''}>🧑‍💼 Suporte (números configurados nas settings)</option>
        <option value="custom_phone" ${nd.destination === 'custom_phone' ? 'selected' : ''}>📱 Número específico</option>
      </select></div>
      <div class="mb-2" id="fp_custom_phone_row" style="display:${nd.destination === 'custom_phone' ? '' : 'none'}">
        <label class="form-label small fw-semibold">Número (com DDI, ex: 5542999991234)</label>
        <input id="fp_custom_phone" class="form-control form-control-sm" value="${escapeHtml(nd.custom_phone || '')}" placeholder="5542999991234">
      </div>
      <div class="mb-2"><label class="form-label small fw-semibold">Mensagem ao usuário <span style="color:#9ca3af">(antes de encaminhar)</span></label>
        <textarea id="fp_message_user" class="form-control form-control-sm" rows="2" placeholder="Aguarde, vou encaminhar seu atendimento...">${escapeHtml(nd.message_user || '')}</textarea></div>
      <div class="mb-2"><label class="form-label small fw-semibold">Mensagem ao agente <span style="color:#9ca3af">(o que o suporte/número recebe)</span></label>
        <textarea id="fp_message_agent" class="form-control form-control-sm" rows="3" placeholder="{{person_name}} ({{phone}}) solicitou atendimento">${escapeHtml(nd.message_agent || '')}</textarea></div>
      <div class="mb-2"><label class="form-label small fw-semibold">Próximo nó <span style="color:#9ca3af">(para "número específico" o fluxo pode continuar)</span></label>
        <select id="fp_next" class="form-select form-select-sm">${nodeOpts(true)}</select></div>`;
  } else if (type === 'horario') {
    html += `<div class="mb-2"><label class="form-label small fw-semibold">Período de atendimento</label>
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:4px">
        <span style="font-size:12px;color:#6b7280;width:32px">De</span>
        <input id="fp_hour_from" type="number" min="0" max="23" class="form-control form-control-sm" value="${nd.hour_from ?? 8}" style="width:68px" placeholder="8">
        <span style="color:#9ca3af">h</span>
        <input id="fp_min_from" type="number" min="0" max="59" class="form-control form-control-sm" value="${nd.min_from ?? 0}" style="width:68px" placeholder="0">
        <span style="color:#9ca3af">min</span>
      </div>
      <div style="display:flex;gap:6px;align-items:center">
        <span style="font-size:12px;color:#6b7280;width:32px">Até</span>
        <input id="fp_hour_to" type="number" min="0" max="23" class="form-control form-control-sm" value="${nd.hour_to ?? 18}" style="width:68px" placeholder="18">
        <span style="color:#9ca3af">h</span>
        <input id="fp_min_to" type="number" min="0" max="59" class="form-control form-control-sm" value="${nd.min_to ?? 0}" style="width:68px" placeholder="0">
        <span style="color:#9ca3af">min</span>
      </div>
      <div class="secret-hint mt-1">Formato 24h. Para horário noturno (ex: 22h–06h) basta inverter De/Até.</div>
    </div>
    <div class="mb-2"><label class="form-label small fw-semibold">Mensagem fora do horário <span style="color:#9ca3af">(opcional)</span></label>
      <textarea id="fp_message_outside" class="form-control form-control-sm" rows="2" placeholder="Nosso atendimento é das 08h às 18h. Retornaremos em breve!">${escapeHtml(nd.message_outside || '')}</textarea></div>
    <div class="mb-2"><label class="form-label small fw-semibold">✅ No horário → próximo nó</label>
      <select id="fp_next_inside" class="form-select form-select-sm">${nodeOpts()}</select></div>
    <div class="mb-2"><label class="form-label small fw-semibold">🔴 Fora do horário → próximo nó</label>
      <select id="fp_next_outside" class="form-select form-select-sm">${nodeOpts(true)}</select></div>`;
  } else if (type === 'end') {
    html += `<div class="mb-2"><label class="form-label small fw-semibold">Mensagem de despedida</label>
      <textarea id="fp_farewell" class="form-control form-control-sm" rows="3">${nd.farewell || ''}</textarea></div>`;
  }

  html += `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;margin-top:12px;font-size:11px">
    <div style="font-weight:700;color:#374151;margin-bottom:6px">📎 Variáveis disponíveis</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:3px 8px">
      <span><code style="background:#e0f2fe;color:#0369a1;padding:1px 5px;border-radius:4px">{{person_name}}</code> <span style="color:#6b7280">Nome da pessoa</span></span>
      <span><code style="background:#e0f2fe;color:#0369a1;padding:1px 5px;border-radius:4px">{{phone}}</code> <span style="color:#6b7280">Número do WhatsApp</span></span>
      <span><code style="background:#d1fae5;color:#065f46;padding:1px 5px;border-radius:4px">{{saudacao}}</code> <span style="color:#6b7280">Bom dia / Boa tarde / Boa noite</span></span>
      <span><code style="background:#d1fae5;color:#065f46;padding:1px 5px;border-radius:4px">{{saudacao_despedida}}</code> <span style="color:#6b7280">um Bom dia / uma Boa tarde…</span></span>
      <span><code style="background:#e0f2fe;color:#0369a1;padding:1px 5px;border-radius:4px">{{person_type}}</code> <span style="color:#6b7280">aluno / morador / unknown</span></span>
      <span><code style="background:#fce7f3;color:#9d174d;padding:1px 5px;border-radius:4px">{{unknown_message}}</code> <span style="color:#6b7280">Msg para desconhecidos</span></span>
      <span><code style="background:#fce7f3;color:#9d174d;padding:1px 5px;border-radius:4px">{{porteiro_url}}</code> <span style="color:#6b7280">URL do api-porteiro</span></span>
      <span><code style="background:#fce7f3;color:#9d174d;padding:1px 5px;border-radius:4px">{{porteiro_token}}</code> <span style="color:#6b7280">Token do api-porteiro</span></span>
      <span><code style="background:#fce7f3;color:#9d174d;padding:1px 5px;border-radius:4px">{{relay_device_id}}</code> <span style="color:#6b7280">ID do dispositivo</span></span>
      <span><code style="background:#fce7f3;color:#9d174d;padding:1px 5px;border-radius:4px">{{relay_door_num}}</code> <span style="color:#6b7280">Número do relay</span></span>
      <span><code style="background:#fce7f3;color:#9d174d;padding:1px 5px;border-radius:4px">{{relay_delay}}</code> <span style="color:#6b7280">Delay do relay (s)</span></span>
      <span><code style="background:#ede9fe;color:#5b21b6;padding:1px 5px;border-radius:4px">{{session.varname}}</code> <span style="color:#6b7280">Variável da sessão (API Call → store_as)</span></span>
    </div>
  </div>`;
  bodyEl.innerHTML = html;

  // Preencher selects com valor atual
  const setS = (id, val) => { const el = document.getElementById(id); if (el && val !== undefined) el.value = val || ''; };
  setS('fp_next', nd.next); setS('fp_on_error', nd.on_error);
  setS('fp_next_aluno', nd.next_aluno || nd.next_known);
  setS('fp_next_morador', nd.next_morador || nd.next_known);
  setS('fp_next_unknown', nd.next_unknown);
  setS('fp_next_true', nd.next_true); setS('fp_next_false', nd.next_false);
  setS('fp_next_inside', nd.next_inside); setS('fp_next_outside', nd.next_outside);

  if (footerEl) {
    footerEl.style.display = '';
    // Ensure duplicate button exists in footer
    if (!document.getElementById('flow-duplicate-btn')) {
      const dupBtn = document.createElement('button');
      dupBtn.id = 'flow-duplicate-btn';
      dupBtn.className = 'btn btn-sm btn-outline-secondary w-100 mt-2';
      dupBtn.innerHTML = '⧉ Duplicar este nó';
      dupBtn.onclick = flowDuplicateSelected;
      footerEl.appendChild(dupBtn);
    }
  }
  flowUpdateEntrySelect(document.getElementById('flow-entry-select')?.value || '');
}

function flowSyncConnections(dfId, nd) {
  if (!flowEditor) return;
  const dfData = flowEditor.export().drawflow.Home.data;
  const dfNode = dfData[dfId];
  if (!dfNode) return;

  // Reverse map: nodeId string → numeric Drawflow id
  const dfIdByNodeId = {};
  for (const [id, n] of Object.entries(dfData)) {
    if (n.data?.id) dfIdByNodeId[n.data.id] = parseInt(id);
  }

  // Remove all existing OUTPUT connections from this node
  for (const [outputKey, outputData] of Object.entries(dfNode.outputs || {})) {
    for (const conn of [...(outputData.connections || [])]) {
      try { flowEditor.removeSingleConnection(parseInt(dfId), parseInt(conn.node), outputKey, 'input_1'); } catch {}
    }
  }

  // Re-draw connections from updated node data
  for (const { outIdx, targetId } of flowExtractConnections(nd)) {
    const dstDfId = dfIdByNodeId[targetId];
    if (dstDfId && dstDfId !== parseInt(dfId)) {
      try { flowEditor.addConnection(parseInt(dfId), dstDfId, `output_${outIdx}`, 'input_1'); } catch {}
    }
  }
}

function flowApplyProps() {
  if (!flowSelectedDfId || !flowEditor) return;
  const dfData = flowEditor.export().drawflow.Home.data;
  const dfNode = dfData[flowSelectedDfId];
  if (!dfNode) return;

  const nd = { ...dfNode.data };
  const gv = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : undefined; };

  nd.id = gv('fp_id') || nd.id;
  nd.label = gv('fp_label') || '';

  const type = nd.type;
  if (type === 'identify') {
    nd.next_aluno = gv('fp_next_aluno') || null;
    nd.next_morador = gv('fp_next_morador') || null;
    nd.next_unknown = gv('fp_next_unknown') || null;
  } else if (type === 'menu') {
    nd.body = gv('fp_body') || '';
    const btnRows = document.querySelectorAll('#fp_buttons_list .flow-btn-row');
    nd.buttons = Array.from(btnRows).map((row) => ({
      id: row.querySelector('.fp-btn-id')?.value.trim() || '',
      title: row.querySelector('.fp-btn-title')?.value.trim() || '',
      next: row.querySelector('.fp-btn-next')?.value || null,
    })).filter((b) => b.id);
  } else if (type === 'message') {
    nd.text = gv('fp_text') || '';
    nd.next = gv('fp_next') || null;
  } else if (type === 'api_call') {
    nd.method = gv('fp_method') || 'POST';
    nd.url = gv('fp_url') || '';
    try { nd.headers = JSON.parse(gv('fp_headers') || '{}'); } catch { nd.headers = {}; }
    try { nd.body = JSON.parse(gv('fp_body_json') || '{}'); } catch { nd.body = {}; }
    nd.response_path = gv('fp_response_path') || '';
    nd.store_as = gv('fp_store_as') || '';
    nd.next = gv('fp_next') || null;
    nd.on_error = gv('fp_on_error') || null;
  } else if (type === 'condition') {
    nd.variable = gv('fp_variable') || '';
    nd.equals = gv('fp_equals') ?? '';
    nd.next_true = gv('fp_next_true') || null;
    nd.next_false = gv('fp_next_false') || null;
  } else if (type === 'transfer') {
    nd.message = gv('fp_message') || '';
  } else if (type === 'encaminhar') {
    nd.destination = gv('fp_destination') || 'support';
    nd.custom_phone = gv('fp_custom_phone') || '';
    nd.message_user = gv('fp_message_user') || '';
    nd.message_agent = gv('fp_message_agent') || '';
    nd.next = gv('fp_next') || null;
  } else if (type === 'horario') {
    nd.hour_from = parseInt(gv('fp_hour_from') ?? 8);
    nd.min_from  = parseInt(gv('fp_min_from') ?? 0);
    nd.hour_to   = parseInt(gv('fp_hour_to') ?? 18);
    nd.min_to    = parseInt(gv('fp_min_to') ?? 0);
    nd.message_outside = gv('fp_message_outside') || '';
    nd.next_inside  = gv('fp_next_inside') || null;
    nd.next_outside = gv('fp_next_outside') || null;
  } else if (type === 'end') {
    nd.farewell = gv('fp_farewell') || '';
  }

  // Atualizar número de outputs para menu (muda com adição de botões)
  if (type === 'menu') {
    const newOut = Math.max(1, (nd.buttons || []).length);
    const curOut = Object.keys(dfNode.outputs || {}).length;
    if (newOut !== curOut) {
      // Recriar nó com novo número de outputs
      const pos_x = dfNode.pos_x;
      const pos_y = dfNode.pos_y;
      flowEditor.removeNodeId(`node-${flowSelectedDfId}`);
      const newDfId = flowEditor.addNode(type, 1, newOut, pos_x, pos_y, type, nd, flowNodeHtml(type, nd.label));
      flowSelectedDfId = newDfId;
      flowSyncConnections(newDfId, nd);
      flowRenderProps();
      flowUpdateEntrySelect(document.getElementById('flow-entry-select')?.value || '');
      return;
    }
  }

  flowEditor.updateNodeDataFromId(flowSelectedDfId, nd);
  flowUpdateNodeLabel(flowSelectedDfId, nd.label);
  flowSyncConnections(flowSelectedDfId, nd);
  flowUpdateEntrySelect(document.getElementById('flow-entry-select')?.value || '');
  flowUndoPush();
  showMessage('Propriedades aplicadas!');
}

function flowAddButton() {
  const list = document.getElementById('fp_buttons_list');
  if (!list) return;
  const i = list.querySelectorAll('.flow-btn-row').length;
  const dfData = flowEditor?.export().drawflow.Home.data;
  const allNodes = dfData ? Object.values(dfData) : [];
  const nodeOpts = '<option value="">— encerrar —</option>' +
    allNodes.map((n) => `<option value="${n.data.id || ''}">${n.data.label || n.data.id || ''}</option>`).join('');
  const row = document.createElement('div');
  row.className = 'flow-btn-row';
  row.id = `fp_btn_${i}`;
  row.innerHTML = `<button type="button" class="flow-btn-del" onclick="flowRemoveButton(${i})" title="Remover botão">✕</button>
    <div class="fp-btn-label">ID do botão</div>
    <input placeholder="ex: btn_${i + 1}" value="btn_${i + 1}" class="fp-btn-id">
    <div class="fp-btn-label">Texto exibido no WhatsApp</div>
    <input placeholder="ex: 🎫 Receber QR Code" value="" class="fp-btn-title">
    <div class="fp-btn-label">Próximo nó ao clicar</div>
    <select class="fp-btn-next">${nodeOpts}</select>`;
  list.appendChild(row);
}

function flowRemoveButton(idx) {
  const row = document.getElementById(`fp_btn_${idx}`);
  if (row) row.remove();
}

let _flowNodeCounter = 0;
function flowAddNode(type) {
  initFlowEditor();
  if (!flowEditor) return;
  _flowNodeCounter++;
  const meta = FLOW_NODE_META[type] || FLOW_NODE_META.message;
  const id = `node_${type}_${_flowNodeCounter}`;
  const label = `${meta.label} ${_flowNodeCounter}`;
  const numOut = meta.outputs;
  const x = 100 + (_flowNodeCounter % 5) * 220;
  const y = 80 + Math.floor(_flowNodeCounter / 5) * 160;
  const NODE_DEFAULTS = {
    horario:    { hour_from: 8, min_from: 0, hour_to: 18, min_to: 0, message_outside: '' },
    encaminhar: { destination: 'support', message_user: '', message_agent: '' },
    menu:       { body: '', buttons: [{ id: 'btn_1', title: 'Opção 1', next: null }] },
    message:    { text: '' },
    api_call:   { method: 'POST', url: '', headers: {}, body: {} },
    condition:  { variable: '', equals: '' },
    transfer:   { message: '' },
    end:        { farewell: '' },
    identify:   {},
  };
  const dfId = flowEditor.addNode(type, meta.inputs, numOut, x, y, type, { id, label, type, ...(NODE_DEFAULTS[type] || {}) }, flowNodeHtml(type, label));
  flowSelectedDfId = dfId;
  flowRenderProps();
  flowUpdateEntrySelect(document.getElementById('flow-entry-select')?.value || '');
  flowUndoPush();
}

function flowDeleteSelectedNode() {
  if (!flowSelectedDfId || !flowEditor) return;
  if (!confirm('Excluir este nó? As conexões a ele serão removidas.')) return;
  flowUndoPush();
  flowEditor.removeNodeId(`node-${flowSelectedDfId}`);
  flowSelectedDfId = null;
  flowRenderProps();
  flowUpdateEntrySelect(document.getElementById('flow-entry-select')?.value || '');
}

async function onSaveChatbotFlow() {
  if (!flowEditor) return;
  flowApplyProps();
  const dfData = flowEditor.export().drawflow.Home.data;
  const entry = document.getElementById('flow-entry-select')?.value || '';
  const nodes = Object.values(dfData || {}).map((dfNode) => {
    const nd = { ...dfNode.data, _pos_x: Math.round(dfNode.pos_x), _pos_y: Math.round(dfNode.pos_y) };
    // Preencher campos next/* a partir das conexões de saída do Drawflow
    const outputs = dfNode.outputs || {};
    const allData = dfData;
    const getTargetId = (outKey) => {
      const conns = outputs[outKey]?.connections || [];
      if (!conns.length) return null;
      const targetDfId = conns[0].node;
      return allData[targetDfId]?.data?.id || null;
    };
    const type = nd.type;
    if (type === 'identify') {
      nd.next_aluno = getTargetId('output_1');
      nd.next_morador = getTargetId('output_2');
      nd.next_unknown = getTargetId('output_3');
      delete nd.next_known;
    } else if (type === 'menu') {
      (nd.buttons || []).forEach((b, i) => { b.next = getTargetId(`output_${i + 1}`); });
    } else if (type === 'message') {
      nd.next = getTargetId('output_1');
    } else if (type === 'api_call') {
      nd.next = getTargetId('output_1');
      nd.on_error = getTargetId('output_2');
    } else if (type === 'condition') {
      nd.next_true = getTargetId('output_1');
      nd.next_false = getTargetId('output_2');
    } else if (type === 'transfer') {
      nd.next = getTargetId('output_1');
    }
    return nd;
  });
  await api('/admin/api/chatbot/flow', { method: 'POST', body: JSON.stringify({ flow: { entry, nodes } }) });
  showMessage('Fluxo salvo com sucesso!');
  flowVersionsSave();
}

function flowClear() {
  if (!confirm('Limpar todo o fluxo? O chatbot voltará ao modo embutido (aluno/morador).')) return;
  if (flowEditor) flowEditor.clear();
  flowSelectedDfId = null;
  flowRenderProps();
  flowUpdateEntrySelect('');
  runAction(() => api('/admin/api/chatbot/flow', { method: 'POST', body: JSON.stringify({ flow: { entry: '', nodes: [] } }) })
    .then(() => showMessage('Fluxo limpo. Modo embutido ativo.')));
}

function flowLoadDefault() {
  initFlowEditor();
  if (!flowEditor) return;
  if (!confirm('Carregar o fluxo padrão? O canvas atual será substituído.')) return;
  flowEditor.clear();
  flowSelectedDfId = null;

  const defaultNodes = [
    { id:'start',         label:'Identificar usuário', type:'identify',  next_aluno:'menu_aluno', next_morador:'menu_morador', next_unknown:'msg_desconhecido', _pos_x:60,  _pos_y:200 },
    { id:'menu_aluno',    label:'Menu Aluno',           type:'menu',      body:'Olá, {{person_name}}! Sou o assistente da portaria. Como posso ajudar?', buttons:[{id:'btn_qr',title:'🎫 Receber QR Code',next:'enviar_qr'},{id:'btn_hora',title:'📅 Meus horários',next:'ver_horarios'},{id:'btn_ajuda',title:'🆘 Preciso de ajuda',next:'suporte'}], _pos_x:340, _pos_y:60 },
    { id:'menu_morador',  label:'Menu Morador',         type:'menu',      body:'Olá, {{person_name}}! Como posso ajudar?', buttons:[{id:'btn_portao',title:'🚪 Abrir portão',next:'abrir_portao'},{id:'btn_qr2',title:'🎫 Receber QR Code',next:'enviar_qr'}], _pos_x:340, _pos_y:320 },
    { id:'msg_desconhecido',label:'Desconhecido',       type:'message',   text:'{{unknown_message}}', next:null, _pos_x:340, _pos_y:500 },
    { id:'enviar_qr',     label:'Enviar QR Code',       type:'api_call',  method:'POST', url:'{{porteiro_url}}/api/v1/chatbot/send-qr', headers:{Authorization:'Bearer {{porteiro_token}}'}, body:{phone:'{{phone}}'}, response_path:'sent', store_as:'qr_sent', next:'fim_qr', on_error:'erro_qr', _pos_x:640, _pos_y:60 },
    { id:'ver_horarios',  label:'Ver Horários',         type:'api_call',  method:'GET',  url:'{{porteiro_url}}/api/v1/chatbot/schedule', headers:{Authorization:'Bearer {{porteiro_token}}'}, body:null, response_path:'text', store_as:'horarios_text', next:'fim_horarios', on_error:'erro_horarios', _pos_x:640, _pos_y:220 },
    { id:'abrir_portao',  label:'Abrir Portão',         type:'api_call',  method:'POST', url:'{{porteiro_url}}/api/v1/chatbot/open-gate', headers:{Authorization:'Bearer {{porteiro_token}}'}, body:{phone:'{{phone}}',device_id:'{{relay_device_id}}',door_num:'{{relay_door_num}}',delay:'{{relay_delay}}'}, response_path:'opened', store_as:'portao_ok', next:'fim_portao', on_error:'erro_portao', _pos_x:640, _pos_y:380 },
    { id:'suporte',       label:'Encaminhar suporte',   type:'transfer',  message:'👨‍💼 Vou conectar você com nossa equipe. Aguarde um momento.', _pos_x:640, _pos_y:560 },
    { id:'fim_qr',        label:'QR Enviado',           type:'message',   text:'✅ Seu QR Code foi enviado! Apresente-o na entrada.', next:null, _pos_x:920, _pos_y:60 },
    { id:'erro_qr',       label:'Erro QR',              type:'message',   text:'❌ Não consegui enviar seu QR Code. Tente novamente mais tarde.', next:null, _pos_x:920, _pos_y:160 },
    { id:'fim_horarios',  label:'Horários',             type:'message',   text:'{{session.horarios_text}}', next:null, _pos_x:920, _pos_y:260 },
    { id:'erro_horarios', label:'Erro Horários',        type:'message',   text:'❌ Não consegui buscar seus horários. Tente novamente mais tarde.', next:null, _pos_x:920, _pos_y:340 },
    { id:'fim_portao',    label:'Portão Acionado',      type:'message',   text:'✅ Portão acionado!', next:null, _pos_x:920, _pos_y:420 },
    { id:'erro_portao',   label:'Erro Portão',          type:'message',   text:'❌ Não foi possível acionar o portão. Tente pelo interfone.', next:null, _pos_x:920, _pos_y:500 },
  ];

  const dfIdMap = {};
  for (const node of defaultNodes) {
    const numOut = flowNodeOutputCount(node);
    const meta = FLOW_NODE_META[node.type] || FLOW_NODE_META.message;
    const dfId = flowEditor.addNode(node.type, meta.inputs, numOut, node._pos_x, node._pos_y, node.type, { ...node }, flowNodeHtml(node.type, node.label));
    dfIdMap[node.id] = dfId;
  }
  for (const node of defaultNodes) {
    const srcDf = dfIdMap[node.id];
    if (!srcDf) continue;
    for (const { outIdx, targetId } of flowExtractConnections(node)) {
      const dstDf = dfIdMap[targetId];
      if (dstDf) try { flowEditor.addConnection(srcDf, dstDf, `output_${outIdx}`, 'input_1'); } catch {}
    }
  }
  flowUpdateEntrySelect('start');
}

// ── Live Monitor ──────────────────────────────────────────────────────────
let liveEs = null;
let liveEvents = [];
const LIVE_MAX = 200;
let liveSessions = new Map(); // phoneRaw → { color, trace, currentNodeId, tokenEl }
let liveColorIdx = 0;
const LIVE_SESSION_COLORS = ['#3b82f6','#10b981','#f59e0b','#8b5cf6','#ef4444','#06b6d4','#ec4899','#84cc16'];

const LIVE_TYPE_META = {
  message:     { icon: '📨', label: 'Mensagem recebida',   color: '#64748b' },
  session:     { icon: '🔄', label: 'Estado da sessão',    color: '#94a3b8' },
  start:       { icon: '▶',  label: 'Fluxo iniciado',      color: '#3b82f6' },
  node:        { icon: '⬡',  label: 'Nó executando',       color: '#8b5cf6' },
  result:      { icon: '→',  label: 'Resultado',           color: '#94a3b8' },
  wait:        { icon: '⏳', label: 'Aguardando resposta', color: '#10b981' },
  menu_select: { icon: '✓',  label: 'Botão selecionado',   color: '#10b981' },
  menu_retry:  { icon: '↩',  label: 'Opção inválida',      color: '#f59e0b' },
  end:         { icon: '⏹',  label: 'Sessão encerrada',    color: '#1e293b' },
  error:       { icon: '⚠',  label: 'Erro',                color: '#ef4444' },
  connected:   { icon: '🟢', label: 'Conectado',           color: '#10b981' },
  relay:       { icon: '📤', label: 'Msg relayed → suporte', color: '#f97316' },
};

function initLiveUI() {
  if (document.getElementById('live-modal')) return;
  const style = document.createElement('style');
  style.textContent = `
    #live-modal{position:fixed;inset:0;z-index:9998;display:none;pointer-events:none}
    #live-panel{position:fixed;right:0;top:0;bottom:0;width:420px;max-width:100vw;display:flex;flex-direction:column;background:#0f172a;box-shadow:-4px 0 32px rgba(0,0,0,.45);pointer-events:all;font-family:ui-monospace,monospace}
    .live-header{padding:12px 16px;border-bottom:1px solid #1e293b;display:flex;justify-content:space-between;align-items:center;flex-shrink:0}
    .live-title{color:#f8fafc;font-weight:700;font-size:14px;display:flex;align-items:center;gap:8px}
    .live-dot{width:8px;height:8px;border-radius:50%;background:#ef4444;animation:live-blink 1s infinite}
    .live-dot.connected{background:#10b981;animation:live-blink 2s infinite}
    @keyframes live-blink{0%,100%{opacity:1}50%{opacity:.3}}
    .live-toolbar{padding:8px 12px;border-bottom:1px solid #1e293b;display:flex;gap:8px;align-items:center;flex-shrink:0;background:#0f172a}
    #live-phone-filter{background:#1e293b;border:1px solid #334155;border-radius:6px;padding:4px 8px;color:#94a3b8;font-size:11px;width:120px;font-family:ui-monospace,monospace}
    #live-phone-filter::placeholder{color:#475569}
    #live-feed{flex:1;overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:2px}
    .live-event{border-radius:6px;padding:6px 10px;font-size:11px;line-height:1.5;border-left:3px solid transparent;background:#1e293b}
    .live-event-header{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
    .live-phone{color:#60a5fa;font-weight:700;font-size:10px;letter-spacing:.04em}
    .live-type{font-weight:700;font-size:10px;text-transform:uppercase;letter-spacing:.06em}
    .live-time{color:#475569;font-size:9px;margin-left:auto;white-space:nowrap}
    .live-detail{color:#94a3b8;font-size:10px;margin-top:2px;word-break:break-word}
    .live-node-badge{display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:700;margin-right:4px}
    #live-footer{padding:8px 12px;border-top:1px solid #1e293b;display:flex;gap:8px;flex-shrink:0}
    .live-close-btn{background:none;border:none;color:#64748b;font-size:18px;cursor:pointer;line-height:1;padding:2px 4px}
    .live-close-btn:hover{color:#f8fafc}
    .live-count-badge{background:#1e293b;color:#64748b;font-size:10px;padding:2px 7px;border-radius:10px;margin-left:6px}
    /* ── Canvas overlay — inside .drawflow so tokens pan/zoom with canvas ── */
    #live-canvas-overlay{position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;z-index:10;overflow:visible}
    .live-token{position:absolute;width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:800;color:#fff;pointer-events:all;cursor:pointer;border:3px solid rgba(255,255,255,.85);box-shadow:0 4px 16px rgba(0,0,0,.45);transition:left .45s cubic-bezier(.34,1.56,.64,1),top .45s cubic-bezier(.34,1.56,.64,1),opacity .4s;z-index:20;letter-spacing:-.5px;line-height:1.1;text-align:center}
    .live-token:hover{transform:scale(1.12)}
    .live-token-pulse{animation:live-tok-pulse 1.4s ease-in-out infinite}
    @keyframes live-tok-pulse{0%,100%{box-shadow:0 4px 16px rgba(0,0,0,.45)}50%{box-shadow:0 0 0 10px rgba(255,255,255,.18),0 4px 16px rgba(0,0,0,.45)}}
    /* ── Node live states ── */
    .drawflow .drawflow-node.df-live-active{border-color:#f59e0b!important;box-shadow:0 0 0 5px rgba(251,191,36,.5)!important;animation:df-node-pulse .65s ease-in-out}
    .drawflow .drawflow-node.df-live-visited{border-color:#93c5fd!important;background:#eff6ff!important}
    .drawflow .drawflow-node.df-live-error{border-color:#ef4444!important;box-shadow:0 0 0 5px rgba(239,68,68,.4)!important}
    .drawflow .drawflow-node.df-live-end{border-color:#10b981!important;box-shadow:0 0 0 5px rgba(16,185,129,.35)!important}
    @keyframes df-node-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.03)}}
    /* ── Live button on ── */
    #flow-live-btn.live-btn-on{background:#10b981!important;border-color:#059669!important;color:#fff!important;animation:live-btn-pulse 1.8s infinite}
    @keyframes live-btn-pulse{0%,100%{box-shadow:0 0 0 0 rgba(16,185,129,.5)}60%{box-shadow:0 0 0 6px rgba(16,185,129,0)}}
    /* ── Session bar (bottom of canvas) ── */
    #live-session-bar{position:absolute;bottom:10px;left:10px;display:flex;flex-wrap:wrap;gap:6px;pointer-events:all;z-index:15}
    .live-session-pill{display:flex;align-items:center;gap:5px;padding:4px 10px 4px 7px;border-radius:20px;font-size:11px;font-weight:700;color:#fff;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.35);transition:transform .15s;white-space:nowrap}
    .live-session-pill:hover{transform:scale(1.07)}
    .live-session-dot{width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,.7);flex-shrink:0;animation:live-blink .9s infinite}
    /* ── Trace popup ── */
    #live-trace-popup{position:fixed;z-index:10001;background:#0f172a;border-radius:10px;box-shadow:0 8px 40px rgba(0,0,0,.65);width:340px;max-height:460px;display:flex;flex-direction:column;font-family:ui-monospace,monospace;overflow:hidden}
    .live-trace-entry{padding:5px 8px;border-left:2px solid transparent;margin-bottom:2px;border-radius:0 4px 4px 0;background:#1e293b}
    .live-trace-entry:hover{background:#253247}
  `;
  document.head.appendChild(style);

  const modal = document.createElement('div');
  modal.id = 'live-modal';
  modal.innerHTML = `
    <div id="live-panel">
      <div class="live-header">
        <div class="live-title">
          <span class="live-dot" id="live-dot"></span>
          <span>Live Monitor</span>
          <span class="live-count-badge" id="live-count">0 eventos</span>
        </div>
        <button class="live-close-btn" onclick="liveClose()" title="Fechar">✕</button>
      </div>
      <div class="live-toolbar">
        <input id="live-phone-filter" placeholder="Filtrar número..." oninput="liveRender()">
        <button class="btn btn-sm" style="font-size:11px;padding:3px 10px;background:#1e293b;border:1px solid #334155;color:#94a3b8;border-radius:6px" onclick="liveClear()">🗑 Limpar</button>
      </div>
      <div id="live-feed"></div>
      <div id="live-footer">
        <span id="live-status" style="font-size:10px;color:#475569;align-self:center">Desconectado</span>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

function liveOpen() {
  initLiveUI();
  const modal = document.getElementById('live-modal');
  const btn = document.getElementById('flow-live-btn');
  if (modal && modal.style.display !== 'none') {
    // segundo clique fecha
    modal.style.display = 'none';
    if (btn) { btn.classList.remove('live-btn-on'); btn.innerHTML = '🔴 Live'; }
    return;
  }
  if (modal) modal.style.display = '';
  if (btn) { btn.classList.add('live-btn-on'); btn.innerHTML = '⏺ Live'; }
  if (!liveEs || liveEs.readyState === EventSource.CLOSED) liveConnect();
}

function liveClose() {
  const modal = document.getElementById('live-modal');
  if (modal) modal.style.display = 'none';
  const btn = document.getElementById('flow-live-btn');
  if (btn) { btn.classList.remove('live-btn-on'); btn.innerHTML = '🔴 Live'; }
}

function liveConnect() {
  if (liveEs) { try { liveEs.close(); } catch {} }
  liveEs = new EventSource('/admin/api/chatbot/live');
  const dot = document.getElementById('live-dot');
  const status = document.getElementById('live-status');

  liveEs.onopen = () => {
    if (dot) { dot.className = 'live-dot connected'; }
    if (status) status.textContent = 'Conectado — aguardando eventos...';
  };
  liveEs.onerror = () => {
    if (dot) dot.className = 'live-dot';
    if (status) status.textContent = 'Reconectando...';
  };
  liveEs.onmessage = (e) => {
    try {
      const ev = JSON.parse(e.data);
      if (ev.type === 'connected') return;
      liveEvents.push(ev);
      if (liveEvents.length > LIVE_MAX) liveEvents.shift();
      liveRender();
      liveHandleCanvasEvent(ev);
    } catch {}
  };
}

function liveClear() {
  liveEvents = [];
  liveSessions.clear();
  liveColorIdx = 0;
  document.getElementById('live-canvas-overlay')?.remove();
  document.getElementById('live-session-bar')?.remove();
  document.getElementById('live-trace-popup')?.remove();
  liveClearCanvasHighlights();
  liveRender();
}

function liveRender() {
  const feed = document.getElementById('live-feed');
  const countEl = document.getElementById('live-count');
  if (!feed) return;
  const filter = (document.getElementById('live-phone-filter')?.value || '').trim().replace(/\D/g, '');
  const visible = filter
    ? liveEvents.filter((e) => (e.phoneRaw || '').includes(filter))
    : liveEvents;
  if (countEl) countEl.textContent = `${liveEvents.length} evento${liveEvents.length !== 1 ? 's' : ''}`;
  if (!visible.length) {
    feed.innerHTML = '<div style="color:#334155;font-size:11px;padding:20px;text-align:center">Nenhum evento ainda.<br>Envie uma mensagem pelo WhatsApp.</div>';
    return;
  }
  const NODE_COLORS = { identify:'#3b82f6', menu:'#10b981', message:'#6b7280', api_call:'#8b5cf6', condition:'#f59e0b', transfer:'#ef4444', end:'#1e293b' };
  feed.innerHTML = visible.slice().reverse().map((ev) => {
    const meta = LIVE_TYPE_META[ev.type] || { icon: '·', label: ev.type, color: '#64748b' };
    const timeStr = ev.ts ? new Date(ev.ts).toLocaleTimeString('pt-BR') : '';
    let detail = '';
    if (ev.type === 'message') detail = `"${escapeHtml((ev.text || '').slice(0, 80))}"`;
    else if (ev.type === 'session') detail = `estado: <b>${escapeHtml(ev.sessState || 'idle')}</b>`;
    else if (ev.type === 'start') detail = `entrada: <b>${escapeHtml(ev.entry || '?')}</b>${ev.reason ? ` — ${escapeHtml(ev.reason)}` : ''}`;
    else if (ev.type === 'node') {
      const nc = NODE_COLORS[ev.nodeType] || '#64748b';
      detail = `<span class="live-node-badge" style="background:${nc}20;color:${nc};border:1px solid ${nc}40">${escapeHtml(ev.nodeType || '')}</span><b>${escapeHtml(ev.nodeLabel || ev.nodeId || '')}</b>`;
    } else if (ev.type === 'result') {
      const next = ev.nextNodeId ? `→ <b>${escapeHtml(ev.nextNodeId)}</b>` : `→ <span style="color:#475569">${escapeHtml(ev.outcome || '')}</span>`;
      detail = next;
    } else if (ev.type === 'wait') detail = `menu: <b>${escapeHtml(ev.nodeLabel || ev.nodeId || '')}</b>`;
    else if (ev.type === 'menu_select') detail = `selecionou "<b>${escapeHtml(ev.input || '')}</b>" → <b>${escapeHtml(ev.next || '')}</b>`;
    else if (ev.type === 'menu_retry') detail = `entrada inválida: "${escapeHtml(ev.input || '')}"`;
    else if (ev.type === 'end') detail = escapeHtml(ev.reason || '');
    else if (ev.type === 'error') detail = `<span style="color:#ef4444">${escapeHtml(ev.error || '')}</span>`;

    return `<div class="live-event" style="border-left-color:${meta.color}">
      <div class="live-event-header">
        <span style="color:${meta.color}">${meta.icon}</span>
        <span class="live-phone">${escapeHtml(ev.phone || '?')}</span>
        <span class="live-type" style="color:${meta.color}">${escapeHtml(meta.label)}</span>
        <span class="live-time">${timeStr}</span>
      </div>
      ${detail ? `<div class="live-detail">${detail}</div>` : ''}
    </div>`;
  }).join('');
}

// ── Canvas Live Overlay ────────────────────────────────────────────────────
function dfIdFromNodeId(nodeId) {
  if (!flowEditor) return null;
  try {
    const data = flowEditor.export().drawflow.Home.data;
    for (const [dfId, dfNode] of Object.entries(data)) {
      if (dfNode.data?.id === nodeId) return dfId;
    }
  } catch {}
  return null;
}

function liveGetNodeWorldPos(nodeId) {
  if (!flowEditor) return null;
  try {
    const data = flowEditor.export().drawflow.Home.data;
    for (const [dfId, dfNode] of Object.entries(data)) {
      if (dfNode.data?.id === nodeId) {
        const el = document.querySelector(`#node-${dfId}`);
        const w = el ? el.offsetWidth : 160;
        const h = el ? el.offsetHeight : 60;
        return { x: dfNode.pos_x + w / 2, y: dfNode.pos_y + h / 2 };
      }
    }
  } catch {}
  return null;
}

function liveEnsureCanvasOverlay() {
  // Tokens go INSIDE .drawflow so they pan/zoom together with nodes
  const drawflowEl = document.querySelector('#drawflow-canvas .drawflow');
  if (!drawflowEl) return null;
  let ov = document.getElementById('live-canvas-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'live-canvas-overlay';
    drawflowEl.appendChild(ov);
  }
  // Session pill bar stays on the outer canvas (fixed corner)
  const canvas = document.getElementById('drawflow-canvas');
  if (canvas && !document.getElementById('live-session-bar')) {
    const bar = document.createElement('div');
    bar.id = 'live-session-bar';
    canvas.appendChild(bar);
  }
  return ov;
}

function liveCreateToken(phoneRaw, phone4, color) {
  const ov = liveEnsureCanvasOverlay();
  if (!ov) return null;
  const token = document.createElement('div');
  token.className = 'live-token live-token-pulse';
  token.style.cssText = `background:${color};left:-60px;top:-60px`;
  token.innerHTML = `...${String(phone4 || phoneRaw).slice(-4)}`;
  token.title = 'Clique para ver rastreio da sessão';
  token.onclick = () => liveShowTrace(phoneRaw);
  ov.appendChild(token);
  return token;
}

function liveMoveToken(phoneRaw, nodeId) {
  const session = liveSessions.get(phoneRaw);
  if (!session?.tokenEl) return;
  const pos = liveGetNodeWorldPos(nodeId);
  if (!pos) return;
  session.tokenEl.style.left = `${pos.x - 22}px`;
  session.tokenEl.style.top = `${pos.y - 22}px`;
}

function liveHighlightNode(nodeId, state) {
  const dfId = dfIdFromNodeId(nodeId);
  if (!dfId) return;
  const el = document.querySelector(`#node-${dfId}`);
  if (!el) return;
  el.classList.remove('df-live-active', 'df-live-error', 'df-live-end');
  void el.offsetWidth; // restart animation
  if (state === 'active') {
    el.classList.add('df-live-active', 'df-live-visited');
    setTimeout(() => el?.classList.remove('df-live-active'), 1800);
  } else if (state === 'error') {
    el.classList.add('df-live-error', 'df-live-visited');
  } else if (state === 'end') {
    el.classList.add('df-live-end', 'df-live-visited');
  } else if (state === 'visited') {
    el.classList.add('df-live-visited');
  }
}

function liveClearCanvasHighlights() {
  document.querySelectorAll('.df-live-active,.df-live-visited,.df-live-error,.df-live-end').forEach((el) => {
    el.classList.remove('df-live-active', 'df-live-visited', 'df-live-error', 'df-live-end');
  });
}

function liveUpdateSessionBar() {
  const bar = document.getElementById('live-session-bar');
  if (!bar) return;
  bar.innerHTML = '';
  for (const [phoneRaw, sess] of liveSessions) {
    const pill = document.createElement('div');
    pill.className = 'live-session-pill';
    pill.style.background = sess.color;
    pill.innerHTML = `<span class="live-session-dot"></span>...${String(phoneRaw).slice(-4)}`;
    pill.title = 'Clique para rastreio';
    pill.onclick = () => liveShowTrace(phoneRaw);
    bar.appendChild(pill);
  }
}

function liveEnsureSession(phoneRaw, phone, onCanvas) {
  if (liveSessions.has(phoneRaw)) return liveSessions.get(phoneRaw);
  const color = LIVE_SESSION_COLORS[liveColorIdx++ % LIVE_SESSION_COLORS.length];
  const token = onCanvas ? liveCreateToken(phoneRaw, phone || phoneRaw, color) : null;
  const sess = { color, trace: [], currentNodeId: null, tokenEl: token };
  liveSessions.set(phoneRaw, sess);
  if (onCanvas) liveUpdateSessionBar();
  return sess;
}

function liveHandleCanvasEvent(ev) {
  const flowTab = document.getElementById('chatbot-flow-tab');
  const onCanvas = !!(flowTab && flowTab.style.display !== 'none' && flowEditor);
  const { type, phoneRaw, phone } = ev;

  switch (type) {
    case 'message': {
      const sess = liveEnsureSession(phoneRaw, phone, onCanvas);
      sess.trace.push(ev);
      break;
    }
    case 'start': {
      // reset session
      const old = liveSessions.get(phoneRaw);
      if (old?.tokenEl) old.tokenEl.remove();
      liveSessions.delete(phoneRaw);
      const sess = liveEnsureSession(phoneRaw, phone, onCanvas);
      sess.trace.push(ev);
      break;
    }
    case 'node': {
      const sess = liveEnsureSession(phoneRaw, phone, onCanvas);
      sess.trace.push(ev);
      sess.currentNodeId = ev.nodeId;
      if (onCanvas) {
        liveMoveToken(phoneRaw, ev.nodeId);
        liveHighlightNode(ev.nodeId, 'active');
      }
      break;
    }
    case 'result':
    case 'wait':
    case 'menu_select':
    case 'menu_retry':
    case 'session': {
      liveSessions.get(phoneRaw)?.trace.push(ev);
      break;
    }
    case 'end': {
      const sess = liveSessions.get(phoneRaw);
      if (sess) {
        sess.trace.push(ev);
        if (onCanvas && sess.currentNodeId) liveHighlightNode(sess.currentNodeId, 'end');
        const cleanup = () => { liveSessions.delete(phoneRaw); liveUpdateSessionBar(); };
        if (sess.tokenEl) {
          sess.tokenEl.style.opacity = '0.35';
          sess.tokenEl.style.transform = 'scale(.75)';
          setTimeout(() => { sess.tokenEl?.remove(); cleanup(); }, 3500);
        } else {
          setTimeout(cleanup, 3500);
        }
      }
      break;
    }
    case 'error': {
      const sess = liveSessions.get(phoneRaw);
      if (sess) {
        sess.trace.push(ev);
        if (onCanvas && ev.nodeId) liveHighlightNode(ev.nodeId, 'error');
        if (sess.tokenEl) {
          sess.tokenEl.style.background = '#ef4444';
          sess.tokenEl.textContent = '!';
          sess.tokenEl.classList.remove('live-token-pulse');
          setTimeout(() => {
            sess.tokenEl?.remove();
            liveSessions.delete(phoneRaw);
            liveUpdateSessionBar();
          }, 4500);
        }
      }
      break;
    }
  }
}

function liveShowTrace(phoneRaw) {
  document.getElementById('live-trace-popup')?.remove();
  const sess = liveSessions.get(phoneRaw);
  if (!sess) return;

  // Highlight path on canvas
  if (flowEditor) {
    liveClearCanvasHighlights();
    sess.trace.filter((e) => e.type === 'node').forEach((e) => liveHighlightNode(e.nodeId, 'visited'));
    if (sess.currentNodeId) liveHighlightNode(sess.currentNodeId, 'active');
  }

  const NC = { identify:'#3b82f6', menu:'#10b981', message:'#6b7280', api_call:'#8b5cf6', condition:'#f59e0b', transfer:'#ef4444', end:'#1e293b' };
  const popup = document.createElement('div');
  popup.id = 'live-trace-popup';
  popup.style.cssText = 'top:70px;right:24px';
  popup.innerHTML = `
    <div style="padding:10px 14px;background:#1e293b;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;border-radius:10px 10px 0 0">
      <span style="color:#f8fafc;font-weight:700;font-size:13px">
        📍 Rastreio <span style="color:${escapeHtml(sess.color)}">●</span> ...${String(phoneRaw).slice(-4)}
      </span>
      <button onclick="document.getElementById('live-trace-popup')?.remove()" style="background:none;border:none;color:#94a3b8;cursor:pointer;font-size:18px;line-height:1;padding:0 4px">✕</button>
    </div>
    <div style="flex:1;overflow-y:auto;padding:8px;max-height:380px">
      ${sess.trace.length === 0
        ? '<div style="color:#475569;font-size:11px;padding:16px;text-align:center">Sem eventos ainda</div>'
        : sess.trace.map((ev) => {
            const meta = LIVE_TYPE_META[ev.type] || { icon: '·', label: ev.type, color: '#64748b' };
            const time = ev.ts ? new Date(ev.ts).toLocaleTimeString('pt-BR') : '';
            let detail = '';
            if (ev.type === 'node') {
              const nc = NC[ev.nodeType] || '#64748b';
              detail = `<span style="background:${nc}30;color:${nc};padding:1px 6px;border-radius:4px;font-size:9px;font-weight:700">${escapeHtml(ev.nodeType || '')}</span> <b style="color:#e2e8f0">${escapeHtml(ev.nodeLabel || ev.nodeId || '')}</b>`;
            } else if (ev.type === 'message') {
              detail = `<span style="color:#94a3b8">"${escapeHtml((ev.text || '').slice(0, 60))}"</span>`;
            } else if (ev.type === 'result') {
              detail = ev.nextNodeId ? `→ <b style="color:#60a5fa">${escapeHtml(ev.nextNodeId)}</b>` : `→ <span style="color:#64748b">${escapeHtml(ev.outcome || 'fim')}</span>`;
            } else if (ev.type === 'wait') {
              detail = `<span style="color:#f59e0b">⏳ aguardando em <b>${escapeHtml(ev.nodeLabel || ev.nodeId || '')}</b></span>`;
            } else if (ev.type === 'end') {
              detail = `<span style="color:#10b981">✅ ${escapeHtml(ev.reason || 'encerrado')}</span>`;
            } else if (ev.type === 'error') {
              detail = `<span style="color:#ef4444">❌ ${escapeHtml(ev.error || ev.message || '')}</span>`;
            } else if (ev.type === 'menu_select') {
              detail = `<span style="color:#a78bfa">✓ "${escapeHtml(ev.input || '')}" → ${escapeHtml(ev.next || '')}</span>`;
            } else if (ev.type === 'start') {
              detail = `<span style="color:#60a5fa">▶ entrada: <b>${escapeHtml(ev.entry || '?')}</b></span>`;
            } else if (ev.type === 'menu_retry') {
              detail = `<span style="color:#f59e0b">entrada inválida: "${escapeHtml(ev.input || '')}"</span>`;
            }
            return `<div class="live-trace-entry" style="border-left-color:${meta.color}">
              <div style="display:flex;justify-content:space-between;align-items:center">
                <span style="color:${meta.color};font-size:10px;font-weight:700">${meta.icon} ${escapeHtml(meta.label)}</span>
                <span style="color:#475569;font-size:9px">${escapeHtml(time)}</span>
              </div>
              ${detail ? `<div style="font-size:10px;margin-top:2px;color:#94a3b8">${detail}</div>` : ''}
            </div>`;
          }).join('')}
    </div>
    <div style="padding:8px 10px;border-top:1px solid #334155;flex-shrink:0;display:flex;gap:6px;background:#1e293b;border-radius:0 0 10px 10px">
      <button onclick="liveEndSession('${escapeHtml(phoneRaw)}')" style="flex:1;background:#ef4444;color:#fff;border:none;border-radius:6px;padding:5px 10px;font-size:11px;font-weight:700;cursor:pointer">🗑️ Encerrar sessão</button>
    </div>`;
  document.body.appendChild(popup);
}

async function liveEndSession(phoneRaw) {
  if (!confirm(`Encerrar sessão de ...${String(phoneRaw).slice(-4)}? O usuário poderá iniciar uma nova conversa.`)) return;
  try {
    await api(`/admin/api/chatbot/session/${encodeURIComponent(phoneRaw)}`, { method: 'DELETE' });
    document.getElementById('live-trace-popup')?.remove();
    liveClearCanvasHighlights();
    const sess = liveSessions.get(phoneRaw);
    if (sess) {
      sess.tokenEl?.remove();
      liveSessions.delete(phoneRaw);
    }
    liveUpdateSessionBar();
    showMessage('Sessão encerrada');
  } catch (e) {
    showMessage('Erro ao encerrar sessão: ' + e.message, 'danger');
  }
}

function liveRefreshCanvasTokens() {
  // Called when flow tab becomes visible — create tokens for sessions that exist but have no token
  if (!flowEditor) return;
  for (const [phoneRaw, sess] of liveSessions) {
    if (!sess.tokenEl) {
      const token = liveCreateToken(phoneRaw, sess.phone || phoneRaw, sess.color);
      sess.tokenEl = token;
      if (sess.currentNodeId) liveMoveToken(phoneRaw, sess.currentNodeId);
    }
  }
  liveUpdateSessionBar();
}

function flowPropsPanelToggle() {
  const panel = document.getElementById('flow-props-panel');
  const btn = document.getElementById('flow-props-toggle-btn');
  if (!panel) return;
  const collapsed = panel.classList.toggle('props-collapsed');
  if (btn) btn.textContent = collapsed ? '▶' : '◀';
}

// ── Flow Simulator ────────────────────────────────────────────────────────
let simState = null;

function initSimulatorUI() {
  if (document.getElementById('flow-sim-modal')) return;
  const style = document.createElement('style');
  style.textContent = `
    #flow-sim-modal{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.5);display:flex;align-items:stretch;justify-content:flex-end}
    #flow-sim-panel{width:400px;max-width:100vw;display:flex;flex-direction:column;background:#fff;box-shadow:-4px 0 32px rgba(0,0,0,.25)}
    .sim-header{padding:14px 18px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;background:#075E54;color:#fff;flex-shrink:0}
    .sim-config{padding:12px 16px;border-bottom:1px solid #e2e8f0;display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;flex-shrink:0;background:#f8fafc}
    #sim-chat{flex:1;overflow-y:auto;padding:12px 10px;background:#E5DDD5;display:flex;flex-direction:column;gap:6px;min-height:0}
    #sim-input-area{padding:10px 14px;border-top:1px solid #e2e8f0;background:#f0f0f0;flex-shrink:0;min-height:48px}
    .sim-bubble{max-width:84%;padding:8px 12px;border-radius:8px;font-size:13px;line-height:1.5;word-break:break-word}
    .sim-bot{background:#fff;border-radius:4px 12px 12px 12px;box-shadow:0 1px 2px rgba(0,0,0,.12);align-self:flex-start}
    .sim-user{background:#DCF8C6;border-radius:12px 4px 12px 12px;align-self:flex-end}
    .sim-sys{background:rgba(0,0,0,.07);border-radius:8px;color:#555;font-size:11px;align-self:center;text-align:center;padding:4px 12px;max-width:100%}
    .sim-wa-btn{display:block;width:100%;margin:3px 0;padding:7px 12px;border:1px solid #25D366;border-radius:8px;background:#fff;color:#128C7E;font-size:13px;cursor:pointer;text-align:center}
    .sim-wa-btn:hover{background:#f0fdf4}
    .sim-act-btn{flex:1;padding:7px;border-radius:8px;border:1.5px solid;font-size:12px;cursor:pointer;font-weight:600}
    .drawflow .drawflow-node.df-sim-active{border-color:#f59e0b!important;box-shadow:0 0 0 4px rgba(251,191,36,.45)!important}
  `;
  document.head.appendChild(style);
  const modal = document.createElement('div');
  modal.id = 'flow-sim-modal';
  modal.style.display = 'none';
  modal.innerHTML = `
    <div style="flex:1" onclick="flowSimClose()"></div>
    <div id="flow-sim-panel">
      <div class="sim-header">
        <div>
          <div style="font-weight:700;font-size:15px">🎮 Simulador de Fluxo</div>
          <div style="font-size:11px;opacity:.85;margin-top:2px" id="sim-node-label">Configure e clique em Iniciar</div>
        </div>
        <button onclick="flowSimClose()" style="background:none;border:none;color:#fff;font-size:20px;cursor:pointer;line-height:1;padding:2px 6px" title="Fechar">✕</button>
      </div>
      <div class="sim-config">
        <div style="flex:1;min-width:100px">
          <label style="font-size:11px;font-weight:600;display:block;margin-bottom:3px">Nome</label>
          <input id="sim-name" class="form-control form-control-sm" value="João Silva">
        </div>
        <div style="flex:1;min-width:95px">
          <label style="font-size:11px;font-weight:600;display:block;margin-bottom:3px">Tipo</label>
          <select id="sim-type" class="form-select form-select-sm">
            <option value="aluno">🎓 Aluno</option>
            <option value="morador">🏠 Morador</option>
            <option value="unknown">❓ Desconhecido</option>
          </select>
        </div>
        <div style="flex:1;min-width:120px">
          <label style="font-size:11px;font-weight:600;display:block;margin-bottom:3px">Telefone <span style="color:#94a3b8;font-weight:400">(sem 55)</span></label>
          <input id="sim-phone" class="form-control form-control-sm" placeholder="(42) 9 9999-9999" maxlength="16" inputmode="numeric">
        </div>
        <button onclick="flowSimStart()" class="btn btn-sm btn-success" style="align-self:flex-end;white-space:nowrap">▶ Iniciar</button>
      </div>
      <div id="sim-chat"></div>
      <div id="sim-input-area"></div>
    </div>
  `;
  document.body.appendChild(modal);
  // Phone mask
  document.getElementById('sim-phone').addEventListener('input', simPhoneMask);
}

function simPhoneMask(e) {
  const el = e.target;
  const digits = el.value.replace(/\D/g, '').slice(0, 11);
  let v = digits;
  if (digits.length > 7) {
    v = `(${digits.slice(0,2)}) ${digits.slice(2,3)} ${digits.slice(3,7)}-${digits.slice(7)}`;
  } else if (digits.length > 3) {
    v = `(${digits.slice(0,2)}) ${digits.slice(2,3)} ${digits.slice(3)}`;
  } else if (digits.length > 2) {
    v = `(${digits.slice(0,2)}) ${digits.slice(2)}`;
  } else if (digits.length > 0) {
    v = `(${digits}`;
  }
  el.value = v;
}

function simGetPhone() {
  const raw = document.getElementById('sim-phone')?.value || '';
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '5500000000000'; // fallback
  return digits.startsWith('55') ? digits : '55' + digits;
}

function flowSimOpen() {
  initSimulatorUI();
  const modal = document.getElementById('flow-sim-modal');
  if (modal) modal.style.display = 'flex';
}

function flowSimClose() {
  const modal = document.getElementById('flow-sim-modal');
  if (modal) modal.style.display = 'none';
  simHighlightNode(null);
  simState = null;
}

function simHighlightNode(logicalId) {
  document.querySelectorAll('.df-sim-active').forEach((el) => el.classList.remove('df-sim-active'));
  if (!logicalId || !flowEditor) return;
  const dfId = flowGetDfId(logicalId);
  if (dfId !== null) {
    const el = document.getElementById('node-' + dfId);
    if (el) el.classList.add('df-sim-active');
  }
}

function simResolve(text) {
  if (!simState) return String(text || '');
  return String(text || '').replace(/\{\{(\w[\w.]*)\}\}/g, (_, key) => {
    if (key.startsWith('session.')) return String(simState.data?.[key.slice(8)] ?? `[${key}]`);
    const m = {
      person_name: simState.person_name,
      phone: simState.phone,
      porteiro_url: simState.cfg?.porteiro_url || '[porteiro_url]',
      porteiro_token: '***',
      relay_device_id: String(simState.cfg?.relay_device_id || '1'),
      relay_door_num: String(simState.cfg?.relay_door_num || '1'),
      relay_delay: String(simState.cfg?.relay_delay || '5'),
      unknown_message: simState.cfg?.unknown_message || '[mensagem para desconhecidos]',
      saudacao: (() => { const h = new Date().getHours(); if (h >= 5 && h < 12) return 'Bom dia'; if (h >= 12 && h < 18) return 'Boa tarde'; if (h >= 18 && h < 22) return 'Boa noite'; return 'Boa madrugada'; })(),
    };
    return m[key] ?? `[${key}]`;
  });
}

function simBubble(html, side) {
  const chat = document.getElementById('sim-chat');
  if (!chat) return;
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex';
  const b = document.createElement('div');
  b.className = `sim-bubble sim-${side}`;
  b.innerHTML = html;
  wrap.appendChild(b);
  chat.appendChild(wrap);
  chat.scrollTop = chat.scrollHeight;
}

function simSetInput(html) {
  const el = document.getElementById('sim-input-area');
  if (el) el.innerHTML = html;
}

function simSetLabel(text) {
  const el = document.getElementById('sim-node-label');
  if (el) el.textContent = text || '';
}

function simEnd(reason) {
  if (simState) simState.depth = 999;
  simHighlightNode(null);
  simSetLabel(reason);
  simBubble(reason, 'sys');
  simSetInput(`<button onclick="flowSimStart()" class="btn btn-sm btn-primary w-100 mt-1">↺ Reiniciar simulação</button>`);
}

async function flowSimStart() {
  if (!flowEditor) { showMessage('Abra o editor de fluxo primeiro', 'error'); return; }
  const allDfNodes = Object.values(flowEditor.export().drawflow.Home.data || {});
  if (!allDfNodes.length) { showMessage('Canvas vazio — carregue o fluxo primeiro', 'error'); return; }
  const entryId = document.getElementById('flow-entry-select')?.value;
  if (!entryId) { showMessage('Selecione o nó inicial (entry) antes de simular', 'error'); return; }

  const nodeMap = {};
  for (const dfNode of allDfNodes) {
    const nd = dfNode.data || {};
    if (nd.id) nodeMap[nd.id] = nd;
  }

  const cfg = state.bootstrap?.settings?.chatbot || {};

  const phone = simGetPhone();
  simState = {
    nodeMap,
    person_name: document.getElementById('sim-name')?.value.trim() || 'Usuário',
    person_type: document.getElementById('sim-type')?.value || 'aluno',
    phone,
    data: {},
    cfg,
    depth: 0,
  };

  document.getElementById('sim-chat').innerHTML = '';
  simSetInput('');
  simHighlightNode(null);
  simBubble(
    `Simulação iniciada&emsp;👤 <b>${simState.person_name}</b> (${simState.person_type})` +
    `<br><small style="color:#64748b">📱 ${phone}</small>`,
    'sys'
  );
  flowSimExec(entryId);
}

function flowSimExec(nodeId) {
  if (!simState) return;
  if (!nodeId) { simEnd('Fluxo encerrado (sem próximo nó)'); return; }
  if (++simState.depth > 25) { simEnd('⚠️ Limite de execução atingido — possível loop no fluxo'); return; }
  const node = simState.nodeMap[nodeId];
  if (!node) { simEnd(`Nó "${nodeId}" não encontrado no canvas`); return; }
  simHighlightNode(nodeId);
  simSetLabel(`▶ ${node.label || nodeId}`);
  const t = node.type || 'message';
  if (t === 'identify')  return simExecIdentify(node);
  if (t === 'menu')      return simExecMenu(node);
  if (t === 'message')   return simExecMessage(node);
  if (t === 'api_call')  return simExecApiCall(node);
  if (t === 'condition') return simExecCondition(node);
  if (t === 'transfer')  return simExecTransfer(node);
  if (t === 'end')       return simExecEnd(node);
  simBubble(`[tipo desconhecido: ${t}]`, 'bot');
  simEnd('Tipo de nó não suportado pelo simulador');
}

function simExecIdentify(node) {
  const t = simState.person_type;
  simBubble(`🔍 Identificação: tipo = <b>${t}</b>, nome = <b>${simState.person_name}</b>`, 'sys');
  let next = t === 'aluno' ? (node.next_aluno || node.next_known) : t === 'morador' ? node.next_morador : node.next_unknown;
  setTimeout(() => flowSimExec(next), 400);
}

function simExecMenu(node) {
  const text = simResolve(node.body || '');
  const buttons = node.buttons || [];
  simBubble(text.replace(/\n/g, '<br>'), 'bot');
  simSetInput(buttons.length
    ? buttons.map((b, i) => `<button class="sim-wa-btn" onclick="simPickBtn(${i})">${b.title || b.id}</button>`).join('')
    : '<p class="text-muted small mb-0">Menu sem botões configurados</p>');
  simState._menuNode = node;
}

function simPickBtn(idx) {
  const node = simState?._menuNode;
  if (!node) return;
  const b = node.buttons?.[idx];
  if (!b) return;
  simState._menuNode = null;
  simBubble(b.title || b.id, 'user');
  simSetInput('');
  setTimeout(() => flowSimExec(b.next), 300);
}

function simExecMessage(node) {
  const text = simResolve(node.text || '');
  simBubble(text.replace(/\n/g, '<br>'), 'bot');
  if (node.next) setTimeout(() => flowSimExec(node.next), 600);
  else simEnd('Conversa encerrada');
}

async function simExecApiCall(node) {
  const method = (node.method || 'POST').toUpperCase();
  // Display: resolve non-secret vars (porteiro_token fica como ***)
  const displayUrl = simResolve(node.url || '');
  const rawBody = node.body && typeof node.body === 'object' ? node.body : null;
  const displayBody = rawBody
    ? Object.fromEntries(Object.entries(rawBody).map(([k, v]) => [k, simResolve(String(v))]))
    : null;

  simBubble(
    `📡 <b>${method}</b> <code style="font-size:11px;word-break:break-all">${displayUrl}</code>` +
    (displayBody ? `<br><small style="color:#888;font-size:10px">${JSON.stringify(displayBody)}</small>` : ''),
    'sys'
  );
  simSetInput('<div class="text-muted small text-center py-2">⏳ Chamando API real...</div>');

  // Chamada real: envia templates originais para o servidor resolver com o token real
  let result;
  try {
    result = await fetch('/admin/api/chatbot/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        method,
        url: node.url || '',         // template original ex: {{porteiro_url}}/api/...
        headers: node.headers || {}, // template original ex: Bearer {{porteiro_token}}
        body: rawBody,               // template original ex: {phone: '{{phone}}'}
        templateVars: {              // vars de runtime do simulador
          phone: simState.phone,
          person_name: simState.person_name,
          ...Object.fromEntries(Object.entries(simState.data).map(([k, v]) => [`session.${k}`, v])),
        },
      }),
    }).then((r) => r.json());
  } catch (e) {
    result = { ok: false, error: e.message };
  }

  simSetInput('');

  if (result.ok) {
    // Extract value at response_path (supports dot notation)
    let extracted = result.data;
    if (node.response_path) {
      for (const part of node.response_path.split('.')) extracted = extracted?.[part];
    }
    if (node.store_as) simState.data[node.store_as] = extracted;

    const prettyJson = simPrettyJson(result.data);
    simBubble(
      `✅ HTTP ${result.status}<br>` +
      `<small style="color:#059669"><b>${node.response_path || '(resposta)'}</b> = <code>${JSON.stringify(extracted)}</code></small>` +
      `<details style="margin-top:4px"><summary style="font-size:10px;color:#94a3b8;cursor:pointer">Ver resposta completa</summary>` +
      `<pre style="font-size:10px;margin:4px 0 0;max-height:120px;overflow:auto;white-space:pre-wrap">${prettyJson}</pre></details>`,
      'bot'
    );

    // Truthy check: go next if extracted value is truthy
    if (extracted) {
      setTimeout(() => flowSimExec(node.next), 400);
    } else {
      simBubble(`⚠️ Valor de <b>"${node.response_path}"</b> é falso/nulo → rota de erro`, 'sys');
      setTimeout(() => flowSimExec(node.on_error), 400);
    }
  } else {
    const prettyErr = result.data ? simPrettyJson(result.data) : (result.error || 'Erro desconhecido');
    simBubble(
      `❌ ${result.status ? `HTTP ${result.status}` : 'Erro de conexão'}: <b>${result.error || ''}</b>` +
      (result.data ? `<details style="margin-top:4px"><summary style="font-size:10px;color:#94a3b8;cursor:pointer">Ver detalhes</summary>` +
      `<pre style="font-size:10px;margin:4px 0 0;max-height:120px;overflow:auto;white-space:pre-wrap;color:#dc2626">${prettyErr}</pre></details>` : ''),
      'bot'
    );
    setTimeout(() => flowSimExec(node.on_error), 400);
  }
}

function simPrettyJson(val) {
  try { return JSON.stringify(val, null, 2).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  catch { return String(val); }
}

function simExecCondition(node) {
  const val = String(simState.data[node.variable] ?? '');
  const eq = String(node.equals ?? '');
  const result = val === eq;
  simBubble(`❓ <code>${node.variable}</code> = <code>${val || '[não definido]'}</code> === <code>${eq}</code> → <b>${result ? 'VERDADEIRO ✅' : 'FALSO ❌'}</b>`, 'sys');
  setTimeout(() => flowSimExec(result ? node.next_true : node.next_false), 400);
}

function simExecTransfer(node) {
  if (node.message) simBubble(simResolve(node.message).replace(/\n/g, '<br>'), 'bot');
  simEnd('👨‍💼 Conversa encaminhada para suporte humano');
}

function simExecEnd(node) {
  if (node.farewell) simBubble(simResolve(node.farewell).replace(/\n/g, '<br>'), 'bot');
  simEnd('🏁 Fluxo encerrado');
}

async function api(url, options) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.error?.message || data.message || `HTTP ${response.status}`);
    err.code = data.error?.code;
    throw err;
  }
  return data;
}

const byId = (id) => document.getElementById(id);
const getValue = (id) => byId(id)?.value.trim() || '';

function setValue(id, value) {
  const el = byId(id);
  if (el) el.value = value ?? '';
}

function setCheckbox(id, value) {
  const el = byId(id);
  if (el) el.checked = Boolean(value);
}

function getCheckbox(id) {
  return Boolean(byId(id)?.checked);
}

function setSecret(id, maskedValue) {
  const el = byId(id);
  if (!el) return;
  el.value = '';
  el.placeholder = maskedValue || 'not configured';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('pt-BR');
}

function relativeTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffH = Math.floor(diffMin / 60);
  const diffD = Math.floor(diffH / 24);
  if (diffMin < 1) return 'agora';
  if (diffMin < 60) return `há ${diffMin} min`;
  if (diffH < 24) return `há ${diffH}h`;
  if (diffD === 1) return 'ontem';
  if (diffD < 7) return `há ${diffD} dias`;
  return date.toLocaleDateString('pt-BR');
}

function showMessage(text, type = 'success', title) {
  const toast = byId('app-toast');
  if (!toast) return;
  byId('app-toast-title').textContent = title || (type === 'error' ? 'Action failed' : 'Action completed');
  byId('app-toast-text').textContent = text;
  toast.className = `app-toast show ${type === 'error' ? 'app-toast-error' : 'app-toast-success'}`;
  if (state.toastTimer) clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove('show'), 4200);
}

function chip(label, variant) {
  return `<span class="status-chip ${variant}"><span class="dot"></span>${escapeHtml(label)}</span>`;
}

function applyChip(id, active, truthyLabel, falsyLabel) {
  const el = byId(id);
  if (!el) return;
  el.className = `status-chip ${active ? 'status-ok' : 'status-warn'}`;
  el.innerHTML = `<span class="dot"></span>${escapeHtml(active ? truthyLabel : falsyLabel)}`;
}

function renderTableBody(id, rowsHtml, colspan) {
  const tbody = document.querySelector(`#${id} tbody`);
  if (!tbody) return;
  tbody.innerHTML = rowsHtml || `<tr><td colspan="${colspan}" class="text-center text-muted py-4">No data.</td></tr>`;
}

function switchScreen(screen) {
  state.activeScreen = screen;
  document.querySelectorAll('[data-screen]').forEach((panel) => {
    panel.classList.toggle('active', panel.getAttribute('data-screen') === screen);
  });
  document.querySelectorAll('.nxl-navbar .nxl-item').forEach((item) => item.classList.remove('active'));
  document.querySelectorAll('[data-screen-nav]').forEach((link) => {
    const active = link.getAttribute('data-screen-nav') === screen;
    link.closest('.nxl-item')?.classList.toggle('active', active);
  });
  byId('breadcrumb-current').textContent = (screen || 'overview').replace(/-/g, ' ');
  if (screen === 'conversations' && state.conversationSummaries.length === 0) {
    loadConversationList(false);
  }
  if (screen === 'audit') {
    loadAuditStatsScreen();
  }
}

function setSendTestMode(mode) {
  const textMode = mode !== 'template';
  const textPanel = byId('test-text-panel');
  const templatePanel = byId('test-template-panel');
  const textButton = byId('send-test-text');
  const templateButton = byId('send-test-template');
  if (textPanel) textPanel.style.display = textMode ? '' : 'none';
  if (templatePanel) templatePanel.style.display = textMode ? 'none' : '';
  if (textButton) textButton.style.display = textMode ? '' : 'none';
  if (templateButton) templateButton.style.display = textMode ? 'none' : '';
  setValue('test_mode', textMode ? 'text' : 'template');
}

function applyPhoneMask(digits) {
  const d = String(digits || '').replace(/\D/g, '').slice(0, 13);
  if (d.length > 9) return `${d.slice(0,2)} (${d.slice(2,4)}) ${d.slice(4,9)}-${d.slice(9)}`;
  if (d.length > 4) return `${d.slice(0,2)} (${d.slice(2,4)}) ${d.slice(4)}`;
  if (d.length > 2) return `${d.slice(0,2)} (${d.slice(2)}`;
  return d;
}

function fillSettings(settings) {
  // Dev / Test Mode
  setCheckbox('dev_mode_enabled', settings.dev?.mode_enabled);
  setValue('dev_test_phone', applyPhoneMask(settings.dev?.test_phone));
  const devChip = byId('status-dev-chip');
  if (devChip) devChip.style.display = settings.dev?.mode_enabled ? '' : 'none';

  setSecret('w_access_token', settings.whatsapp.access_token);
  setValue('w_phone_number_id', settings.whatsapp.phone_number_id);
  setValue('w_business_account_id', settings.whatsapp.business_account_id);
  setSecret('w_webhook_verify_token', settings.whatsapp.webhook_verify_token);
  setValue('w_api_version', settings.whatsapp.api_version);
  setValue('w_webhook_domain', settings.whatsapp.webhook_domain);
  setSecret('abuse_key', settings.abuseipdb.api_key);
  setValue('global_allowlist', (settings.security.global_allowlist || []).join('\n'));
  setValue('yellow_threshold', settings.security.yellow_threshold);
  setValue('block_threshold', settings.security.block_threshold);
  setValue('ttl_minutes', settings.security.reputation_ttl_minutes);
  setValue('global_rate_limit', settings.security.global_rate_limit_per_minute);

  // Chatbot
  if (settings.chatbot) {
    setCheckbox('chatbot_enabled', settings.chatbot.enabled);
    setValue('chatbot_porteiro_url', settings.chatbot.porteiro_url);
    setSecret('chatbot_porteiro_token', settings.chatbot.porteiro_token);
    setValue('chatbot_unknown_message', settings.chatbot.unknown_message);
    setValue('chatbot_session_ttl_min', settings.chatbot.session_ttl_min);
    setValue('chatbot_relay_device_id', settings.chatbot.relay_device_id);
    setValue('chatbot_relay_door_num', settings.chatbot.relay_door_num);
    setValue('chatbot_relay_delay', settings.chatbot.relay_delay);
    setValue('chatbot_support_phones', settings.chatbot.support_phones);
    setCheckbox('chatbot_support_forward_unknown', settings.chatbot.support_forward_unknown);
    setCheckbox('chatbot_debug_errors', settings.chatbot.debug_errors);
  }
}

function renderOverview(data) {
  const clients = data.clients || [];
  const globalAllowlist = data.settings.security.global_allowlist || [];
  const clientAllowlistCount = clients.reduce((sum, client) => sum + ((client.allowed_ips || []).length), 0);

  byId('metric-clients').textContent = String(clients.length);
  byId('metric-blocked').textContent = String((data.blocked_ips || []).length);
  byId('metric-messages').textContent = String((data.messages || []).length);
  byId('metric-webhooks').textContent = String((data.webhooks || []).length);
  byId('overview-phone-id').textContent = data.settings.whatsapp.phone_number_id || '-';
  byId('overview-webhook-domain').textContent = data.settings.whatsapp.webhook_domain || '-';
  byId('overview-allowlist-count').textContent = String(globalAllowlist.length + clientAllowlistCount);

  applyChip('status-whatsapp-chip', Boolean(data.settings.whatsapp.phone_number_id && data.settings.whatsapp.api_version), 'WhatsApp ready', 'WhatsApp incomplete');
  applyChip('status-abuse-chip', Boolean(data.settings.abuseipdb.api_key), 'AbuseIPDB active', 'AbuseIPDB missing key');
  applyChip('status-business-chip', Boolean(data.settings.whatsapp.business_account_id), 'Business ID set', 'Business ID missing');
}

function renderClientSelect(clients) {
  const select = byId('allow_client_id');
  if (!select) return;
  const options = clients.map((client) => `<option value="${client.id}">${escapeHtml(client.name)}</option>`).join('');
  select.innerHTML = options || '<option value="">No clients</option>';
}

function renderClients(clients) {
  renderClientSelect(clients);
  const rows = clients.map((client) => `
    <tr>
      <td>
        <div class="fw-semibold">${escapeHtml(client.name)}</div>
        <div class="text-muted small">${escapeHtml(client.description || '')}</div>
      </td>
      <td>${client.status === 'active' ? chip('active', 'status-ok') : chip(client.status || 'inactive', 'status-warn')}</td>
      <td>${escapeHtml(String(client.rate_limit_per_minute || '-'))}/min</td>
      <td>${escapeHtml(formatDate(client.last_used_at))}</td>
      <td class="text-wrap">${(client.allowed_ips || []).length ? (client.allowed_ips || []).map((item) => `<div class="small mono">${escapeHtml(item.ip_or_cidr)}</div>`).join('') : '<span class="text-muted small">No allowlist</span>'}</td>
      <td>
        <div class="d-flex gap-2">
          <button class="btn btn-sm btn-light-brand" onclick="regenerateToken(${client.id},'${escapeHtml(client.name)}')">Regenerar token</button>
          <button class="btn btn-sm btn-danger" onclick="deleteClient(${client.id},'${escapeHtml(client.name)}')">Excluir</button>
        </div>
      </td>
    </tr>
  `).join('');
  renderTableBody('clients-table', rows, 6);
}

async function regenerateToken(id, name) {
  if (!confirm(`Regenerar token do cliente "${name}"?\nO token atual será invalidado imediatamente.`)) return;
  const data = await api(`/admin/api/clients/${id}/regenerate-token`, { method: 'POST', body: JSON.stringify({}) });
  const box = byId('token-reveal-box');
  const clientEl = byId('token-reveal-client');
  const tokenEl = byId('token-reveal-value');
  if (box && tokenEl) {
    if (clientEl) clientEl.textContent = name;
    tokenEl.textContent = data.plain_token;
    box.style.display = 'block';
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  await loadBootstrap();
  switchScreen('clients');
}

async function deleteClient(id, name) {
  if (!confirm(`Excluir cliente "${name}"?\nTodos os IPs permitidos também serão removidos.`)) return;
  await api(`/admin/api/clients/${id}`, { method: 'DELETE' });
  const box = byId('token-reveal-box');
  if (box) box.style.display = 'none';
  await loadBootstrap();
  showMessage(`Cliente "${name}" excluído.`);
  switchScreen('clients');
}

function renderSecurity(data) {
  const blockedRows = (data.blocked_ips || []).map((item) => `
    <tr>
      <td class="mono">${escapeHtml(item.ip)}</td>
      <td>${escapeHtml(item.reason || '-')}</td>
      <td>${escapeHtml(item.source || '-')}</td>
      <td>${escapeHtml(formatDate(item.updated_at))}</td>
    </tr>
  `).join('');
  renderTableBody('blocked-table', blockedRows, 4);

  const reputationRows = (data.ip_reputation || []).map((item) => `
    <tr>
      <td class="mono">${escapeHtml(item.ip)}</td>
      <td>${item.category === 'blacklist' ? chip('blacklist', 'status-warn') : item.category === 'yellowlist' ? chip('yellowlist', 'status-warn') : chip(item.category || 'whitelist', 'status-ok')}</td>
      <td>${escapeHtml(String(item.abuse_score ?? '-'))}</td>
      <td>${escapeHtml(formatDate(item.expires_at))}</td>
    </tr>
  `).join('');
  renderTableBody('reputation-table', reputationRows, 4);
}

function populateTemplateTestSelect() {
  const select = byId('test_template_name');
  if (!select) return;
  const options = state.loadedTemplates.map((item) => `<option value="${escapeHtml(item.name)}">${escapeHtml(item.name)}${item.language ? ` (${escapeHtml(item.language)})` : ''}</option>`).join('');
  select.innerHTML = options || '<option value="">Load templates first</option>';
}

function getSelectedTemplate() {
  const selectedName = getValue('test_template_name');
  return state.loadedTemplates.find((item) => item.name === selectedName) || null;
}

function extractTemplateVariables(text) {
  const matches = String(text || '').match(/{{\d+}}/g) || [];
  return Array.from(new Set(matches.map((item) => Number(item.replace(/[{}]/g, ''))))).sort((a, b) => a - b);
}

function buildTemplateComponentsFromInputs(template) {
  if (!template) return [];
  const components = [];
  const bodyComponent = (template.components || []).find((item) => String(item.type || '').toUpperCase() === 'BODY');
  const bodyVariables = extractTemplateVariables(bodyComponent?.text);
  if (bodyVariables.length) {
    components.push({
      type: 'body',
      parameters: bodyVariables.map((index) => ({
        type: 'text',
        text: getValue(`builder-body-${index}`),
      })),
    });
  }

  const buttonsComponent = (template.components || []).find((item) => String(item.type || '').toUpperCase() === 'BUTTONS');
  (buttonsComponent?.buttons || []).forEach((button, index) => {
    const kind = String(button.type || '').toUpperCase();
    if (kind === 'URL') {
      const value = getValue(`builder-button-${index}`);
      if (value) {
        components.push({
          type: 'button',
          sub_type: 'url',
          index: String(index),
          parameters: [{ type: 'text', text: value }],
        });
      }
    }
  });

  return components.filter((item) => (item.parameters || []).length > 0);
}

function syncTemplateComponentsJson() {
  const template = getSelectedTemplate();
  if (!template) return;
  const generated = buildTemplateComponentsFromInputs(template);
  setValue('test_template_components', generated.length ? JSON.stringify(generated, null, 2) : '[]');
}

function renderTemplateBuilder(template) {
  const container = byId('test-template-builder');
  if (!container) return;
  if (!template) {
    container.innerHTML = '<div class="col-12 text-muted small">Load templates and select one to generate helper fields.</div>';
    setValue('test_template_components', '');
    return;
  }

  const fields = [];
  const bodyComponent = (template.components || []).find((item) => String(item.type || '').toUpperCase() === 'BODY');
  const bodyVariables = extractTemplateVariables(bodyComponent?.text);
  bodyVariables.forEach((index) => {
    fields.push(`
      <div class="col-lg-6">
        <label class="form-label">Body variable ${index}</label>
        <input id="builder-body-${index}" class="form-control template-builder-input" data-builder-kind="body" data-builder-index="${index}" placeholder="Value for {{${index}}}">
      </div>
    `);
  });

  const buttonsComponent = (template.components || []).find((item) => String(item.type || '').toUpperCase() === 'BUTTONS');
  (buttonsComponent?.buttons || []).forEach((button, index) => {
    const kind = String(button.type || '').toUpperCase();
    if (kind === 'URL') {
      fields.push(`
        <div class="col-lg-6">
          <label class="form-label">Button URL variable ${index + 1}</label>
          <input id="builder-button-${index}" class="form-control template-builder-input" data-builder-kind="button" data-builder-index="${index}" placeholder="URL suffix or variable">
        </div>
      `);
    }
  });

  if (!fields.length) {
    container.innerHTML = '<div class="col-12 text-muted small">This template does not expose simple positional text variables. You can still edit the JSON manually below.</div>';
    setValue('test_template_components', '[]');
    return;
  }

  container.innerHTML = fields.join('');
  container.querySelectorAll('.template-builder-input').forEach((input) => {
    input.addEventListener('input', syncTemplateComponentsJson);
  });
  syncTemplateComponentsJson();
}

function syncSelectedTemplateMeta() {
  const selected = getSelectedTemplate();
  if (!selected) return;
  setValue('test_template_language', selected.language || '');
  renderTemplateBuilder(selected);
}

function renderTemplates(templates) {
  state.loadedTemplates = templates || [];
  populateTemplateTestSelect();
  syncSelectedTemplateMeta();
  const rows = (templates || []).map((item) => `
    <tr>
      <td>
        <div class="fw-semibold">${escapeHtml(item.name)}</div>
        <div class="small text-muted">${escapeHtml(item.category || '-')}</div>
      </td>
      <td>${escapeHtml(item.status || '-')}</td>
      <td>${escapeHtml(item.language || '-')}</td>
    </tr>
  `).join('');
  renderTableBody('templates-table', rows, 3);
}

function renderAutoReplies(autoReplies) {
  const container = byId('auto-replies-list');
  if (!container) return;
  if (!autoReplies.length) {
    container.innerHTML = '<div class="mini-item text-muted">No rules configured.</div>';
    return;
  }
  container.innerHTML = autoReplies.map((item) => `
    <div class="mini-item">
      <strong>${escapeHtml(item.name)}</strong>
      <div class="small text-muted mb-1">Match: ${escapeHtml(item.match_type)} | Status: ${escapeHtml(item.status)}</div>
      <div class="small">Keyword: <span class="mono">${escapeHtml(item.keyword)}</span></div>
      <div class="small mt-1">${escapeHtml(item.reply_text || item.template_name || '-')}</div>
    </div>
  `).join('');
}

// ── Audit helpers ─────────────────────────────────────────────────────────────

function normalizeConversationKey(value) {
  const s = String(value || '').trim() || 'unknown';
  // Normaliza números BR: 13 dígitos com 9° dígito → 12 dígitos
  if (s.length === 13 && s.startsWith('55') && s[4] === '9') {
    return s.slice(0, 4) + s.slice(5);
  }
  return s;
}

function formatConversationName(key) {
  if (!key || key === 'unknown') return 'Desconhecido';
  const m = key.match(/^55(\d{2})9?(\d{4})(\d{4})$/);
  if (m) return `(${m[1]}) ${m[2]}-${m[3]}`;
  const m2 = key.match(/^(\d{2})9?(\d{4})(\d{4})$/);
  if (m2) return `(${m2[1]}) ${m2[2]}-${m2[3]}`;
  return key;
}

function displayNameFor(phone) {
  const key = normalizeConversationKey(phone);
  return state.contactNames[key] || formatConversationName(key);
}

function conversationInitials(key) {
  const m = key.match(/^55(\d{2})/);
  if (m) return m[1];
  const digits = key.replace(/\D/g, '');
  if (digits.length >= 2) return digits.slice(0, 2);
  return 'WA';
}

const AVATAR_COLORS = [
  '#25D366','#128C7E','#075E54','#34B7F1',
  '#9C27B0','#F57C00','#E91E63','#1565C0',
  '#2E7D32','#00838F','#6A1B9A','#BF360C',
];

function avatarColor(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (Math.imul(31, h) + key.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

function formatMsgTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  if (now.toDateString() === d.toDateString()) {
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (yest.toDateString() === d.toDateString()) return 'ontem';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

const MSG_TYPE_ICON = {
  text: '💬',
  template: '📋',
  image: '🖼️',
  video: '🎥',
  audio: '🎵',
  document: '📄',
  sticker: '🪄',
};

function msgTypeIcon(type) {
  return MSG_TYPE_ICON[type] || '📨';
}

function statusChip(status) {
  if (status === 'sent') return '<span class="audit-chip chip-sent">✓ enviado</span>';
  if (status === 'failed') return '<span class="audit-chip chip-failed">✗ falha</span>';
  if (status === 'pending') return '<span class="audit-chip chip-pending">⏳ pendente</span>';
  return `<span class="audit-chip chip-muted">${escapeHtml(status)}</span>`;
}

function describeOutboundMessage(item) {
  if (item.message_type === 'text') return item.payload?.text?.body || 'Mensagem de texto';
  if (item.message_type === 'template') {
    const name = item.payload?.template?.name || 'template';
    const bodyParam = item.payload?.template?.components
      ?.find((c) => c.type === 'body')?.parameters?.[0]?.text;
    return bodyParam ? `${name} — ${bodyParam}` : name;
  }
  if (item.message_type === 'interactive') {
    const iv = item.payload?.interactive || {};
    const body = iv.body?.text || '';
    const buttons = iv.action?.buttons || [];
    const btnLabels = buttons.map((b) => b.reply?.title || b.reply?.id).filter(Boolean);
    const btnSummary = btnLabels.length ? `[${btnLabels.join(' · ')}]` : '(sem botões)';
    return body ? `${body.slice(0, 60)}${body.length > 60 ? '…' : ''} ${btnSummary}` : `Menu interativo ${btnSummary}`;
  }
  const mediaObj = item.payload?.[item.message_type];
  const caption = mediaObj?.caption;
  const filename = mediaObj?.filename;
  const label = caption || filename || '';
  return label ? `${item.message_type}: ${label}` : `${item.message_type}`;
}

function friendlyApiError(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  // WhatsApp API errors
  const msg = error.message || error.error?.message || error.error_data?.details
    || (typeof error === 'object' ? JSON.stringify(error) : String(error));
  const code = error.code ? ` (código ${error.code})` : '';
  return msg + code;
}

function formatPayloadDetails(item) {
  if (!item.payload) return '';
  const p = item.payload;
  const lines = [];
  if (item.direction === 'outbound') {
    if (item.message_type === 'text') {
      lines.push(`💬 <b>Texto:</b> ${escapeHtml(p.text?.body || '')}`);
    } else if (item.message_type === 'interactive') {
      const iv = p.interactive || {};
      lines.push(`📋 <b>Corpo:</b> ${escapeHtml(iv.body?.text || '(vazio)')}`);
      const btns = iv.action?.buttons || [];
      if (btns.length) {
        lines.push(`<b>Botões:</b>`);
        btns.forEach((b) => lines.push(`&nbsp;&nbsp;• ${escapeHtml(b.reply?.title || b.reply?.id || '?')} <span style="color:#94a3b8;font-size:10px">(id: ${escapeHtml(b.reply?.id || '')})</span>`));
      } else {
        lines.push(`<b>Botões:</b> <span style="color:#ef4444">nenhum configurado</span>`);
      }
    } else if (item.message_type === 'template') {
      const t = p.template || {};
      lines.push(`📄 <b>Template:</b> ${escapeHtml(t.name || '')} (${escapeHtml(t.language?.code || '')})`);
    } else {
      lines.push(`<pre style="font-size:10px;max-height:120px;overflow:auto">${escapeHtml(JSON.stringify(p, null, 2))}</pre>`);
    }
  } else {
    const value = p.entry?.[0]?.changes?.[0]?.value || {};
    const msg = value.messages?.[0];
    if (msg) {
      lines.push(`📨 <b>De:</b> ${escapeHtml(msg.from || '')} &nbsp;·&nbsp; <b>Tipo:</b> ${escapeHtml(msg.type || '')}`);
      if (msg.text?.body) lines.push(`💬 ${escapeHtml(msg.text.body)}`);
      if (msg.interactive) {
        const r = msg.interactive.button_reply || msg.interactive.list_reply;
        if (r) lines.push(`↩️ <b>Botão clicado:</b> ${escapeHtml(r.title || r.id)}`);
      }
    } else if (value.statuses?.length) {
      const s = value.statuses[0];
      lines.push(`📊 <b>Status:</b> ${escapeHtml(s.status)} &nbsp;·&nbsp; msg ${escapeHtml(s.id || '')}`);
    }
  }
  return lines.join('<br>');
}

function describeWebhookMessage(item) {
  const value = item.payload?.entry?.[0]?.changes?.[0]?.value || {};
  const message = value.messages?.[0];
  if (message?.type === 'text') return message.text?.body || 'Texto recebido';
  if (message?.type === 'button') return `↩️ ${message.button?.text || message.button?.payload || 'Botão'}`.trim();
  if (message?.type === 'interactive') {
    const reply = message.interactive?.button_reply || message.interactive?.list_reply;
    const txt = reply?.title || reply?.id || '';
    return txt ? `↩️ ${txt}` : '↩️ Resposta interativa';
  }
  if (message?.type === 'image') return '🖼️ Imagem recebida';
  if (message?.type === 'document') return '📄 Documento recebido';
  if (message?.type === 'audio') return '🎵 Áudio recebido';
  if (message?.type === 'video') return '🎥 Vídeo recebido';
  const statuses = value.statuses;
  if (statuses?.length) {
    const s = statuses[0];
    const st = s.status;
    const icon = st === 'delivered' ? '✓✓' : st === 'read' ? '👁️' : st === 'sent' ? '✓' : st === 'failed' ? '✗' : '';
    return `${icon} ${st}`.trim();
  }
  return item.event_type || 'Webhook';
}

function isStatusEvent(item) {
  const value = item.payload?.entry?.[0]?.changes?.[0]?.value || {};
  return Boolean(value.statuses?.length) && !value.messages?.length;
}

function buildConversations(data) {
  const map = new Map();
  const ensureConversation = (key) => {
    const normalizedKey = normalizeConversationKey(key);
    if (!map.has(normalizedKey)) {
      map.set(normalizedKey, {
        key: normalizedKey,
        title: displayNameFor(normalizedKey),
        isGroup: normalizedKey.includes('@g.us'),
        items: [],
        lastAt: '',
        outboundCount: 0,
        inboundCount: 0,
        failedCount: 0,
      });
    }
    return map.get(normalizedKey);
  };

  for (const item of data.messages || []) {
    const conversation = ensureConversation(item.to_number);
    const isDevRedirected = item.dev_redirected_to && item.dev_redirected_to !== item.to_number;
    conversation.items.push({
      id: `out-${item.id}`,
      rawId: item.id,
      direction: 'outbound',
      timestamp: item.created_at,
      status: item.status || 'pending',
      text: describeOutboundMessage(item),
      sublabel: item.message_type || 'message',
      devMode: isDevRedirected,
      devRedirectedTo: item.dev_redirected_to,
      clientRef: item.client_reference || '',
      metaId: item.meta_message_id || '',
      payload: item.payload,
      error: item.error,
    });
    conversation.outboundCount += 1;
    if (item.status === 'failed') conversation.failedCount += 1;
    if (!conversation.lastAt || conversation.lastAt < item.created_at) conversation.lastAt = item.created_at;
  }

  for (const item of data.webhooks || []) {
    if (isStatusEvent(item)) continue; // filter delivery status noise
    const conversation = ensureConversation(item.from_number || item.source_ip || 'unknown');
    conversation.items.push({
      id: `in-${item.id}`,
      rawId: item.id,
      direction: 'inbound',
      timestamp: item.created_at,
      status: item.event_type || 'received',
      text: describeWebhookMessage(item),
      sublabel: item.event_type || 'webhook',
      payload: item.payload,
    });
    conversation.inboundCount += 1;
    if (!conversation.lastAt || conversation.lastAt < item.created_at) conversation.lastAt = item.created_at;
  }

  return Array.from(map.values())
    .map((conversation) => {
      conversation.items.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
      const last = conversation.items[conversation.items.length - 1];
      conversation.preview = last?.text || 'Sem mensagens';
      conversation.previewStatus = last?.status;
      return conversation;
    })
    .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
}

function applyAuditFilter(conversations) {
  const f = state.auditFilter;
  if (f === 'all') return conversations;
  return conversations
    .map((conv) => {
      if (!conv.items.length) return conv; // summary-only: no items to filter
      const items = conv.items.filter((it) => it.status === f);
      if (!items.length) return null;
      return { ...conv, items };
    })
    .filter(Boolean);
}

function renderConversationList(conversations) {
  const container = byId('conversation-list');
  if (!container) return;
  const filtered = applyAuditFilter(conversations);
  if (!filtered.length) {
    container.innerHTML = '<div class="conversation-empty">Nenhum log encontrado.</div>';
    return;
  }
  if (!state.selectedConversationKey || !filtered.some((item) => item.key === state.selectedConversationKey)) {
    state.selectedConversationKey = filtered[0].key;
  }
  const byKey = new Map(filtered.map((c) => [c.key, c]));
  container.innerHTML = filtered.map((conversation) => {
    const isActive = conversation.key === state.selectedConversationKey;
    const color = avatarColor(conversation.key);
    const initials = conversationInitials(conversation.key);
    const time = formatMsgTime(conversation.lastAt);
    const isFailed = conversation.previewStatus === 'failed';
    const lastSeenAt = state.readConversations[conversation.key];
    // Só mostra badge se houver atividade (mensagem/falha) mais recente do que a última vez que a conversa foi aberta
    const hasUnseenActivity = !lastSeenAt || (conversation.lastAt && conversation.lastAt > lastSeenAt);
    const badge = !hasUnseenActivity ? '' : (
      conversation.inboundCount > 0
        ? `<span class="wa-badge">${conversation.inboundCount}</span>`
        : conversation.failedCount > 0
          ? `<span class="wa-badge wa-badge-fail">${conversation.failedCount}</span>`
          : ''
    );
    const previewIcon = isFailed ? '✗ ' : '';
    return `
    <div class="wa-item${isActive ? ' active' : ''}" data-conversation-key="${escapeHtml(conversation.key)}">
      <div class="wa-avatar" style="background:${color}">${escapeHtml(initials)}</div>
      <div class="wa-body">
        <div class="wa-top">
          <span class="wa-name">${escapeHtml(conversation.title)}</span>
          <span class="wa-time${isFailed ? ' wa-time-fail' : ''}">${escapeHtml(time)}</span>
        </div>
        <div class="wa-bottom">
          <span class="wa-preview${isFailed ? ' wa-preview-fail' : ''}">${escapeHtml(previewIcon + conversation.preview)}</span>
          ${badge}
        </div>
      </div>
    </div>`;
  }).join('');
  container.querySelectorAll('[data-conversation-key]').forEach((el) => {
    el.addEventListener('click', () => {
      const key = el.getAttribute('data-conversation-key');
      state.readConversations[key] = byKey.get(key)?.lastAt || new Date().toISOString();
      state.selectedConversationKey = key;
      state.expandedBubble = null;
      renderCurrentConvList();
      loadAndShowThread(key);
    });
  });
}

function renderConversationThread(conversations) {
  const thread = byId('conversation-thread');
  const title = byId('conversation-title');
  const subtitle = byId('conversation-subtitle');
  const meta = byId('conversation-meta');
  if (!thread || !title || !subtitle || !meta) return;
  const filtered = applyAuditFilter(conversations);
  const conversation = filtered.find((item) => item.key === state.selectedConversationKey);
  if (!conversation) {
    title.textContent = 'Nenhuma conversa selecionada';
    subtitle.textContent = 'Selecione um número à esquerda para inspecionar o histórico.';
    meta.textContent = '';
    thread.innerHTML = '<div class="conversation-empty">Nenhuma conversa disponível.</div>';
    updateComposerState(null);
    const renameBtn0 = byId('conversation-rename-btn');
    if (renameBtn0) renameBtn0.style.display = 'none';
    return;
  }
  title.textContent = conversation.title;
  const avatarEl = byId('conversation-avatar');
  if (avatarEl) {
    avatarEl.style.background = avatarColor(conversation.key);
    avatarEl.textContent = conversationInitials(conversation.key);
  }
  updateComposerState(conversation.key);
  const renameBtn = byId('conversation-rename-btn');
  if (renameBtn) renameBtn.style.display = '';
  subtitle.textContent = conversation.isGroup
    ? 'Timeline agrupada para um grupo WhatsApp.'
    : `${conversation.outboundCount} enviadas · ${conversation.inboundCount} recebidas${conversation.failedCount ? ` · <span style="color:#ef4444">${conversation.failedCount} falhas</span>` : ''}`;
  meta.innerHTML = `<div class="small text-muted">${conversation.items.length} eventos</div>`;

  thread.innerHTML = conversation.items.map((item) => {
    const isExpanded = state.expandedBubble === item.id;
    const isFailed = item.status === 'failed';
    const extraClasses = [
      item.devMode ? 'bubble-dev' : '',
      isFailed ? 'bubble-failed' : '',
    ].filter(Boolean).join(' ');

    const payloadHtml = isExpanded && item.payload
      ? `<div class="bubble-payload">${formatPayloadDetails(item)}</div>`
      : '';
    const errorHtml = isExpanded && item.error
      ? `<div class="bubble-error-detail">⚠️ ${escapeHtml(friendlyApiError(item.error))}</div>`
      : '';

    const metaIdHtml = item.metaId
      ? `<span class="mono" title="${escapeHtml(item.metaId)}">${escapeHtml(item.metaId.slice(-12))}</span>`
      : '';
    const clientRefHtml = item.clientRef
      ? `<span class="bubble-ref" title="${escapeHtml(item.clientRef)}">${escapeHtml(item.clientRef.slice(0, 28))}</span>`
      : '';

    return `
    <div class="bubble-row ${item.direction}" data-bubble-id="${escapeHtml(item.id)}">
      <div class="bubble ${item.direction} ${extraClasses}">
        ${item.devMode ? `<div class="dev-badge">DEV → ${escapeHtml(item.devRedirectedTo || '')}</div>` : ''}
        <div class="bubble-text">${
          item.direction === 'inbound' && (item.sublabel === 'messages' || item.sublabel === 'webhook') && item.text.startsWith('↩️')
            ? `<span class="bubble-btn-reply">${escapeHtml(item.text)}</span>`
            : `${msgTypeIcon(item.sublabel)} ${escapeHtml(item.text)}`
        }</div>
        <div class="bubble-meta">
          <span>${statusChip(item.status)} ${escapeHtml(item.sublabel)}</span>
          <span title="${escapeHtml(formatDate(item.timestamp))}">${escapeHtml(relativeTime(item.timestamp))} ${metaIdHtml}</span>
        </div>
        ${clientRefHtml ? `<div class="bubble-ref-row">${clientRefHtml}</div>` : ''}
        ${payloadHtml}${errorHtml}
        <button class="bubble-expand-btn" data-bid="${escapeHtml(item.id)}">${isExpanded ? '▲ ocultar' : '▾ detalhes'}</button>
      </div>
    </div>`;
  }).join('');

  thread.querySelectorAll('.bubble-expand-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const bid = btn.getAttribute('data-bid');
      state.expandedBubble = state.expandedBubble === bid ? null : bid;
      renderCurrentThread();
    });
  });
}

function renderAudit(data) {
  // Filter bar
  const filterBar = byId('audit-filter-bar');
  if (filterBar && !filterBar.dataset.bound) {
    filterBar.dataset.bound = '1';
    filterBar.querySelectorAll('[data-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.auditFilter = btn.getAttribute('data-filter');
        state.expandedBubble = null;
        filterBar.querySelectorAll('[data-filter]').forEach((b) => b.classList.toggle('active', b === btn));
        renderCurrentConvList();
        renderCurrentThread();
      });
    });
  }

  // Refresh button
  const refreshBtn = byId('audit-refresh-btn');
  if (refreshBtn && !refreshBtn.dataset.bound) {
    refreshBtn.dataset.bound = '1';
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      refreshBtn.textContent = '↻ carregando…';
      state.conversationSummaries = [];
      state.conversationOffset = 0;
      state.threadCache = {};
      await loadConversationList(false);
      refreshBtn.disabled = false;
      refreshBtn.textContent = '↻ atualizar';
    });
  }

  // Auto-refresh toggle
  const autoRefreshBtn = byId('audit-auto-refresh-btn');
  const autoRefreshLabel = byId('audit-last-refresh');
  if (autoRefreshBtn && !autoRefreshBtn.dataset.bound) {
    autoRefreshBtn.dataset.bound = '1';

    function updateAutoRefreshLabel() {
      if (autoRefreshLabel && state.auditLastRefresh) {
        autoRefreshLabel.textContent = `Atualizado: ${state.auditLastRefresh.toLocaleTimeString('pt-BR')}`;
      }
    }

    function startAutoRefresh() {
      if (state.auditAutoRefreshTimer) return;
      state.auditAutoRefreshTimer = setInterval(async () => {
        state.conversationSummaries = [];
        state.conversationOffset = 0;
        state.threadCache = {};
        await loadConversationList(false);
        state.auditLastRefresh = new Date();
        updateAutoRefreshLabel();
      }, 30000);
      autoRefreshBtn.classList.add('active');
      autoRefreshBtn.title = 'Auto-atualização ativa (30s) — clique para desativar';
    }

    function stopAutoRefresh() {
      if (state.auditAutoRefreshTimer) {
        clearInterval(state.auditAutoRefreshTimer);
        state.auditAutoRefreshTimer = null;
      }
      autoRefreshBtn.classList.remove('active');
      if (autoRefreshLabel) autoRefreshLabel.textContent = '';
      autoRefreshBtn.title = 'Ativar auto-atualização a cada 30s';
    }

    autoRefreshBtn.addEventListener('click', () => {
      if (state.auditAutoRefreshTimer) stopAutoRefresh(); else startAutoRefresh();
    });
  }

  loadConversationList(false);

  const actionRows = (data.actions || []).map((item) => `
    <tr>
      <td>${escapeHtml(item.action)}</td>
      <td>${escapeHtml(item.target_type)}:${escapeHtml(item.target_id || '-')}</td>
      <td title="${escapeHtml(formatDate(item.created_at))}">${escapeHtml(relativeTime(item.created_at))}</td>
    </tr>
  `).join('');
  renderTableBody('actions-table', actionRows, 3);
}

function fillDashboard(data) {
  state.bootstrap = data;
  fillSettings(data.settings);
  renderOverview(data);
  renderClients(data.clients || []);
  renderSecurity(data);
  renderTemplates(state.loadedTemplates);
  renderAutoReplies(data.auto_replies || []);
  renderAudit(data);
}

async function loadBootstrap(showToast = false) {
  const data = await api('/admin/api/bootstrap');
  fillDashboard(data);
  if (showToast) showMessage('Dashboard refreshed.');
}

function buildSettingsPayload() {
  return {
    dev: {
      mode_enabled: getCheckbox('dev_mode_enabled'),
      test_phone: getValue('dev_test_phone'),
    },
    whatsapp: {
      access_token: getValue('w_access_token'),
      phone_number_id: getValue('w_phone_number_id'),
      business_account_id: getValue('w_business_account_id'),
      webhook_verify_token: getValue('w_webhook_verify_token'),
      api_version: getValue('w_api_version'),
      webhook_domain: getValue('w_webhook_domain'),
    },
    abuseipdb: { api_key: getValue('abuse_key') },
    security: {
      global_allowlist: getValue('global_allowlist').split('\n').map((item) => item.trim()).filter(Boolean),
      yellow_threshold: Number(getValue('yellow_threshold') || 25),
      block_threshold: Number(getValue('block_threshold') || 75),
      reputation_ttl_minutes: Number(getValue('ttl_minutes') || 1440),
      global_rate_limit_per_minute: Number(getValue('global_rate_limit') || 120),
    },
  };
}

async function onSaveSettings() {
  const devEnabled = getCheckbox('dev_mode_enabled');
  const devPhone = getValue('dev_test_phone').replace(/\D/g, '');
  if (devEnabled) {
    if (!devPhone) {
      showMessage('Informe o número de teste antes de ativar o Dev Mode.', 'error', 'Campo obrigatório');
      byId('dev_test_phone')?.focus();
      return;
    }
    if (devPhone.length < 10 || devPhone.length > 15) {
      showMessage('Número de teste inválido. Use o formato com DDI (ex: 5542999999999).', 'error', 'Número inválido');
      byId('dev_test_phone')?.focus();
      return;
    }
  }
  // Garante que só dígitos são enviados
  if (byId('dev_test_phone')) byId('dev_test_phone').value = devPhone;
  await api('/admin/api/settings', { method: 'POST', body: JSON.stringify(buildSettingsPayload()) });
  await loadBootstrap();
  showMessage('Settings saved.');
}

async function onCreateClient() {
  const name = getValue('client_name');
  const data = await api('/admin/api/clients', {
    method: 'POST',
    body: JSON.stringify({
      name,
      description: getValue('client_description'),
      rate_limit_per_minute: Number(getValue('client_rate_limit') || 60),
    }),
  });
  await loadBootstrap();
  // Exibe token no box persistente
  const box = byId('token-reveal-box');
  const clientEl = byId('token-reveal-client');
  const tokenEl = byId('token-reveal-value');
  if (box && tokenEl) {
    if (clientEl) clientEl.textContent = name;
    tokenEl.textContent = data.plain_token;
    box.style.display = 'block';
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  // Limpa formulário
  setValue('client_name', '');
  setValue('client_description', '');
  setValue('client_rate_limit', '60');
  switchScreen('clients');
}

function copyToken() {
  const token = byId('token-reveal-value')?.textContent || '';
  if (!token) return;
  navigator.clipboard.writeText(token).then(() => {
    showMessage('Token copiado para a área de transferência!');
  }).catch(() => {
    prompt('Copie o token manualmente:', token);
  });
}

async function onAllowClientIp() {
  const clientId = getValue('allow_client_id');
  if (!clientId) throw new Error('Select a client.');
  await api(`/admin/api/clients/${clientId}/allow-ip`, {
    method: 'POST',
    body: JSON.stringify({
      ip_or_cidr: getValue('allow_ip_or_cidr'),
      notes: getValue('allow_ip_notes'),
    }),
  });
  setValue('allow_ip_or_cidr', '');
  setValue('allow_ip_notes', '');
  await loadBootstrap();
  showMessage('Allowed IP added to client.');
}

async function onRecheckIp() {
  await api('/admin/api/security/ip/recheck', { method: 'POST', body: JSON.stringify({ ip: getValue('security_ip') }) });
  await loadBootstrap();
  showMessage('IP rechecked.');
  switchScreen('security');
}

async function onBlockIp() {
  await api('/admin/api/security/ip/block', {
    method: 'POST',
    body: JSON.stringify({ ip: getValue('security_ip'), reason: 'Manual block from admin dashboard.' }),
  });
  await loadBootstrap();
  showMessage('IP blocked.');
  switchScreen('security');
}

async function onUnblockIp() {
  await api('/admin/api/security/ip/unblock', { method: 'POST', body: JSON.stringify({ ip: getValue('security_ip') }) });
  await loadBootstrap();
  showMessage('IP unblocked.');
  switchScreen('security');
}

async function onLoadTemplates() {
  const query = new URLSearchParams();
  const filters = {
    name: getValue('template_name_filter'),
    status: getValue('template_status_filter'),
    language: getValue('template_language_filter'),
    category: getValue('template_category_filter'),
  };
  Object.entries(filters).forEach(([key, value]) => {
    if (value) query.set(key, value);
  });
  const suffix = query.toString() ? `?${query.toString()}` : '';
  const data = await api(`/admin/api/templates${suffix}`);
  renderTemplates(data.data || []);
  showMessage(`Templates loaded: ${(data.data || []).length}.`);
  switchScreen('templates');
}

async function onSendTestText() {
  const data = await api('/admin/api/send/test/text', {
    method: 'POST',
    body: JSON.stringify({
      to: getValue('test_to'),
      text: getValue('test_text'),
    }),
  });
  byId('send-output').textContent = JSON.stringify(data.data, null, 2);
  await loadBootstrap();
  showMessage('Text test completed.');
  switchScreen('send-test');
}

function parseTemplateComponents() {
  const raw = getValue('test_template_components');
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Components JSON is invalid.');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Components JSON must be an array.');
  }
  return parsed;
}

async function onSendTestTemplate() {
  const templateName = getValue('test_template_name');
  const languageCode = getValue('test_template_language');
  if (!templateName) throw new Error('Select a template first.');
  if (!languageCode) throw new Error('Template language is required.');
  const data = await api('/admin/api/send/test/template', {
    method: 'POST',
    body: JSON.stringify({
      to: getValue('test_to'),
      template_name: templateName,
      language_code: languageCode,
      components: parseTemplateComponents(),
    }),
  });
  byId('send-output').textContent = JSON.stringify(data.data, null, 2);
  await loadBootstrap();
  showMessage('Template test completed.');
  switchScreen('send-test');
}

async function onSaveAutoReply() {
  await api('/admin/api/auto-replies', {
    method: 'POST',
    body: JSON.stringify({
      name: getValue('reply_name'),
      keyword: getValue('reply_keyword'),
      match_type: getValue('reply_match_type'),
      reply_type: 'text',
      reply_text: getValue('reply_text'),
      status: 'active',
    }),
  });
  setValue('reply_name', '');
  setValue('reply_keyword', '');
  setValue('reply_text', '');
  await loadBootstrap();
  showMessage('Auto reply rule saved.');
  switchScreen('auto-replies');
}

async function onSaveChatbot() {
  const payload = {
    chatbot: {
      enabled: getCheckbox('chatbot_enabled'),
      porteiro_url: getValue('chatbot_porteiro_url'),
      porteiro_token: getValue('chatbot_porteiro_token'),
      unknown_message: getValue('chatbot_unknown_message'),
      session_ttl_min: Number(getValue('chatbot_session_ttl_min') || 5),
      relay_device_id: getValue('chatbot_relay_device_id'),
      relay_door_num: Number(getValue('chatbot_relay_door_num') || 1),
      relay_delay: Number(getValue('chatbot_relay_delay') || 5),
      support_phones: getValue('chatbot_support_phones'),
      support_forward_unknown: getCheckbox('chatbot_support_forward_unknown'),
      debug_errors: getCheckbox('chatbot_debug_errors'),
    },
  };
  await api('/admin/api/settings', { method: 'POST', body: JSON.stringify(payload) });
  showMessage('Configurações do chatbot salvas!');
}

function bindEvents() {
  byId('save-settings')?.addEventListener('click', () => runAction(onSaveSettings));
  byId('save-chatbot')?.addEventListener('click', () => runAction(onSaveChatbot));
  byId('refresh-all')?.addEventListener('click', () => runAction(() => loadBootstrap(true)));

  document.querySelectorAll('[data-chatbot-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tabId = btn.dataset.chatbotTab;
      document.querySelectorAll('.chatbot-tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('#chatbot-settings-tab,#chatbot-flow-tab').forEach((p) => { p.style.display = 'none'; });
      const panel = document.getElementById(tabId);
      if (panel) panel.style.display = '';
      const saveBtn = document.getElementById('save-chatbot');
      if (saveBtn) saveBtn.style.display = tabId === 'chatbot-settings-tab' ? '' : 'none';
      if (tabId === 'chatbot-flow-tab') { runAction(loadChatbotFlow); liveRefreshCanvasTokens(); }
    });
  });
  byId('create-client')?.addEventListener('click', () => runAction(onCreateClient));
  byId('allow-client-ip')?.addEventListener('click', () => runAction(onAllowClientIp));
  byId('recheck-ip')?.addEventListener('click', () => runAction(onRecheckIp));
  byId('block-ip')?.addEventListener('click', () => runAction(onBlockIp));
  byId('unblock-ip')?.addEventListener('click', () => runAction(onUnblockIp));
  byId('load-templates')?.addEventListener('click', () => runAction(onLoadTemplates));
  byId('send-test-text')?.addEventListener('click', () => runAction(onSendTestText));
  byId('send-test-template')?.addEventListener('click', () => runAction(onSendTestTemplate));
  byId('save-auto-reply')?.addEventListener('click', () => runAction(onSaveAutoReply));

  // Composer (Conversas)
  byId('wa-composer-send-text')?.addEventListener('click', () => runAction(onComposerSendText));
  byId('wa-composer-text')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      runAction(onComposerSendText);
    }
  });
  byId('wa-composer-toggle-template')?.addEventListener('click', () => setComposerMode('template'));
  byId('wa-composer-toggle-text')?.addEventListener('click', () => setComposerMode('text'));
  byId('wa-composer-template-select')?.addEventListener('change', renderComposerTemplateParams);
  byId('wa-composer-send-template')?.addEventListener('click', () => runAction(onComposerSendTemplate));
  byId('conversation-rename-btn')?.addEventListener('click', () => runAction(onConversationRename));
  byId('wa-jump-latest')?.addEventListener('click', () => _scrollThreadToBottom());
  byId('conversation-thread')?.addEventListener('scroll', () => _updateJumpToLatestVisibility());

  // Auditoria (estatísticas)
  byId('audit-stats-refresh-btn')?.addEventListener('click', () => runAction(loadAuditStatsScreen));
  byId('audit-stats-range')?.addEventListener('change', () => {
    state.auditStatsRange = getValue('audit-stats-range') || 'all';
    state.auditLogOffset = 0;
    runAction(loadAuditStatsScreen);
  });
  byId('audit-log-filter-btn')?.addEventListener('click', () => {
    state.auditLogFilters.status = getValue('audit-log-status');
    state.auditLogFilters.phone = getValue('audit-log-phone');
    state.auditLogOffset = 0;
    runAction(loadAuditLogTable);
  });
  byId('audit-log-prev-btn')?.addEventListener('click', () => {
    state.auditLogOffset = Math.max(0, state.auditLogOffset - state.auditLogLimit);
    runAction(loadAuditLogTable);
  });
  byId('audit-log-next-btn')?.addEventListener('click', () => {
    state.auditLogOffset += state.auditLogLimit;
    runAction(loadAuditLogTable);
  });
  byId('test_mode')?.addEventListener('change', () => setSendTestMode(getValue('test_mode')));
  byId('test_template_name')?.addEventListener('change', syncSelectedTemplateMeta);
  byId('dev_test_phone')?.addEventListener('input', () => {
    const el = byId('dev_test_phone');
    const digits = el.value.replace(/\D/g, '').slice(0, 13);
    // Máscara: 55 (42) 99999-9999
    let masked = digits;
    if (digits.length > 9) {
      masked = `${digits.slice(0,2)} (${digits.slice(2,4)}) ${digits.slice(4,9)}-${digits.slice(9)}`;
    } else if (digits.length > 4) {
      masked = `${digits.slice(0,2)} (${digits.slice(2,4)}) ${digits.slice(4)}`;
    } else if (digits.length > 2) {
      masked = `${digits.slice(0,2)} (${digits.slice(2)}`;
    }
    el.value = masked;
  });
  document.querySelectorAll('[data-screen-nav]').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const screen = link.getAttribute('data-screen-nav');
      switchScreen(screen);
      if (screen === 'users') loadUsersScreen();
    });
  });
}

// ── Audit: conversas agrupadas com carregamento lazy ──────────────────────────

function buildConversationFromSummary(s) {
  const fakeItem = s.last_direction === 'outbound'
    ? { message_type: s.last_sublabel, payload: s.last_payload || {} }
    : { payload: s.last_payload || {}, event_type: s.last_sublabel };
  const preview = s.last_direction === 'outbound'
    ? describeOutboundMessage(fakeItem)
    : describeWebhookMessage(fakeItem);
  return {
    key: String(s.phone),
    title: displayNameFor(String(s.phone)),
    isGroup: String(s.phone).includes('@g.us'),
    items: [],
    lastAt: s.last_at,
    outboundCount: s.outbound_count || 0,
    inboundCount: s.inbound_count || 0,
    failedCount: s.failed_count || 0,
    preview: preview || 'Sem mensagens',
    previewStatus: s.last_direction === 'outbound' ? (s.last_status || 'sent') : 'received',
  };
}

function renderCurrentConvList() {
  const convObjects = state.conversationSummaries.map(buildConversationFromSummary);
  renderConversationList(convObjects);
  _updateConvLoadMoreBtn();
}

function renderCurrentThread() {
  const phone = state.selectedConversationKey;
  const threadEl = byId('conversation-thread');
  if (state.threadLoading) {
    if (threadEl) threadEl.innerHTML = '<div class="conversation-empty">⏳ Carregando conversa...</div>';
    return;
  }
  if (!phone || !state.threadCache[phone]) {
    renderConversationThread([]);
    return;
  }
  const cached = state.threadCache[phone];
  const conversations = buildConversations({ messages: cached.messages, webhooks: cached.webhooks });
  renderConversationThread(conversations);
}

async function resolveContactNamesFor(phones) {
  const unique = [...new Set((phones || []).map(String))]
    .filter((p) => !(normalizeConversationKey(p) in state.contactNames));
  if (!unique.length) return;
  try {
    const resp = await api('/admin/api/contacts/resolve', {
      method: 'POST',
      body: JSON.stringify({ phones: unique }),
    });
    let changed = false;
    for (const [phone, contact] of Object.entries(resp.data || {})) {
      if (contact?.name) {
        state.contactNames[normalizeConversationKey(phone)] = contact.name;
        changed = true;
      }
    }
    if (changed) {
      renderCurrentConvList();
      renderCurrentThread();
    }
  } catch (e) {
    // Nome é um "nice to have" — não deve travar a tela de conversas.
    console.warn('contacts resolve failed', e.message);
  }
}

async function loadConversationList(append = false) {
  if (state.conversationLoading) return;
  state.conversationLoading = true;
  // Disable existing btn during fetch (it may have been rendered inside list)
  const existingBtn = byId('audit-load-more-btn');
  if (existingBtn) { existingBtn.disabled = true; existingBtn.textContent = '⏳ Carregando...'; }
  try {
    const offset = append ? state.conversationOffset : 0;
    const resp = await api(`/admin/api/audit/conversations?limit=50&offset=${offset}`);
    if (append) {
      state.conversationSummaries = [...state.conversationSummaries, ...resp.data];
    } else {
      state.conversationSummaries = resp.data;
    }
    state.conversationTotal = resp.total ?? state.conversationSummaries.length;
    state.conversationOffset = state.conversationSummaries.length;
    renderCurrentConvList(); // renders list + button
    resolveContactNamesFor(state.conversationSummaries.map((s) => s.phone));
    // Auto-select first conversation or reload cached thread
    if (state.conversationSummaries.length) {
      const currentValid = state.selectedConversationKey &&
        state.conversationSummaries.some((s) => s.phone === state.selectedConversationKey);
      const targetPhone = currentValid ? state.selectedConversationKey : state.conversationSummaries[0].phone;
      if (!currentValid) {
        state.selectedConversationKey = targetPhone;
        renderCurrentConvList(); // re-render with active state
      }
      if (!state.threadCache[targetPhone]) {
        loadAndShowThread(targetPhone);
      } else {
        renderCurrentThread();
        _scrollThreadToBottom();
      }
    }
  } catch (e) {
    showMessage(e.message, 'error');
    state.conversationLoading = false;
    _updateConvLoadMoreBtn();
    return;
  }
  state.conversationLoading = false;
  _updateConvLoadMoreBtn();
}

async function loadAndShowThread(phone) {
  if (state.threadCache[phone]) {
    renderCurrentThread();
    _scrollThreadToBottom();
    return;
  }
  state.threadLoading = true;
  renderCurrentThread();
  try {
    const data = await api(`/admin/api/audit/conversation/${encodeURIComponent(phone)}`);
    state.threadCache[phone] = data;
  } catch (e) {
    showMessage(e.message, 'error');
  } finally {
    state.threadLoading = false;
    renderCurrentThread();
    _scrollThreadToBottom();
  }
}

function _scrollThreadToBottom() {
  const threadEl = byId('conversation-thread');
  if (!threadEl) return;
  // Double rAF: garante que o layout já assentou (evita scrollHeight desatualizado)
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      threadEl.scrollTop = threadEl.scrollHeight;
      _updateJumpToLatestVisibility();
    });
  });
}

function _updateJumpToLatestVisibility() {
  const threadEl = byId('conversation-thread');
  const jumpBtn = byId('wa-jump-latest');
  if (!threadEl || !jumpBtn) return;
  const distanceFromBottom = threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight;
  jumpBtn.style.display = distanceFromBottom > 120 ? 'block' : 'none';
}

// ── Composer (enviar mensagem pela tela de Conversas) ─────────────────────────

function updateComposerState(phone) {
  const composer = byId('wa-composer');
  if (!composer) return;
  if (!phone) { composer.style.display = 'none'; return; }
  composer.style.display = 'block';

  const cached = state.threadCache[phone];
  const webhooks = cached?.webhooks || [];
  const lastInboundAt = webhooks.length ? webhooks[webhooks.length - 1].created_at : null;
  const withinWindow = Boolean(lastInboundAt) && (Date.now() - new Date(lastInboundAt).getTime()) < 24 * 3600 * 1000;

  const warningEl = byId('wa-composer-warning');
  const textInput = byId('wa-composer-text');
  const sendTextBtn = byId('wa-composer-send-text');
  if (warningEl) {
    warningEl.style.display = withinWindow ? 'none' : 'block';
    if (!withinWindow) {
      warningEl.textContent = '⚠️ Fora da janela de 24h do WhatsApp — este número não respondeu nas últimas 24h. Use um template aprovado (botão "📋 Template") para reabrir a conversa.';
    }
  }
  if (textInput) textInput.disabled = !withinWindow;
  if (sendTextBtn) sendTextBtn.disabled = !withinWindow;
}

function setComposerMode(mode) {
  state.composerMode = mode;
  const textRow = byId('wa-composer-text-row');
  const templateRow = byId('wa-composer-template-row');
  if (textRow) textRow.style.display = mode === 'text' ? 'flex' : 'none';
  if (templateRow) templateRow.style.display = mode === 'template' ? 'flex' : 'none';
  if (mode === 'template') loadComposerTemplates();
}

async function loadComposerTemplates() {
  const select = byId('wa-composer-template-select');
  if (!select) return;
  if (!state.loadedTemplates.length) {
    try {
      const data = await api('/admin/api/templates');
      state.loadedTemplates = data.data || [];
    } catch (e) {
      showMessage(e.message, 'error');
      return;
    }
  }
  select.innerHTML = state.loadedTemplates.map((item) =>
    `<option value="${escapeHtml(item.name)}" data-language="${escapeHtml(item.language || '')}">${escapeHtml(item.name)}${item.language ? ` (${escapeHtml(item.language)})` : ''}</option>`
  ).join('') || '<option value="">Nenhum template carregado</option>';
  renderComposerTemplateParams();
}

function renderComposerTemplateParams() {
  const select = byId('wa-composer-template-select');
  const container = byId('wa-composer-template-params');
  if (!select || !container) return;
  const template = state.loadedTemplates.find((t) => t.name === select.value);
  if (!template) { container.innerHTML = ''; return; }
  const bodyComponent = (template.components || []).find((c) => String(c.type || '').toUpperCase() === 'BODY');
  const variables = extractTemplateVariables(bodyComponent?.text);
  const suggestedName = state.selectedConversationKey ? displayNameFor(state.selectedConversationKey) : '';
  container.innerHTML = variables.map((index) => `
    <input id="wa-composer-body-${index}" class="wa-composer-select" style="max-width:160px;display:inline-block"
      placeholder="{{${index}}}" value="${index === 1 ? escapeHtml(suggestedName) : ''}">
  `).join('');
}

function buildComposerTemplateComponents(template) {
  if (!template) return [];
  const bodyComponent = (template.components || []).find((c) => String(c.type || '').toUpperCase() === 'BODY');
  const variables = extractTemplateVariables(bodyComponent?.text);
  if (!variables.length) return [];
  return [{
    type: 'body',
    parameters: variables.map((index) => ({ type: 'text', text: getValue(`wa-composer-body-${index}`) })),
  }];
}

async function onComposerSendText() {
  const phone = state.selectedConversationKey;
  if (!phone) return;
  const textEl = byId('wa-composer-text');
  const text = (textEl?.value || '').trim();
  if (!text) return;
  const sendBtn = byId('wa-composer-send-text');
  if (sendBtn) sendBtn.disabled = true;
  try {
    await api(`/admin/api/conversation/${encodeURIComponent(phone)}/send-text`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    if (textEl) textEl.value = '';
    delete state.threadCache[phone];
    await loadAndShowThread(phone);
    showMessage('Mensagem enviada.');
  } catch (e) {
    if (e.code === 'outside_24h_window') setComposerMode('template');
    showMessage(e.message, 'error');
  } finally {
    if (sendBtn) sendBtn.disabled = false;
  }
}

async function onComposerSendTemplate() {
  const phone = state.selectedConversationKey;
  if (!phone) return;
  const select = byId('wa-composer-template-select');
  const name = select?.value;
  if (!name) { showMessage('Selecione um template.', 'error'); return; }
  const template = state.loadedTemplates.find((t) => t.name === name);
  const language = template?.language || select.selectedOptions?.[0]?.dataset.language || 'pt_BR';
  const btn = byId('wa-composer-send-template');
  if (btn) btn.disabled = true;
  try {
    await api(`/admin/api/conversation/${encodeURIComponent(phone)}/send-template`, {
      method: 'POST',
      body: JSON.stringify({
        template_name: name,
        language_code: language,
        components: buildComposerTemplateComponents(template),
      }),
    });
    delete state.threadCache[phone];
    await loadAndShowThread(phone);
    showMessage('Template enviado.');
    setComposerMode('text');
  } catch (e) {
    showMessage(e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function onConversationRename() {
  const phone = state.selectedConversationKey;
  if (!phone) return;
  const key = normalizeConversationKey(phone);
  const current = state.contactNames[key] || '';
  const name = prompt('Nome do contato:', current);
  if (name === null || !name.trim()) return;
  await runAction(async () => {
    await api(`/admin/api/contacts/${encodeURIComponent(phone)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: name.trim() }),
    });
    state.contactNames[key] = name.trim();
    renderCurrentConvList();
    renderCurrentThread();
    showMessage('Nome atualizado.');
  });
}

// ── Auditoria (estatísticas) ───────────────────────────────────────────────────

function setText(id, value) {
  const el = byId(id);
  if (el) el.textContent = value ?? '–';
}

function describeSource(row) {
  if (row.client_name) return row.client_name;
  return String(row.client_reference || '').split(':')[0] || 'desconhecido';
}

function renderAuditStatsCards(data) {
  setText('audit-stat-sent', data.sent);
  setText('audit-stat-received', data.received);
  setText('audit-stat-failed', data.failed);
  setText('audit-stat-pending', data.pending);
  const container = byId('audit-stat-by-source');
  if (!container) return;
  container.innerHTML = (data.bySource || []).map((s) => `
    <div class="mini-item d-flex justify-content-between align-items-center">
      <strong>${escapeHtml(s.label)}</strong>
      <span class="small text-muted">${s.total} total · <span style="color:#15803d">${s.sent || 0} ok</span>${s.failed ? ` · <span style="color:#991b1b">${s.failed} falhas</span>` : ''}</span>
    </div>
  `).join('') || '<div class="mini-item text-muted">Sem dados no período.</div>';
}

function renderAuditLogTable(rows) {
  const tbody = document.querySelector('#audit-log-table tbody');
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-4">Nenhuma mensagem no período.</td></tr>';
    return;
  }
  resolveContactNamesFor(rows.map((r) => r.to_number).filter(Boolean));
  tbody.innerHTML = rows.map((row) => {
    const statusVariant = row.status === 'sent' ? 'chip-sent' : row.status === 'failed' ? 'chip-failed' : row.status === 'pending' ? 'chip-pending' : 'chip-muted';
    return `
      <tr>
        <td class="small" title="${escapeHtml(formatDate(row.created_at))}">${escapeHtml(relativeTime(row.created_at))}</td>
        <td>${escapeHtml(displayNameFor(row.to_number))}</td>
        <td class="small">${escapeHtml(describeSource(row))}</td>
        <td class="small">${escapeHtml(row.message_type || '-')}</td>
        <td><span class="audit-chip ${statusVariant}">${escapeHtml(row.status)}</span></td>
      </tr>
    `;
  }).join('');
}

async function loadAuditLogTable() {
  const params = new URLSearchParams();
  params.set('range', state.auditStatsRange);
  params.set('limit', String(state.auditLogLimit));
  params.set('offset', String(state.auditLogOffset));
  if (state.auditLogFilters.status) params.set('status', state.auditLogFilters.status);
  if (state.auditLogFilters.phone) params.set('phone', state.auditLogFilters.phone);
  try {
    const resp = await api(`/admin/api/messages?${params.toString()}`);
    state.auditLogTotal = resp.total || 0;
    renderAuditLogTable(resp.data || []);
    const pageInfo = byId('audit-log-pageinfo');
    if (pageInfo) {
      const from = resp.data.length ? state.auditLogOffset + 1 : 0;
      const to = state.auditLogOffset + resp.data.length;
      pageInfo.textContent = `${from}-${to} de ${state.auditLogTotal}`;
    }
    const prevBtn = byId('audit-log-prev-btn');
    const nextBtn = byId('audit-log-next-btn');
    if (prevBtn) prevBtn.disabled = state.auditLogOffset === 0;
    if (nextBtn) nextBtn.disabled = state.auditLogOffset + resp.data.length >= state.auditLogTotal;
  } catch (e) {
    showMessage(e.message, 'error');
  }
}

async function loadAuditStatsScreen() {
  try {
    const stats = await api(`/admin/api/audit/stats?range=${encodeURIComponent(state.auditStatsRange)}`);
    renderAuditStatsCards(stats.data);
  } catch (e) {
    showMessage(e.message, 'error');
  }
  await loadAuditLogTable();
}

function _updateConvLoadMoreBtn() {
  const listEl = byId('conversation-list');
  if (!listEl) return;
  // btn may have been wiped by renderConversationList's innerHTML reset
  let btn = byId('audit-load-more-btn');
  const remaining = state.conversationTotal - state.conversationOffset;
  if (remaining <= 0 && !state.conversationLoading) {
    if (btn) btn.remove();
    return;
  }
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'audit-load-more-btn';
    btn.className = 'audit-load-more-btn';
    listEl.appendChild(btn);
    btn.addEventListener('click', () => loadConversationList(true));
  }
  if (state.conversationLoading) {
    btn.disabled = true;
    btn.textContent = '⏳ Carregando...';
  } else {
    btn.disabled = false;
    btn.textContent = `↓ Carregar mais ${remaining} conversas`;
  }
}

// ── Gerenciamento de usuários ─────────────────────────────────────────────────

async function loadUsersScreen() {
  const tbody = document.querySelector('#users-table tbody');
  if (!tbody) return;
  try {
    const { data } = await api('/admin/api/users');
    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted py-4">Nenhum usuário.</td></tr>';
      return;
    }
    tbody.innerHTML = data.map((u) => `
      <tr>
        <td><strong>${escapeHtml(u.username)}</strong></td>
        <td><span class="status-chip ${u.status === 'active' ? 'status-ok' : 'status-warn'}"><span class="dot"></span>${u.status === 'active' ? 'Ativo' : 'Inativo'}</span></td>
        <td class="text-muted small">${u.last_login_at ? relativeTime(u.last_login_at) : '—'}</td>
        <td class="text-end" style="white-space:nowrap">
          <button class="btn btn-sm btn-outline-secondary me-1" onclick="onPromptUserPassword(${u.id},'${escapeHtml(u.username)}')">🔑 Senha</button>
          <button class="btn btn-sm btn-outline-warning me-1" onclick="onToggleUserStatus(${u.id})">${u.status === 'active' ? 'Desativar' : 'Ativar'}</button>
          <button class="btn btn-sm btn-outline-danger" onclick="onDeleteUser(${u.id},'${escapeHtml(u.username)}')">Excluir</button>
        </td>
      </tr>`).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="4" class="text-danger py-3">${escapeHtml(e.message)}</td></tr>`;
  }
}

async function onCreateUser() {
  const username = getValue('new-user-username');
  const password = byId('new-user-password')?.value || '';
  if (!username || !password) return showMessage('Preencha usuário e senha', 'error');
  await runAction(async () => {
    await api('/admin/api/users', { method: 'POST', body: JSON.stringify({ username, password }) });
    byId('new-user-username').value = '';
    byId('new-user-password').value = '';
    showMessage(`Usuário "${username}" criado com sucesso`);
    loadUsersScreen();
  });
}

async function onPromptUserPassword(userId, username) {
  const pw = prompt(`Nova senha para "${username}" (mín. 8 caracteres):`);
  if (!pw) return;
  await runAction(async () => {
    await api(`/admin/api/users/${userId}/password`, { method: 'POST', body: JSON.stringify({ new_password: pw }) });
    showMessage(`Senha de "${username}" alterada`);
  });
}

async function onToggleUserStatus(userId) {
  await runAction(async () => {
    const { data } = await api(`/admin/api/users/${userId}/status`, { method: 'POST', body: JSON.stringify({}) });
    showMessage(`Usuário ${data.status === 'active' ? 'ativado' : 'desativado'}`);
    loadUsersScreen();
  });
}

async function onDeleteUser(userId, username) {
  if (!confirm(`Excluir usuário "${username}"? Esta ação não pode ser desfeita.`)) return;
  await runAction(async () => {
    await api(`/admin/api/users/${userId}`, { method: 'DELETE' });
    showMessage(`Usuário "${username}" excluído`);
    loadUsersScreen();
  });
}

async function onChangeOwnPassword() {
  const current = byId('profile-current-pw')?.value || '';
  const newPw = byId('profile-new-pw')?.value || '';
  const confirm = byId('profile-confirm-pw')?.value || '';
  if (!current || !newPw || !confirm) return showMessage('Preencha todos os campos', 'error');
  if (newPw !== confirm) return showMessage('Nova senha e confirmação não conferem', 'error');
  await runAction(async () => {
    await api('/admin/api/profile/password', { method: 'POST', body: JSON.stringify({ current_password: current, new_password: newPw }) });
    byId('profile-current-pw').value = '';
    byId('profile-new-pw').value = '';
    byId('profile-confirm-pw').value = '';
    showMessage('Senha alterada com sucesso!');
  });
}

async function runAction(handler) {
  try {
    await handler();
  } catch (error) {
    showMessage(error.message, 'error');
  }
}

bindEvents();
setSendTestMode('text');
switchScreen('overview');
renderTemplateBuilder(null);
loadBootstrap().catch((error) => showMessage(error.message, 'error'));
