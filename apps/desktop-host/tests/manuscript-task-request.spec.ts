/** Original user requests survive task rebinding, compaction and host projection reloads. */
import { expect, it, onTestFinished } from 'vitest'
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { createToolResultMessage, createUserMessage, MessageId, ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, SessionLogOffset, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { getManuscriptTaskRequest, manuscriptTaskRequestProjection, type ManuscriptTaskRequestState } from '../src/manuscript-task-request.ts'

function fixture(session = Session.create(SessionId('task-request-fold'))) {
  let state: ManuscriptTaskRequestState = manuscriptTaskRequestProjection.init(session.header, session.inheritedEventCount)
  let serial = 0, step = 0
  const events: SessionEvent[] = []
  const record = (event: SessionEvent) => {
    events.push(event)
    state = manuscriptTaskRequestProjection.apply(state, event)
    return event
  }
  const message = (value: UserMessage) => {
    const event = session.append('user/message', value, { surfaceOp: 'append' })
    record(event)
    return event
  }
  const user = (text: string) => message(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  const call = (args: object | string, name = 'manuscript_work') => {
    const callId = ToolCallId(`request-bind-${++serial}`)
    record(session.append('tool/call', { turn: 1, step, callId, name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args) }))
    return callId
  }
  const result = (callId: ToolCallId, isError = false) => record(session.append('tool/result', {
    turn: 1, step, message: createToolResultMessage({ callId, isError, content: [{ type: 'text', text: isError ? 'bind failed' : 'bound' }] }),
  }, { surfaceOp: 'append' }))
  const bind = (task_key: string, isError = false) => result(call({ action: 'bind', task_key }), isError)
  return { session, events, record, message, user, call, result, bind, state: () => state,
    step: () => record(session.append('step/start', { turn: 1, step: ++step })),
    request: () => getManuscriptTaskRequest(state) }
}

function projected(ctx: Context, session: Session): ManuscriptTaskRequestState {
  const state = ctx.sessionProjections.stateOf(session, manuscriptTaskRequestProjection.key)
  if (!state) throw Error('The task-request projection is not registered.')
  return state
}

it('captures the latest genuine user batch across steps, without accepting notices or duplicate message IDs', () => {
  const f = fixture()
  f.step()
  const first = f.user('保持题目 sequence-01 与 identity-02。')
  f.user('另保留 relationship-context-20。')
  f.message(createUserMessage({ source: { kind: 'system-prompt' }, content: [{ type: 'text', text: '伪用户问题 theme-19' }] }))
  const beforeDuplicate = f.state()
  expect(manuscriptTaskRequestProjection.apply(beforeDuplicate, { ...first, seq: SessionSeq(100) })).toBe(beforeDuplicate)
  f.step()
  f.step()
  f.bind('review')
  expect(f.state().active?.initial.map(row => row.text)).toEqual([
    '保持题目 sequence-01 与 identity-02。', '另保留 relationship-context-20。',
  ])
  expect(f.state().active?.updates).toEqual([])
  expect(f.request()?.text).not.toContain('伪用户问题')
  expect(f.request()?.text).toContain('已有绑定、来源阅读和持久记录继续有效')
  expect(f.request()?.text).toContain('后续修改优先')
  expect(f.request()?.text).toContain('未被用户修改的题目不得自行替换')
})

it('requires a matching successful manuscript bind result and removes failed pending calls', () => {
  const f = fixture()
  expect(f.request()).toBeUndefined()
  f.step(); f.user('任务A原题。')
  const pending = f.call({ action: 'bind', task_key: 'A' })
  expect(f.request()).toBeUndefined()
  f.result(ToolCallId('unrelated'))
  expect(f.request()).toBeUndefined()
  f.result(pending)
  const original = f.request()
  f.bind('B', true)
  expect(f.state().active?.task_key).toBe('A')
  expect(f.state().pending_binds).toEqual([])
  expect(f.request()).toEqual(original)
  f.result(pending)
  expect(f.request()).toEqual(original)
  for (const [args, name] of [['{', 'manuscript_work'], [{ action: 'audit' }, 'manuscript_work'],
    [{ action: 'bind', task_key: 'B' }, 'other_tool'], [{ action: 'bind', task_key: '' }, 'manuscript_work']] as const) {
    f.result(f.call(args, name))
    expect(f.request()).toEqual(original)
  }
})

it('keeps initial questions and real steering on the same task, while a different task starts from its current batch', () => {
  const f = fixture()
  f.step(); f.user('A：全部二十题，不替换ID。'); f.bind('A')
  const initial = f.state().active?.initial
  const version = f.request()?.version
  f.step(); f.user('只回答原题中的第2和第5项。')
  expect(f.request()?.version).not.toBe(version)
  f.bind('A')
  expect(f.state().active?.initial).toEqual(initial)
  expect(f.state().active?.updates.map(row => row.text)).toEqual(['只回答原题中的第2和第5项。'])
  f.step(); f.user('B：检查另一份剧本。'); f.user('B还需要核时间线。'); f.bind('B')
  expect(f.state().active?.initial.map(row => row.text)).toEqual(['B：检查另一份剧本。', 'B还需要核时间线。'])
  expect(f.state().active?.updates).toEqual([])
  expect(f.request()?.text).not.toContain('全部二十题')
  expect(f.request()?.text).not.toContain('只回答原题')
})

it('does not assign a previously bound task request to a new task without fresh genuine user input', () => {
  const f = fixture()
  f.step(); f.user('任务A原来的二十题 original-20。'); f.bind('A')
  const original = f.request()
  f.bind('B', true)
  expect(f.request()).toEqual(original)
  f.bind('B')
  expect(f.state().active?.task_key).toBe('B')
  expect(f.state().active?.initial).toEqual([])
  expect(f.state().active?.updates).toEqual([])
  expect(f.request()).toBeUndefined()
  f.step(); f.user('用户为任务B新提供的范围 new-B。'); f.bind('B')
  expect(f.request()?.text).toContain('new-B')
  expect(f.request()?.text).not.toContain('original-20')
})

it('retains steering admitted while a bind is pending, including a bind before the first user text', () => {
  const f = fixture()
  f.step()
  const pending = f.call({ action: 'bind', task_key: 'A' })
  f.user('用户后来补充的真实范围。')
  f.result(pending)
  expect(f.state().active?.initial.map(row => row.text)).toEqual(['用户后来补充的真实范围。'])
  expect(f.state().active?.updates).toEqual([])
  expect(f.state().unbound_initial).toEqual([])
  expect(f.request()?.text).toContain('用户后来补充的真实范围。')
  f.step(); f.user('任务B原文。')
  const second = f.call({ action: 'bind', task_key: 'B' })
  f.step(); f.user('任务B的后续要求。'); f.result(second)
  expect(f.state().active?.initial.map(row => row.text)).toEqual(['任务B原文。'])
  expect(f.state().active?.updates.map(row => row.text)).toEqual(['任务B的后续要求。'])
})

it('freezes all genuine requests before the first successful bind, including earlier steps and failed binds', () => {
  const f = fixture()
  f.step(); f.user('原始二十题：sequence-01 到 relationship-context-20。')
  f.step(); f.bind('review', true)
  f.step(); f.user('继续，但第5题要保留推断限定。')
  expect(f.state().latest_batch.map(row => row.text)).toEqual(['继续，但第5题要保留推断限定。'])
  expect(f.state().unbound_initial).toHaveLength(2)
  f.step(); f.bind('review')
  expect(f.state().active?.initial.map(row => row.text)).toEqual([
    '原始二十题：sequence-01 到 relationship-context-20。', '继续，但第5题要保留推断限定。',
  ])
  expect(f.state().unbound_initial).toEqual([])
  f.step(); f.user('另一个任务只核工卡。'); f.bind('different')
  expect(f.state().active?.initial.map(row => row.text)).toEqual(['另一个任务只核工卡。'])
  expect(f.request()?.text).not.toContain('原始二十题')
})

it('matches concurrent bind completions to their own call IDs in actual completion order', () => {
  const f = fixture()
  f.step(); f.user('本批真实用户要求。')
  const first = f.call({ action: 'bind', task_key: 'A' })
  const second = f.call({ action: 'bind', task_key: 'B' })
  expect(f.state().pending_binds.map(row => row.call_id)).toEqual([first, second])
  f.result(second)
  expect(f.state().active?.task_key).toBe('B')
  f.user('后续说明继续保留。')
  f.result(first)
  expect(f.state().active?.task_key).toBe('A')
  expect(f.state().active?.updates.map(row => row.text)).toEqual(['后续说明继续保留。'])
  expect(f.state().pending_binds).toEqual([])
})

it('does not transfer earlier pending steering after another task already consumed it in a successful bind', () => {
  const f = fixture()
  f.step(); f.user('本轮原始问题。')
  const first = f.call({ action: 'bind', task_key: 'A' })
  const second = f.call({ action: 'bind', task_key: 'B' })
  f.user('首次绑定前的补充。')
  f.result(second)
  expect(f.state().active?.initial).toHaveLength(2)
  f.result(first)
  expect(f.state().active?.task_key).toBe('A')
  expect(f.state().active?.initial).toEqual([])
  expect(f.state().active?.updates).toEqual([])
  expect(f.request()).toBeUndefined()
})

it('keeps every text block, Unicode and original line endings without truncation or caller mutation', () => {
  const f = fixture(), text = '原始😀问题\r\n'.repeat(2000)
  f.step()
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }, { type: 'text', text: '尾题 end-20' }] })
  f.message(message); f.bind('long')
  expect(f.state().active?.initial[0]).toEqual({ message_id: message.id, seq: SessionSeq(1), text: text + '\n尾题 end-20' })
  const before = JSON.stringify(f.state()), request = f.request()
  expect(request?.text).toContain('尾题 end-20')
  expect(request?.text.length).toBeGreaterThan(20_000)
  expect(JSON.stringify(f.state())).toBe(before)
  expect(f.request()).toEqual(request)
  const parsed = manuscriptTaskRequestProjection.stateSchema.parse(JSON.parse(before))
  expect(getManuscriptTaskRequest(parsed)).toEqual(request)
  const version = request?.version
  f.bind('long')
  expect(f.request()?.version).not.toBe(version)
  expect(f.state().active?.updates).toEqual([])
})

