/**
 * 简繁转换与一键整理验收（方案 §3.2）
 * 1) 与 Python 旧项目逐样本比对（有 .venv 时直接跑旧实现，否则按已核对的字面量断言）
 * 2) 覆盖保护词/多义词策略、全角转半角边界、一键整理固定三段 + 规则顺序
 * 运行：npx tsx scripts/test-convert.ts
 */
import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { toSimplified, toTraditional, clearTableCache } from '../electron/services/chineseConvert'
import { toHalfwidth } from '../electron/services/textConvert'
import { tidyText } from '../electron/services/tidy'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`)
  console.log(`ok - ${message}`)
}

const SAMPLES = [
  '他头发很长，干部在干燥的房间里工作。',
  '他頭髮很長，幹部在乾燥的房間裡工作。',
  '干杯之后，后天出发去里面看看。',
  '干发后著名',
  '这是第一章，混合ＡＢＣ１２３＋－　，。',
  '空行测试\r\n\r\n\r\n\r\n结束\x07\u200b'
]

interface PythonResult {
  s2t: string[]
  t2s: string[]
  half: string[]
}

/** 直接调用旧项目 Python 实现，作为迁移一致性的权威证据 */
function pythonExpected(): PythonResult | null {
  const project = '/Users/Joey/Sites/Projects/NovelManager'
  const python = `${project}/.venv/bin/python`
  if (!existsSync(python) || !existsSync(`${project}/novelmanager/services/tidy.py`)) return null
  const code = [
    'import sys, json',
    `sys.path.insert(0, ${JSON.stringify(project)})`,
    'from novelmanager.services import chinese_convert as cc, text_convert as tc',
    'data = json.load(sys.stdin)',
    'samples = data["samples"]',
    'print(json.dumps({',
    '  "s2t": [cc.to_traditional(t).text for t in samples],',
    '  "t2s": [cc.to_simplified(t).text for t in samples],',
    '  "half": [tc.to_halfwidth(t).text for t in samples],',
    '}, ensure_ascii=False))'
  ].join('\n')
  const out = spawnSync(python, ['-c', code], {
    encoding: 'utf8',
    input: JSON.stringify({ samples: SAMPLES })
  })
  if (out.status !== 0) throw new Error(`调用旧项目 Python 失败: ${out.stderr}`)
  return JSON.parse(out.stdout) as PythonResult
}

const expected = pythonExpected()
if (expected) {
  SAMPLES.forEach((sample, index) => {
    assert(toTraditional(sample).text === expected.s2t[index], `简转繁与旧项目一致：${sample.slice(0, 8)}`)
    assert(toSimplified(sample).text === expected.t2s[index], `繁转简与旧项目一致：${sample.slice(0, 8)}`)
    assert(toHalfwidth(sample).text === expected.half[index], `全角转半角与旧项目一致：${sample.slice(0, 8)}`)
  })
} else {
  console.log('skip - 本机无 NovelManager 虚拟环境，跳过逐样本比对（下方字面量断言仍覆盖内容）')
}

// 字面量断言（经旧项目 Python 实测核对）
assert(
  toTraditional('他头发很长，干部在干燥的房间里工作。').text ===
    '他頭髮很長，幹部在乾燥的房間裏工作。',
  '词组最长匹配：头发/干部/干燥 各自取正确繁体'
)
assert(
  toSimplified('他頭髮很長，幹部在乾燥的房間裡工作。').text ===
    '他头发很长，干部在干燥的房间里工作。',
  '繁转简词组还原'
)

// 多义字：单字保留原字并计数，词组能判断时正常转换（Python ambiguous.txt 同款）
const ambiguous = toTraditional('干发后')
assert(ambiguous.text === '干发后' && ambiguous.kept === 3, '多义字单字保留并计数 3 处')
assert(toTraditional('干杯').text === '乾杯', '词组覆盖多义字时不保留')
assert(toTraditional('后天').text === '後天', '词组覆盖多义字（后天→後天）')
assert(toTraditional('著名').text === '著名' && toTraditional('著名').kept === 0, '标准字形不做著/着台湾变体转换')

const empty = toTraditional('')
assert(empty.text === '' && empty.kept === 0 && empty.keptWords === 0, '空串直接返回')

// 全角转半角：只动字母/数字/加减号
const half = toHalfwidth('ＡＢＣ１２３＋－　，。中文')
assert(half.text === 'ABC123+-\u3000，。中文', '全角字母数字加减号转半角，全角空格与中文标点不动')

// 一键整理：UTF-16LE 归一 → 繁转简 → 全角转半角 → 按规则表顺序跑 tidyEnabled（默认删段末不可见、删多余空行）
const tidied = tidyText(
  '第一章 开始\r\n\r\n\r\n\r\n这是  正文\t末尾　　\u200b\n\n結尾\x07'
)
assert(
  tidied.text === '第一章 开始\n\n这是  正文\t末尾\n\n结尾\x07',
  `整理结果符合新口径（实际 ${JSON.stringify(tidied.text)}）`
)
const tidyCounts = tidyText('这是  第一行\n\n\n\n沈')
assert(tidyCounts.convertKept === 1, '整理结果沿用繁转简的保留计数（沈 属多义字）')

// 重复调用同一张表（缓存）结果稳定
clearTableCache()
assert(toTraditional('头发').text === '頭髮', '清空词表缓存后可重建并复用')

console.log('all convert checks passed')
