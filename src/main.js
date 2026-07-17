// Agent Test Suite — Tauri frontend.
// All HTTP requests and file dialogs go through Rust commands (invoke),
// so the webview never talks to the network directly.
const { invoke } = window.__TAURI__.core;

// Server port is user-configurable (header field), persisted across restarts.
const DEFAULT_PORT = 37123;
const PORT_STORAGE_KEY = 'agent_test_port';
const CASES_STORAGE_KEY = 'agent_test_cases';   // last applied test-case JSON
const FILE_PATH_STORAGE_KEY = 'agent_test_cases_path'; // full path of the last loaded file
const AGENT_STORAGE_KEY = 'agent_test_agent';   // last selected agent id
let apiPort = parseInt(localStorage.getItem(PORT_STORAGE_KEY), 10);
if (!(apiPort >= 1 && apiPort <= 65535)) apiPort = DEFAULT_PORT;
function apiBase() { return `http://127.0.0.1:${apiPort}`; }

// Resolve URLs the server hands back (session files may be relative).
function resolveServerUrl(url) {
  if (!url) return '';
  return url.startsWith('/') ? `${apiBase()}${url}` : url;
}

// Application state
let agents = [];
let testCases = [];
let currentSelectedCaseIndex = null;
let isRunningAll = false;
let stopRequested = false;
let isServerOnline = false;
let currentFilePath = null; // full path of the currently loaded config file, if known

// DOM Elements
const portInput = document.getElementById('port-input');
const agentSelect = document.getElementById('agent-select');
const btnRefreshAgents = document.getElementById('btn-refresh-agents');
const btnRunAll = document.getElementById('btn-run-all');
const btnStopAll = document.getElementById('btn-stop-all');
const testCasesList = document.getElementById('test-cases-list');
const jsonEditor = document.getElementById('json-editor');
const btnEditorApply = document.getElementById('btn-editor-apply');
const btnEditorSave = document.getElementById('btn-editor-save');
const btnRefreshConfig = document.getElementById('btn-refresh-config');
const configFilePath = document.getElementById('config-file-path');
const dropzone = document.getElementById('dropzone');
const connectionDot = document.getElementById('connection-dot');
const connectionText = document.getElementById('connection-text');

// Stats elements
const statTotal = document.getElementById('stat-total');
const statPassed = document.getElementById('stat-passed');
const statFailed = document.getElementById('stat-failed');
const statPending = document.getElementById('stat-pending');
const testProgressBar = document.getElementById('test-progress-bar');
const summaryBadge = document.getElementById('summary-badge');

// Detail elements
const detailPopover = document.getElementById('test-detail-popover');
const detailPopoverBackdrop = document.getElementById('test-detail-backdrop');
const btnDetailClose = document.getElementById('btn-detail-close');
const testDetailPlaceholder = document.getElementById('test-detail-placeholder');
const testDetailContent = document.getElementById('test-detail-content');
const detailCaseName = document.getElementById('detail-case-name');
const detailCasePrompt = document.getElementById('detail-case-prompt');
const detailCaseTools = document.getElementById('detail-case-tools');
const detailCaseModel = document.getElementById('detail-case-model');
const detailCaseUrl = document.getElementById('detail-case-url');
const detailCaseStatus = document.getElementById('detail-case-status');
const detailCaseOutput = document.getElementById('detail-case-output');
const detailCaseCheck = document.getElementById('detail-case-check');
const detailCaseAssert = document.getElementById('detail-case-assert');
const detailSessionSec = document.getElementById('detail-session-sec');
const detailSessionLink = document.getElementById('detail-session-link');
const detailLogsSec = document.getElementById('detail-logs-sec');
const detailLogsList = document.getElementById('detail-logs-list');

