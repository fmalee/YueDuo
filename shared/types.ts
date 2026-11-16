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

/** preload 注入到 window.yue 的形状 */
export interface YueBridge {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<IpcResult<T>>
}
