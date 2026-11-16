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

/**
 * 会话快照中的标签（session:persist，方案 §1.8）
 * draft/view_state 不在这里：仍由 file:writeDraft 写入同一行，persist 不覆盖两列
 */
export interface SessionTabInput {
  id: string
  path: string
  title: string
  /** 视口顶部行（不是光标行；恢复时滚到该行并顶部对齐） */
  progressLine: number
  dirty: boolean
  lastFocusedAt: number
}

/** session:persist 入参：标签顺序即数组顺序 */
export interface SessionSnapshot {
  activeTabId: string | null
  tabs: SessionTabInput[]
}

/** session:restore 返回的标签行（按 position 升序） */
export interface SessionTabRecord extends SessionTabInput {
  position: number
  /** 是否有 draft/view_state（脏标签恢复时据此读草稿） */
  hasDraft: boolean
}

/** session:restore 返回 */
export interface SessionRestore {
  activeTabId: string | null
  tabs: SessionTabRecord[]
}

/** 标签元信息（全文内容只存在于 Monaco model，绝不进这里） */
export interface TabMeta {
  id: string
  path: string
  title: string
  /** 打开/保存时的源编码（状态栏展示，方案 §1.10） */
  encoding: string
  dirty: boolean
  lastFocusedAt: number
}

/** 外观三态（方案 §1.10：浅/深/跟随系统） */
export type ThemeMode = 'light' | 'dark' | 'system'

/** 设置文件（userData/settings.json，方案 §1.9；当前最小切片只落外观） */
export interface AppSettings {
  appearance: ThemeMode
}

/** 当前生效主题（主进程 nativeTheme 判定后推给渲染层，方案 §1.10） */
export interface ThemeChanged {
  dark: boolean
}

/** preload 注入到 window.yue 的形状 */
export interface YueBridge {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<IpcResult<T>>
  /** 订阅 nativeTheme 'updated'（返回取消订阅）；外观=跟随系统时靠它切主题 */
  onThemeUpdated(callback: (payload: ThemeChanged) => void): () => void
  /** 订阅退出/关窗前的会话落盘请求（返回取消订阅）；渲染层保存完成后回 session:flushDone */
  onSessionFlush(callback: () => void): () => void
}
