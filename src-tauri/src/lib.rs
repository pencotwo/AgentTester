use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::time::Duration;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

/// File content paired with the full path it was read from, so the UI
/// can display where the loaded JSON config actually lives on disk.
#[derive(Serialize)]
struct LoadedFile {
    path: String,
    content: String,
}

fn http_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| e.to_string())
}

/// Only allow requests to the local machine — this app talks to the
/// agent server on 127.0.0.1 and to session URLs it hands back.
fn ensure_loopback(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("Invalid URL: {e}"))?;
    match parsed.host_str() {
        Some("127.0.0.1") | Some("localhost") | Some("[::1]") | Some("::1") => Ok(()),
        other => Err(format!(
            "Refusing non-loopback host: {}",
            other.unwrap_or("<none>")
        )),
    }
}

/// GET http://127.0.0.1:{port}/health — returns true when the server is up.
#[tauri::command]
async fn check_health(port: u16) -> bool {
    let Ok(client) = http_client(2) else {
        return false;
    };
    match client
        .get(format!("http://127.0.0.1:{port}/health"))
        .send()
        .await
    {
        Ok(res) => res.status().is_success(),
        Err(_) => false,
    }
}

/// GET http://127.0.0.1:{port}/input?{query} and parse the JSON body.
#[tauri::command]
async fn api_get(port: u16, query: String) -> Result<Value, String> {
    let client = http_client(30)?;
    let url = format!("http://127.0.0.1:{port}/input?{query}");
    let res = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("Server returned HTTP {}", res.status().as_u16()));
    }
    res.json::<Value>().await.map_err(|e| e.to_string())
}

/// POST a JSON body to http://127.0.0.1:{port}/input.
#[tauri::command]
async fn api_post(port: u16, body: Value) -> Result<Value, String> {
    let client = http_client(30)?;
    let url = format!("http://127.0.0.1:{port}/input");
    let res = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("Server returned HTTP {}", res.status().as_u16()));
    }
    Ok(res.json::<Value>().await.unwrap_or(Value::Null))
}

/// Fetch an arbitrary loopback URL as JSON (used for session files the
/// server links to, e.g. detail.lastSessionUrl).
#[tauri::command]
async fn fetch_url_json(url: String) -> Result<Value, String> {
    ensure_loopback(&url)?;
    let client = http_client(30)?;
    let res = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("Server returned HTTP {}", res.status().as_u16()));
    }
    res.json::<Value>().await.map_err(|e| e.to_string())
}

/// Candidate locations for a well-known config file: next to the executable,
/// the working directory, and its parent (covers `cargo tauri dev`,
/// where the cwd is src-tauri/ and the file lives in the repo root).
fn default_config_paths(filename: &str) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            paths.push(dir.join(filename));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        paths.push(cwd.join(filename));
        if let Some(parent) = cwd.parent() {
            paths.push(parent.join(filename));
        }
    }
    paths
}

/// Re-read a previously loaded/saved config file from its known path
/// (used by the JSON Config "Refresh" button).
#[tauri::command]
fn read_text_file(path: String) -> Result<LoadedFile, String> {
    let path = PathBuf::from(path);
    if !path.is_file() {
        return Err(format!("File not found: {}", path.display()));
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    Ok(LoadedFile {
        path: path.display().to_string(),
        content,
    })
}

#[tauri::command]
fn load_default_test_cases() -> Result<LoadedFile, String> {
    for path in default_config_paths("test_case.json") {
        if path.is_file() {
            let content = std::fs::read_to_string(&path)
                .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
            return Ok(LoadedFile {
                path: path.display().to_string(),
                content,
            });
        }
    }
    Err("test_case.json not found".into())
}

/// Load the Model List sidecar file (model_list.json). Unlike test_case.json
/// this file is fully app-managed — no open/save dialogs, just silent
/// auto-load/auto-save next to the executable.
#[tauri::command]
fn load_default_model_list() -> Result<LoadedFile, String> {
    for path in default_config_paths("model_list.json") {
        if path.is_file() {
            let content = std::fs::read_to_string(&path)
                .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
            return Ok(LoadedFile {
                path: path.display().to_string(),
                content,
            });
        }
    }
    Err("model_list.json not found".into())
}

/// Silently persist the Model List to a fixed location next to the
/// executable (no dialog — called after every add/delete/edit/reorder/
/// checkbox toggle, so a dialog every time would be unusable).
#[tauri::command]
fn save_model_list(content: String) -> Result<String, String> {
    let dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.to_path_buf()))
        .or_else(|| std::env::current_dir().ok())
        .ok_or("Unable to resolve a directory to save model_list.json")?;
    let path = dir.join("model_list.json");
    std::fs::write(&path, content).map_err(|e| format!("Failed to write {}: {e}", path.display()))?;
    Ok(path.display().to_string())
}

