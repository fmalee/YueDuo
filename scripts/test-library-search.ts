import {
  buildPaletteEntries,
  PALETTE_EMPTY_LIMIT,
  PALETTE_LIMIT,
  queryEntries
} from '../shared/librarySearch'
import type { LibraryBook } from '../shared/types'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`)
  console.log(`ok - ${message}`)
}

let seq = 0
function book(partial: Partial<LibraryBook>): LibraryBook {
  seq += 1
  return {
    id: seq,
    relativePath: `测试/${partial.title ?? '未命名'}.txt`,
    path: `/tmp/书库/测试/${partial.title ?? '未命名'}.txt`,
    filename: `${partial.title ?? '未命名'}.txt`,
    title: '未命名',
    author: '',
    tags: [],
    rating: 0,
    wordCount: 0,
    progressLine: 0,
    lastReadAt: 0,
    ...partial
  }
}

// 快照顺序即最近阅读顺序（主进程按 last_read_at 倒序读出）
const books = [
  book({ title: '笑傲江湖', author: '金庸', tags: ['武侠', '追更'], lastReadAt: 300 }),
  book({ title: '射雕英雄传', author: '金庸', tags: ['武侠'], lastReadAt: 200 }),
  book({ title: '多情剑客无情剑', author: '古龙', tags: ['武侠'], lastReadAt: 100 }),
  book({ title: '金庸作品集', author: '佚名', tags: ['合集'], lastReadAt: 90 }),
  book({ title: '书剑恩仇录', author: '查良镛', tags: ['金庸'], lastReadAt: 80 }),
  book({ title: '金庸', author: '某人', tags: [], lastReadAt: 70 }),
  book({ title: '都市日常', author: '武侠迷', tags: ['都市'], lastReadAt: 60 })
]
const entries = buildPaletteEntries(books)

// 1) 空输入：保持快照顺序（最近阅读优先），最多 20 条
const empty = queryEntries(entries, '   ')
assert(empty.length === entries.length, '空输入返回快照条目')
assert(empty[0].title === '笑傲江湖' && empty[6].title === '都市日常', '空输入保持最近阅读顺序')

// 2) 单词：字段优先级 书名全等 > 前缀 > 包含 > 作者 > 标签
const single = queryEntries(entries, '金庸')
assert(
  single.map((e) => e.title).join('|') ===
    '金庸|金庸作品集|笑傲江湖|射雕英雄传|书剑恩仇录',
  `单词按字段优先级排序（实际 ${single.map((e) => e.title).join('|')}）`
)
assert(!single.some((e) => e.title === '多情剑客无情剑'), '无命中字段的书被排除')

// 3) 多词 AND：每个词都要命中（金庸=作者，武侠=标签）
const multi = queryEntries(entries, '  金庸   武侠 ')
assert(
  multi.map((e) => e.title).join('|') === '笑傲江湖|射雕英雄传',
  `多词 AND 只保留同时命中的书（实际 ${multi.map((e) => e.title).join('|')}）`
)
assert(!multi.some((e) => e.title === '多情剑客无情剑'), '只命中一个词的书被排除')

// 4) 同分保持快照顺序：射雕与笑傲都是作者+标签命中，笑傲更近，排在前面
assert(multi[0].title === '笑傲江湖', '同分保持最近阅读顺序')

// 5) 大小写不敏感（英文书名/作者/标签）
const english = buildPaletteEntries([
  book({ title: 'Dune', author: 'Frank Herbert', tags: ['SciFi'] })
])
assert(queryEntries(english, 'dune')[0]?.title === 'Dune', '书名大小写不敏感')
assert(queryEntries(english, 'frank')[0]?.title === 'Dune', '作者大小写不敏感')
assert(queryEntries(english, 'scifi')[0]?.title === 'Dune', '标签大小写不敏感')

// 6) 上限：查询结果 50 条，空输入 20 条
const many = buildPaletteEntries(
  Array.from({ length: 80 }, (_, i) => book({ title: `江湖录${i}`, lastReadAt: 1000 - i }))
)
assert(queryEntries(many, '江湖').length === PALETTE_LIMIT, `查询结果封顶 ${PALETTE_LIMIT}`)
assert(
  queryEntries(many, '').length === PALETTE_EMPTY_LIMIT,
  `空输入封顶 ${PALETTE_EMPTY_LIMIT}`
)

// 7) 书名包含优先于作者：书名含「金庸」的书整体排在仅作者是金庸的书前面
assert(
  single.findIndex((e) => e.title === '金庸作品集') <
    single.findIndex((e) => e.title === '笑傲江湖'),
  '书名命中优先于作者命中'
)

console.log('library-search: 全部通过')
