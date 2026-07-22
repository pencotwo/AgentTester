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
const AUTO_SWITCH_LM_KEY = 'agent_test_auto_switch_lm';
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
let modelList = []; // [{ id, name, checked }] — see Model List card
let draggedModelIndex = null;
let autoSwitchLmStudio = localStorage.getItem(AUTO_SWITCH_LM_KEY) === 'true';

// Key used in tc.modelResults when a run didn't override the model
// (i.e. no Model List entry was checked, so the test case's own `model`
// field — or the agent's default — was used).
const MODEL_DEFAULT_KEY = '__default__';
function modelKeyFor(modelOverride) { return modelOverride || MODEL_DEFAULT_KEY; }
function modelLabelFor(key) { return key === MODEL_DEFAULT_KEY ? '(Test Case 預設 Model)' : key; }

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
const btnResultSave = document.getElementById('btn-result-save');
const btnResultOpen = document.getElementById('btn-result-open');
const resultFilePath = document.getElementById('result-file-path');
const modelListEl = document.getElementById('model-list');
const modelListEmpty = document.getElementById('model-list-empty');
const btnModelAdd = document.getElementById('btn-model-add');
const chkAutoSwitchLm = document.getElementById('chk-auto-switch-lm');
const lmSwitchStatus = document.getElementById('lm-switch-status');
const modelOverrideBanner = document.getElementById('model-override-banner');
const modelOverrideBannerText = document.getElementById('model-override-banner-text');
const modelListCheckedBadge = document.getElementById('model-list-checked-badge');
const connectionDot = document.getElementById('connection-dot');
const connectionText = document.getElementById('connection-text');

// Stats elements
const statTotal = document.getElementById('stat-total');
const statPassed = document.getElementById('stat-passed');
const statFailed = document.getElementById('stat-failed');
const statPending = document.getElementById('stat-pending');
const testProgressBar = document.getElementById('test-progress-bar');
const summaryBadge = document.getElementById('summary-badge');
const categoryStatsCard = document.getElementById('category-stats-card');
const categoryStatsList = document.getElementById('category-stats-list');

// Detail elements
const detailPopover = document.getElementById('test-detail-popover');
const detailPopoverBackdrop = document.getElementById('test-detail-backdrop');
const btnDetailClose = document.getElementById('btn-detail-close');
const testDetailPlaceholder = document.getElementById('test-detail-placeholder');
const testDetailContent = document.getElementById('test-detail-content');
const detailCaseName = document.getElementById('detail-case-name');
const detailCasePrompt = document.getElementById('detail-case-prompt');
const detailCaseTools = document.getElementById('detail-case-tools');
const detailCaseUrl = document.getElementById('detail-case-url');
const detailCaseStatus = document.getElementById('detail-case-status');
const detailCaseOutput = document.getElementById('detail-case-output');
const detailCaseCheck = document.getElementById('detail-case-check');
const detailCaseAssert = document.getElementById('detail-case-assert');
const detailSessionSec = document.getElementById('detail-session-sec');
const detailSessionLink = document.getElementById('detail-session-link');
const detailLogsSec = document.getElementById('detail-logs-sec');
const detailLogsList = document.getElementById('detail-logs-list');
const detailModelsSec = document.getElementById('detail-models-sec');
const detailModelResults = document.getElementById('detail-model-results');

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
  loadModelList();

  // Setup Listeners
  btnRefreshAgents.addEventListener('click', fetchAgents);
  btnRunAll.addEventListener('click', runAllTests);
  btnStopAll.addEventListener('click', () => {
    stopRequested = true;
    btnStopAll.disabled = true;
    btnStopAll.innerHTML = '<span>■</span> Stopping...';
  });
  btnEditorApply.addEventListener('click', applyEditorJson);
  btnEditorSave.addEventListener('click', saveJsonToFile);
  btnRefreshConfig.addEventListener('click', refreshConfigFile);
  btnResultSave.addEventListener('click', saveTestResults);
  btnResultOpen.addEventListener('click', openTestResults);
  btnModelAdd.addEventListener('click', addModel);
  chkAutoSwitchLm.checked = autoSwitchLmStudio;
  chkAutoSwitchLm.addEventListener('change', () => {
    autoSwitchLmStudio = chkAutoSwitchLm.checked;
    try { localStorage.setItem(AUTO_SWITCH_LM_KEY, String(autoSwitchLmStudio)); } catch (_) {}
  });
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

