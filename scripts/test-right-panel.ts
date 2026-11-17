import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseChapters } from '../electron/services/chapterParser'
import {
  addBookmark,
  listBookmarks,
  listLibraryBookmarks,
  removeBookmark,
  replaceBookmarks
} from '../electron/services/bookmarkRepository'
import { closeDatabase, getDatabase, initDatabase } from '../electron/services/database'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`)
  console.log(`ok - ${message}`)
}

// 1) 章节正则：Python EXTRACT_CHAPTERS 同口径
const text = [
  '书名《测试》',
  '第1章 开始',
  '正文',
  '  第十二回 风起',
  '第两百章 终局',
  '今天第一章的感想', // 不以「第」开头，不匹配
  '序章',
  '楔子 旧事',
  '番外 一',
  '第一部 山河',
  '尾声'
].join('\n')
const chapters = parseChapters(text)
assert(chapters.length === 8, `提取 8 个章节（实际 ${chapters.length}）`)
assert(chapters[0].title === '第1章 开始' && chapters[0].line === 2, '第1章 行号 2')
assert(chapters[1].title === '第十二回 风起' && chapters[1].line === 4, '行首缩进去掉并保留行号')
assert(chapters[2].title === '第两百章 终局', '第两百章匹配')
assert(chapters.some((c) => c.title === '番外 一'), '番外匹配')
assert(!chapters.some((c) => c.title.includes('感想')), '句中「第一章」不误匹配')

// 2) 书签仓储：最小书籍记录 + 同行 upsert + 按行排序 + 删除
const dir = mkdtempSync(join(tmpdir(), 'yue-26-bookmark-'))
initDatabase(dir)
const rel = '金庸/笑傲江湖.txt'
let list = addBookmark(rel, '笑傲江湖.txt', 30, '第三十行摘要')
list = addBookmark(rel, '笑傲江湖.txt', 10, '第十行摘要')
assert(list.length === 2 && list[0].line === 10, '书签按行号升序')
list = addBookmark(rel, '笑傲江湖.txt', 10, '改后的摘要')
assert(list.length === 2 && list[0].note === '改后的摘要', '同行书签更新摘要而不新增')
const book = getDatabase()
  .prepare('SELECT title FROM books WHERE relative_path = ?')
  .get(rel) as { title: string }
assert(book.title === '笑傲江湖', '未入库书籍补最小记录，书名取文件名 stem')
list = removeBookmark(rel, 10)
assert(list.length === 1 && list[0].line === 30, '删除指定行书签')
assert(listBookmarks(rel).length === 1, 'listBookmarks 与返回值一致')

// 3) 全库书签分组（方案 §2.7）：两本书各成一组，组内按行号升序
const rel2 = '古龙/多情剑客无情剑.txt'
addBookmark(rel2, '多情剑客无情剑.txt', 8, '小李飞刀')
addBookmark(rel2, '多情剑客无情剑.txt', 3, '开篇')
addBookmark(rel, '笑傲江湖.txt', 12, '令狐冲')
const groups = listLibraryBookmarks()
assert(groups.length === 2, `全库书签分 2 组（实际 ${groups.length}）`)
assert(groups[0].title === '多情剑客无情剑' && groups[0].bookmarks.length === 2, '古龙组书名与条数')
assert(
  groups[0].bookmarks[0].line === 3 && groups[0].bookmarks[1].line === 8,
  '组内按行号升序'
)
assert(groups[1].title === '笑傲江湖' && groups[1].bookmarks.length === 2, '金庸组书名与条数')

// 4) 整体回写（漂移落库）：去重、过滤非法行号、删旧行
const replaced = replaceBookmarks(rel, '笑傲江湖.txt', [
  { line: 31, note: '漂移后' },
  { line: 31, note: '重复行丢弃' },
  { line: 0, note: '非法行号' },
  { line: 45, note: '新增' }
])
assert(
  replaced.length === 2 && replaced[0].line === 31 && replaced[0].note === '漂移后',
  '整体回写去重且保留首条'
)
assert(replaced[1].line === 45, '整体回写写入新行号')
assert(listBookmarks(rel).length === 2, '整体回写后旧书签被替换')
closeDatabase()
rmSync(dir, { recursive: true, force: true })
console.log('ALL OK')
