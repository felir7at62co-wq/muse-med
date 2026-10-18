/** Product-owned native Feishu composition and physical file authorization. */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createMuseAgentStore, drainMuseOperations, mountMuseFeishu, readWorkspaceFile, stopMuseTransport } from './muse-feishu-runtime.mjs'

test('new and restored native Agents mount their Muse preset and current model with reasoning', async () => {
  const calls = []
  const selections = new WeakMap()
  const owned = new Set()
  const agentCtx = { tools: { guard: guard => { calls.push(['guard', guard]); return () => {} } }, effect: effect => effect() }
  const agent = { session: { requestHeader: () => undefined } }
  const ctx = {
    agentPresets: {
      resolveForCreation: async id => { calls.push(['create-preset', id]); return { id } },
      resolve: async id => { calls.push(['resume-preset', id]); return { id } },
      mount: async (_scope, id) => { calls.push(['mount', id]) },
    },
    sessionProjections: { stateOf: () => ({ pending: null }) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'muse', model: 'flash', reasoningEffort: 'high' }) },
    sessionPersistence: { stat: async id => ({ header: { id, agentPreset: 'preserved-preset' } }) },
    agents: {
      get: () => undefined,
      create: async options => { calls.push(['create', options]); await options.setup(agentCtx, agent); return { agent, dispose: async () => {} } },
      resume: async options => { calls.push(['resume', options]); await options.setup(agentCtx, agent); return { agent, dispose: async () => {} } },
    },
  }
  const selectionFor = scope => { const ref = { current: undefined }; selections.set(scope, ref); return ref }
  const store = createMuseAgentStore(ctx, { agentPreset: 'short-drama', denyTools: ['ask_user_question', 'exit_plan_mode', 'custom_denied'] }, selectionFor, owned)
  assert.equal(await store.create('created', '/workspace'), agent)
  assert.deepEqual(calls.find(([name]) => name === 'create')[1].meta, { cwd: '/workspace', agentPreset: 'short-drama' })
  assert.deepEqual(selections.get(agentCtx).current, { provider: 'muse', model: 'flash', reasoningEffort: 'high' })
  assert.equal(calls.find(([name]) => name === 'guard')[1]({ name: 'ask_user_question' }), undefined)
  assert.match(calls.find(([name]) => name === 'guard')[1]({ name: 'exit_plan_mode' }), /unavailable/u)
  assert.match(calls.find(([name]) => name === 'guard')[1]({ name: 'custom_denied' }), /unavailable/u)
  assert.equal(await store.resume('restored'), agent)
  assert.ok(calls.some(([name, id]) => name === 'resume-preset' && id === 'preserved-preset'))
  assert.equal(owned.size, 2)
})

test('restoration distinguishes a missing Session from an unreadable persisted Session', async () => {
  const ctx = { agents: { get: () => undefined }, sessionPersistence: { stat: async () => undefined } }
  const store = createMuseAgentStore(ctx, {}, () => {}, new Set())
  await assert.rejects(store.resume('missing'), error => error.code === 'MUSE_SESSION_NOT_FOUND')
  const failure = new Error('storage unavailable')
  ctx.sessionPersistence.stat = async () => { throw failure }
  await assert.rejects(store.resume('existing'), error => error === failure)
})

test('outbound reads reject traversal, physical escape, directories, and oversized files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'muse-feishu-outbound-'))
  const workspace = join(root, 'workspace')
  const outside = join(root, 'outside')
  mkdirSync(workspace)
  mkdirSync(outside)
  const link = join(workspace, 'escape')
  try {
    writeFileSync(join(workspace, '交付.txt'), 'owned')
    writeFileSync(join(outside, 'private.txt'), 'private')
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal(new TextDecoder().decode((await readWorkspaceFile(workspace, '交付.txt', 5)).bytes), 'owned')
    await assert.rejects(readWorkspaceFile(workspace, '../outside/private.txt', 100), /outside/u)
    await assert.rejects(readWorkspaceFile(workspace, 'escape/private.txt', 100), /physical/u)
    await assert.rejects(readWorkspaceFile(workspace, '.', 100), /regular file/u)
    await assert.rejects(readWorkspaceFile(workspace, '交付.txt', 4), /size limit/u)
  } finally {
    unlinkSync(link)
    rmSync(root, { recursive: true, force: true })
  }
})

test('only the product channel row can start the native provider', () => {
  assert.doesNotThrow(() => mountMuseFeishu({}, { enabled: false }, {}, {}))
  assert.throws(() => mountMuseFeishu({ fiber: { entry: { options: { id: 'extra-upstream-row' } } } }, { enabled: true }, {}, {}), /feishu-channel/u)
})


test('live delegated Sessions cannot bypass the cold restoration lineage policy', async () => {
  const delegated = { session: { header: { origin: 'subagent' } } }
  const store = createMuseAgentStore({ agents: { get: () => delegated } }, {}, () => {}, new Set())
  assert.throws(() => store.get('delegated'), /delegated/u)
  await assert.rejects(store.resume('delegated'), /delegated/u)
  delegated.session.header = { parentSession: 'parent' }
  assert.throws(() => store.get('delegated'), /delegated/u)
  delegated.session.header = { agentPreset: 'short-drama' }
  assert.equal(store.get('root'), delegated)
  assert.equal(await store.resume('root'), delegated)
})

test('teardown drains every handle and propagates Session disposal failure', async () => {
  const failure = new Error('Session persistence failed')
  const cancelled = []
  const handles = new Set([1, 2].map(id => ({ agent: { cancel: () => { cancelled.push(id) } },
    dispose: async () => { if (id === 1) throw failure } })))
  await assert.rejects(drainMuseOperations(handles, new Set()), error => error instanceof AggregateError && error.errors[0] === failure)
  assert.deepEqual(cancelled, [1, 2])
})


test('socket teardown waits after SDK close removes every prior event listener', async () => {
  const socket = Object.assign(new EventEmitter(), { readyState: 1 })
  let stopped = false
  const transport = { ws: { wsConfig: { getWSInstance: () => socket } }, stop: async () => {
    socket.removeAllListeners()
    queueMicrotask(() => { socket.readyState = 3; socket.emit('close') })
    stopped = true
  } }
  await stopMuseTransport(transport)
  assert.equal(stopped, true)
  assert.equal(socket.readyState, 3)
  socket.readyState = 1
  transport.stop = async () => {
    socket.removeAllListeners()
    setImmediate(() => { socket.readyState = 3; socket.emit('close') })
  }
  await stopMuseTransport(transport)
  assert.equal(socket.readyState, 3)
})