// Build the results payload (status/output/session/logs for every loaded
// case) shared by the manual "Save Results" dialog and the automatic
// post-"Run All Tests" save — keeps both writers in the same JSON shape.
function buildTestResultsPayload() {
  return {
    savedAt: new Date().toISOString(),
    results: testCases.map(tc => ({
      id: tc.id,
      name: tc.name,
      status: tc.status,
      resultText: tc.resultText,
      execId: tc.execId,
      errorMsg: tc.errorMsg,
      check: tc.check,
      sessionData: tc.sessionData,
      logs: tc.logs,
      modelResults: tc.modelResults || {}
    }))
  };
}

// Save the current test *results* to a JSON file via the native save
// dialog, separate from the test_case.json config.
async function saveTestResults() {
  if (testCases.length === 0) {
    alert('No test cases loaded — nothing to save.');
    return;
  }
  const payload = buildTestResultsPayload();
  const content = JSON.stringify(payload, null, 2);
  const stamp = payload.savedAt.replace(/[:.]/g, '-');
  try {
    const savedPath = await invoke('save_test_result_dialog', {
      content,
      defaultName: `test_result_${stamp}.json`
    });
    if (savedPath) {
      resultFilePath.innerText = savedPath;
      resultFilePath.title = savedPath;
    }
  } catch (err) {
    alert('Failed to save results: ' + err);
  }
}

// Silently save results to <app dir>/result/ after "Run All Tests" — same
// JSON format as saveTestResults(), no dialog, so every run leaves a record.
async function autoSaveTestResults() {
  if (testCases.length === 0) return;
  const payload = buildTestResultsPayload();
  const content = JSON.stringify(payload, null, 2);
  const stamp = payload.savedAt.replace(/[:.]/g, '-');
  try {
    const savedPath = await invoke('save_test_result_auto', {
      content,
      defaultName: `test_result_${stamp}.json`
    });
    resultFilePath.innerText = savedPath;
    resultFilePath.title = savedPath;
  } catch (err) {
    console.error('Auto-save of test results failed:', err);
  }
}

// Open a previously saved results file and merge it back into the
// currently loaded test cases (matched by id).
async function openTestResults() {
  try {
    const file = await invoke('open_test_result_dialog');
    if (file === null || file === undefined) return; // user cancelled

    const payload = JSON.parse(file.content);
    const results = Array.isArray(payload) ? payload : (payload.results || []);
    if (testCases.length === 0) {
      alert('Load a test_case.json first so results can be matched against it.');
      return;
    }

    const byId = new Map(results.map(r => [r.id, r]));
    testCases.forEach(tc => {
      const r = byId.get(tc.id);
      if (!r) return;
      tc.status = r.status || 'idle';
      tc.resultText = r.resultText || '';
      tc.execId = r.execId || '';
      tc.errorMsg = r.errorMsg || '';
      tc.sessionData = r.sessionData || null;
      tc.logs = r.logs || [];
      tc.modelResults = r.modelResults || {};
    });

    renderTestCasesList();
    updateStats();
    if (currentSelectedCaseIndex !== null) selectTestCase(currentSelectedCaseIndex);

    resultFilePath.innerText = file.path;
    resultFilePath.title = file.path;
  } catch (err) {
    alert('Failed to open results: ' + err);
  }
}

// ---------------------------------------------------------------------
// Model List card — add/delete/edit/reorder/check a list of model names.
// Checked models override each test case's `model` field when running.
// Fully app-managed: auto-loaded/auto-saved to model_list.json next to
// the executable, no open/save dialogs.
// ---------------------------------------------------------------------

async function loadModelList() {
  try {
    const file = await invoke('load_default_model_list');
    const parsed = JSON.parse(file.content);
    if (Array.isArray(parsed)) modelList = parsed;
  } catch (e) {
    console.log('No model_list.json found yet, starting with an empty Model List.', e);
  }
  renderModelList();
}

