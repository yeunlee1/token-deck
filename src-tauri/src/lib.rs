// 로컬 AI 도구 로그를 안전하게 읽고 트레이 창을 관리하는 Tauri 백엔드
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::UNIX_EPOCH,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};

mod device_inventory;
mod native_integration;

const MAX_SCAN_DEPTH: usize = 32;
const MAX_LOG_FILES: usize = 10_000;
const MAX_RAW_BYTES_PER_FILE_PER_SCAN: u64 = 8 * 1024 * 1024;
const MAX_CODEX_BASELINE_TAIL_BYTES: u64 = 2 * 1024 * 1024;
const MAX_CODEX_SESSION_META_BYTES: u64 = 64 * 1024;
const MAX_LOG_LINE_BYTES: usize = 64 * 1024 * 1024;
const MAX_TOTAL_SANITIZED_BYTES: usize = 64 * 1024 * 1024;
const MAX_DEVICE_DISPLAY_NAME_CHARS: usize = 64;
const MAX_DEVICE_ID_STATE_BYTES: u64 = 4 * 1024;
const MAX_LOCAL_USAGE_CACHE_BYTES: u64 = 48 * 1024 * 1024;
const MAX_LOCAL_USAGE_CACHE_EVENTS: usize = 50_000;
const LOCAL_USAGE_SEEN_FILTER_BYTES: usize = 1024 * 1024;
const LOCAL_USAGE_SEEN_FILTER_ENCODED_BYTES: usize = LOCAL_USAGE_SEEN_FILTER_BYTES.div_ceil(3) * 4;
const MAX_LOCAL_PROJECT_CACHE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_LOCAL_PROJECT_CACHE_ENTRIES: usize = 10_000;
static CREDENTIAL_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static DEVICE_ID_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static SCAN_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static LOCAL_USAGE_CACHE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static SCAN_TRANSACTIONS: OnceLock<Mutex<ScanTransactionState>> = OnceLock::new();

