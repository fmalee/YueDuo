//! 每书库一个数据库 + 换库三步（对齐 electron/services/libraryDatabase.ts，方案 §2.13）：
//! - 首选 `<书库根>/yueduo.db`，随库搬迁；根目录不可写时回落
//!   `<app_data_dir>/library-db/<书库根 sha1 前 16 位>.db`（与 Electron 版同名回落文件一致）
//! - 换库顺序：open（建新库 + 读新会话，旧库不动）→ 渲染层存档旧会话 →
//!   activate（切活动库）→ 渲染层恢复新会话；中止/失败时 abort 只关新库，原库仍可用

use std::fs;
use std::path::{Path, PathBuf};

use sha1::{Digest, Sha1};

use super::db::open_database;
use super::session::load_session;
use super::{LibraryRuntime, StateInner};
use crate::types::LibraryOpenResult;

/// 书库根统一 realpath 后比较，且必须是目录（方案 §2.13 硬约束）。
pub fn resolve_library_root(root: &str) -> Result<PathBuf, String> {
    if root.trim().is_empty() {
        return Err("尚未设置书库根目录".into());
    }
    let resolved = fs::canonicalize(root).map_err(|_| format!("书库目录不存在：{root}"))?;
    if !resolved.is_dir() {
        return Err(format!("书库路径不是目录：{}", resolved.display()));
    }
    Ok(resolved)
}

/// 回落库文件名：按书库根 realpath 的 sha1 前 16 位隔离（与 Electron 版同名回落文件一致）
fn fallback_file(user_data: &Path, root: &str) -> PathBuf {
    let hash = Sha1::digest(root.as_bytes());
    let prefix: String = hash.iter().take(8).map(|b| format!("{b:02x}")).collect();
    user_data.join("library-db").join(format!("{prefix}.db"))
}

/// 建库失败时只清理本次新建的半成品，绝不删除用户原有的数据库。
fn remove_partial(file: &Path) {
    for suffix in ["", "-wal", "-shm"] {
        let _ = fs::remove_file(format!("{}{suffix}", file.display()));
    }
}

/// 首选 `<书库根>/yueduo.db`，不可写时回落 app_data_dir（按库根隔离）。
pub fn open_at(root: &Path, user_data: &Path) -> Result<LibraryRuntime, String> {
    let primary = root.join("yueduo.db");
    let existed = primary.exists();
    match open_database(&primary) {
        Ok(db) => Ok(LibraryRuntime {
            root: root.to_string_lossy().to_string(),
            file: primary.to_string_lossy().to_string(),
            db,
            fallback: false,
        }),
        Err(e) => {
            if existed {
                return Err(e);
            }
            remove_partial(&primary);
            let file = fallback_file(user_data, &root.to_string_lossy());
            let db = open_database(&file).map_err(|e| format!("书库数据库创建失败：{e}"))?;
            Ok(LibraryRuntime {
                root: root.to_string_lossy().to_string(),
                file: file.to_string_lossy().to_string(),
                db,
                fallback: true,
            })
        }
    }
}

/// library:open —— 建新库并读出它的会话；同一书库直接返回 switched=false。
/// 新库只建连接与迁移，旧库在 activate 前保持活动（可以继续存档旧会话）。
pub(crate) fn prepare(
    inner: &mut StateInner,
    user_data: &Path,
    root: &str,
) -> Result<LibraryOpenResult, String> {
    // 先丢弃上一次未提交的准备结果（目录无效时也不会留下悬空连接）
    abort(inner);
    let resolved = resolve_library_root(root)?;
    let resolved_str = resolved.to_string_lossy().to_string();
    if let Some(active) = &inner.active {
        if active.root == resolved_str {
            return Ok(LibraryOpenResult {
                root: resolved_str,
                switched: false,
                session: None,
                fallback: active.fallback,
            });
        }
    }
    let runtime = open_at(&resolved, user_data)?;
    match load_session(&runtime.db, &runtime.root) {
        Ok(session) => {
            let result = LibraryOpenResult {
                root: runtime.root.clone(),
                switched: true,
                session: Some(session),
                fallback: runtime.fallback,
            };
            inner.pending = Some(runtime);
            Ok(result)
        }
        Err(e) => {
            let _ = runtime.db.close();
            Err(e)
        }
    }
}

