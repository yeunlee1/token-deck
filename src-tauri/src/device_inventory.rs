// 기기별 AI 도구 설정을 비밀값 없이 수집하고 안전한 항목만 적용하는 모듈
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsString,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const SCHEMA_VERSION: u8 = 1;
const MAX_INVENTORY_ITEMS: usize = 512;
const MAX_APPLY_ITEMS: usize = 32;
const MAX_DIRECTORY_ENTRIES: usize = 512;
const MAX_CONFIG_BYTES: u64 = 1024 * 1024;
const MAX_CLI_OUTPUT_BYTES: u64 = 1024 * 1024;
const MAX_LABEL_BYTES: usize = 128;
const MAX_VERSION_BYTES: usize = 64;
const LIST_COMMAND_TIMEOUT: Duration = Duration::from_secs(15);
const APPLY_COMMAND_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeviceInventoryItem {
    pub provider: String,
    pub kind: String,
    pub key: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub enabled: bool,
    pub installed: bool,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marketplace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport: Option<String>,
    pub has_secrets: bool,
    pub transferable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeviceInventory {
    pub schema_version: u8,
    pub captured_at: u64,
    pub items: Vec<DeviceInventoryItem>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApplyDeviceInventoryResult {
    pub key: String,
    pub status: String,
    pub message: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SafeReadError {
    Missing,
    Link,
    NotFile,
    TooLarge,
    Io,
    InvalidUtf8,
}

#[derive(Default)]
struct InventoryCollector {
    items: BTreeMap<String, DeviceInventoryItem>,
    warnings: BTreeSet<String>,
}

impl InventoryCollector {
    fn insert(&mut self, item: DeviceInventoryItem) {
        if !valid_item(&item) {
            self.warn("inventory-item-invalid");
            return;
        }
        let identity = format!("{}\u{0}{}\u{0}{}", item.provider, item.kind, item.key);
        if let Some(existing) = self.items.get_mut(&identity) {
            merge_item(existing, item);
            return;
        }
        if self.items.len() >= MAX_INVENTORY_ITEMS {
            self.warn("inventory-limit-reached");
            return;
        }
        self.items.insert(identity, item);
    }

    fn warn(&mut self, code: &str) {
        self.warnings.insert(code.to_owned());
    }

    fn finish(self) -> DeviceInventory {
        DeviceInventory {
            schema_version: SCHEMA_VERSION,
            captured_at: now_millis(),
            items: self.items.into_values().collect(),
            warnings: self.warnings.into_iter().collect(),
        }
    }
}

#[tauri::command]
pub(crate) async fn collect_device_inventory() -> Result<DeviceInventory, String> {
    tauri::async_runtime::spawn_blocking(collect_device_inventory_blocking)
        .await
        .map_err(|_| "기기 설정 인벤토리를 수집하지 못했습니다".to_owned())
}

#[tauri::command]
pub(crate) async fn apply_device_inventory_items(
    items: Vec<DeviceInventoryItem>,
) -> Result<Vec<ApplyDeviceInventoryResult>, String> {
    if items.len() > MAX_APPLY_ITEMS {
        return Err("한 번에 적용할 수 있는 설정 항목 수를 초과했습니다".to_owned());
    }
    tauri::async_runtime::spawn_blocking(move || apply_items_blocking(items))
        .await
        .map_err(|_| "기기 설정 항목을 적용하지 못했습니다".to_owned())
}

fn collect_device_inventory_blocking() -> DeviceInventory {
    let Some(home) = user_home() else {
        let mut collector = InventoryCollector::default();
        collector.warn("home-unavailable");
        return collector.finish();
    };
    collect_from_home(&home, None)
}

fn collect_from_home(
    home: &Path,
    codex_plugins: Option<Vec<DeviceInventoryItem>>,
) -> DeviceInventory {
    let mut collector = InventoryCollector::default();
    collect_codex(home, codex_plugins, &mut collector);
    collect_claude(home, &mut collector);
    collect_gemini(home, &mut collector);
    collector.finish()
}

fn collect_codex(
    home: &Path,
    cli_plugins: Option<Vec<DeviceInventoryItem>>,
    collector: &mut InventoryCollector,
) {
    let root = home.join(".codex");
    if !provider_root_available(&root, collector, "codex-root") {
        return;
    }
    let config_path = root.join("config.toml");
    let config = read_limited_string(&config_path, MAX_CONFIG_BYTES)
        .and_then(|content| toml::from_str::<toml::Value>(&content).map_err(|_| SafeReadError::Io));

    match &config {
        Ok(value) => collect_toml_mcp_table("codex", value, "user", collector),
        Err(SafeReadError::Missing) => {}
        Err(error) => collector.warn(config_warning("codex", *error)),
    }

    if let Some(items) = cli_plugins.or_else(run_codex_plugin_list) {
        for item in items {
            collector.insert(item);
        }
    } else {
        collector.warn("codex-plugin-list-unavailable");
        if let Ok(value) = &config {
            collect_codex_plugins_from_config(
                value,
                &root.join("plugins").join("cache"),
                collector,
            );
        }
    }
    collect_codex_cached_plugin_skills(&root.join("plugins").join("cache"), collector);

    let skills_root = root.join("skills");
    let mut entries = bounded_directory_entries(
        &skills_root,
        MAX_DIRECTORY_ENTRIES,
        collector,
        "codex-skills",
    );
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if entry.file_name() == ".system" {
            collect_skill_root(
                "codex",
                &entry.path(),
                "system",
                collector,
                "codex-system-skills",
            );
        } else {
            collect_skill_entry("codex", &entry.path(), entry.file_name(), "user", collector);
        }
    }
}

fn collect_claude(home: &Path, collector: &mut InventoryCollector) {
    let root = home.join(".claude");
    if !provider_root_available(&root, collector, "claude-root") {
        return;
    }
    collect_skill_root(
        "claude",
        &root.join("skills"),
        "user",
        collector,
        "claude-skills",
    );

    let settings = read_json_file(&root.join("settings.json"), "claude-settings", collector);
    let installed = read_json_file(
        &root.join("plugins").join("installed_plugins.json"),
        "claude-installed-plugins",
        collector,
    );
    collect_claude_plugins(settings.as_ref(), installed.as_ref(), collector);
    collect_claude_plugin_skills(
        &root.join("plugins").join("data"),
        installed.as_ref(),
        collector,
    );

    if let Some(user_config) =
        read_json_file(&home.join(".claude.json"), "claude-user-config", collector)
    {
        if let Some(servers) = user_config.get("mcpServers") {
            collect_json_mcp_table("claude", servers, "user", None, collector);
        }
        if let Some(projects) = user_config.get("projects").and_then(JsonValue::as_object) {
            for project in projects.values().take(MAX_DIRECTORY_ENTRIES) {
                let Some(project_object) = project.as_object() else {
                    continue;
                };
                let disabled = string_set(project_object.get("disabledMcpjsonServers"));
                if let Some(servers) = project_object.get("mcpServers") {
                    collect_json_mcp_table(
                        "claude",
                        servers,
                        "project",
                        Some(&disabled),
                        collector,
                    );
                }
            }
            if projects.len() > MAX_DIRECTORY_ENTRIES {
                collector.warn("claude-project-limit-reached");
            }
        }
    }
}

fn collect_gemini(home: &Path, collector: &mut InventoryCollector) {
    let root = home.join(".gemini");
    if !provider_root_available(&root, collector, "gemini-root") {
        return;
    }
    collect_skill_root(
        "gemini",
        &root.join("skills"),
        "user",
        collector,
        "gemini-skills",
    );

    let mcp_enablement = read_json_file(
        &root.join("mcp-server-enablement.json"),
        "gemini-mcp-enablement",
        collector,
    );
    let mut disabled_mcp = gemini_disabled_mcp_servers(mcp_enablement.as_ref());
    if let Some(settings) =
        read_json_file(&root.join("settings.json"), "gemini-settings", collector)
    {
        if let Some(excluded) = settings.get("mcp").and_then(|value| value.get("excluded")) {
            disabled_mcp.extend(string_set(Some(excluded)));
        }
        if let Some(servers) = settings.get("mcpServers") {
            collect_json_mcp_table("gemini", servers, "user", Some(&disabled_mcp), collector);
        }
    }
    collect_gemini_extensions(&root.join("extensions"), &disabled_mcp, collector);
}

fn collect_skill_root(
    provider: &str,
    root: &Path,
    source: &str,
    collector: &mut InventoryCollector,
    warning_prefix: &str,
) {
    let mut entries =
        bounded_directory_entries(root, MAX_DIRECTORY_ENTRIES, collector, warning_prefix);
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        collect_skill_entry(
            provider,
            &entry.path(),
            entry.file_name(),
            source,
            collector,
        );
    }
}

fn collect_skill_entry(
    provider: &str,
    path: &Path,
    name: OsString,
    source: &str,
    collector: &mut InventoryCollector,
) {
    let Some(name) = name
        .to_str()
        .filter(|value| safe_label(value, MAX_LABEL_BYTES))
    else {
        return;
    };
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return;
    };
    if crate::is_link_like(&metadata.file_type()) || !metadata.is_dir() {
        return;
    }
    let manifest = path.join("SKILL.md");
    let Ok(manifest_metadata) = fs::symlink_metadata(manifest) else {
        return;
    };
    if crate::is_link_like(&manifest_metadata.file_type())
        || !manifest_metadata.is_file()
        || manifest_metadata.len() > MAX_CONFIG_BYTES
    {
        return;
    }
    collector.insert(DeviceInventoryItem {
        provider: provider.to_owned(),
        kind: "skill".to_owned(),
        key: name.to_owned(),
        display_name: name.to_owned(),
        version: None,
        enabled: true,
        installed: true,
        source: source.to_owned(),
        marketplace: None,
        transport: None,
        has_secrets: false,
        transferable: false,
        blocked_reason: Some("unsupported".to_owned()),
    });
}