type BoundedLine = (Option<Vec<u8>>, usize, bool);

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UsageProvider {
    Codex,
    Claude,
    Gemini,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum CachedUsageSource {
    LocalJsonl,
    Otel,
    ProviderApi,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct CachedTokenBreakdown {
    input: u64,
    cached: u64,
    output: u64,
    reasoning: u64,
    tool: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CachedUsageEvent {
    id: String,
    provider: UsageProvider,
    source: CachedUsageSource,
    device_id: String,
    session_id: String,
    project_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    occurred_at: String,
    tokens: CachedTokenBreakdown,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CachedUsageOwnershipState {
    version: u8,
    known_event_ids: Vec<String>,
    owners: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    seen_filter: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CachedLocalUsageState {
    version: u8,
    events: Vec<CachedUsageEvent>,
    ownership: CachedUsageOwnershipState,
    #[serde(default)]
    codex_cumulative: HashMap<String, CachedTokenBreakdown>,
    #[serde(default)]
    codex_retired_session_filter: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CachedLocalUsageSnapshot {
    events: Vec<CachedUsageEvent>,
    ownership: Option<CachedUsageOwnershipState>,
    codex_cumulative: HashMap<String, CachedTokenBreakdown>,
    codex_retired_session_filter: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CachedDeviceIdentity {
    version: u8,
    device_id: String,
}

fn provider_selected(providers: Option<&[UsageProvider]>, provider: UsageProvider) -> bool {
    providers.is_none_or(|selected| selected.contains(&provider))
}

#[derive(Clone, Default, Deserialize, Serialize)]
struct ScanCursor {
    offset: u64,
    prefix_fingerprint: u64,
    created_at_nanos: u64,
    #[serde(default)]
    gemini_discard_offset: Option<u64>,
    #[serde(default)]
    codex_baseline: Option<String>,
}

#[derive(Clone)]
struct PendingScanCommit {
    home: PathBuf,
    cursors: HashMap<String, ScanCursor>,
    policy_revision: u64,
}

#[derive(Default)]
struct ScanTransactionState {
    next_token: u64,
    policy_revisions: HashMap<PathBuf, u64>,
    pending: HashMap<String, PendingScanCommit>,
}

#[cfg(windows)]
pub(crate) fn is_link_like(file_type: &fs::FileType) -> bool {
    use std::os::windows::fs::FileTypeExt;
    file_type.is_symlink() || file_type.is_symlink_dir() || file_type.is_symlink_file()
}

#[cfg(not(windows))]
pub(crate) fn is_link_like(file_type: &fs::FileType) -> bool {
    file_type.is_symlink()
}

pub fn run_claude_statusline_capture() -> Result<(), String> {
    native_integration::run_claude_statusline_capture()
}

fn credential_entry(provider: &str) -> Result<keyring::Entry, String> {
    if !is_supported_credential_provider(provider) {
        return Err("지원하지 않는 공급사입니다".into());
    }
    keyring::Entry::new("app.tokendeck.desktop", provider).map_err(|error| error.to_string())
}

fn is_supported_credential_provider(provider: &str) -> bool {
    if matches!(
        provider,
        "openai" | "anthropic" | "google" | "supabase" | "supabase-pending"
    ) {
        return true;
    }
    let Some((base, owner_hash)) = provider.split_once(':') else {
        return false;
    };
    matches!(base, "openai" | "anthropic" | "google")
        && owner_hash.len() == 16
        && owner_hash.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn credential_lock() -> std::sync::MutexGuard<'static, ()> {
    CREDENTIAL_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn secret_has_marker(secret: &str, marker: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(secret)
        .ok()
        .and_then(|value| {
            value
                .get("marker")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .as_deref()
        == Some(marker)
}

#[tauri::command]
fn store_provider_secret(provider: String, secret: String) -> Result<(), String> {
    if secret.trim().is_empty() {
        return Err("빈 자격 증명은 저장할 수 없습니다".into());
    }
    let _guard = credential_lock();
    credential_entry(&provider)?
        .set_password(&secret)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn load_provider_secret(provider: String) -> Result<Option<String>, String> {
    let _guard = credential_lock();
    match credential_entry(&provider)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn remove_provider_secret(provider: String) -> Result<(), String> {
    let _guard = credential_lock();
    match credential_entry(&provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn remove_provider_secret_if_marker(provider: String, marker: String) -> Result<bool, String> {
    let _guard = credential_lock();
    let entry = credential_entry(&provider)?;
    let secret = match entry.get_password() {
        Ok(secret) => secret,
        Err(keyring::Error::NoEntry) => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };
    if !secret_has_marker(&secret, &marker) {
        return Ok(false);
    }
    entry
        .delete_credential()
        .map_err(|error| error.to_string())?;
    Ok(true)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogDocument {
    provider: String,
    path: String,
    modified_at: u64,
    content: String,
    git_remote: Option<String>,
    project_id: String,
    project_name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalUsageScanResult {
    documents: Vec<LogDocument>,
    commit_token: String,
    codex_baselines: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct CurrentDeviceInfo {
    name: Option<String>,
    platform: String,
}

fn sanitize_device_display_name(value: &str) -> Option<String> {
    let without_controls: String = value
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect();
    let normalized = without_controls
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let truncated: String = normalized
        .chars()
        .take(MAX_DEVICE_DISPLAY_NAME_CHARS)
        .collect();
    let trimmed = truncated.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

fn resolve_device_display_name(
    computer_name: Option<&str>,
    host_name: Option<&str>,
) -> Option<String> {
    computer_name
        .and_then(sanitize_device_display_name)
        .or_else(|| host_name.and_then(sanitize_device_display_name))
}

#[tauri::command]
fn current_device_info() -> CurrentDeviceInfo {
    let computer_name = std::env::var("COMPUTERNAME").ok();
    let host_name = std::env::var("HOSTNAME").ok();
    CurrentDeviceInfo {
        name: resolve_device_display_name(computer_name.as_deref(), host_name.as_deref()),
        platform: std::env::consts::OS.to_owned(),
    }
}

fn git_remote_from_cwd(cwd: Option<PathBuf>) -> Option<String> {
    let mut directory = cwd?;
    loop {
        if let Some(config) = git_config_path(&directory) {
            if let Ok(content) = fs::read_to_string(config) {
                let mut in_origin = false;
                for line in content.lines() {
                    let trimmed = line.trim();
                    if trimmed.starts_with('[') {
                        in_origin = trimmed == "[remote \"origin\"]";
                    }
                    if in_origin && trimmed.starts_with("url") {
                        return trimmed
                            .split_once('=')
                            .map(|(_, url)| url.trim().to_owned());
                    }
                }
            }
        }
        if !directory.pop() {
            return None;
        }
    }
}

fn git_config_path(directory: &Path) -> Option<PathBuf> {
    let dot_git = directory.join(".git");
    if dot_git.is_dir() {
        return Some(dot_git.join("config"));
    }
    let pointer = fs::read_to_string(&dot_git).ok()?;
    let git_dir_value = pointer.trim().strip_prefix("gitdir:")?.trim();
    let git_dir = {
        let path = PathBuf::from(git_dir_value);
        if path.is_absolute() {
            path
        } else {
            directory.join(path)
        }
    };
    let common_dir = fs::read_to_string(git_dir.join("commondir"))
        .ok()
        .map(|value| git_dir.join(value.trim()));
    Some(common_dir.unwrap_or(git_dir).join("config"))
}

#[cfg(test)]
mod tests {
    use super::{
        collect_files, commit_scan_cursors_blocking, file_prefix_fingerprint, git_remote_from_cwd,
        load_local_project_names_at, load_local_usage_cache_at, load_local_usage_state_at,
        load_or_store_device_id_at, load_scan_cursors, local_project_name_cache_path,
        local_usage_cache_path, prime_file_cursors, prime_file_cursors_with_mode,
        provider_selected, read_json_value_chunk, read_log_chunk, resolve_device_display_name,
        safe_git_remote, sanitize_device_display_name, sanitized_log_records,
        save_local_project_names_at, save_local_usage_cache_at, save_local_usage_state_at,
        save_scan_cursors, scan_cursor_path, scan_local_usage_at, secret_has_marker,
        stable_local_identifier, CachedTokenBreakdown, CachedUsageEvent, CachedUsageOwnershipState,
        CachedUsageSource, ScanCursor, UsageProvider, MAX_DEVICE_DISPLAY_NAME_CHARS,
        MAX_LOCAL_USAGE_CACHE_BYTES, MAX_LOG_FILES, MAX_RAW_BYTES_PER_FILE_PER_SCAN,
        MAX_SCAN_DEPTH,
    };

    fn cached_usage_event() -> CachedUsageEvent {
        CachedUsageEvent {
            id: "event-1".to_owned(),
            provider: UsageProvider::Codex,
            source: CachedUsageSource::LocalJsonl,
            device_id: "00000000-0000-4000-8000-000000000001".to_owned(),
            session_id: "session-1".to_owned(),
            project_id: "project-1".to_owned(),
            model: Some("gpt-5".to_owned()),
            occurred_at: "2026-07-14T00:00:00.000Z".to_owned(),
            tokens: CachedTokenBreakdown {
                input: 1,
                cached: 2,
                output: 3,
                reasoning: 4,
                tool: 5,
            },
            request_id: None,
        }
    }

    fn temporary_home(label: &str) -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("token-deck-{label}-{unique}"))
    }
    use std::{
        collections::HashMap,
        fs,
        io::Write,
        path::Path,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn device_display_name_prefers_sanitized_computer_name() {
        assert_eq!(
            resolve_device_display_name(Some("  WORK\nPC\0  "), Some("fallback-host")),
            Some("WORK PC".to_owned())
        );
    }

    #[test]
    fn provider_selection_defaults_to_all_and_honors_explicit_choices() {
        assert!(provider_selected(None, UsageProvider::Codex));
        let selected = [UsageProvider::Codex, UsageProvider::Gemini];
        assert!(provider_selected(Some(&selected), UsageProvider::Codex));
        assert!(!provider_selected(Some(&selected), UsageProvider::Claude));
        assert!(provider_selected(Some(&selected), UsageProvider::Gemini));
        assert!(!provider_selected(Some(&[]), UsageProvider::Codex));
    }

    #[test]
    fn existing_webview_device_id_is_migrated_to_durable_native_state() {
        let home = temporary_home("device-id-migration");
        let existing = "00000000-0000-4000-8000-000000000001";

        assert_eq!(
            load_or_store_device_id_at(&home, existing).unwrap(),
            existing
        );
        assert_eq!(
            load_or_store_device_id_at(&home, "00000000-0000-4000-8000-000000000002").unwrap(),
            existing
        );

        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn native_device_id_is_recovered_after_primary_state_is_lost() {
        let home = temporary_home("device-id-recovery");
        let existing = "00000000-0000-4000-8000-000000000003";
        load_or_store_device_id_at(&home, existing).unwrap();
        fs::remove_file(super::device_identity_path(&home)).unwrap();

        assert_eq!(
            load_or_store_device_id_at(&home, "00000000-0000-4000-8000-000000000004").unwrap(),
            existing
        );
        assert!(super::device_identity_path(&home).exists());

        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn native_device_id_rejects_unsafe_legacy_values() {
        let home = temporary_home("invalid-device-id");

        assert!(load_or_store_device_id_at(&home, "../different-device").is_err());
        assert!(load_or_store_device_id_at(&home, "abc").is_err());
        assert!(!super::device_identity_path(&home).exists());

        if home.exists() {
            fs::remove_dir_all(home).unwrap();
        }
    }

    #[test]
    fn first_scan_load_keeps_persisted_file_cursor() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let home = std::env::temp_dir().join(format!("token-deck-cursor-{unique}"));
        let expected = ScanCursor {
            offset: 321,
            prefix_fingerprint: 654,
            created_at_nanos: 987,
            gemini_discard_offset: Some(123),
            codex_baseline: None,
        };
        let cursors = HashMap::from([("persisted".to_owned(), expected.clone())]);

        save_scan_cursors(&home, &cursors).unwrap();

        let loaded = load_scan_cursors(&home);
        assert_eq!(loaded.get("persisted").unwrap().offset, expected.offset);
        assert_eq!(
            loaded.get("persisted").unwrap().gemini_discard_offset,
            expected.gemini_discard_offset
        );
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn uncommitted_scan_is_replayed_until_cache_acknowledges_it() {
        let home = temporary_home("two-phase-scan");
        let log = home.join(".claude").join("projects").join("session.jsonl");
        fs::create_dir_all(log.parent().unwrap()).unwrap();
        fs::write(
            &log,
            "{\"sessionId\":\"session-1\",\"requestId\":\"request-1\",\"message\":{\"usage\":{\"input_tokens\":3}}}\n",
        )
        .unwrap();

        let first = scan_local_usage_at(&home, None, Some(vec![UsageProvider::Claude])).unwrap();
        assert_eq!(first.documents.len(), 1);
        assert!(!scan_cursor_path(&home).exists());

        let replay = scan_local_usage_at(&home, None, Some(vec![UsageProvider::Claude])).unwrap();
        assert_eq!(replay.documents.len(), 1);
        assert!(!scan_cursor_path(&home).exists());

        assert!(commit_scan_cursors_blocking(&replay.commit_token).unwrap());
        let key = stable_local_identifier(&log.to_string_lossy());
        assert_eq!(
            load_scan_cursors(&home).get(&key).unwrap().offset,
            fs::metadata(&log).unwrap().len()
        );
        assert!(!commit_scan_cursors_blocking(&first.commit_token).unwrap());
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn local_usage_cache_round_trip_restores_only_event_metadata() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let home = std::env::temp_dir().join(format!("token-deck-usage-cache-{unique}"));
        let expected = vec![cached_usage_event()];

        save_local_usage_cache_at(&home, &expected).unwrap();

        assert_eq!(load_local_usage_cache_at(&home).unwrap(), expected);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn local_usage_cache_rejects_prompt_fields_and_oversized_files() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let home = std::env::temp_dir().join(format!("token-deck-invalid-cache-{unique}"));
        let path = local_usage_cache_path(&home);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!([{
                "id": "event-1", "provider": "codex", "source": "local-jsonl",
                "deviceId": "00000000-0000-4000-8000-000000000001", "sessionId": "session-1", "projectId": "project-1",
                "occurredAt": "2026-07-14T00:00:00.000Z",
                "tokens": { "input": 1, "cached": 0, "output": 0, "reasoning": 0, "tool": 0 },
                "prompt": "저장하면 안 되는 원문"
            }]))
            .unwrap(),
        )
        .unwrap();
        assert!(load_local_usage_cache_at(&home).is_err());

        fs::File::create(&path)
            .unwrap()
            .set_len(MAX_LOCAL_USAGE_CACHE_BYTES + 1)
            .unwrap();
        assert!(load_local_usage_cache_at(&home).is_err());
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn local_usage_ownership_round_trip_uses_only_bounded_hashes() {
        let home = temporary_home("usage-ownership");
        assert!(load_local_usage_state_at(&home)
            .unwrap()
            .ownership
            .is_none());
        let events = vec![cached_usage_event()];
        let expected = CachedUsageOwnershipState {
            version: 1,
            known_event_ids: vec!["event-1".to_owned()],
            owners: HashMap::from([("event-1".to_owned(), "a".repeat(64))]),
            seen_filter: String::new(),
        };
        let unclaimed = CachedUsageOwnershipState {
            version: 1,
            known_event_ids: Vec::new(),
            owners: HashMap::new(),
            seen_filter: String::new(),
        };
        let checkpoint = HashMap::from([(
            "00000000-0000-4000-8000-000000000001:session-1".to_owned(),
            CachedTokenBreakdown {
                input: 51_000,
                cached: 500,
                output: 200,
                reasoning: 25,
                tool: 3,
            },
        )]);
        let retired_filter = format!(
            "{}==",
            "A".repeat(crate::LOCAL_USAGE_SEEN_FILTER_ENCODED_BYTES - 2)
        );

        save_local_usage_state_at(&home, &events, &unclaimed, &checkpoint, &retired_filter)
            .unwrap();
        save_local_usage_state_at(&home, &events, &expected, &checkpoint, &retired_filter).unwrap();

        let snapshot = load_local_usage_state_at(&home).unwrap();
        assert_eq!(snapshot.ownership, Some(expected.clone()));
        assert_eq!(snapshot.codex_cumulative, checkpoint);
        assert_eq!(snapshot.codex_retired_session_filter, retired_filter);

        fs::write(local_usage_cache_path(&home), "{broken").unwrap();
        let recovered = load_local_usage_state_at(&home).unwrap();
        assert_eq!(recovered.events, events);
        assert_eq!(recovered.ownership, Some(expected));
        assert_eq!(recovered.codex_cumulative, checkpoint);
        assert_eq!(recovered.codex_retired_session_filter, retired_filter);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn local_usage_ownership_rejects_unknown_events_and_corruption() {
        let home = temporary_home("invalid-usage-ownership");
        let unknown = CachedUsageOwnershipState {
            version: 1,
            known_event_ids: vec!["event-1".to_owned()],
            owners: HashMap::from([("event-2".to_owned(), "b".repeat(64))]),
            seen_filter: String::new(),
        };
        assert!(save_local_usage_state_at(
            &home,
            &[cached_usage_event()],
            &unknown,
            &HashMap::new(),
            ""
        )
        .is_err());
        let malformed_filter = CachedUsageOwnershipState {
            version: 1,
            known_event_ids: vec!["event-1".to_owned()],
            owners: HashMap::new(),
            seen_filter: "AAAA".to_owned(),
        };
        assert!(save_local_usage_state_at(
            &home,
            &[cached_usage_event()],
            &malformed_filter,
            &HashMap::new(),
            ""
        )
        .is_err());
        assert!(save_local_usage_state_at(
            &home,
            &[cached_usage_event()],
            &CachedUsageOwnershipState {
                version: 1,
                known_event_ids: vec!["event-1".to_owned()],
                owners: HashMap::new(),
                seen_filter: String::new(),
            },
            &HashMap::new(),
            "AAAA"
        )
        .is_err());

        let path = local_usage_cache_path(&home);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"{"version":1,"knownEventIds":[],"owners":{},"prompt":"secret"}"#,
        )
        .unwrap();
        assert!(load_local_usage_state_at(&home).is_err());
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn inferred_project_names_use_a_separate_safe_cache() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let home = std::env::temp_dir().join(format!("token-deck-project-cache-{unique}"));
        let expected = HashMap::from([("local_1234".to_owned(), "Token Deck".to_owned())]);

        save_local_project_names_at(&home, &expected).unwrap();

        assert_eq!(load_local_project_names_at(&home).unwrap(), expected);
        let path = local_project_name_cache_path(&home);
        fs::write(&path, r#"{"local_1234":"C:\\private\\project"}"#).unwrap();
        assert!(load_local_project_names_at(&home).is_err());
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn newly_enabled_provider_starts_after_logs_created_while_disabled() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("token-deck-prime-{unique}"));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("usage.jsonl");
        fs::write(&path, "disabled-period\n").unwrap();
        let mut cursors = HashMap::new();
        let mut files_seen = 0;

        prime_file_cursors(&root, "jsonl", &mut cursors, 0, &mut files_seen).unwrap();
        let key = stable_local_identifier(&path.to_string_lossy());
        let offset = cursors.get(&key).unwrap().offset;
        fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"enabled-period\n")
            .unwrap();

        let (lines, _) = read_log_chunk(&path, offset).unwrap();
        assert_eq!(lines, vec!["enabled-period"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reenabled_codex_marks_the_first_new_cumulative_record_as_a_baseline() {
        let home = temporary_home("codex-rebaseline");
        let root = home.join(".codex").join("sessions");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("session.jsonl");
        let session_meta = "{\"type\":\"session_meta\",\"payload\":{\"id\":\"session-1\",\"cwd\":\"C:\\\\work\\\\repo\"}}\n";
        let disabled_usage = "{\"type\":\"event_msg\",\"timestamp\":\"2026-07-11T00:00:01Z\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":100}}}}\n";
        fs::write(&path, format!("{session_meta}{disabled_usage}")).unwrap();
        let mut cursors = HashMap::new();
        let mut primed_files = 0;
        prime_file_cursors_with_mode(&root, "jsonl", &mut cursors, 0, &mut primed_files, true)
            .unwrap();
        let key = stable_local_identifier(&path.to_string_lossy());
        assert!(cursors.get(&key).unwrap().codex_baseline.is_some());
        save_scan_cursors(&home, &cursors).unwrap();

        let enabled_usage = "{\"type\":\"event_msg\",\"timestamp\":\"2026-07-11T00:00:02Z\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":1100}}}}\n";
        fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(enabled_usage.as_bytes())
            .unwrap();
        let scan = scan_local_usage_at(&home, None, Some(vec![UsageProvider::Codex])).unwrap();

        assert_eq!(scan.codex_baselines.len(), 1);
        assert!(scan.codex_baselines[0].contains("\"input_tokens\":100"));
        assert!(scan.codex_baselines[0].contains("\"session_id\":\"session-1\""));
        assert_eq!(scan.documents.len(), 1);
        assert!(scan.documents[0].content.contains("1100"));
        assert!(scan.documents[0]
            .content
            .contains("\"session_id\":\"session-1\""));
        assert!(commit_scan_cursors_blocking(&scan.commit_token).unwrap());
        assert!(load_scan_cursors(&home)
            .get(&key)
            .unwrap()
            .codex_baseline
            .is_none());
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn activation_boundary_fails_instead_of_partially_priming_over_file_limit() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("token-deck-prime-limit-{unique}"));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("usage.jsonl"), "disabled-period\n").unwrap();
        let mut cursors = HashMap::new();
        let mut files_seen = MAX_LOG_FILES;

        assert!(prime_file_cursors(&root, "jsonl", &mut cursors, 0, &mut files_seen).is_err());
        assert!(cursors.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn device_display_name_uses_hostname_when_computer_name_is_empty() {
        assert_eq!(
            resolve_device_display_name(Some("\0\n"), Some("  office-host  ")),
            Some("office-host".to_owned())
        );
        assert_eq!(resolve_device_display_name(None, Some("\r\n")), None);
    }

    #[test]
    fn device_display_name_removes_controls_and_limits_unicode_length() {
        let input = format!("{}\u{7f}private", "가".repeat(80));
        let sanitized = sanitize_device_display_name(&input).unwrap();

        assert_eq!(sanitized.chars().count(), MAX_DEVICE_DISPLAY_NAME_CHARS);
        assert!(sanitized.chars().all(|character| !character.is_control()));
    }

    #[test]
    fn worktree_uses_common_repository_config() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("token-deck-worktree-{unique}"));
        let worktree = root.join("worktree");
        let git_dir = root.join("repo.git").join("worktrees").join("feature");
        fs::create_dir_all(&worktree).unwrap();
        fs::create_dir_all(&git_dir).unwrap();
        fs::write(
            worktree.join(".git"),
            format!("gitdir: {}", git_dir.display()),
        )
        .unwrap();
        fs::write(git_dir.join("commondir"), "../..").unwrap();
        fs::write(
            root.join("repo.git").join("config"),
            "[remote \"origin\"]\n  url = git@github.com:owner/repo.git\n",
        )
        .unwrap();

        assert_eq!(
            git_remote_from_cwd(Some(worktree)),
            Some("git@github.com:owner/repo.git".into())
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn claude_log_sanitizer_removes_message_content_and_hashes_path() {
        let line = r#"{"cwd":"C:\\Users\\person\\secret-project","sessionId":"session-1","requestId":"request-1","timestamp":"2026-07-11T00:00:00Z","message":{"id":"message-1","model":"claude-test","content":[{"type":"text","text":"private prompt and source code"}],"usage":{"input_tokens":12,"output_tokens":3,"prompt":"nested private prompt"}}}"#;
        let records = sanitized_log_records("claude", line, None);

        assert_eq!(records.len(), 1);
        assert!(!records[0].line.contains("private prompt"));
        assert!(!records[0].line.contains("secret-project"));
        let value: serde_json::Value = serde_json::from_str(&records[0].line).unwrap();
        assert_eq!(
            value
                .pointer("/message/usage/input_tokens")
                .and_then(serde_json::Value::as_u64),
            Some(12)
        );
        assert!(value
            .get("cwd")
            .and_then(serde_json::Value::as_str)
            .unwrap()
            .starts_with("local_"));
    }

    #[test]
    fn gemini_log_sanitizer_drops_prompt_attributes() {
        let line = r#"{"timestamp":"2026-07-11T00:00:00Z","attributes":{"gen_ai.usage.input_tokens":8,"gen_ai.usage.output_tokens":2,"gen_ai.prompt":"private prompt","session.id":"session-1"}}"#;
        let records = sanitized_log_records("gemini", line, None);

        assert_eq!(records.len(), 1);
        assert!(!records[0].line.contains("private prompt"));
        assert!(!records[0].line.contains("gen_ai.prompt"));
        assert!(records[0].line.contains("gen_ai.usage.input_tokens"));
    }

    #[test]
    fn gemini_wrapped_attributes_keep_only_the_expected_scalar() {
        let line = r#"{"attributes":[{"key":"gen_ai.usage.input_tokens","value":{"intValue":"8","secret":"private prompt"}},{"key":"user.email","value":{"stringValue":"private@example.com"}},{"key":"gen_ai.input.messages","value":{"stringValue":"private source"}},{"key":"session.id","value":{"stringValue":"session-1"}}]}"#;
        let records = sanitized_log_records("gemini", line, None);

        assert_eq!(records.len(), 1);
        assert!(records[0]
            .line
            .contains("\"gen_ai.usage.input_tokens\":\"8\""));
        assert!(records[0].line.contains("\"session.id\":\"session-1\""));
        for private in [
            "private prompt",
            "private@example.com",
            "private source",
            "user.email",
        ] {
            assert!(!records[0].line.contains(private), "leaked {private}");
        }
    }

    fn gemini_file_exporter_records(project_dir: &Path) -> (String, String) {
        // google-gemini/gemini-cli f354eeb의 FileLogExporter 출력 형태를 재현합니다.
        let classic = serde_json::json!({
            "hrTime": [1_783_728_123_u64, 456_000_000_u64],
            "hrTimeObserved": [1_783_728_123_u64, 457_000_000_u64],
            "body": "private response body",
            "attributes": {
                "event.name": "gemini_cli.api_response",
                "event.timestamp": "2026-07-11T12:02:03.456Z",
                "session.id": "gemini-session",
                "prompt_id": "prompt-1",
                "model": "gemini-2.5-pro",
                "project_dir": project_dir.to_string_lossy(),
                "input_token_count": 20,
                "cached_content_token_count": 5,
                "output_token_count": 7,
                "thoughts_token_count": 3,
                "tool_token_count": 2,
                "user.email": "private@example.com",
                "response_text": "private response"
            },
            "resource": { "attributes": { "user.email": "private@example.com" } }
        });
        let semantic = serde_json::json!({
            "hrTime": [1_783_728_123_u64, 456_000_000_u64],
            "body": "semantic private response",
            "attributes": {
                "event.name": "gen_ai.client.inference.operation.details",
                "event.timestamp": "2026-07-11T12:02:03.456Z",
                "session.id": "gemini-session",
                "gen_ai.response.id": "response-1",
                "gen_ai.request.model": "gemini-2.5-pro",
                "project_dir": project_dir.to_string_lossy(),
                "gen_ai.usage.input_tokens": 20,
                "gen_ai.usage.output_tokens": 7,
                "gen_ai.input.messages": "private prompt",
                "gen_ai.output.messages": "private response"
            }
        });
        (
            serde_json::to_string_pretty(&classic).unwrap(),
            serde_json::to_string_pretty(&semantic).unwrap(),
        )
    }

    #[test]
    fn gemini_pretty_json_cursor_stays_at_the_last_complete_value() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("token-deck-gemini-stream-{unique}.log"));
        let (classic, semantic) = gemini_file_exporter_records(Path::new("C:\\work\\repo"));
        let partial_length = semantic.len() / 2;
        fs::write(&path, format!("{classic}\n{}", &semantic[..partial_length])).unwrap();

        let (first, first_cursor) = read_json_value_chunk(&path, 0).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first_cursor, classic.len() as u64);

        let complete = format!("{classic}\n{semantic}\n");
        fs::write(&path, &complete).unwrap();
        let (second, second_cursor) = read_json_value_chunk(&path, first_cursor).unwrap();
        assert_eq!(second.len(), 1);
        assert_eq!(second_cursor, complete.len() as u64);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn oversized_gemini_record_is_discarded_with_bounded_progress() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("token-deck-gemini-large-{unique}"));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("telemetry.log");
        let oversized = serde_json::json!({
            "body": format!(
                "private-prompt-{}",
                "x".repeat(MAX_RAW_BYTES_PER_FILE_PER_SCAN as usize + 1_024)
            ),
            "attributes": {
                "event.name": "gemini_cli.api_response",
                "event.timestamp": "2026-07-11T12:02:03.456Z",
                "session.id": "oversized-session",
                "prompt_id": "oversized-prompt",
                "model": "gemini-2.5-pro",
                "input_token_count": 99
            }
        });
        let normal = serde_json::json!({
            "attributes": {
                "event.name": "gemini_cli.api_response",
                "event.timestamp": "2026-07-11T12:02:04.456Z",
                "session.id": "normal-session",
                "prompt_id": "normal-prompt",
                "model": "gemini-2.5-pro",
                "input_token_count": 7
            }
        });
        fs::write(
            &path,
            format!(
                "{}\n{}\n",
                serde_json::to_string_pretty(&oversized).unwrap(),
                serde_json::to_string_pretty(&normal).unwrap()
            ),
        )
        .unwrap();
        let cursor_key = stable_local_identifier(&path.to_string_lossy());
        let mut cursors = HashMap::new();
        let mut output = Vec::new();

        for pass in 0..3 {
            let mut files_seen = 0;
            let mut output_bytes = 0;
            collect_files(
                &root,
                "log",
                "gemini",
                0,
                &mut output,
                0,
                &mut files_seen,
                &mut output_bytes,
                &mut cursors,
            );
            let cursor = cursors.get(&cursor_key).unwrap();
            if pass == 0 {
                assert_eq!(cursor.offset, 0);
                assert!(cursor.gemini_discard_offset.is_some());
            } else if pass == 1 {
                assert!(cursor.offset > 0);
                assert!(cursor.gemini_discard_offset.is_none());
            }
        }

        assert_eq!(output.len(), 1);
        assert!(output[0].content.contains("normal-prompt"));
        assert!(!output[0].content.contains("private-prompt"));
        assert!(!output[0].content.contains("oversized-prompt"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn gemini_file_exporter_records_are_sanitized_without_private_payloads() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("token-deck-gemini-pretty-{unique}"));
        let project = root.join("private-project");
        fs::create_dir_all(&root).unwrap();
        let (classic, semantic) = gemini_file_exporter_records(&project);
        fs::write(
            root.join("telemetry.log"),
            format!("{classic}\n{semantic}\n"),
        )
        .unwrap();
        let mut output = Vec::new();
        let mut files_seen = 0;
        let mut output_bytes = 0;
        let mut cursors = HashMap::new();

        collect_files(
            &root,
            "log",
            "gemini",
            0,
            &mut output,
            0,
            &mut files_seen,
            &mut output_bytes,
            &mut cursors,
        );

        assert_eq!(output.len(), 1);
        assert_eq!(output[0].content.lines().count(), 2);
        assert!(output[0].content.contains("input_token_count"));
        assert!(output[0].content.contains("gen_ai.response.id"));
        assert!(output[0].content.contains("hrTime"));
        for private in [
            "private@example.com",
            "private response",
            "private prompt",
            "user.email",
            "response_text",
            "gen_ai.input.messages",
            "gen_ai.output.messages",
            "project_dir",
        ] {
            assert!(!output[0].content.contains(private), "leaked {private}");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn log_scan_stops_beyond_maximum_depth() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("token-deck-depth-{unique}"));
        let mut deepest = root.clone();
        for _ in 0..=MAX_SCAN_DEPTH {
            deepest.push("nested");
        }
        fs::create_dir_all(&deepest).unwrap();
        fs::write(
            deepest.join("session.jsonl"),
            r#"{"sessionId":"s","message":{"usage":{"input_tokens":1}}}"#,
        )
        .unwrap();
        let mut output = Vec::new();
        let mut files_seen = 0;
        let mut output_bytes = 0;
        let mut cursors = HashMap::new();

        collect_files(
            &root,
            "jsonl",
            "claude",
            0,
            &mut output,
            0,
            &mut files_seen,
            &mut output_bytes,
            &mut cursors,
        );

        assert!(output.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn repeated_bounded_reads_eventually_reach_log_tail() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("token-deck-cursor-{unique}.jsonl"));
        let line = format!("{}\n", "x".repeat(1024));
        let content = line.repeat(9_000) + "tail\n";
        fs::write(&path, &content).unwrap();

        let (first, first_offset) = read_log_chunk(&path, 0).unwrap();
        assert!(!first.is_empty());
        assert!(first_offset > 0 && first_offset < content.len() as u64);
        let (second, second_offset) = read_log_chunk(&path, first_offset).unwrap();
        assert_eq!(second.last().map(String::as_str), Some("tail"));
        assert_eq!(second_offset, content.len() as u64);

        fs::remove_file(path).unwrap();
    }

    #[test]
    fn gemini_records_are_grouped_by_project_without_raw_paths() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("token-deck-gemini-{unique}"));
        fs::create_dir_all(&root).unwrap();
        let alpha = root.join("private-alpha");
        let beta = root.join("private-beta");
        let log = format!(
            "{{\"attributes\":{{\"project_dir\":{},\"gen_ai.usage.input_tokens\":1}}}}\n{{\"attributes\":{{\"project_dir\":{},\"gen_ai.usage.output_tokens\":2}}}}\n",
            serde_json::to_string(&alpha.to_string_lossy()).unwrap(),
            serde_json::to_string(&beta.to_string_lossy()).unwrap(),
        );
        fs::write(root.join("telemetry.log"), log).unwrap();
        let mut output = Vec::new();
        let mut files_seen = 0;
        let mut output_bytes = 0;
        let mut cursors = HashMap::new();

        collect_files(
            &root,
            "log",
            "gemini",
            0,
            &mut output,
            0,
            &mut files_seen,
            &mut output_bytes,
            &mut cursors,
        );

        assert_eq!(output.len(), 2);
        assert_ne!(output[0].project_id, output[1].project_id);
        for document in &output {
            assert!(!document.path.contains("private-alpha"));
            assert!(!document.path.contains("private-beta"));
            assert!(!document.content.contains("project_dir"));
            assert!(!document
                .content
                .contains(&root.to_string_lossy().to_string()));
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn codex_cursor_chunk_keeps_initial_session_project_for_token_events() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("token-deck-codex-{unique}"));
        fs::create_dir_all(&root).unwrap();
        let cwd = root.join("private-project");
        let session_meta = format!(
            "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"session-1\",\"cwd\":{}}}}}\n",
            serde_json::to_string(&cwd.to_string_lossy()).unwrap()
        );
        let token_count = "{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":4,\"output_tokens\":1}}}}\n";
        let path = root.join("session.jsonl");
        fs::write(&path, format!("{session_meta}{token_count}")).unwrap();
        let mut output = Vec::new();
        let mut files_seen = 0;
        let mut output_bytes = 0;
        let mut cursors = HashMap::from([(
            stable_local_identifier(&path.to_string_lossy()),
            ScanCursor {
                offset: session_meta.len() as u64,
                prefix_fingerprint: file_prefix_fingerprint(&path).unwrap(),
                created_at_nanos: 0,
                gemini_discard_offset: None,
                codex_baseline: None,
            },
        )]);

        collect_files(
            &root,
            "jsonl",
            "codex",
            0,
            &mut output,
            0,
            &mut files_seen,
            &mut output_bytes,
            &mut cursors,
        );

        assert_eq!(output.len(), 1);
        assert!(output[0].content.contains("input_tokens"));
        assert!(output[0].content.contains("\"session_id\":\"session-1\""));
        assert!(!output[0].content.contains("session_meta"));
        assert_eq!(
            output[0].project_id,
            super::project_metadata(Some(&cwd), &path).1
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn codex_chunk_without_prefix_session_id_does_not_advance_its_cursor() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("token-deck-codex-no-session-{unique}"));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("session.jsonl");
        let token_count = "{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":4}}}}\n";
        fs::write(&path, token_count).unwrap();
        let key = stable_local_identifier(&path.to_string_lossy());
        let mut cursors = HashMap::from([(
            key.clone(),
            ScanCursor {
                offset: 0,
                prefix_fingerprint: file_prefix_fingerprint(&path).unwrap(),
                created_at_nanos: 0,
                gemini_discard_offset: None,
                codex_baseline: None,
            },
        )]);
        let mut output = Vec::new();
        let mut files_seen = 0;
        let mut output_bytes = 0;

        collect_files(
            &root,
            "jsonl",
            "codex",
            0,
            &mut output,
            0,
            &mut files_seen,
            &mut output_bytes,
            &mut cursors,
        );

        assert!(output.is_empty());
        assert_eq!(cursors.get(&key).unwrap().offset, 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn replaced_log_resets_cursor_when_prefix_changes() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("token-deck-replace-{unique}"));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("session.jsonl");
        let old = "{\"sessionId\":\"old\",\"message\":{\"usage\":{\"input_tokens\":1}}}\n";
        fs::write(&path, old).unwrap();
        let key = stable_local_identifier(&path.to_string_lossy());
        let mut cursors = HashMap::from([(
            key,
            ScanCursor {
                offset: old.len() as u64,
                prefix_fingerprint: file_prefix_fingerprint(&path).unwrap(),
                created_at_nanos: 0,
                gemini_discard_offset: None,
                codex_baseline: None,
            },
        )]);
        let replacement = "{\"cwd\":\"C:\\\\work\\\\new-project\",\"sessionId\":\"new\",\"requestId\":\"new-request\",\"padding\":\"replacement-is-longer-than-the-old-file\",\"message\":{\"usage\":{\"input_tokens\":9}}}\n";
        fs::write(&path, replacement).unwrap();
        let mut output = Vec::new();
        let mut files_seen = 0;
        let mut output_bytes = 0;

        collect_files(
            &root,
            "jsonl",
            "claude",
            0,
            &mut output,
            0,
            &mut files_seen,
            &mut output_bytes,
            &mut cursors,
        );

        assert_eq!(output.len(), 1);
        assert!(output[0].content.contains("\"input_tokens\":9"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn restart_does_not_reset_an_unchanged_cursor_at_end_of_file() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("token-deck-restart-cursor-{unique}"));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("session.jsonl");
        let existing = "{\"sessionId\":\"old\",\"requestId\":\"old-request\",\"message\":{\"usage\":{\"input_tokens\":1}}}\n";
        fs::write(&path, existing).unwrap();
        let key = stable_local_identifier(&path.to_string_lossy());
        let mut cursors = HashMap::from([(
            key,
            ScanCursor {
                offset: existing.len() as u64,
                prefix_fingerprint: file_prefix_fingerprint(&path).unwrap(),
                created_at_nanos: 0,
                gemini_discard_offset: None,
                codex_baseline: None,
            },
        )]);
        let mut output = Vec::new();
        let mut files_seen = 0;
        let mut output_bytes = 0;

        collect_files(
            &root,
            "jsonl",
            "claude",
            0,
            &mut output,
            0,
            &mut files_seen,
            &mut output_bytes,
            &mut cursors,
        );

        assert!(output.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn remote_normalization_accepts_network_remotes_only() {
        assert_eq!(
            safe_git_remote("https://example.com/Owner/Repo.git".into()),
            Some("example.com/owner/repo".into())
        );
        assert_eq!(
            safe_git_remote("git@github.com:Owner/Repo.git".into()),
            Some("github.com/owner/repo".into())
        );
        assert_eq!(
            safe_git_remote("https://token@example.com/Owner/Repo.git".into()),
            None
        );
        assert_eq!(
            safe_git_remote("https://example.com/Owner/Repo.git?secret=1#frag".into()),
            None
        );
        assert_eq!(safe_git_remote("file:///C:/private/repo".into()), None);
        assert_eq!(safe_git_remote("C:\\private\\repo".into()), None);
        assert_eq!(safe_git_remote("//server/private/repo".into()), None);
    }

    #[test]
    fn credential_marker_comparison_requires_exact_marker() {
        let secret = r#"{"marker":"session-2","token":"private"}"#;
        assert!(secret_has_marker(secret, "session-2"));
        assert!(!secret_has_marker(secret, "session-1"));
        assert!(!secret_has_marker("not-json", "session-2"));
    }

    #[test]
    fn credential_provider_allows_owned_slots_only_for_account_providers() {
        assert!(crate::is_supported_credential_provider("openai"));
        assert!(crate::is_supported_credential_provider(
            "openai:0123456789abcdef"
        ));
        assert!(crate::is_supported_credential_provider(
            "anthropic:abcdef0123456789"
        ));
        assert!(crate::is_supported_credential_provider(
            "google:0123456789abcdef"
        ));
        assert!(crate::is_supported_credential_provider("supabase-pending"));
        assert!(!crate::is_supported_credential_provider(
            "supabase:0123456789abcdef"
        ));
        assert!(!crate::is_supported_credential_provider("openai:not-safe"));
        assert!(!crate::is_supported_credential_provider(
            "openai:0123456789abcdeg"
        ));
    }
}

fn is_usage_line(provider: &str, line: &str) -> bool {
    match provider {
        "codex" => line.contains("\"token_count\"") || line.contains("\"session_meta\""),
        "claude" => line.contains("\"usage\""),
        "gemini" => {
            line.contains("gen_ai.usage")
                || line.contains("gemini_cli.api_response")
                || line.contains("\"input_token_count\"")
        }
        _ => false,
    }
}

fn stable_local_identifier(value: &str) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in value.replace('\\', "/").to_lowercase().bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("local_{hash:016x}")
}

fn stable_project_hash(value: &str) -> String {
    let normalized = value
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase();
    (0..4u64)
        .map(|salt| {
            let mut hash = 0xcbf29ce484222325u64 ^ salt;
            for byte in normalized.bytes() {
                hash ^= u64::from(byte);
                hash = hash.wrapping_mul(0x100000001b3);
            }
            format!("{hash:016x}")
        })
        .collect()
}

fn safe_project_name(cwd: Option<&Path>, git_remote: Option<&str>) -> Option<String> {
    git_remote
        .and_then(|remote| remote.rsplit('/').next())
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            cwd.and_then(Path::file_name)
                .map(|name| name.to_string_lossy().into_owned())
        })
}

fn value_string<'a>(value: &'a serde_json::Value, pointers: &[&str]) -> Option<&'a str> {
    pointers
        .iter()
        .find_map(|pointer| value.pointer(pointer).and_then(serde_json::Value::as_str))
}

fn raw_cwd(value: &serde_json::Value) -> Option<PathBuf> {
    value_string(
        value,
        &[
            "/cwd",
            "/payload/cwd",
            "/workspace/path",
            "/attributes/project_dir",
        ],
    )
    .map(PathBuf::from)
}

fn sanitized_cwd(value: &serde_json::Value) -> Option<String> {
    raw_cwd(value).map(|path| stable_local_identifier(&path.to_string_lossy()))
}

fn sanitized_token_usage(value: &serde_json::Value) -> Option<serde_json::Value> {
    let allowed = [
        "input_tokens",
        "input",
        "cached_input_tokens",
        "cached_input_token_count",
        "cached_tokens",
        "cached",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
        "output_tokens",
        "output",
        "reasoning_output_tokens",
        "reasoning_tokens",
        "reasoning",
        "thinking_tokens",
        "tool_tokens",
        "tool",
        "total_tokens",
    ];
    let usage: serde_json::Map<String, serde_json::Value> = value
        .as_object()?
        .iter()
        .filter(|(key, item)| allowed.contains(&key.as_str()) && item.is_number())
        .map(|(key, item)| (key.clone(), item.clone()))
        .collect();
    (!usage.is_empty()).then_some(serde_json::Value::Object(usage))
}

fn sanitized_codex(
    value: &serde_json::Value,
    fallback_session_id: Option<&str>,
) -> Option<serde_json::Value> {
    if value
        .pointer("/payload/type")
        .and_then(serde_json::Value::as_str)
        == Some("session_meta")
        || value.get("type").and_then(serde_json::Value::as_str) == Some("session_meta")
    {
        return Some(serde_json::json!({
            "type": "session_meta",
            "timestamp": value.get("timestamp"),
            "payload": {
                "id": value_string(value, &["/payload/id", "/payload/session_id", "/session_id"])
                    .or(fallback_session_id),
                "cwd": sanitized_cwd(value)
            }
        }));
    }
    let usage = sanitized_token_usage(
        [
            "/payload/info/total_token_usage",
            "/payload/total_token_usage",
            "/info/total_token_usage",
            "/total_token_usage",
            "/usage",
        ]
        .iter()
        .find_map(|pointer| value.pointer(pointer))?,
    )?;
    Some(serde_json::json!({
        "timestamp": value.get("timestamp").or_else(|| value.get("created_at")),
        "payload": {
            "session_id": value_string(value, &["/payload/session_id", "/session_id", "/sessionId"])
                .or(fallback_session_id),
            "model": value_string(value, &["/payload/model", "/model"]),
            "info": { "total_token_usage": usage }
        }
    }))
}

fn sanitized_claude(value: &serde_json::Value) -> Option<serde_json::Value> {
    let usage = sanitized_token_usage(
        value
            .pointer("/message/usage")
            .or_else(|| value.get("usage"))?,
    )?;
    Some(serde_json::json!({
        "timestamp": value.get("timestamp").or_else(|| value.get("created_at")),
        "cwd": sanitized_cwd(value),
        "sessionId": value_string(value, &["/sessionId", "/session_id"]),
        "requestId": value_string(value, &["/requestId", "/request_id", "/message/id", "/response/id"]),
        "message": {
            "id": value_string(value, &["/message/id"]),
            "model": value_string(value, &["/message/model", "/model"]),
            "usage": usage
        }
    }))
}

fn gemini_attribute_allowed(key: &str) -> bool {
    key.starts_with("gen_ai.usage.")
        || matches!(
            key,
            "input_token_count"
                | "input_tokens"
                | "cached_token_count"
                | "cached_content_token_count"
                | "cached_tokens"
                | "output_token_count"
                | "output_tokens"
                | "thoughts_token_count"
                | "reasoning_tokens"
                | "tool_token_count"
                | "tool_tokens"
                | "session.id"
                | "session_id"
                | "gemini.session_id"
                | "gen_ai.request.id"
                | "gen_ai.response.id"
                | "request_id"
                | "event.id"
                | "prompt_id"
                | "gen_ai.request.model"
                | "model"
                | "model_name"
                | "event.name"
                | "event.timestamp"
        )
}

fn gemini_numeric_attribute(key: &str) -> bool {
    key.starts_with("gen_ai.usage.")
        || matches!(
            key,
            "input_token_count"
                | "input_tokens"
                | "cached_token_count"
                | "cached_content_token_count"
                | "cached_tokens"
                | "output_token_count"
                | "output_tokens"
                | "thoughts_token_count"
                | "reasoning_tokens"
                | "tool_token_count"
                | "tool_tokens"
        )
}

fn gemini_scalar_value(value: &serde_json::Value, numeric: bool) -> Option<&serde_json::Value> {
    if value.is_number() || value.is_string() {
        return Some(value);
    }
    let wrapped = value.as_object()?;
    let keys: &[&str] = if numeric {
        &["intValue", "doubleValue", "stringValue"]
    } else {
        &["stringValue"]
    };
    keys.iter().find_map(|key| wrapped.get(*key))
}

fn safe_gemini_attribute_value(key: &str, value: &serde_json::Value) -> Option<serde_json::Value> {
    let numeric = gemini_numeric_attribute(key);
    let value = gemini_scalar_value(value, numeric)?;
    if numeric {
        if value.is_number()
            || value.as_str().is_some_and(|text| {
                text.len() <= 32
                    && text
                        .parse::<f64>()
                        .is_ok_and(|number| number.is_finite() && number >= 0.0)
            })
        {
            return Some(value.clone());
        }
        return None;
    }
    value
        .as_str()
        .filter(|text| text.len() <= 1_024)
        .map(|_| value.clone())
}

fn sanitized_gemini_attributes(
    attributes: &serde_json::Value,
) -> Option<serde_json::Map<String, serde_json::Value>> {
    let mut safe = serde_json::Map::new();
    if let Some(items) = attributes.as_array() {
        for item in items {
            let Some(key) = item.get("key").and_then(serde_json::Value::as_str) else {
                continue;
            };
            if !gemini_attribute_allowed(key) {
                continue;
            }
            if let Some(value) = item
                .get("value")
                .and_then(|value| safe_gemini_attribute_value(key, value))
            {
                safe.insert(key.to_owned(), value);
            }
        }
    } else {
        for (key, value) in attributes.as_object()? {
            if !gemini_attribute_allowed(key) {
                continue;
            }
            if let Some(value) = safe_gemini_attribute_value(key, value) {
                safe.insert(key.clone(), value);
            }
        }
    }
    Some(safe)
}

fn safe_hr_time(value: Option<&serde_json::Value>) -> Option<serde_json::Value> {
    let parts = value?.as_array()?;
    if parts.len() != 2
        || parts.iter().any(|part| {
            !part.is_number()
                && !part
                    .as_str()
                    .is_some_and(|text| text.bytes().all(|byte| byte.is_ascii_digit()))
        })
    {
        return None;
    }
    Some(serde_json::Value::Array(parts.clone()))
}

fn safe_timestamp_value(value: Option<&serde_json::Value>) -> Option<serde_json::Value> {
    match value? {
        serde_json::Value::Number(number) => Some(serde_json::Value::Number(number.clone())),
        serde_json::Value::String(text)
            if text.len() <= 64
                && text.bytes().all(|byte| {
                    byte.is_ascii_digit() || matches!(byte, b'-' | b':' | b'.' | b'+' | b'T' | b'Z')
                }) =>
        {
            Some(serde_json::Value::String(text.clone()))
        }
        _ => None,
    }
}

fn sanitized_gemini_record(record: &serde_json::Value) -> Option<serde_json::Value> {
    let attributes = record
        .get("attributes")
        .or_else(|| record.get("attribute"))?;
    let safe_attributes = sanitized_gemini_attributes(attributes)?;
    let timestamp = safe_timestamp_value(record.get("timestamp"))
        .or_else(|| safe_timestamp_value(safe_attributes.get("event.timestamp")));
    Some(serde_json::json!({
        "timeUnixNano": safe_timestamp_value(record.get("timeUnixNano")),
        "observedTimeUnixNano": safe_timestamp_value(record.get("observedTimeUnixNano")),
        "hrTime": safe_hr_time(record.get("hrTime")),
        "hrTimeObserved": safe_hr_time(record.get("hrTimeObserved")),
        "timestamp": timestamp,
        "attributes": safe_attributes,
    }))
}

fn attribute_string(attributes: &serde_json::Value, key: &str) -> Option<String> {
    if let Some(value) = attributes.get(key).and_then(serde_json::Value::as_str) {
        return Some(value.to_owned());
    }
    attributes.as_array()?.iter().find_map(|item| {
        if item.get("key").and_then(serde_json::Value::as_str) != Some(key) {
            return None;
        }
        let value = item.get("value")?;
        value.as_str().map(str::to_owned).or_else(|| {
            value
                .as_object()?
                .values()
                .find_map(serde_json::Value::as_str)
                .map(str::to_owned)
        })
    })
}

fn gemini_record_cwd(record: &serde_json::Value, fallback: Option<&Path>) -> Option<PathBuf> {
    record
        .get("attributes")
        .or_else(|| record.get("attribute"))
        .and_then(|attributes| attribute_string(attributes, "project_dir"))
        .map(PathBuf::from)
        .or_else(|| fallback.map(Path::to_path_buf))
}

fn sanitized_gemini(value: &serde_json::Value) -> Vec<(serde_json::Value, Option<PathBuf>)> {
    if let Some(resource_logs) = value
        .get("resourceLogs")
        .and_then(serde_json::Value::as_array)
    {
        let mut records = Vec::new();
        for resource_log in resource_logs {
            let resource_cwd = resource_log
                .pointer("/resource/attributes")
                .and_then(|attributes| attribute_string(attributes, "project_dir"))
                .map(PathBuf::from);
            for scope in resource_log
                .get("scopeLogs")
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
            {
                for record in scope
                    .get("logRecords")
                    .and_then(serde_json::Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    if let Some(safe) = sanitized_gemini_record(record) {
                        records.push((safe, gemini_record_cwd(record, resource_cwd.as_deref())));
                    }
                }
            }
        }
        return records;
    }
    sanitized_gemini_record(value)
        .map(|safe| (safe, gemini_record_cwd(value, raw_cwd(value).as_deref())))
        .into_iter()
        .collect()
}

struct SanitizedRecord {
    line: String,
    cwd: Option<PathBuf>,
}

fn sanitized_log_records(
    provider: &str,
    line: &str,
    codex_session_id: Option<&str>,
) -> Vec<SanitizedRecord> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        return Vec::new();
    };
    let values: Vec<(serde_json::Value, Option<PathBuf>)> = match provider {
        "codex" => sanitized_codex(&value, codex_session_id)
            .map(|safe| (safe, raw_cwd(&value)))
            .into_iter()
            .collect(),
        "claude" => sanitized_claude(&value)
            .map(|safe| (safe, raw_cwd(&value)))
            .into_iter()
            .collect(),
        "gemini" => sanitized_gemini(&value),
        _ => Vec::new(),
    };
    values
        .into_iter()
        .filter_map(|(value, cwd)| {
            serde_json::to_string(&value)
                .ok()
                .map(|line| SanitizedRecord { line, cwd })
        })
        .collect()
}