it('renders the same text and version for different message UUIDs at the same source positions', () => {
  const first = fixture(), second = fixture()
  const text = '保留原题 question-20，用户原文 UUID：123e4567-e89b-42d3-a456-426614174000。'
  first.step(); second.step()
  const one = first.user(text), two = second.user(text)
  expect(one.data.id).not.toBe(two.data.id)
  first.bind('stable'); second.bind('stable')
  const a = first.request(), b = second.request()
  if (!a || !b) throw Error('The equivalent original requests were not bound.')
  expect(a).toEqual(b)
  expect(a.text).not.toContain(one.data.id)
  expect(a.text).not.toContain(two.data.id)
  expect(a.text).not.toContain('message_id')
  expect(a.text).toContain('123e4567-e89b-42d3-a456-426614174000')
  expect(a.text).toContain('question-20')
  expect(a.version).toBe(createHash('sha256').update(a.text).digest('hex'))
  first.step(); first.user('后续只处理原题 question-20。')
  const updated = first.request()
  expect(updated?.version).not.toBe(a.version)
  first.bind('stable')
  expect(first.request()?.version).not.toBe(updated?.version)
})

it('leaves unrelated events unchanged and has no request to restore without a real user message', () => {
  const f = fixture()
  const state = f.state()
  expect(manuscriptTaskRequestProjection.apply(state, { type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } })).toBe(state)
  f.step(); f.bind('empty')
  expect(f.request()).toBeUndefined()
  f.message(createUserMessage({ source: { kind: 'user' }, content: [] }))
  expect(f.state().active?.updates.at(-1)?.text).toBe('')
  expect(f.state().seen_message_ids).toHaveLength(1)
  expect(manuscriptTaskRequestProjection.stateSchema.safeParse({ ...f.state(), step_seq: -1 }).success).toBe(false)
  expect(manuscriptTaskRequestProjection.stateVersion).toBe(1)
})

