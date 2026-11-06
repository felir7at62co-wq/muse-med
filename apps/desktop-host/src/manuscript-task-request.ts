/** Host-only reconstruction of the original user requests for a successfully bound manuscript task. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

const requestSchema = z.strictObject({ message_id: z.string().transform(MessageId),
  seq: z.number().int().nonnegative().transform(SessionSeq), text: z.string() })
const sequence = z.number().int().nonnegative().transform(SessionSeq)
const bindingSchema = z.strictObject({ task_key: z.string().min(1), binding_seq: sequence,
  initial: z.array(requestSchema), updates: z.array(requestSchema) })
const stateSchema = z.strictObject({ inherited_event_count: z.number().int().nonnegative().transform(SessionLogOffset),
  step_seq: sequence.nullable(), batch_step_seq: sequence.nullable(),
  latest_batch: z.array(requestSchema), unbound_initial: z.array(requestSchema), seen_message_ids: z.array(z.string().transform(MessageId)),
  pending_binds: z.array(z.strictObject({ call_id: z.string().transform(ToolCallId), task_key: z.string().min(1),
    initial: z.array(requestSchema), updates: z.array(requestSchema) })), active: bindingSchema.nullable() })
const bindArguments = z.object({ action: z.literal('bind'), task_key: z.string().min(1) })

/** Original text and identities reconstructed from committed user messages and successful task bindings. */
export type ManuscriptTaskRequestState = z.infer<typeof stateSchema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Real user requests for the active manuscript binding, omitted from client snapshots. */
    museManuscriptTaskRequests: ManuscriptTaskRequestState
  }
}

/** Host-only fold of child-owned events; failed bindings and synthetic notices never replace the task's original request. */
export const manuscriptTaskRequestProjection = {
  key: 'museManuscriptTaskRequests', stateSchema, stateVersion: 1,
  init: (_header, inheritedEventCount): ManuscriptTaskRequestState => ({ inherited_event_count: inheritedEventCount,
    step_seq: null, batch_step_seq: null, latest_batch: [], unbound_initial: [], seen_message_ids: [], pending_binds: [], active: null }),
  apply(state, event) {
    if (event.seq < state.inherited_event_count) return state
    switch (event.type) {
      case 'step/start': return { ...state, step_seq: event.seq }
      case 'user/message': {
        const message = event.data
        if (message.source.kind !== 'user' || state.seen_message_ids.includes(message.id)) return state
        const request = { message_id: message.id, seq: event.seq,
          text: message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') }
        return { ...state, batch_step_seq: state.step_seq,
          latest_batch: state.batch_step_seq === state.step_seq ? [...state.latest_batch, request] : [request],
          unbound_initial: state.active ? state.unbound_initial : [...state.unbound_initial, request],
          seen_message_ids: [...state.seen_message_ids, message.id],
          pending_binds: state.pending_binds.map(row => ({ ...row, updates: [...row.updates, request] })),
          active: state.active ? { ...state.active, updates: [...state.active.updates, request] } : null }
      }
      case 'tool/call': {
        if (event.data.name !== 'manuscript_work') return state
        let raw: unknown
        try { raw = JSON.parse(event.data.arguments) }
        catch (_error) { return state } // Malformed tool JSON cannot establish a task binding.
        const parsed = bindArguments.safeParse(raw)
        if (!parsed.success || state.pending_binds.some(row => row.call_id === event.data.callId)) return state
        return { ...state, pending_binds: [...state.pending_binds, { call_id: event.data.callId,
          task_key: parsed.data.task_key, initial: state.latest_batch, updates: [] }] }
      }
      case 'tool/result': {
        const pending = state.pending_binds.find(row => row.call_id === event.data.message.toolCallId)
        if (!pending) return state
        const pending_binds = state.pending_binds.filter(row => row !== pending)
        if (event.data.message.isError) return { ...state, pending_binds }
        const previous = state.active?.task_key === pending.task_key ? state.active : undefined
        const binding = state.active
        const initial = previous?.initial ?? (binding
          ? pending.initial.filter(row => row.seq > binding.binding_seq) : state.unbound_initial)
        const updates = previous?.updates ?? (binding ? pending.updates.filter(row => row.seq > binding.binding_seq) : [])
        return { ...state, pending_binds, unbound_initial: [], active: { task_key: pending.task_key, binding_seq: event.seq,
          initial, updates } }
      }
      default: return state // Other producers and compaction events do not author user requests.
    }
  },
} satisfies ProjectionDefinition<'museManuscriptTaskRequests', ManuscriptTaskRequestState>

/**
 * Quote the active task's original requests without truncation or semantic rewriting.
 * The returned text preserves initial question IDs and later user changes; it does
 * not ask the model to repeat binding or discard existing source-reading progress.
 * @param state - Current host projection, including any complete replay or restored cache.
 * @returns Task identity, a version for this binding generation and text, or undefined without an original user request.
 */
export function getManuscriptTaskRequest(state: ManuscriptTaskRequestState):
  { task_key: string; version: string; text: string } | undefined {
  if (!state.active || state.active.initial.length + state.active.updates.length === 0) return undefined
  const quote = (requests: typeof state.active.initial) => requests.map(({ seq, text }) => ({ seq, text }))
  const body = JSON.stringify({ task_key: state.active.task_key, binding_seq: state.active.binding_seq,
    initial: quote(state.active.initial), updates: quote(state.active.updates) })
  const text = '当前任务的原始用户请求引用。已有绑定、来源阅读和持久记录继续有效，不要因本段恢复重新bind或清空进度。'
    + 'initial保留首次绑定前的原始问题及ID，updates记录之后的用户要求；全部按原消息顺序，后续修改优先。'
    + '未被用户修改的题目不得自行替换、增造或重编号。'
    + '以下只引用原始消息中的文字，不代表重新提交一条用户消息。\n' + body
  return { task_key: state.active.task_key, version: createHash('sha256').update(text).digest('hex'), text }
}