fn safe_git_remote(remote: String) -> Option<String> {
    let trimmed = remote.trim().replace('\\', "/");
    if trimmed.starts_with('/')
        || trimmed.starts_with("//")
        || trimmed.as_bytes().get(1) == Some(&b':')
        || trimmed.contains(['?', '#'])
    {
        return None;
    }
    let without_suffix = trimmed.trim_end_matches('/').trim_end_matches(".git");
    let (host, path) = if let Some((scheme, rest)) = without_suffix.split_once("://") {
        if !matches!(
            scheme.to_ascii_lowercase().as_str(),
            "http" | "https" | "ssh" | "git"
        ) {
            return None;
        }
        let (authority, path) = rest.split_once('/')?;
        if authority.contains('@') {
            return None;
        }
        (authority, path)
    } else {
        let scp = without_suffix
            .rsplit_once('@')
            .map(|(_, value)| value)
            .unwrap_or(without_suffix);
        scp.split_once(':')?
    };
    let host = host.trim().to_lowercase();
    let path = path
        .trim_matches('/')
        .trim_end_matches(".git")
        .to_lowercase();
    if host.is_empty() || path.is_empty() || host.contains(['/', '\\']) {
        return None;
    }
    Some(format!("{host}/{path}"))
}

fn scan_cursor_path(home: &Path) -> PathBuf {
    home.join(".token-deck").join("scan-cursors.json")
}