/// Native "open file" dialog; returns the file content + path, or None if cancelled.
#[tauri::command]
async fn open_test_case_dialog(app: tauri::AppHandle) -> Result<Option<LoadedFile>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("JSON", &["json"])
        .blocking_pick_file();
    match picked {
        Some(file) => {
            let path = file.into_path().map_err(|e| e.to_string())?;
            let content = std::fs::read_to_string(&path)
                .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
            Ok(Some(LoadedFile {
                path: path.display().to_string(),
                content,
            }))
        }
        None => Ok(None),
    }
}

/// Native "save file" dialog; returns the saved-to path, or None if cancelled.
#[tauri::command]
async fn save_test_case_dialog(app: tauri::AppHandle, content: String) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("JSON", &["json"])
        .set_file_name("test_case.json")
        .blocking_save_file();
    match picked {
        Some(file) => {
            let path = file.into_path().map_err(|e| e.to_string())?;
            std::fs::write(&path, content)
                .map_err(|e| format!("Failed to write {}: {e}", path.display()))?;
            Ok(Some(path.display().to_string()))
        }
        None => Ok(None),
    }
}

/// Native "save file" dialog for test *results* (separate default file
/// name / dialog title from the config-file save so users don't confuse
/// the two).
#[tauri::command]
async fn save_test_result_dialog(
    app: tauri::AppHandle,
    content: String,
    default_name: String,
) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("JSON", &["json"])
        .set_file_name(&default_name)
        .blocking_save_file();
    match picked {
        Some(file) => {
            let path = file.into_path().map_err(|e| e.to_string())?;
            std::fs::write(&path, content)
                .map_err(|e| format!("Failed to write {}: {e}", path.display()))?;
            Ok(Some(path.display().to_string()))
        }
        None => Ok(None),
    }
}

/// Native "open file" dialog for a previously saved test-result JSON file.
#[tauri::command]
async fn open_test_result_dialog(app: tauri::AppHandle) -> Result<Option<LoadedFile>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("JSON", &["json"])
        .blocking_pick_file();
    match picked {
        Some(file) => {
            let path = file.into_path().map_err(|e| e.to_string())?;
            let content = std::fs::read_to_string(&path)
                .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
            Ok(Some(LoadedFile {
                path: path.display().to_string(),
                content,
            }))
        }
        None => Ok(None),
    }
}

/// Build an `lms` invocation. On Windows, suppress the console window that
/// would otherwise flash briefly since this is a GUI app spawning a CLI tool.
fn lms_command(args: &[&str]) -> std::process::Command {
    let mut cmd = std::process::Command::new("lms");
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// `lms load <name> --yes` — used by the Model List card's "自動切換 LM
/// Studio Model" toggle to load a model before running its batch of tests.
/// `--yes` skips the interactive context-length/GPU-offload prompt.
#[tauri::command]
fn lms_load_model(name: String) -> Result<String, String> {
    let output = lms_command(&["load", &name, "--yes"]).output().map_err(|e| {
        format!("無法執行 lms load（請確認 LM Studio CLI 已安裝並在 PATH 中）：{e}")
    })?;
    if !output.status.success() {
        return Err(format!(
            "lms load {name} 失敗：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// `lms unload <name>` — called after a model's batch of tests finishes.
#[tauri::command]
fn lms_unload_model(name: String) -> Result<String, String> {
    let output = lms_command(&["unload", &name])
        .output()
        .map_err(|e| format!("無法執行 lms unload：{e}"))?;
    if !output.status.success() {
        return Err(format!(
            "lms unload {name} 失敗：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Open a URL in the system default browser (session JSON links, etc.).
#[tauri::command]
fn open_in_browser(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Only http(s) URLs can be opened".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            check_health,
            api_get,
            api_post,
            fetch_url_json,
            read_text_file,
            load_default_test_cases,
            load_default_model_list,
            save_model_list,
            open_test_case_dialog,
            save_test_case_dialog,
            save_test_result_dialog,
            open_test_result_dialog,
            lms_load_model,
            lms_unload_model,
            open_in_browser
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