function persistModelList() {
  invoke('save_model_list', { content: JSON.stringify(modelList, null, 2) })
    .catch(err => console.error('Failed to save model_list.json', err));
}

function getCheckedModels() {
  return modelList.filter(m => m.checked).map(m => m.name);
}

// Surface the currently-checked Model List entries wherever a run could be
// triggered, since a checked entry silently overrides every test case's own
// `model` field (see getCheckedModels / executeTestCaseForModel). Without
// this, it's easy to leave a model checked from a previous session and
// unknowingly test the wrong model on the next run.
function renderModelOverrideBanner() {
  const checked = getCheckedModels();
  if (checked.length === 0) {
    modelOverrideBanner.style.display = 'none';
    modelListCheckedBadge.style.display = 'none';
    return;
  }
  modelOverrideBanner.style.display = '';
  modelOverrideBannerText.textContent =
    `Model Override 生效中：已勾選 ${checked.length} 個 Model（${checked.join('、')}），` +
    'Run / Run All Tests 時將強制使用這些 Model，忽略每個 test case 自己的 model 設定。';
  modelListCheckedBadge.style.display = '';
  modelListCheckedBadge.textContent = `${checked.length} 個已勾選`;
}

function addModel() {
  const name = prompt('新增 Model 名稱（需與 Agent 端可用的 Model 名稱一致）：');
  if (!name || !name.trim()) return;
  modelList.push({
    id: 'm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    name: name.trim(),
    checked: true
  });
  renderModelList();
  persistModelList();
}

function editModel(idx) {
  const current = modelList[idx];
  const name = prompt('編輯 Model 名稱：', current.name);
  if (!name || !name.trim()) return;
  current.name = name.trim();
  renderModelList();
  persistModelList();
}

function deleteModel(idx) {
  const current = modelList[idx];
  if (!confirm(`刪除 Model「${current.name}」？`)) return;
  modelList.splice(idx, 1);
  renderModelList();
  persistModelList();
}

function renderModelList() {
  modelListEl.querySelectorAll('.model-item').forEach(el => el.remove());
  modelListEmpty.style.display = modelList.length === 0 ? 'block' : 'none';
  renderModelOverrideBanner();

  modelList.forEach((m, idx) => {
    const item = document.createElement('div');
    item.className = 'model-item';
    item.draggable = true;
    item.dataset.index = idx;
    item.innerHTML = `
      <span class="model-drag-handle">⠿</span>
      <input type="checkbox" class="model-checkbox" ${m.checked ? 'checked' : ''}>
      <span class="model-name">${escapeHtml(m.name)}</span>
      <div class="model-item-actions">
        <button class="btn-model-edit" title="編輯">✎</button>
        <button class="btn-model-delete" title="刪除">🗑</button>
      </div>
    `;

    item.querySelector('.model-checkbox').addEventListener('change', (e) => {
      m.checked = e.target.checked;
      renderModelOverrideBanner();
      persistModelList();
    });
    item.querySelector('.btn-model-edit').addEventListener('click', () => editModel(idx));
    item.querySelector('.btn-model-delete').addEventListener('click', () => deleteModel(idx));

    item.addEventListener('dragstart', () => {
      draggedModelIndex = idx;
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      draggedModelIndex = null;
    });
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      item.classList.add('drag-over');
    });
    item.addEventListener('dragleave', () => {
      item.classList.remove('drag-over');
    });
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      item.classList.remove('drag-over');
      if (draggedModelIndex === null || draggedModelIndex === idx) return;
      const [moved] = modelList.splice(draggedModelIndex, 1);
      modelList.splice(idx, 0, moved);
      renderModelList();
      persistModelList();
    });

    modelListEl.appendChild(item);
  });
}

// Load `modelName` into LM Studio via `lms load --yes`. Returns true on
// success; on failure it alerts (a wrong/no model would silently skew
// every test result for this batch, so it's worth interrupting for).
async function lmStudioLoad(modelName) {
  lmSwitchStatus.textContent = `🔄 Loading "${modelName}" in LM Studio...`;
  try {
    await invoke('lms_load_model', { name: modelName });
    lmSwitchStatus.textContent = `✅ Loaded "${modelName}"`;
    return true;
  } catch (err) {
    lmSwitchStatus.textContent = `❌ Failed to load "${modelName}": ${err}`;
    alert(`LM Studio 載入 model「${modelName}」失敗，這個 model 的測試將略過：\n${err}`);
    return false;
  }
}

