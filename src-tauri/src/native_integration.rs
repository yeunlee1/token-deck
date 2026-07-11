// Windows 자동 시작과 Gemini CLI 로컬 텔레메트리 설정을 관리하는 네이티브 통합 모듈
use serde::Serialize;
use serde_json::{Map, Value};
use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

const AUTOSTART_VALUE_NAME: &str = "Token Deck";

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

#[cfg(test)]
mod tests {
    use super::{autostart_launch_command, is_telemetry_configured, merge_telemetry_settings};
    use serde_json::json;
    use std::path::Path;

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
}
