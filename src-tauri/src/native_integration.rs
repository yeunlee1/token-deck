// Windows 자동 시작과 Gemini CLI 로컬 텔레메트리 설정을 관리하는 네이티브 통합 모듈
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    fs,
    io::{ErrorKind, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::Command,
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

const AUTOSTART_VALUE_NAME: &str = "Token Deck";
const MAX_QUOTA_SCAN_DEPTH: usize = 32;
const MAX_QUOTA_FILES: usize = 10_000;
const MAX_QUOTA_TAIL_BYTES: u64 = 2 * 1024 * 1024;
static QUOTA_SCAN_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindowStatus {
    used_percent: f64,
    remaining_percent: f64,
    window_minutes: u64,
    resets_at: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderQuotaStatus {
    provider: String,
    supported: bool,
    plan_type: Option<String>,
    five_hour: Option<QuotaWindowStatus>,
    weekly: Option<QuotaWindowStatus>,
    daily: Option<QuotaWindowStatus>,
    message: Option<String>,
    updated_at: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeQuotaCaptureStatus {
    configured: bool,
    settings_path: String,
    data_path: String,
    has_data: bool,
    existing_status_line: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutostartStatus {
    supported: bool,
    enabled: bool,
    launch_command: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiStatus {
    installed: bool,
    version: Option<String>,
    executable_path: Option<String>,
    settings_path: String,
    settings_exists: bool,
    telemetry_configured: bool,
    telemetry_outfile: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiConfigurationResult {
    settings_path: String,
    backup_path: Option<String>,
    telemetry_outfile: String,
}

fn user_home() -> Result<PathBuf, String> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .ok_or_else(|| "사용자 홈 폴더를 찾을 수 없습니다".to_owned())
}

fn autostart_launch_command() -> Result<String, String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    Ok(format!("\"{}\" --hidden", executable.display()))
}

#[cfg(windows)]
fn read_autostart_command() -> Result<Option<String>, String> {
    use winreg::{
        enums::{HKEY_CURRENT_USER, KEY_READ},
        RegKey,
    };

    let current_user = RegKey::predef(HKEY_CURRENT_USER);
    let run = current_user
        .open_subkey_with_flags(
            "Software\\Microsoft\\Windows\\CurrentVersion\\Run",
            KEY_READ,
        )
        .map_err(|error| error.to_string())?;
    match run.get_value::<String, _>(AUTOSTART_VALUE_NAME) {
        Ok(command) => Ok(Some(command)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(not(windows))]
fn read_autostart_command() -> Result<Option<String>, String> {
    Ok(None)
}

#[tauri::command]
pub fn autostart_status() -> Result<AutostartStatus, String> {
    let command = read_autostart_command()?;
    Ok(AutostartStatus {
        supported: cfg!(windows),
        enabled: command.is_some(),
        launch_command: command,
    })
}

#[cfg(windows)]
fn update_autostart(enabled: bool) -> Result<(), String> {
    use winreg::{
        enums::{HKEY_CURRENT_USER, KEY_SET_VALUE},
        RegKey,
    };

    let current_user = RegKey::predef(HKEY_CURRENT_USER);
    let run = current_user
        .open_subkey_with_flags(
            "Software\\Microsoft\\Windows\\CurrentVersion\\Run",
            KEY_SET_VALUE,
        )
        .map_err(|error| error.to_string())?;
    if enabled {
        run.set_value(AUTOSTART_VALUE_NAME, &autostart_launch_command()?)
            .map_err(|error| error.to_string())
    } else {
        match run.delete_value(AUTOSTART_VALUE_NAME) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

#[cfg(not(windows))]
fn update_autostart(_enabled: bool) -> Result<(), String> {
    Err("현재 자동 시작 설정은 Windows에서만 지원합니다".to_owned())
}

#[tauri::command]
pub fn set_autostart(enabled: bool) -> Result<AutostartStatus, String> {
    update_autostart(enabled)?;
    autostart_status()
}

fn gemini_paths() -> Result<(PathBuf, PathBuf), String> {
    let gemini_directory = user_home()?.join(".gemini");
    Ok((
        gemini_directory.join("settings.json"),
        gemini_directory.join("telemetry.log"),
    ))
}

fn read_settings(path: &Path) -> Result<Option<Value>, String> {
    match fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content)
            .map(Some)
            .map_err(|error| format!("Gemini 설정 JSON을 읽을 수 없습니다. {error}")),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn is_telemetry_configured(settings: Option<&Value>, outfile: &Path) -> bool {
    let Some(telemetry) = settings.and_then(|value| value.get("telemetry")) else {
        return false;
    };
    telemetry.get("enabled").and_then(Value::as_bool) == Some(true)
        && telemetry.get("target").and_then(Value::as_str) == Some("local")
        && telemetry.get("logPrompts").and_then(Value::as_bool) == Some(false)
        && telemetry.get("outfile").and_then(Value::as_str)
            == Some(outfile.to_string_lossy().as_ref())
}

#[cfg(windows)]
fn gemini_command_output(arguments: &[&str]) -> Option<String> {
    let output = Command::new("cmd")
        .args(["/D", "/C", "gemini"])
        .args(arguments)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

#[cfg(not(windows))]
fn gemini_command_output(arguments: &[&str]) -> Option<String> {
    let output = Command::new("gemini").args(arguments).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

#[cfg(windows)]
fn gemini_executable_path() -> Option<String> {
    let output = Command::new("where.exe").arg("gemini").output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_owned)
}

#[cfg(not(windows))]
fn gemini_executable_path() -> Option<String> {
    let output = Command::new("which").arg("gemini").output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

#[tauri::command]
pub fn gemini_status() -> Result<GeminiStatus, String> {
    let (settings_path, outfile) = gemini_paths()?;
    let settings = read_settings(&settings_path)?;
    let executable_path = gemini_executable_path();
    let version = executable_path
        .as_ref()
        .and_then(|_| gemini_command_output(&["--version"]))
        .filter(|value| !value.is_empty());
    Ok(GeminiStatus {
        installed: executable_path.is_some(),
        version,
        executable_path,
        settings_path: settings_path.to_string_lossy().into_owned(),
        settings_exists: settings.is_some(),
        telemetry_configured: is_telemetry_configured(settings.as_ref(), &outfile),
        telemetry_outfile: outfile.to_string_lossy().into_owned(),
    })
}

fn backup_path(settings_path: &Path) -> Result<PathBuf, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    Ok(settings_path.with_file_name(format!("settings.json.backup-{timestamp}")))
}

fn merge_telemetry_settings(
    mut settings: Map<String, Value>,
    outfile: &Path,
) -> Result<Map<String, Value>, String> {
    let telemetry_value = settings
        .entry("telemetry".to_owned())
        .or_insert_with(|| Value::Object(Map::new()));
    let telemetry = telemetry_value
        .as_object_mut()
        .ok_or_else(|| "기존 telemetry 설정이 JSON 객체가 아닙니다".to_owned())?;
    telemetry.insert("enabled".to_owned(), Value::Bool(true));
    telemetry.insert("target".to_owned(), Value::String("local".to_owned()));
    telemetry.insert(
        "outfile".to_owned(),
        Value::String(outfile.to_string_lossy().into_owned()),
    );
    telemetry.insert("logPrompts".to_owned(), Value::Bool(false));
    Ok(settings)
}

#[tauri::command]
pub fn configure_gemini_telemetry() -> Result<GeminiConfigurationResult, String> {
    let (settings_path, outfile) = gemini_paths()?;
    let existing = read_settings(&settings_path)?;
    let mut settings = match existing
        .clone()
        .unwrap_or_else(|| Value::Object(Map::new()))
    {
        Value::Object(settings) => settings,
        _ => return Err("Gemini 설정의 최상위 값은 JSON 객체여야 합니다".to_owned()),
    };

    settings = merge_telemetry_settings(settings, &outfile)?;

    let backup = if existing.is_some() {
        let backup = backup_path(&settings_path)?;
        fs::copy(&settings_path, &backup).map_err(|error| error.to_string())?;
        Some(backup)
    } else {
        None
    };

    let parent = settings_path
        .parent()
        .ok_or_else(|| "Gemini 설정 폴더를 찾을 수 없습니다".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = settings_path.with_extension("json.tmp");
    let serialized = serde_json::to_string_pretty(&Value::Object(settings))
        .map_err(|error| error.to_string())?;
    fs::write(&temporary, format!("{serialized}\n")).map_err(|error| error.to_string())?;
    if let Err(error) = fs::rename(&temporary, &settings_path) {
        if error.kind() == ErrorKind::AlreadyExists || settings_path.exists() {
            fs::remove_file(&settings_path).map_err(|remove_error| remove_error.to_string())?;
            fs::rename(&temporary, &settings_path)
                .map_err(|rename_error| rename_error.to_string())?;
        } else {
            return Err(error.to_string());
        }
    }

    Ok(GeminiConfigurationResult {
        settings_path: settings_path.to_string_lossy().into_owned(),
        backup_path: backup.map(|path| path.to_string_lossy().into_owned()),
        telemetry_outfile: outfile.to_string_lossy().into_owned(),
    })
}

fn quota_window(value: &Value, default_minutes: u64) -> Option<QuotaWindowStatus> {
    let raw = value
        .get("used_percent")
        .or_else(|| value.get("used_percentage"))
        .or_else(|| value.get("utilization"))?
        .as_f64()?;
    let used = if raw <= 1.0
        && value.get("used_percent").is_none()
        && value.get("used_percentage").is_none()
    {
        raw * 100.0
    } else {
        raw
    };
    let used = used.clamp(0.0, 100.0);
    Some(QuotaWindowStatus {
        used_percent: used,
        remaining_percent: 100.0 - used,
        window_minutes: value
            .get("window_minutes")
            .and_then(Value::as_u64)
            .unwrap_or(default_minutes),
        resets_at: value
            .get("resets_at")
            .or_else(|| value.get("reset_at"))
            .and_then(Value::as_u64),
    })
}

fn parse_codex_quota(value: &Value) -> Option<ProviderQuotaStatus> {
    let limits = value.pointer("/payload/rate_limits")?;
    let primary = limits
        .get("primary")
        .and_then(|window| quota_window(window, 300));
    let secondary = limits
        .get("secondary")
        .and_then(|window| quota_window(window, 10_080));
    Some(ProviderQuotaStatus {
        provider: "codex".to_owned(),
        supported: primary.is_some() || secondary.is_some(),
        plan_type: limits
            .get("plan_type")
            .and_then(Value::as_str)
            .map(str::to_owned),
        five_hour: primary.filter(|window| window.window_minutes == 300),
        weekly: secondary.filter(|window| window.window_minutes == 10_080),
        daily: None,
        message: None,
        updated_at: None,
    })
}

fn newest_codex_quota(root: &Path) -> Option<ProviderQuotaStatus> {
    let mut newest: Option<(SystemTime, ProviderQuotaStatus)> = None;
    let mut files_seen = 0;
    find_codex_quota(root, &mut newest, 0, &mut files_seen);
    newest.map(|(_, quota)| quota)
}

fn read_file_tail(path: &Path, max_bytes: u64) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    let start = length.saturating_sub(max_bytes);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::with_capacity((length - start).min(max_bytes) as usize);
    file.take(max_bytes).read_to_end(&mut bytes).ok()?;
    if start > 0 {
        let newline = bytes.iter().position(|byte| *byte == b'\n')?;
        bytes.drain(..=newline);
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn find_codex_quota(
    root: &Path,
    newest: &mut Option<(SystemTime, ProviderQuotaStatus)>,
    depth: usize,
    files_seen: &mut usize,
) {
    if depth > MAX_QUOTA_SCAN_DEPTH || *files_seen >= MAX_QUOTA_FILES {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if *files_seen >= MAX_QUOTA_FILES {
            return;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if crate::is_link_like(&file_type) {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            find_codex_quota(&path, newest, depth + 1, files_seen);
            continue;
        }
        if path.extension().and_then(|extension| extension.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|metadata| metadata.modified()) else {
            continue;
        };
        *files_seen += 1;
        if newest
            .as_ref()
            .is_some_and(|(current, _)| *current > modified)
        {
            continue;
        }
        let Some(content) = read_file_tail(&path, MAX_QUOTA_TAIL_BYTES) else {
            continue;
        };
        let quota = content.lines().rev().find_map(|line| {
            serde_json::from_str::<Value>(line)
                .ok()
                .and_then(|value| parse_codex_quota(&value))
        });
        if let Some(mut quota) = quota {
            quota.updated_at = modified
                .duration_since(UNIX_EPOCH)
                .ok()
                .map(|value| value.as_secs());
            *newest = Some((modified, quota));
        }
    }
}

fn claude_paths() -> Result<(PathBuf, PathBuf), String> {
    let home = user_home()?;
    Ok((
        home.join(".claude").join("settings.json"),
        home.join(".token-deck").join("claude-quota.json"),
    ))
}

fn claude_capture_status_inner() -> Result<ClaudeQuotaCaptureStatus, String> {
    let (settings_path, data_path) = claude_paths()?;
    let settings = match fs::read_to_string(&settings_path) {
        Ok(content) => serde_json::from_str::<Value>(&content)
            .map_err(|error| format!("Claude 설정 JSON을 읽을 수 없습니다. {error}"))?,
        Err(error) if error.kind() == ErrorKind::NotFound => Value::Object(Map::new()),
        Err(error) => return Err(error.to_string()),
    };
    let command = settings
        .pointer("/statusLine/command")
        .and_then(Value::as_str);
    let expected =
        claude_statusline_command(&std::env::current_exe().map_err(|error| error.to_string())?);
    Ok(ClaudeQuotaCaptureStatus {
        configured: settings.pointer("/statusLine/type").and_then(Value::as_str) == Some("command")
            && command == Some(expected.as_str()),
        existing_status_line: settings.get("statusLine").is_some(),
        settings_path: settings_path.to_string_lossy().into_owned(),
        data_path: data_path.to_string_lossy().into_owned(),
        has_data: data_path.exists(),
    })
}

fn claude_statusline_command(executable: &Path) -> String {
    let portable_path = executable.to_string_lossy().replace('\\', "/");
    format!("\"{portable_path}\" --claude-statusline")
}

fn merge_claude_statusline(
    mut settings: Map<String, Value>,
    command: &str,
) -> Result<Map<String, Value>, String> {
    match settings.get("statusLine") {
        Some(Value::Object(status_line))
            if status_line.get("type").and_then(Value::as_str) == Some("command")
                && status_line.get("command").and_then(Value::as_str) == Some(command) =>
        {
            return Ok(settings);
        }
        Some(_) => {
            return Err(
                "기존 Claude statusLine 설정이 있어 자동으로 덮어쓰지 않았습니다".to_owned(),
            );
        }
        None => {}
    }
    settings.insert(
        "statusLine".to_owned(),
        serde_json::json!({
            "type": "command",
            "command": command
        }),
    );
    Ok(settings)
}

#[tauri::command]
pub fn claude_quota_capture_status() -> Result<ClaudeQuotaCaptureStatus, String> {
    claude_capture_status_inner()
}

#[tauri::command]
pub fn configure_claude_quota_capture() -> Result<ClaudeQuotaCaptureStatus, String> {
    let (settings_path, _) = claude_paths()?;
    let existing = match fs::read_to_string(&settings_path) {
        Ok(content) => Some(
            serde_json::from_str::<Value>(&content)
                .map_err(|error| format!("Claude 설정 JSON을 읽을 수 없습니다. {error}"))?,
        ),
        Err(error) if error.kind() == ErrorKind::NotFound => None,
        Err(error) => return Err(error.to_string()),
    };
    let settings = match existing
        .clone()
        .unwrap_or_else(|| Value::Object(Map::new()))
    {
        Value::Object(settings) => settings,
        _ => return Err("Claude 설정의 최상위 값은 JSON 객체여야 합니다".to_owned()),
    };
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let command = claude_statusline_command(&executable);
    if settings
        .get("statusLine")
        .and_then(|value| value.get("type"))
        .and_then(Value::as_str)
        == Some("command")
        && settings
            .get("statusLine")
            .and_then(|value| value.get("command"))
            .and_then(Value::as_str)
            == Some(command.as_str())
    {
        return claude_capture_status_inner();
    }
    let settings = merge_claude_statusline(settings, &command)?;
    if existing.is_some() {
        fs::copy(&settings_path, backup_path(&settings_path)?)
            .map_err(|error| error.to_string())?;
    }
    if let Some(parent) = settings_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(
        &settings_path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&Value::Object(settings))
                .map_err(|error| error.to_string())?
        ),
    )
    .map_err(|error| error.to_string())?;
    claude_capture_status_inner()
}

fn claude_quota_from_file(path: &Path) -> Option<ProviderQuotaStatus> {
    fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
}

fn quota_statuses_blocking() -> Result<Vec<ProviderQuotaStatus>, String> {
    let _scan_guard = QUOTA_SCAN_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let home = user_home()?;
    let codex = newest_codex_quota(&home.join(".codex").join("sessions")).unwrap_or_else(|| {
        ProviderQuotaStatus {
            provider: "codex".to_owned(),
            supported: false,
            plan_type: None,
            five_hour: None,
            weekly: None,
            daily: None,
            message: Some("Codex 한도 이벤트를 기다리는 중입니다".to_owned()),
            updated_at: None,
        }
    });
    let (_, claude_data) = claude_paths()?;
    let claude = claude_quota_from_file(&claude_data).unwrap_or_else(|| ProviderQuotaStatus {
        provider: "claude".to_owned(),
        supported: false,
        plan_type: None,
        five_hour: None,
        weekly: None,
        daily: None,
        message: Some("설정에서 Claude 한도 연동을 활성화하세요".to_owned()),
        updated_at: None,
    });
    let gemini = ProviderQuotaStatus {
        provider: "gemini".to_owned(),
        supported: false,
        plan_type: None,
        five_hour: None,
        weekly: None,
        daily: None,
        message: Some("Gemini CLI 정액제는 5시간·주간 한도를 제공하지 않습니다".to_owned()),
        updated_at: None,
    };
    Ok(vec![codex, claude, gemini])
}

#[tauri::command]
pub async fn quota_statuses() -> Result<Vec<ProviderQuotaStatus>, String> {
    tauri::async_runtime::spawn_blocking(quota_statuses_blocking)
        .await
        .map_err(|error| format!("한도 상태 수집 작업을 완료하지 못했습니다. {error}"))?
}

pub fn run_claude_statusline_capture() -> Result<(), String> {
    let mut input = String::new();
    std::io::stdin()
        .read_to_string(&mut input)
        .map_err(|error| error.to_string())?;
    let value: Value = serde_json::from_str(&input).map_err(|error| error.to_string())?;
    let quota = claude_quota_from_statusline(&value, SystemTime::now())?;
    let (_, data_path) = claude_paths()?;
    if let Some(parent) = data_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(
        &data_path,
        serde_json::to_string(&quota).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let five = quota
        .five_hour
        .as_ref()
        .map(|window| format!("5h {:.0}%", window.remaining_percent));
    let week = quota
        .weekly
        .as_ref()
        .map(|window| format!("7d {:.0}%", window.remaining_percent));
    println!(
        "{}",
        [five, week]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" · ")
    );
    Ok(())
}

fn claude_quota_from_statusline(
    value: &Value,
    captured_at: SystemTime,
) -> Result<ProviderQuotaStatus, String> {
    let limits = value.get("rate_limits").unwrap_or(&Value::Null);
    let five_hour = limits
        .get("five_hour")
        .and_then(|window| quota_window(window, 300));
    let weekly = limits
        .get("seven_day")
        .and_then(|window| quota_window(window, 10_080));
    let now = captured_at
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();
    Ok(ProviderQuotaStatus {
        provider: "claude".to_owned(),
        supported: five_hour.is_some() || weekly.is_some(),
        plan_type: None,
        five_hour,
        weekly,
        daily: None,
        message: None,
        updated_at: Some(now),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        autostart_launch_command, claude_quota_from_statusline, claude_statusline_command,
        is_telemetry_configured, merge_claude_statusline, merge_telemetry_settings,
        parse_codex_quota, read_file_tail,
    };
    use serde_json::json;
    use std::{
        fs,
        path::Path,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn telemetry_requires_prompt_logging_to_be_disabled() {
        let outfile = Path::new("C:\\Users\\tester\\.gemini\\telemetry.log");
        let safe = json!({
            "telemetry": {
                "enabled": true,
                "target": "local",
                "outfile": "C:\\Users\\tester\\.gemini\\telemetry.log",
                "logPrompts": false
            }
        });
        let unsafe_settings = json!({
            "telemetry": {
                "enabled": true,
                "target": "local",
                "outfile": "C:\\Users\\tester\\.gemini\\telemetry.log",
                "logPrompts": true
            }
        });

        assert!(is_telemetry_configured(Some(&safe), outfile));
        assert!(!is_telemetry_configured(Some(&unsafe_settings), outfile));
    }

    #[test]
    fn telemetry_merge_preserves_unrelated_settings() {
        let outfile = Path::new("C:\\Users\\tester\\.gemini\\telemetry.log");
        let existing = json!({
            "theme": "dark",
            "telemetry": { "traces": true, "logPrompts": true }
        });
        let merged =
            merge_telemetry_settings(existing.as_object().unwrap().clone(), outfile).unwrap();

        assert_eq!(merged.get("theme"), Some(&json!("dark")));
        assert_eq!(merged["telemetry"]["traces"], json!(true));
        assert_eq!(merged["telemetry"]["enabled"], json!(true));
        assert_eq!(merged["telemetry"]["logPrompts"], json!(false));
    }

    #[test]
    fn autostart_launches_without_opening_the_main_window() {
        assert!(autostart_launch_command().unwrap().ends_with(" --hidden"));
    }

    #[test]
    fn codex_jsonl_rate_limits_map_to_five_hour_and_weekly_windows() {
        let value = json!({
            "timestamp": "2026-07-11T14:29:51.652Z",
            "payload": {
                "type": "token_count",
                "rate_limits": {
                    "primary": { "used_percent": 6.0, "window_minutes": 300, "resets_at": 1783794411 },
                    "secondary": { "used_percent": 8.0, "window_minutes": 10080, "resets_at": 1784359202 },
                    "plan_type": "pro"
                }
            }
        });
        let quota = parse_codex_quota(&value).unwrap();

        assert!(quota.supported);
        assert_eq!(quota.plan_type.as_deref(), Some("pro"));
        assert_eq!(quota.five_hour.unwrap().remaining_percent, 94.0);
        assert_eq!(quota.weekly.unwrap().remaining_percent, 92.0);
    }

    #[test]
    fn claude_statusline_parses_subscription_rate_limits() {
        let value = json!({
            "rate_limits": {
                "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600 },
                "seven_day": { "used_percentage": 41.2, "resets_at": 1738857600 }
            }
        });
        let quota =
            claude_quota_from_statusline(&value, UNIX_EPOCH + Duration::from_secs(100)).unwrap();

        assert_eq!(quota.five_hour.unwrap().remaining_percent, 76.5);
        assert_eq!(quota.weekly.unwrap().remaining_percent, 58.8);
        assert_eq!(quota.updated_at, Some(100));
    }

    #[test]
    fn claude_statusline_preserves_other_settings_and_rejects_conflicts() {
        let command =
            claude_statusline_command(Path::new("C:\\Program Files\\Token Deck\\token-deck.exe"));
        let settings = json!({ "theme": "dark" }).as_object().unwrap().clone();
        let merged = merge_claude_statusline(settings, &command).unwrap();

        assert_eq!(merged.get("theme"), Some(&json!("dark")));
        assert_eq!(
            merged["statusLine"]["command"],
            json!("\"C:/Program Files/Token Deck/token-deck.exe\" --claude-statusline")
        );

        let conflicting =
            json!({ "statusLine": { "type": "command", "command": "custom-status" } })
                .as_object()
                .unwrap()
                .clone();
        assert!(merge_claude_statusline(conflicting, &command).is_err());
        let malformed = json!({ "statusLine": { "padding": 2 } })
            .as_object()
            .unwrap()
            .clone();
        assert!(merge_claude_statusline(malformed, &command).is_err());
    }

    #[test]
    fn quota_reader_only_returns_complete_lines_from_bounded_tail() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("token-deck-quota-tail-{unique}.jsonl"));
        let latest = r#"{"payload":{"rate_limits":{"primary":{"used_percent":9}}}}"#;
        fs::write(&path, format!("{}\nolder\n{latest}\n", "x".repeat(200))).unwrap();

        let tail = read_file_tail(&path, 100).unwrap();

        assert!(!tail.contains(&"x".repeat(20)));
        assert!(tail.contains(latest));
        fs::remove_file(path).unwrap();
    }
}
