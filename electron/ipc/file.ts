import { statSync, readFileSync } from 'fs'
import { decodeBytes } from '../services/textCodec'
import type { FileReadResult, FileStat } from '../../shared/types'

function statOf(path: string): FileStat {
  const s = statSync(path)
  return { ino: Number(s.ino), size: s.size, mtimeMs: s.mtimeMs }
}

/** file:readText —— 打开/按需重载标签（textCodec 探测+转换+换行归一） */
export function fileReadText(path: string): FileReadResult {
  const { text, encoding } = decodeBytes(readFileSync(path))
  return { text, encoding, stat: statOf(path) }
}

/** file:stat —— 同文件去重（inode 优先，realpath 兜底在调用侧做） */
export function fileStat(path: string): FileStat {
  return statOf(path)
}
