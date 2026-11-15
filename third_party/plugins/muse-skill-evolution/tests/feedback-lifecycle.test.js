import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import * as evolution from '../src/index.js'

const fixtureTimeoutMs = 60_000
const receipt = { id: 'a'.repeat(32), revision: 1, deduplication: 'available' }
const candidate = { kind: 'suggestion', title: 'Retain checked task results',
  observed: 'Verification facts are shown separately.', expected: 'Present verification facts together.',
  steps: ['Complete a file verification.'], acceptance: ['The saved result and verification are distinguishable.'], evidenceRefs: [0] }

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

/** Bound readiness waits by the test's cancellation without leaving an abort listener behind. */
async function untilResolved(promise, signal) {
  signal.throwIfAborted()
  let cancel
  const cancelled = new Promise((resolve, reject) => {
    cancel = () => reject(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
  })
  try { return await Promise.race([promise, cancelled]) }
  finally { signal.removeEventListener('abort', cancel) }
}

/** Wait for the production admission gate rather than assuming a disposal callback already ran. */
async function untilState(condition, signal) {
  while (!condition()) {
    signal.throwIfAborted()
    await new Promise(resolve => setImmediate(resolve))
  }
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'muse-evolution-lifecycle-'))
  const ctx = new Context(), entered = deferred(), response = deferred()
  let calls = 0
  t.after(async () => {
    response.resolve(receipt)
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const route = { provider: 'lifecycle-fixture', model: 'lifecycle-fixture' }
  const source = { id: 'source-session', header: { cwd: root }, requestHeader: () => ({ config: route }) }
  await ctx.plugin(SkillRegistry).await()
  await ctx.plugin({
    name: 'fixture-evolution-lifecycle-services',
    apply(scope) {
      scope.provide('agents', {
        list: () => [{ session: source, status: 'idle' }],
        get: () => ({ session: source, model: { current: () => route } }),
        async create(options) {
          const sections = [], restrictions = []
          options.setup({ systemPrompt: { section: value => { sections.push(value) } },
            tools: { restrict: value => { restrictions.push(value) } }, on: () => () => {} })
          assert.deepEqual(restrictions, [{ allow: [], includeOwn: true }])
          assert.ok(sections.some(section => section.complete === true))
          const child = { id: options.sessionId, header: options.meta }
          return {
            agent: {
              session: { ...child, deriveMessages: () => [{ role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ action: 'none', feedback: candidate }) }] }] },
              followup() {},
              async whenIdle() { ctx.emit('session/event', child, { type: 'turn/end', data: { reason: { kind: 'completed' } } }) },
              cancel() {},
            },
            async dispose() {},
          }
        },
      })
      scope.provide('sessions', { get: id => id === source.id ? source : undefined, async flush() {} })
      scope.provide('sessionPersistence', {})
      scope.provide('tools', { register: () => () => {} })
      scope.provide('systemPrompt', {})
      scope.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access' }) })
    },
  }).await()
  const account = ctx.plugin({
    name: 'fixture-evolution-lifecycle-account',
    apply(scope) {
      scope.provide('museAccount', {
        async feedback(request) {
          calls += 1
          entered.resolve(request)
          return await response.promise
        },
      })
    },
  })
  await account.await()
  await ctx.plugin(evolution, { home: join(root, 'state'), skillsRoot: join(root, 'skills'), idleMs: 0, minToolCalls: 1 }).await()
  const runtime = ctx.museSkillEvolution
  let seq = 0
  const event = (type, data) => ctx.emit('session/event', source, { type, seq: seq++, data })
  event('turn/start', { turn: 1 })
  event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'Check the result before completion.' }] })
  event('tool/call', { name: 'read', callId: 'read-one' })
  event('tool/result', { message: { source: { callId: 'read-one' }, isError: false } })
  event('turn/end', { reason: { kind: 'completed' } })
  await runtime.writes
  runtime.timer?.ref()
  const request = await untilResolved(entered.promise, t.signal)
  const stateFile = join(root, 'state', 'state.json')
  const readRun = async () => Object.values(JSON.parse(await readFile(stateFile, 'utf8')).runs)[0]
  assert.equal(request.includeDiagnostics, false)
  const pending = await readRun()
  assert.equal(pending.feedback.state, 'sending')
  assert.deepEqual(pending.feedback.request, request)
  return { ctx, account, runtime, response, readRun, calls: () => calls }
}

for (const mode of ['provider withdrawal', 'root disposal']) {
  test(`production optional account wiring drains a held POST during ${mode}`, { timeout: fixtureTimeoutMs }, async t => {
    const f = await fixture(t)
    let disposed = false
    const operation = mode === 'provider withdrawal' ? f.account.dispose() : f.ctx.fiber.dispose()
    const disposing = operation.then(() => { disposed = true })
    await untilState(() => mode === 'provider withdrawal' ? f.runtime.feedbackProvider === undefined : f.runtime.closed, t.signal)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(disposed, false)
    f.response.resolve(receipt)
    await untilResolved(disposing, t.signal)
    if (mode === 'provider withdrawal') await untilResolved(f.runtime.whenIdle(), t.signal)
    const result = await f.readRun()
    assert.equal(disposed, true)
    assert.equal(result.state, 'none')
    assert.equal(result.feedback.state, 'submitted')
    assert.deepEqual(result.feedback.receipt, receipt)
    assert.equal(f.calls(), 1)
    if (mode === 'provider withdrawal') assert.equal(f.runtime.feedbackProvider, undefined)
    else assert.equal(f.ctx.get('museSkillEvolution'), undefined)
  })
}