// Init
window.addEventListener('DOMContentLoaded', () => {
  portInput.value = apiPort;
  portInput.addEventListener('change', () => {
    const v = parseInt(portInput.value, 10);
    apiPort = (v >= 1 && v <= 65535) ? v : DEFAULT_PORT;
    portInput.value = apiPort;
    localStorage.setItem(PORT_STORAGE_KEY, String(apiPort));
    // Force a fresh detection against the new port right away.
    setServerOffline();
    connectionText.innerText = 'Agent Server: Checking...';
    checkServerHealth();
    if (currentSelectedCaseIndex !== null) selectTestCase(currentSelectedCaseIndex);
  });

  checkServerHealth();
  setInterval(checkServerHealth, 5000); // Check server health every 5s

  // Try automatic load from disk first (test_case.json next to the app)
  autoLoadTestCases();

  // Setup Listeners
  btnRefreshAgents.addEventListener('click', fetchAgents);
  btnRunAll.addEventListener('click', runAllTests);
  btnStopAll.addEventListener('click', () => {
    stopRequested = true;
    btnStopAll.disabled = true;
    btnStopAll.innerHTML = '<span>■</span> Stopping...';
    onTestFinished();
  });
  btnEditorApply.addEventListener('click', applyEditorJson);
  btnEditorSave.addEventListener('click', saveJsonToFile);
  btnRefreshConfig.addEventListener('click', refreshConfigFile);
  agentSelect.addEventListener('change', () => {
    if (agentSelect.value) {
      try { localStorage.setItem(AGENT_STORAGE_KEY, agentSelect.value); } catch (_) {}
    }
    if (currentSelectedCaseIndex !== null) {
      selectTestCase(currentSelectedCaseIndex);
    }
  });

  // Open native file dialog on click; drag & drop still works because
  // the Tauri window has dragDropEnabled: false (HTML5 drop events fire).
  dropzone.addEventListener('click', openTestCaseFile);
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.style.borderColor = 'var(--accent)';
  });
  dropzone.addEventListener('dragleave', () => {
    dropzone.style.borderColor = 'var(--border)';
  });
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.style.borderColor = 'var(--border)';
    if (e.dataTransfer.files.length > 0) {
      readJsonFile(e.dataTransfer.files[0]);
    }
  });

  // Links open in the system default browser via Rust.
  detailCaseUrl.addEventListener('click', (e) => {
    e.preventDefault();
    const url = detailCaseUrl.dataset.url;
    if (url) invoke('open_in_browser', { url }).catch(err => console.error(err));
  });
  detailSessionLink.addEventListener('click', (e) => {
    e.preventDefault();
    const url = detailSessionLink.dataset.url;
    if (url) invoke('open_in_browser', { url }).catch(err => console.error(err));
  });

  // Detail popover dismissal: close button, backdrop click, or Escape.
  btnDetailClose.addEventListener('click', closeDetailPopover);
  detailPopoverBackdrop.addEventListener('click', closeDetailPopover);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && detailPopover.classList.contains('visible')) {
      closeDetailPopover();
    }
  });

  // Keep the popover anchored to its test-item while the window resizes
  // or the page scrolls (the item's viewport position can change).
  window.addEventListener('resize', repositionOpenPopover);
  window.addEventListener('scroll', repositionOpenPopover, true);
});

// Server health checking (Rust: reqwest GET /health with 2s timeout)
async function checkServerHealth() {
  try {
    const ok = await invoke('check_health', { port: apiPort });
    if (ok) {
      if (!isServerOnline) {
        isServerOnline = true;
        connectionDot.className = 'status-dot online';
        connectionText.innerText = 'Agent Server: Online';
        fetchAgents();
      }
    } else {
      setServerOffline();
    }
  } catch (err) {
    setServerOffline();
  }
}

function setServerOffline() {
  isServerOnline = false;
  connectionDot.className = 'status-dot offline';
  connectionText.innerText = 'Agent Server: Offline';
  agentSelect.innerHTML = '<option value="">-- Start Agent.exe first --</option>';
  btnRunAll.disabled = true;
}