/// library:activate —— 切活动库：先换引用再关旧连接；没有待切换库时抛错。
/// 该操作本身不失败（除无待切换库），换库的提交点是安全的。
pub(crate) fn commit(inner: &mut StateInner) -> Result<String, String> {
    let target = inner.pending.take().ok_or("没有待切换的书库")?;
    let previous = inner.active.replace(target);
    let root = inner
        .active
        .as_ref()
        .map(|r| r.root.clone())
        .unwrap_or_default();
    inner.startup_error.clear();
    if let Some(previous) = previous {
        // close 消费连接：成功返回 Ok(())，失败返回 (连接, 错误) 供降级处理
        if let Err((_, e)) = previous.db.close() {
            // 已切到新库，旧连接关不掉只影响文件句柄释放，不影响数据一致性
            eprintln!("[library] 旧数据库关闭失败: {e}");
        }
    }
    Ok(root)
}

/// library:abort —— 放弃待切换的新库（存档失败/用户取消时）；活动库不受影响
pub(crate) fn abort(inner: &mut StateInner) {
    if let Some(runtime) = inner.pending.take() {
        let _ = runtime.db.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_file_matches_electron_sha1_prefix() {
        // Electron：sha1(realpath) 十六进制前 16 位 + '.db'；同名回落文件在搬家后应继续命中。
        // 基准值：sha1("/Users/Joey/Sites/Projects/小说") = eacbfff748c6637cdd010fe5ad0b465c3a23584c
        let dir = std::env::temp_dir().join(format!("yueduo-fallback-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = fallback_file(&dir, "/Users/Joey/Sites/Projects/小说");
        assert!(file
            .to_string_lossy()
            .ends_with("library-db/eacbfff748c6637c.db"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn prepare_commit_abort_roundtrip() {
        // 两个临时书库根 + 内存态 StateInner 验证三步事务
        let base = std::env::temp_dir().join(format!("yueduo-switch-{}", std::process::id()));
        let lib_a = base.join("书库A");
        let lib_b = base.join("书库B");
        fs::create_dir_all(&lib_a).unwrap();
        fs::create_dir_all(&lib_b).unwrap();
        let user_data = base.join("user-data");
        fs::create_dir_all(&user_data).unwrap();

        let mut inner = StateInner {
            settings: crate::types::default_settings(),
            active: None,
            pending: None,
            startup_error: String::new(),
            scan_cancel: Default::default(),
            enrich_generation: 0,
            enrich_job: None,
        };
        // 初始库 A（真实链路：resolve_library_root 先 realpath 再 open_at）
        let rt = open_at(
            &resolve_library_root(lib_a.to_str().unwrap()).unwrap(),
            &user_data,
        )
        .unwrap();
        inner.active = Some(rt);
        // macOS /var → /private/var 符号链接：统一 realpath 后比较
        let resolved_b = fs::canonicalize(&lib_b).unwrap().to_string_lossy().to_string();
        // 准备切到 B：建新库 + 读新会话（空会话），旧库仍活动
        let prepared = prepare(&mut inner, &user_data, lib_b.to_str().unwrap()).unwrap();
        assert!(prepared.switched);
        assert_eq!(prepared.root, resolved_b);
        assert!(prepared.session.unwrap().tabs.is_empty());
        assert_eq!(
            inner.active.as_ref().unwrap().root,
            fs::canonicalize(&lib_a).unwrap().to_string_lossy().to_string()
        );
        // abort：丢弃 pending，活动库仍是 A
        abort(&mut inner);
        assert!(inner.pending.is_none());
        assert_eq!(
            inner.active.as_ref().unwrap().root,
            fs::canonicalize(&lib_a).unwrap().to_string_lossy().to_string()
        );
        // 再次 prepare + commit：切到 B，A 关闭
        prepare(&mut inner, &user_data, lib_b.to_str().unwrap()).unwrap();
        let root = commit(&mut inner).unwrap();
        assert_eq!(root, resolved_b);
        assert_eq!(inner.active.as_ref().unwrap().root, resolved_b);
        // 同库重复 prepare：switched=false
        let again = prepare(&mut inner, &user_data, lib_b.to_str().unwrap()).unwrap();
        assert!(!again.switched);
        // commit 无 pending：报错
        assert!(commit(&mut inner).is_err());
        fs::remove_dir_all(&base).unwrap();
    }
}
