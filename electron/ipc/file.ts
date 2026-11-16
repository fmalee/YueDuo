import { statSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { decodeBytes, encodeForWrite } from '../services/textCodec'
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

/**
 * file:writeText —— 保存（UTF-16LE + 临时文件写 + rename 原子替换）
 * 临时文件与目标同盘（先试同目录，失败退系统 tmp），中断不破坏原文件（Python 同款语义）
 */
export function fileWriteText(path: string, text: string): { encoding: string; stat: FileStat } {
  const data = encodeForWrite(text)
  let tmpPath = join(dirname(path), `.${randomUUID()}.yueduo-tmp`)
  try {
    writeFileSync(tmpPath, data)
  } catch {
    // 同目录不可写时退系统 tmp（跨盘 rename 会失败，此时复制语义退化为直接写）
    tmpPath = join(tmpdir(), `yueduo-${randomUUID()}`)
    writeFileSync(tmpPath, data)
    copySync(tmpPath, path)
    unlinkSync(tmpPath)
    return { encoding: 'utf-16-le', stat: statOf(path) }
  }
  renameSync(tmpPath, path)
  return { encoding: 'utf-16-le', stat: statOf(path) }
}

function copySync(src: string, dest: string): void {
  writeFileSync(dest, readFileSync(src))
}