// Fetch active agents
async function fetchAgents() {
  if (!isServerOnline) return;
  try {
    const data = await invoke('api_get', { port: apiPort, query: 'action=list_agents' });
    agents = data.agents || [];

    // Filter agents that allow HTTP request
    const httpAgents = agents.filter(a => a.allowHttp);

    if (httpAgents.length === 0) {
      agentSelect.innerHTML = '<option value="">-- No Agents allow HTTP (enable it in settings) --</option>';
      btnRunAll.disabled = true;
      return;
    }

    agentSelect.innerHTML = '';
    httpAgents.forEach(agent => {
      const opt = document.createElement('option');
      opt.value = agent.agentId;
      opt.innerText = `${agent.name} (${agent.agentId})`;
      agentSelect.appendChild(opt);
    });

    // Restore the previously selected agent when it is still available.
    const savedAgent = localStorage.getItem(AGENT_STORAGE_KEY);
    if (savedAgent && httpAgents.some(a => a.agentId === savedAgent)) {
      agentSelect.value = savedAgent;
    }

    if (testCases.length > 0) {
      btnRunAll.disabled = false;
    }
  } catch (err) {
    console.error('Fetch agents failed', err);
  }
}

// Update the "currently loaded file" display in the JSON Config card.
function setConfigFilePath(path) {
  currentFilePath = path || null;
  if (currentFilePath) {
    configFilePath.innerText = currentFilePath;
    configFilePath.title = currentFilePath;
    try { localStorage.setItem(FILE_PATH_STORAGE_KEY, currentFilePath); } catch (_) {}
  } else {
    configFilePath.innerText = '尚未載入檔案';
    configFilePath.title = '';
    try { localStorage.removeItem(FILE_PATH_STORAGE_KEY); } catch (_) {}
  }
}

// Auto-load test_case.json from disk (exe dir / cwd); fall back to the
// last-saved copy in localStorage.
async function autoLoadTestCases() {
  try {
    const file = await invoke('load_default_test_cases');
    jsonEditor.value = file.content;
    testCases = JSON.parse(file.content);
    initializeTestCases();
    setConfigFilePath(file.path);
    return;
  } catch (e) {
    console.log('Unable to auto-load test_case.json, trying saved copy / manual load.', e);
  }
  const saved = localStorage.getItem(CASES_STORAGE_KEY);
  if (saved) {
    try {
      jsonEditor.value = saved;
      testCases = JSON.parse(saved);
      initializeTestCases();
      setConfigFilePath(localStorage.getItem(FILE_PATH_STORAGE_KEY));
    } catch (_) { /* corrupt saved copy — wait for manual load */ }
  }
}

// Re-read the currently loaded config file from disk; falls back to
// re-scanning the default locations when no path is known yet.
async function refreshConfigFile() {
  if (!currentFilePath) {
    await autoLoadTestCases();
    return;
  }
  const originalLabel = btnRefreshConfig.innerHTML;
  btnRefreshConfig.disabled = true;
  btnRefreshConfig.innerHTML = '<span class="spinner"></span> Refreshing...';
  try {
    const file = await invoke('read_text_file', { path: currentFilePath });
    applyJsonContent(file.content, file.path);
  } catch (err) {
    alert('Failed to refresh file: ' + err);
  } finally {
    btnRefreshConfig.disabled = false;
    btnRefreshConfig.innerHTML = originalLabel;
  }
}

// Native open-file dialog via Rust.
async function openTestCaseFile() {
  try {
    const file = await invoke('open_test_case_dialog');
    if (file === null || file === undefined) return; // user cancelled
    applyJsonContent(file.content, file.path);
  } catch (err) {
    alert('Failed to open file: ' + err);
  }
}

// Drag & drop path still delivers a File object — read it in the webview.
// Browsers don't expose the full filesystem path for dropped files, so we
// can only show the filename here (Refresh won't be available for it).
function readJsonFile(file) {
  const reader = new FileReader();
  reader.onload = (event) => {
    applyJsonContent(event.target.result, file.path || null);
  };
  reader.readAsText(file);
}

