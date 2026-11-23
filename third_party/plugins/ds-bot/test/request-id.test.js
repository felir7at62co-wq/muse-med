import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { AgentModel, modelSelectionProjectionDefinition } from '@deepseek-ai/dsh-agent'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { install as installRequests } from '../src/host/requests.js'

let rt

test('old identities survive age and receipt volume without permitting another delivery', async () => {
  const rt = { state: {}, own: (object, key) => Object.hasOwn(object, key) ? object[key] : undefined, readOnly: () => undefined, save: async () => {}, warn() {} }
  installRequests(rt)
  const original = rt.requestIdentity({ caller: 'a', context: 'chat', name: 'original', payload: { message: 'do it' } })
  await rt.admitRequest(original, async () => 'first receipt')
  rt.state.requests[original.key].at = 0
  for (let i = 0; i < 2001; i += 1) rt.state.requests[`other-${i}`] = { at: i, outcome: 'delivered', fingerprint: 'x', receipt: 'kept' }
  const fresh = rt.requestIdentity({ caller: 'a', context: 'chat', name: 'fresh', payload: { message: 'next' } })
  await rt.admitRequest(fresh, async () => 'next receipt')
  const result = await rt.admitRequest(original, async () => { throw new Error('duplicate delivery') })
  assert.deepEqual(result, { status: 'replay', receipt: 'first receipt' })
})

// A two-Bot team, optionally with b in a group Session 'gb' of room 'Ops'.
function team({ group = false } = {}) {
  return {
    version: 1,
    mainBotIds: ['a'],
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
      b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    },
    rooms: group ? { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'a', named: true, sessions: { b: 'gb' } } } : {},
    agents: {},
    exchanges: [],
    exchangeTurns: {},
    works: {},
    questions: {},
    prefs: {},
    revision: 0,
  }
}

// The plugin in a home of its own, with a stand-in DSH around it. The seed is written the
// first time; a later boot keeps the state the first run saved.
async function boot(home, seed, { taskRouting, modelCatalog = {}, unavailable = [], rejectSelection, recordedEvents = {} } = {}) {
  if (seed !== undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  const ctx = fakeContext()
  const agents = new Map()
  const selections = []
  const archived = []
  let nextSession = 0
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const events = [...(recordedEvents[sessionId] ?? [])]
      let selection = events.reduce(modelSelectionProjectionDefinition.apply, modelSelectionProjectionDefinition.init())
      const session = {
        id: sessionId,
        requestHeader: () => undefined,
        append(type, data) {
          const event = { type, data }
          events.push(event)
          selection = modelSelectionProjectionDefinition.apply(selection, event)
        },
      }
      const model = new AgentModel(() => selection, session, {})
      agents.set(sessionId, {
        session,
        model,
        id: sessionId,
        calls,
        events,
        status: 'idle',
        followup(message) { calls.push(['followup', message, model.current()]) },
        steer(message) { calls.push(['steer', message]) },
        inject(message) { calls.push(['inject', message]) },
        cancel(cause) { calls.push(['cancel', cause]) },
        async whenIdle() {},
        async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
        inbox: {
          nextStep: [],
          nextTurn: [],
          remove(id) {
            for (const list of [this.nextStep, this.nextTurn]) {
              const at = list.findIndex(message => message.id === id)
              if (at !== -1) return list.splice(at, 1).length === 1
            }
            return false
          },
        },
      })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: {
      listProviders: () => Object.keys(modelCatalog).map(id => ({ id })),
      listModels: async provider => modelCatalog[provider] ?? [],
      resolveModelInfo: async (provider, id) => modelCatalog[provider]?.find(model => model.id === id) ?? {},
    },
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async id => { archived.push(id) },
    },
    sessionController: {
      create: async () => ({ sessionId: `s${++nextSession}` }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async (request) => {
        if (rejectSelection?.(request)) throw new Error('Model selection refused')
        selections.push(request)
        const selected = { provider: request.provider, model: request.model }
        agentOf(request.sessionId).model.select(selected)
        return { selected }
      },
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  rt = createRuntime(ctx, { home, taskRouting })
  if (unavailable.length > 0) rt.missingKeys = async () => new Set(unavailable)
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const tool = (name, args, sessionId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId } })
  const stop = async () => { await ctx.dispose() }
  // Loading once fills the Session-owner indexes turns.js filters events by.
  await tool('list_bots', {}, 'a')
  return { ctx, rt, agents, agentOf, emit, tool, stop, selections, archived }
}

