// 로컬 AI 도구 로그를 안전하게 읽고 트레이 창을 관리하는 Tauri 백엔드
use serde::Serialize;
use std::{fs, io::{BufRead, BufReader}, path::{Path, PathBuf}, time::UNIX_EPOCH};
use tauri::{menu::{Menu, MenuItem}, tray::TrayIconBuilder, Manager};

fn credential_entry(provider: &str) -> Result<keyring::Entry, String> {
    if !matches!(provider, "openai" | "anthropic" | "google") {
        return Err("지원하지 않는 공급사입니다".into());
    }
    keyring::Entry::new("app.tokendeck.desktop", provider).map_err(|error| error.to_string())
}

#[tauri::command]
fn store_provider_secret(provider: String, secret: String) -> Result<(), String> {
    if secret.trim().is_empty() { return Err("빈 자격 증명은 저장할 수 없습니다".into()); }
    credential_entry(&provider)?.set_password(&secret).map_err(|error| error.to_string())
}

#[tauri::command]
fn load_provider_secret(provider: String) -> Result<Option<String>, String> {
    match credential_entry(&provider)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn remove_provider_secret(provider: String) -> Result<(), String> {
    match credential_entry(&provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogDocument {
    provider: String,
    path: String,
    modified_at: u64,
    content: String,
    git_remote: Option<String>,
}

fn cwd_from_content(content: &str) -> Option<PathBuf> {
    content.lines().take(20).find_map(|line| {
        let value: serde_json::Value = serde_json::from_str(line).ok()?;
        value.get("cwd")
            .or_else(|| value.pointer("/payload/cwd"))
            .and_then(|cwd| cwd.as_str())
            .map(PathBuf::from)
    })
}

fn git_remote_from_cwd(cwd: Option<PathBuf>) -> Option<String> {
    let mut directory = cwd?;
    loop {
        let config = directory.join(".git").join("config");
        if let Ok(content) = fs::read_to_string(config) {
            let mut in_origin = false;
            for line in content.lines() {
                let trimmed = line.trim();
                if trimmed.starts_with('[') { in_origin = trimmed == "[remote \"origin\"]"; }
                if in_origin && trimmed.starts_with("url") {
                    return trimmed.split_once('=').map(|(_, url)| url.trim().to_owned());
                }
            }
        }
        if !directory.pop() { return None; }
    }
}

fn is_usage_line(provider: &str, line: &str) -> bool {
    match provider {
        "codex" => line.contains("\"token_count\"") || line.contains("\"session_meta\""),
        "claude" => line.contains("\"usage\""),
        "gemini" => line.contains("token.usage") || line.contains("gen_ai.usage"),
        _ => false,
    }
}

fn collect_files(root: &Path, extension: &str, provider: &str, modified_since: u64, output: &mut Vec<LogDocument>) {
    let Ok(entries) = fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, extension, provider, modified_since, output);
            continue;
        }
        if path.extension().and_then(|value| value.to_str()) != Some(extension) { continue; }
        let Ok(metadata) = entry.metadata() else { continue };
        let modified_at = metadata.modified().ok().and_then(|value| value.duration_since(UNIX_EPOCH).ok()).map_or(0, |value| value.as_secs());
        if modified_at <= modified_since { continue; }
        let Ok(file) = fs::File::open(&path) else { continue };
        let mut content = String::new();
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            if is_usage_line(provider, &line) {
                content.push_str(&line);
                content.push('\n');
            }
        }
        if content.is_empty() { continue; }
        let git_remote = git_remote_from_cwd(cwd_from_content(&content));
        output.push(LogDocument { provider: provider.into(), path: path.to_string_lossy().into_owned(), modified_at, content, git_remote });
    }
}

#[tauri::command]
fn scan_local_usage(modified_since: Option<u64>) -> Vec<LogDocument> {
    let Some(home) = std::env::var_os("USERPROFILE").map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(PathBuf::from)) else { return Vec::new() };
    let mut documents = Vec::new();
    let since = modified_since.unwrap_or(0);
    collect_files(&home.join(".codex").join("sessions"), "jsonl", "codex", since, &mut documents);
    collect_files(&home.join(".claude").join("projects"), "jsonl", "claude", since, &mut documents);
    collect_files(&home.join(".gemini"), "log", "gemini", since, &mut documents);
    documents.sort_by_key(|document| std::cmp::Reverse(document.modified_at));
    documents
}

#[tauri::command]
fn integration_status() -> serde_json::Value {
    let home = std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_default();
    serde_json::json!({
        "codex": home.join(".codex").join("sessions").exists(),
        "claude": home.join(".claude").join("projects").exists(),
        "gemini": home.join(".gemini").exists()
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let show = MenuItem::with_id(app, "show", "Token Deck 열기", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let _tray = TrayIconBuilder::new()
                .tooltip("Token Deck")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => if let Some(window) = app.get_webview_window("main") { let _ = window.show(); let _ = window.set_focus(); },
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_local_usage,
            integration_status,
            store_provider_secret,
            load_provider_secret,
            remove_provider_secret,
        ])
        .run(tauri::generate_context!())
        .expect("Token Deck 실행 중 오류가 발생했습니다");
}