function applyJsonContent(content, path) {
  try {
    jsonEditor.value = content;
    testCases = JSON.parse(content);
    initializeTestCases();
    setConfigFilePath(path);
  } catch (err) {
    alert('Invalid JSON file format: ' + err.message);
  }
}

function applyEditorJson() {
  try {
    testCases = JSON.parse(jsonEditor.value);
    initializeTestCases();
  } catch (err) {
    alert('JSON syntax error: ' + err.message);
  }
}

// Save the current editor JSON via the native save dialog (Rust).
async function saveJsonToFile() {
  let content;
  try {
    content = JSON.stringify(JSON.parse(jsonEditor.value), null, 2);
  } catch (err) {
    alert('JSON syntax error, not saved: ' + err.message);
    return;
  }
  try { localStorage.setItem(CASES_STORAGE_KEY, content); } catch (_) {}

  try {
    const savedPath = await invoke('save_test_case_dialog', { content });
    if (savedPath) setConfigFilePath(savedPath);
  } catch (err) {
    alert('Failed to save file: ' + err);
  }
}

// Setup loaded test cases
function initializeTestCases() {
  // Remember the applied config so a restart restores it.
  try { localStorage.setItem(CASES_STORAGE_KEY, jsonEditor.value); } catch (_) {}
  testCases = testCases.map((tc, index) => ({
    id: tc.id || index + 1,
    name: tc.name || `Test Case #${index + 1}`,
    prompt: tc.prompt || '',
    tools: tc.tools || [],
    knowledges: tc.knowledges || [],
    model: tc.model || '',
    check: tc.check || 'true',
    status: 'idle', // idle, running, success, error
    resultText: '',
    sessionData: null,
    execId: '',
    logs: [],
    errorMsg: ''
  }));

  updateStats();
  renderTestCasesList();
  if (isServerOnline && agents.some(a => a.allowHttp)) {
    btnRunAll.disabled = false;
  }
  btnStopAll.disabled = true;
  btnStopAll.innerHTML = '<span>■</span> Stop';
  closeDetailPopover();
}

function updateStats() {
  const total = testCases.length;
  const passed = testCases.filter(t => t.status === 'success').length;
  const failed = testCases.filter(t => t.status === 'error').length;
  const running = testCases.filter(t => t.status === 'running').length;
  const pending = total - (passed + failed + running);

  statTotal.innerText = total;
  statPassed.innerText = passed;
  statFailed.innerText = failed;
  statPending.innerText = pending;

  if (total > 0) {
    const percent = ((passed + failed) / total) * 100;
    testProgressBar.style.width = `${percent}%`;
  } else {
    testProgressBar.style.width = '0%';
  }

  if (running > 0) {
    summaryBadge.innerText = 'RUNNING';
    summaryBadge.className = 'test-status-badge status-running';
  } else if (failed > 0) {
    summaryBadge.innerText = 'FAILED';
    summaryBadge.className = 'test-status-badge status-error';
  } else if (passed === total && total > 0) {
    summaryBadge.innerText = 'PASSED';
    summaryBadge.className = 'test-status-badge status-success';
  } else {
    summaryBadge.innerText = 'READY';
    summaryBadge.className = 'test-status-badge status-idle';
  }
}

