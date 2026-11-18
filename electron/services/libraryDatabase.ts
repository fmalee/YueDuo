import { createHash } from 'crypto'
import { existsSync, mkdirSync, realpathSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import type { Database } from 'better-sqlite3'
import {
  activateDatabase,
  closeDatabase,
  initDatabase,
  openDatabase,
  swapDatabase
} from './database'
import { loadSession } from './sessionStore'
import type { LibraryOpenResult } from '../../shared/types'

/**
 * 每书库一个数据库（方案 §2.13 / §四）：
 * - 首选 `<书库根>/yueduo.db`，随库搬迁；根目录不可写时回落
 *   `<userData>/library-db/<书库根哈希>.db`（按库根隔离，避免两个书库共用一份库串数据）
 * - 换库顺序：prepare（建新库 + 读新会话，旧库不动）→ 调用方存档旧会话 → commit（切活动库）
 *   → 调用方恢复新会话；中止/失败时 abort 只关新库，原库仍可用
 * 纯 Node 实现（AGENTS.md：services 不 import Electron），userData 由调用方注入
 */

export interface LibraryDatabaseRuntime {
  root: string
  file: string
  db: Database
  fallback: boolean
}

export interface PreparedLibrary {
  result: LibraryOpenResult
  runtime: LibraryDatabaseRuntime | null
}

const DB_FILE = 'yueduo.db'

/** 书库根统一 realpath 后比较，且必须是目录（方案 §2.13 硬约束） */
export function resolveLibraryRoot(root: string): string {
  if (!root.trim()) throw new Error('尚未设置书库根目录')
  let resolved: string
  try {
    resolved = realpathSync(root)
  } catch {
    throw new Error(`书库目录不存在：${root}`)
  }
  if (!statSync(resolved).isDirectory()) {
    throw new Error(`书库路径不是目录：${resolved}`)
  }
  return resolved
}

/** 回落库文件名：按 realpath 哈希隔离，同一书库重启后仍命中同一份 */
function fallbackFile(userData: string, root: string): string {
  const hash = createHash('sha1').update(root).digest('hex').slice(0, 16)
  return join(userData, 'library-db', `${hash}.db`)
}

/** 建库失败时只清理本次新建的半成品，绝不删除用户原有的数据库 */
function removePartial(file: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(file + suffix)
    } catch {
      // 不存在或不可删：忽略，回落路径仍会继续尝试
    }
  }
}

function openAt(root: string, userData: string): LibraryDatabaseRuntime {
  const primary = join(root, DB_FILE)
  const existed = existsSync(primary)
  try {
    return { root, file: primary, db: openDatabase(primary), fallback: false }
  } catch (e) {
    if (existed) throw e
    removePartial(primary)
  }
  const dir = join(userData, 'library-db')
  mkdirSync(dir, { recursive: true })
  const file = fallbackFile(userData, root)
  try {
    return { root, file, db: openDatabase(file), fallback: true }
  } catch (e) {
    const suffix = e instanceof Error ? e.message : String(e)
    throw new Error(`书库数据库创建失败：${suffix}`, { cause: e })
  }
}

export class LibraryDatabaseManager {
  private active: LibraryDatabaseRuntime | null = null
  private pending: LibraryDatabaseRuntime | null = null

  constructor(private readonly userData: string) {}

  /**
   * 启动：按设置里的书库根打开对应库；根无效/库打不开时回落 userData 默认会话库，
   * 并把原因交给渲染层展示（不阻断启动，也不丢会话）。
   */
  init(root: string): { root: string; error: string; fallback: boolean } {
    if (!root) {
      initDatabase(this.userData)
      this.active = null
      return { root: '', error: '', fallback: false }
    }
    try {
      const resolved = resolveLibraryRoot(root)
      const runtime = openAt(resolved, this.userData)
      activateDatabase(runtime.db, runtime.file)
      this.active = runtime
      return { root: resolved, error: '', fallback: runtime.fallback }
    } catch (e) {
      initDatabase(this.userData)
      this.active = null
      return { root: '', error: e instanceof Error ? e.message : String(e), fallback: false }
    }
  }

  currentRoot(): string {
    return this.active?.root ?? ''
  }

  currentFallback(): boolean {
    return this.active?.fallback ?? false
  }

  /**
   * 建新库并读出它的会话；同一书库直接返回 switched=false。
   * 新库只建连接与迁移，旧库在 commit 前保持活动（可以继续存档旧会话）。
   */
  prepare(root: string): PreparedLibrary {
    // 先丢弃上一次未提交的准备结果（目录无效时也不会留下悬空连接）
    this.abort()
    const resolved = resolveLibraryRoot(root)
    if (this.active && this.active.root === resolved) {
      return {
        result: { root: resolved, switched: false, session: null, fallback: this.active.fallback },
        runtime: null
      }
    }
    const runtime = openAt(resolved, this.userData)
    try {
      const session = loadSession(runtime.db, runtime.root)
      this.pending = runtime
      return {
        result: { root: resolved, switched: true, session, fallback: runtime.fallback },
        runtime
      }
    } catch (e) {
      runtime.db.close()
      throw e
    }
  }

  /** 切活动库：先换引用再关旧连接；没有待切换库时抛错（渲染层据此保留原状态） */
  commit(): string {
    const target = this.pending
    if (!target) throw new Error('没有待切换的书库')
    this.pending = null
    const previous = swapDatabase(target.db, target.file)
    this.active = target
    try {
      previous?.close()
    } catch (e) {
      // 已切到新库，旧连接关不掉只影响文件句柄释放，不影响数据一致性
      console.warn('[library] 旧数据库关闭失败:', e)
    }
    return target.root
  }

  /** 放弃待切换的新库（存档失败/用户取消时）；活动库不受影响 */
  abort(): void {
    if (!this.pending) return
    const runtime = this.pending
    this.pending = null
    try {
      runtime.db.close()
    } catch {
      // 关闭失败不影响内存状态
    }
  }

  /** 退出前收尾：待切换库与活动库都关闭 */
  close(): void {
    this.abort()
    closeDatabase()
    this.active = null
  }
}
