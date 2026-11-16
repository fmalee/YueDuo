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

/** 文件身份（同文件去重依据：inode 优先） */
export interface FileStat {
  ino: number
  size: number
  mtimeMs: number
}

/** file:readText 返回 */
export interface FileReadResult {
  text: string
  encoding: string
  stat: FileStat
}

/** 标签元信息（全文内容只存在于 Monaco model，绝不进这里） */
export interface TabMeta {
  id: string
  path: string
  title: string
  dirty: boolean
  lastFocusedAt: number
}

/** preload 注入到 window.yue 的形状 */
export interface YueBridge {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<IpcResult<T>>
}
