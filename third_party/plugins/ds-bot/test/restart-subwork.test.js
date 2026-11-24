// A restart ends every subagent run of the process that started it. A Bot that handed
// work on to a run and waits for it must hear what became of that run once, after the
// start, and the answer it owes the Bot that asked it must still go up.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as realDelay } from 'node:timers/promises'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { answerSender } from '../src/host/turns.js'

// Chief asks Writer for work; Writer hands part of it to a subagent.
const seed = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

const started = new Map()

// One DS Bot host on `home`; a second start on the same home is a restart. `logs`: the
// durable Session logs DSH keeps, by Session; `unreadable` makes every log unreadable.
// `services`: DSH services the host can look up. `agentCtx`: the scope of each Agent.
async function start(home, { logs = new Map(), unreadable = false, services, agentCtx, warnings = [] } = {}) {
  const ctx = fakeContext({ services })
  ctx.logger.warn = (...args) => warnings.push(args.slice(1).join(' '))
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const keep = (message) => { calls.push(message) }
      agents.set(sessionId, {
        id: sessionId,
        session: { id: sessionId },
        calls,
        inbox: { nextStep: [], nextTurn: [], remove: () => false },
        followup: keep,
        steer: keep,
        cancel() {},
        ...(agentCtx === undefined ? {} : { ctx: agentCtx(sessionId) }),
      })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      inspect: async (sessionId) => {
        if (unreadable) throw new Error('session not found')
        return { events: logs.get(sessionId) ?? [] }
      },
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener(agents.get(id)?.session ?? { id }, { type, seq: ++seq, data })
    }
  }
  // Subagent lifecycle and tool results reach the plugin through a carrier DSH keys by
  // the Agent the event is for.
  const emitScoped = (parentId, name, ...args) => {
    const carrier = scopeTarget({}, agentOf(parentId))
    for (const listener of ctx.listeners.get(name) ?? []) listener.call(carrier, ...args)
  }
  const tool = (name, args, sessionId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId } })
  await tool('list_bots', {}, 'a')
  const host = { rt, ctx, agentOf, emit, emitScoped, tool, warnings, stop: () => ctx.dispose() }
  started.set(home, [...(started.get(home) ?? []), host])
  return host
}

