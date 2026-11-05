import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config } from '../src/config.js'
import { EvolutionRuntime } from '../src/runtime.js'
import { parseReview, reviewInput, REVIEW_SYSTEM, scrubEvidence } from '../src/reviewer.js'
import { createEvolutionStore } from '../src/store.js'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function fixture(overrides = {}) {
  const config = { ...Config({ idleMs: 0, minToolCalls: 2, ...overrides }), skillsRoot: overrides.skillsRoot ?? '/tmp/muse-generated-skills' }
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
  const store = overrides.store ?? {
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
  return { config, ctx, runtime, completed, settle, records, proposals, modelCalls, applied, rootAgent, session, event, started, store }
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


const feedbackCandidate = { kind: 'suggestion', title: 'Summarize checked file results',
  observed: 'Task results separate the save and read checks.', expected: 'Present a compact verification summary.',
  steps: ['Save a file and inspect the read result.'], acceptance: ['The summary distinguishes a save from a verified match.'], evidenceRefs: [0] }
const skillCandidate = { action: 'create', name: 'muse-learned-feedback-verification', description: 'Verify saved output before reporting completion',
  content: 'Read saved text and compare it with the requested text before claiming a match.', why: 'The task checked the saved result.' }
const feedbackReceipt = { id: 'a'.repeat(32), revision: 1, deduplication: 'available' }

async function feedbackFixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'muse-feedback-runtime-'))
  const store = createEvolutionStore({ home: join(root, 'state'), skillsRoot: join(root, 'skills'), writable: () => true,
    maxSkillChars: 8000, maxDescriptionChars: 300, maxSkills: 20, maxRuns: 1000, maxProposals: 200, maxVersions: 1000 })
  let f
  t.after(async () => { await f?.beforeDispose?.(); await f?.runtime.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) })
  await store.ready()
  f = fixture({ ...overrides, store, skillsRoot: join(root, 'skills'), reply: JSON.stringify({ ...skillCandidate, feedback: feedbackCandidate, ...overrides.answer }) })
  return { ...f, root }
}

test('one native review applies real Skill bytes and posts a prior durable intent through the current account provider', async t => {
  const f = await feedbackFixture(t)
  const requests = []
  const close = f.runtime.attachFeedback({ async feedback(request) {
    const disk = JSON.parse(await readFile(join(f.root, 'state', 'state.json'), 'utf8'))
    const current = Object.values(disk.runs)[0]
    assert.equal(current.feedback.state, 'sending')
    assert.deepEqual(current.feedback.request, request)
    requests.push(request); return feedbackReceipt
  } })
  t.after(close)
  await f.runtime.start(); f.completed(); await f.settle()
  assert.equal(f.modelCalls.length, 1); assert.deepEqual(f.modelCalls[0].restrictions, [{ allow: [], includeOwn: true }])
  assert.match(await readFile(join(f.root, 'skills', skillCandidate.name, 'SKILL.md'), 'utf8'), /Read saved text/)
  const run = f.store.runs()[0]
  assert.equal(run.state, 'applied'); assert.equal(run.feedback.state, 'submitted'); assert.deepEqual(run.feedback.receipt, feedbackReceipt)
  assert.equal(requests.length, 1); assert.equal(requests[0].sessionId, f.session.id); assert.equal(requests[0].includeDiagnostics, false)
  assert.doesNotMatch(requests[0].text, /Please verify|PRIVATE/)
})

test('invalid optional feedback remains inspectably rejected while a valid Skill is actually applied', async t => {
  const f = await feedbackFixture(t, { answer: { feedback: { ...feedbackCandidate, observed: 'password=secret-value' } } })
  let posts = 0
  const close = f.runtime.attachFeedback({ async feedback() { posts += 1; return feedbackReceipt } }); t.after(close)
  await f.runtime.start(); f.completed(); await f.settle()
  const run = f.store.runs()[0]
  assert.equal(run.state, 'applied'); assert.deepEqual(run.feedbackProblem, { state: 'rejected', code: 'invalid-feedback' })
  assert.equal(run.feedback, undefined); assert.equal(posts, 0)
  assert.match(await readFile(join(f.root, 'skills', skillCandidate.name, 'SKILL.md'), 'utf8'), /Read saved text/)
  assert.doesNotMatch(JSON.stringify(run.feedbackProblem), /secret-value/)
})