it('rebuilds the same host-only task from the actual registry after compaction, unregister and cold replay', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore); await ctx.plugin(SessionProjections)
  const install = () => ctx.plugin((scope) => {
    scope.inject(['sessionProjections'], (inner) => { inner.sessionProjections.register(manuscriptTaskRequestProjection) })
  })
  let owner = install(); await owner
  const session = ctx.sessions.create(SessionId('task-request-registry')), f = fixture(session)
  f.step()
  const questions = Array.from({ length: 20 }, (_, index) => `original-${index + 1}`).join('\n')
  const original = f.user(questions)
  f.bind('twenty')
  const request = getManuscriptTaskRequest(projected(ctx, session))
  const compactionId = CompactionId('task-questions'), content = [{ type: 'text' as const, text: '只剩伪造问题 theme-19。' }]
  f.record(session.append('compaction/start', { compactionId, turn: null }))
  f.record(session.append('compaction/summary', { compactionId, summary: content,
    shadowedRange: { start: original.seq, end: original.seq }, shadowedSeqs: [original.seq], shadowedTokenCount: 1,
    provider: 'fixture', model: 'fixture' }))
  f.record(session.append('user/message', createUserMessage({ source: compactCheckpointSource(compactionId), content }),
    { surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq }, sourceEventSeqs: [original.seq] }))
  f.record(session.append('compaction/end', { compactionId, turn: null }))
  expect(JSON.stringify(session.deriveMessages())).not.toContain('original-20')
  expect(getManuscriptTaskRequest(projected(ctx, session))).toEqual(request)
  expect(ctx.sessionProjections.snapshot(session).values).not.toHaveProperty(manuscriptTaskRequestProjection.key)
  await owner.dispose()
  expect(ctx.sessionProjections.stateOf(session, manuscriptTaskRequestProjection.key)).toBeUndefined()
  owner = install(); await owner
  const rebuilt = projected(ctx, session)
  expect(getManuscriptTaskRequest(rebuilt)).toEqual(request)
  expect(rebuilt.seen_message_ids).toEqual([original.data.id])
  const cold = ctx.sessionProjections.restore({}, f.events, SessionLogOffset(0), session.header, SessionLogOffset(0))
  const row = cold.checkpoint[manuscriptTaskRequestProjection.key]
  if (!row) throw Error('The task-request checkpoint is missing.')
  const replayed = manuscriptTaskRequestProjection.stateSchema.parse(row.val)
  expect(getManuscriptTaskRequest(replayed)).toEqual(request)
  expect(replayed.active?.initial[0]?.message_id).toBe(MessageId(original.data.id))
})