// Unload `modelName` via `lms unload`. Best-effort — failures are logged
// but don't interrupt the run (the tests for this model already finished).
async function lmStudioUnload(modelName) {
  lmSwitchStatus.textContent = `🔄 Unloading "${modelName}" in LM Studio...`;
  try {
    await invoke('lms_unload_model', { name: modelName });
    lmSwitchStatus.textContent = `✅ Unloaded "${modelName}"`;
  } catch (err) {
    lmSwitchStatus.textContent = `❌ Failed to unload "${modelName}": ${err}`;
    console.error('lms unload failed', err);
  }
}

// Run `work()` wrapped in an LM Studio load/unload cycle for `model`, when
// the "自動切換 LM Studio Model" checkbox is on and a real model override
// is in play (the no-override/"use test case's own model" case has no
// single model to switch to, so it's skipped). If loading fails, `work()`
// is skipped entirely so the resulting FAILED status reflects a load
// problem rather than being tested against the wrong (or no) model.
async function withLmStudioModel(model, work) {
  if (!autoSwitchLmStudio || !model) {
    await work();
    return;
  }
  const loaded = await lmStudioLoad(model);
  if (!loaded) return;
  try {
    await work();
  } finally {
    await lmStudioUnload(model);
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
    category: tc.category || '',
    check: tc.check || 'true',
    status: 'idle', // idle, running, success, error
    resultText: '',
    sessionData: null,
    execId: '',
    logs: [],
    errorMsg: '',
    modelResults: {} // per-model breakdown; see recomputeAggregate()
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

  updateCategoryStats();
}

// Per-category TOTAL / PASSED / FAILED / PENDING breakdown
function updateCategoryStats() {
  const categories = {};
  const hasAnyCategory = testCases.some(tc => tc.category);

  testCases.forEach(tc => {
    const cat = tc.category || 'Uncategorized';
    if (!categories[cat]) categories[cat] = { total: 0, passed: 0, failed: 0, running: 0 };
    categories[cat].total++;
    if (tc.status === 'success') categories[cat].passed++;
    else if (tc.status === 'error') categories[cat].failed++;
    else if (tc.status === 'running') categories[cat].running++;
  });

  if (!hasAnyCategory) {
    categoryStatsCard.style.display = 'none';
    categoryStatsList.innerHTML = '';
    return;
  }

  categoryStatsCard.style.display = '';
  categoryStatsList.innerHTML = Object.keys(categories).sort().map(name => {
    const c = categories[name];
    const pending = c.total - c.passed - c.failed - c.running;
    return `
      <div class="category-stats-row">
        <span class="category-stats-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
        <span class="category-stats-counts">
          <span class="cs-total">T:${c.total}</span>
          <span class="cs-passed">P:${c.passed}</span>
          <span class="cs-failed">F:${c.failed}</span>
          <span class="cs-pending">Pd:${pending}</span>
        </span>
      </div>
    `;
  }).join('');
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
        ${tc.category
          ? `<span class="test-meta-tag test-meta-category">${escapeHtml(tc.category)}</span>`
          : ''}
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
  // FoxAgent's status API (`lastContentPreview`, i.e. tc.resultText) is capped at
  // ~300 chars and wraps the answer in a "## 任務執行總結 ... ### 結論" summary.
  // The just-finished step's `reply` in the fetched session is the real, complete,
  // unwrapped answer -- prefer it whenever session data is available.
  if (tc.sessionData && Array.isArray(tc.sessionData.steps) && tc.sessionData.steps.length) {
    const lastStep = tc.sessionData.steps[tc.sessionData.steps.length - 1];
    if (lastStep && typeof lastStep.reply === 'string' && lastStep.reply) {
      return lastStep.reply;
    }
  }
  return extractFinalAnswer(tc.resultText);
}

// Fallback for when session data isn't available: strip FoxAgent's
// "## 任務執行總結 ... ### 結論" task-summary wrapper from the raw preview text,
// keeping only what follows the last "### 結論" marker.
function extractFinalAnswer(text) {
  if (!text) return text;
  const marker = '### 結論';
  const idx = text.lastIndexOf(marker);
  return idx === -1 ? text : text.slice(idx + marker.length).trim();
}

// Derive a test case's aggregate status/output fields (used by the list
// row badge and the top of the detail popover) from its per-model results.
// Aggregate rule: RUNNING if any model is still running, else FAILED if
// any model failed, else PASSED only if every run model passed.
function recomputeAggregate(tc) {
  const entries = Object.values(tc.modelResults || {});
  if (entries.length === 0) {
    tc.status = 'idle';
    tc.resultText = '';
    tc.sessionData = null;
    tc.execId = '';
    tc.logs = [];
    tc.errorMsg = '';
    return;
  }
  if (entries.some(e => e.status === 'running')) tc.status = 'running';
  else if (entries.some(e => e.status === 'error')) tc.status = 'error';
  else if (entries.every(e => e.status === 'success')) tc.status = 'success';
  else tc.status = 'idle';

  // Mirror the most recently updated entry into the flat fields that the
  // list/detail views already read, so a single-model run behaves exactly
  // like before.
  const latest = entries[entries.length - 1];
  tc.resultText = latest.resultText;
  tc.sessionData = latest.sessionData;
  tc.execId = latest.execId;
  tc.logs = latest.logs;
  tc.errorMsg = latest.errorMsg;
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

  const agentId = agentSelect.value || '<agent_id>';
  const tempExecId = tc.execId || 'tc_temp';
  const toolsStr = tc.tools && tc.tools.length > 0 ? encodeURIComponent(tc.tools.join(',')) : '';
  const knowledgesStr = tc.knowledges && tc.knowledges.length > 0 ? encodeURIComponent(tc.knowledges.join(',')) : '';
  const messageStr = encodeURIComponent(tc.prompt);
  let requestUrl = `${apiBase()}/input?agent_id=${encodeURIComponent(agentId)}&action=run&exec_id=${tempExecId}`;
  if (toolsStr) requestUrl += `&tools=${toolsStr}`;
  if (knowledgesStr) requestUrl += `&knowledges=${knowledgesStr}`;
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

  // Per-Model Results (only meaningful once at least one model has run)
  const modelEntries = Object.entries(tc.modelResults || {});
  if (modelEntries.length > 0) {
    detailModelsSec.style.display = 'block';
    detailModelResults.innerHTML = '';
    modelEntries.forEach(([key, entry]) => {
      let statusColor = 'var(--text-muted)';
      if (entry.status === 'success') statusColor = 'var(--success)';
      else if (entry.status === 'error') statusColor = 'var(--error)';
      else if (entry.status === 'running') statusColor = 'var(--info)';
      const preview = getFullResultText(entry) || '(no output)';
      const row = document.createElement('div');
      row.className = 'detail-model-row';
      row.innerHTML = `
        <div class="detail-model-row-header">
          <span class="detail-model-name">${escapeHtml(modelLabelFor(key))}</span>
          <span style="color:${statusColor}; font-weight:600;">${escapeHtml(entry.status.toUpperCase())}</span>
        </div>
        <div class="detail-model-row-body">${escapeHtml(preview)}</div>
      `;
      detailModelResults.appendChild(row);
    });
  } else {
    detailModelsSec.style.display = 'none';
  }

  // Anchor next to the selected row now that content is populated
  // (accurate popover size needed for edge-flip/clamp math).
  const itemEl = testCasesList.querySelector(`.test-item[data-index="${idx}"]`);
  positionDetailPopover(itemEl);
}

// Run a single test case's row "▶ Run" button: executes once per checked
// Model List entry (in list order), sequentially; falls back to the test
// case's own `model` field when no Model List entry is checked.
async function runSingleTest(idx) {
  const models = getCheckedModels();
  const modelSeq = models.length > 0 ? models : [null];
  const tc = testCases[idx];
  if (!tc.modelResults) tc.modelResults = {};
  modelSeq.forEach(m => { delete tc.modelResults[modelKeyFor(m)]; });
  recomputeAggregate(tc);
  renderTestCasesList();
  updateStats();
  if (currentSelectedCaseIndex === idx) selectTestCase(idx);

  for (const model of modelSeq) {
    await withLmStudioModel(model, () => executeTestCaseForModel(idx, model));
  }
}

// Execute test case `idx` once, overriding its `model` field with
// `modelOverride` (or falling back to the test case's own setting when
// null). Stores the outcome under tc.modelResults[key] and resolves once
// the run has fully finished (or failed to start).
async function executeTestCaseForModel(idx, modelOverride) {
  const tc = testCases[idx];
  const key = modelKeyFor(modelOverride);
  if (!tc.modelResults) tc.modelResults = {};
  const entry = { model: key, status: 'running', resultText: '', sessionData: null, execId: '', logs: [], errorMsg: '' };
  tc.modelResults[key] = entry;
  recomputeAggregate(tc);
  renderTestCasesList();
  updateStats();
  if (currentSelectedCaseIndex === idx) selectTestCase(idx);

  if (!isServerOnline) {
    entry.status = 'error';
    entry.errorMsg = 'Server is offline. Start Agent.exe first!';
    entry.resultText = entry.errorMsg;
    recomputeAggregate(tc);
    renderTestCasesList();
    updateStats();
    if (currentSelectedCaseIndex === idx) selectTestCase(idx);
    return;
  }
  const agentId = agentSelect.value;
  if (!agentId) {
    entry.status = 'error';
    entry.errorMsg = 'Please select an Agent first.';
    entry.resultText = entry.errorMsg;
    recomputeAggregate(tc);
    renderTestCasesList();
    updateStats();
    if (currentSelectedCaseIndex === idx) selectTestCase(idx);
    return;
  }

  const execId = 'tc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  entry.execId = execId;

  try {
    // Send POST input run request (via Rust)
    const requestBody = {
      agent_id: agentId,
      action: 'run',
      exec_id: execId,
      tools: tc.tools || [],
      model: modelOverride || tc.model || '',
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

    await pollUntilFinished(idx, key, agentId, execId);
  } catch (err) {
    entry.status = 'error';
    entry.errorMsg = String(err);
    entry.resultText = `Failed to trigger execution: ${err}`;
    recomputeAggregate(tc);
    renderTestCasesList();
    updateStats();
    if (currentSelectedCaseIndex === idx) selectTestCase(idx);
  }
}

// Poll status of executing agent until this exec_id finishes; resolves
// once the result (and assertion check) has been recorded.
function pollUntilFinished(idx, modelKey, agentId, execId) {
  const tc = testCases[idx];
  const entry = tc.modelResults[modelKey];
  const maxAttempts = 120; // 2 minutes timeout

  return new Promise((resolve) => {
    let attempts = 0;
    const interval = setInterval(async () => {
      attempts++;
      if (attempts > maxAttempts) {
        clearInterval(interval);
        entry.status = 'error';
        entry.errorMsg = 'Timeout: Agent execution exceeded 2 minutes';
        entry.resultText = 'Polling timeout.';
        recomputeAggregate(tc);
        renderTestCasesList();
        updateStats();
        if (currentSelectedCaseIndex === idx) selectTestCase(idx);
        resolve();
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
          entry.status = 'running';
          // Update live output preview if any
          if (detail.currentRound) {
            entry.resultText = `Running... Round ${detail.currentRound}. Tokens: ${detail.currentTokens || 0}`;
            if (currentSelectedCaseIndex === idx) {
              detailCaseOutput.innerText = entry.resultText;
            }
          }
        }

        if (isFinished) {
          clearInterval(interval);

          // Gather result details
          entry.resultText = detail.lastContentPreview || '';
          const isSuccessRun = detail.lastSuccess !== false;

          // Store session metadata. Always include `steps`/`messages`/`exchanges`/`logs`
          // as arrays so check expressions can safely call e.g. session.steps.some(...)
          // even when no session file is ever produced for this run, or the fetched
          // session JSON is missing one of these fields.
          const emptySessionData = {
            lastSessionUrl: detail.lastSessionUrl,
            lastSessionPath: detail.lastSessionPath,
            lastTokens: detail.lastTokens,
            lastRounds: detail.lastRounds,
            steps: [],
            messages: [],
            exchanges: [],
            logs: []
          };
          entry.sessionData = emptySessionData;

          // Attempt to load full session file to get steps/messages/logs
          if (detail.lastSessionUrl) {
            try {
              const fullSession = await invoke('fetch_url_json', {
                url: resolveServerUrl(detail.lastSessionUrl)
              });
              // `fullSession` is FoxAgent's whole shared, ever-growing session file
              // (all steps/messages for every test case run against this agent today —
              // several MB and climbing). Only the step for *this* exec is relevant to
              // checks/display, so keep just that slice; storing the full array in every
              // test case's sessionData bloats memory and makes "Save Results" try to
              // serialize hundreds of MB.
              const allSteps = Array.isArray(fullSession.steps) ? fullSession.steps : [];
              entry.sessionData = {
                ...emptySessionData,
                id: fullSession.id,
                created_at: fullSession.created_at,
                updated_at: fullSession.updated_at,
                title: fullSession.title,
                steps: allSteps.length ? [allSteps[allSteps.length - 1]] : [],
                messages: [],
                exchanges: fullSession.exchanges || [],
                logs: fullSession.logs || []
              };
              entry.logs = entry.sessionData.logs;
            } catch (e) {
              console.error('Failed to load session details', e);
            }
          }

          // If the agent execution itself failed
          if (!isSuccessRun) {
            entry.status = 'error';
            entry.errorMsg = 'Agent aborted or run execution failed internally';
          } else {
            // Run the assertion check
            verifyCheckExpressionForEntry(tc, entry);
          }

          recomputeAggregate(tc);
          renderTestCasesList();
          updateStats();
          if (currentSelectedCaseIndex === idx) selectTestCase(idx);
          resolve();
        }
      } catch (err) {
        console.error('Polling error', err);
      }
    }, 1000);
  });
}

// Evaluate JavaScript verification expression against one model's result entry.
function verifyCheckExpressionForEntry(tc, entry) {
  const resultText = getFullResultText(entry);
  const sessionObj = entry.sessionData || { exchanges: [], logs: [] };

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
      entry.status = 'success';
    } else {
      entry.status = 'error';
      entry.errorMsg = 'Assertion failed: check expression evaluated to false.';
    }
  } catch (err) {
    entry.status = 'error';
    entry.errorMsg = `Assertion check syntax error: ${err.message}`;
  }
}

