import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply, inject } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const CHOICES = { type: 'options', id: 'pick', options: [{ label: 'A' }, { label: 'B' }] }
const METER = { type: 'metric', label: 'Progress', value: '70%' }
function start(t, { home = mkdtempSync(join(tmpdir(), 'deep-view-')), beforeApply } = {}) {
  const ctx = fakeContext(), sent = [], events = []
  t.after(async () => { await ctx.dispose(); await rm(home, { recursive: true, force: true }) })
  let flushError, resolveHook, seq = 0, route
  const agent = { id: 'a1', root: true,
    session: { id: 's1', get seq() { return seq + 1 }, deriveMessages: () => events.filter(event => event.type === 'user/message').map(event => event.data) },
    inbox: { nextTurn: [], nextStep: [] }, followup(message) { sent.push({ sessionId: 's1', message }); this.inbox.nextTurn.push(message) } }
  ctx.agentsRegistry.map.set('a1', agent)
  ctx.sessionController.resolveAgent = async () => { await resolveHook?.(); return { agent } }
  ctx.sessions.flush = async () => { if (flushError !== undefined) throw flushError }
  ctx.connection.fetch.register = options => { route = options; return async () => {} }
  beforeApply?.(ctx)
  apply(ctx, { home })
  const emit = (id, type, data) => {
    const event = { type, seq: ++seq, data: type === 'user/message' ? { id: `message-${seq}`, ...data } : data }; events.push(event)
    for (const listener of ctx.listeners.get('session/event') ?? []) listener({ id }, event)
  }
  const exec = (over = {}) => ({ agent, callId: 'call-1', signal: new AbortController().signal,
    concluded: false, concludeTurn() { this.concluded = true }, ...over })
  const show = (args, over) => ctx.registeredTools.get('show_view').execute(args, exec(over))
  const call = async (op, body) => (await route.fetch(new Request('http://localhost/api/deep-view', {
    method: 'POST', body: JSON.stringify({ op, ...body }),
  }))).json()
  const reply = (record, selected = ['A']) => call('reply', { sessionId: 's1', viewId: record.id, action: 'pick', values: { selected } })
  return { ctx, home, agent, events, emit, show, exec, call, reply, sent,
    failFlush(error) { flushError = error }, gateResolve(hook) { resolveHook = hook } }
}