// After a restart, a message its recipient never read is sent again on purpose (resume.js);
// what a repeated request adds is everything else.
const freshSends = agent => agent.calls.filter(([, message]) => !message?.content?.[0]?.text?.includes('restarted before it could reach you'))
const tempHome = () => mkdtempSync(join(tmpdir(), 'ds-bot-request-'))
const cleanup = home => rmSync(home, { recursive: true, force: true, maxRetries: 5 })

const taskRouting = { enabled: true, flash: 'test-flash/deepseek-v4.1-flash', pro: 'test-pro/deepseek-v4-pro' }
const modelCatalog = {
  'test-flash': [{ id: 'deepseek-v4.1-flash', inputModalities: ['text'], context: { contextWindow: 64000 } }],
  'test-pro': [{ id: 'deepseek-v4-pro', inputModalities: ['text'], context: { contextWindow: 128000 } }],
  'test-original': [{ id: 'worker-normal' }],
}
const taskArgs = (request_id, task_difficulty, routing_reason) => ({ to: 'Writer', message: `Work for ${request_id}`, when: 'queue', request_id, task_difficulty, routing_reason })

test('Main Bot selects Flash for routine work and Pro for difficult work while preserving its Worker’s other chats', async (t) => {
  const home = tempHome()
  const seed = team()
  seed.bots.b.model = 'test-original/worker-normal'
  seed.bots.b.appliedModel = seed.bots.b.model
  const { ctx, rt, agentOf, tool, stop, selections } = await boot(home, seed, { taskRouting, modelCatalog })
  t.after(async () => { await stop(); cleanup(home) })
  const worker = agentOf('b')
  worker.status = 'running'
  worker.inbox.nextTurn.push({ id: 'existing-work' })
  rt.live.set('b', { turn: 'previous-work' })
  const cards = await tool('list_bot_model_cards', {}, 'a')
  assert.match(cards, /routine: test-flash\/deepseek-v4\.1-flash.*Advertised input: text.*Context: 64000 tokens/)
  assert.match(cards, /advanced: test-pro\/deepseek-v4-pro.*Context: 128000 tokens/)
  assert.match(cards, /No benchmark data for this exact route/)
  assert.doesNotMatch(cards, /Bailian|Listed CNY|First text p50/)
  assert.match(ctx.sections.get('bot-identity').text({ agent: { id: 'a' } }), /Before assigning a new independent task.*list_bot_model_cards/)
  assert.doesNotMatch(ctx.sections.get('bot-identity').text({ agent: { id: 'b' } }), /list_bot_model_cards/)

  const argumentsForFlash = taskArgs('format-subtitles', 'routine', 'Apply a known subtitle format.')
  const flash = await tool('message_bot', argumentsForFlash, 'a')
  const pro = await tool('message_bot', taskArgs('compare-scripts', 'advanced', 'Reconcile conflicting plot details across scripts.'), 'a')
  assert.match(flash, /task session s1.*Selected model: test-flash\/deepseek-v4\.1-flash.*Reason: Apply a known subtitle format/)
  assert.match(pro, /task session s2.*Selected model: test-pro\/deepseek-v4-pro.*Reason: Reconcile conflicting plot details/)
  assert.deepEqual(selections, [
    { sessionId: 's1', provider: 'test-flash', model: 'deepseek-v4.1-flash', saveDefault: false },
    { sessionId: 's2', provider: 'test-pro', model: 'deepseek-v4-pro', saveDefault: false },
  ])
  assert.equal(rt.chatOf('b'), 'b')
  assert.equal(rt.botOf('b').model, 'test-original/worker-normal')
  assert.equal(worker.inbox.nextTurn[0].id, 'existing-work')
  assert.equal(worker.calls.length, 0)
  assert.equal(agentOf('s1').calls[0][0], 'followup')
  assert.equal(agentOf('s2').calls[0][0], 'followup')
  assert.deepEqual(agentOf('s1').events, [{ type: 'model/selection', data: { provider: 'test-flash', model: 'deepseek-v4.1-flash' } }])
  assert.deepEqual(agentOf('s2').events, [{ type: 'model/selection', data: { provider: 'test-pro', model: 'deepseek-v4-pro' } }])
  assert.deepEqual(agentOf('s2').calls[0][2], agentOf('s2').events[0].data)
  assert.equal(await tool('message_bot', argumentsForFlash, 'a'), flash)
  await assert.rejects(tool('message_bot', { ...argumentsForFlash, task_model: taskRouting.pro }, 'a'), /already used for a different request/)
  assert.equal(agentOf('s1').calls.length, 1)

  await rt.applyModel(rt.botOf('b'), { force: true })
  assert.deepEqual(selections.map(selection => selection.sessionId), ['s1', 's2', 'b'])
  await rt.switchPart('b', 's2')
  await tool('message_bot', { to: 'Writer', message: 'A separate message' }, 'a')
  assert.equal(worker.calls.length, 1)
  assert.equal(agentOf('s2').calls.length, 1)
})