const freshHome = (t, state = seed()) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-restart-subwork-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  t.after(async () => {
    await Promise.all((started.get(home) ?? []).map(host => host.stop()))
    started.delete(home)
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  return home
}
const stateOf = home => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
const notes = (home) => {
  try { return JSON.parse(readFileSync(join(home, 'inflight.json'), 'utf8')) } catch { return { turns: {}, queued: {} } }
}
// The team file is written in the background: the wait ticks the mocked clock, and
// gives the file writes real time.
const settleState = async (t, check) => {
  const deadline = performance.now() + 10_000
  while (!check() && performance.now() < deadline) {
    t.mock.timers.tick(100)
    await realDelay(5)
  }
  assert.ok(check(), 'condition not reached')
}
const settle = async (check) => {
  const deadline = performance.now() + 10_000
  while (!check() && performance.now() < deadline) await new Promise(resolve => setImmediate(resolve))
  assert.ok(check(), 'condition not reached')
}
// Long enough for anything the host would still send to arrive.
const idle = () => realDelay(100)
const text = message => message.content.map(block => block.text ?? '').join('\n')
const said = (host, id, turn, words) => {
  host.emit(id, 'assistant/message', { message: { content: [{ type: 'text', text: words }] } })
  host.emit(id, 'turn/end', { turn, reason: { kind: 'completed' } })
}
// A message as DSH would replay it: the turn starts and takes it up.
const run = (host, sessionId, turn, message) => {
  host.emit(sessionId, 'turn/start', { turn })
  host.emit(sessionId, 'user/message', { content: message.content, source: message.source })
}

// Chief asks Writer; Writer's turn hands episode 3 to a subagent and, unless `end` is
// false, ends while the subagent works.
async function delegate(host, { end = true } = {}) {
  await host.tool('message_bot', { to: 'Writer', message: 'Transcribe episode 3' }, 'a')
  const request = host.agentOf('b').calls[0]
  run(host, 'b', 1, request)
  const args = { description: 'episode 3', prompt: 'transcribe episode 3' }
  host.emit('b', 'tool/call', { callId: 'call1', name: 'subagent', arguments: JSON.stringify(args) })
  host.emitScoped('b', 'subagent/start', { runId: 'r1', provider: 'spawn', parentSessionId: 'b', id: 'sub1', local: true })
  host.emitScoped('b', 'tools/result', { callId: 'call1', name: 'subagent', arguments: args, agent: host.agentOf('b') }, { isError: false, value: { kind: 'activation', subagentId: 'sub1' } })
  host.emit('b', 'tool/result', { callId: 'call1', message: { callId: 'call1', content: [{ type: 'text', text: 'started subagent sub1' }], isError: false } })
  if (end) said(host, 'b', 1, 'The helper is on it.')
  return request
}

// The subagent's own log: an earlier run of the same child, then this run's turn, which
// says `words` and ends with `reason` (none: the restart cut it off).
const childLog = (at, words, reason) => [
  { type: 'turn/start', seq: 1, time: at - 60_000, data: { turn: 1 } },
  { type: 'assistant/message', seq: 2, time: at - 59_000, data: { message: { content: [{ type: 'text', text: 'an earlier run' }] } } },
  { type: 'turn/end', seq: 3, time: at - 58_000, data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'turn/start', seq: 4, time: at + 10, data: { turn: 2 } },
  { type: 'assistant/message', seq: 5, time: at + 20, data: { message: { content: [{ type: 'text', text: words }] } } },
  ...(reason === undefined ? [] : [{ type: 'turn/end', seq: 6, time: at + 30, data: { turn: 2, reason } }]),
]

const HEADER = '[DeepSeek Harness restarted · work you handed on · for the work Chief asked you for; your answer goes to Chief once everything you handed on is back]'

// Writer goes on after the notice, and Chief reads the answer that goes up; a third
// start then finds nothing to settle or send.
async function goesOnOnce(t, home, second, notice, logs, check) {
  run(second, 'b', 2, notice)
  said(second, 'b', 2, 'Episode 3 is done.')
  await settle(() => second.agentOf('a').calls.length === 1)
  const answer = second.agentOf('a').calls[0]
  assert.equal(answer.source.replyTo, notice.source.work)
  assert.match(text(answer), /Episode 3 is done\./)
  check(text(answer))
  run(second, 'a', 1, answer)
  said(second, 'a', 1, 'Thanks.')
  await settleState(t, () => Object.keys(notes(home).queued ?? {}).length === 0 && Object.keys(notes(home).turns ?? {}).length === 0
    && stateOf(home).works?.[notice.source.work] === undefined)
  await second.stop()
  const third = await start(home, { logs })
  t.mock.timers.tick(3000)
  await idle()
  assert.deepEqual([third.agentOf('a').calls.length, third.agentOf('b').calls.length], [0, 0])
}

for (const [label, cutOff] of [
  ['its turn never ended', { log: at => childLog(at, 'half of episode 3') }],
  ['its log cannot be read', { unreadable: true }],
]) {
  test(`a subagent run a restart cut off is settled once when ${label}: Writer is told, and its answer still goes up`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const home = freshHome(t)
    const logs = new Map()
    const first = await start(home, { logs })
    const request = await delegate(first)
    const workId = request.source.exchangeId
    assert.match(first.rt.statusOf('b'), /waiting for subagent episode 3 to hand back work, for Chief/)
    // A run this process started is not one a restart left.
    await settleState(t, () => stateOf(home).works?.r1 !== undefined)
    assert.equal(first.agentOf('b').calls.length, 1)
    if (cutOff.log) logs.set('sub1', cutOff.log(stateOf(home).works.r1.at))
    await first.stop()

    const second = await start(home, { logs, unreadable: cutOff.unreadable })
    t.mock.timers.tick(3000)
    await settle(() => second.agentOf('b').calls.length === 1)
    const notice = second.agentOf('b').calls[0]
    assert.equal(text(notice), `${HEADER}\nA restart cut off subagent episode 3; its result is unknown.\nCheck what is already on disk before you redo any of it.`)
    assert.deepEqual([notice.source.role, notice.source.work], ['reply', workId])
    // The wait is over in the team file and in the status line; nothing goes to Chief
    // yet, and the request is not sent again.
    await settleState(t, () => stateOf(home).works?.r1 === undefined)
    const work = stateOf(home).works[workId]
    assert.deepEqual(work.open, [])
    assert.deepEqual(work.results.map(result => [result.name, result.text]), [['subagent episode 3', 'Cut off by a DeepSeek Harness restart; its result is unknown.']])
    assert.doesNotMatch(second.rt.statusOf('b'), /hand back work/)
    await idle()
    assert.deepEqual([second.agentOf('a').calls.length, second.agentOf('b').calls.length], [0, 1])

    await goesOnOnce(t, home, second, notice, logs, (answer) => {
      assert.match(answer, /subagent episode 3:\nCut off by a DeepSeek Harness restart; its result is unknown\./)
    })
  })
}