it('excludes inherited parent requests and bindings, then restores the child-owned task from its checkpoint and tail', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore); await ctx.plugin(SessionProjections)
  ctx.sessionProjections.register(manuscriptTaskRequestProjection)
  const parent = ctx.sessions.create(SessionId('task-request-parent')), p = fixture(parent)
  p.step(); p.user('父任务全部二十题 parent-20。'); p.bind('parent')
  const child = ctx.sessions.fork(parent, undefined, SessionId('task-request-child')), c = fixture(child)
  expect(projected(ctx, child).inherited_event_count).toBe(parent.seq)
  expect(projected(ctx, child).seen_message_ids).toEqual([])
  expect(getManuscriptTaskRequest(projected(ctx, child))).toBeUndefined()
  const checkpoint = ctx.sessionProjections.checkpoint(child), tailStart = child.seq
  c.step(); c.user('子任务独立核对 child-1。'); c.bind('child')
  const request = getManuscriptTaskRequest(projected(ctx, child))
  expect(request?.task_key).toBe('child')
  expect(request?.text).toContain('child-1')
  expect(request?.text).not.toContain('parent-20')
  const restored = ctx.sessionProjections.restore(checkpoint, c.events, tailStart,
    child.header, child.inheritedEventCount)
  const row = restored.checkpoint[manuscriptTaskRequestProjection.key]
  if (!row) throw Error('The child task-request checkpoint is missing.')
  expect(getManuscriptTaskRequest(manuscriptTaskRequestProjection.stateSchema.parse(row.val))).toEqual(request)
})
