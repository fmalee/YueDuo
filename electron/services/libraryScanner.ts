import { readdir, readFile, realpath, stat } from 'fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'path'
import type { Dirent } from 'fs'
import { decodeBytes } from './textCodec'
import { parseMetadata } from './metadataParser'
import { readFinderRating } from './finderMetadata'
import { getDatabase } from './database'
import type { LibraryEntry, LibraryScanProgress, LibraryScanResult } from '../../shared/types'

/**
 * 书库扫描（方案 §2.2，以 Python library_scanner 为准翻译）：
 * - fastScan：只读文件系统铺目录树，一层一读，不碰数据库也不读正文
 * - enrich：后台递归遍历 .txt，解码全文 → 解析元数据 → 按 relative_path 直命中写库
 * （移动识别/删除清理属 2.3 对账，本步不做）
 * 纯 Node 实现（AGENTS.md：services 不 import Electron），数据库由 database 服务注入
 */

/** 后缀判断小写化，兼容 Windows 上常见的 .TXT（Python 同款） */
function isTxtFile(name: string): boolean {
  return name.toLowerCase().endsWith('.txt')
}

/** 对齐 Python 的 `sorted(..., key=name.lower())`：按小写名称排序，保证扫描顺序稳定 */
function byName(a: Dirent, b: Dirent): number {
  const left = a.name.toLowerCase()
  const right = b.name.toLowerCase()
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * 书架目录树的一层（library:fastScan）：
 * 目录在前、TXT 在后，均按名称排序；符号链接按目标类型分类（断链跳过），
 * 展开下一层由渲染层按需再调，不在这一步递归。
 */
export async function listDirectory(root: string, relativeDir = ''): Promise<LibraryEntry[]> {
  const dir = relativeDir ? join(root, relativeDir) : root
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const directories: LibraryEntry[] = []
  const files: LibraryEntry[] = []
  for (const entry of entries) {
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
    let isDir = entry.isDirectory()
    let isFile = entry.isFile()
    if (entry.isSymbolicLink()) {
      try {
        const info = await stat(join(dir, entry.name))
        isDir = info.isDirectory()
        isFile = info.isFile()
      } catch {
        continue // 断链不展示
      }
    }
    if (isDir) directories.push({ name: entry.name, relativePath, isDir: true })
    else if (isFile && isTxtFile(entry.name)) {
      files.push({ name: entry.name, relativePath, isDir: false })
    }
  }
  const sortEntries = (a: LibraryEntry, b: LibraryEntry): number => {
    const left = a.name.toLowerCase()
    const right = b.name.toLowerCase()
    return left < right ? -1 : left > right ? 1 : 0
  }
  directories.sort(sortEntries)
  files.sort(sortEntries)
  return [...directories, ...files]
}

/**
 * 深度优先遍历 .txt（对齐 Python _iter_txt_files）：
 * 每层先按名称输出本层文件，再按名称进入子目录；
 * 不进入符号链接目录（Python os.walk 默认 followlinks=False，避免环）。
 * 只产出绝对路径，书库相对路径由调用方按 realpath 后的真实目标计算（Python 同款）。
 */
async function* walkTxtFiles(dirAbs: string): AsyncGenerator<string> {
  let entries: Dirent[]
  try {
    entries = await readdir(dirAbs, { withFileTypes: true })
  } catch {
    return // 单个目录不可读不中断整次扫描
  }
  const files = entries.filter((entry) => entry.isFile() || entry.isSymbolicLink()).sort(byName)
  for (const file of files) {
    if (!isTxtFile(file.name)) continue
    if (file.isSymbolicLink()) {
      // Python os.walk 的 filenames 含符号链接文件；指向目录的链接不在这里递归（followlinks=False）
      try {
        if (!(await stat(join(dirAbs, file.name))).isFile()) continue
      } catch {
        continue // 断链
      }
    }
    yield join(dirAbs, file.name)
  }
  const directories = entries.filter((entry) => entry.isDirectory()).sort(byName)
  for (const directory of directories) {
    yield* walkTxtFiles(join(dirAbs, directory.name))
  }
}

export interface ScanLibraryOptions {
  /** 每 10 个成功入库的文件回调一次（对齐 Python _ScanThread 的合并频率） */
  onProgress?: (progress: LibraryScanProgress) => void
  /** 返回 false 时停止扫描（换库/退出时用），已入库的结果保留 */
  shouldContinue?: () => boolean
}

/**
 * 后台补元数据（library:enrich）：
 * 逐本读取 → textCodec 探测解码 → 解析书名/作者/标签/字数 → 按 relative_path 直命中写库。
 * 不可读文件与重复 inode 一律跳过，不中断整次扫描；
 * 更新只覆盖扫描可得字段，评分/进度/最近阅读与 miss_count 留给其它流程。
 */
export async function scanLibrary(
  root: string,
  options: ScanLibraryOptions = {}
): Promise<LibraryScanResult> {
  const db = getDatabase()
  const selectBook = db.prepare('SELECT id FROM books WHERE relative_path = ?')
  const updateBook = db.prepare(`
    UPDATE books SET
      filename = @filename, title = @title, author = @author, tags = @tags,
      word_count = @wordCount, size_bytes = @sizeBytes, encoding = @encoding,
      rating = COALESCE(@rating, rating),
      updated_at = @updatedAt
    WHERE id = @id
  `)
  const insertBook = db.prepare(`
    INSERT INTO books
      (relative_path, filename, title, author, tags, word_count, size_bytes, encoding, rating,
       created_at, updated_at)
    VALUES
      (@relativePath, @filename, @title, @author, @tags, @wordCount, @sizeBytes, @encoding,
       COALESCE(@rating, 0), @now, @now)
  `)

  const seen = new Set<string>()
  const result: LibraryScanResult = { total: 0, skipped: 0, books: [] }
  let realRoot: string
  try {
    realRoot = await realpath(root)
  } catch {
    return result
  }
  let index = 0

  for await (const absPath of walkTxtFiles(root)) {
    if (options.shouldContinue && !options.shouldContinue()) break
    index++

    let resolved: string
    try {
      resolved = await realpath(absPath)
    } catch {
      result.skipped++
      continue
    }
    // 落库身份用 realpath 后的真实目标（Python 同款）：符号链接与真实文件只入一次
    const rel = relative(realRoot, resolved)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      result.skipped++ // 指向书库外的链接没有库内相对路径，不计入书库
      continue
    }
    if (seen.has(resolved)) {
      result.skipped++
      continue
    }
    seen.add(resolved)
    const relativePath = rel.split(sep).join('/')

    try {
      // Finder 星级与文件系统/正文并行读：macOS 上无属性视为 0（Python 口径），
      // 非 macOS 返回 null，靠 COALESCE 保留库内评分
      const [data, info, rating] = await Promise.all([
        readFile(resolved),
        stat(resolved),
        readFinderRating(resolved)
      ])
      const { text, encoding } = decodeBytes(data)
      const meta = parseMetadata(text, basename(resolved), basename(dirname(resolved)))
      const now = Date.now()
      const params = {
        relativePath,
        filename: basename(resolved),
        title: meta.title,
        author: meta.author,
        tags: meta.tags.join(' '),
        wordCount: meta.wordCount,
        sizeBytes: info.size,
        encoding,
        rating,
        updatedAt: now
      }
      const existing = selectBook.get(relativePath) as { id: number } | undefined
      if (existing) updateBook.run({ ...params, id: existing.id })
      else insertBook.run({ ...params, now })
      result.total++
      result.books.push({
        relativePath,
        filename: params.filename,
        title: params.title,
        wordCount: params.wordCount,
        sizeBytes: params.sizeBytes,
        inserted: !existing
      })
      if (index % 10 === 0) options.onProgress?.({ scanned: index, path: resolved })
    } catch {
      result.skipped++ // 权限/删除/解码异常只跳过该文件
    }
  }
  return result
}
