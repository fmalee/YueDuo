import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  activateDatabase,
  closeDatabase,
  openDatabase
} from '../electron/services/database'
import { loadSession, persistSession, relocateSessionTabs } from '../electron/services/sessionStore'
import { writeDraft } from '../electron/services/draftStore'
import type { SessionSnapshot } from '../shared/types'

/**
 * 会话标签路径口径验收（纯 Node，临时书库，不碰真实数据）：
 * - 落盘：库内标签写 book_id + 相对路径；库外标签写绝对路径 + NULL；空白标签两者为空
 * - 恢复：book_id 优先按 books.relative_path 拼当前书库根，查不到/文件不存在退回存的相对路径
 * - 缺失：文件不存在时不丢标签、标记 missing，对账改完 books 后按 book_id 重试一次能接上
 * - 历史行：绝对路径 + NULL 恢复仍按绝对路径打开，下次落盘自然写成新格式
 * - 整库搬家：数据库随库移动后，同一会话能按新书库根还原
 */
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`)
  console.log(`ok - ${message}`)
}

interface TabRow {
  id: string
  book_id: number | null
  path: string
}

function rowOf(id: string): TabRow {
  const row = db
    .prepare('SELECT id, book_id, path FROM session_tabs WHERE id = ?')
    .get(id) as TabRow | undefined
  if (!row) throw new Error(`FAIL: session_tabs 缺少 ${id}`)
  return row
}

function tab(
  id: string,
  path: string
): SessionSnapshot['tabs'][number] {
  return {
    id,
    path,
    title: path ? (path.split('/').pop() ?? path) : '未命名',
    progressLine: 1,
    cursorLine: 1,
    cursorColumn: 1,
    dirty: false,
    lastFocusedAt: 1
  }
}

const base = realpathSync(mkdtempSync(join(tmpdir(), 'yue-session-paths-')))
const root = join(base, 'library')
const oldRelative = join('sub', 'b.txt')
const movedRelative = join('moved', 'b.txt')
const bookPath = join(root, oldRelative)
const external = join(base, 'outside.txt')

mkdirSync(join(root, 'sub'), { recursive: true })
mkdirSync(join(root, 'moved'), { recursive: true })
writeFileSync(join(root, 'a.txt'), '《甲书》\n正文', 'utf8')
writeFileSync(bookPath, '《乙书》\n正文', 'utf8')
writeFileSync(external, '《库外》\n正文', 'utf8')

const dbFile = join(root, 'yueduo.db')
let db = openDatabase(dbFile)
activateDatabase(db, dbFile)
const now = Date.now()
db.prepare('INSERT INTO books (relative_path, created_at, updated_at) VALUES (?, ?, ?)').run(
  'a.txt',
  now,
  now
)
const bookId = Number(
  db
    .prepare('INSERT INTO books (relative_path, created_at, updated_at) VALUES (?, ?, ?)')
    .run(join('sub', 'b.txt'), now, now).lastInsertRowid
)

// 1) 落盘：库内相对路径 + book_id，库外绝对路径 + NULL，空白两者为空
persistSession(
  db,
  {
    activeTabId: 'tab-in',
    tabs: [tab('tab-in', bookPath), tab('tab-out', external), tab('tab-blank', '')]
  },
  root
)
const inRow = rowOf('tab-in')
assert(inRow.book_id === bookId, '库内标签落 book_id')
assert(inRow.path === 'sub/b.txt', `库内标签落相对路径（实际 ${inRow.path}）`)
const outRow = rowOf('tab-out')
assert(outRow.book_id === null, '库外标签 book_id 为 NULL')
assert(outRow.path === external, '库外标签仍落绝对路径')
const blankRow = rowOf('tab-blank')
assert(blankRow.book_id === null && blankRow.path === '', '空白标签两者都为空')

// 2) 恢复：相对路径拼回当前书库根，库外绝对路径原样
let session = loadSession(db, root)
const restoredIn = session.tabs.find((t) => t.id === 'tab-in')
const restoredOut = session.tabs.find((t) => t.id === 'tab-out')
const restoredBlank = session.tabs.find((t) => t.id === 'tab-blank')
assert(restoredIn?.path === bookPath && restoredIn.missing === false, '库内标签按书库根还原绝对路径')
assert(restoredOut?.path === external && restoredOut.missing === false, '库外标签按绝对路径还原')
assert(restoredBlank?.path === '' && restoredBlank.missing === false, '空白标签恢复为空路径')

// 3) 文件移动 + 对账改相对路径：恢复时按 book_id 跟随，不再依赖会话同步路径
renameSync(bookPath, join(root, movedRelative))
session = loadSession(db, root)
const missingIn = session.tabs.find((t) => t.id === 'tab-in')
assert(missingIn?.missing === true, '文件移走且未对账时标签标记缺失（不丢标签）')
assert(missingIn?.path === bookPath, '缺失标签保留原路径作为展示位置')
db.prepare('UPDATE books SET relative_path = ? WHERE id = ?').run(movedRelative, bookId)
session = loadSession(db, root)
const followed = session.tabs.find((t) => t.id === 'tab-in')
assert(
  followed?.path === join(root, movedRelative) && followed.missing === false,
  '对账更新 books.relative_path 后恢复直接跟到新路径'
)

// 4) 对账扫完的重试：按 book_id 把缺失标签接上
// 会话行里还是最初的 sub/b.txt + book_id；文件与 books 都已换到 moved/c.txt
renameSync(join(root, movedRelative), join(root, 'moved', 'c.txt'))
db.prepare('UPDATE books SET relative_path = ? WHERE id = ?').run(join('moved', 'c.txt'), bookId)
const relocated = relocateSessionTabs(db, root, ['tab-in', 'tab-blank'])
assert(relocated.length === 1, '重试只为重新找到文件的标签返回结果')
assert(
  relocated[0]?.tabId === 'tab-in' && relocated[0]?.path === join(root, 'moved', 'c.txt'),
  '重试按 book_id 拼出对账后的新路径'
)
session = loadSession(db, root)
assert(session.tabs.find((t) => t.id === 'tab-in')?.missing === false, '重试后恢复状态不再是缺失')

// 5) 库外文件丢失：标记缺失，且重试不会凭空造出结果
const ghost = join(base, 'ghost.txt')
persistSession(db, { activeTabId: 'tab-out', tabs: [tab('tab-ghost', ghost)] }, root)
const ghostRow = rowOf('tab-ghost')
assert(ghostRow.book_id === null && ghostRow.path === ghost, '库外缺失文件仍按绝对路径落盘')
session = loadSession(db, root)
assert(session.tabs.find((t) => t.id === 'tab-ghost')?.missing === true, '库外文件不存在时标记缺失')
assert(relocateSessionTabs(db, root, ['tab-ghost']).length === 0, '库外缺失标签重试无结果')

// 6) 历史行（绝对路径 + NULL）：按绝对路径打开，下次落盘自然写成新格式
db.prepare(
  `INSERT INTO session_tabs (id, position, book_id, path, title, dirty, last_focused_at)
   VALUES ('tab-legacy', 9, NULL, ?, '历史行', 0, ?)`
).run(join(root, 'a.txt'), now)
session = loadSession(db, root)
const legacy = session.tabs.find((t) => t.id === 'tab-legacy')
assert(
  legacy?.path === join(root, 'a.txt') && legacy.missing === false && legacy.bookId === null,
  '历史绝对路径行按原样恢复'
)
persistSession(db, { activeTabId: 'tab-legacy', tabs: [tab('tab-legacy', join(root, 'a.txt'))] }, root)
const legacyRow = rowOf('tab-legacy')
assert(
  legacyRow.path === 'a.txt' && legacyRow.book_id !== null,
  '历史行下次落盘自然写成相对路径 + book_id'
)

// 7) 草稿占位行：persist 还没跑过就卸载，也要按同一口径落库
writeDraft(
  db,
  'tab-draft',
  '未保存正文',
  null,
  { path: join(root, 'a.txt'), title: '甲书', progressLine: 3, lastFocusedAt: 2 },
  root
)
const draftRow = rowOf('tab-draft')
assert(
  draftRow.path === 'a.txt' && draftRow.book_id !== null,
  '草稿占位行同样写相对路径 + book_id'
)

// 8) 整个书库搬家：数据库随库走，会话按新书库根还原
persistSession(
  db,
  { activeTabId: 'tab-in', tabs: [tab('tab-in', join(root, 'moved', 'c.txt'))] },
  root
)
closeDatabase()
const movedRoot = join(base, 'library-moved')
renameSync(root, movedRoot)
const movedDbFile = join(movedRoot, 'yueduo.db')
db = openDatabase(movedDbFile)
activateDatabase(db, movedDbFile)
session = loadSession(db, movedRoot)
const movedTab = session.tabs.find((t) => t.id === 'tab-in')
assert(
  movedTab?.path === join(movedRoot, 'moved', 'c.txt') && movedTab.missing === false,
  '整库搬家后会话标签仍能在新位置打开'
)
assert(existsSync(movedTab?.path ?? ''), '搬家后的标签路径真实存在')

closeDatabase()
rmSync(base, { recursive: true, force: true })
console.log('ALL OK')