#[allow(clippy::too_many_arguments)]
fn collect_plugin_skill_root(
    provider: &str,
    plugin_key: &str,
    root: &Path,
    version: Option<&str>,
    enabled: bool,
    installed: bool,
    source: &str,
    collector: &mut InventoryCollector,
    warning_prefix: &str,
) {
    let entries = bounded_directory_entries(root, MAX_DIRECTORY_ENTRIES, collector, warning_prefix);
    for entry in entries {
        let Some(skill_name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let combined_key = format!("{plugin_key}:{skill_name}");
        if !safe_label(&skill_name, MAX_LABEL_BYTES) || !safe_skill_directory(&entry.path()) {
            continue;
        }
        if !safe_label(&combined_key, MAX_LABEL_BYTES) {
            collector.warn("plugin-skill-key-too-long");
            continue;
        }
        collector.insert(DeviceInventoryItem {
            provider: provider.to_owned(),
            kind: "skill".to_owned(),
            key: combined_key,
            display_name: skill_name,
            version: version.map(str::to_owned),
            enabled,
            installed,
            source: source.to_owned(),
            marketplace: None,
            transport: None,
            has_secrets: false,
            transferable: false,
            blocked_reason: Some("unsupported".to_owned()),
        });
    }
}

fn collect_toml_mcp_table(
    provider: &str,
    root: &toml::Value,
    source: &str,
    collector: &mut InventoryCollector,
) {
    let Some(servers) = root.get("mcp_servers").and_then(toml::Value::as_table) else {
        return;
    };
    for (name, config) in servers.iter().take(MAX_DIRECTORY_ENTRIES) {
        let Some(table) = config.as_table() else {
            continue;
        };
        let has_secrets = toml_has_secret_references(config, 0) || toml_has_secret_arguments(table);
        let has_local_path = toml_has_local_path(table);
        let enabled = table
            .get("enabled")
            .and_then(toml::Value::as_bool)
            .unwrap_or_else(|| {
                !table
                    .get("disabled")
                    .and_then(toml::Value::as_bool)
                    .unwrap_or(false)
            });
        insert_mcp_item(
            provider,
            name,
            source,
            transport_from_toml(table),
            enabled,
            has_secrets,
            has_local_path,
            collector,
        );
    }
    if servers.len() > MAX_DIRECTORY_ENTRIES {
        collector.warn("mcp-server-limit-reached");
    }
}

fn collect_json_mcp_table(
    provider: &str,
    value: &JsonValue,
    source: &str,
    disabled: Option<&BTreeSet<String>>,
    collector: &mut InventoryCollector,
) {
    let Some(servers) = value.as_object() else {
        return;
    };
    for (name, config) in servers.iter().take(MAX_DIRECTORY_ENTRIES) {
        let Some(object) = config.as_object() else {
            continue;
        };
        let configured_enabled = object
            .get("enabled")
            .and_then(JsonValue::as_bool)
            .unwrap_or_else(|| {
                !object
                    .get("disabled")
                    .and_then(JsonValue::as_bool)
                    .unwrap_or(false)
            });
        let enabled = configured_enabled && !disabled.is_some_and(|set| mcp_is_disabled(set, name));
        insert_mcp_item(
            provider,
            name,
            source,
            transport_from_json(object),
            enabled,
            json_has_secret_references(config, 0) || json_has_secret_arguments(object),
            json_has_local_path(object),
            collector,
        );
    }
    if servers.len() > MAX_DIRECTORY_ENTRIES {
        collector.warn("mcp-server-limit-reached");
    }
}

#[allow(clippy::too_many_arguments)]
fn insert_mcp_item(
    provider: &str,
    name: &str,
    source: &str,
    transport: String,
    enabled: bool,
    has_secrets: bool,
    has_local_path: bool,
    collector: &mut InventoryCollector,
) {
    if !safe_label(name, MAX_LABEL_BYTES) {
        return;
    }
    let blocked_reason = if has_secrets {
        "secret"
    } else if has_local_path {
        "local_path"
    } else {
        "unsupported"
    };
    collector.insert(DeviceInventoryItem {
        provider: provider.to_owned(),
        kind: "mcp".to_owned(),
        key: name.to_owned(),
        display_name: name.to_owned(),
        version: None,
        enabled,
        installed: true,
        source: source.to_owned(),
        marketplace: None,
        transport: Some(transport),
        has_secrets,
        transferable: false,
        blocked_reason: Some(blocked_reason.to_owned()),
    });
}

fn run_codex_plugin_list() -> Option<Vec<DeviceInventoryItem>> {
    let bytes = command_output_limited(codex_program(), &["plugin", "list", "--json"])?;
    parse_codex_plugin_list(&bytes).ok()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexPluginList {
    #[serde(default)]
    installed: Vec<CodexPluginRecord>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexPluginRecord {
    plugin_id: String,
    version: Option<String>,
    #[serde(default)]
    installed: bool,
    #[serde(default)]
    enabled: bool,
}

fn parse_codex_plugin_list(bytes: &[u8]) -> Result<Vec<DeviceInventoryItem>, ()> {
    if bytes.len() as u64 > MAX_CLI_OUTPUT_BYTES {
        return Err(());
    }
    let list: CodexPluginList = serde_json::from_slice(bytes).map_err(|_| ())?;
    let mut items = Vec::new();
    for record in list.installed.into_iter().take(MAX_INVENTORY_ITEMS) {
        let Some((name, marketplace)) = split_plugin_selector(&record.plugin_id) else {
            continue;
        };
        let name = name.to_owned();
        let marketplace = marketplace.to_owned();
        items.push(DeviceInventoryItem {
            provider: "codex".to_owned(),
            kind: "plugin".to_owned(),
            key: record.plugin_id,
            display_name: name,
            version: safe_version(record.version),
            enabled: record.enabled,
            installed: record.installed,
            source: marketplace_source(&marketplace).to_owned(),
            marketplace: Some(marketplace),
            transport: None,
            has_secrets: false,
            transferable: record.installed && record.enabled,
            blocked_reason: None,
        });
    }
    Ok(items)
}

fn collect_codex_plugins_from_config(
    config: &toml::Value,
    cache_root: &Path,
    collector: &mut InventoryCollector,
) {
    let versions = codex_plugin_versions(cache_root, collector);
    let Some(plugins) = config.get("plugins").and_then(toml::Value::as_table) else {
        return;
    };
    for (selector, config) in plugins.iter().take(MAX_DIRECTORY_ENTRIES) {
        let Some((name, marketplace)) = split_plugin_selector(selector) else {
            continue;
        };
        let enabled = config
            .get("enabled")
            .and_then(toml::Value::as_bool)
            .unwrap_or(true);
        collector.insert(DeviceInventoryItem {
            provider: "codex".to_owned(),
            kind: "plugin".to_owned(),
            key: selector.to_owned(),
            display_name: name.to_owned(),
            version: versions.get(selector).cloned().flatten(),
            enabled,
            installed: true,
            source: marketplace_source(marketplace).to_owned(),
            marketplace: Some(marketplace.to_owned()),
            transport: None,
            has_secrets: false,
            transferable: enabled,
            blocked_reason: None,
        });
    }
}

fn codex_plugin_versions(
    cache_root: &Path,
    collector: &mut InventoryCollector,
) -> BTreeMap<String, Option<String>> {
    let mut versions = BTreeMap::new();
    let marketplaces = bounded_directory_entries(
        cache_root,
        MAX_DIRECTORY_ENTRIES,
        collector,
        "codex-plugin-cache",
    );
    for marketplace_entry in marketplaces {
        let Some(marketplace) = marketplace_entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !valid_selector_component(&marketplace) || !safe_directory(&marketplace_entry.path()) {
            continue;
        }
        let plugins = bounded_directory_entries(
            &marketplace_entry.path(),
            MAX_DIRECTORY_ENTRIES,
            collector,
            "codex-plugin-cache",
        );
        for plugin_entry in plugins {
            let Some(plugin) = plugin_entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if !valid_selector_component(&plugin) || !safe_directory(&plugin_entry.path()) {
                continue;
            }
            let selector = format!("{plugin}@{marketplace}");
            let version_entries = bounded_directory_entries(
                &plugin_entry.path(),
                MAX_DIRECTORY_ENTRIES,
                collector,
                "codex-plugin-cache",
            );
            for version_entry in version_entries {
                if !safe_directory(&version_entry.path()) {
                    continue;
                }
                let manifest_root = version_entry.path().join(".codex-plugin");
                if !safe_directory(&manifest_root) {
                    continue;
                }
                let manifest = manifest_root.join("plugin.json");
                let Ok(content) = read_limited_string(&manifest, MAX_CONFIG_BYTES) else {
                    continue;
                };
                let Ok(value) = serde_json::from_str::<JsonValue>(&content) else {
                    continue;
                };
                let Some(version) = value
                    .get("version")
                    .and_then(JsonValue::as_str)
                    .filter(|value| safe_label(value, MAX_VERSION_BYTES))
                else {
                    continue;
                };
                versions
                    .entry(selector.clone())
                    .and_modify(|known| *known = None)
                    .or_insert_with(|| Some(version.to_owned()));
            }
        }
    }
    versions
}

fn collect_codex_cached_plugin_skills(cache_root: &Path, collector: &mut InventoryCollector) {
    let states = plugin_state_snapshot(collector, "codex");
    if states.is_empty() {
        return;
    }
    let marketplaces = bounded_directory_entries(
        cache_root,
        MAX_DIRECTORY_ENTRIES,
        collector,
        "codex-plugin-skills",
    );
    for marketplace_entry in marketplaces {
        let Some(marketplace) = marketplace_entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !valid_selector_component(&marketplace) || !safe_directory(&marketplace_entry.path()) {
            continue;
        }
        let plugins = bounded_directory_entries(
            &marketplace_entry.path(),
            MAX_DIRECTORY_ENTRIES,
            collector,
            "codex-plugin-skills",
        );
        for plugin_entry in plugins {
            let Some(plugin) = plugin_entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let selector = format!("{plugin}@{marketplace}");
            let Some(state) = states.get(&selector).filter(|state| state.installed) else {
                continue;
            };
            let Some(expected_version) = state.version.as_deref() else {
                collector.warn("codex-plugin-skill-version-unknown");
                continue;
            };
            let versions = bounded_directory_entries(
                &plugin_entry.path(),
                MAX_DIRECTORY_ENTRIES,
                collector,
                "codex-plugin-skills",
            );
            let mut matched = false;
            for version in versions {
                if !safe_directory(&version.path())
                    || !codex_cache_version_matches(&version.path(), expected_version)
                {
                    continue;
                }
                matched = true;
                collect_plugin_skill_root(
                    "codex",
                    &selector,
                    &version.path().join("skills"),
                    state.version.as_deref(),
                    state.enabled,
                    state.installed,
                    &state.source,
                    collector,
                    "codex-plugin-skills",
                );
                break;
            }
            if !matched {
                collector.warn("codex-plugin-skill-version-not-found");
            }
        }
    }
}

fn codex_cache_version_matches(version_root: &Path, expected: &str) -> bool {
    if version_root
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == expected)
    {
        return true;
    }
    let manifest_root = version_root.join(".codex-plugin");
    if !safe_directory(&manifest_root) {
        return false;
    }
    read_limited_string(&manifest_root.join("plugin.json"), MAX_CONFIG_BYTES)
        .ok()
        .and_then(|content| serde_json::from_str::<JsonValue>(&content).ok())
        .and_then(|manifest| {
            manifest
                .get("version")
                .and_then(JsonValue::as_str)
                .map(str::to_owned)
        })
        .is_some_and(|version| version == expected)
}

fn plugin_state_snapshot(
    collector: &InventoryCollector,
    provider: &str,
) -> BTreeMap<String, DeviceInventoryItem> {
    collector
        .items
        .values()
        .filter(|item| item.provider == provider && item.kind == "plugin")
        .map(|item| (item.key.clone(), item.clone()))
        .collect()
}

fn collect_claude_plugins(
    settings: Option<&JsonValue>,
    installed: Option<&JsonValue>,
    collector: &mut InventoryCollector,
) {
    let mut plugins: BTreeMap<String, (bool, bool, Option<String>)> = BTreeMap::new();
    if let Some(enabled) = settings
        .and_then(|value| value.get("enabledPlugins"))
        .and_then(JsonValue::as_object)
    {
        for (selector, value) in enabled.iter().take(MAX_DIRECTORY_ENTRIES) {
            if split_plugin_selector(selector).is_some() {
                plugins
                    .entry(selector.clone())
                    .or_insert((false, false, None))
                    .0 = value.as_bool().unwrap_or(false);
            }
        }
    }
    if let Some(installed_plugins) = installed
        .and_then(|value| value.get("plugins"))
        .and_then(JsonValue::as_object)
    {
        for (selector, records) in installed_plugins.iter().take(MAX_DIRECTORY_ENTRIES) {
            if split_plugin_selector(selector).is_none() {
                continue;
            }
            let entry = plugins
                .entry(selector.clone())
                .or_insert((true, false, None));
            entry.1 = true;
            entry.2 = installed_plugin_version(records);
        }
    }
    for (selector, (enabled, installed, version)) in plugins {
        let Some((name, marketplace)) = split_plugin_selector(&selector) else {
            continue;
        };
        collector.insert(DeviceInventoryItem {
            provider: "claude".to_owned(),
            kind: "plugin".to_owned(),
            key: selector.clone(),
            display_name: name.to_owned(),
            version: version.clone(),
            enabled,
            installed,
            source: "marketplace".to_owned(),
            marketplace: Some(marketplace.to_owned()),
            transport: None,
            has_secrets: false,
            transferable: installed && enabled,
            blocked_reason: None,
        });
    }
}

fn installed_plugin_version(value: &JsonValue) -> Option<String> {
    let version = if let Some(object) = value.as_object() {
        object.get("version").and_then(JsonValue::as_str)
    } else {
        value.as_array().and_then(|records| {
            records
                .iter()
                .find_map(|record| record.get("version").and_then(JsonValue::as_str))
        })
    }?;
    safe_label(version, MAX_VERSION_BYTES).then(|| version.to_owned())
}

fn collect_claude_plugin_skills(
    data_root: &Path,
    installed: Option<&JsonValue>,
    collector: &mut InventoryCollector,
) {
    let states = plugin_state_snapshot(collector, "claude");
    let Some(installed_plugins) = installed
        .and_then(|value| value.get("plugins"))
        .and_then(JsonValue::as_object)
    else {
        return;
    };
    for (selector, records) in installed_plugins.iter().take(MAX_DIRECTORY_ENTRIES) {
        let Some((plugin_name, marketplace)) = split_plugin_selector(selector) else {
            continue;
        };
        let Some(state) = states.get(selector).filter(|state| state.installed) else {
            continue;
        };
        let Some(expected_version) = state.version.as_deref() else {
            collector.warn("claude-plugin-skill-version-unknown");
            continue;
        };
        let mut matched = false;
        for record in installed_plugin_records(records) {
            if record.get("version").and_then(JsonValue::as_str) != Some(expected_version) {
                continue;
            }
            let Some(plugin_root) = record
                .get("path")
                .and_then(JsonValue::as_str)
                .and_then(|path| safe_installed_plugin_path(data_root, path))
            else {
                continue;
            };
            if plugin_root.file_name().and_then(|name| name.to_str()) != Some(marketplace) {
                continue;
            }
            let manifest_root = plugin_root.join(".claude-plugin");
            if !safe_directory(&manifest_root) {
                continue;
            }
            let Some(manifest) = read_json_file(
                &manifest_root.join("plugin.json"),
                "claude-plugin-manifest",
                collector,
            ) else {
                continue;
            };
            if manifest.get("name").and_then(JsonValue::as_str) != Some(plugin_name)
                || manifest.get("version").and_then(JsonValue::as_str) != Some(expected_version)
            {
                continue;
            }
            matched = true;
            collect_plugin_skill_root(
                "claude",
                &state.key,
                &plugin_root.join("skills"),
                state.version.as_deref(),
                state.enabled,
                state.installed,
                &state.source,
                collector,
                "claude-plugin-skills",
            );
            break;
        }
        if !matched {
            collector.warn("claude-plugin-skill-installation-unverified");
        }
    }
}

fn installed_plugin_records(value: &JsonValue) -> Vec<&serde_json::Map<String, JsonValue>> {
    if let Some(object) = value.as_object() {
        return vec![object];
    }
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(JsonValue::as_object)
        .take(MAX_DIRECTORY_ENTRIES)
        .collect()
}

fn safe_installed_plugin_path(data_root: &Path, raw_path: &str) -> Option<PathBuf> {
    if !safe_directory(data_root) {
        return None;
    }
    let candidate = PathBuf::from(raw_path);
    if !candidate.is_absolute() {
        return None;
    }
    let root_canonical = fs::canonicalize(data_root).ok()?;
    let candidate_canonical = fs::canonicalize(&candidate).ok()?;
    if !candidate_canonical.starts_with(&root_canonical) {
        return None;
    }
    let relative = candidate.strip_prefix(data_root).ok()?;
    let mut current = data_root.to_path_buf();
    for component in relative.components() {
        let std::path::Component::Normal(component) = component else {
            return None;
        };
        current.push(component);
        if !safe_directory(&current) {
            return None;
        }
    }
    Some(candidate)
}

fn collect_gemini_extensions(
    root: &Path,
    disabled_mcp: &BTreeSet<String>,
    collector: &mut InventoryCollector,
) {
    let enablement = read_json_file(
        &root.join("extension-enablement.json"),
        "gemini-extension-enablement",
        collector,
    );
    let entries =
        bounded_directory_entries(root, MAX_DIRECTORY_ENTRIES, collector, "gemini-extensions");
    for entry in entries {
        if !safe_directory(&entry.path()) {
            continue;
        }
        let Some(manifest) = read_json_file(
            &entry.path().join("gemini-extension.json"),
            "gemini-extension-manifest",
            collector,
        ) else {
            continue;
        };
        let Some(name) = manifest
            .get("name")
            .and_then(JsonValue::as_str)
            .filter(|value| valid_selector_component(value))
        else {
            continue;
        };
        let version = manifest
            .get("version")
            .and_then(JsonValue::as_str)
            .filter(|value| safe_label(value, MAX_VERSION_BYTES))
            .map(str::to_owned);
        let enabled = gemini_extension_enabled(enablement.as_ref(), name);
        let has_env_file = regular_nonempty_file(&entry.path().join(".env"));
        let has_secrets = has_env_file || json_has_secret_references(&manifest, 0);
        collector.insert(DeviceInventoryItem {
            provider: "gemini".to_owned(),
            kind: "plugin".to_owned(),
            key: name.to_owned(),
            display_name: name.to_owned(),
            version: version.clone(),
            enabled,
            installed: true,
            source: "user".to_owned(),
            marketplace: None,
            transport: None,
            has_secrets,
            transferable: false,
            blocked_reason: None,
        });
        collect_plugin_skill_root(
            "gemini",
            name,
            &entry.path().join("skills"),
            version.as_deref(),
            enabled,
            true,
            "user",
            collector,
            "gemini-extension-skills",
        );
        if let Some(servers) = manifest.get("mcpServers") {
            collect_json_mcp_table("gemini", servers, "user", Some(disabled_mcp), collector);
        }
    }
}

fn gemini_extension_enabled(enablement: Option<&JsonValue>, name: &str) -> bool {
    let Some(overrides) = enablement
        .and_then(|value| value.get(name))
        .and_then(|value| value.get("overrides"))
        .and_then(JsonValue::as_array)
    else {
        return true;
    };
    overrides
        .iter()
        .filter_map(JsonValue::as_str)
        .next_back()
        .is_none_or(|rule| !rule.trim_start().starts_with('!'))
}

fn gemini_disabled_mcp_servers(enablement: Option<&JsonValue>) -> BTreeSet<String> {
    enablement
        .and_then(JsonValue::as_object)
        .into_iter()
        .flatten()
        .filter(|(_, state)| {
            state
                .get("enabled")
                .and_then(JsonValue::as_bool)
                .is_some_and(|enabled| !enabled)
        })
        .map(|(name, _)| name.trim().to_lowercase())
        .collect()
}

fn apply_items_blocking(items: Vec<DeviceInventoryItem>) -> Vec<ApplyDeviceInventoryResult> {
    let local = collect_device_inventory_blocking();
    let local_plugins: BTreeMap<(String, String), DeviceInventoryItem> = local
        .items
        .into_iter()
        .filter(|item| item.kind == "plugin")
        .map(|item| ((item.provider.clone(), item.key.clone()), item))
        .collect();

    items
        .into_iter()
        .map(|item| apply_item(item, &local_plugins))
        .collect()
}

fn apply_item(
    item: DeviceInventoryItem,
    local_plugins: &BTreeMap<(String, String), DeviceInventoryItem>,
) -> ApplyDeviceInventoryResult {
    apply_item_with_command(item, local_plugins, command_status)
}

fn apply_item_with_command<F>(
    item: DeviceInventoryItem,
    local_plugins: &BTreeMap<(String, String), DeviceInventoryItem>,
    run_command: F,
) -> ApplyDeviceInventoryResult
where
    F: Fn(&str, &[&str]) -> bool,
{
    let result_key = if safe_label(&item.key, MAX_LABEL_BYTES) {
        item.key.clone()
    } else {
        "invalid".to_owned()
    };
    if item.kind == "skill" || item.kind == "mcp" {
        return apply_result(
            result_key,
            "manual",
            "스킬과 MCP 설정은 대상 기기에서 직접 확인해야 합니다",
        );
    }
    if item.kind != "plugin" || !matches!(item.provider.as_str(), "codex" | "claude" | "gemini") {
        return apply_result(result_key, "failed", "지원하지 않는 설정 항목입니다");
    }
    if !valid_item(&item) || !valid_apply_recipe(&item) {
        return apply_result(
            "invalid".to_owned(),
            "failed",
            "설정 항목의 안전 조건을 확인할 수 없습니다",
        );
    }

    let local = local_plugins.get(&(item.provider.clone(), item.key.clone()));
    if local.is_some_and(|value| value.installed && value.enabled) {
        return apply_result(
            result_key,
            "alreadyPresent",
            "이미 설치되어 활성화된 항목입니다",
        );
    }

    match item.provider.as_str() {
        "codex" => {
            let success = run_command(codex_program(), &["plugin", "add", "--json", &item.key]);
            command_apply_result(
                result_key,
                success,
                "Codex 플러그인을 설치하고 활성화했습니다",
            )
        }
        "claude" => {
            let installed = local.is_some_and(|value| value.installed)
                || run_command(
                    claude_program(),
                    &["plugin", "install", &item.key, "--scope", "user"],
                );
            let enabled = installed
                && run_command(
                    claude_program(),
                    &["plugin", "enable", &item.key, "--scope", "user"],
                );
            command_apply_result(
                result_key,
                enabled,
                "Claude 플러그인을 설치하고 활성화했습니다",
            )
        }
        "gemini" => {
            let Some(local) = local else {
                return apply_result(
                    "invalid".to_owned(),
                    "failed",
                    "설정 항목의 안전 조건을 확인할 수 없습니다",
                );
            };
            if !local.installed {
                return apply_result(
                    "invalid".to_owned(),
                    "failed",
                    "설정 항목의 안전 조건을 확인할 수 없습니다",
                );
            }
            let success = run_command(gemini_program(), &["extensions", "enable", &item.key]);
            command_apply_result(result_key, success, "Gemini 확장 기능을 활성화했습니다")
        }
        _ => apply_result(result_key, "failed", "지원하지 않는 공급사입니다"),
    }
}

fn valid_apply_recipe(item: &DeviceInventoryItem) -> bool {
    if !item.installed || !item.enabled || item.has_secrets || item.blocked_reason.is_some() {
        return false;
    }
    match item.provider.as_str() {
        "codex" | "claude" => {
            let Some((name, marketplace)) = split_plugin_selector(&item.key) else {
                return false;
            };
            item.transferable
                && item.display_name == name
                && matches!(item.source.as_str(), "marketplace" | "bundled")
                && item.marketplace.as_deref() == Some(marketplace)
                && item.transport.is_none()
        }
        "gemini" => {
            valid_plugin_key("gemini", &item.key)
                && item.display_name == item.key
                && item.source == "user"
                && item.marketplace.is_none()
                && item.transport.is_none()
        }
        _ => false,
    }
}

fn command_apply_result(
    key: String,
    success: bool,
    success_message: &str,
) -> ApplyDeviceInventoryResult {
    if success {
        apply_result(key, "applied", success_message)
    } else {
        apply_result(key, "failed", "도구의 설정 명령을 완료하지 못했습니다")
    }
}

fn apply_result(key: String, status: &str, message: &str) -> ApplyDeviceInventoryResult {
    ApplyDeviceInventoryResult {
        key,
        status: status.to_owned(),
        message: message.to_owned(),
    }
}

fn valid_item(item: &DeviceInventoryItem) -> bool {
    matches!(item.provider.as_str(), "codex" | "claude" | "gemini")
        && matches!(item.kind.as_str(), "skill" | "mcp" | "plugin")
        && matches!(
            item.source.as_str(),
            "user" | "system" | "marketplace" | "bundled" | "project"
        )
        && safe_label(&item.key, MAX_LABEL_BYTES)
        && safe_label(&item.display_name, MAX_LABEL_BYTES)
        && item
            .version
            .as_deref()
            .is_none_or(|value| safe_label(value, MAX_VERSION_BYTES))
        && item
            .marketplace
            .as_deref()
            .is_none_or(valid_selector_component)
        && item
            .transport
            .as_deref()
            .is_none_or(|value| matches!(value, "stdio" | "http" | "sse" | "unknown"))
        && item
            .blocked_reason
            .as_deref()
            .is_none_or(|value| matches!(value, "secret" | "local_path" | "unsupported"))
}

fn merge_item(existing: &mut DeviceInventoryItem, incoming: DeviceInventoryItem) {
    existing.enabled |= incoming.enabled;
    existing.installed |= incoming.installed;
    existing.has_secrets |= incoming.has_secrets;
    existing.transferable |= incoming.transferable;
    if existing.version.is_none() {
        existing.version = incoming.version;
    }
    if existing.transport != incoming.transport {
        existing.transport = Some("unknown".to_owned());
    }
    existing.blocked_reason =
        stronger_blocked_reason(existing.blocked_reason.take(), incoming.blocked_reason);
}

fn stronger_blocked_reason(left: Option<String>, right: Option<String>) -> Option<String> {
    [left, right]
        .into_iter()
        .flatten()
        .max_by_key(|value| match value.as_str() {
            "secret" => 3,
            "local_path" => 2,
            "unsupported" => 1,
            _ => 0,
        })
}

fn read_json_file(
    path: &Path,
    warning_prefix: &str,
    collector: &mut InventoryCollector,
) -> Option<JsonValue> {
    match read_limited_string(path, MAX_CONFIG_BYTES) {
        Ok(content) => match serde_json::from_str(&content) {
            Ok(value) => Some(value),
            Err(_) => {
                collector.warn(&format!("{warning_prefix}-invalid"));
                None
            }
        },
        Err(SafeReadError::Missing) => None,
        Err(error) => {
            collector.warn(config_warning(warning_prefix, error));
            None
        }
    }
}

fn read_limited_string(path: &Path, max_bytes: u64) -> Result<String, SafeReadError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            SafeReadError::Missing
        } else {
            SafeReadError::Io
        }
    })?;
    if crate::is_link_like(&metadata.file_type()) {
        return Err(SafeReadError::Link);
    }
    if !metadata.is_file() {
        return Err(SafeReadError::NotFile);
    }
    if metadata.len() > max_bytes {
        return Err(SafeReadError::TooLarge);
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    fs::File::open(path)
        .map_err(|_| SafeReadError::Io)?
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| SafeReadError::Io)?;
    if bytes.len() as u64 > max_bytes {
        return Err(SafeReadError::TooLarge);
    }
    String::from_utf8(bytes).map_err(|_| SafeReadError::InvalidUtf8)
}

