/**
 * 评分入口共用的「再点同分取消」手势（方案 §2.5，对齐 Python RatingClickTracker）：
 * 同一目标、同一分数连续点两次，且间隔超过双击间隔，才归零；
 * 首次点已有评分只重申该分数，快速双击的第二下不会误清。
 * 判定表放在模块级：标签列表改分后会重排/重建行，组件重建不影响手势。
 */
const CANCEL_INTERVAL = 500

interface Tracker {
  lastClicked: number
  lastAt: number
}

const trackers = new Map<string, Tracker>()

export function resolveRatingClick(key: string, current: number, clicked: number): number {
  const now = Date.now()
  const last = trackers.get(key)
  const cancel =
    clicked > 0 &&
    clicked === current &&
    last?.lastClicked === clicked &&
    now - (last?.lastAt ?? 0) > CANCEL_INTERVAL
  trackers.set(key, { lastClicked: clicked, lastAt: now })
  return cancel ? 0 : clicked
}
