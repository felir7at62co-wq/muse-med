import assert from 'node:assert/strict'
import { test } from 'node:test'
import { listedOpener } from '../src/client/open-listed.js'

const store = (ids = []) => {
  const listeners = new Set()
  const snapshot = { byId: {} }
  const notify = () => { for (const fn of listeners) fn() }
  const put = (id, main) => { snapshot.byId[id] = main ? { id, retainedBy: { mainView: 1 } } : { id } }
  for (const id of ids) put(id)
  return {
    getSnapshot: () => snapshot,
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    set: (id) => { put(id); notify() },
    setMain: (id) => { for (const row of Object.values(snapshot.byId)) delete row.retainedBy; put(id, true); notify() },
    listeners: () => listeners.size,
  }
}

const mainViewOf = list => Object.values(list.getSnapshot().byId).find(row => (row?.retainedBy?.mainView ?? 0) > 0)?.id

const rig = (list) => {
  const opened = []
  let refreshes = 0
  const show = listedOpener({ list, open: id => opened.push(id), refresh: () => { refreshes += 1 }, current: () => mainViewOf(list) })
  return { show, opened, refreshes: () => refreshes }
}

test('a listed Session opens at once and no refresh is asked for', () => {
  const { show, opened, refreshes } = rig(store(['a']))
  show('a')
  assert.deepEqual(opened, ['a'])
  assert.equal(refreshes(), 0)
})

test('an unlisted Session opens when the list reaches it, only once', () => {
  const list = store()
  const { show, opened, refreshes } = rig(list)
  show('a')
  assert.deepEqual(opened, [])
  assert.equal(refreshes(), 1)
  list.set('a')
  assert.deepEqual(opened, ['a'])
  list.set('b')
  assert.deepEqual(opened, ['a'])
})

test('a newer navigation drops the wait for the old one', () => {
  const list = store(['b'])
  const { show, opened } = rig(list)
  show('a')
  show('b')
  assert.deepEqual(opened, ['b'])
  list.set('a')
  assert.deepEqual(opened, ['b'])
})

test('two waits in a row keep only the last one', () => {
  const list = store()
  const { show, opened } = rig(list)
  show('a')
  show('b')
  list.set('a')
  list.set('b')
  assert.deepEqual(opened, ['b'])
})

test('a navigation elsewhere drops the wait', () => {
  const list = store(['x'])
  list.setMain('x')
  const { show, opened } = rig(list)
  show('a')
  list.setMain('y')
  list.set('a')
  assert.deepEqual(opened, [])
})

test('a first selection waiting for the Session list defeats the delayed Main Bot landing', context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const list = store(['main'])
  const { show, opened } = rig(list)
  const canLand = show.guard()
  setTimeout(() => { if (canLand()) show('main') }, 400)
  show('selected')
  context.mock.timers.tick(400)
  assert.deepEqual(opened, [])
  list.set('selected')
  list.setMain('selected')
  assert.deepEqual(opened, ['selected'])
  assert.equal(canLand(), false)
})

test('default landings remain blocked until the selected Session is retained', () => {
  const list = store(['selected'])
  const { show, opened } = rig(list)
  show('selected')
  const canLand = show.guard()
  assert.equal(canLand(), false, 'openSession has not yet retained the destination')
  list.set('main')
  assert.equal(canLand(), false, 'other list updates do not finish the explicit navigation')
  list.setMain('selected')
  assert.equal(canLand(), false, 'a landing prepared for the empty view is now stale')
  assert.equal(show.guard()(), true, 'the settled destination may prepare a later landing')
  assert.deepEqual(opened, ['selected'])
  assert.equal(list.listeners(), 0)
})

test('an immediately retained explicit selection invalidates an earlier default landing', () => {
  const list = store(['main', 'selected'])
  const opened = []
  const show = listedOpener({ list, current: () => mainViewOf(list), open: id => { opened.push(id); list.setMain(id) } })
  const canLand = show.guard()
  show('selected')
  if (canLand()) show('main')
  assert.deepEqual(opened, ['selected'])
  assert.equal(list.listeners(), 0)
})

test('an external navigation keeps its destination and permits later automatic navigation', () => {
  const list = store(['before', 'elsewhere'])
  list.setMain('before')
  const { show, opened } = rig(list)
  show('selected')
  list.setMain('elsewhere')
  list.set('selected')
  assert.deepEqual(opened, [])
  assert.equal(show.guard()(), true)
  assert.equal(list.listeners(), 0)
})

test('a selection during an asynchronous landing refresh invalidates its continuation', async () => {
  const list = store(['main', 'selected'])
  const { show, opened } = rig(list)
  const canLand = show.guard()
  let refreshed
  const refresh = new Promise(resolve => { refreshed = resolve })
  const landing = (async () => {
    if (!canLand()) return
    await refresh
    if (canLand()) show('main')
  })()
  show('selected')
  list.setMain('selected')
  refreshed()
  await landing
  assert.deepEqual(opened, ['selected'])
})

test('an untouched empty view can still land on the Main Bot', () => {
  const list = store(['main'])
  const { show, opened } = rig(list)
  const canLand = show.guard()
  if (canLand()) show('main')
  assert.deepEqual(opened, ['main'])
})

test('disposal cancels list subscriptions and invalidates outstanding default landings', () => {
  const list = store()
  const { show, opened } = rig(list)
  const canLand = show.guard()
  show('selected')
  assert.equal(list.listeners(), 1)
  show.cancel()
  list.set('selected')
  assert.equal(list.listeners(), 0)
  assert.equal(canLand(), false)
  assert.deepEqual(opened, [])
})