test('Main Bot sees dated route-specific prices, latency, success counts and advertised thinking before dispatch', async (t) => {
  const home = tempHome()
  const { tool, stop } = await boot(home, team(), {
    taskRouting: { enabled: true },
    modelCatalog: {
      'muse-cloud-deepseek-flash-auto': [{
        id: 'deepseek-v4.1-flash', inputModalities: ['text'], context: { contextWindow: 128000 }, defaultMaxTokens: 8192,
        reasoning: { efforts: [{ id: 'off' }, { id: 'high' }], defaultEffort: 'high' },
      }],
      'muse-cloud-jubian-pro': [{ id: 'deepseek-v4-pro', inputModalities: ['text'] }],
    },
  })
  t.after(async () => { await stop(); cleanup(home) })
  const cards = await tool('list_bot_model_cards', {}, 'a')
  assert.match(cards, /routine: muse-cloud-deepseek-flash-auto\/deepseek-v4\.1-flash.*Context: 128000 tokens\. Default output budget: 8192 tokens\. Advertised thinking: off, high \(default high\)/)
  assert.match(cards, /Jubian \(deepseek-v4\.1-flash\).*peak 1\.2\/0\.024\/4\.8.*Peak rate matched 16 account debits/)
  assert.match(cards, /Streaming 16\/16 successful\. First text p50\/p95 533\/1354 ms, completion 581\/1440 ms\. Response reported deepseek-v4\.1-flash-1017 in 16\/16 requests/)
  assert.match(cards, /Bailian Beijing \(deepseek-v4\.1-flash-1017\).*peak 2\/0\.04\/8/)
  assert.match(cards, /Jubian \(deepseek-v4-pro\).*peak 9\/0\.3\/27/)
  assert.match(cards, /Rates checked 2026-11-22 PT/)
  assert.match(cards, /short text, thinking off, 64 output tokens maximum and no retries/)
  assert.match(cards, /The gateway selects Flash suppliers/)
  assert.equal([...cards.matchAll(/Screenplay quality \d+\/100 across 5\/5 scored tasks/g)].length, 3)
  assert.match(cards, /Screenplay quality 78\/100.*continuation between locked episodes 95/)
  assert.match(cards, /five paired synthetic Chinese Muse tasks with thinking off/)
  assert.match(cards, /0\/3 produced an answer at 1536 output tokens/)
})

test('a requested exact model takes priority and unavailable routes have explicit outcomes', async (t) => {
  const home = tempHome()
  const { rt, agentOf, tool, stop, selections } = await boot(home, team({ group: true }), { taskRouting, modelCatalog, unavailable: ['test-flash'] })
  t.after(async () => { await stop(); cleanup(home) })
  const cards = await tool('list_bot_model_cards', {}, 'a')
  assert.doesNotMatch(cards, /test-flash/)
  assert.match(cards, /test-pro/)
  assert.match(await tool('list_bot_model_cards', {}, 'b'), /Only Main Bots/)
  await assert.rejects(tool('message_bot', { ...taskArgs('permission', 'advanced', 'Worker cannot route.'), to: 'Chief' }, 'b'), /Only a Main Bot/)
  const group = rt.state.rooms.r1
  group.members.push('a')
  rt.groupOwners.set('ga', { botId: 'a', roomId: group.id })
  await assert.rejects(tool('message_bot', taskArgs('group', 'advanced', 'Group work.'), 'ga'), /Main Bot’s own chat/)

  assert.match(await tool('message_bot', taskArgs('fallback', 'routine', 'Routine work.'), 'a'), /uses its existing model/)
  assert.equal(agentOf('b').calls.length, 1)
  assert.match(await tool('message_bot', { ...taskArgs('missing', 'advanced', 'User requested Flash.'), task_model: taskRouting.flash }, 'a'), /unavailable/)
  assert.equal(agentOf('b').calls.length, 1)
  assert.match(await tool('message_bot', { ...taskArgs('manual', 'routine', 'Use the model the user requested.'), task_model: taskRouting.pro }, 'a'), /Selected model: test-pro\/deepseek-v4-pro/)
  assert.deepEqual(selections.map(selection => selection.model), ['deepseek-v4-pro'])
})

