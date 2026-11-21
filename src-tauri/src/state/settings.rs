//! 设置读写（对齐 electron/services/settingsStore.ts）。
//! 纯文件系统，目录由调用方注入，便于单测隔离。

use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

use crate::types::*;

pub fn settings_path(dir: &Path) -> std::path::PathBuf {
    dir.join("settings.json")
}

fn clamp_int(value: Option<&Value>, min: i64, max: i64, fallback: i64) -> i64 {
    match value.and_then(Value::as_i64) {
        Some(v) => v.clamp(min, max),
        None => fallback,
    }
}

/// 逐字段校验：白名单外/缺字段/类型不对一律回落默认值（旧文件升级保留其余字段）。
pub fn normalize_settings(raw: &Value) -> AppSettings {
    let defaults = default_settings();
    let obj = raw.as_object();
    let get = |key: &str| obj.and_then(|o| o.get(key));
    AppSettings {
        appearance: get("appearance")
            .and_then(Value::as_str)
            .filter(|s| THEME_MODES.contains(s))
            .unwrap_or(&defaults.appearance)
            .to_string(),
        sidebar_width: clamp_int(
            get("sidebarWidth"),
            SIDEBAR_MIN_WIDTH,
            SIDEBAR_MAX_WIDTH,
            defaults.sidebar_width,
        ),
        library_root: get("libraryRoot")
            .and_then(Value::as_str)
            .unwrap_or(&defaults.library_root)
            .to_string(),
        preload_count: clamp_int(
            get("preloadCount"),
            PRELOAD_MIN_COUNT,
            PRELOAD_MAX_COUNT,
            defaults.preload_count,
        ),
        close_button_always_visible: get("closeButtonAlwaysVisible")
            .and_then(Value::as_bool)
            .unwrap_or(defaults.close_button_always_visible),
        // 字体与字号是固定单选：白名单外一律回落默认，不做区间夹取
        reader_font: get("readerFont")
            .and_then(Value::as_str)
            .filter(|s| READER_FONTS.iter().any(|(key, _)| key == s))
            .unwrap_or(&defaults.reader_font)
            .to_string(),
        reader_font_size: get("readerFontSize")
            .and_then(Value::as_i64)
            .filter(|s| READER_FONT_SIZES.contains(s))
            .unwrap_or(defaults.reader_font_size),
    }
}

/// 文件缺失或 JSON 损坏都回落默认值，不让坏配置阻断启动。
pub fn read_settings(dir: &Path) -> AppSettings {
    match fs::read_to_string(settings_path(dir)) {
        Ok(text) => serde_json::from_str::<Value>(&text)
            .map(|v| normalize_settings(&v))
            .unwrap_or_else(|_| default_settings()),
        Err(_) => default_settings(),
    }
}

/// 临时文件 + rename 原子替换（与文本保存同款，中断不留半截 JSON）。
pub fn write_settings(dir: &Path, settings: &AppSettings) -> Result<AppSettings, String> {
    let next = normalize_settings(&serde_json::to_value(settings).map_err(|e| e.to_string())?);
    fs::create_dir_all(dir).map_err(|e| format!("创建设置目录失败: {e}"))?;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = dir.join(format!(".{}-{nanos}.settings-tmp", std::process::id()));
    let body = serde_json::to_string_pretty(&next).map_err(|e| e.to_string())?;
    fs::write(&tmp, format!("{body}\n"))
        .and_then(|_| fs::rename(&tmp, settings_path(dir)))
        .map_err(|e| format!("写入设置失败: {e}"))?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "yueduo-settings-{}-{}",
            tag,
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn settings_normalize_clamps_and_whitelists() {
        let raw = serde_json::json!({
            "appearance": "neon",
            "sidebarWidth": 99999,
            "preloadCount": -5,
            "libraryRoot": "/books",
            "closeButtonAlwaysVisible": "yes",
            "readerFont": "comic-sans",
            "readerFontSize": 15.5,
            "rules": [{ "ignored": true }]
        });
        let s = normalize_settings(&raw);
        assert_eq!(s.appearance, "system");
        assert_eq!(s.sidebar_width, SIDEBAR_MAX_WIDTH);
        assert_eq!(s.preload_count, PRELOAD_MIN_COUNT);
        assert_eq!(s.library_root, "/books");
        // 非法类型回落默认值 true（与 TS 版 DEFAULT_SETTINGS 一致）
        assert!(s.close_button_always_visible);
        assert_eq!(s.reader_font, "pingfang");
        assert_eq!(s.reader_font_size, 15);
    }

    #[test]
    fn settings_write_read_roundtrip() {
        let dir = temp_dir("roundtrip");
        let mut s = default_settings();
        s.appearance = "dark".into();
        s.sidebar_width = 320;
        let written = write_settings(&dir, &s).unwrap();
        assert_eq!(written.appearance, "dark");
        assert_eq!(read_settings(&dir).sidebar_width, 320);
        fs::remove_dir_all(&dir).unwrap();
    }

    /// 默认值单一源（shared/defaultSettings.json）：解析结果与预期一致，
    /// 防止 JSON 字段改名/类型不对导致静默回落。
    #[test]
    fn default_settings_from_shared_json() {
        let s = default_settings();
        assert_eq!(s.appearance, "system");
        assert_eq!(s.sidebar_width, 240);
        assert_eq!(s.library_root, "");
        assert_eq!(s.preload_count, 4);
        assert!(s.close_button_always_visible);
        assert_eq!(s.reader_font, "pingfang");
        assert_eq!(s.reader_font_size, 15);
    }
}
