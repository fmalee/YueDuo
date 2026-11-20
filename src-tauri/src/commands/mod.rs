//! 按域收敛 IPC 参数、调用 state/services，不写业务。
//! 命名：Rust fn 用 snake_case（即 command 名），参数名与 bridge.ts 的 camelCase key 自动对应。
//! 铁律：一律 async（跑在线程池，避免主线程阻塞死锁），错误统一 Result<T, String>。
//! 新增通道同步三处：本目录对应域文件、`src/ipc/bridge.ts`、`shared/types.ts`（Rust 侧镜像 `types.rs`）。

pub mod app;
pub mod dialog;
pub mod file;
pub mod library;
pub mod session;
pub mod settings;
