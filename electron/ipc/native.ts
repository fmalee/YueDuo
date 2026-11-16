import Database from 'better-sqlite3'
import type { NativeSanity } from '../../shared/types'

/** native:sanity —— 阶段 0 验收：主进程 bundle 里 external 的 better-sqlite3 真实可用 */
export function nativeSanity(): NativeSanity {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE t (a INTEGER)')
  db.prepare('INSERT INTO t VALUES (?)').run(42)
  const ok = db.prepare('SELECT a FROM t').get() as { a: number }
  db.close()
  if (ok.a !== 42) throw new Error('better-sqlite3 sanity 查询结果异常')
  return {
    betterSqlite3: '13.2.0 加载执行正常',
    electron: process.versions.electron,
    nodeAbi: process.versions.modules
  }
}
