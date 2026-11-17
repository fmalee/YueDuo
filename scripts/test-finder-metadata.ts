import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildBplistNumber,
  buildBplistString,
  parseBplistNumber,
  parseBplistString,
  readFinderComment,
  readFinderRating,
  writeFinderComment,
  writeFinderRating
} from '../electron/services/finderMetadata'
import { closeDatabase, getDatabase, initDatabase } from '../electron/services/database'
import { scanLibrary } from '../electron/services/libraryScanner'

const COMMENT_ATTR = 'com.apple.metadata:kMDItemFinderComment'
const RATING_ATTR = 'com.apple.metadata:kMDItemStarRating'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`)
  console.log(`ok - ${message}`)
}

/** 用 python3 plistlib 生成对照字节（只作编码口径基准，不参与运行时代码） */
function pythonDump(kind: 'str' | 'float', values: Array<string | number>): string[] {
  const body =
    kind === 'str'
      ? 'import sys, json, plistlib\nfor v in json.load(sys.stdin):\n    print(plistlib.dumps(v, fmt=plistlib.FMT_BINARY).hex())'
      : 'import sys, json, plistlib\nfor v in json.load(sys.stdin):\n    print(plistlib.dumps(float(v), fmt=plistlib.FMT_BINARY).hex())'
  const result = spawnSync('python3', ['-c', body], {
    input: JSON.stringify(values),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  if (result.status !== 0) throw new Error(`python3 plistlib 调用失败：${result.stderr}`)
  return result.stdout.trim().split('\n')
}

async function main(): Promise<void> {
  // 1) 注释字符串：与 python3 plistlib.dumps(str, FMT_BINARY) 逐字节一致
  const strings = [
    '',
    'abc',
    'a'.repeat(14),
    'a'.repeat(15),
    'a'.repeat(20),
    'a'.repeat(255),
    'a'.repeat(256),
    'a'.repeat(300),
    '科幻 星际',
    '🐉🐉续集 123',
    '中文English混排',
    '长'.repeat(30000)
  ]
  const expectedStrings = pythonDump('str', strings)
  strings.forEach((value, index) => {
    const actual = buildBplistString(value).toString('hex')
    const label = value.length > 20 ? `长度 ${value.length}` : JSON.stringify(value)
    assert(actual === expectedStrings[index], `注释 bplist 与 Python 一致：${label}`)
    assert(parseBplistString(Buffer.from(expectedStrings[index], 'hex')) === value, `注释可回读：${label}`)
  })

  // 2) 星级实数：沿用 2.5 的构造，扩展后仍与 Python 一致
  const ratings = [0, 1, 2.5, 3, 4, 5]
  const expectedRatings = pythonDump('float', ratings)
  ratings.forEach((value, index) => {
    assert(buildBplistNumber(value).toString('hex') === expectedRatings[index], `星级 bplist 与 Python 一致：${value}`)
    assert(parseBplistNumber(Buffer.from(expectedRatings[index], 'hex')) === value, `星级可回读：${value}`)
  })

  if (process.platform !== 'darwin') {
    console.log('skip - 非 macOS 跳过 xattr 读写')
    return
  }

  // 3) 真实 xattr：写、读、同值跳过、无主题跳过、非 ASCII、与 Python 字节一致
  const dir = mkdtempSync(join(tmpdir(), 'yue-210-finder-'))
  const file = join(dir, '测试书.txt')
  writeFileSync(file, '正文')
  try {
    assert(!(await writeFinderComment(file, null)), '无主题跳过写入')
    assert(!(await writeFinderComment(file, '')), '空主题跳过写入')

    assert(await writeFinderComment(file, '科幻 星际'), '首次写入 Finder 注释')
    assert((await readFinderComment(file)) === '科幻 星际', '读回 Finder 注释')
    const raw = spawnSync('xattr', ['-px', COMMENT_ATTR, file], { encoding: 'utf8' })
    assert(
      raw.stdout.replace(/\s+/g, '').toLowerCase() === pythonDump('str', ['科幻 星际'])[0],
      '注释 xattr 字节与 Python plistlib 一致'
    )
    assert(!(await writeFinderComment(file, '科幻 星际')), '旧注释相同则跳过写入')

    const nonAscii = '续集 🐉 中文 123'
    assert(await writeFinderComment(file, nonAscii), '注释可改为非 ASCII 内容')
    assert((await readFinderComment(file)) === nonAscii, '非 ASCII 注释读回一致')

    // 外部工具（python3 plistlib + xattr）写入的注释也能读
    const externalHex = pythonDump('str', ['外部写入的注释'])[0]
    spawnSync('xattr', ['-w', '-x', COMMENT_ATTR, externalHex, file], { encoding: 'utf8' })
    assert((await readFinderComment(file)) === '外部写入的注释', '可读外部写入的 UTF-16BE 注释')

    // 4) 星级双向：写出后读回；同值跳过；xattr 字节与 Python 一致
    assert(await writeFinderRating(file, 4), '写入 Finder 星级')
    assert((await readFinderRating(file)) === 4, '读回 Finder 星级')
    assert(!(await writeFinderRating(file, 4)), '星级同值跳过写入')
    const ratingRaw = spawnSync('xattr', ['-px', RATING_ATTR, file], { encoding: 'utf8' })
    assert(
      ratingRaw.stdout.replace(/\s+/g, '').toLowerCase() === pythonDump('float', [4])[0],
      '星级 xattr 字节与 Python plistlib 一致'
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  // 5) 扫描读入：Finder 星级写进文件后，enrich 落库
  const libraryDir = mkdtempSync(join(tmpdir(), 'yue-210-library-'))
  const dbDir = mkdtempSync(join(tmpdir(), 'yue-210-db-'))
  try {
    const bookPath = join(libraryDir, '扫描评分.txt')
    writeFileSync(bookPath, '《扫描评分》\n作者：某人\n主题：测试\n正文第一行')
    assert(await writeFinderRating(bookPath, 3), '文件写入 Finder 星级 3')
    initDatabase(dbDir)
    const result = await scanLibrary(libraryDir)
    const row = getDatabase()
      .prepare('SELECT rating FROM books WHERE relative_path = ?')
      .get('扫描评分.txt') as { rating: number } | undefined
    assert(result.total === 1 && row?.rating === 3, '扫描读入 Finder 星级并落库')
  } finally {
    closeDatabase()
    rmSync(libraryDir, { recursive: true, force: true })
    rmSync(dbDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
