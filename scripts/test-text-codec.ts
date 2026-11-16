// 1.1 textCodec 服务验证：真实书库样本 + 自造编码样本
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { decodeBytes, encodeForWrite } from '../electron/services/textCodec'
import iconv from 'iconv-lite'

const lib = '/Users/Joey/Sites/Projects/小说'
const samples = [
  '重生之心动.txt',
  '我就是好莱坞.txt',
  '风流小保安.txt',
  '金庸/笑傲江湖.txt',
  '经典/百年孤独.txt'
]

let pass = 0
let fail = 0

console.log('=== 真实书库样本 ===')
for (const rel of samples) {
  const p = resolve(lib, rel)
  let data: Buffer
  try {
    data = readFileSync(p)
  } catch {
    console.log(`SKIP ${rel}（文件不存在）`)
    continue
  }
  const t0 = performance.now()
  const { text, encoding } = decodeBytes(data)
  const dt = (performance.now() - t0).toFixed(0)
  const head = text.slice(0, 24).replace(/\n/g, '⏎')
  console.log(`${rel} → ${encoding}，${(data.length / 1024 / 1024).toFixed(1)}MB 耗时${dt}ms 首行「${head}」`)
  if (text.length > 0) pass++
  else fail++
}

console.log('\n=== 自造编码样本 ===')
const probe = '书名：测试\n作者：佚名\n正文内容，中文编码探测。\n'.repeat(40)
const cases: Array<[string, Buffer, string, string | null]> = [
  ['utf-8 BOM', iconv.encode(probe, 'utf-8') as Buffer, 'utf-8', '正文内容'],
  ['utf-8 无 BOM', Buffer.from(probe, 'utf-8'), 'utf-8', '正文内容'],
  ['utf-16 带BOM', iconv.encode(probe, 'utf-16') as Buffer, 'utf-16', '正文内容'], // iconv-lite utf-16 写 BOM
  ['utf-16le 无BOM', iconv.encode(probe, 'utf-16le') as Buffer, 'utf-16le', '正文内容'],
  ['gb18030', iconv.encode(probe, 'gb18030') as Buffer, 'gb18030', '正文内容'],
  ['big5', iconv.encode('書名：測試\n作者：佚名\n正文內容，中文編碼探測。\n'.repeat(40), 'big5') as Buffer, 'big5', '正文內容'],
  ['空文件', Buffer.alloc(0), 'utf-8', null]
]
for (const [name, data, expected, marker] of cases) {
  const { text, encoding } = decodeBytes(data)
  const ok = encoding === expected && (marker === null ? text === '' : text.includes(marker))
  console.log(`${name} → ${encoding}${ok ? ' ✓' : ` ✗（期望 ${expected}）`}`)
  ok ? pass++ : fail++
}

console.log('\n=== 写入编码 roundtrip ===')
const out = encodeForWrite('a\r\nb\rc\nd')
const back = iconv.decode(out, 'utf-16le')
console.log(
  `utf-16le 写入 ${out.length}B，roundtrip ${back === 'a\nb\nc\nd' ? '✓（换行已归一）' : `✗「${back}」`}`
)
back === 'a\nb\nc\nd' ? pass++ : fail++

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
