//! services：纯 Rust 业务，可单测、不依赖 tauri 类型（AGENTS.md 对应原 services/ 约束）。

pub mod codec;
pub mod convert;
pub mod files;
pub mod find_rules;
pub mod metadata;
pub mod metadata_writer;
pub mod reconcile;
pub mod scanner;
pub mod text;
