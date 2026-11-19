import { syncMenuState } from '../menu'
import type { AppMenuState } from '../../shared/types'

/** app:syncMenuState —— 渲染层侧栏显隐变化（键盘或菜单）后回写应用菜单勾选 */
export function appSyncMenuState(state: AppMenuState): null {
  syncMenuState(state)
  return null
}