fn bounded_directory_entries(
    path: &Path,
    limit: usize,
    collector: &mut InventoryCollector,
    warning_prefix: &str,
) -> Vec<fs::DirEntry> {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return Vec::new();
    };
    if crate::is_link_like(&metadata.file_type()) || !metadata.is_dir() {
        collector.warn(&format!("{warning_prefix}-link-or-invalid"));
        return Vec::new();
    }
    let Ok(read_dir) = fs::read_dir(path) else {
        collector.warn(&format!("{warning_prefix}-unreadable"));
        return Vec::new();
    };
    let mut entries = Vec::new();
    for entry in read_dir {
        if entries.len() >= limit {
            collector.warn(&format!("{warning_prefix}-limit-reached"));
            break;
        }
        if let Ok(entry) = entry {
            entries.push(entry);
        }
    }
    entries
}

fn provider_root_available(
    root: &Path,
    collector: &mut InventoryCollector,
    warning_prefix: &str,
) -> bool {
    match fs::symlink_metadata(root) {
        Ok(metadata) if metadata.is_dir() && !crate::is_link_like(&metadata.file_type()) => true,
        Ok(_) => {
            collector.warn(&format!("{warning_prefix}-link-or-invalid"));
            false
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => {
            collector.warn(&format!("{warning_prefix}-unreadable"));
            false
        }
    }
}

fn safe_directory(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.is_dir() && !crate::is_link_like(&metadata.file_type()))
}