test('a task model selection failure delivers nothing and leaves its request free to retry', async (t) => {
  const home = tempHome()
  let fail = true
  const { agentOf, archived, tool, stop } = await boot(home, team(), { taskRouting, modelCatalog, rejectSelection: request => fail && request.saveDefault === false })
  t.after(async () => { await stop(); cleanup(home) })
  const args = taskArgs('retry-unselected', 'advanced', 'Complex work.')
  assert.match(await tool('message_bot', args, 'a'), /Task not delivered/)
  assert.deepEqual(archived, ['s1'])
  assert.equal(agentOf('s1').calls.length, 0)
  fail = false
  assert.match(await tool('message_bot', args, 'a'), /task session s2.*Selected model/)
  assert.equal(agentOf('s2').calls.length, 1)
})

test('a missed task delivery remains pinned to its Worker thread and a retry gets the original receipt', async (t) => {
  const home = tempHome()
  const first = await boot(home, team(), { taskRouting, modelCatalog })
  const args = taskArgs('restart-task', 'routine', 'Routine work.')
  const receipt = await first.tool('message_bot', args, 'a')
  await first.stop()
  const pending = JSON.parse(readFileSync(join(home, 'inflight.json'), 'utf8'))
  assert.equal(pending.queued.s1[0].args.taskThread, true)
  assert.equal(pending.queued.s1[0].args.sessionId, 's1')
  const second = await boot(home, undefined, { taskRouting, modelCatalog, recordedEvents: { s1: first.agentOf('s1').events } })
  t.after(async () => { await second.stop(); cleanup(home) })
  assert.equal(second.rt.botOf('b').openParts[0].taskModel, taskRouting.flash)
  assert.equal(second.rt.chatOf('b'), 'b')
  assert.equal(await second.tool('message_bot', args, 'a'), receipt)
  assert.equal(freshSends(second.agentOf('s1')).length, 0)
  for (let retry = 0; retry < 100 && second.agentOf('s1').calls.length === 0; retry += 1) await delay(50)
  assert.equal(second.agentOf('s1').calls.length, 1)
  assert.deepEqual(second.agentOf('s1').calls[0][2], { provider: 'test-flash', model: 'deepseek-v4.1-flash' })
  assert.equal(second.agentOf('b').calls.length, 0)
})

test('a request with an id is delivered once, and a repeat gives the first receipt back', async (t) => {
  const home = tempHome()
  const { agents, tool, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })

  const first = await tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  assert.equal(first, 'Delivered to Writer. Its reply will arrive later as a new message; do not wait for it.')
  assert.equal(agents.get('b').calls.length, 1)

  const again = await tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  assert.equal(again, first)
  assert.equal(agents.get('b').calls.length, 1)
})

test('the same request id with other content is refused, and nothing goes out', async (t) => {
  const seed = team()
  seed.bots.c = { id: 'c', name: 'Tester', role: 'Test', sessionId: 'c', createdAt: 3 }
  const home = tempHome()
  const { agents, tool, stop } = await boot(home, seed)
  t.after(async () => { await stop(); cleanup(home) })

  await tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  await assert.rejects(tool('message_bot', { to: 'Writer', message: 'do another thing', request_id: 'r-1' }, 'a'), /request_id "r-1" was already used for a different request/)
  assert.equal(agents.get('b').calls.length, 1)
  // Another target under the same name is another request, and is refused as well.
  await tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-2' }, 'c')
  await assert.rejects(tool('message_bot', { to: 'Chief', message: 'do the thing', request_id: 'r-2' }, 'c'), /request_id "r-2" was already used for a different request/)
  assert.equal(agents.get('a')?.calls.length ?? 0, 0)
})

