/** IPC 统一返回契约：全部 invoke 通道都返回这个形状（方案 §三） */
export interface IpcOk<T = unknown> {
  ok: true
  data: T
}

export interface IpcErr {
  ok: false
  error: string
}

export type IpcResult<T = unknown> = IpcOk<T> | IpcErr

/** native:sanity 返回 */
export interface NativeSanity {
  betterSqlite3: string
  electron: string
  nodeAbi: string
}

/** 文件身份（同文件去重依据：dev+ino 优先，realPath 兜底，方案 §1.6） */
export interface FileStat {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  realPath: string
}

/** file:readText 返回 */
export interface FileReadResult {
  text: string
  encoding: string
  stat: FileStat
}

/** dialog:confirmClose 返回 */
export type ConfirmChoice = 'save' | 'discard' | 'cancel'

/**
 * LRU 卸载草稿（file:writeDraft / file:readDraft，方案 §1.7）
 * 阶段 1.7 为主进程内存级实现，1.8 会话持久化时迁 SQLite session_tabs.draft/view_state（IPC 不变）
 */
export interface DraftEntry {
  /** 卸载时的未保存全文；null = 卸载时非 dirty（重载走 file:readText） */
  text: string | null
  /** 卸载时的 Monaco 视图状态（滚动/选区），重载恢复阅读进度 */
  viewState: unknown
}

/** 标签元信息（全文内容只存在于 Monaco model，绝不进这里） */
export interface TabMeta {
  id: string
  path: string
  title: string
  dirty: boolean
  lastFocusedAt: number
}

/** 外观三态（方案 §1.10：浅/深/跟随系统） */
export type ThemeMode = 'light' | 'dark' | 'system'

/** 设置文件（userData/settings.json，方案 §1.9；当前最小切片只落外观） */
export interface AppSettings {
  appearance: ThemeMode
}

/** preload 注入到 window.yue 的形状 */
export interface YueBridge {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<IpcResult<T>>
}