fn load_scan_cursors(home: &Path) -> HashMap<String, ScanCursor> {
    let path = scan_cursor_path(home);
    fs::read_to_string(path)
        .ok()
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_default()
}

fn save_scan_cursors(home: &Path, cursors: &HashMap<String, ScanCursor>) -> Result<(), String> {
    let path = scan_cursor_path(home);
    let parent = path
        .parent()
        .ok_or_else(|| "스캔 커서 저장 경로를 확인할 수 없습니다".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    let content = serde_json::to_string(cursors).map_err(|error| error.to_string())?;
    fs::write(&temporary, content).map_err(|error| error.to_string())?;
    if fs::rename(&temporary, &path).is_err() {
        if path.exists() {
            fs::remove_file(&path).map_err(|error| error.to_string())?;
        }
        fs::rename(&temporary, &path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn scan_transactions() -> &'static Mutex<ScanTransactionState> {
    SCAN_TRANSACTIONS.get_or_init(|| Mutex::new(ScanTransactionState::default()))
}

fn collection_policy_revision(home: &Path) -> u64 {
    let state = scan_transactions()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    state.policy_revisions.get(home).copied().unwrap_or(0)
}

pub(crate) fn increment_collection_policy_revision(home: &Path) {
    let mut state = scan_transactions()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let revision = state
        .policy_revisions
        .entry(home.to_path_buf())
        .or_default();
    *revision = revision.wrapping_add(1);
}

fn stage_scan_commit(
    home: &Path,
    cursors: HashMap<String, ScanCursor>,
    policy_revision: u64,
) -> String {
    let mut state = scan_transactions()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    state.pending.retain(|_, pending| pending.home != home);
    state.next_token = state.next_token.wrapping_add(1);
    let token = format!("{}-{}", std::process::id(), state.next_token);
    state.pending.insert(
        token.clone(),
        PendingScanCommit {
            home: home.to_path_buf(),
            cursors,
            policy_revision,
        },
    );
    token
}

fn commit_scan_cursors_blocking(commit_token: &str) -> Result<bool, String> {
    let _scan_guard = SCAN_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut state = scan_transactions()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(pending) = state.pending.get(commit_token).cloned() else {
        return Ok(false);
    };
    let current_revision = state
        .policy_revisions
        .get(&pending.home)
        .copied()
        .unwrap_or(0);
    if current_revision != pending.policy_revision {
        state.pending.remove(commit_token);
        return Ok(false);
    }
    save_scan_cursors(&pending.home, &pending.cursors)?;
    state.pending.remove(commit_token);
    Ok(true)
}

fn device_identity_path(home: &Path) -> PathBuf {
    home.join(".token-deck").join("device-id.json")
}

fn valid_device_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

fn read_device_identity_file(path: &Path) -> Result<Option<CachedDeviceIdentity>, String> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if metadata.len() > MAX_DEVICE_ID_STATE_BYTES {
        return Err("기기 식별자 상태 파일이 허용 크기를 초과했습니다".to_owned());
    }
    let content = fs::read(path).map_err(|error| error.to_string())?;
    let identity: CachedDeviceIdentity = serde_json::from_slice(&content)
        .map_err(|error| format!("기기 식별자 상태 JSON이 올바르지 않습니다. {error}"))?;
    if identity.version != 1 || !valid_device_id(&identity.device_id) {
        return Err("기기 식별자 상태에 허용되지 않는 값이 있습니다".to_owned());
    }
    Ok(Some(identity))
}

fn replace_device_identity_file(path: &Path, content: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "기기 식별자 저장 경로를 확인할 수 없습니다".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
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
    fs::rename(&temporary, path)
        .map_err(|error| format!("기기 식별자 상태를 원자 교체하지 못했습니다. {error}"))
}

fn save_device_identity_at(home: &Path, device_id: &str) -> Result<(), String> {
    if !valid_device_id(device_id) {
        return Err("허용되지 않는 기기 식별자입니다".to_owned());
    }
    let identity = CachedDeviceIdentity {
        version: 1,
        device_id: device_id.to_owned(),
    };
    let content = serde_json::to_vec(&identity).map_err(|error| error.to_string())?;
    let primary = device_identity_path(home);
    let backup = primary.with_extension("json.bak");
    replace_device_identity_file(&backup, &content)?;
    replace_device_identity_file(&primary, &content)
}

fn load_or_store_device_id_at(home: &Path, candidate: &str) -> Result<String, String> {
    let _identity_guard = DEVICE_ID_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let primary = device_identity_path(home);
    match read_device_identity_file(&primary) {
        Ok(Some(identity)) => return Ok(identity.device_id),
        Ok(None) => {}
        Err(primary_error) => {
            let backup = primary.with_extension("json.bak");
            return match read_device_identity_file(&backup) {
                Ok(Some(identity)) => {
                    replace_device_identity_file(
                        &primary,
                        &serde_json::to_vec(&identity).map_err(|error| error.to_string())?,
                    )?;
                    Ok(identity.device_id)
                }
                Ok(None) | Err(_) => Err(format!(
                    "기기 식별자 상태와 복구 백업을 읽지 못했습니다. {primary_error}"
                )),
            };
        }
    }

    let backup = primary.with_extension("json.bak");
    match read_device_identity_file(&backup) {
        Ok(Some(identity)) => {
            replace_device_identity_file(
                &primary,
                &serde_json::to_vec(&identity).map_err(|error| error.to_string())?,
            )?;
            Ok(identity.device_id)
        }
        Ok(None) => {
            save_device_identity_at(home, candidate)?;
            Ok(candidate.to_owned())
        }
        Err(backup_error) => Err(format!(
            "기기 식별자 복구 백업을 읽지 못했습니다. {backup_error}"
        )),
    }
}

fn local_usage_cache_path(home: &Path) -> PathBuf {
    home.join(".token-deck").join("local-usage-events.json")
}

fn valid_cache_identifier(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_bytes
        && !value.chars().any(char::is_control)
        && !value.contains(['/', '\\'])
}

fn valid_cache_text(value: &str, max_bytes: usize) -> bool {
    value.len() <= max_bytes
        && !value.chars().any(char::is_control)
        && !value.contains("\\")
        && !value.starts_with('/')
        && !value.contains("://")
}

fn validate_cached_usage_events(events: &[CachedUsageEvent]) -> Result<(), String> {
    if events.len() > MAX_LOCAL_USAGE_CACHE_EVENTS {
        return Err(format!(
            "로컬 사용량 캐시는 최대 {MAX_LOCAL_USAGE_CACHE_EVENTS}개 이벤트까지 저장할 수 있습니다"
        ));
    }
    for event in events {
        if !valid_cache_identifier(&event.id, 256)
            || !valid_device_id(&event.device_id)
            || !valid_cache_identifier(&event.session_id, 256)
            || !valid_cache_identifier(&event.project_id, 256)
            || event
                .request_id
                .as_deref()
                .is_some_and(|value| !valid_cache_identifier(value, 256))
            || event
                .model
                .as_deref()
                .is_some_and(|value| !valid_cache_text(value, 256))
            || event.occurred_at.len() > 64
            || chrono::DateTime::parse_from_rfc3339(&event.occurred_at).is_err()
        {
            return Err("로컬 사용량 캐시에 허용되지 않는 메타데이터가 있습니다".to_owned());
        }
    }
    Ok(())
}

fn valid_owner_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn validate_local_usage_ownership(state: &CachedUsageOwnershipState) -> Result<(), String> {
    if state.version != 1 {
        return Err("지원하지 않는 로컬 사용량 소유권 형식입니다".to_owned());
    }
    if state.known_event_ids.len() > MAX_LOCAL_USAGE_CACHE_EVENTS
        || state.owners.len() > MAX_LOCAL_USAGE_CACHE_EVENTS
    {
        return Err(format!(
            "로컬 사용량 소유권은 최대 {MAX_LOCAL_USAGE_CACHE_EVENTS}개 이벤트까지 저장할 수 있습니다"
        ));
    }
    let known = state.known_event_ids.iter().collect::<HashSet<_>>();
    if known.len() != state.known_event_ids.len()
        || state
            .known_event_ids
            .iter()
            .any(|event_id| !valid_cache_identifier(event_id, 256))
        || state.owners.iter().any(|(event_id, owner_hash)| {
            !known.contains(event_id)
                || !valid_cache_identifier(event_id, 256)
                || !valid_owner_hash(owner_hash)
        })
        || !valid_local_usage_seen_filter(&state.seen_filter)
    {
        return Err("로컬 사용량 소유권에 허용되지 않는 값이 있습니다".to_owned());
    }
    Ok(())
}

fn valid_local_usage_seen_filter(value: &str) -> bool {
    value.is_empty()
        || (value.len() == LOCAL_USAGE_SEEN_FILTER_ENCODED_BYTES
            && value.bytes().enumerate().all(|(index, byte)| {
                if index >= value.len() - 2 {
                    byte == b'='
                } else {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/')
                }
            }))
}

fn validate_local_usage_state(state: &CachedLocalUsageState) -> Result<(), String> {
    if state.version != 1 {
        return Err("지원하지 않는 로컬 사용량 상태 형식입니다".to_owned());
    }
    validate_cached_usage_events(&state.events)?;
    validate_local_usage_ownership(&state.ownership)?;
    if state.codex_cumulative.len() > MAX_LOCAL_USAGE_CACHE_EVENTS
        || state
            .codex_cumulative
            .keys()
            .any(|key| !valid_cache_identifier(key, 512))
    {
        return Err("로컬 Codex 누적 기준점에 허용되지 않는 값이 있습니다".to_owned());
    }
    if !valid_local_usage_seen_filter(&state.codex_retired_session_filter) {
        return Err("로컬 Codex 퇴역 세션 필터가 올바르지 않습니다".to_owned());
    }
    let event_ids = state
        .events
        .iter()
        .map(|event| &event.id)
        .collect::<HashSet<_>>();
    if state
        .ownership
        .known_event_ids
        .iter()
        .any(|event_id| !event_ids.contains(event_id))
    {
        return Err("로컬 사용량 상태의 소유권이 보존 이벤트와 일치하지 않습니다".to_owned());
    }
    Ok(())
}

fn decode_local_usage_snapshot(content: &[u8]) -> Result<CachedLocalUsageSnapshot, String> {
    if let Ok(state) = serde_json::from_slice::<CachedLocalUsageState>(content) {
        validate_local_usage_state(&state)?;
        return Ok(CachedLocalUsageSnapshot {
            events: state.events,
            ownership: Some(state.ownership),
            codex_cumulative: state.codex_cumulative,
            codex_retired_session_filter: state.codex_retired_session_filter,
        });
    }
    let events: Vec<CachedUsageEvent> = serde_json::from_slice(content)
        .map_err(|error| format!("로컬 사용량 상태 JSON이 올바르지 않습니다. {error}"))?;
    validate_cached_usage_events(&events)?;
    Ok(CachedLocalUsageSnapshot {
        events,
        ownership: None,
        codex_cumulative: HashMap::new(),
        codex_retired_session_filter: String::new(),
    })
}

fn read_local_usage_file(path: &Path) -> Result<Option<CachedLocalUsageSnapshot>, String> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if metadata.len() > MAX_LOCAL_USAGE_CACHE_BYTES {
        return Err("로컬 사용량 상태 파일이 허용 크기를 초과했습니다".to_owned());
    }
    let content = fs::read(path).map_err(|error| error.to_string())?;
    decode_local_usage_snapshot(&content).map(Some)
}

fn load_local_usage_state_at(home: &Path) -> Result<CachedLocalUsageSnapshot, String> {
    let _cache_guard = LOCAL_USAGE_CACHE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = local_usage_cache_path(home);
    match read_local_usage_file(&path) {
        Ok(Some(snapshot)) => Ok(snapshot),
        Ok(None) => {
            let backup = path.with_extension("json.bak");
            match read_local_usage_file(&backup) {
                Ok(Some(snapshot)) => Ok(snapshot),
                Ok(None) => Ok(CachedLocalUsageSnapshot {
                    events: Vec::new(),
                    ownership: None,
                    codex_cumulative: HashMap::new(),
                    codex_retired_session_filter: String::new(),
                }),
                Err(backup_error) => Err(format!(
                    "로컬 사용량 상태와 복구 백업을 읽지 못했습니다. {backup_error}"
                )),
            }
        }
        Err(primary_error) => {
            let backup = path.with_extension("json.bak");
            match read_local_usage_file(&backup) {
                Ok(Some(snapshot)) => Ok(snapshot),
                Ok(None) | Err(_) => Err(format!(
                    "로컬 사용량 상태와 복구 백업을 읽지 못했습니다. {primary_error}"
                )),
            }
        }
    }
}

fn write_recoverable_file(path: &Path, content: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "로컬 사용량 상태 경로를 확인할 수 없습니다".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    let backup = path.with_extension("json.bak");
    let backup_temporary = path.with_extension("json.bak.tmp");
    fs::write(&temporary, content).map_err(|error| error.to_string())?;
    fs::write(&backup_temporary, content).map_err(|error| error.to_string())?;
    if backup.exists() {
        fs::remove_file(&backup).map_err(|error| error.to_string())?;
    }
    fs::rename(&backup_temporary, &backup).map_err(|error| error.to_string())?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    fs::rename(&temporary, path)
        .map_err(|error| format!("새 로컬 사용량 상태를 원자 교체하지 못했습니다. {error}"))
}

fn save_local_usage_state_at(
    home: &Path,
    events: &[CachedUsageEvent],
    ownership: &CachedUsageOwnershipState,
    codex_cumulative: &HashMap<String, CachedTokenBreakdown>,
    codex_retired_session_filter: &str,
) -> Result<(), String> {
    let _cache_guard = LOCAL_USAGE_CACHE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let state = CachedLocalUsageState {
        version: 1,
        events: events.to_vec(),
        ownership: ownership.clone(),
        codex_cumulative: codex_cumulative.clone(),
        codex_retired_session_filter: codex_retired_session_filter.to_owned(),
    };
    validate_local_usage_state(&state)?;
    let content = serde_json::to_vec(&state).map_err(|error| error.to_string())?;
    if content.len() as u64 > MAX_LOCAL_USAGE_CACHE_BYTES {
        return Err("로컬 사용량 상태 파일이 허용 크기를 초과했습니다".to_owned());
    }
    write_recoverable_file(&local_usage_cache_path(home), &content)
}

fn load_local_usage_cache_at(home: &Path) -> Result<Vec<CachedUsageEvent>, String> {
    Ok(load_local_usage_state_at(home)?.events)
}

fn save_local_usage_cache_at(home: &Path, events: &[CachedUsageEvent]) -> Result<(), String> {
    let ownership = CachedUsageOwnershipState {
        version: 1,
        known_event_ids: events.iter().map(|event| event.id.clone()).collect(),
        owners: HashMap::new(),
        seen_filter: String::new(),
    };
    save_local_usage_state_at(home, events, &ownership, &HashMap::new(), "")
}

fn local_project_name_cache_path(home: &Path) -> PathBuf {
    home.join(".token-deck").join("local-project-names.json")
}

fn validate_local_project_names(names: &HashMap<String, String>) -> Result<(), String> {
    if names.len() > MAX_LOCAL_PROJECT_CACHE_ENTRIES {
        return Err(format!(
            "로컬 프로젝트 이름 캐시는 최대 {MAX_LOCAL_PROJECT_CACHE_ENTRIES}개까지 저장할 수 있습니다"
        ));
    }
    for (project_id, name) in names {
        if !valid_cache_identifier(project_id, 256)
            || name.is_empty()
            || name.chars().count() > 80
            || name.chars().any(char::is_control)
            || name.contains(['/', '\\'])
            || name.contains("://")
            || matches!(name.as_str(), "." | "..")
        {
            return Err("로컬 프로젝트 이름 캐시에 허용되지 않는 값이 있습니다".to_owned());
        }
    }
    Ok(())
}

fn load_local_project_names_at(home: &Path) -> Result<HashMap<String, String>, String> {
    let _cache_guard = LOCAL_USAGE_CACHE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = local_project_name_cache_path(home);
    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(error) => return Err(error.to_string()),
    };
    if metadata.len() > MAX_LOCAL_PROJECT_CACHE_BYTES {
        return Err("로컬 프로젝트 이름 캐시 파일이 허용 크기를 초과했습니다".to_owned());
    }
    let content = fs::read(&path).map_err(|error| error.to_string())?;
    let names: HashMap<String, String> = serde_json::from_slice(&content).map_err(|error| {
        format!("로컬 프로젝트 이름 캐시 JSON 객체가 올바르지 않습니다. {error}")
    })?;
    validate_local_project_names(&names)?;
    Ok(names)
}