test('declares the root registry and rejects duplicate global tool registration', t => {
  assert.ok(inject.includes('agents'))
  assert.throws(() => start(t, { beforeApply: ctx => ctx.tools.register({ name: 'show_view' }) }), /already registered/)
})
test('marks only its own result and displays read-only views without ending the turn', async t => {
  const fixture = start(t), tool = fixture.ctx.registeredTools.get('show_view'), exec = fixture.exec()
  assert.deepEqual(tool.output.presentationMeta({}, ''), { owner: 'deep-view' })
  assert.equal(await tool.execute({ title: 'Progress', view: METER }, exec), 'The view is on screen.')
  assert.equal(exec.concluded, false)
  assert.deepEqual(await fixture.call('pending', { sessionId: 's1' }), { ok: true, value: null })
})
test('refuses invalid blueprints and mismatched wait rules', async t => {
  const fixture = start(t)
  assert.match(await fixture.show({ view: { type: 'nope' } }), /unknown component/)
  assert.match(await fixture.show({ view: METER, await_reply: true }), /nothing to submit/)
  assert.match(await fixture.show({ view: CHOICES, await_reply: false }), /waits for the user/)
})
test('uses the durable call identity and requires a live root for an interactive view', async t => {
  const fixture = start(t), tool = fixture.ctx.registeredTools.get('show_view'), exec = fixture.exec()
  assert.match(await tool.execute({ view: CHOICES }, exec), /next message/)
  assert.equal(exec.concluded, true)
  assert.equal((await fixture.call('pending', { sessionId: 's1' })).value.id, 'call-1')
  const child = { ...fixture.agent, id: 'child', root: false }
  fixture.ctx.agentsRegistry.map.set(child.id, child)
  assert.match(await fixture.show({ view: CHOICES }, { agent: child }), /root session/)
  assert.match(await fixture.show({ view: CHOICES }, { agent: undefined }), /root session/)
  assert.match(await fixture.show({ view: CHOICES }, { callId: undefined }), /tool-call identity/)
})
test('a failed save keeps the turn running and reports no private path', async t => {
  const parent = mkdtempSync(join(tmpdir(), 'deep-view-block-')); t.after(() => rm(parent, { recursive: true, force: true }))
  const blocker = join(parent, 'blocker'); await writeFile(blocker, 'x')
  const fixture = start(t, { home: join(blocker, 'sub') }), exec = fixture.exec()
  const text = await fixture.ctx.registeredTools.get('show_view').execute({ view: CHOICES }, exec)
  assert.match(text, /could not be kept open/); assert.doesNotMatch(text, /deep-view-block-/)
  assert.equal(exec.concluded, false)
  assert.equal((await fixture.call('pending', { sessionId: 's1' })).error.code, 'deep-view/internal')
})
test('an uncertain flush retains one answer identity and retries never enqueue twice', async t => {
  const fixture = start(t); await fixture.show({ view: CHOICES })
  const record = (await fixture.call('pending', { sessionId: 's1' })).value
  assert.equal((await fixture.reply(record, ['Nope'])).error.code, 'deep-view/invalid')
  assert.equal((await fixture.reply({ ...record, id: 'old' })).error.code, 'deep-view/stale')
  fixture.failFlush(new Error('private-disk-path'))
  const failed = await fixture.reply(record)
  assert.equal(failed.error.code, 'deep-view/unconfirmed'); assert.doesNotMatch(JSON.stringify(failed), /private-disk-path/)
  const visible = (await fixture.call('pending', { sessionId: 's1' })).value
  assert.equal(visible.answerPending, true); assert.equal(visible.delivery, undefined)
  const intent = JSON.parse(await readFile(join(fixture.home, 'pending.json'), 'utf8')).s1.delivery
  assert.equal(intent.message.id, fixture.sent[0].message.id)
  assert.equal((await fixture.reply(record, ['B'])).error.code, 'deep-view/answer-conflict')
  fixture.failFlush(undefined)
  assert.deepEqual(await fixture.reply(record), { ok: true, value: true })
  assert.deepEqual(await fixture.reply(record), { ok: true, value: true })
  assert.equal(fixture.sent.length, 1); assert.equal(fixture.sent[0].message.source.kind, 'deep-view-reply')
  assert.deepEqual(await fixture.call('pending', { sessionId: 's1' }), { ok: true, value: null })
})
test('concurrent answers serialize across a blocked Agent lookup', async t => {
  const fixture = start(t), entered = Promise.withResolvers(), release = Promise.withResolvers()
  await fixture.show({ view: CHOICES }); const record = (await fixture.call('pending', { sessionId: 's1' })).value
  fixture.gateResolve(async () => { entered.resolve(); await release.promise })
  const first = fixture.reply(record); await entered.promise
  const duplicate = fixture.reply(record); release.resolve()
  assert.deepEqual(await Promise.all([first, duplicate]), [{ ok: true, value: true }, { ok: true, value: true }])
  assert.equal(fixture.sent.length, 1)
})
test('a late close cannot dismiss a replacement view', async t => {
  const fixture = start(t); await fixture.show({ view: CHOICES })
  const old = (await fixture.call('pending', { sessionId: 's1' })).value
  await fixture.show({ title: 'Replacement', view: CHOICES }, { callId: 'call-2' })
  assert.equal((await fixture.call('dismiss', { sessionId: 's1', viewId: old.id })).error.code, 'deep-view/stale')
  assert.equal((await fixture.call('pending', { sessionId: 's1' })).value.id, 'call-2')
  assert.deepEqual(await fixture.call('dismiss', { sessionId: 's1', viewId: 'call-2' }), { ok: true, value: true })
  assert.deepEqual(await fixture.call('pending', { sessionId: 's1' }), { ok: true, value: null })
})
test('ordinary user messages revoke open cards while background notices leave them open', async t => {
  const fixture = start(t)
  for (const kind of ['user', 'user-question-reply', 'deep-view-reply']) {
    await fixture.show({ view: CHOICES }); fixture.emit('s1', 'user/message', { source: { kind: 'schedule' } })
    assert.notEqual((await fixture.call('pending', { sessionId: 's1' })).value, null)
    fixture.emit('s1', 'user/message', { source: { kind } })
    assert.deepEqual(await fixture.call('pending', { sessionId: 's1' }), { ok: true, value: null })
  }
})
test('a stopped plugin drains an in-flight lookup without admitting its answer', async t => {
  const fixture = start(t), entered = Promise.withResolvers(), release = Promise.withResolvers()
  await fixture.show({ view: CHOICES }); const record = (await fixture.call('pending', { sessionId: 's1' })).value
  fixture.gateResolve(async () => { entered.resolve(); await release.promise })
  const answering = fixture.reply(record); await entered.promise
  const disposal = fixture.ctx.dispose(); release.resolve()
  assert.equal((await answering).error.code, 'deep-view/unavailable'); await disposal
  assert.equal(fixture.sent.length, 0)
  assert.equal(JSON.parse(await readFile(join(fixture.home, 'pending.json'), 'utf8')).s1.delivery, undefined)
  assert.equal(fixture.ctx.registeredTools.size, 0)
})
test('an aborted view request leaves no open card or concluded turn', async t => {
  const fixture = start(t), controller = new AbortController(), exec = fixture.exec({ signal: controller.signal })
  controller.abort()
  await assert.rejects(fixture.ctx.registeredTools.get('show_view').execute({ view: CHOICES }, exec), error => error.name === 'AbortError')
  assert.equal(exec.concluded, false)
  assert.deepEqual(await fixture.call('pending', { sessionId: 's1' }), { ok: true, value: null })
})

