import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config } from '../src/config.js'
import { EvolutionRuntime } from '../src/runtime.js'
import { parseReview, reviewInput, REVIEW_SYSTEM, scrubEvidence } from '../src/reviewer.js'

function fixture(overrides = {}) {
  const config = { ...Config({ idleMs: 0, minToolCalls: 2, ...overrides }), skillsRoot: '/tmp/muse-generated-skills' }
  const records = new Map(), listeners = new Map(), proposals = [], modelCalls = [], applied = []
  let notifyStarted
  const started = new Promise(resolve => { notifyStarted = resolve })
  const route = { provider: 'fixture', model: 'source-model' }
  const session = { id: 'source', header: { cwd: '/tmp', delegationDepth: 0 }, requestHeader: () => ({ config: route }) }
  const rootAgent = { id: session.id, session, status: 'idle', model: { current: () => route } }
  const agents = new Map([[session.id, rootAgent]])
  const emit = (name, ...args) => { for (const listener of listeners.get(name) ?? []) listener(...args) }
  const ctx = {
    reflect: { provide() {} },
    logger: { warn() {} },
    on(name, listener) {
      const set = listeners.get(name) ?? new Set()
      listeners.set(name, set); set.add(listener)
      return () => { set.delete(listener) }
    },
    agents: {
      list: () => [...agents.values()], get: id => agents.get(id),
      async create(options) {
        const child = { id: options.sessionId, header: { ...options.meta } }
        const captured = { options, sections: [], restrictions: [], hooks: new Map(), input: null, disposed: false }
        modelCalls.push(captured)
        options.setup({ systemPrompt: { section: section => captured.sections.push(section) }, tools: { restrict: restriction => captured.restrictions.push(restriction) },
          on: (name, handler) => { captured.hooks.set(name, handler) } })
        const handle = {
          agent: {
            session: { ...child, deriveMessages: () => [{ role: 'assistant', content: [{ type: 'text', text: overrides.reply ?? JSON.stringify({ action: 'create',
              name: 'muse-learned-source-review', description: 'Review source evidence before editing', content: 'Read the original evidence and verify the final change against it.', why: 'The user corrected an unsupported inference.' }) }] }] },
            followup: input => { captured.input = input },
            whenIdle: async () => {
              if (overrides.holdReview) await new Promise(resolve => { captured.release = resolve; notifyStarted() })
              emit('session/event', child, { type: 'turn/end', data: { reason: { kind: captured.cancelled ? 'aborted' : 'completed' } } })
            },
            cancel: () => { captured.cancelled = true; captured.release?.() },
          },
          dispose: async () => { captured.disposed = true; await overrides.onChildDispose?.({ rootAgent, emit }) },
        }
        return handle
      },
    },
    sessions: { get: id => id === session.id ? session : undefined, flush: async () => true },
    skills: { snapshot: async () => ({ complete: true, skills: overrides.discoveredSkills ?? [] }),
      get: async name => (overrides.discoveredSkills ?? []).find(skill => skill.name === name) },
    sandboxPolicy: { resolve: () => ({ mode: overrides.sourceMode ?? 'danger-full-access' }) },
  }
  const store = {
    runs: () => [...records.values()], catalog: async () => overrides.catalog ?? [],
    proposals: () => proposals,
    recordRun: async record => { records.set(record.id, structuredClone(record)) },
    addProposal: async proposal => { const result = { ...proposal, id: 'proposal-' + proposals.length }; proposals.push(result); return result },
    apply: async id => { applied.push(id); return { state: 'applied' } },
  }
  const runtime = new EvolutionRuntime(ctx, { config, store })
  let sequence = 0
  const event = (type, data, target = session) => emit('session/event', target, { type, seq: sequence++, data })
  const completed = (turn = 1, reason = 'completed', toolCount = 2, target = session) => {
    event('turn/start', { turn }, target)
    event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'Please verify the original evidence before writing.' }] }, target)
    for (let n = 0; n < toolCount; n += 1) {
      event('tool/call', { name: 'read_file', callId: 'call-' + n }, target)
      event('tool/result', { message: { source: { callId: 'call-' + n }, isError: false } }, target)
    }
    event('assistant/message', { message: { content: [{ type: 'text', text: 'I verified the evidence and corrected the unsupported claim.' }] } }, target)
    event('turn/end', { turn, reason: { kind: reason } }, target)
  }
  const settle = async () => { await runtime.writes; runtime.timer?.ref(); await runtime.whenIdle() }
  return { config, ctx, runtime, completed, settle, records, proposals, modelCalls, applied, rootAgent, session, event, started }
}

test('rejects invalid configuration and incomplete or sensitive review proposals', () => {
  assert.throws(() => Config({ maxReviewsPerDay: -1 }))
  assert.throws(() => Config({ idleMs: 0.5 }))
  assert.deepEqual(parseReview('{"action":"none"}', Config({})), { action: 'none' })
  assert.throws(() => parseReview('{"action":"create","name":"other"}', Config({})))
  assert.throws(() => parseReview('{"action":"create","name":"muse-learned-api","description":"api_key=12345","content":"Do work","why":"Learned"}', Config({})))
  assert.equal(scrubEvidence('Bearer abcdef password=very-secret'), 'Bearer [redacted] password=[redacted]')
})

test('review evidence and catalog keep the complete authored input inside the budget', () => {
  const config = Config({ inputMaxChars: 4000 })
  const text = reviewInput({ source: { sessionId: 's', turn: 1 }, lines: ['User: Keep the correction.', 'X'.repeat(8000)] },
    [{ name: 'muse-learned-long', description: 'd', content: 'Y'.repeat(8000), owned: true }], config)
  assert.ok(REVIEW_SYSTEM.length + text.length <= 4000)
  assert.match(text, /Keep the correction/)
  assert.doesNotMatch(text, /Y{20}/)
})