// Render left panel test items
function renderTestCasesList() {
  testCasesList.innerHTML = '';
  if (testCases.length === 0) {
    testCasesList.innerHTML = '<div style="color:var(--text-muted); text-align:center; padding: 40px 0;">No test cases loaded.</div>';
    return;
  }

  testCases.forEach((tc, idx) => {
    const item = document.createElement('div');
    item.className = `test-item ${currentSelectedCaseIndex === idx ? 'active' : ''}`;
    item.dataset.index = idx;

    let statusClass = 'status-idle';
    let statusText = 'READY';
    if (tc.status === 'running') {
      statusClass = 'status-running';
      statusText = 'RUNNING';
    } else if (tc.status === 'success') {
      statusClass = 'status-success';
      statusText = 'PASSED';
    } else if (tc.status === 'error') {
      statusClass = 'status-error';
      statusText = 'FAILED';
    }

    item.innerHTML = `
      <div class="test-summary-row">
        <div class="test-title-container">
          <span class="test-id">#${tc.id}</span>
          <span class="test-name">${escapeHtml(tc.name)}</span>
        </div>
        <span class="test-status-badge ${statusClass}" id="badge-${idx}">${statusText}</span>
      </div>
      <div class="test-summary-row" style="margin-top: 4px;">
        <div class="test-prompt-preview">${escapeHtml(tc.prompt)}</div>
        <button class="btn btn-secondary btn-run-single" style="height: 28px; padding: 0 10px; font-size: 11px;" id="btn-run-${idx}">
          ${tc.status === 'running' ? '<span class="spinner"></span>' : '▶ Run'}
        </button>
      </div>
      <div class="test-meta-row">
        <span class="test-meta-tag test-meta-model">${escapeHtml(tc.model || 'Default Model')}</span>
        ${tc.tools && tc.tools.length > 0
          ? tc.tools.map(t => `<span class="test-meta-tag test-meta-tool">${escapeHtml(t)}</span>`).join('')
          : '<span class="test-meta-tag test-meta-tool-empty">No Tools</span>'}
      </div>
    `;

    item.addEventListener('click', (e) => {
      // Prevent triggered run from selecting row if click on Run button
      if (e.target.closest('.btn-run-single')) return;
      // Clicking the already-open item's row again closes its popover.
      if (currentSelectedCaseIndex === idx && detailPopover.classList.contains('visible')) {
        closeDetailPopover();
      } else {
        selectTestCase(idx);
      }
    });

    const runBtn = item.querySelector('.btn-run-single');
    runBtn.addEventListener('click', () => {
      if (tc.status !== 'running') {
        runSingleTest(idx);
      }
    });

    testCasesList.appendChild(item);
  });
}

function getFullResultText(tc) {
  if (tc.sessionData && tc.sessionData.exchanges) {
    const responseEx = tc.sessionData.exchanges.slice().reverse().find(ex => ex.phase === 'response');
    if (responseEx && responseEx.payload && responseEx.payload.body) {
      const body = responseEx.payload.body;
      // 1. LM Studio output array
      if (Array.isArray(body.output)) {
        const text = body.output
          .filter(out => out && out.type === 'message' && out.content)
          .map(out => out.content)
          .join('\n');
        if (text) return text;
      }
      // 2. OpenAI Choices structure
      if (body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content) {
        return body.choices[0].message.content;
      }
    }
  }
  return tc.resultText;
}

// Close the floating detail popover and clear the selection highlight.
function closeDetailPopover() {
  currentSelectedCaseIndex = null;
  detailPopover.classList.remove('visible');
  detailPopoverBackdrop.classList.remove('visible');
  document.querySelectorAll('.test-item.active').forEach(item => item.classList.remove('active'));
}

// Anchor the popover beside the given test-item element, flipping to the
// left edge (and clamping within the viewport) when there isn't room.
function positionDetailPopover(itemEl) {
  if (!itemEl) return;
  const rect = itemEl.getBoundingClientRect();
  const gap = 16;
  const margin = 16;
  const popoverWidth = detailPopover.offsetWidth || 660;
  const popoverHeight = detailPopover.offsetHeight || 300;

  let left = rect.right + gap;
  if (left + popoverWidth + margin > window.innerWidth) {
    left = rect.left - gap - popoverWidth;
  }
  left = Math.min(Math.max(left, margin), Math.max(margin, window.innerWidth - popoverWidth - margin));

  let top = Math.min(rect.top, window.innerHeight - popoverHeight - margin);
  top = Math.max(top, margin);

  detailPopover.style.left = `${left}px`;
  detailPopover.style.top = `${top}px`;
}

