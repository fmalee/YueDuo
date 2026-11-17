import { execFile } from 'child_process'

/**
 * Finder／Path Finder 扩展属性读写（对齐 Python finder_metadata / plistlib）：
 * - 星级 com.apple.metadata:kMDItemStarRating：bplist00 实数（float marker 0x23）
 * - 注释 com.apple.metadata:kMDItemFinderComment：bplist00 字符串
 * 用 `xattr -px` / `xattr -w -x` 传十六进制，避免非 UTF-8 字节在命令行里被破坏。
 * 不引入 plist 依赖，bplist00 手写构造必须与 python3 plistlib.dumps(FMT_BINARY) 逐字节一致：
 * - 字符串：全 ASCII 走 UTF-8 marker 0x5X/0x5F，否则 UTF-16BE marker 0x6X/0x6F
 * - 扩展长度：token|0xF 后跟内联整数对象（0x10/0x11/0x12/0x13 + 大端长度）
 * - 偏移表宽度按「头 + 对象」总长度取 1/2/4/8 字节
 * - trailer 32 字节（Python pack('>5xBBBQQQ', sortVersion, offsetSize, refSize, ...)）
 */
const RATING_ATTR = 'com.apple.metadata:kMDItemStarRating'
const COMMENT_ATTR = 'com.apple.metadata:kMDItemFinderComment'
const HEADER = Buffer.from('bplist00', 'ascii')

/** 对齐 Python `value.encode('ascii')`：全部码元 < 128 才走 UTF-8 marker */
function isAsciiOnly(value: string): boolean {
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) > 0x7f) return false
  return true
}

function runXattr(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('xattr', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout) =>
      resolve(error ? null : stdout)
    )
  })
}

function readUIntBE(buf: Buffer, offset: number, size: number): number {
  let value = 0
  for (let i = 0; i < size; i++) value = value * 256 + buf[offset + i]
  return value
}

/** 读顶层对象位置（32 字节 trailer，Python plistlib 口径）；结构不合法返回 null */
function readTopObject(buf: Buffer): { offset: number; marker: number } | null {
  if (buf.length < 40 || buf.toString('ascii', 0, 8) !== 'bplist00') return null
  const trailer = buf.length - 32
  const offsetSize = buf[trailer + 6]
  if (offsetSize < 1 || offsetSize > 8) return null
  const numObjects = readUIntBE(buf, trailer + 8, 8)
  const topObject = readUIntBE(buf, trailer + 16, 8)
  const offsetTableOffset = readUIntBE(buf, trailer + 24, 8)
  if (numObjects < 1 || topObject >= numObjects || offsetTableOffset >= buf.length) return null
  const entry = offsetTableOffset + topObject * offsetSize
  if (entry + offsetSize > buf.length) return null

  const offset = readUIntBE(buf, entry, offsetSize)
  if (offset >= buf.length) return null
  return { offset, marker: buf[offset] }
}

/** 只解析顶层 real/int（Finder 星级为 real）；结构不合法返回 null */
export function parseBplistNumber(buf: Buffer): number | null {
  const top = readTopObject(buf)
  if (!top) return null
  const { offset, marker } = top
  const type = marker >> 4
  const info = marker & 0x0f

  if (type === 0x2) {
    if (info === 0x2 && offset + 5 <= buf.length) return buf.readFloatBE(offset + 1)
    if (info === 0x3 && offset + 9 <= buf.length) return buf.readDoubleBE(offset + 1)
    return null
  }
  if (type === 0x1) {
    const size = [1, 2, 4, 8][info]
    if (!size || offset + 1 + size > buf.length) return null
    return readUIntBE(buf, offset + 1, size)
  }
  return null
}

/** Python _count_to_size：宽度按最小可容纳字节取 1/2/4/8（注意 JS 位移在 2^32 处会回绕，用乘方） */
function countToSize(count: number): number {
  if (count < 0x100) return 1
  if (count < 0x10000) return 2
  if (count < 2 ** 31) return 4
  return 8
}