test('two callers with the same request id do not collide', async (t) => {
  const seed = team()
  seed.bots.c = { id: 'c', name: 'Tester', role: 'Test', sessionId: 'c', createdAt: 3 }
  const home = tempHome()
  const { agents, tool, stop } = await boot(home, seed)
  t.after(async () => { await stop(); cleanup(home) })

  await tool('message_bot', { to: 'Writer', message: 'from Chief', request_id: 'r-1' }, 'a')
  await tool('message_bot', { to: 'Writer', message: 'from Tester', request_id: 'r-1' }, 'c')
  assert.equal(agents.get('b').calls.length, 2)
})

test('two calls at once with the same request id admit it once', async (t) => {
  const home = tempHome()
  const { agents, tool, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })

  const [first, second] = await Promise.all([
    tool('message_bot', { to: 'Writer', message: 'same request', request_id: 'r-1' }, 'a'),
    tool('message_bot', { to: 'Writer', message: 'same request', request_id: 'r-1' }, 'a'),
  ])
  assert.equal(first, second)
  assert.equal(agents.get('b').calls.length, 1)
})

test('a repeat after a restart gives the receipt back and sends nothing', async (t) => {
  const home = tempHome()
  const first = await boot(home, team())
  const receipt = await first.tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  await first.stop()

  const again = await boot(home)
  t.after(async () => { await again.stop(); cleanup(home) })
  const out = await again.tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  assert.equal(out, receipt)
  assert.equal(freshSends(again.agentOf('b')).length, 0)
})

test('a repeat after the recipient read the message does not send it again', async (t) => {
  const home = tempHome()
  const { agents, emit, tool, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })

  const first = await tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  const delivered = agents.get('b').calls[0][1]
  emit('b', 'user/message', { content: delivered.content, source: delivered.source })
  const again = await tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  assert.equal(again, first)
  assert.equal(agents.get('b').calls.length, 1)
})

test('a request whose delivery failed is not sent again', async (t) => {
  const home = tempHome()
  const { agentOf, tool, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })

  const writer = agentOf('b')
  const steer = writer.steer
  writer.steer = () => { throw new Error('dsh is down') }
  await assert.rejects(tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a'), /dsh is down/)
  writer.steer = steer
  // The outcome of that admission is not known, so it is not sent again.
  await assert.rejects(tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a'), /outcome of request_id "r-1" is not known/)
  assert.equal(writer.calls.length, 0)
})

test('a request with an id takes in the message before it, and a repeat merges nothing', async (t) => {
  const home = tempHome()
  const { agentOf, emit, tool, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })

  const writer = agentOf('b')
  writer.steer = (message) => { writer.calls.push(['steer', message]); writer.inbox.nextStep.push(message) }
  emit('b', 'turn/start', { turn: 1 })

  const first = await tool('message_bot', { to: 'Writer', message: 'task 1', request_id: 'r-1' }, 'a')
  const second = await tool('message_bot', { to: 'Writer', message: 'task 2', request_id: 'r-2' }, 'a')
  assert.match(second, /had not read your earlier message yet/)
  assert.equal(writer.inbox.nextStep.length, 1)

  const again = await tool('message_bot', { to: 'Writer', message: 'task 1', request_id: 'r-1' }, 'a')
  assert.equal(again, first)
  assert.equal(writer.inbox.nextStep.length, 1)
  assert.equal(writer.inbox.nextStep[0].source.exchangeId, writer.calls[0][1].source.exchangeId)
})

test('a request with an id that queues, or that answers the user, goes out once', async (t) => {
  const home = tempHome()
  const { agents, emit, tool, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })

  // Writer is working, so a request that waits for its current work is queued.
  emit('b', 'turn/start', { turn: 1 })
  const queued = await tool('message_bot', { to: 'Writer', message: 'later', when: 'queue', request_id: 'r-1' }, 'a')
  assert.match(queued, /^Queued for Writer/)
  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['followup'])
  assert.equal(await tool('message_bot', { to: 'Writer', message: 'later', when: 'queue', request_id: 'r-1' }, 'a'), queued)

  const toUser = await tool('message_bot', { to: 'Writer', message: 'tell them', reply_to: 'user', request_id: 'r-2' }, 'a')
  assert.match(toUser, /It will answer the user in its own chat/)
  assert.equal(await tool('message_bot', { to: 'Writer', message: 'tell them', reply_to: 'user', request_id: 'r-2' }, 'a'), toUser)
  assert.equal(agents.get('b').calls.length, 2)
})

