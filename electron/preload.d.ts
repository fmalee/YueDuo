import type { YueBridge } from '../shared/types'

declare global {
  interface Window {
    yue: YueBridge
  }
}