test('a restarted uncertain answer stays locked until its original message can be verified', async t => {
  const fixture = start(t); await fixture.show({ view: CHOICES })
  const record = (await fixture.call('pending', { sessionId: 's1' })).value
  fixture.failFlush(new Error('unavailable'))
  assert.equal((await fixture.reply(record)).error.code, 'deep-view/unconfirmed')
  const original = fixture.sent[0].message
  await fixture.ctx.dispose()
  const restarted = start(t, { home: fixture.home })
  assert.equal((await restarted.call('pending', { sessionId: 's1' })).value.answerPending, true)
  assert.equal((await restarted.reply(record)).error.code, 'deep-view/unconfirmed')
  assert.equal(restarted.sent.length, 0)
  restarted.events.push({ type: 'user/message', seq: 1, data: original })
  assert.deepEqual(await restarted.reply(record), { ok: true, value: true })
  assert.equal(restarted.sent.length, 0)
})

test('a newer human message invalidates an answer waiting for Agent lookup', async t => {
  const fixture = start(t), entered = Promise.withResolvers(), release = Promise.withResolvers()
  await fixture.show({ view: CHOICES }); const record = (await fixture.call('pending', { sessionId: 's1' })).value
  fixture.gateResolve(async () => { entered.resolve(); await release.promise })
  const answering = fixture.reply(record); await entered.promise
  fixture.emit('s1', 'user/message', { source: { kind: 'user' } }); release.resolve()
  assert.equal((await answering).error.code, 'deep-view/stale')
  assert.equal(fixture.sent.length, 0)
  assert.deepEqual(await fixture.call('pending', { sessionId: 's1' }), { ok: true, value: null })
})