fn safe_skill_directory(path: &Path) -> bool {
    if !safe_directory(path) {
        return false;
    }
    fs::symlink_metadata(path.join("SKILL.md")).is_ok_and(|metadata| {
        metadata.is_file()
            && metadata.len() <= MAX_CONFIG_BYTES
            && !crate::is_link_like(&metadata.file_type())
    })
}

fn regular_nonempty_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| {
        metadata.is_file()
            && metadata.len() > 0
            && metadata.len() <= MAX_CONFIG_BYTES
            && !crate::is_link_like(&metadata.file_type())
    })
}

fn command_output_limited(program: &str, args: &[&str]) -> Option<Vec<u8>> {
    let mut command = child_command(program);
    let mut child = command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let read_ok = stdout
            .take(MAX_CLI_OUTPUT_BYTES + 1)
            .read_to_end(&mut bytes)
            .is_ok();
        (read_ok, bytes)
    });
    let status = wait_for_child(&mut child, LIST_COMMAND_TIMEOUT);
    let (read_ok, bytes) = reader.join().ok()?;
    status
        .filter(|status| status.success())
        .filter(|_| read_ok && bytes.len() as u64 <= MAX_CLI_OUTPUT_BYTES)
        .map(|_| bytes)
}

fn command_status(program: &str, args: &[&str]) -> bool {
    let mut command = child_command(program);
    let Ok(mut child) = command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    wait_for_child(&mut child, APPLY_COMMAND_TIMEOUT).is_some_and(|status| status.success())
}

