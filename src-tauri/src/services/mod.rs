//! services：纯 Rust 业务，可单测、不依赖 tauri 类型（AGENTS.md 对应原 services/ 约束）。

pub mod codec;
pub mod convert;
pub mod files;
pub mod find_rules;
pub mod finder;
pub mod metadata;
pub mod metadata_writer;
pub mod reconcile;
pub mod scanner;
pub mod text;

/// Unix 毫秒时间戳（epoch 前回 0）：各仓储写 updated_at/last_read_at 的统一时钟
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
