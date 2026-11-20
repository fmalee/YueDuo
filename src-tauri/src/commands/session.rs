//! session 域：会话 persist/restore/relocate + 退出握手回执。
//! persist/restore 读写 session_tabs/session_state；flushDone 是退出握手回执
//! （关窗/退出的 session:flush 推送在 P3 shell 落地，渲染层已按事件订阅）。

use tauri::State;

use crate::state::session as session_store;
use crate::state::AppState;
use crate::types::*;

#[tauri::command]
pub async fn session_persist(
    state: State<'_, AppState>,
    snapshot: SessionSnapshot,
) -> Result<(), String> {
    state
        .with_active_db(|db, root| session_store::persist_session(db, &snapshot, root))?;
    Ok(())
}

#[tauri::command]
pub async fn session_restore(state: State<'_, AppState>) -> Result<SessionRestore, String> {
    Ok(state
        .with_active_db(|db, root| session_store::load_session(db, root))?
        .unwrap_or(SessionRestore {
            active_tab_id: None,
            tabs: vec![],
        }))
}

/// 对账扫完后按 book_id 重连缺失标签（渲染层只传标签 id，路径判定在主进程）；
/// 只返回重新找到文件的标签
#[tauri::command]
pub async fn session_relocate(
    state: State<'_, AppState>,
    tab_ids: Vec<String>,
) -> Result<Vec<SessionRelocation>, String> {
    Ok(state
        .with_active_db(|db, root| session_store::relocate_session_tabs(db, root, &tab_ids))?
        .unwrap_or_default())
}

/// 退出握手回执：渲染层落盘完成，主进程可继续退出（P3 shell 消费）
#[tauri::command]
pub async fn session_flush_done() -> Result<(), String> {
    Ok(())
}
