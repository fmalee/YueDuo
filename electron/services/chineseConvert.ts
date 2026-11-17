import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { ConvertResult } from '../../shared/types'

/**
 * 简繁转换（方案 §3.2）：OpenCC 词表 + 保守策略，从 Python
 * `novelmanager/services/chinese_convert.py` 翻译。
 *
 * 策略顺序（改顺序会改变结果）：
 * 1. 保护词整词跳过（keep.txt，人名地名等专名）；
 * 2. 词组最长匹配优先（解决「干」在干部／干燥里该用幹还是乾）；
 * 3. 单字一对一直接换；
 * 4. 单字一对多：ambiguous.txt 里的保留原字并计数，其余按词表首选项转换。
 *
 * 标准简繁表把「著／着」这类同字异义归入台湾变体表，本模块只做标准字形，不做该转换。
 * 词表放在 resources/dicts（OpenCC 原始文本，可随时增删）。
 */
type Direction = 's2t' | 't2s'

/** 词表目录：主进程产物在 out/main，资源在项目根 resources/dicts；打包后随 asarUnpack 同路径可读 */
function resolveDictDir(): string {
  const candidates = [
    join(__dirname, '../../resources/dicts'),
    join(process.cwd(), 'resources/dicts')
  ]
  return candidates.find((dir) => existsSync(join(dir, 'st_characters.txt'))) ?? candidates[0]
}

const DICT_DIR = resolveDictDir()

const DIRECTION_FILES: Record<Direction, [string, string]> = {
  s2t: ['st_characters.txt', 'st_phrases.txt'],
  t2s: ['ts_characters.txt', 'ts_phrases.txt']
}

interface TrieNode {
  children: Map<string, TrieNode>
  value?: string
}

interface DictTable {
  /** 一对一单字映射 */
  unique: Map<string, string>
  /** 一对多且无法脱离上下文判断的字：保留原字 */
  ambiguous: Set<string>
  /** 保护词字典树（目标值 = 原词） */
  keep: TrieNode
  /** 词组字典树 */
  phrases: TrieNode
}

/** 读取 OpenCC 词表：每行 `源<TAB>候选1 候选2 …`，# 开头为注释 */
function readEntries(fileName: string): Array<[string, string[]]> {
  const filePath = join(DICT_DIR, fileName)
  if (!existsSync(filePath)) throw new Error(`缺少简繁转换词表：${filePath}`)
  const entries: Array<[string, string[]]> = []
  for (const rawLine of readFileSync(filePath, 'utf-8').split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const tabIndex = line.indexOf('\t')
    if (tabIndex === -1) continue
    const source = line.slice(0, tabIndex)
    const candidates = line
      .slice(tabIndex + 1)
      .trim()
      .split(/\s+/)
    if (source && candidates.length > 0 && candidates[0]) entries.push([source, candidates])
  }
  return entries
}

function readLines(fileName: string): string[] {
  const filePath = join(DICT_DIR, fileName)
  if (!existsSync(filePath)) return []
  return readFileSync(filePath, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
}

/** 多义字清单：一行一个，也允许空格分隔多个 */
function readAmbiguousChars(): Set<string> {
  const chars = new Set<string>()
  for (const line of readLines('ambiguous.txt')) {
    for (const char of line.split(/\s+/)) if (char) chars.add(char)
  }
  return chars
}

/** 按码位逐层建树；匹配时也按码位走，扩展区汉字（如 𫔭）才能与词表对齐 */
function buildTrie(entries: Array<[string, string]>): TrieNode {
  const root: TrieNode = { children: new Map() }
  for (const [source, target] of entries) {
    let node = root
    for (const char of source) {
      let child = node.children.get(char)
      if (!child) {
        child = { children: new Map() }
        node.children.set(char, child)
      }
      node = child
    }
    node.value = target
  }
  return root
}

/** 从 start 起找最长命中，返回 [原词, 目标词] */
function longestMatch(trie: TrieNode, text: string, start: number): [string, string] | null {
  let node: TrieNode | undefined = trie
  let best: [string, string] | null = null
  let cursor = start
  while (cursor < text.length && node) {
    const codePoint = text.codePointAt(cursor)
    if (codePoint === undefined) break
    const char = String.fromCodePoint(codePoint)
    node = node.children.get(char)
    if (!node) break
    cursor += char.length
    if (node.value !== undefined) best = [text.slice(start, cursor), node.value]
  }
  return best
}

const tableCache = new Map<Direction, DictTable>()

function getTable(direction: Direction): DictTable {
  const cached = tableCache.get(direction)
  if (cached) return cached

  const [charFile, phraseFile] = DIRECTION_FILES[direction]
  const ambiguousChars = readAmbiguousChars()
  const unique = new Map<string, string>()
  const ambiguous = new Set<string>()

  for (const [source, candidates] of readEntries(charFile)) {
    if (candidates.length === 1) {
      unique.set(source, candidates[0])
    } else if (ambiguousChars.has(source)) {
      // 一字多义且词组表判断不了 → 保留原字，由调用方计数告知用户
      ambiguous.add(source)
    } else {
      // 多出的候选只是生僻异体（开／𫔭），按词表首选项转换
      unique.set(source, candidates[0])
    }
  }

  const phrases = readEntries(phraseFile).map(
    ([source, candidates]) => [source, candidates[0]] as [string, string]
  )
  const keep = readLines('keep.txt').map((word) => [word, word] as [string, string])

  const table: DictTable = {
    unique,
    ambiguous,
    keep: buildTrie(keep),
    phrases: buildTrie(phrases)
  }
  tableCache.set(direction, table)
  return table
}

export function convert(text: string, direction: Direction): ConvertResult {
  if (!text) return { text, kept: 0, keptWords: 0 }
  const table = getTable(direction)
  const out: string[] = []
  let kept = 0
  let keptWords = 0
  let index = 0

  while (index < text.length) {
    const keepHit = longestMatch(table.keep, text, index)
    if (keepHit) {
      out.push(keepHit[1])
      index += keepHit[0].length
      keptWords += 1
      continue
    }
    const phraseHit = longestMatch(table.phrases, text, index)
    if (phraseHit) {
      out.push(phraseHit[1])
      index += phraseHit[0].length
      continue
    }
    const codePoint = text.codePointAt(index)
    if (codePoint === undefined) break
    const char = String.fromCodePoint(codePoint)
    const target = table.unique.get(char)
    if (target !== undefined) {
      out.push(target)
    } else {
      out.push(char)
      if (table.ambiguous.has(char)) kept += 1
    }
    index += char.length
  }

  return { text: out.join(''), kept, keptWords }
}

/** 简转繁（标准字形） */
export function toTraditional(text: string): ConvertResult {
  return convert(text, 's2t')
}

/** 繁转简（标准字形） */
export function toSimplified(text: string): ConvertResult {
  return convert(text, 't2s')
}

/** 清空词表缓存（测试/热重载用） */
export function clearTableCache(): void {
  tableCache.clear()
}