/** Python _write_size：<15 单字节；否则 token|0xF + 内联整数对象 + 大端长度 */
function encodeSize(token: number, size: number): Buffer {
  if (size < 0x0f) return Buffer.from([token | size])
  const head = Buffer.alloc(2)
  head[0] = token | 0x0f
  if (size < 0x100) {
    head[1] = 0x10
    const out = Buffer.alloc(3)
    head.copy(out)
    out[2] = size
    return out
  }
  if (size < 0x10000) {
    head[1] = 0x11
    const out = Buffer.alloc(4)
    head.copy(out)
    out.writeUInt16BE(size, 2)
    return out
  }
  if (size < 2 ** 32) {
    head[1] = 0x12
    const out = Buffer.alloc(6)
    head.copy(out)
    out.writeUInt32BE(size, 2)
    return out
  }
  head[1] = 0x13
  const out = Buffer.alloc(10)
  head.copy(out)
  out.writeBigUInt64BE(BigInt(size), 2)
  return out
}

/** 单个顶层对象的完整 bplist00：头 + 对象 + 偏移表 + 32 字节 trailer */
function buildSingleObject(object: Buffer): Buffer {
  const offsetTableOffset = HEADER.length + object.length
  const offsetSize = countToSize(offsetTableOffset)
  const offsetTable = Buffer.alloc(offsetSize)
  if (offsetSize === 8) offsetTable.writeBigUInt64BE(BigInt(HEADER.length), 0)
  else offsetTable.writeUIntBE(HEADER.length, 0, offsetSize)

  const trailer = Buffer.alloc(32)
  trailer[5] = 0 // sortVersion
  trailer[6] = offsetSize
  trailer[7] = 1 // refSize（单对象）
  trailer.writeBigUInt64BE(1n, 8) // 对象数
  trailer.writeBigUInt64BE(0n, 16) // 顶层对象索引
  trailer.writeBigUInt64BE(BigInt(offsetTableOffset), 24)
  return Buffer.concat([HEADER, object, offsetTable, trailer])
}

/** 构造只含一个 8 字节实数的 bplist00（与 Python plistlib.dumps(float) 同构） */
export function buildBplistNumber(value: number): Buffer {
  const payload = Buffer.alloc(9)
  payload[0] = 0x23
  payload.writeDoubleBE(value, 1)
  return buildSingleObject(payload)
}

/** 字符串对象：Python 全 ASCII 走 0x5X，含非 ASCII 走 UTF-16BE 0x6X（低 4 位是字符数） */
function encodeBplistString(value: string): Buffer {
  if (isAsciiOnly(value)) {
    return Buffer.concat([encodeSize(0x50, value.length), Buffer.from(value, 'ascii')])
  }
  const utf16 = Buffer.from(value, 'utf-16le').swap16()
  return Buffer.concat([encodeSize(0x60, utf16.length / 2), utf16])
}

/** 构造只含一个字符串的 bplist00（与 Python plistlib.dumps(str) 逐字节一致） */
export function buildBplistString(value: string): Buffer {
  return buildSingleObject(encodeBplistString(value))
}

/** 扩展长度内联整数对象：0x10/0x11/0x12/0x13 + 1/2/4/8 字节大端 */
function readExtendedLength(buf: Buffer, offset: number): { length: number; start: number } | null {
  if (offset >= buf.length || buf[offset] >> 4 !== 0x1) return null
  const info = buf[offset] & 0x0f
  const size = [1, 2, 4, 8][info]
  if (!size || offset + 1 + size > buf.length) return null
  return { length: readUIntBE(buf, offset + 1, size), start: offset + 1 + size }
}

/**
 * 只解析顶层字符串：兼容 Python 的 UTF-16BE marker 与 Finder/其它工具写出的 UTF-8 marker。
 * 结构不合法返回 null。
 */
export function parseBplistString(buf: Buffer): string | null {
  const top = readTopObject(buf)
  if (!top) return null
  const { offset, marker } = top
  const type = marker >> 4
  const info = marker & 0x0f
  if (type !== 0x5 && type !== 0x6) return null

  let length = info
  let start = offset + 1
  if (info === 0x0f) {
    const ext = readExtendedLength(buf, offset + 1)
    if (!ext) return null
    length = ext.length
    start = ext.start
  }

  if (type === 0x5) {
    if (start + length > buf.length) return null
    return buf.toString('utf8', start, start + length)
  }
  const end = start + length * 2
  if (end > buf.length) return null
  return Buffer.from(buf.subarray(start, end)).swap16().toString('utf-16le')
}

/**
 * 读星级：0～5。非 macOS 返回 null（调用方保留库内评分）；
 * macOS 上无属性/读取失败按 0 分（对齐 Python finder_metadata.rating）。
 */