fn save_local_project_names_at(home: &Path, names: &HashMap<String, String>) -> Result<(), String> {
    let _cache_guard = LOCAL_USAGE_CACHE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    validate_local_project_names(names)?;
    let content = serde_json::to_vec(names).map_err(|error| error.to_string())?;
    if content.len() as u64 > MAX_LOCAL_PROJECT_CACHE_BYTES {
        return Err("로컬 프로젝트 이름 캐시 파일이 허용 크기를 초과했습니다".to_owned());
    }
    let path = local_project_name_cache_path(home);
    let parent = path
        .parent()
        .ok_or_else(|| "로컬 프로젝트 이름 캐시 경로를 확인할 수 없습니다".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, content).map_err(|error| error.to_string())?;
    if fs::rename(&temporary, &path).is_err() {
        if path.exists() {
            fs::remove_file(&path).map_err(|error| error.to_string())?;
        }
        fs::rename(&temporary, &path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn user_home_path() -> Result<PathBuf, String> {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .ok_or_else(|| "사용자 홈 폴더를 찾을 수 없습니다".to_owned())
}

#[tauri::command]
async fn load_or_store_device_id(candidate: String) -> Result<String, String> {
    let home = user_home_path()?;
    tauri::async_runtime::spawn_blocking(move || load_or_store_device_id_at(&home, &candidate))
        .await
        .map_err(|error| format!("기기 식별자 저장을 완료하지 못했습니다. {error}"))?
}

#[tauri::command]
async fn load_local_usage_cache() -> Result<Vec<CachedUsageEvent>, String> {
    let home = user_home_path()?;
    tauri::async_runtime::spawn_blocking(move || load_local_usage_cache_at(&home))
        .await
        .map_err(|error| format!("로컬 사용량 캐시 읽기를 완료하지 못했습니다. {error}"))?
}

#[tauri::command]
async fn save_local_usage_cache(events: Vec<CachedUsageEvent>) -> Result<(), String> {
    let home = user_home_path()?;
    tauri::async_runtime::spawn_blocking(move || save_local_usage_cache_at(&home, &events))
        .await
        .map_err(|error| format!("로컬 사용량 캐시 저장을 완료하지 못했습니다. {error}"))?
}

#[tauri::command]
async fn load_local_usage_state() -> Result<CachedLocalUsageSnapshot, String> {
    let home = user_home_path()?;
    tauri::async_runtime::spawn_blocking(move || load_local_usage_state_at(&home))
        .await
        .map_err(|error| format!("로컬 사용량 상태 읽기를 완료하지 못했습니다. {error}"))?
}

#[tauri::command]
async fn save_local_usage_state(
    events: Vec<CachedUsageEvent>,
    ownership: CachedUsageOwnershipState,
    codex_cumulative: HashMap<String, CachedTokenBreakdown>,
    codex_retired_session_filter: String,
) -> Result<(), String> {
    let home = user_home_path()?;
    tauri::async_runtime::spawn_blocking(move || {
        save_local_usage_state_at(
            &home,
            &events,
            &ownership,
            &codex_cumulative,
            &codex_retired_session_filter,
        )
    })
    .await
    .map_err(|error| format!("로컬 사용량 상태 저장을 완료하지 못했습니다. {error}"))?
}

#[tauri::command]
async fn load_local_project_names() -> Result<HashMap<String, String>, String> {
    let home = user_home_path()?;
    tauri::async_runtime::spawn_blocking(move || load_local_project_names_at(&home))
        .await
        .map_err(|error| format!("로컬 프로젝트 이름 캐시 읽기를 완료하지 못했습니다. {error}"))?
}

#[tauri::command]
async fn save_local_project_names(names: HashMap<String, String>) -> Result<(), String> {
    let home = user_home_path()?;
    tauri::async_runtime::spawn_blocking(move || save_local_project_names_at(&home, &names))
        .await
        .map_err(|error| format!("로컬 프로젝트 이름 캐시 저장을 완료하지 못했습니다. {error}"))?
}

fn read_bounded_line(reader: &mut BufReader<fs::File>) -> std::io::Result<Option<BoundedLine>> {
    let mut bytes = Vec::new();
    let mut bytes_read = 0usize;
    let mut overflowed = false;

    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if bytes_read == 0 {
                Ok(None)
            } else {
                Ok(Some(((!overflowed).then_some(bytes), bytes_read, false)))
            };
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(available.len(), |index| index + 1);
        if !overflowed {
            let remaining = MAX_LOG_LINE_BYTES.saturating_sub(bytes.len());
            let copied = consumed.min(remaining);
            bytes.extend_from_slice(&available[..copied]);
            overflowed = copied < consumed;
        }
        reader.consume(consumed);
        bytes_read = bytes_read.saturating_add(consumed);
        if newline.is_some() {
            return Ok(Some(((!overflowed).then_some(bytes), bytes_read, true)));
        }
    }
}

fn read_log_chunk(path: &Path, requested_offset: u64) -> Option<(Vec<String>, u64)> {
    let mut file = fs::File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    let offset = requested_offset.min(length);
    file.seek(SeekFrom::Start(offset)).ok()?;
    let mut reader = BufReader::new(file);
    let mut lines = Vec::new();
    let mut position = offset;
    loop {
        if position.saturating_sub(offset) >= MAX_RAW_BYTES_PER_FILE_PER_SCAN {
            break;
        }
        let line_start = position;
        let Some((bytes, read, terminated)) = read_bounded_line(&mut reader).ok()? else {
            break;
        };
        position += read as u64;
        if position.saturating_sub(offset) > MAX_RAW_BYTES_PER_FILE_PER_SCAN && !lines.is_empty() {
            position = line_start;
            break;
        }
        if !terminated {
            position = line_start;
            break;
        }
        // 비정상적으로 큰 단일 행 하나가 뒤의 정상 이벤트 수집까지 막지 않도록 건너뜁니다.
        let Some(mut bytes) = bytes else { continue };
        while matches!(bytes.last(), Some(b'\n' | b'\r')) {
            bytes.pop();
        }
        if let Ok(line) = String::from_utf8(bytes) {
            lines.push(line);
        }
    }
    Some((lines, position))
}

fn read_json_value_chunk(path: &Path, requested_offset: u64) -> Option<(Vec<String>, u64)> {
    let mut file = fs::File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    let offset = requested_offset.min(length);
    file.seek(SeekFrom::Start(offset)).ok()?;
    let read_limit = length
        .saturating_sub(offset)
        .min(MAX_RAW_BYTES_PER_FILE_PER_SCAN);
    let mut bytes = Vec::with_capacity(read_limit as usize);
    file.take(read_limit).read_to_end(&mut bytes).ok()?;

    let mut values = serde_json::Deserializer::from_slice(&bytes).into_iter::<serde_json::Value>();
    let mut records = Vec::new();
    let mut complete_offset = 0usize;
    while let Some(result) = values.next() {
        let Ok(value) = result else {
            break;
        };
        complete_offset = values.byte_offset();
        if let Ok(serialized) = serde_json::to_string(&value) {
            records.push(serialized);
        }
    }

    if offset + bytes.len() as u64 == length
        && bytes[complete_offset..].iter().all(u8::is_ascii_whitespace)
    {
        complete_offset = bytes.len();
    }
    Some((records, offset + complete_offset as u64))
}

struct ProviderChunk {
    lines: Vec<String>,
    next_offset: u64,
    gemini_discard_offset: Option<u64>,
}

fn scan_gemini_discard_boundary(path: &Path, start_offset: u64) -> Option<(Option<u64>, u64)> {
    const READ_BUFFER_BYTES: usize = 64 * 1024;
    const BOUNDARY_OVERLAP_BYTES: u64 = 16;

    let mut file = fs::File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    let start = start_offset.min(length);
    let mut at_line_start = start == 0;
    if start > 0 {
        file.seek(SeekFrom::Start(start - 1)).ok()?;
        let mut previous = [0_u8; 1];
        file.read_exact(&mut previous).ok()?;
        at_line_start = previous[0] == b'\n';
    }
    file.seek(SeekFrom::Start(start)).ok()?;

    let mut buffer = [0_u8; READ_BUFFER_BYTES];
    let mut scanned = 0_u64;
    let mut closing_line = false;
    while scanned < MAX_RAW_BYTES_PER_FILE_PER_SCAN {
        let remaining = (MAX_RAW_BYTES_PER_FILE_PER_SCAN - scanned) as usize;
        let read = file
            .read(&mut buffer[..remaining.min(READ_BUFFER_BYTES)])
            .ok()?;
        if read == 0 {
            break;
        }
        for (index, byte) in buffer[..read].iter().copied().enumerate() {
            let absolute = start + scanned + index as u64;
            if byte == b'\n' {
                if closing_line {
                    return Some((Some(absolute + 1), absolute + 1));
                }
                at_line_start = true;
                closing_line = false;
            } else if at_line_start {
                closing_line = matches!(byte, b'}' | b']');
                at_line_start = false;
            } else if closing_line && !matches!(byte, b' ' | b'\t' | b'\r') {
                closing_line = false;
            }
        }
        scanned += read as u64;
    }

    let scanned_end = start + scanned;
    if scanned_end == length && closing_line {
        return Some((Some(length), length));
    }
    let next_scan = scanned_end
        .saturating_sub(BOUNDARY_OVERLAP_BYTES)
        .max(start);
    Some((None, next_scan))
}

fn read_provider_chunk(
    path: &Path,
    requested_offset: u64,
    provider: &str,
    gemini_discard_offset: Option<u64>,
) -> Option<ProviderChunk> {
    if provider != "gemini" {
        let (lines, next_offset) = read_log_chunk(path, requested_offset)?;
        return Some(ProviderChunk {
            lines,
            next_offset,
            gemini_discard_offset: None,
        });
    }

    if let Some(discard_offset) = gemini_discard_offset {
        let (boundary, next_discard_offset) = scan_gemini_discard_boundary(path, discard_offset)?;
        return Some(ProviderChunk {
            lines: Vec::new(),
            next_offset: boundary.unwrap_or(requested_offset),
            gemini_discard_offset: boundary.is_none().then_some(next_discard_offset),
        });
    }

    let length = fs::metadata(path).ok()?.len();
    let read_end = requested_offset
        .saturating_add(MAX_RAW_BYTES_PER_FILE_PER_SCAN)
        .min(length);
    let (lines, next_offset) = read_json_value_chunk(path, requested_offset)?;
    let oversized = lines.is_empty() && next_offset == requested_offset && read_end < length;
    Some(ProviderChunk {
        lines,
        next_offset,
        gemini_discard_offset: oversized
            .then_some(read_end.saturating_sub(16).max(requested_offset)),
    })
}

fn initial_log_cwd(path: &Path, provider: &str) -> Option<PathBuf> {
    if !matches!(provider, "codex" | "claude") {
        return None;
    }
    read_log_chunk(path, 0)?.0.into_iter().find_map(|line| {
        serde_json::from_str::<serde_json::Value>(&line)
            .ok()
            .and_then(|value| raw_cwd(&value))
    })
}

fn file_prefix_fingerprint(path: &Path) -> Option<u64> {
    let mut file = fs::File::open(path).ok()?;
    let mut buffer = [0u8; 4096];
    let read = file.read(&mut buffer).ok()?;
    let mut hash = 0xcbf29ce484222325u64;
    for byte in &buffer[..read] {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    Some(hash)
}

fn project_metadata(
    cwd: Option<&Path>,
    log_path: &Path,
) -> (Option<String>, String, Option<String>) {
    let git_remote = git_remote_from_cwd(cwd.map(Path::to_path_buf)).and_then(safe_git_remote);
    let (prefix, input) = if let Some(remote) = git_remote.as_deref() {
        ("git_", remote.to_owned())
    } else {
        (
            "local_",
            cwd.map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_else(|| format!("log:{}", log_path.to_string_lossy())),
        )
    };
    let project_id = format!("{prefix}{}", stable_project_hash(&input));
    let project_name = safe_project_name(cwd, git_remote.as_deref());
    (git_remote, project_id, project_name)
}

struct PendingLogDocument {
    content: String,
    git_remote: Option<String>,
    project_name: Option<String>,
}

#[allow(clippy::too_many_arguments)]
fn collect_files(
    root: &Path,
    extension: &str,
    provider: &str,
    modified_since: u64,
    output: &mut Vec<LogDocument>,
    depth: usize,
    files_seen: &mut usize,
    output_bytes: &mut usize,
    cursors: &mut HashMap<String, ScanCursor>,
) {
    if depth > MAX_SCAN_DEPTH
        || *files_seen >= MAX_LOG_FILES
        || *output_bytes >= MAX_TOTAL_SANITIZED_BYTES
    {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if *files_seen >= MAX_LOG_FILES || *output_bytes >= MAX_TOTAL_SANITIZED_BYTES {
            return;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if is_link_like(&file_type) {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            collect_files(
                &path,
                extension,
                provider,
                modified_since,
                output,
                depth + 1,
                files_seen,
                output_bytes,
                cursors,
            );
            continue;
        }
        if path.extension().and_then(|value| value.to_str()) != Some(extension) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |value| value.as_secs());
        let cursor_key = stable_local_identifier(&path.to_string_lossy());
        let prefix_fingerprint = file_prefix_fingerprint(&path).unwrap_or(0);
        let created_at_nanos = metadata
            .created()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_nanos().min(u128::from(u64::MAX)) as u64)
            .unwrap_or(0);
        let stored = cursors.get(&cursor_key).cloned().unwrap_or_default();
        let same_file = stored.prefix_fingerprint == prefix_fingerprint
            && (stored.created_at_nanos == 0
                || created_at_nanos == 0
                || stored.created_at_nanos == created_at_nanos);
        let previous_offset = if same_file && stored.offset <= metadata.len() {
            stored.offset
        } else {
            0
        };
        let previous_discard_offset = (same_file && previous_offset == stored.offset)
            .then_some(stored.gemini_discard_offset)
            .flatten()
            .filter(|offset| *offset <= metadata.len());
        if modified_at <= modified_since && previous_offset >= metadata.len() {
            continue;
        }
        *files_seen += 1;
        let Some(chunk) =
            read_provider_chunk(&path, previous_offset, provider, previous_discard_offset)
        else {
            continue;
        };
        let default_cwd = initial_log_cwd(&path, provider);
        let codex_session_id = if provider == "codex" {
            match codex_session_id_from_prefix(&path) {
                Ok(session_id) => Some(session_id),
                Err(_) => continue,
            }
        } else {
            None
        };
        let mut grouped: HashMap<String, PendingLogDocument> = HashMap::new();
        for line in chunk.lines {
            if is_usage_line(provider, &line) {
                for record in sanitized_log_records(provider, &line, codex_session_id.as_deref()) {
                    let cwd = if provider == "gemini" {
                        record.cwd.as_deref()
                    } else {
                        record.cwd.as_deref().or(default_cwd.as_deref())
                    };
                    let (git_remote, project_id, project_name) = project_metadata(cwd, &path);
                    let pending = grouped
                        .entry(project_id)
                        .or_insert_with(|| PendingLogDocument {
                            content: String::new(),
                            git_remote,
                            project_name,
                        });
                    pending.content.push_str(&record.line);
                    pending.content.push('\n');
                }
            }
        }
        cursors.insert(
            cursor_key.clone(),
            ScanCursor {
                offset: chunk.next_offset,
                prefix_fingerprint,
                created_at_nanos,
                gemini_discard_offset: chunk.gemini_discard_offset,
                codex_baseline: None,
            },
        );
        for (project_id, pending) in grouped {
            if pending.content.is_empty() {
                continue;
            }
            if *output_bytes + pending.content.len() > MAX_TOTAL_SANITIZED_BYTES {
                cursors.insert(
                    cursor_key,
                    ScanCursor {
                        offset: previous_offset,
                        prefix_fingerprint,
                        created_at_nanos,
                        gemini_discard_offset: previous_discard_offset,
                        codex_baseline: None,
                    },
                );
                return;
            }
            *output_bytes += pending.content.len();
            output.push(LogDocument {
                provider: provider.into(),
                path: format!("log_{cursor_key}_{project_id}"),
                modified_at,
                content: pending.content,
                git_remote: pending.git_remote,
                project_id,
                project_name: pending.project_name,
            });
        }
    }
}

#[cfg(test)]
fn prime_file_cursors(
    root: &Path,
    extension: &str,
    cursors: &mut HashMap<String, ScanCursor>,
    depth: usize,
    files_seen: &mut usize,
) -> Result<(), String> {
    prime_file_cursors_with_mode(root, extension, cursors, depth, files_seen, false)
}

fn codex_baseline_from_tail(path: &Path, length: u64) -> Result<Option<String>, String> {
    if length == 0 {
        return Ok(None);
    }
    let start = length.saturating_sub(MAX_CODEX_BASELINE_TAIL_BYTES);
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    file.seek(SeekFrom::Start(start))
        .map_err(|error| error.to_string())?;
    let mut bytes = Vec::with_capacity((length - start) as usize);
    file.read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    let content = String::from_utf8_lossy(&bytes);
    let complete = if start == 0 {
        content.as_ref()
    } else {
        content.split_once('\n').map_or("", |(_, rest)| rest)
    };
    for line in complete.lines().rev() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let Some(mut sanitized) = sanitized_codex(&value, None) else {
            continue;
        };
        if sanitized
            .pointer("/payload/info/total_token_usage")
            .is_some()
        {
            if sanitized
                .pointer("/payload/session_id")
                .and_then(serde_json::Value::as_str)
                .is_none()
            {
                sanitized["payload"]["session_id"] =
                    serde_json::Value::String(codex_session_id_from_prefix(path)?);
            }
            return serde_json::to_string(&sanitized)
                .map(Some)
                .map_err(|error| error.to_string());
        }
    }
    if start > 0 {
        return Err(format!(
            "Codex 비활성 기간 기준점을 최근 {}바이트에서 찾지 못했습니다. {}",
            MAX_CODEX_BASELINE_TAIL_BYTES,
            path.display()
        ));
    }
    Ok(None)
}

fn codex_session_id_from_prefix(path: &Path) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut bytes = Vec::with_capacity(MAX_CODEX_SESSION_META_BYTES as usize + 1);
    file.take(MAX_CODEX_SESSION_META_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    let truncated = bytes.len() as u64 > MAX_CODEX_SESSION_META_BYTES;
    bytes.truncate(MAX_CODEX_SESSION_META_BYTES as usize);
    let content = String::from_utf8_lossy(&bytes);
    let complete = if truncated {
        content.rsplit_once('\n').map_or("", |(lines, _)| lines)
    } else {
        content.as_ref()
    };
    for line in complete.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let is_session_meta = value.get("type").and_then(serde_json::Value::as_str)
            == Some("session_meta")
            || value
                .pointer("/payload/type")
                .and_then(serde_json::Value::as_str)
                == Some("session_meta");
        if !is_session_meta {
            continue;
        }
        if let Some(session_id) = value_string(
            &value,
            &["/payload/id", "/payload/session_id", "/session_id"],
        ) {
            return Ok(session_id.to_owned());
        }
    }
    Err("Codex 비활성 기간 기준점의 세션 식별자를 찾지 못했습니다".to_owned())
}

