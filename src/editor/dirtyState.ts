/**
 * O(1) 精确判脏状态机（与 Monaco getAlternativeVersionId() 数学同构）
 *
 * 通过 invertedEffects 在每次文档变更时向历史栈记录变更前的版本号；
 * 撤销时自动还原版本号，重做时自动恢复变更后版本号，规避 undoDepth 在
 * 500ms 输入合并和历史裁剪下的失效问题。
 */
import { invertedEffects, isolateHistory } from '@codemirror/commands'
import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

const setDocVersion = StateEffect.define<number>()

let versionSeq = 1

export const docVersionField: StateField<number> = StateField.define<number>({
  create: () => versionSeq++,
  update(value, tr) {
    let restored: number | undefined
    for (const effect of tr.effects) {
      if (effect.is(setDocVersion)) {
        restored = effect.value
      }
    }
    if (restored !== undefined) return restored
    if (tr.docChanged) return versionSeq++
    return value
  }
})

export const dirtyTrackingExtension: Extension = [
  docVersionField,
  invertedEffects.of((tr) =>
    tr.docChanged ? [setDocVersion.of(tr.startState.field(docVersionField))] : []
  )
]

export function currentDocVersion(state: EditorState): number {
  return state.field(docVersionField)
}

/** 保存后在激活视图上调用：隔离撤销历史并返回新的保存基线版本号 */
export function isolateAndCaptureBaseline(view: EditorView): number {
  view.dispatch({ annotations: isolateHistory.of('full') })
  return view.state.field(docVersionField)
}

/** 非当前标签离线保存时调用：返回隔离后的新 state 与新基线版本号 */
export function isolateStateBaseline(state: EditorState): { state: EditorState; baseline: number } {
  const nextState = state.update({ annotations: isolateHistory.of('full') }).state
  return {
    state: nextState,
    baseline: nextState.field(docVersionField)
  }
}