// Keep the popover anchored to its item across resize/scroll while open.
function repositionOpenPopover() {
  if (!detailPopover.classList.contains('visible') || currentSelectedCaseIndex === null) return;
  const itemEl = testCasesList.querySelector(`.test-item[data-index="${currentSelectedCaseIndex}"]`);
  positionDetailPopover(itemEl);
}

function selectTestCase(idx) {
  currentSelectedCaseIndex = idx;

  // Update highlights
  document.querySelectorAll('.test-item').forEach((item, index) => {
    if (index === idx) item.classList.add('active');
    else item.classList.remove('active');
  });

  testDetailPlaceholder.style.display = 'none';
  testDetailContent.style.display = 'block';
  detailPopover.classList.add('visible');
  detailPopoverBackdrop.classList.add('visible');

  const tc = testCases[idx];
  detailCaseName.innerText = `[#${tc.id}] ${tc.name}`;
  detailCasePrompt.innerText = tc.prompt;
  detailCaseTools.innerText = tc.tools && tc.tools.length > 0 ? tc.tools.join(', ') : '(None)';
  detailCaseModel.innerText = tc.model || '(Default Agent Model)';

  const agentId = agentSelect.value || '<agent_id>';
  const tempExecId = tc.execId || 'tc_temp';
  const toolsStr = tc.tools && tc.tools.length > 0 ? encodeURIComponent(tc.tools.join(',')) : '';
  const knowledgesStr = tc.knowledges && tc.knowledges.length > 0 ? encodeURIComponent(tc.knowledges.join(',')) : '';
  const modelStr = tc.model ? encodeURIComponent(tc.model) : '';
  const messageStr = encodeURIComponent(tc.prompt);
  let requestUrl = `${apiBase()}/input?agent_id=${encodeURIComponent(agentId)}&action=run&exec_id=${tempExecId}`;
  if (toolsStr) requestUrl += `&tools=${toolsStr}`;
  if (knowledgesStr) requestUrl += `&knowledges=${knowledgesStr}`;
  if (modelStr) requestUrl += `&model=${modelStr}`;
  if (messageStr) requestUrl += `&message=${messageStr}`;

  detailCaseUrl.innerText = requestUrl;
  detailCaseUrl.dataset.url = requestUrl;

  if (tc.execId) {
    detailCaseStatus.innerHTML = `Exec ID: <span style="font-family:var(--mono); color:var(--accent); font-weight:500;">${tc.execId}</span> (${tc.status.toUpperCase()})`;
  } else {
    detailCaseStatus.innerText = tc.status.toUpperCase();
  }

  const fullText = getFullResultText(tc);
  detailCaseOutput.innerText = fullText || (tc.status === 'running' ? 'Running agent...' : 'No execution output yet.');
  if (tc.status === 'error' && tc.errorMsg) {
    detailCaseOutput.innerHTML += `\n\n<span style="color:var(--error); font-weight:bold;">Error details: ${escapeHtml(tc.errorMsg)}</span>`;
  }

  detailCaseCheck.innerText = tc.check;

  if (tc.status === 'success') {
    detailCaseAssert.innerHTML = `<span style="color:var(--success); font-weight:600;">✓ PASSED</span> (Condition evaluated to true)`;
  } else if (tc.status === 'error') {
    detailCaseAssert.innerHTML = `<span style="color:var(--error); font-weight:600;">✗ FAILED</span> (Condition evaluated to false, or execution error)`;
  } else if (tc.status === 'running') {
    detailCaseAssert.innerHTML = `<span style="color:var(--info); font-weight:600;">ℹ RUNNING</span> (Waiting for verification)`;
  } else {
    detailCaseAssert.innerText = 'PENDING';
  }

  // Session Link
  const sessionUrl = tc.sessionData && (tc.sessionData.lastSessionUrl || tc.sessionData.sessionUrl);
  if (sessionUrl) {
    detailSessionSec.style.display = 'block';
    detailSessionLink.dataset.url = resolveServerUrl(sessionUrl);
  } else {
    detailSessionSec.style.display = 'none';
  }

  // App Logs
  if (tc.logs && tc.logs.length > 0) {
    detailLogsSec.style.display = 'block';
    detailLogsList.innerHTML = '';
    tc.logs.forEach(log => {
      const item = document.createElement('div');
      item.className = `detail-log-item ${log.level}`;
      const time = new Date(log.timestamp).toLocaleTimeString('zh-TW', { hour12: false });
      item.innerText = `[${time}] ${log.message}`;
      detailLogsList.appendChild(item);
    });
  } else {
    detailLogsSec.style.display = 'none';
  }

  // Anchor next to the selected row now that content is populated
  // (accurate popover size needed for edge-flip/clamp math).
  const itemEl = testCasesList.querySelector(`.test-item[data-index="${idx}"]`);
  positionDetailPopover(itemEl);
}