fn prime_file_cursors_with_mode(
    root: &Path,
    extension: &str,
    cursors: &mut HashMap<String, ScanCursor>,
    depth: usize,
    files_seen: &mut usize,
    capture_codex_baseline: bool,
) -> Result<(), String> {
    if depth > MAX_SCAN_DEPTH {
        return Err("공급사 로그 폴더가 허용된 탐색 깊이를 초과했습니다".to_owned());
    }
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if is_link_like(&file_type) {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            prime_file_cursors_with_mode(
                &path,
                extension,
                cursors,
                depth + 1,
                files_seen,
                capture_codex_baseline,
            )?;
            continue;
        }
        if path.extension().and_then(|value| value.to_str()) != Some(extension) {
            continue;
        }
        if *files_seen >= MAX_LOG_FILES {
            return Err(format!(
                "공급사 로그 파일이 허용된 {MAX_LOG_FILES}개를 초과했습니다"
            ));
        }
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        *files_seen += 1;
        let cursor_key = stable_local_identifier(&path.to_string_lossy());
        let prefix_fingerprint = file_prefix_fingerprint(&path).ok_or_else(|| {
            format!(
                "공급사 로그 파일 경계를 읽을 수 없습니다. {}",
                path.display()
            )
        })?;
        let created_at_nanos = metadata
            .created()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_nanos().min(u128::from(u64::MAX)) as u64)
            .unwrap_or(0);
        cursors.insert(
            cursor_key,
            ScanCursor {
                offset: metadata.len(),
                prefix_fingerprint,
                created_at_nanos,
                gemini_discard_offset: None,
                codex_baseline: capture_codex_baseline
                    .then(|| codex_baseline_from_tail(&path, metadata.len()))
                    .transpose()?
                    .flatten(),
            },
        );
    }
    Ok(())
}

