/** Exercise staged cards against production AgentRegistry, AgentLoop and Session identities. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot'
import * as DeepView from './index.js'
import { executeTool } from './.muse-tool-call.mjs'

const CHOICES = { type: 'options', id: 'pick', options: [{ label: 'A' }, { label: 'B' }] }
const CONFIRM = { type: 'confirm', id: 'confirm' }
const FORM = { type: 'form', id: 'form', fields: [{ id: 'title', label: 'Title' }] }

test('the staged manifest passes native compatibility without an exemption and rejects later Hosts', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'))
  assert.equal(manifest.engines.dsh, '0.2.2-rc.1 || 0.2.2-rc.2')
  assert.equal(evaluatePluginCompatibility(manifest), undefined)
  for (const runtime of ['0.2.2-rc.3', '0.2.2', '0.3.0']) {
    assert.equal(evaluatePluginCompatibility(manifest, {}, runtime)?.exempted, false)
  }
})

class OfflineAdapter extends LlmAdapter {
  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }) }
  async *stream() {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Recorded.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Recorded.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'muse-deep-view-host-'))
  const ctx = new Context(), routes = new Map()
  let plugin, lookup, requestCount = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => { requestCount++; throw new Error('Unexpected external request') }
  t.after(async () => {
    try { await ctx.fiber.dispose() }
    finally { globalThis.fetch = originalFetch; await rm(home, { recursive: true, force: true }) }
    assert.equal(requestCount, 0)
  })
  await mountAgentLoopTestDependencies(ctx)
  await mountAgentLoopTestHarness(ctx)
  ctx.effect(() => ctx.llm.registerAdapter(['offline-card'], new OfflineAdapter()))
  ctx.provide('connection', { fetch: { register(route) {
    assert.equal(routes.has(route.path), false)
    routes.set(route.path, route)
    return () => routes.delete(route.path)
  } } })
  ctx.provide('sessionController', { async resolveAgent(id) {
    if (lookup !== undefined) return lookup(id)
    const agent = ctx.agents.get(SessionId(id))
    return agent === undefined ? { error: new Error('Unavailable') } : { agent }
  } })
  const create = (id, meta = {}) => ctx.agents.create({ sessionId: SessionId(id),
    agentOptions: { provider: 'offline-card', model: 'fixture' }, meta })
  const mainHandle = await create('card-main', { agentPreset: 'main-session' })
  const otherHandle = await create('card-other')
  const childHandle = await create('card-child', { parentSession: mainHandle.agent.id, origin: 'subagent' })
  const main = mainHandle.agent, other = otherHandle.agent, child = childHandle.agent
  const mount = async () => { plugin = await ctx.plugin(DeepView, { home }) }
  await mount()
  assert.equal(typeof ctx.agents.roots, 'undefined')
  assert.equal(ctx.agents.get(main.id), main)
  assert.equal(main.session.header.agentPreset, 'main-session')
  assert.equal(child.session.header.origin, 'subagent')
  let sequence = 0
  const show = (view = CHOICES, agent = main, extra = {}, signal = new AbortController().signal) => executeTool(ctx, {
    agent, name: 'show_view', callId: ToolCallId(`card-${++sequence}`), signal,
    arguments: { title: 'Source decision', view, ...extra },
  })
  const call = async (op, body) => {
    const route = routes.get('/api/deep-view')
    assert.ok(route)
    const response = await route.fetch(new Request('http://localhost/api/deep-view', {
      method: 'POST', body: JSON.stringify({ op, ...body }),
    }))
    return response.json()
  }
  const pending = (sessionId = main.id) => call('pending', { sessionId })
  const reply = (record, { sessionId = main.id, action = 'pick', values = { selected: ['A'] } } = {}) =>
    call('reply', { sessionId, viewId: record.id, action, values })
  const replies = agent => [...agent.session.deriveMessages(), ...agent.inbox.nextTurn, ...agent.inbox.nextStep]
    .filter(message => message.source.kind === 'deep-view-reply')
  const human = agent => agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Changed requirement.' }], source: { kind: 'user' } }))
  const waitForMessage = (agent, kind) => {
    const done = Promise.withResolvers()
    const dispose = ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'user/message' && event.data.source.kind === kind) { dispose(); done.resolve(event) }
    })
    t.after(dispose)
    return done.promise
  }
  return { ctx, home, main, other, child, mainHandle, childHandle, show, call, pending, reply, replies, human, waitForMessage, mount,
    overrideLookup(value) { lookup = value }, unmount: () => plugin.dispose() }
}

test('production root cards submit once to their original Main Session without a roots shim', async t => {
  const f = await fixture(t)
  const result = await f.show()
  assert.equal(result.isError, false)
  assert.match(result.content[0].text, /next message/)
  const record = (await f.pending()).value
  const arrived = f.waitForMessage(f.main, 'deep-view-reply')
  assert.deepEqual(await f.reply(record), { ok: true, value: true })
  await arrived
  assert.deepEqual(await f.reply(record), { ok: true, value: true })
  assert.equal(new Set(f.replies(f.main).map(message => message.id)).size, 1)
  assert.equal(f.replies(f.other).length, 0)
  assert.equal(f.replies(f.child).length, 0)
  assert.deepEqual(await f.pending(), { ok: true, value: null })
})

test('live subagents and disposed roots cannot offer interactive cards', async t => {
  const f = await fixture(t)
  assert.match((await f.show(CHOICES, f.child)).content[0].text, /root session/)
  await f.mainHandle.dispose()
  assert.match((await f.show()).content[0].text, /root session/)
  assert.deepEqual(await f.pending(), { ok: true, value: null })
})

test('a different live root returned for a requested Session cannot receive its answer', async t => {
  const f = await fixture(t)
  await f.show()
  const record = (await f.pending()).value
  f.overrideLookup(async () => ({ agent: f.other }))
  assert.equal((await f.reply(record)).error.code, 'deep-view/unavailable')
  assert.equal(f.replies(f.other).length, 0)
  assert.equal(f.replies(f.main).length, 0)
  assert.equal((await f.pending()).value.answerPending, undefined)
  f.overrideLookup(undefined)
  assert.deepEqual(await f.reply(record), { ok: true, value: true })
})

test('missing and no-longer-live lookup results leave the original answer unclaimed', async t => {
  const f = await fixture(t)
  await f.show()
  const record = (await f.pending()).value
  f.overrideLookup(async () => ({ error: new Error('Unavailable') }))
  assert.equal((await f.reply(record)).error.code, 'deep-view/unavailable')
  f.overrideLookup(async () => ({ agent: f.main }))
  await f.mainHandle.dispose()
  assert.equal((await f.reply(record)).error.code, 'deep-view/root-required')
  assert.equal((await f.pending()).value.answerPending, undefined)
})

test('invalid answers and cross-Session or superseded view identities cannot submit or dismiss cards', async t => {
  const f = await fixture(t)
  await f.show()
  const old = (await f.pending()).value
  assert.equal((await f.reply(old, { values: { selected: ['missing'] } })).error.code, 'deep-view/invalid')
  assert.equal((await f.reply(old, { sessionId: f.other.id })).error.code, 'deep-view/stale')
  await f.show()
  const current = (await f.pending()).value
  assert.notEqual(current.id, old.id)
  assert.equal((await f.reply(old)).error.code, 'deep-view/stale')
  assert.equal((await f.call('dismiss', { sessionId: f.main.id, viewId: old.id })).error.code, 'deep-view/stale')
  assert.deepEqual(await f.call('dismiss', { sessionId: f.main.id, viewId: current.id }), { ok: true, value: true })
  assert.deepEqual(await f.pending(), { ok: true, value: null })
  assert.equal(f.replies(f.main).length, 0)
})

for (const [view, action, values] of [
  [CONFIRM, 'confirm', { confirmed: false }], [FORM, 'form', { canceled: true }],
]) {
  test(`keeps ${view.type} cancellation as one original-Session user answer`, async t => {
    const f = await fixture(t)
    await f.show(view)
    const record = (await f.pending()).value
    const arrived = f.waitForMessage(f.main, 'deep-view-reply')
    assert.deepEqual(await f.reply(record, { action, values }), { ok: true, value: true })
    await arrived
    const message = f.replies(f.main)[0]
    const payload = JSON.parse(message.content[0].text)
    assert.deepEqual(payload.answers[0].values, values)
    assert.equal(f.replies(f.other).length, 0)
  })
}

test('a newer human input revokes an answer blocked on the real Agent lookup', async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  await f.show()
  const record = (await f.pending()).value
  f.overrideLookup(async () => { entered.resolve(); await release.promise; return { agent: f.main } })
  const answering = f.reply(record)
  await entered.promise
  const arrived = f.waitForMessage(f.main, 'user')
  f.human(f.main)
  await arrived
  release.resolve()
  assert.equal((await answering).error.code, 'deep-view/stale')
  assert.equal(f.replies(f.main).length, 0)
})

test('plugin unload drains a blocked lookup without admitting an answer', async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  await f.show()
  const record = (await f.pending()).value
  f.overrideLookup(async () => { entered.resolve(); await release.promise; return { agent: f.main } })
  const answering = f.reply(record)
  await entered.promise
  const unloading = f.unmount()
  release.resolve()
  assert.equal((await answering).error.code, 'deep-view/unavailable')
  await unloading
  assert.equal(f.replies(f.main).length, 0)
  assert.equal(JSON.parse(await readFile(join(f.home, 'pending.json'), 'utf8'))[f.main.id].delivery, undefined)
  assert.equal(f.ctx.tools.schemas().some(tool => tool.name === 'show_view'), false)
})

test('read-only views do not reserve an answer and aborted interactive requests create no pending card', async t => {
  const f = await fixture(t)
  const result = await f.show({ type: 'metric', label: 'Count', value: '2' })
  assert.equal(result.isError, false)
  assert.equal(result.content[0].text, 'The view is on screen.')
  const controller = new AbortController()
  controller.abort()
  const stopped = await f.show(CHOICES, f.main, {}, controller.signal)
  assert.equal(stopped.isError, true)
  assert.deepEqual(await f.pending(), { ok: true, value: null })
})
