import iconv from 'iconv-lite'
import chardet from 'chardet'

/** 工作编码（对齐 Python constants.WORK_ENCODING） */
export const WORK_ENCODING = 'utf-16-le'

export interface LoadedText {
  text: string
  encoding: string
}

// UTF-32 的 BOM 以 UTF-16 的 BOM 开头，必须先匹配 UTF-32（对齐 Python _BOMS）
const BOMS: ReadonlyArray<readonly [Buffer, string]> = [
  [Buffer.from([0xff, 0xfe, 0x00, 0x00]), 'utf-32'], // BOM_UTF32_LE
  [Buffer.from([0x00, 0x00, 0xfe, 0xff]), 'utf-32'], // BOM_UTF32_BE
  [Buffer.from([0xef, 0xbb, 0xbf]), 'utf-8'], // BOM_UTF8 → utf-8-sig
  [Buffer.from([0xff, 0xfe]), 'utf-16'], // BOM_UTF16_LE
  [Buffer.from([0xfe, 0xff]), 'utf-16'] // BOM_UTF16_BE
]

// chardet 对短文本易把 GBK 误判为韩、日或西欧编码；
// 项目面向中文小说，这类结果再用 GB18030 严格解码复核（对齐 Python _SUSPECT_ENCODINGS）
const SUSPECT_ENCODINGS = new Set([
  'windows-1252',
  'iso-8859-1',
  'ascii',
  'shift-jis',
  'shift_jis',
  'sjis',
  'euc-jp',
  'eucjp',
  'windows-932',
  'cp932',
  'euc-kr',
  'euckr',
  'windows-949',
  'cp949',
  'johab'
])

const FALLBACK_ENCODINGS = ['utf-8', 'gb18030', 'big5']

/** iconv-lite 与 Python 解码语义对齐：BOM 版本需手动去 BOM */
function decodeStripBom(data: Buffer, encoding: string): string | null {
  if (encoding === 'utf-8') {
    // utf-8-sig：iconv-lite 的 'utf8' 不剥 BOM，手动处理
    if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
      return iconv.decode(data.subarray(3), 'utf-8')
    }
    return iconv.decode(data, 'utf-8')
  }
  if (encoding === 'utf-16') {
    // Python utf-16 解码器按 BOM 判字节序并剥除；这里已由 BOM 表判明方向
    if (data[0] === 0xff && data[1] === 0xfe) return iconv.decode(data.subarray(2), 'utf-16le')
    if (data[0] === 0xfe && data[1] === 0xff) return iconv.decode(data.subarray(2), 'utf-16be')
    return null
  }
  if (encoding === 'utf-32') {
    if (
      data.length >= 4 &&
      data[0] === 0xff &&
      data[1] === 0xfe &&
      data[2] === 0 &&
      data[3] === 0
    ) {
      return iconv.decode(data.subarray(4), 'utf-32le')
    }
    if (
      data.length >= 4 &&
      data[0] === 0 &&
      data[1] === 0 &&
      data[2] === 0xfe &&
      data[3] === 0xff
    ) {
      return iconv.decode(data.subarray(4), 'utf-32be')
    }
    return null
  }
  if (!iconv.encodingExists(encoding)) return null
  return iconv.decode(data, encoding)
}

/** 严格可解码校验（对齐 Python decode 严格模式）：roundtrip 重编码必须与原字节一致 */
function canDecode(data: Buffer, encoding: string): boolean {
  if (!iconv.encodingExists(encoding)) return false
  try {
    const text = iconv.decode(data, encoding)
    const back = iconv.encode(text, encoding)
    return back.equals(data)
  } catch {
    return false
  }
}

/** chardet 编码名 → iconv-lite 名归一（小写、下划线转横线） */
function normalizeChardetName(name: string): string {
  return name.toLowerCase().replace(/_/g, '-')
}

/** 无 BOM 的 UTF-16 中文常被误判为 UTF-8；用 NUL 字节与换行数量判断字节序（Python 同款） */
function guessUtf16WithoutBom(data: Buffer): string | null {
  if (data.length < 4 || !data.includes(0)) return null

  let sample = data.subarray(0, 8192)
  if (sample.length % 2) sample = sample.subarray(0, sample.length - 1)

  let bestEncoding: string | null = null
  let bestNewlines = 0
  for (const encoding of ['utf-16le', 'utf-16be'] as const) {
    let text: string
    try {
      text = iconv.decode(sample, encoding)
    } catch {
      continue
    }
    const newlines = countChar(text, '\n')
    if (newlines > bestNewlines) {
      bestEncoding = encoding
      bestNewlines = newlines
    }
  }
  return bestEncoding
}

function countChar(text: string, ch: string): number {
  let n = 0
  for (let i = text.indexOf(ch); i !== -1; i = text.indexOf(ch, i + 1)) n++
  return n
}

export function detectEncoding(data: Buffer): string {
  for (const [bom, encoding] of BOMS) {
    if (data.length >= bom.length && data.subarray(0, bom.length).equals(bom)) {
      return encoding
    }
  }

  const utf16Guess = guessUtf16WithoutBom(data)
  if (utf16Guess !== null) return utf16Guess

  // 对齐 charset-normalizer：chardet 探测 + 可解码校验 + GB18030 复核
  // 启发式统计特征用前 256KB 足够稳定，避免大文件全量分析
  const detected = chardet.detect(data.subarray(0, 262144))
  const encoding = detected ? normalizeChardetName(detected) : null
  if (encoding && canDecode(data, encoding)) {
    if (SUSPECT_ENCODINGS.has(encoding) && canDecode(data, 'gb18030')) {
      return 'gb18030'
    }
    return encoding
  }

  for (const candidate of FALLBACK_ENCODINGS) {
    if (canDecode(data, candidate)) return candidate
  }
  return 'utf-8'
}

function decodeWithFallbacks(data: Buffer, encoding: string): string {
  // 首选直接解（能严格解就用）
  if (canDecode(data, encoding)) {
    const text = decodeStripBom(data, encoding)
    if (text !== null) return text
  }
  for (const candidate of FALLBACK_ENCODINGS) {
    if (!canDecode(data, candidate)) continue
    const text = decodeStripBom(data, candidate)
    if (text !== null) return text
  }
  // 仍失败时保留可读部分，避免整本书无法打开（errors="replace" 对齐）
  return iconv.decode(data, 'utf-8')
}

/** 供 readText 主流程使用：探测 + 解码 + BOM 残留清理 + 换行归一 */
export function decodeBytes(data: Buffer): LoadedText {
  if (data.length === 0) return { text: '', encoding: 'utf-8' }

  const encoding = detectEncoding(data)
  let text = decodeWithFallbacks(data, encoding)
  // BOM 已由解码器去除，这里兜底清掉残留的 ZERO WIDTH NO-BREAK SPACE
  if (text.startsWith('\ufeff')) text = text.slice(1)
  return { text: normalizeNewlines(text), encoding }
}

/** 换行归一：CRLF/CR → LF（对齐 Python _normalize_newlines） */
export function normalizeNewlines(text: string): string {
  return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
}

/** 按工作编码写入：先写临时文件再原子替换，避免中断破坏原文件（Python 同款） */
export function encodeForWrite(text: string): Buffer {
  const normalized = normalizeNewlines(text)
  return iconv.encode(normalized, WORK_ENCODING)
}

/** 单测/脚本导出：直接读文件 */
export { decodeStripBom }
