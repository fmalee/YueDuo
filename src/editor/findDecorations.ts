/**
 * 视口裁剪查找高亮扩展
 *
 * 严禁对大文档全文命中挂载装饰：仅通过 ViewPlugin 对 view.visibleRanges
 * 做二分查找并裁剪挂载，保障百万字小说高频查找流畅。
 */
import {
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
  type StateEffectType
} from '@codemirror/state'
import {
  Decoration,
  ViewPlugin,
  type DecorationSet,
  type EditorView,
  type ViewUpdate
} from '@codemirror/view'

export interface FindHighlightRange {
  from: number
  to: number
}

export interface FindHighlightPayload {
  matches: readonly FindHighlightRange[]
  currentIndex: number
}

const EMPTY_PAYLOAD: FindHighlightPayload = {
  matches: [],
  currentIndex: -1
}

export const setFindHighlightEffect: StateEffectType<FindHighlightPayload> =
  StateEffect.define<FindHighlightPayload>()

export const clearFindHighlightEffect: StateEffectType<void> = StateEffect.define<void>()

const findHighlightField = StateField.define<FindHighlightPayload>({
  create: () => EMPTY_PAYLOAD,
  update(value, tr) {
    let next = tr.docChanged ? EMPTY_PAYLOAD : value
    for (const effect of tr.effects) {
      if (effect.is(clearFindHighlightEffect)) {
        next = EMPTY_PAYLOAD
      } else if (effect.is(setFindHighlightEffect)) {
        next = effect.value
      }
    }
    return next
  }
})

const matchMark = Decoration.mark({ class: 'yd-find-match' })
const currentMatchMark = Decoration.mark({ class: 'yd-find-match-current' })

function buildVisibleDecorations(view: EditorView): DecorationSet {
  const { matches, currentIndex } = view.state.field(findHighlightField)
  if (matches.length === 0) return Decoration.none

  const docLen = view.state.doc.length
  const builder = new RangeSetBuilder<Decoration>()
  let lastAddedIndex = -1

  for (const { from: vFrom, to: vTo } of view.visibleRanges) {
    let lo = Math.max(0, lastAddedIndex + 1)
    let hi = matches.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (matches[mid].to <= vFrom) {
        lo = mid + 1
      } else {
        hi = mid
      }
    }

    for (let i = lo; i < matches.length; i++) {
      const m = matches[i]
      if (m.from >= vTo) break
      if (m.from >= 0 && m.from < m.to && m.to <= docLen) {
        builder.add(m.from, m.to, i === currentIndex ? currentMatchMark : matchMark)
      }
      lastAddedIndex = i
    }
  }

  return builder.finish()
}

const findHighlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = buildVisibleDecorations(view)
    }

    update(update: ViewUpdate): void {
      const hasHighlightEffect = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(setFindHighlightEffect) || e.is(clearFindHighlightEffect))
      )
      if (update.viewportChanged || update.docChanged || hasHighlightEffect) {
        this.decorations = buildVisibleDecorations(update.view)
      }
    }
  },
  {
    decorations: (v) => v.decorations
  }
)

export const findDecorationsExtension: Extension = [findHighlightField, findHighlightPlugin]
