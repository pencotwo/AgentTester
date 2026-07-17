# Agent Test Suite (Tauri)

Agent prompt / tool 驗證儀表板的 Rust Tauri 桌面版,由原本的單頁 `test_case.html` 改造而來。
A Rust Tauri desktop port of the single-page `test_case.html` testing dashboard for the agent server.

## 架構 / Architecture

```
AgentTester/
├── src/                      # 前端 (純 HTML/CSS/JS,無需 npm / bundler)
│   ├── index.html            #   Frontend (vanilla HTML/CSS/JS, no npm/bundler needed)
│   ├── styles.css
│   └── main.js               #   所有 fetch 改為 invoke() 呼叫 Rust 指令
├── src-tauri/                # Rust 後端 / Rust backend
│   ├── src/lib.rs            #   Tauri commands(HTTP、檔案對話框、開啟瀏覽器)
│   ├── src/main.rs
│   ├── tauri.conf.json
│   ├── capabilities/default.json
│   └── icons/
├── test_case.json            # 測試案例設定檔(啟動時自動載入)
└── test_case.html            # 原始單頁版本(保留參考)/ original single-file version (kept for reference)
```

## Rust 指令 / Tauri Commands

所有網路請求與檔案存取都在 Rust 端執行,WebView 完全不直接連網(避免 CORS 問題):
All network and file I/O happens in Rust — the webview never talks to the network directly (no CORS issues):

| Command | 用途 / Purpose |
|---|---|
| `check_health(port)` | GET `/health` 檢查 Agent 伺服器是否在線(2 秒逾時) |
| `api_get(port, query)` | GET `/input?{query}`(list_agents、get_status) |
| `api_post(port, body)` | POST `/input` 觸發 agent 執行 / trigger an agent run |
| `fetch_url_json(url)` | 抓取 session JSON(僅允許 loopback 位址 / loopback-only) |
| `load_default_test_cases()` | 自動從執行檔旁 / 工作目錄載入 `test_case.json` |
| `open_test_case_dialog()` | 原生開檔對話框 / native open-file dialog |
| `save_test_case_dialog(content)` | 原生存檔對話框 / native save-file dialog |
| `open_in_browser(url)` | 用系統預設瀏覽器開啟連結 / open link in default browser |

## 測試案例格式 / Test Case Format

`test_case.json` 為測試案例陣列,每個案例的欄位如下:
`test_case.json` is an array of test cases; each case has the following fields:

```json
{
  "id": 1,
  "name": "測試名稱 / test name",
  "prompt": "要發送給 Agent 的訊息 / message sent to the agent",
  "tools": ["execute_command"],
  "knowledges": ["kb_name"],
  "model": "qwen2.5-coder-3b-instruct",
  "check": "result.includes('關鍵字')"
}
```

| 欄位 / Field | 說明 / Description |
|---|---|
| `id` | 案例編號 / case number |
| `name` | 顯示名稱 / display name |
| `prompt` | 發送給 Agent 的訊息 / the message sent to the agent |
| `tools` | 此案例允許使用的工具,可為空陣列 / tools the case may use; can be empty |
| `knowledges` | 此案例使用的知識庫;**有設定且非空時才會隨 request 發送** / knowledge bases for the case; **only sent with the request when set and non-empty** |
| `model` | 指定模型,空字串代表使用 Agent 預設 / model override; empty string uses the agent default |
| `check` | 驗證用 JavaScript 表達式,可使用 `result`(最終回覆)與 `session`(完整 session 物件)/ JS assertion expression with `result` (final reply) and `session` (full session object) |

## 開發與建置 / Development & Build

需求 / Prerequisites: Rust toolchain + `tauri-cli`(`cargo install tauri-cli`)+ WebView2(Windows 10/11 內建)。

```sh
# 一鍵啟動 / one-click launch:
#   有 release exe 就直接執行,否則自動改跑 cargo tauri dev
#   runs the built release exe if present, else falls back to dev mode
run.bat

# 開發模式(從 repo 根目錄執行)/ dev mode (run from the repo root)
cargo tauri dev

# 建置發行版(產出 exe 與安裝檔)/ release build (exe + installers)
cargo tauri build
# 輸出 / output: src-tauri/target/release/agent-tester.exe
#                src-tauri/target/release/bundle/ (msi / nsis)
```

## 使用 / Usage

1. 先啟動 Agent 伺服器(HTTP API 預設埠 37123,可在標題列欄位修改)。
   Start the agent server first (HTTP API defaults to port 37123; changeable in the header field).
2. 把 `test_case.json` 放在 exe 旁邊或 repo 根目錄會自動載入;也可以點擊/拖曳載入,或直接在 JSON 編輯器修改後 Apply。
   `test_case.json` next to the exe (or repo root in dev) auto-loads; you can also click/drag to load, or edit in the JSON editor and Apply.
3. Run All 或單一 Run 執行測試,右側面板顯示執行細節、session 與 App logs。
   Run all tests or a single one; the right panel shows execution detail, session data, and app logs.