// Run all tests: iterates checked Model List entries in list order,
// running every test case to completion for one model before moving on
// to the next (rather than interleaving models per test case). Falls
// back to each test case's own `model` field when no model is checked.
async function runAllTests() {
  if (isRunningAll) return;
  isRunningAll = true;
  stopRequested = false;
  btnRunAll.disabled = true;
  btnStopAll.disabled = false;
  btnStopAll.innerHTML = '<span>■</span> Stop';
  agentSelect.disabled = true;

  const models = getCheckedModels();
  const modelSeq = models.length > 0 ? models : [null];

  // Clear out only the result slots we're about to (re)run, so re-running
  // a subset of models doesn't wipe sibling-model results still on screen.
  testCases.forEach(tc => {
    if (!tc.modelResults) tc.modelResults = {};
    modelSeq.forEach(m => { delete tc.modelResults[modelKeyFor(m)]; });
    recomputeAggregate(tc);
  });
  renderTestCasesList();
  updateStats();

  for (const model of modelSeq) {
    await withLmStudioModel(model, async () => {
      for (let i = 0; i < testCases.length; i++) {
        if (stopRequested) return;
        await executeTestCaseForModel(i, model);
      }
    });
    if (stopRequested) break;
  }

  await autoSaveTestResults();

  isRunningAll = false;
  stopRequested = false;
  btnRunAll.disabled = false;
  btnStopAll.disabled = true;
  btnStopAll.innerHTML = '<span>■</span> Stop';
  agentSelect.disabled = false;
  updateStats();
  renderTestCasesList();
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