test('a subagent run that finished but never handed back delivers its answer once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const logs = new Map()
  const first = await start(home, { logs })
  const request = await delegate(first)
  await settleState(t, () => stateOf(home).works?.r1 !== undefined)
  logs.set('sub1', childLog(stateOf(home).works.r1.at, 'Episode 3 is in ep03.md.', { kind: 'completed' }))
  await first.stop()

  const second = await start(home, { logs })
  t.mock.timers.tick(3000)
  await settle(() => second.agentOf('b').calls.length === 1)
  const notice = second.agentOf('b').calls[0]
  assert.equal(text(notice), `${HEADER}\nsubagent episode 3 ended before the restart, and its result never reached you:\nEpisode 3 is in ep03.md.`)
  await settleState(t, () => stateOf(home).works?.r1 === undefined)
  assert.deepEqual(stateOf(home).works[request.source.exchangeId].results.map(result => result.text), ['Episode 3 is in ep03.md.'])

  await goesOnOnce(t, home, second, notice, logs, (answer) => {
    assert.match(answer, /subagent episode 3:\nEpisode 3 is in ep03\.md\./)
    assert.doesNotMatch(answer, /an earlier run/)
  })
})

test('a result that came back but was never read reaches the Bot that waited, once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const state = seed()
  state.works = { x1: { from: 'a', to: 'b', open: ['r1'], results: [{ id: 'r1', name: 'subagent episode 3', child: 'sub1', session: 'b', text: 'Episode 3 is in ep03.md.', at: 1 }], at: 1 } }
  const home = freshHome(t, state)
  const second = await start(home)
  t.mock.timers.tick(3000)
  await settle(() => second.agentOf('b').calls.length === 1)
  const notice = second.agentOf('b').calls[0]
  assert.equal(text(notice), `${HEADER}\nsubagent episode 3 ended before the restart, and its result never reached you:\nEpisode 3 is in ep03.md.`)
  await settleState(t, () => stateOf(home).works?.x1?.open.length === 0)
  await goesOnOnce(t, home, second, notice, new Map(), (answer) => {
    assert.match(answer, /subagent episode 3:\nEpisode 3 is in ep03\.md\./)
  })
})

test('a Writer turn the restart cut off is picked up with what became of its subagent run, in one message', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const logs = new Map()
  const first = await start(home, { logs })
  const request = await delegate(first, { end: false })
  await settleState(t, () => stateOf(home).works?.r1 !== undefined && notes(home).turns?.b?.trigger !== undefined)
  logs.set('sub1', childLog(stateOf(home).works.r1.at, 'half of episode 3'))
  await first.stop()

  const second = await start(home, { logs })
  t.mock.timers.tick(3000)
  await settle(() => second.agentOf('b').calls.length === 1)
  await idle()
  assert.equal(second.agentOf('b').calls.length, 1)
  const resumed = second.agentOf('b').calls[0]
  assert.deepEqual([resumed.source.role, resumed.source.exchangeId, resumed.source.resumed], ['request', request.source.exchangeId, true])
  assert.match(text(resumed), /^\[Message from Chief · DeepSeek Harness restarted while you were working on it\]/)
  assert.match(text(resumed), /\nA restart cut off subagent episode 3; its result is unknown\.\nCheck what is already on disk before you redo any of it\.$/)
  await settleState(t, () => stateOf(home).works?.r1 === undefined)
  assert.deepEqual(stateOf(home).works[request.source.exchangeId].open, [])
})

test('a subagent run whose child is still resident is left to hand back by itself', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const logs = new Map()
  const first = await start(home, { logs })
  await delegate(first)
  await settleState(t, () => stateOf(home).works?.r1 !== undefined)
  await first.stop()

  // Only DS Bot reloaded: DSH still has the child.
  const second = await start(home, { logs, services: { agents: { get: id => (id === 'sub1' ? { id } : undefined) } } })
  t.mock.timers.tick(3000)
  await idle()
  assert.equal(second.agentOf('b').calls.length, 0)
  assert.notEqual(stateOf(home).works.r1, undefined)
  assert.match(second.rt.statusOf('b'), /waiting for subagent episode 3 to hand back work/)
})

