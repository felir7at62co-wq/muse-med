/** Todo changes relative to the preceding recorded write. */
import type { ToolCallBlock } from './tool-call-model.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolDetailsModel } from '../components/ToolDetails.tsx'
import type { TodoBaseline } from './todo-history.ts'
import { todosDetail } from './details-card-model.ts'
import { parsedToolCall, singleResultText } from './raw-tool-call.ts'
import { detailJson, detailRecord } from './detail-model-shared.ts'

/**
 * Read a whole todo list without treating a partial update as the current plan.
 * @param block - Recorded or running todo call.
 * @param t - Conversation dictionary translator.
 * @returns Replacement arguments or a validated successful update result, otherwise null.
 */
export function todoListArgs(block: ToolCallBlock, t: TranslateNS<'conversation'>): Record<string, unknown> | null {
  const call = parsedToolCall(block)
  if (call?.name === 'todo_write') return call.args
  if (call?.name !== 'todo_update' || !('kind' in block) || block.isError) return null
  const text = singleResultText(block)
  const value = text === undefined ? undefined : detailJson(text)
  return detailRecord(value) && todosDetail(value, t) !== null ? value : null
}

/**
 * Compare this write with its predecessor in the loaded call history.
 * @param block - The write being displayed.
 * @param baseline - List recorded before this call, or undefined when its start is unavailable.
 * @param hasMore - Whether older unloaded history may contain a preceding list.
 * @param t - Conversation dictionary translator.
 * @returns Details and a change summary, or null for generic Tool output.
 */
export function todoDiffModel(
  block: ToolCallBlock,
  baseline: TodoBaseline | undefined,
  hasMore: boolean,
  t: TranslateNS<'conversation'>,
): { details: ToolDetailsModel; summary: string | null } | null {
  if (!('kind' in block) || block.isError) return null
  const args = todoListArgs(block, t)
  const current = args === null ? null : todosDetail(args, t)
  if (current === null) return null
  const previous: ToolDetailsModel | null = baseline?.todos === undefined ? null : { items: baseline.todos.map(todo => ({
    title: todo.content, status: { value: todo.status, label: t(`detail.todo.${todo.status}`) }, fields: [],
  })) }
  if (baseline === undefined || (previous === null && hasMore)) {
    return { details: { ...current, caption: t('todo.diff.unavailable') }, summary: null }
  }
  const previousByTitle = new Map(previous?.items.map(item => [item.title, item]))
  const currentTitles = new Set(current.items.map(item => item.title))
  const retainedPositions = new Map(previous?.items.filter(item => currentTitles.has(item.title)).map((item, index) => [item.title, index]))
  let retainedIndex = 0
  const items: ToolDetailsModel['items'][number][] = []
  const unchanged: ToolDetailsModel['items'][number][] = []
  let added = 0
  let updated = 0
  for (const item of current.items) {
    const before = previousByTitle.get(item.title)
    previousByTitle.delete(item.title)
    if (before === undefined) {
      added++
      items.push({ ...item, change: { value: 'added', label: t('todo.diff.addedItem') } })
    } else {
      const moved = retainedPositions.get(item.title) !== retainedIndex++
      const statusChanged = before.status?.value !== item.status?.value
      if (statusChanged || moved) {
        updated++
        items.push({
          ...item,
          ...statusChanged && before.status !== undefined ? { previousStatus: before.status.label } : {},
          change: { value: 'updated', label: t(statusChanged ? 'todo.diff.updatedItem' : 'todo.diff.movedItem') },
        })
      } else {
        unchanged.push(item)
      }
    }
  }
  for (const item of previousByTitle.values()) {
    items.push({ ...item, change: { value: 'removed', label: t('todo.diff.removedItem') } })
  }
  const summary = [
    added > 0 ? t('todo.diff.added', { count: added }) : null,
    updated > 0 ? t('todo.diff.updated', { count: updated }) : null,
    previousByTitle.size > 0 ? t('todo.diff.removed', { count: previousByTitle.size }) : null,
  ].filter(part => part !== null).join(' · ')
  return {
    summary: summary || t('todo.diff.noChanges'),
    details: {
      items,
      caption: t(previous === null ? 'todo.diff.initial' : 'todo.diff.compare'),
      empty: current.items.length === 0 && previous === null ? t('detail.todo.empty') : t('todo.diff.noChanges'),
      ...unchanged.length === 0 ? {} : { unchanged: { label: t('todo.diff.unchanged', { count: unchanged.length }), items: unchanged } },
    },
  }
}
