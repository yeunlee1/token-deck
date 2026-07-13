// Windows 자동 시작과 Gemini CLI 로컬 텔레메트리 설정을 관리하는 네이티브 통합 모듈
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    io::{ErrorKind, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::Command,
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

const AUTOSTART_VALUE_NAME: &str = "Token Deck";
const MAX_QUOTA_SCAN_DEPTH: usize = 32;
const MAX_QUOTA_FILES: usize = 10_000;
const MAX_QUOTA_CANDIDATE_FILES: usize = 32;
const MAX_QUOTA_TAIL_BYTES: u64 = 2 * 1024 * 1024;
const MAX_COLLECTION_POLICY_BYTES: u64 = 1024;
static QUOTA_SCAN_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static CODEX_QUOTA_CACHE: OnceLock<Mutex<CodexQuotaCache>> = OnceLock::new();

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
    #[serde(default)]
    expired_windows: Vec<String>,
    message: Option<String>,
    updated_at: Option<u64>,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct CodexQuotaFileMetadata {
    path: PathBuf,
    modified: SystemTime,
    length: u64,
}

#[derive(Clone, Debug)]
struct CodexQuotaCandidate {
    file: CodexQuotaFileMetadata,
    candidate_time: u64,
    quota: ProviderQuotaStatus,
}

#[derive(Default)]
struct CodexQuotaCache {
    root: Option<PathBuf>,
    fingerprint: u64,
    files: Vec<CodexQuotaFileMetadata>,
    winner: Option<CodexQuotaCandidate>,
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
fn hidden_command(program: &str) -> Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let mut command = Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(windows)]
fn gemini_command_output(arguments: &[&str]) -> Option<String> {
    let output = hidden_command("cmd")
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
    let output = hidden_command("where.exe").arg("gemini").output().ok()?;
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
    let mut five_hour = None;
    let mut weekly = None;
    for (key, default_minutes) in [("primary", 300), ("secondary", 10_080)] {
        let Some(window) = limits
            .get(key)
            .and_then(|value| quota_window(value, default_minutes))
        else {
            continue;
        };
        match window.window_minutes {
            300 => five_hour = Some(window),
            10_080 => weekly = Some(window),
            _ => {}
        }
    }
    Some(ProviderQuotaStatus {
        provider: "codex".to_owned(),
        supported: five_hour.is_some() || weekly.is_some(),
        plan_type: limits
            .get("plan_type")
            .and_then(Value::as_str)
            .map(str::to_owned),
        five_hour,
        weekly,
        daily: None,
        expired_windows: Vec::new(),
        message: None,
        updated_at: value
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(|timestamp| chrono::DateTime::parse_from_rfc3339(timestamp).ok())
            .and_then(|timestamp| u64::try_from(timestamp.timestamp()).ok()),
    })
}

fn newest_codex_quota(root: &Path) -> Option<ProviderQuotaStatus> {
    let mut files = Vec::new();
    let mut files_seen = 0;
    collect_codex_quota_files(root, &mut files, 0, &mut files_seen);
    let mut cache = CODEX_QUOTA_CACHE
        .get_or_init(|| Mutex::new(CodexQuotaCache::default()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    newest_codex_quota_from_files(root, files, &mut cache, read_file_tail)
}

fn codex_quota_candidate_time(quota: &ProviderQuotaStatus, modified: SystemTime) -> u64 {
    quota.updated_at.unwrap_or_else(|| {
        modified
            .duration_since(UNIX_EPOCH)
            .map_or(0, |value| value.as_secs())
    })
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

fn collect_codex_quota_files(
    root: &Path,
    files: &mut Vec<CodexQuotaFileMetadata>,
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
            collect_codex_quota_files(&path, files, depth + 1, files_seen);
            continue;
        }
        if path.extension().and_then(|extension| extension.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        *files_seen += 1;
        files.push(CodexQuotaFileMetadata {
            path,
            modified,
            length: metadata.len(),
        });
    }
}

fn codex_quota_metadata_fingerprint(files: &[CodexQuotaFileMetadata]) -> u64 {
    let mut hasher = DefaultHasher::new();
    files.hash(&mut hasher);
    hasher.finish()
}

fn codex_quota_file_changed(
    file: &CodexQuotaFileMetadata,
    previous: &[CodexQuotaFileMetadata],
) -> bool {
    previous
        .binary_search_by(|candidate| candidate.path.cmp(&file.path))
        .map_or(true, |index| previous[index] != *file)
}

fn newest_codex_quota_from_files<F>(
    root: &Path,
    mut files: Vec<CodexQuotaFileMetadata>,
    cache: &mut CodexQuotaCache,
    mut read_tail: F,
) -> Option<ProviderQuotaStatus>
where
    F: FnMut(&Path, u64) -> Option<String>,
{
    files.sort_unstable_by(|left, right| left.path.cmp(&right.path));
    let fingerprint = codex_quota_metadata_fingerprint(&files);
    let same_root = cache.root.as_deref() == Some(root);
    if same_root && cache.fingerprint == fingerprint && cache.files == files {
        return cache
            .winner
            .as_ref()
            .map(|candidate| candidate.quota.clone());
    }

    let previous_winner = same_root.then(|| cache.winner.clone()).flatten();
    let current_winner_file = previous_winner.as_ref().and_then(|winner| {
        files
            .binary_search_by(|candidate| candidate.path.cmp(&winner.file.path))
            .ok()
            .map(|index| files[index].clone())
    });
    let winner_unchanged = previous_winner
        .as_ref()
        .zip(current_winner_file.as_ref())
        .is_some_and(|(winner, current)| winner.file == *current);
    let mut newest = winner_unchanged.then(|| previous_winner.clone()).flatten();

    let needs_fallback_scan =
        !same_root || cache.root.is_none() || previous_winner.is_some() && !winner_unchanged;
    let mut candidates = if needs_fallback_scan {
        files.iter().collect::<Vec<_>>()
    } else {
        files
            .iter()
            .filter(|file| codex_quota_file_changed(file, &cache.files))
            .collect::<Vec<_>>()
    };
    candidates.sort_unstable_by(|left, right| {
        right
            .modified
            .cmp(&left.modified)
            .then_with(|| left.path.cmp(&right.path))
    });

    let mandatory_winner_path = (!winner_unchanged)
        .then(|| previous_winner.as_ref().map(|winner| &winner.file.path))
        .flatten()
        .filter(|path| {
            current_winner_file
                .as_ref()
                .is_some_and(|file| file.path == **path)
        });
    let mut selected = Vec::with_capacity(MAX_QUOTA_CANDIDATE_FILES);
    if let Some(path) = mandatory_winner_path {
        if let Some(file) = current_winner_file
            .as_ref()
            .filter(|file| file.path == *path)
        {
            selected.push(file);
        }
    }
    for file in candidates {
        if selected.len() >= MAX_QUOTA_CANDIDATE_FILES {
            break;
        }
        if selected.iter().any(|selected| selected.path == file.path) {
            continue;
        }
        selected.push(file);
    }

    for file in selected {
        let Some(content) = read_tail(&file.path, MAX_QUOTA_TAIL_BYTES) else {
            continue;
        };
        let quota = content.lines().rev().find_map(|line| {
            serde_json::from_str::<Value>(line)
                .ok()
                .and_then(|value| parse_codex_quota(&value))
        });
        let Some(quota) = quota else {
            continue;
        };
        let candidate_time = codex_quota_candidate_time(&quota, file.modified);
        let replace = newest.as_ref().is_none_or(|current| {
            candidate_time > current.candidate_time
                || (candidate_time == current.candidate_time
                    && file.modified > current.file.modified)
        });
        if replace {
            newest = Some(CodexQuotaCandidate {
                file: file.clone(),
                candidate_time,
                quota,
            });
        }
    }

    cache.root = Some(root.to_path_buf());
    cache.fingerprint = fingerprint;
    cache.files = files;
    cache.winner = newest;
    cache
        .winner
        .as_ref()
        .map(|candidate| candidate.quota.clone())
}

fn claude_paths() -> Result<(PathBuf, PathBuf), String> {
    let home = user_home()?;
    Ok((
        home.join(".claude").join("settings.json"),
        home.join(".token-deck").join("claude-quota.json"),
    ))
}

fn collection_policy_path_for(home: &Path) -> PathBuf {
    home.join(".token-deck").join("collection-providers.json")
}

fn validate_collection_providers(
    providers: Vec<crate::UsageProvider>,
) -> Result<Vec<crate::UsageProvider>, String> {
    if providers.is_empty() || providers.len() > 3 {
        return Err("수집할 인공지능 서비스는 한 개 이상 세 개 이하여야 합니다".to_owned());
    }
    let mut unique = Vec::with_capacity(providers.len());
    for provider in providers {
        if unique.contains(&provider) {
            return Err("수집할 인공지능 서비스가 중복되어 있습니다".to_owned());
        }
        unique.push(provider);
    }
    Ok(unique)
}

fn decode_collection_policy(content: &[u8]) -> Result<Vec<crate::UsageProvider>, String> {
    let providers = serde_json::from_slice(content)
        .map_err(|error| format!("수집 서비스 설정 JSON이 올바르지 않습니다. {error}"))?;
    validate_collection_providers(providers)
}

fn read_collection_policy_file(path: &Path) -> Result<Option<Vec<crate::UsageProvider>>, String> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if metadata.len() > MAX_COLLECTION_POLICY_BYTES {
        return Err("수집 서비스 설정 파일이 허용 크기를 초과했습니다".to_owned());
    }
    let content = fs::read(path).map_err(|error| error.to_string())?;
    decode_collection_policy(&content).map(Some)
}

fn read_collection_policy_at(home: &Path) -> Result<Option<Vec<crate::UsageProvider>>, String> {
    let primary = collection_policy_path_for(home);
    match read_collection_policy_file(&primary) {
        Ok(Some(providers)) => Ok(Some(providers)),
        Ok(None) => read_collection_policy_file(&primary.with_extension("json.bak")),
        Err(primary_error) => {
            match read_collection_policy_file(&primary.with_extension("json.bak")) {
                Ok(Some(providers)) => Ok(Some(providers)),
                Ok(None) | Err(_) => Err(format!(
                    "수집 서비스 설정과 복구 백업을 읽지 못했습니다. {primary_error}"
                )),
            }
        }
    }
}

fn replace_collection_policy_file(path: &Path, content: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension(format!(
        "{}.tmp",
        path.extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("state")
    ));
    fs::write(&temporary, content).map_err(|error| error.to_string())?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

fn save_collection_policy_files(
    home: &Path,
    providers: &[crate::UsageProvider],
) -> Result<(), String> {
    let path = collection_policy_path_for(home);
    let parent = path
        .parent()
        .ok_or_else(|| "수집 서비스 설정 경로를 확인할 수 없습니다".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let content = serde_json::to_vec(providers).map_err(|error| error.to_string())?;
    replace_collection_policy_file(&path.with_extension("json.bak"), &content)?;
    replace_collection_policy_file(&path, &content)
}

#[cfg(test)]
fn collection_policy_allows(content: &str, provider: crate::UsageProvider) -> bool {
    decode_collection_policy(content.as_bytes())
        .ok()
        .is_some_and(|providers| providers.contains(&provider))
}

fn collection_policy_allows_provider(provider: crate::UsageProvider) -> bool {
    user_home()
        .ok()
        .and_then(|home| read_collection_policy_at(&home).ok().flatten())
        .is_some_and(|providers| providers.contains(&provider))
}

#[tauri::command]
pub fn load_collection_providers() -> Result<Option<Vec<crate::UsageProvider>>, String> {
    let home = user_home()?;
    let providers = read_collection_policy_at(&home)?;
    if let Some(providers) = providers.as_deref() {
        save_collection_policy_files(&home, providers)?;
    }
    Ok(providers)
}

#[tauri::command]
pub fn set_collection_providers(providers: Vec<crate::UsageProvider>) -> Result<(), String> {
    set_collection_providers_at(&user_home()?, providers)
}

fn providers_to_prime(
    existing_policy: Option<&[crate::UsageProvider]>,
    providers: &[crate::UsageProvider],
) -> Vec<crate::UsageProvider> {
    if existing_policy.is_none() {
        return Vec::new();
    }
    providers
        .iter()
        .copied()
        .filter(|provider| existing_policy.is_none_or(|selected| !selected.contains(provider)))
        .fold(Vec::new(), |mut unique, provider| {
            if !unique.contains(&provider) {
                unique.push(provider);
            }
            unique
        })
}

fn set_collection_providers_at(
    home: &Path,
    providers: Vec<crate::UsageProvider>,
) -> Result<(), String> {
    let _scan_guard = crate::SCAN_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let providers = validate_collection_providers(providers)?;
    let existing_policy = read_collection_policy_at(home)?;
    let newly_enabled = providers_to_prime(existing_policy.as_deref(), &providers);
    if !newly_enabled.is_empty() {
        let mut cursors = crate::load_scan_cursors(home);
        crate::prime_provider_cursors(home, &newly_enabled, &mut cursors)?;
        crate::save_scan_cursors(home, &cursors)?;
    }
    save_collection_policy_files(home, &providers)?;
    crate::increment_collection_policy_revision(home);
    Ok(())
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

fn quota_window_is_current(window: &QuotaWindowStatus, updated_at: Option<u64>, now: u64) -> bool {
    match window.resets_at {
        Some(resets_at) => resets_at > now,
        None => updated_at.is_some_and(|updated_at| {
            updated_at.saturating_add(window.window_minutes.saturating_mul(60)) > now
        }),
    }
}

fn discard_expired_quota_windows(mut status: ProviderQuotaStatus, now: u64) -> ProviderQuotaStatus {
    let updated_at = status.updated_at;
    status.expired_windows.clear();
    if status
        .five_hour
        .as_ref()
        .is_some_and(|window| !quota_window_is_current(window, updated_at, now))
    {
        status.five_hour = None;
        status.expired_windows.push("fiveHour".to_owned());
    }
    if status
        .weekly
        .as_ref()
        .is_some_and(|window| !quota_window_is_current(window, updated_at, now))
    {
        status.weekly = None;
        status.expired_windows.push("weekly".to_owned());
    }
    if status
        .daily
        .as_ref()
        .is_some_and(|window| !quota_window_is_current(window, updated_at, now))
    {
        status.daily = None;
        status.expired_windows.push("daily".to_owned());
    }
    status.supported =
        status.five_hour.is_some() || status.weekly.is_some() || status.daily.is_some();
    if !status.supported {
        status.message = Some("한도 창이 만료되어 새 한도 정보를 기다리는 중입니다".to_owned());
    }
    status
}

fn quota_statuses_blocking(
    providers: Option<Vec<crate::UsageProvider>>,
) -> Result<Vec<ProviderQuotaStatus>, String> {
    let _scan_guard = QUOTA_SCAN_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();
    let mut statuses = Vec::new();
    if crate::provider_selected(providers.as_deref(), crate::UsageProvider::Codex) {
        let home = user_home()?;
        statuses.push(
            newest_codex_quota(&home.join(".codex").join("sessions"))
                .map(|status| discard_expired_quota_windows(status, now))
                .unwrap_or_else(|| ProviderQuotaStatus {
                    provider: "codex".to_owned(),
                    supported: false,
                    plan_type: None,
                    five_hour: None,
                    weekly: None,
                    daily: None,
                    expired_windows: Vec::new(),
                    message: Some("Codex 한도 이벤트를 기다리는 중입니다".to_owned()),
                    updated_at: None,
                }),
        );
    }
    if crate::provider_selected(providers.as_deref(), crate::UsageProvider::Claude) {
        let (_, claude_data) = claude_paths()?;
        statuses.push(
            claude_quota_from_file(&claude_data)
                .map(|status| discard_expired_quota_windows(status, now))
                .unwrap_or_else(|| ProviderQuotaStatus {
                    provider: "claude".to_owned(),
                    supported: false,
                    plan_type: None,
                    five_hour: None,
                    weekly: None,
                    daily: None,
                    expired_windows: Vec::new(),
                    message: Some("설정에서 Claude 한도 연동을 활성화하세요".to_owned()),
                    updated_at: None,
                }),
        );
    }
    if crate::provider_selected(providers.as_deref(), crate::UsageProvider::Gemini) {
        statuses.push(ProviderQuotaStatus {
            provider: "gemini".to_owned(),
            supported: false,
            plan_type: None,
            five_hour: None,
            weekly: None,
            daily: None,
            expired_windows: Vec::new(),
            message: Some("Gemini CLI 정액제는 5시간·주간 한도를 제공하지 않습니다".to_owned()),
            updated_at: None,
        });
    }
    Ok(statuses)
}

#[tauri::command]
pub async fn quota_statuses(
    providers: Option<Vec<crate::UsageProvider>>,
) -> Result<Vec<ProviderQuotaStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || quota_statuses_blocking(providers))
        .await
        .map_err(|error| format!("한도 상태 수집 작업을 완료하지 못했습니다. {error}"))?
}

pub fn run_claude_statusline_capture() -> Result<(), String> {
    if !collection_policy_allows_provider(crate::UsageProvider::Claude) {
        return Ok(());
    }
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
        expired_windows: Vec::new(),
        message: None,
        updated_at: Some(now),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        autostart_launch_command, claude_quota_from_statusline, claude_statusline_command,
        codex_quota_candidate_time, collection_policy_allows, collection_policy_path_for,
        discard_expired_quota_windows, is_telemetry_configured, merge_claude_statusline,
        merge_telemetry_settings, newest_codex_quota_from_files, parse_codex_quota,
        quota_statuses_blocking, read_collection_policy_at, read_file_tail,
        set_collection_providers_at, CodexQuotaCache, CodexQuotaFileMetadata, ProviderQuotaStatus,
        QuotaWindowStatus, MAX_QUOTA_CANDIDATE_FILES,
    };
    use serde_json::json;
    use std::{
        collections::HashMap,
        fs,
        io::Write,
        path::{Path, PathBuf},
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    fn temporary_home(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("token-deck-{label}-{unique}"))
    }

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
    fn collection_policy_only_allows_explicit_providers() {
        let policy = r#"["codex","gemini"]"#;

        assert!(collection_policy_allows(
            policy,
            crate::UsageProvider::Codex
        ));
        assert!(!collection_policy_allows(
            policy,
            crate::UsageProvider::Claude
        ));
        assert!(collection_policy_allows(
            policy,
            crate::UsageProvider::Gemini
        ));
        assert!(!collection_policy_allows(
            "not-json",
            crate::UsageProvider::Codex
        ));
    }

    #[test]
    fn first_collection_policy_preserves_existing_logs_for_initial_import() {
        let home = temporary_home("first-policy");
        let log = home.join(".gemini").join("telemetry.log");
        fs::create_dir_all(log.parent().unwrap()).unwrap();
        fs::write(&log, "past-event\n").unwrap();

        set_collection_providers_at(&home, vec![crate::UsageProvider::Gemini]).unwrap();

        let cursors = crate::load_scan_cursors(&home);
        let key = crate::stable_local_identifier(&log.to_string_lossy());
        assert!(!cursors.contains_key(&key));
        assert_eq!(
            fs::read_to_string(collection_policy_path_for(&home)).unwrap(),
            r#"["gemini"]"#
        );
        fs::remove_file(collection_policy_path_for(&home)).unwrap();
        assert_eq!(
            read_collection_policy_at(&home).unwrap(),
            Some(vec![crate::UsageProvider::Gemini])
        );
        assert!(set_collection_providers_at(&home, Vec::new()).is_err());
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn enabling_provider_snapshots_offsets_and_merges_latest_cursors() {
        let home = temporary_home("enable-boundary");
        let policy_path = collection_policy_path_for(&home);
        fs::create_dir_all(policy_path.parent().unwrap()).unwrap();
        fs::write(&policy_path, r#"["codex"]"#).unwrap();
        let log = home.join(".gemini").join("telemetry.log");
        fs::create_dir_all(log.parent().unwrap()).unwrap();
        fs::write(&log, "disabled-period\n").unwrap();
        let existing = crate::ScanCursor {
            offset: 7,
            prefix_fingerprint: 8,
            created_at_nanos: 9,
            gemini_discard_offset: None,
            codex_baseline: None,
        };
        crate::save_scan_cursors(
            &home,
            &HashMap::from([("existing".to_owned(), existing.clone())]),
        )
        .unwrap();

        set_collection_providers_at(
            &home,
            vec![crate::UsageProvider::Codex, crate::UsageProvider::Gemini],
        )
        .unwrap();

        let cursors = crate::load_scan_cursors(&home);
        let key = crate::stable_local_identifier(&log.to_string_lossy());
        let offset = cursors.get(&key).unwrap().offset;
        assert_eq!(cursors.get("existing").unwrap().offset, existing.offset);
        assert_eq!(offset, fs::metadata(&log).unwrap().len());
        fs::OpenOptions::new()
            .append(true)
            .open(&log)
            .unwrap()
            .write_all(b"enabled-period\n")
            .unwrap();
        assert_eq!(
            crate::read_log_chunk(&log, offset).unwrap().0,
            vec!["enabled-period"]
        );
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn corrupt_policy_fails_closed_without_advancing_provider_cursors() {
        let home = temporary_home("corrupt-policy");
        let policy_path = collection_policy_path_for(&home);
        fs::create_dir_all(policy_path.parent().unwrap()).unwrap();
        fs::write(&policy_path, "not-json").unwrap();
        let codex = home.join(".codex").join("sessions").join("session.jsonl");
        let gemini = home.join(".gemini").join("telemetry.log");
        fs::create_dir_all(codex.parent().unwrap()).unwrap();
        fs::create_dir_all(gemini.parent().unwrap()).unwrap();
        fs::write(&codex, "codex-disabled\n").unwrap();
        fs::write(&gemini, "gemini-disabled\n").unwrap();

        let result = set_collection_providers_at(
            &home,
            vec![crate::UsageProvider::Codex, crate::UsageProvider::Gemini],
        );

        assert!(result.is_err());
        let cursors = crate::load_scan_cursors(&home);
        for path in [&codex, &gemini] {
            let key = crate::stable_local_identifier(&path.to_string_lossy());
            assert!(!cursors.contains_key(&key));
        }
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn provider_round_trip_rejects_a_scan_from_the_old_policy_revision() {
        let home = temporary_home("policy-revision");
        let policy_path = collection_policy_path_for(&home);
        fs::create_dir_all(policy_path.parent().unwrap()).unwrap();
        fs::write(&policy_path, r#"["codex"]"#).unwrap();
        let log = home.join(".claude").join("projects").join("session.jsonl");
        fs::create_dir_all(log.parent().unwrap()).unwrap();
        fs::write(
            &log,
            "{\"sessionId\":\"session-1\",\"requestId\":\"request-1\",\"message\":{\"usage\":{\"input_tokens\":3}}}\n",
        )
        .unwrap();
        let stale =
            crate::scan_local_usage_at(&home, None, Some(vec![crate::UsageProvider::Claude]))
                .unwrap();
        assert_eq!(stale.documents.len(), 1);

        set_collection_providers_at(
            &home,
            vec![crate::UsageProvider::Codex, crate::UsageProvider::Claude],
        )
        .unwrap();
        set_collection_providers_at(&home, vec![crate::UsageProvider::Codex]).unwrap();
        set_collection_providers_at(
            &home,
            vec![crate::UsageProvider::Codex, crate::UsageProvider::Claude],
        )
        .unwrap();
        let key = crate::stable_local_identifier(&log.to_string_lossy());
        let primed_offset = crate::load_scan_cursors(&home).get(&key).unwrap().offset;

        assert!(!crate::commit_scan_cursors_blocking(&stale.commit_token).unwrap());
        assert_eq!(
            crate::load_scan_cursors(&home).get(&key).unwrap().offset,
            primed_offset
        );
        assert_eq!(primed_offset, fs::metadata(&log).unwrap().len());
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn expired_quota_windows_are_removed_instead_of_reappearing_as_live() {
        let window = |resets_at| QuotaWindowStatus {
            used_percent: 20.0,
            remaining_percent: 80.0,
            window_minutes: 300,
            resets_at,
        };
        let partially_current = discard_expired_quota_windows(
            ProviderQuotaStatus {
                provider: "claude".to_owned(),
                supported: true,
                plan_type: Some("pro".to_owned()),
                five_hour: Some(window(Some(99))),
                weekly: Some(QuotaWindowStatus {
                    window_minutes: 10_080,
                    resets_at: Some(200),
                    ..window(None)
                }),
                daily: None,
                expired_windows: Vec::new(),
                message: None,
                updated_at: Some(50),
            },
            100,
        );

        assert!(partially_current.five_hour.is_none());
        assert!(partially_current.weekly.is_some());
        assert!(partially_current.supported);
        assert_eq!(partially_current.expired_windows, ["fiveHour"]);

        let expired_without_reset = discard_expired_quota_windows(
            ProviderQuotaStatus {
                provider: "codex".to_owned(),
                supported: true,
                plan_type: None,
                five_hour: Some(window(None)),
                weekly: None,
                daily: None,
                expired_windows: Vec::new(),
                message: None,
                updated_at: Some(1),
            },
            18_002,
        );

        assert!(expired_without_reset.five_hour.is_none());
        assert!(!expired_without_reset.supported);
        assert_eq!(expired_without_reset.expired_windows, ["fiveHour"]);
        assert_eq!(
            expired_without_reset.message.as_deref(),
            Some("한도 창이 만료되어 새 한도 정보를 기다리는 중입니다")
        );
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
        assert_eq!(quota.updated_at, Some(1_783_780_191));
    }

    #[test]
    fn codex_quota_candidates_prefer_source_time_and_keep_fallback_time_internal() {
        let quota_at = |timestamp: Option<&str>| {
            parse_codex_quota(&json!({
                "timestamp": timestamp,
                "payload": {
                    "rate_limits": {
                        "primary": { "used_percent": 10.0, "window_minutes": 10080 }
                    }
                }
            }))
            .unwrap()
        };
        let older = quota_at(Some("2026-07-11T10:00:00Z"));
        let newer = quota_at(Some("2026-07-11T11:00:00Z"));
        let without_source_time = quota_at(None);

        assert!(
            codex_quota_candidate_time(&newer, UNIX_EPOCH + Duration::from_secs(1))
                > codex_quota_candidate_time(&older, UNIX_EPOCH + Duration::from_secs(999_999))
        );
        assert_eq!(
            codex_quota_candidate_time(&without_source_time, UNIX_EPOCH + Duration::from_secs(123)),
            123
        );
        assert_eq!(without_source_time.updated_at, None);
    }

    #[test]
    fn codex_quota_scan_bounds_tail_reads_and_reuses_unchanged_metadata() {
        let root = Path::new("C:\\quota-test\\sessions");
        let files = (0..40)
            .map(|index| CodexQuotaFileMetadata {
                path: root.join(format!("file-{index:02}.jsonl")),
                modified: UNIX_EPOCH + Duration::from_secs(index),
                length: index + 1,
            })
            .collect::<Vec<_>>();
        let quota_line = |timestamp: &str, used_percent: f64| {
            json!({
                "timestamp": timestamp,
                "payload": {
                    "rate_limits": {
                        "primary": {
                            "used_percent": used_percent,
                            "window_minutes": 10_080
                        }
                    }
                }
            })
            .to_string()
        };
        let mut cache = CodexQuotaCache::default();
        let mut reads = 0;
        let first = newest_codex_quota_from_files(root, files.clone(), &mut cache, |path, _| {
            reads += 1;
            if path.ends_with("file-39.jsonl") {
                Some(quota_line("2026-07-11T10:00:00Z", 70.0))
            } else if path.ends_with("file-38.jsonl") {
                Some(quota_line("2026-07-11T11:00:00Z", 10.0))
            } else {
                Some("{}".to_owned())
            }
        })
        .unwrap();

        assert_eq!(reads, MAX_QUOTA_CANDIDATE_FILES);
        assert_eq!(first.weekly.unwrap().remaining_percent, 90.0);
        let reads_after_first_scan = reads;

        let cached = newest_codex_quota_from_files(root, files, &mut cache, |_, _| {
            reads += 1;
            None
        })
        .unwrap();

        assert_eq!(reads, reads_after_first_scan);
        assert_eq!(cached.updated_at, Some(1_783_767_600));
    }

    #[test]
    fn codex_quota_cache_keeps_source_newer_winner_outside_new_candidate_limit() {
        let root = Path::new("C:\\quota-test\\winner-cache");
        let winner = CodexQuotaFileMetadata {
            path: root.join("winner.jsonl"),
            modified: UNIX_EPOCH + Duration::from_secs(1),
            length: 1,
        };
        let mut cache = CodexQuotaCache::default();
        let source_line = |timestamp: &str, used_percent: f64| {
            json!({
                "timestamp": timestamp,
                "payload": {
                    "rate_limits": {
                        "primary": {
                            "used_percent": used_percent,
                            "window_minutes": 10_080
                        }
                    }
                }
            })
            .to_string()
        };
        let first =
            newest_codex_quota_from_files(root, vec![winner.clone()], &mut cache, |_, _| {
                Some(source_line("2026-07-11T12:00:00Z", 5.0))
            })
            .unwrap();
        assert_eq!(first.weekly.unwrap().remaining_percent, 95.0);

        let mut changed = vec![winner];
        changed.extend((0..40).map(|index| CodexQuotaFileMetadata {
            path: root.join(format!("new-{index:02}.jsonl")),
            modified: UNIX_EPOCH + Duration::from_secs(100 + index),
            length: 2,
        }));
        let mut reads = 0;
        let retained = newest_codex_quota_from_files(root, changed, &mut cache, |_, _| {
            reads += 1;
            Some(source_line("2026-07-11T11:00:00Z", 99.0))
        })
        .unwrap();

        assert_eq!(reads, MAX_QUOTA_CANDIDATE_FILES);
        assert_eq!(retained.weekly.unwrap().remaining_percent, 95.0);
        assert_eq!(retained.updated_at, Some(1_783_771_200));
    }

    #[test]
    fn codex_jsonl_weekly_only_primary_window_remains_visible() {
        let value = json!({
            "timestamp": "2026-07-13T07:00:00.000Z",
            "payload": {
                "type": "token_count",
                "rate_limits": {
                    "primary": { "used_percent": 19.0, "window_minutes": 10080, "resets_at": 1784505600 },
                    "secondary": null,
                    "plan_type": "pro"
                }
            }
        });
        let quota = parse_codex_quota(&value).unwrap();

        assert!(quota.supported);
        assert!(quota.five_hour.is_none());
        assert_eq!(quota.weekly.unwrap().remaining_percent, 81.0);
    }

    #[test]
    fn codex_jsonl_windows_are_classified_by_duration_not_position() {
        let value = json!({
            "payload": {
                "rate_limits": {
                    "primary": { "used_percent": 12.0, "window_minutes": 10080 },
                    "secondary": { "used_percent": 35.0, "window_minutes": 300 }
                }
            }
        });
        let quota = parse_codex_quota(&value).unwrap();

        assert_eq!(quota.five_hour.unwrap().remaining_percent, 65.0);
        assert_eq!(quota.weekly.unwrap().remaining_percent, 88.0);
    }

    #[test]
    fn quota_collection_only_returns_selected_providers() {
        let gemini = quota_statuses_blocking(Some(vec![crate::UsageProvider::Gemini])).unwrap();

        assert_eq!(gemini.len(), 1);
        assert_eq!(gemini[0].provider, "gemini");
        assert!(quota_statuses_blocking(Some(Vec::new()))
            .unwrap()
            .is_empty());
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