test('completed root tool work creates a native logged reviewer with the original route and no tools', async t => {
  const f = fixture(); t.after(() => f.runtime.dispose())
  await f.runtime.start(); f.completed(); await f.settle()
  assert.equal(f.modelCalls.length, 1)
  const call = f.modelCalls[0]
  assert.equal(call.options.meta.parentSession, 'source')
  assert.equal(call.options.meta.origin, 'subagent')
  assert.equal(call.options.agentOptions.model, 'source-model')
  assert.equal(call.sections[0].complete, true)
  assert.deepEqual(call.restrictions, [{ allow: [], includeOwn: true }])
  assert.equal(call.disposed, true)
  assert.equal(call.input.source.kind, 'muse-skill-evolution')
  assert.match(call.input.content[0].text, /I verified the evidence/)
  assert.equal(f.proposals.length, 1)
  assert.equal(f.applied.length, 1)
  assert.equal([...f.records.values()][0].state, 'applied')
})

test('pure chat, failed or cancelled work and reviewer children do not trigger paid review', async t => {
  const f = fixture(); t.after(() => f.runtime.dispose())
  await f.runtime.start()
  f.completed(1, 'completed', 0); f.completed(2, 'error'); f.completed(3, 'aborted')
  f.completed(1, 'completed', 4, { id: 'muse-skill-review-child', header: { origin: 'subagent', delegationDepth: 1 } })
  await f.settle()
  assert.equal(f.modelCalls.length, 0)
  assert.equal(f.records.size, 0)
})

test('daily review cap and read-only source policy preserve proposals without automatic writes', async t => {
  const f = fixture({ maxReviewsPerDay: 1, sourceMode: 'read-only' }); t.after(() => f.runtime.dispose())
  await f.runtime.start(); f.completed(1); f.completed(2); await f.settle()
  assert.equal(f.modelCalls.length, 1)
  assert.equal(f.proposals.length, 1)
  assert.equal(f.applied.length, 0)
  assert.equal([...f.records.values()].filter(run => run.state === 'queued').length, 1)
})

test('active user work and unloading prevent scheduled reviews', async () => {
  const f = fixture()
  await f.runtime.start(); f.rootAgent.status = 'running'; f.completed(); await f.settle()
  assert.equal(f.modelCalls.length, 0)
  f.rootAgent.status = 'idle'; f.runtime.arm()
  await f.runtime.dispose()
  assert.equal(f.modelCalls.length, 0)
})

test('invalid model output remains a recorded failure and never switches to another route', async t => {
  const f = fixture({ reply: 'This is not a JSON proposal' }); t.after(() => f.runtime.dispose())
  await f.runtime.start(); f.completed(); await f.settle()
  assert.equal(f.modelCalls.length, 1)
  assert.equal(f.modelCalls[0].disposed, true)
  assert.equal(f.proposals.length, 0)
  assert.equal([...f.records.values()][0].state, 'failed')
})

test('reviewer admission refuses a second step after a hallucinated tool call', async t => {
  const f = fixture(); t.after(() => f.runtime.dispose())
  await f.runtime.start(); f.completed(); await f.settle()
  const admit = f.modelCalls[0].hooks.get('agent/pre-step')
  const next = async () => ({ kind: 'enter', messages: [{ role: 'user', content: [] }] })
  assert.equal((await admit({ step: 1 }, next)).kind, 'enter')
  assert.deepEqual(await admit({ step: 2 }, next), { kind: 'reject' })
  assert.deepEqual(await admit({ step: 3 }, next), { kind: 'reject' })
})

test('existing external Skills receive a baseline-bound proposal without automatic application', async t => {
  const f = fixture({ discoveredSkills: [{ name: 'existing-workflow', description: 'Use this workflow', content: 'Keep the original user requirement.' }],
    reply: JSON.stringify({ action: 'update', name: 'existing-workflow', description: 'Use this workflow', content: 'Keep the original user requirement and verify the final output.', why: 'The user required a final comparison.' }) })
  t.after(() => f.runtime.dispose())
  await f.runtime.start(); f.completed(); await f.settle()
  assert.match(f.proposals[0].baseHash, /^[a-f0-9]{64}$/u)
  assert.equal(f.applied.length, 0)
  assert.equal([...f.records.values()][0].state, 'proposed')
})

test('unload cancels the active native reviewer and awaits its disposal', async () => {
  const f = fixture({ holdReview: true })
  await f.runtime.start(); f.completed(); await f.runtime.writes
  f.runtime.timer.ref()
  await f.started
  assert.equal(f.modelCalls.length, 1)
  await f.runtime.dispose()
  assert.equal(f.modelCalls[0].cancelled, true)
  assert.equal(f.modelCalls[0].disposed, true)
  assert.equal(f.applied.length, 0)
  assert.equal([...f.records.values()][0].state, 'failed')
})

test('new root work during child disposal cancels the result before any Skill proposal or apply', async t => {
  const f = fixture({ onChildDispose: ({ rootAgent, emit }) => {
    rootAgent.status = 'running'
    emit('agent/status', { agent: rootAgent, status: 'running' })
  } })
  t.after(() => f.runtime.dispose())
  await f.runtime.start(); f.completed(); await f.settle()
  assert.equal(f.modelCalls.length, 1)
  assert.equal(f.modelCalls[0].disposed, true)
  assert.equal(f.proposals.length, 0)
  assert.equal(f.applied.length, 0)
  const result = [...f.records.values()][0]
  assert.equal(result.state, 'failed')
  assert.match(result.error, /cancelled/)
})