test('a request with an id in a group calls the member once', async (t) => {
  const seed = team({ group: true })
  seed.rooms.r1.sessions.a = 'ga'
  const home = tempHome()
  const { rt, tool, stop } = await boot(home, seed)
  t.after(async () => { await stop(); cleanup(home) })

  let posts = 0
  rt.roomStepText = async () => { posts += 1 }
  const first = await tool('message_bot', { to: 'Writer', message: 'do it', request_id: 'r-1' }, 'ga')
  assert.match(first, /^Called Writer in "Ops"/)
  assert.equal(posts, 1)
  assert.equal(await tool('message_bot', { to: 'Writer', message: 'do it', request_id: 'r-1' }, 'ga'), first)
  assert.equal(posts, 1)
})

test('a request that was in the air when DS Bot stopped is not sent again', async (t) => {
  const home = tempHome()
  const first = await boot(home, team())
  // The delivery hangs, as it would when DS Bot stops in the middle of it.
  first.ctx.sessions.flush = async () => new Promise(() => {})
  const inFlight = first.tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  inFlight.catch(() => {})
  for (let count = 0; count < 200 && Object.keys(first.rt.state.requests).length === 0; count += 1) await delay(10)
  assert.equal(Object.keys(first.rt.state.requests).length, 1)
  assert.equal(Object.values(first.rt.state.requests)[0].outcome, 'pending')
  await first.stop()

  const again = await boot(home)
  t.after(async () => { await again.stop(); cleanup(home) })
  // The outcome of that admission is not known, so it is not sent again.
  await assert.rejects(again.tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a'), /outcome of request_id "r-1" is not known/)
  assert.equal(freshSends(again.agentOf('b')).length, 0)
})

test('a name whose receipt is no longer kept is not used again', async (t) => {
  const home = tempHome()
  const { rt, agents, tool, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })

  await tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  // The receipt falls out of what is kept; the name itself stays taken.
  for (const record of Object.values(rt.state.requests)) record.receipt = undefined
  const out = await tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  assert.match(out, /Nothing was sent again: request_id "r-1" was admitted before/)
  assert.equal(agents.get('b').calls.length, 1)
})

test('a request whose receipt cannot be saved is not sent', async (t) => {
  const home = tempHome()
  const { rt, agents, tool, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })

  const save = rt.save
  rt.save = async () => { throw new Error('the disk is full') }
  await assert.rejects(tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a'), /the disk is full/)
  assert.equal(agents.get('b')?.calls.length ?? 0, 0)
  // Nothing went out, so the name is free again.
  rt.save = save
  const out = await tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  assert.match(out, /^Delivered to Writer/)
  assert.equal(agents.get('b').calls.length, 1)
})

test('calls without a request id are sent as they were', async (t) => {
  const home = tempHome()
  const { agents, tool, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })

  await tool('message_bot', { to: 'Writer', message: 'one' }, 'a')
  await tool('message_bot', { to: 'Writer', message: 'two' }, 'a')
  assert.equal(agents.get('b').calls.length, 2)
})

test('the receipt of a request is kept in the team file', async (t) => {
  const home = tempHome()
  const { tool, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })

  await tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const receipts = Object.values(saved.requests)
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0].outcome, 'delivered')
  assert.match(receipts[0].receipt, /^Delivered to Writer/)
})

for (const reason of ['stopped', 'lock lost']) {
  test(`a named request is not delivered when its state save is skipped: ${reason}`, async (t) => {
    const home = tempHome()
    const host = await boot(home, team())
    t.after(async () => { await host.stop(); cleanup(home) })
    const args = { to: 'Writer', message: 'do the thing', request_id: 'r-1' }
    let attempt
    let closing
    if (reason === 'stopped') {
      attempt = host.tool('message_bot', args, 'a')
      // The call has started but has not reached admission when its host closes.
      closing = host.stop()
    } else {
      writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: 1, host: `${hostname()}-other`, token: 'other-writer', since: Date.now() }))
      attempt = host.tool('message_bot', args, 'a')
    }
    await assert.rejects(attempt, /cannot save|cannot be saved/i)
    await closing
    assert.equal(host.agentOf('b').calls.length, 0)
    assert.equal(Object.keys(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).requests ?? {}).length, 0)
  })
}