fn prime_provider_cursors(
    home: &Path,
    providers: &[UsageProvider],
    cursors: &mut HashMap<String, ScanCursor>,
) -> Result<(), String> {
    for provider in providers {
        let (root, extension) = match provider {
            UsageProvider::Codex => (home.join(".codex").join("sessions"), "jsonl"),
            UsageProvider::Claude => (home.join(".claude").join("projects"), "jsonl"),
            UsageProvider::Gemini => (home.join(".gemini"), "log"),
        };
        let mut files_seen = 0;
        prime_file_cursors_with_mode(
            &root,
            extension,
            cursors,
            0,
            &mut files_seen,
            matches!(provider, UsageProvider::Codex),
        )?;
    }
    Ok(())
}

fn scan_local_usage_at(
    home: &Path,
    modified_since: Option<u64>,
    providers: Option<Vec<UsageProvider>>,
) -> Result<LocalUsageScanResult, String> {
    let _scan_guard = SCAN_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let policy_revision = collection_policy_revision(home);
    let mut documents = Vec::new();
    let since = modified_since.unwrap_or(0);
    let mut files_seen = 0;
    let mut output_bytes = 0;
    let mut cursors = load_scan_cursors(home);
    let codex_selected = provider_selected(providers.as_deref(), UsageProvider::Codex);
    let codex_baselines = if codex_selected {
        cursors
            .values_mut()
            .filter_map(|cursor| cursor.codex_baseline.take())
            .collect()
    } else {
        Vec::new()
    };
    if codex_selected {
        let root = home.join(".codex").join("sessions");
        collect_files(
            &root,
            "jsonl",
            "codex",
            since,
            &mut documents,
            0,
            &mut files_seen,
            &mut output_bytes,
            &mut cursors,
        );
    }
    if provider_selected(providers.as_deref(), UsageProvider::Claude) {
        files_seen = 0;
        let root = home.join(".claude").join("projects");
        collect_files(
            &root,
            "jsonl",
            "claude",
            since,
            &mut documents,
            0,
            &mut files_seen,
            &mut output_bytes,
            &mut cursors,
        );
    }
    if provider_selected(providers.as_deref(), UsageProvider::Gemini) {
        files_seen = 0;
        let root = home.join(".gemini");
        collect_files(
            &root,
            "log",
            "gemini",
            since,
            &mut documents,
            0,
            &mut files_seen,
            &mut output_bytes,
            &mut cursors,
        );
    }
    documents.sort_by_key(|document| std::cmp::Reverse(document.modified_at));
    let commit_token = stage_scan_commit(home, cursors, policy_revision);
    Ok(LocalUsageScanResult {
        documents,
        commit_token,
        codex_baselines,
    })
}

