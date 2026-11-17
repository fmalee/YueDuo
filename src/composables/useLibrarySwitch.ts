import { chooseLibrary, libraryAbort, libraryActivate, libraryOpen } from '@/ipc/bridge'
import { useLibraryStore } from '@/stores/library'
import { useSettingsStore } from '@/stores/settings'
import { archiveSessionForSwitch, applyRestoredSession } from './useSession'
import { refreshLibraryBookmarks } from './useLibraryBookmarks'

/**
 * 换库编排（方案 §2.13，渲染层负责存档与恢复，主进程负责库连接）：
 * 1. library:open —— 主进程建新库、停扫描、读出新车库会话（旧库仍活动）
 * 2. archiveSessionForSwitch —— 旧会话快照 + 驻留脏标签草稿写进旧库
 * 3. library:activate —— 主进程关闭旧库、切活动库（提交点）
 * 4. applyRestoredSession —— 清空当前 model/标签，灌入新库会话
 * 任一步失败都中止在旧库；已准备的新库用 library:abort 关掉，绝不留两个半库。
 */
function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export async function switchLibrary(root: string): Promise<boolean> {
  const library = useLibraryStore()
  const settings = useSettingsStore()

  let prepared
  try {
    prepared = await libraryOpen(root)
  } catch (e) {
    library.error = message(e)
    return false
  }

  // 启动时按设置打开同一书库：只刷新列表，不重复存档/恢复
  if (!prepared.switched) {
    await library.applyOpened(prepared)
    if (settings.libraryRoot !== prepared.root) await settings.setLibraryRoot(prepared.root)
    return true
  }

  // 存档旧会话失败：新库尚未启用，关掉它即可回到原库
  try {
    await archiveSessionForSwitch()
  } catch (e) {
    await libraryAbort().catch(() => undefined)
    library.error = `换库已取消：${message(e)}`
    return false
  }

  try {
    await libraryActivate()
  } catch (e) {
    await libraryAbort().catch(() => undefined)
    library.error = `换库失败：${message(e)}`
    return false
  }

  // 已切到新库：恢复新库会话（草稿在激活后按 tabId 从新库懒读，不会串到旧库）
  applyRestoredSession(prepared.session)
  refreshLibraryBookmarks()
  await settings.setLibraryRoot(prepared.root)
  await library.applyOpened(prepared)
  return true
}

/** 选择目录并切换；取消选择返回 false */
export async function chooseAndSwitchLibrary(): Promise<boolean> {
  const root = await chooseLibrary()
  if (!root) return false
  return switchLibrary(root)
}