export async function readFinderRating(path: string): Promise<number | null> {
  if (process.platform !== 'darwin') return null
  const hex = await runXattr(['-px', RATING_ATTR, path])
  if (!hex) return 0
  const raw = Buffer.from(hex.replace(/\s+/g, ''), 'hex')
  const value = parseBplistNumber(raw)
  if (value === null) return 0
  return Math.min(5, Math.max(0, Math.round(value)))
}

/**
 * 写星级到 Finder 扩展属性：只写文件元数据、不碰正文。
 * 写前读旧值，相同则跳过（AGENTS.md）；失败静默返回 false，不影响数据库评分。
 */
export async function writeFinderRating(path: string, rating: number): Promise<boolean> {
  if (process.platform !== 'darwin') return false
  const value = Math.min(5, Math.max(0, Math.round(rating)))
  const current = await readFinderRating(path)
  if (current === value) return false
  const hex = buildBplistNumber(value).toString('hex')
  const stdout = await runXattr(['-w', '-x', RATING_ATTR, hex, path])
  return stdout !== null
}

/** 读 Finder 注释；非 macOS、无属性或无法解析返回 null */
export async function readFinderComment(path: string): Promise<string | null> {
  if (process.platform !== 'darwin') return null
  const hex = await runXattr(['-px', COMMENT_ATTR, path])
  if (!hex) return null
  return parseBplistString(Buffer.from(hex.replace(/\s+/g, ''), 'hex'))
}

/**
 * 注释写入结果：
 * - refreshed：xattr 已写入，Finder 也同步完成（简介立即可见）
 * - written：xattr 已写入，但 Finder 同步失败（无授权 / osascript 异常），调用方需知道
 * - skipped：非 macOS、无内容或与旧值相同，未写
 * - failed：xattr 写入本身失败
 */
export type FinderCommentWriteStatus = 'refreshed' | 'written' | 'skipped' | 'failed'

/**
 * 让 Finder 写入同一条注释：raw xattr 只改文件本身，Finder／Path Finder 的简介
 * 不总是直接读 xattr——Spotlight 索引会滞后，Finder 自己的缓存还可能长期停在旧值；
 * 经 Finder 走它自己的元数据 API 才会立即刷新（Path Finder 的
 * setSpotlightCommentUsingTheFinder 就是 `set comment of item ...`）。失败不影响已写入的 xattr。
 *
 * 路径与注释都作为 osascript 的 argv 传入，不拼进脚本文本，双引号／反斜杠／换行／中文
 * 不会破坏语法，也不会被当成脚本执行。
 */
function syncFinderComment(path: string, text: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    execFile(
      'osascript',
      [
        '-e',
        'on run argv',
        '-e',
        'tell application "Finder" to set comment of (POSIX file (item 1 of argv) as alias) to (item 2 of argv)',
        '-e',
        'end run',
        path,
        text
      ],
      { timeout: 2000 },
      (error, _stdout, stderr) => {
        if (error) resolve({ ok: false, error: stderr?.trim() || error.message })
        else resolve({ ok: true })
      }
    )
  })
}

/**
 * 写 Finder 注释（方案 §2.10）：无主题跳过；写前读旧注释，内容相同也跳过，
 * 减少写操作、避免反复改动文件。xattr 写成功后尝试让 Finder 同步；
 * 同步失败只降级为 'written'，不抛出、不阻塞保存主流程。
 */
export async function writeFinderComment(
  path: string,
  text: string | null,
  /** 测试注入口：默认走真实 osascript，单测可替换为失败实现验证降级 */
  sync: (path: string, text: string) => Promise<{ ok: boolean; error?: string }> = syncFinderComment
): Promise<FinderCommentWriteStatus> {
  if (process.platform !== 'darwin') return 'skipped'
  if (!text) return 'skipped'
  const current = await readFinderComment(path)
  if (current === text) return 'skipped'
  const hex = buildBplistString(text).toString('hex')
  const stdout = await runXattr(['-w', '-x', COMMENT_ATTR, hex, path])
  if (stdout === null) {
    console.warn(`[finder] 注释 xattr 写入失败：${path}`)
    return 'failed'
  }
  // xattr 已落盘；再让 Finder 同步一次索引，Finder 简介里立即能看到
  const synced = await sync(path, text)
  if (!synced.ok) {
    console.warn(
      `[finder] 注释已写入 xattr，但 Finder 同步失败：${synced.error ?? '未知原因'}（${path}）`
    )
    return 'written'
  }
  return 'refreshed'
}