// Run a single test case
async function runSingleTest(idx) {
  if (!isServerOnline) {
    alert('Server is offline. Start Agent.exe first!');
    onTestFinished();
    return;
  }
  const agentId = agentSelect.value;
  if (!agentId) {
    alert('Please select an Agent first.');
    onTestFinished();
    return;
  }

  const tc = testCases[idx];
  tc.status = 'running';
  tc.resultText = '';
  tc.sessionData = null;
  tc.logs = [];
  tc.errorMsg = '';

  const execId = 'tc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  tc.execId = execId;

  renderTestCasesList();
  updateStats();
  if (currentSelectedCaseIndex === idx) selectTestCase(idx);

  try {
    // Send POST input run request (via Rust)
    const requestBody = {
      agent_id: agentId,
      action: 'run',
      exec_id: execId,
      tools: tc.tools || [],
      model: tc.model || '',
      parameters: {
        message: tc.prompt
      }
    };
    // Only send "knowledges" when the test case actually sets it.
    if (tc.knowledges && tc.knowledges.length > 0) {
      requestBody.knowledges = tc.knowledges;
    }
    await invoke('api_post', {
      port: apiPort,
      body: requestBody
    });

    // Start polling for completion
    pollTestStatus(idx, agentId, execId);
  } catch (err) {
    tc.status = 'error';
    tc.errorMsg = String(err);
    tc.resultText = `Failed to trigger execution: ${err}`;
    renderTestCasesList();
    updateStats();
    if (currentSelectedCaseIndex === idx) selectTestCase(idx);
    onTestFinished();
  }
}

