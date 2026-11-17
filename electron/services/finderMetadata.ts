import { execFile } from 'child_process'

/**
 * Finder／Path Finder 星级读写（对齐 Python finder_metadata）：
 * 星级存在扩展属性 com.apple.metadata:kMDItemStarRating，值是 bplist00 实数（float marker 0x23）。
 * 用 `xattr -px` / `xattr -w -x` 传十六进制，避免非 UTF-8 字节在命令行里被破坏；
 * 不引入 plist 依赖，bplist00 的实数对象与 trailer 手写构造（AGENTS.md 数据约定）。
 */
const RATING_ATTR = 'com.apple.metadata:kMDItemStarRating'

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

/** 只解析顶层 real/int（Finder 星级为 real）；结构不合法返回 null */
export function parseBplistNumber(buf: Buffer): number | null {
  if (buf.length < 40 || buf.toString('ascii', 0, 8) !== 'bplist00') return null
  const trailer = buf.length - 32
  const offsetSize = buf[trailer + 6]
  if (offsetSize < 1 || offsetSize > 8) return null
  const numObjects = readUIntBE(buf, trailer + 8, 8)
  const topObject = readUIntBE(buf, trailer + 16, 8)
  const offsetTableOffset = readUIntBE(buf, trailer + 24, 8)
  if (numObjects < 1 || topObject >= numObjects || offsetTableOffset >= buf.length) return null

  const objectOffset = readUIntBE(buf, offsetTableOffset + topObject * offsetSize, offsetSize)
  if (objectOffset >= buf.length) return null
  const marker = buf[objectOffset]
  const type = marker >> 4
  const info = marker & 0x0f

  if (type === 0x2) {
    if (info === 0x2 && objectOffset + 5 <= buf.length) return buf.readFloatBE(objectOffset + 1)
    if (info === 0x3 && objectOffset + 9 <= buf.length) return buf.readDoubleBE(objectOffset + 1)
    return null
  }
  if (type === 0x1) {
    const size = [1, 2, 4, 8][info]
    if (!size || objectOffset + 1 + size > buf.length) return null
    return readUIntBE(buf, objectOffset + 1, size)
  }
  return null
}

/** 构造只含一个 8 字节实数的 bplist00（与 Python plistlib.dumps(float) 同构） */
export function buildBplistNumber(value: number): Buffer {
  // 头 8 字节 + 对象（0x23 + 8 字节 BE double）+ 偏移表 1 字节 + trailer 32 字节
  const payload = Buffer.alloc(9)
  payload[0] = 0x23
  payload.writeDoubleBE(value, 1)
  const trailer = Buffer.alloc(32)
  trailer[6] = 1 // offset 整数宽度
  trailer[7] = 1 // object ref 宽度
  trailer.writeBigUInt64BE(1n, 8) // 对象数
  trailer.writeBigUInt64BE(0n, 16) // 顶层对象索引
  trailer.writeBigUInt64BE(17n, 24) // 偏移表起点（头 8 + 对象 9）
  return Buffer.concat([Buffer.from('bplist00', 'ascii'), payload, Buffer.from([8]), trailer])
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