test('feedback unknown and missing duplicate protection retain successful Skill results independently', async t => {
  for (const outcome of ['unknown', 'old-server']) {
    await t.test(outcome, async inner => {
      const f = await feedbackFixture(inner)
      const close = f.runtime.attachFeedback({ async feedback() {
        if (outcome === 'unknown') throw { code: 'muse-feedback/unconfirmed' }
        return { id: feedbackReceipt.id, revision: 1 }
      } }); inner.after(close)
      await f.runtime.start(); f.completed(); await f.settle()
      const run = f.store.runs()[0]
      assert.equal(run.state, 'applied')
      assert.equal(run.feedback.state, outcome === 'unknown' ? 'unknown' : 'submitted')
      if (outcome === 'old-server') assert.equal(run.feedback.receipt.deduplication, 'unavailable')
      else assert.equal(run.feedback.receipt, undefined)
    })
  }
})

test('absent account, opt-out and zero daily quota retain local feedback without calling the inbox', async t => {
  for (const mode of ['absent', 'disabled', 'quota']) {
    await t.test(mode, async inner => {
      const f = await feedbackFixture(inner, { ...(mode === 'disabled' ? { autoSubmitFeedback: false } : {}), ...(mode === 'quota' ? { maxFeedbackPerDay: 0 } : {}) })
      let posts = 0
      if (mode !== 'absent') inner.after(f.runtime.attachFeedback({ async feedback() { posts += 1; return feedbackReceipt } }))
      await f.runtime.start(); f.completed(); await f.settle()
      const run = f.store.runs()[0]
      assert.equal(run.state, 'applied'); assert.equal(run.feedback.state, mode === 'quota' ? 'limited' : 'proposed')
      assert.equal(posts, 0)
    })
  }
})

test('provider withdrawal and enclosing disposal await the original POST and persist its real receipt after cancellation', async t => {
  const f = await feedbackFixture(t)
  let started, release
  const entered = new Promise(resolve => { started = resolve })
  const response = new Promise(resolve => { release = resolve })
  f.beforeDispose = () => { release(feedbackReceipt) }
  const close = f.runtime.attachFeedback({ async feedback() { started(); return response } })
  await f.runtime.start(); f.completed(); const settled = f.settle(); await entered
  let withdrawn = false, disposed = false
  const withdrawing = close().then(() => { withdrawn = true })
  const disposing = f.runtime.dispose().then(() => { disposed = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(withdrawn, false); assert.equal(disposed, false)
  release(feedbackReceipt)
  await Promise.all([settled, withdrawing, disposing])
  assert.equal(withdrawn, true); assert.equal(disposed, true)
  const run = f.store.runs()[0]
  assert.equal(run.state, 'applied'); assert.equal(run.feedback.state, 'submitted'); assert.deepEqual(run.feedback.receipt, feedbackReceipt)
})

test('a valid feedback-only result survives Skill ownership rejection without applying unrelated files', async t => {
  const f = await feedbackFixture(t, { answer: { action: 'update', name: 'unowned-existing-skill' } })
  let posts = 0
  const close = f.runtime.attachFeedback({ async feedback() { posts += 1; return feedbackReceipt } }); t.after(close)
  await f.runtime.start(); f.completed(); await f.settle()
  const run = f.store.runs()[0]
  assert.equal(run.state, 'failed'); assert.equal(run.feedback.state, 'submitted'); assert.equal(posts, 1)
})