// Poll status of executing agent
function pollTestStatus(idx, agentId, execId) {
  const tc = testCases[idx];
  const maxAttempts = 120; // 2 minutes timeout
  let attempts = 0;

  const interval = setInterval(async () => {
    attempts++;
    if (attempts > maxAttempts) {
      clearInterval(interval);
      tc.status = 'error';
      tc.errorMsg = 'Timeout: Agent execution exceeded 2 minutes';
      tc.resultText = 'Polling timeout.';
      renderTestCasesList();
      updateStats();
      if (currentSelectedCaseIndex === idx) selectTestCase(idx);
      onTestFinished();
      return;
    }

    try {
      const statusData = await invoke('api_get', {
        port: apiPort,
        query: `action=get_status&agent_id=${encodeURIComponent(agentId)}`
      });
      const detail = statusData.detail || {};

      // Check if finished
      const isFinished = !statusData.running && detail.lastExecId === execId;
      const isCurrentlyRunning = statusData.running && detail.currentExecId === execId;

      if (isCurrentlyRunning) {
        tc.status = 'running';
        // Update live output preview if any
        if (detail.currentRound) {
          tc.resultText = `Running... Round ${detail.currentRound}. Tokens: ${detail.currentTokens || 0}`;
          if (currentSelectedCaseIndex === idx) {
            detailCaseOutput.innerText = tc.resultText;
          }
        }
      }

      if (isFinished) {
        clearInterval(interval);

        // Gather result details
        tc.resultText = detail.lastContentPreview || '';
        const isSuccessRun = detail.lastSuccess !== false;

        // Store session metadata
        tc.sessionData = {
          lastSessionUrl: detail.lastSessionUrl,
          lastSessionPath: detail.lastSessionPath,
          lastTokens: detail.lastTokens,
          lastRounds: detail.lastRounds
        };

        // Attempt to load full session file to get exchanges & logs
        if (detail.lastSessionUrl) {
          try {
            const fullSession = await invoke('fetch_url_json', {
              url: resolveServerUrl(detail.lastSessionUrl)
            });
            tc.sessionData = fullSession;
            tc.logs = fullSession.logs || [];
          } catch (e) {
            console.error('Failed to load session details', e);
          }
        }

        // If the agent execution itself failed
        if (!isSuccessRun) {
          tc.status = 'error';
          tc.errorMsg = 'Agent aborted or run execution failed internally';
        } else {
          // Run the assertion check
          verifyCheckExpression(idx);
        }

        renderTestCasesList();
        updateStats();
        if (currentSelectedCaseIndex === idx) selectTestCase(idx);
        onTestFinished();
      }
    } catch (err) {
      console.error('Polling error', err);
    }
  }, 1000);
}

// Evaluate JavaScript verification expression
function verifyCheckExpression(idx) {
  const tc = testCases[idx];
  const resultText = getFullResultText(tc);
  const sessionObj = tc.sessionData || { exchanges: [], logs: [] };

  try {
    // Quick syntax helper: if check starts with "contains:", do case-insensitive substring
    let expression = tc.check.trim();
    let passed = false;

    if (expression.startsWith('contains:')) {
      const matchStr = expression.substring(9).trim();
      passed = resultText.toLowerCase().includes(matchStr.toLowerCase());
    } else {
      // Construct function with result & session variables
      const checkFn = new Function('result', 'session', `return (${expression});`);
      passed = !!checkFn(resultText, sessionObj);
    }

    if (passed) {
      tc.status = 'success';
    } else {
      tc.status = 'error';
      tc.errorMsg = 'Assertion failed: check expression evaluated to false.';
    }
  } catch (err) {
    tc.status = 'error';
    tc.errorMsg = `Assertion check syntax error: ${err.message}`;
  }
}

// Run all tests sequentially
async function runAllTests() {
  if (isRunningAll) return;
  isRunningAll = true;
  stopRequested = false;
  btnRunAll.disabled = true;
  btnStopAll.disabled = false;
  btnStopAll.innerHTML = '<span>■</span> Stop';
  agentSelect.disabled = true;

  // Reset all cases to idle
  testCases.forEach(tc => {
    tc.status = 'idle';
    tc.resultText = '';
    tc.sessionData = null;
    tc.execId = '';
    tc.logs = [];
    tc.errorMsg = '';
  });

  renderTestCasesList();
  updateStats();

  // Sequentially run
  for (let i = 0; i < testCases.length; i++) {
    if (stopRequested) {
      break;
    }
    await new Promise((resolve) => {
      // Store completion listener
      window.onTestCaseComplete = () => {
        window.onTestCaseComplete = null;
        resolve();
      };
      runSingleTest(i);
    });
  }

  isRunningAll = false;
  stopRequested = false;
  btnRunAll.disabled = false;
  btnStopAll.disabled = true;
  btnStopAll.innerHTML = '<span>■</span> Stop';
  agentSelect.disabled = false;
  updateStats();
  renderTestCasesList();
}

function onTestFinished() {
  if (isRunningAll && typeof window.onTestCaseComplete === 'function') {
    window.onTestCaseComplete();
  }
}

// Utilities
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
