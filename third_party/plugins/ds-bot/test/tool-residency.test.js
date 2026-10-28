import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cleanResidentTools, install } from '../src/host/tool-residency.js'
import { fakeContext } from './fake-ctx.js'

const start = () => {
  let provider
  let disposed = false
  let saveFailure
  const refreshed = []
  const service = {
    registerResidency(value) { provider = value; return () => { disposed = true } },
    async refresh(agent) { refreshed.push({ agent: agent.id, tools: await provider.read(agent) }) },
  }
  const ctx = fakeContext({ services: { toolDiscovery: service } })
  const bots = { chief: { id: 'chief', resident_tools: ['list_bots'] }, muse: { id: 'muse', resident_tools: ['video_inspect'] } }
  const owners = { chief: 'chief', muse: 'muse', group: 'muse', part2: 'muse' }
  const agents = Object.keys(owners).map(id => ({ id, session: { id } }))
  ctx.agents = { list: () => agents }
  const rt = {
    ctx, load: async () => {}, readOnly: () => undefined,
    botOf: id => bots[id], selfOf: id => owners[id],
    save: async options => { assert.equal(options.required, true); if (saveFailure) throw saveFailure },
  }
  install(rt)
  const step = async agent => {
    let delegated = false
    for (const listener of ctx.listeners.get('agent/pre-step') ?? []) await listener({ agent }, () => { delegated = true })
    assert.equal(delegated, true)
  }
  return { ctx, rt, agents, bots, owners, refreshed, service, step, provider: () => provider,
    fail: error => { saveFailure = error }, disposed: () => disposed }
}

test('resident tools validate persisted and external lists and keep deterministic exact names', () => {
  assert.deepEqual(cleanResidentTools(['video_inspect', 'read', 'read']), ['read', 'video_inspect'])
  for (const input of [null, {}, [''], ['has space'], [false], ['a\0b'], Array(513).fill('read')]) {
    assert.throws(() => cleanResidentTools(input), /resident_tools/)
  }
})

test('each Bot shares its own residency across its group and conversation parts', async t => {
  const s = start()
  t.after(() => s.ctx.dispose())
  for (const agent of s.agents) await s.step(agent)
  assert.deepEqual(s.refreshed, [
    { agent: 'chief', tools: ['list_bots'] }, { agent: 'muse', tools: ['video_inspect'] },
    { agent: 'group', tools: ['video_inspect'] }, { agent: 'part2', tools: ['video_inspect'] },
  ])
  await s.provider().write(s.agents[2], ['shot_script'])
  assert.deepEqual(s.bots.muse.resident_tools, ['shot_script'])
  assert.deepEqual(s.bots.chief.resident_tools, ['list_bots'])
  await s.step(s.agents[3])
  assert.deepEqual(s.refreshed.at(-1), { agent: 'part2', tools: ['shot_script'] })
})

test('an Agent created before its Bot record gets residency before the next step', async t => {
  const s = start()
  t.after(() => s.ctx.dispose())
  const agent = { id: 'late', session: { id: 'late' } }
  for (const listener of s.ctx.listeners.get('agent/created') ?? []) await listener({ agent })
  assert.equal(s.refreshed.length, 0)
  s.owners.late = 'muse'
  await s.step(agent)
  assert.deepEqual(s.refreshed, [{ agent: 'late', tools: ['video_inspect'] }])
})

test('a failed required save restores residency and reports the write failure', async t => {
  const s = start()
  t.after(() => s.ctx.dispose())
  await s.step(s.agents[1])
  s.fail(new Error('disk unavailable'))
  await assert.rejects(s.provider().write(s.agents[1], ['write']), /disk unavailable/)
  assert.deepEqual(s.bots.muse.resident_tools, ['video_inspect'])
  s.fail(undefined)
  await s.provider().write(s.agents[1], [])
  assert.deepEqual(s.bots.muse.resident_tools, [])
})

test('the bridge preserves access policy and disposes its provider registration', async () => {
  const s = start()
  await s.step(s.agents[1])
  assert.equal(s.provider().matches({ id: 'stranger', session: { id: 'stranger' } }), false)
  const before = [...s.ctx.registeredTools.keys()]
  assert.deepEqual(before, [])
  await s.ctx.dispose()
  assert.equal(s.disposed(), true)
})


test('unloading awaits the provider disposer before reporting completion', async () => {
  let release
  let entered = false
  const disposed = new Promise(resolve => { release = resolve })
  const ctx = fakeContext({ services: { toolDiscovery: {
    registerResidency: () => async () => { entered = true; await disposed },
    refresh: async () => {},
  } } })
  install({ ctx, load: async () => {}, botOf: id => id === 'muse' ? { id } : undefined, selfOf: id => id })
  for (const listener of ctx.listeners.get('agent/created') ?? []) await listener({ agent: { id: 'muse' } })
  let complete = false
  const closing = ctx.dispose().then(() => { complete = true })
  await Promise.resolve()
  assert.equal(entered, true)
  assert.equal(complete, false)
  release()
  await closing
  assert.equal(complete, true)
})