// Writer takes Chief's request up and has said part of its answer when its turn stops.
async function stoppedWriter(host, home, reason) {
  await host.tool('message_bot', { to: 'Writer', message: 'Draft the plan' }, 'a')
  const request = host.agentOf('b').calls[0]
  run(host, 'b', 1, request)
  host.emit('b', 'assistant/message', { message: { content: [{ type: 'text', text: 'Half of the plan.' }] } })
  host.emit('b', 'turn/end', { turn: 1, reason })
  return request
}

test('a request turn stopped by a shutdown is answered once, by the turn the next start picks up', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const first = await start(home)
  const request = await stoppedWriter(first, home, { kind: 'aborted', reason: { kind: 'disposed' } })
  const workId = request.source.exchangeId
  // Chief is not told now, and the work stays open for the pick-up.
  await settleState(t, () => notes(home).turns?.b?.trigger?.exchangeId === workId && stateOf(home).works?.[workId] !== undefined)
  await idle()
  assert.equal(first.agentOf('a').calls.length, 0)
  await first.stop()

  const second = await start(home)
  t.mock.timers.tick(3000)
  await settle(() => second.agentOf('b').calls.length === 1)
  const resumed = second.agentOf('b').calls[0]
  assert.deepEqual([resumed.source.role, resumed.source.exchangeId, resumed.source.resumed], ['request', workId, true])
  assert.equal(second.agentOf('a').calls.length, 0)
  run(second, 'b', 2, resumed)
  said(second, 'b', 2, 'The plan is ready.')
  await settle(() => second.agentOf('a').calls.length === 1)
  await idle()
  assert.equal(second.agentOf('a').calls.length, 1)
  const answer = second.agentOf('a').calls[0]
  assert.equal(answer.source.replyTo, workId)
  assert.match(text(answer), /The plan is ready\./)
  assert.doesNotMatch(text(answer), /stopped before it could answer/)
})

test('a picked-up request turn stopped by a shutdown again tells Chief, since it is not picked up twice', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const first = await start(home)
  const request = await stoppedWriter(first, home, { kind: 'aborted', reason: { kind: 'disposed' } })
  await settleState(t, () => notes(home).turns?.b?.trigger?.exchangeId === request.source.exchangeId)
  await first.stop()

  const second = await start(home)
  t.mock.timers.tick(3000)
  await settle(() => second.agentOf('b').calls.length === 1)
  run(second, 'b', 2, second.agentOf('b').calls[0])
  second.emit('b', 'turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'disposed' } } })
  await settle(() => second.agentOf('a').calls.length === 1)
  assert.equal(second.agentOf('a').calls[0].source.replyTo, request.source.exchangeId)
  assert.match(text(second.agentOf('a').calls[0]), /^\[Reply from Writer\]\nWriter was stopped before it could answer your message\.$/)
})

test('a request turn the user stops is answered at once, and its work closes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const host = await start(home)
  const request = await stoppedWriter(host, home, { kind: 'aborted', reason: { kind: 'user' } })
  await settle(() => host.agentOf('a').calls.length === 1)
  const answer = host.agentOf('a').calls[0]
  assert.deepEqual([answer.source.role, answer.source.replyTo], ['reply', request.source.exchangeId])
  assert.match(text(answer), /Half of the plan\./)
  await settleState(t, () => stateOf(home).works?.[request.source.exchangeId] === undefined && notes(home).turns?.b === undefined)
})

test('a reply to a Bot whose Agent is closing still goes out', async (t) => {
  const state = seed()
  state.capabilities = { items: { guide: { name: 'guide', kind: 'skill', description: 'Guide', content: 'Do the work.', createdBy: null, createdAt: 1, updatedAt: 1 } } }
  state.bots.a.capabilities = ['guide']
  const home = freshHome(t, state)
  const closing = () => Object.assign(new Error('cannot create effect on inactive context'), { code: 'INACTIVE_EFFECT' })
  const refuse = () => { throw closing() }
  const host = await start(home, { agentCtx: () => ({ effect: refuse, on: refuse, plugin: refuse, tools: { register: refuse } }) })
  answerSender(host.rt, 'b', { senderSessionId: 'a', exchangeId: 'x1' }, 'The plan is ready.')
  await settle(() => host.agentOf('a').calls.length === 1)
  assert.match(text(host.agentOf('a').calls[0]), /The plan is ready\./)
  assert.ok(host.warnings.some(line => line.includes('capabilities not mounted for a: its Agent is closing')), host.warnings.join('\n'))
  assert.ok(!host.warnings.some(line => line.includes('reply delivery failed')), host.warnings.join('\n'))
})