fn wait_for_child(
    child: &mut std::process::Child,
    timeout: Duration,
) -> Option<std::process::ExitStatus> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            Ok(None) | Err(_) => {
                terminate_child_tree(child);
                return None;
            }
        }
    }
}

fn child_command(program: &str) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(CREATE_NEW_PROCESS_GROUP);
    }
    command
}

#[cfg(windows)]
fn terminate_child_tree(child: &mut std::process::Child) {
    let pid = child.id().to_string();
    let mut taskkill = Command::new("taskkill")
        .args(["/PID", &pid, "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok();
    if let Some(killer) = taskkill.as_mut() {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match killer.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(25));
                }
                Ok(None) | Err(_) => {
                    let _ = killer.kill();
                    let _ = killer.wait();
                    break;
                }
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(not(windows))]
fn terminate_child_tree(child: &mut std::process::Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn split_plugin_selector(selector: &str) -> Option<(&str, &str)> {
    if selector.len() > MAX_LABEL_BYTES {
        return None;
    }
    let mut parts = selector.split('@');
    let name = parts.next()?;
    let marketplace = parts.next()?;
    if parts.next().is_some()
        || !valid_selector_component(name)
        || !valid_selector_component(marketplace)
    {
        return None;
    }
    Some((name, marketplace))
}

fn valid_plugin_key(provider: &str, key: &str) -> bool {
    match provider {
        "codex" | "claude" => split_plugin_selector(key).is_some(),
        "gemini" => valid_selector_component(key),
        _ => false,
    }
}

fn valid_selector_component(value: &str) -> bool {
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    value.len() <= MAX_LABEL_BYTES
        && first.is_ascii_alphanumeric()
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn safe_label(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_bytes
        && value != "."
        && value != ".."
        && !value.chars().any(|character| {
            character.is_control() || matches!(character, '/' | '\\' | '<' | '>' | '|' | '"')
        })
}

fn safe_version(version: Option<String>) -> Option<String> {
    version.filter(|value| safe_label(value, MAX_VERSION_BYTES))
}

fn transport_from_toml(config: &toml::map::Map<String, toml::Value>) -> String {
    config
        .get("type")
        .and_then(toml::Value::as_str)
        .and_then(normalize_transport)
        .or_else(|| config.contains_key("url").then(|| "http".to_owned()))
        .or_else(|| config.contains_key("command").then(|| "stdio".to_owned()))
        .unwrap_or_else(|| "unknown".to_owned())
}

fn transport_from_json(config: &serde_json::Map<String, JsonValue>) -> String {
    config
        .get("type")
        .and_then(JsonValue::as_str)
        .and_then(normalize_transport)
        .or_else(|| config.contains_key("url").then(|| "http".to_owned()))
        .or_else(|| config.contains_key("command").then(|| "stdio".to_owned()))
        .unwrap_or_else(|| "unknown".to_owned())
}

fn normalize_transport(value: &str) -> Option<String> {
    match value.to_ascii_lowercase().as_str() {
        "stdio" => Some("stdio".to_owned()),
        "http" | "streamable-http" => Some("http".to_owned()),
        "sse" => Some("sse".to_owned()),
        _ => None,
    }
}

fn toml_has_secret_references(value: &toml::Value, depth: usize) -> bool {
    if depth > 5 {
        return false;
    }
    match value {
        toml::Value::Table(table) => table.iter().any(|(key, child)| {
            (secret_field_name(key) && value_present_toml(child))
                || toml_has_secret_references(child, depth + 1)
        }),
        toml::Value::Array(values) => values
            .iter()
            .any(|child| toml_has_secret_references(child, depth + 1)),
        _ => false,
    }
}

fn json_has_secret_references(value: &JsonValue, depth: usize) -> bool {
    if depth > 5 {
        return false;
    }
    match value {
        JsonValue::Object(object) => object.iter().any(|(key, child)| {
            (secret_field_name(key) && value_present_json(child))
                || json_has_secret_references(child, depth + 1)
        }),
        JsonValue::Array(values) => values
            .iter()
            .any(|child| json_has_secret_references(child, depth + 1)),
        _ => false,
    }
}

fn secret_field_name(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    key == "env"
        || key.contains("token")
        || key.contains("secret")
        || key.contains("password")
        || key.contains("authorization")
        || key.contains("header")
        || key.contains("cookie")
        || key.contains("api_key")
        || key.contains("apikey")
}

fn value_present_toml(value: &toml::Value) -> bool {
    match value {
        toml::Value::String(value) => !value.is_empty(),
        toml::Value::Array(value) => !value.is_empty(),
        toml::Value::Table(value) => !value.is_empty(),
        _ => true,
    }
}

fn value_present_json(value: &JsonValue) -> bool {
    match value {
        JsonValue::Null => false,
        JsonValue::String(value) => !value.is_empty(),
        JsonValue::Array(value) => !value.is_empty(),
        JsonValue::Object(value) => !value.is_empty(),
        _ => true,
    }
}

fn toml_has_local_path(config: &toml::map::Map<String, toml::Value>) -> bool {
    config
        .get("command")
        .and_then(toml::Value::as_str)
        .is_some_and(looks_like_absolute_path)
        || config
            .get("args")
            .and_then(toml::Value::as_array)
            .is_some_and(|values| {
                values
                    .iter()
                    .filter_map(toml::Value::as_str)
                    .any(looks_like_absolute_path)
            })
}

fn json_has_local_path(config: &serde_json::Map<String, JsonValue>) -> bool {
    config
        .get("command")
        .and_then(JsonValue::as_str)
        .is_some_and(looks_like_absolute_path)
        || config
            .get("args")
            .and_then(JsonValue::as_array)
            .is_some_and(|values| {
                values
                    .iter()
                    .filter_map(JsonValue::as_str)
                    .any(looks_like_absolute_path)
            })
}

fn toml_has_secret_arguments(config: &toml::map::Map<String, toml::Value>) -> bool {
    config
        .get("args")
        .and_then(toml::Value::as_array)
        .is_some_and(|values| {
            arguments_contain_secret_flag(values.iter().filter_map(toml::Value::as_str))
        })
}

fn json_has_secret_arguments(config: &serde_json::Map<String, JsonValue>) -> bool {
    config
        .get("args")
        .and_then(JsonValue::as_array)
        .is_some_and(|values| {
            arguments_contain_secret_flag(values.iter().filter_map(JsonValue::as_str))
        })
}

fn arguments_contain_secret_flag<'a>(arguments: impl Iterator<Item = &'a str>) -> bool {
    arguments.into_iter().any(|argument| {
        let normalized = argument
            .trim()
            .trim_start_matches('-')
            .split_once('=')
            .map_or_else(|| argument.trim().trim_start_matches('-'), |(name, _)| name)
            .to_ascii_lowercase();
        matches!(
            normalized.as_str(),
            "h" | "header"
                | "token"
                | "api-key"
                | "api_key"
                | "apikey"
                | "secret"
                | "password"
                | "authorization"
                | "auth-token"
                | "access-token"
                | "bearer"
                | "cookie"
        )
    })
}

fn looks_like_absolute_path(value: &str) -> bool {
    Path::new(value).is_absolute()
        || value.starts_with("\\\\")
        || value
            .as_bytes()
            .get(1..3)
            .is_some_and(|bytes| bytes == b":\\" || bytes == b":/")
}

fn string_set(value: Option<&JsonValue>) -> BTreeSet<String> {
    value
        .and_then(JsonValue::as_array)
        .into_iter()
        .flatten()
        .filter_map(JsonValue::as_str)
        .filter(|value| safe_label(value, MAX_LABEL_BYTES))
        .map(|value| value.trim().to_lowercase())
        .collect()
}

fn mcp_is_disabled(disabled: &BTreeSet<String>, name: &str) -> bool {
    let normalized = name.trim().to_lowercase();
    disabled.contains(&normalized)
        || disabled.iter().any(|value| {
            value
                .strip_prefix("ext:")
                .is_some_and(|value| value.ends_with(&format!(":{normalized}")))
        })
}

fn marketplace_source(marketplace: &str) -> &'static str {
    if marketplace == "openai-bundled" || marketplace == "openai-primary-runtime" {
        "bundled"
    } else {
        "marketplace"
    }
}

fn config_warning(prefix: &str, error: SafeReadError) -> &'static str {
    match (prefix, error) {
        ("codex", SafeReadError::Link) => "codex-config-link-skipped",
        ("codex", SafeReadError::TooLarge) => "codex-config-too-large",
        ("codex", _) => "codex-config-unreadable",
        (_, SafeReadError::Link) => "config-link-skipped",
        (_, SafeReadError::TooLarge) => "config-too-large",
        _ => "config-unreadable",
    }
}