fn scan_local_usage_blocking(
    modified_since: Option<u64>,
    providers: Option<Vec<UsageProvider>>,
) -> Result<LocalUsageScanResult, String> {
    let home = user_home_path()?;
    scan_local_usage_at(&home, modified_since, providers)
}

#[tauri::command]
async fn scan_local_usage(
    modified_since: Option<u64>,
    providers: Option<Vec<UsageProvider>>,
) -> Result<LocalUsageScanResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        scan_local_usage_blocking(modified_since, providers)
    })
    .await
    .map_err(|error| format!("로컬 사용량 수집 작업을 완료하지 못했습니다. {error}"))?
}

#[tauri::command]
async fn commit_scan_cursors(commit_token: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || commit_scan_cursors_blocking(&commit_token))
        .await
        .map_err(|error| format!("로컬 사용량 커서 저장을 완료하지 못했습니다. {error}"))?
}

#[tauri::command]
fn integration_status(providers: Option<Vec<UsageProvider>>) -> serde_json::Value {
    let home = std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_default();
    serde_json::json!({
        "codex": provider_selected(providers.as_deref(), UsageProvider::Codex) && home.join(".codex").join("sessions").exists(),
        "claude": provider_selected(providers.as_deref(), UsageProvider::Claude) && home.join(".claude").join("projects").exists(),
        "gemini": provider_selected(providers.as_deref(), UsageProvider::Gemini) && home.join(".gemini").exists()
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(
            |app, _arguments, _cwd| {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            },
        ))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            #[cfg(all(debug_assertions, windows))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link().register_all()?;
            }
            let show = MenuItem::with_id(app, "show", "Token Deck 열기", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let _tray = TrayIconBuilder::new()
                .tooltip("Token Deck")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            if std::env::args_os().any(|argument| argument == "--hidden") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_local_usage,
            commit_scan_cursors,
            load_or_store_device_id,
            load_local_usage_cache,
            save_local_usage_cache,
            load_local_usage_state,
            save_local_usage_state,
            load_local_project_names,
            save_local_project_names,
            integration_status,
            current_device_info,
            device_inventory::collect_device_inventory,
            device_inventory::apply_device_inventory_items,
            store_provider_secret,
            load_provider_secret,
            remove_provider_secret,
            remove_provider_secret_if_marker,
            native_integration::autostart_status,
            native_integration::set_autostart,
            native_integration::gemini_status,
            native_integration::configure_gemini_telemetry,
            native_integration::quota_statuses,
            native_integration::load_collection_providers,
            native_integration::set_collection_providers,
            native_integration::claude_quota_capture_status,
            native_integration::configure_claude_quota_capture,
        ])
        .run(tauri::generate_context!())
        .expect("Token Deck 실행 중 오류가 발생했습니다");
}
