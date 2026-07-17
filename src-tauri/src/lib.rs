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
/// ListAgent server on 127.0.0.1 and to session URLs it hands back.
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

/// Candidate locations for test_case.json: next to the executable,
/// the working directory, and its parent (covers `cargo tauri dev`,
/// where the cwd is src-tauri/ and the file lives in the repo root).
fn default_test_case_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            paths.push(dir.join("test_case.json"));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        paths.push(cwd.join("test_case.json"));
        if let Some(parent) = cwd.parent() {
            paths.push(parent.join("test_case.json"));
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
    for path in default_test_case_paths() {
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
            open_test_case_dialog,
            save_test_case_dialog,
            open_in_browser
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