fn user_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn codex_program() -> &'static str {
    "codex"
}

#[cfg(windows)]
fn claude_program() -> &'static str {
    "claude.cmd"
}

#[cfg(not(windows))]
fn claude_program() -> &'static str {
    "claude"
}

#[cfg(windows)]
fn gemini_program() -> &'static str {
    "gemini.cmd"
}

#[cfg(not(windows))]
fn gemini_program() -> &'static str {
    "gemini"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_json_parser_drops_paths_urls_and_unknown_secret_fields() {
        let input = br#"{
          "installed": [{
            "pluginId": "sample@market",
            "name": "sample",
            "marketplaceName": "market",
            "version": "1.2.3",
            "installed": true,
            "enabled": true,
            "source": {"path": "C:\\private\\plugin"},
            "marketplaceSource": {"source": "https://secret.invalid/repo"},
            "token": "do-not-export"
          }]
        }"#;
        let items = parse_codex_plugin_list(input).expect("valid plugin list");
        let serialized = serde_json::to_string(&items).expect("serialize inventory");
        assert_eq!(items.len(), 1);
        assert!(serialized.contains("sample@market"));
        assert!(!serialized.contains("private"));
        assert!(!serialized.contains("secret.invalid"));
        assert!(!serialized.contains("do-not-export"));
        assert!(!serialized.contains("source.path"));
    }

    #[test]
    fn codex_config_fallback_trusts_only_a_single_cached_version() {
        let root = temporary_directory("codex-fallback-cache");
        let cache_root = root.join("cache");
        for (plugin, version, skill) in [
            ("stable", "1.0.0", "stable-skill"),
            ("ambiguous", "1.0.0", "old-skill"),
            ("ambiguous", "2.0.0", "new-skill"),
        ] {
            let version_root = cache_root.join("market").join(plugin).join(version);
            let manifest_root = version_root.join(".codex-plugin");
            let skill_root = version_root.join("skills").join(skill);
            fs::create_dir_all(&manifest_root).expect("create Codex plugin manifest fixture");
            fs::create_dir_all(&skill_root).expect("create Codex plugin skill fixture");
            fs::write(
                manifest_root.join("plugin.json"),
                format!(r#"{{"name":"{plugin}","version":"{version}"}}"#),
            )
            .expect("write Codex plugin manifest fixture");
            fs::write(skill_root.join("SKILL.md"), b"private skill body")
                .expect("write Codex plugin skill fixture");
        }

        let config = toml::from_str::<toml::Value>(
            r#"
                [plugins."stable@market"]
                enabled = true

                [plugins."ambiguous@market"]
                enabled = true
            "#,
        )
        .expect("valid Codex fallback config");
        let mut collector = InventoryCollector::default();
        collect_codex_plugins_from_config(&config, &cache_root, &mut collector);
        collect_codex_cached_plugin_skills(&cache_root, &mut collector);
        let inventory = collector.finish();

        let stable = inventory
            .items
            .iter()
            .find(|item| item.kind == "plugin" && item.key == "stable@market")
            .expect("stable plugin inventory");
        let ambiguous = inventory
            .items
            .iter()
            .find(|item| item.kind == "plugin" && item.key == "ambiguous@market")
            .expect("ambiguous plugin inventory");
        assert_eq!(stable.version.as_deref(), Some("1.0.0"));
        assert_eq!(ambiguous.version, None);
        assert!(inventory
            .items
            .iter()
            .any(|item| item.key == "stable@market:stable-skill"));
        assert!(!inventory
            .items
            .iter()
            .any(|item| item.key.starts_with("ambiguous@market:")));
        assert!(inventory
            .warnings
            .contains(&"codex-plugin-skill-version-unknown".to_owned()));
        fs::remove_dir_all(root).expect("remove temporary directory");
    }

    #[test]
    fn mcp_inventory_exposes_only_safe_metadata() {
        let value: JsonValue = serde_json::from_str(
            r#"{"server":{"type":"stdio","command":"C:\\private\\server.exe","args":["--token","hidden"],"env":{"API_TOKEN":"very-secret"}}}"#,
        )
        .expect("valid json");
        let mut collector = InventoryCollector::default();
        collect_json_mcp_table("claude", &value, "project", None, &mut collector);
        let inventory = collector.finish();
        let serialized = serde_json::to_string(&inventory).expect("serialize inventory");
        assert_eq!(inventory.items.len(), 1);
        assert!(inventory.items[0].has_secrets);
        assert_eq!(inventory.items[0].blocked_reason.as_deref(), Some("secret"));
        assert!(!serialized.contains("private"));
        assert!(!serialized.contains("very-secret"));
        assert!(!serialized.contains("API_TOKEN"));
        assert!(!serialized.contains("--token"));
    }

    #[test]
    fn mcp_secret_flags_are_detected_without_environment_fields() {
        let value: JsonValue = serde_json::from_str(
            r#"{"server":{"command":"npx","args":["package-name","--api-key","do-not-export"]}}"#,
        )
        .expect("valid json");
        let mut collector = InventoryCollector::default();
        collect_json_mcp_table("codex", &value, "user", None, &mut collector);
        let inventory = collector.finish();
        assert!(inventory.items[0].has_secrets);
        assert_eq!(inventory.items[0].blocked_reason.as_deref(), Some("secret"));
        assert!(!serde_json::to_string(&inventory)
            .expect("serialize inventory")
            .contains("do-not-export"));
    }

    #[test]
    fn plugin_selector_rejects_flags_paths_and_shell_metacharacters() {
        assert!(valid_plugin_key("codex", "sample@market-place"));
        assert!(valid_plugin_key("gemini", "sample.extension"));
        for selector in [
            "--help@market",
            "sample",
            "sample@market@extra",
            "sample/child@market",
            "sample@market&whoami",
            "sample@..",
            "sample@market place",
        ] {
            assert!(!valid_plugin_key("codex", selector), "{selector}");
        }
        assert!(!valid_plugin_key("gemini", "--help"));
        assert!(!valid_plugin_key("gemini", "name&whoami"));
    }

    #[test]
    fn claude_plugin_json_uses_settings_and_installed_manifest_without_paths() {
        let settings: JsonValue =
            serde_json::from_str(r#"{"enabledPlugins":{"tool@market":true}}"#)
                .expect("valid settings");
        let installed: JsonValue = serde_json::from_str(
            r#"{"plugins":{"tool@market":[{"version":"2.0.0","path":"C:\\private\\tool"}]}}"#,
        )
        .expect("valid installed plugins");
        let mut collector = InventoryCollector::default();
        collect_claude_plugins(Some(&settings), Some(&installed), &mut collector);
        let inventory = collector.finish();
        let serialized = serde_json::to_string(&inventory).expect("serialize inventory");
        assert_eq!(inventory.items[0].version.as_deref(), Some("2.0.0"));
        assert!(inventory.items[0].enabled);
        assert!(inventory.items[0].installed);
        assert!(!serialized.contains("private"));
    }

    #[test]
    fn claude_plugin_json_accepts_object_shaped_install_record() {
        let installed: JsonValue = serde_json::from_str(
            r#"{"plugins":{"tool@market":{"version":"3.1.4","path":"C:\\private\\tool"}}}"#,
        )
        .expect("valid installed plugins");
        let mut collector = InventoryCollector::default();
        collect_claude_plugins(None, Some(&installed), &mut collector);
        let inventory = collector.finish();
        let serialized = serde_json::to_string(&inventory).expect("serialize inventory");
        assert_eq!(inventory.items[0].version.as_deref(), Some("3.1.4"));
        assert!(!serialized.contains("private"));
    }

    #[test]
    fn plugin_skill_inventory_uses_combined_key_without_reading_body() {
        let root = temporary_directory("plugin-skills");
        let skill = root.join("skills").join("review");
        fs::create_dir_all(&skill).expect("create skill fixture");
        fs::write(
            skill.join("SKILL.md"),
            b"---\nname: review\n---\nAPI_TOKEN=do-not-export\nC:\\private\\path\n",
        )
        .expect("write skill fixture");
        let mut collector = InventoryCollector::default();
        collect_plugin_skill_root(
            "codex",
            "plugin@market",
            &root.join("skills"),
            Some("1.0.0"),
            true,
            true,
            "marketplace",
            &mut collector,
            "test-plugin-skills",
        );
        let inventory = collector.finish();
        let serialized = serde_json::to_string(&inventory).expect("serialize inventory");
        assert_eq!(inventory.items[0].key, "plugin@market:review");
        assert_eq!(inventory.items[0].display_name, "review");
        assert!(!serialized.contains("do-not-export"));
        assert!(!serialized.contains("private"));

        let mut too_long = InventoryCollector::default();
        collect_plugin_skill_root(
            "codex",
            &"p".repeat(125),
            &root.join("skills"),
            Some("1.0.0"),
            true,
            true,
            "marketplace",
            &mut too_long,
            "test-plugin-skills",
        );
        assert!(too_long.items.is_empty());
        assert!(too_long.warnings.contains("plugin-skill-key-too-long"));
        fs::remove_dir_all(root).expect("remove temporary directory");
    }

    #[test]
    fn provider_plugin_layouts_collect_internal_skill_names() {
        let root = temporary_directory("provider-plugin-skills");
        let codex_cache = root.join("codex-cache");
        let codex_skill = codex_cache
            .join("market")
            .join("tool")
            .join("1.0.0")
            .join("skills")
            .join("codex-skill");
        fs::create_dir_all(&codex_skill).expect("create Codex skill fixture");
        fs::write(codex_skill.join("SKILL.md"), b"secret body").expect("write Codex skill");
        let old_codex_skill = codex_cache
            .join("market")
            .join("tool")
            .join("0.9.0")
            .join("skills")
            .join("old-skill");
        fs::create_dir_all(&old_codex_skill).expect("create old Codex skill fixture");
        fs::write(old_codex_skill.join("SKILL.md"), b"old secret body")
            .expect("write old Codex skill");

        let claude_data = root.join("claude-data");
        let claude_plugin = claude_data.join("tool-market").join("market");
        let claude_skill = claude_plugin.join("skills").join("claude-skill");
        fs::create_dir_all(claude_plugin.join(".claude-plugin"))
            .expect("create Claude manifest directory");
        fs::create_dir_all(&claude_skill).expect("create Claude skill fixture");
        fs::write(
            claude_plugin.join(".claude-plugin").join("plugin.json"),
            br#"{"name":"tool","version":"1.0.0"}"#,
        )
        .expect("write Claude manifest");
        fs::write(claude_skill.join("SKILL.md"), b"secret body").expect("write Claude skill");

        let gemini_extensions = root.join("gemini-extensions");
        let gemini_plugin = gemini_extensions.join("tool");
        let gemini_skill = gemini_plugin.join("skills").join("gemini-skill");
        fs::create_dir_all(&gemini_skill).expect("create Gemini skill fixture");
        fs::write(
            gemini_plugin.join("gemini-extension.json"),
            br#"{"name":"tool","version":"1.0.0"}"#,
        )
        .expect("write Gemini manifest");
        fs::write(gemini_skill.join("SKILL.md"), b"secret body").expect("write Gemini skill");

        let mut collector = InventoryCollector::default();
        for provider in ["codex", "claude"] {
            collector.insert(DeviceInventoryItem {
                provider: provider.to_owned(),
                kind: "plugin".to_owned(),
                key: "tool@market".to_owned(),
                display_name: "tool".to_owned(),
                version: Some("1.0.0".to_owned()),
                enabled: true,
                installed: true,
                source: "marketplace".to_owned(),
                marketplace: Some("market".to_owned()),
                transport: None,
                has_secrets: false,
                transferable: true,
                blocked_reason: None,
            });
        }
        collect_codex_cached_plugin_skills(&codex_cache, &mut collector);
        let claude_installed = serde_json::json!({
            "plugins": {
                "tool@market": [{
                    "version": "1.0.0",
                    "path": claude_plugin.to_string_lossy()
                }]
            }
        });
        collect_claude_plugin_skills(&claude_data, Some(&claude_installed), &mut collector);
        collect_gemini_extensions(&gemini_extensions, &BTreeSet::new(), &mut collector);

        let inventory = collector.finish();
        let keys: BTreeSet<_> = inventory
            .items
            .iter()
            .map(|item| item.key.as_str())
            .collect();
        assert!(keys.contains("tool@market:codex-skill"));
        assert!(keys.contains("tool@market:claude-skill"));
        assert!(keys.contains("tool:gemini-skill"));
        assert!(!keys.contains("tool@market:old-skill"));
        assert!(!serde_json::to_string(&inventory)
            .expect("serialize inventory")
            .contains("secret body"));
        fs::remove_dir_all(root).expect("remove temporary directory");
    }

    #[test]
    fn gemini_enablement_reads_only_the_last_boolean_direction() {
        let enabled: JsonValue =
            serde_json::from_str(r#"{"tool":{"overrides":["/home/*","!/home/*"]}}"#)
                .expect("valid enablement");
        assert!(!gemini_extension_enabled(Some(&enabled), "tool"));
        assert!(gemini_extension_enabled(Some(&enabled), "missing"));
    }

    #[test]
    fn gemini_mcp_enablement_normalizes_names_without_exporting_file_content() {
        let enablement: JsonValue = serde_json::from_str(
            r#"{"EXT:Tool:Server":{"enabled":false,"token":"do-not-export"}}"#,
        )
        .expect("valid mcp enablement");
        let disabled = gemini_disabled_mcp_servers(Some(&enablement));
        assert!(mcp_is_disabled(&disabled, "server"));
        assert!(!disabled.iter().any(|value| value.contains("do-not-export")));
    }

    #[test]
    fn apply_results_use_the_frontend_status_contract() {
        let item = DeviceInventoryItem {
            provider: "codex".to_owned(),
            kind: "skill".to_owned(),
            key: "review".to_owned(),
            display_name: "review".to_owned(),
            version: None,
            enabled: true,
            installed: true,
            source: "user".to_owned(),
            marketplace: None,
            transport: None,
            has_secrets: false,
            transferable: false,
            blocked_reason: Some("unsupported".to_owned()),
        };
        let result = apply_item(item, &BTreeMap::new());
        assert_eq!(result.status, "manual");

        let invalid = DeviceInventoryItem {
            provider: "codex".to_owned(),
            kind: "plugin".to_owned(),
            key: "--help@market".to_owned(),
            display_name: "invalid".to_owned(),
            version: None,
            enabled: true,
            installed: true,
            source: "marketplace".to_owned(),
            marketplace: Some("market".to_owned()),
            transport: None,
            has_secrets: false,
            transferable: true,
            blocked_reason: None,
        };
        assert_eq!(apply_item(invalid, &BTreeMap::new()).status, "failed");

        let safe_recipe = DeviceInventoryItem {
            provider: "codex".to_owned(),
            kind: "plugin".to_owned(),
            key: "tool@market".to_owned(),
            display_name: "tool".to_owned(),
            version: Some("1.0.0".to_owned()),
            enabled: true,
            installed: true,
            source: "marketplace".to_owned(),
            marketplace: Some("market".to_owned()),
            transport: None,
            has_secrets: false,
            transferable: true,
            blocked_reason: None,
        };
        let calls = std::cell::Cell::new(0usize);
        for malicious in [
            DeviceInventoryItem {
                transferable: false,
                ..safe_recipe.clone()
            },
            DeviceInventoryItem {
                has_secrets: true,
                ..safe_recipe.clone()
            },
            DeviceInventoryItem {
                blocked_reason: Some("secret".to_owned()),
                ..safe_recipe.clone()
            },
            DeviceInventoryItem {
                source: "user".to_owned(),
                ..safe_recipe.clone()
            },
            DeviceInventoryItem {
                marketplace: Some("other".to_owned()),
                ..safe_recipe.clone()
            },
        ] {
            let result = apply_item_with_command(malicious, &BTreeMap::new(), |_, _| {
                calls.set(calls.get() + 1);
                true
            });
            assert_eq!(result.status, "failed");
            assert_eq!(result.message, "설정 항목의 안전 조건을 확인할 수 없습니다");
        }
        assert_eq!(calls.get(), 0);

        let result = apply_item_with_command(safe_recipe, &BTreeMap::new(), |_, _| {
            calls.set(calls.get() + 1);
            true
        });
        assert_eq!(result.status, "applied");
        assert_eq!(calls.get(), 1);

        let gemini_recipe = DeviceInventoryItem {
            provider: "gemini".to_owned(),
            kind: "plugin".to_owned(),
            key: "tool".to_owned(),
            display_name: "tool".to_owned(),
            version: Some("1.0.0".to_owned()),
            enabled: true,
            installed: true,
            source: "user".to_owned(),
            marketplace: None,
            transport: None,
            has_secrets: false,
            transferable: false,
            blocked_reason: None,
        };
        let mut local_plugins = BTreeMap::new();
        local_plugins.insert(
            ("gemini".to_owned(), "tool".to_owned()),
            DeviceInventoryItem {
                enabled: false,
                ..gemini_recipe.clone()
            },
        );
        let malicious_gemini = DeviceInventoryItem {
            has_secrets: true,
            ..gemini_recipe.clone()
        };
        assert_eq!(
            apply_item_with_command(malicious_gemini, &local_plugins, |_, _| {
                calls.set(calls.get() + 1);
                true
            })
            .status,
            "failed"
        );
        assert_eq!(calls.get(), 1);
        assert_eq!(
            apply_item_with_command(gemini_recipe, &local_plugins, |_, _| {
                calls.set(calls.get() + 1);
                true
            })
            .status,
            "applied"
        );
        assert_eq!(calls.get(), 2);
    }

    #[test]
    fn bounded_reader_and_directory_enforce_limits() {
        let root = temporary_directory("limits");
        fs::create_dir_all(&root).expect("create temporary directory");
        fs::write(root.join("large.json"), b"12345").expect("write fixture");
        assert_eq!(
            read_limited_string(&root.join("large.json"), 4),
            Err(SafeReadError::TooLarge)
        );
        for name in ["one", "two", "three"] {
            fs::create_dir(root.join(name)).expect("create fixture directory");
        }
        let mut collector = InventoryCollector::default();
        let entries = bounded_directory_entries(&root, 2, &mut collector, "test-directory");
        assert_eq!(entries.len(), 2);
        assert!(collector.warnings.contains("test-directory-limit-reached"));
        fs::remove_dir_all(root).expect("remove temporary directory");
    }

    #[test]
    fn linked_skill_directory_is_not_collected_when_link_creation_is_available() {
        let root = temporary_directory("links");
        let target = root.join("target");
        let skills = root.join("skills");
        fs::create_dir_all(&target).expect("create target");
        fs::create_dir_all(&skills).expect("create skills");
        fs::write(target.join("SKILL.md"), b"---\nname: linked\n---\n").expect("write manifest");
        let link = skills.join("linked");
        if create_directory_link(&target, &link).is_ok() {
            let mut collector = InventoryCollector::default();
            collect_skill_root("codex", &skills, "user", &mut collector, "test-skills");
            assert!(collector.items.is_empty());
        }
        fs::remove_dir_all(root).expect("remove temporary directory");
    }

    #[test]
    fn linked_provider_root_is_not_scanned_when_link_creation_is_available() {
        let root = temporary_directory("provider-link");
        let home = root.join("home");
        let target = root.join("target");
        fs::create_dir_all(&home).expect("create home fixture");
        fs::create_dir_all(target.join("skills").join("hidden")).expect("create target fixture");
        fs::write(
            target.join("skills").join("hidden").join("SKILL.md"),
            b"---\nname: hidden\n---\n",
        )
        .expect("write target manifest");
        if create_directory_link(&target, &home.join(".codex")).is_ok() {
            let mut collector = InventoryCollector::default();
            collect_codex(&home, Some(Vec::new()), &mut collector);
            assert!(collector.items.is_empty());
            assert!(collector.warnings.contains("codex-root-link-or-invalid"));
        }
        fs::remove_dir_all(root).expect("remove temporary directory");
    }

    fn temporary_directory(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "token-deck-inventory-{label}-{}-{}",
            std::process::id(),
            now_millis()
        ))
    }

    #[cfg(windows)]
    fn create_directory_link(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_dir(target, link)
    }

    #[cfg(unix)]
    fn create_directory_link(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }
}
