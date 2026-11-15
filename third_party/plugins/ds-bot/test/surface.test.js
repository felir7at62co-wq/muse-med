import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canReuseOrdinarySession, classicWorkspaceTarget, freePriority, groupsFor, ordinarySessionStarter, readMode, surfaceGroups, surfaceSelections, writeMode } from '../src/client/surface.js'
import { STORAGE } from '../src/client/storage.js'

test('only a switch to classic view carries the displayed Bot current part to the workspace', () => {
  const bot = { id: 'writer', sessionId: 'current' }
  const roster = { byId: { writer: bot, current: bot, old: bot } }
  assert.deepEqual(classicWorkspaceTarget('bot', 'agent', 'current', roster), { botId: 'writer', sessionId: 'current' })
  for (const [from, to, id] of [['agent', 'agent', 'current'], ['bot', 'bot', 'current'], ['bot', 'agent', 'old'], ['bot', 'agent', 'outside'], ['bot', 'agent', undefined]]) {
    assert.equal(classicWorkspaceTarget(from, to, id, roster), undefined)
  }
})

test('Bot mode mounts both groups; Agent mode mounts neither', () => {
  assert.deepEqual(groupsFor({ mode: 'bot' }), { shell: true, conversation: true })
  assert.deepEqual(groupsFor({ mode: 'bot', plain: false }), { shell: true, conversation: true })
  assert.deepEqual(groupsFor({ mode: 'agent' }), { shell: false, conversation: false })
  assert.deepEqual(groupsFor({ mode: 'agent', plain: true }), { shell: false, conversation: false })
})

test('a plain Bot-mode view keeps the shell but drops the conversation', () => {
  assert.deepEqual(groupsFor({ mode: 'bot', plain: true }), { shell: true, conversation: false })
})

test('the saved surface mode survives reloads and defaults to bot', () => {
  const store = new Map()
  const storage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
    removeItem: key => store.delete(key),
  }
  assert.equal(readMode(storage), 'bot')
  writeMode('agent', storage)
  assert.equal(readMode(storage), 'agent')
  writeMode('bot', storage)
  assert.equal(readMode(storage), 'bot')
  store.set(STORAGE.surface, 'nonsense')
  assert.equal(readMode(storage), 'bot')
})

const recordingGroups = (log, { failing = null } = {}) => {
  const entry = name => () => () => {
    log.push(name)
    if (name === failing) throw new Error(`could not release ${name}`)
  }
  return surfaceGroups({
    shell: () => { log.push('install shell'); return [entry('shell styles'), entry('shell theme')] },
    conversation: () => { log.push('install conversation'); return [entry('conversation styles'), entry('conversation tokens'), entry('conversation cells')] },
  })
}

test('switching to Agent mode withdraws the conversation before the shell, last entry first', (t) => {
  t.mock.method(console, 'warn', () => {})
  const log = []
  const groups = recordingGroups(log)
  groups.reconcile(groupsFor({ mode: 'bot' }))
  assert.deepEqual(log, ['install shell', 'install conversation'])
  log.length = 0
  groups.reconcile(groupsFor({ mode: 'agent' }))
  assert.deepEqual(log, ['conversation cells', 'conversation tokens', 'conversation styles', 'shell theme', 'shell styles'])
})

test('a throwing disposer does not stop the rest, and the group can be installed again', (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const log = []
  const groups = recordingGroups(log, { failing: 'conversation tokens' })
  groups.reconcile(groupsFor({ mode: 'bot' }))
  log.length = 0
  assert.doesNotThrow(() => groups.reconcile(groupsFor({ mode: 'agent' })))
  assert.deepEqual(log, ['conversation cells', 'conversation tokens', 'conversation styles', 'shell theme', 'shell styles'])
  assert.equal(warn.mock.callCount(), 1)
  log.length = 0
  groups.reconcile(groupsFor({ mode: 'bot' }))
  assert.deepEqual(log, ['install shell', 'install conversation'])
})

test('unloading the plugin disposes every group even when a disposer throws', (t) => {
  t.mock.method(console, 'warn', () => {})
  const log = []
  const groups = recordingGroups(log, { failing: 'conversation cells' })
  groups.reconcile(groupsFor({ mode: 'bot' }))
  log.length = 0
  assert.doesNotThrow(() => groups.dispose())
  assert.deepEqual(log, ['conversation cells', 'conversation tokens', 'conversation styles', 'shell theme', 'shell styles'])
  log.length = 0
  groups.dispose()
  assert.deepEqual(log, [])
})

test('a group whose install throws stays unmounted and is tried again', (t) => {
  t.mock.method(console, 'warn', () => {})
  let attempts = 0
  const groups = surfaceGroups({
    shell: () => [() => () => {}],
    conversation: () => [() => { attempts += 1; if (attempts === 1) throw new Error('slot refused'); return () => {} }],
  })
  assert.doesNotThrow(() => groups.reconcile(groupsFor({ mode: 'bot' })))
  groups.reconcile(groupsFor({ mode: 'bot', plain: true }))
  groups.reconcile(groupsFor({ mode: 'bot' }))
  assert.equal(attempts, 2)
})

// 公开#149: another plugin held a cell at the same priority, so one step of the
// conversation group threw after the styles, the header and the chat cells were on.
test('a group whose step throws takes back the steps before it, so Agent mode leaves nothing behind', (t) => {
  t.mock.method(console, 'warn', () => {})
  const live = new Set()
  const mount = name => () => { live.add(name); return () => live.delete(name) }
  const collide = () => { throw new Error('single slot "conversation.input.model" already has a registration at priority -10') }
  const errors = []
  const groups = surfaceGroups({
    shell: () => [mount('shell styles')],
    conversation: () => [mount('conversation css'), mount('HeaderPill'), mount('chat.node cells'), collide, mount('bot-plus')],
  }, { onError: (group, error) => errors.push([group, error.message]) })
  groups.reconcile(groupsFor({ mode: 'bot' }))
  assert.deepEqual([...live], ['shell styles'])
  assert.deepEqual(errors.map(([group]) => group), ['conversation'])
  groups.reconcile(groupsFor({ mode: 'agent' }))
  assert.deepEqual([...live], [])
})

test('a shell that cannot go on keeps the conversation group off too', (t) => {
  t.mock.method(console, 'warn', () => {})
  const live = new Set()
  const mount = name => () => { live.add(name); return () => live.delete(name) }
  const groups = surfaceGroups({
    shell: () => [mount('shell styles'), () => { throw new Error('slot refused') }],
    conversation: () => [mount('conversation css')],
  })
  groups.reconcile(groupsFor({ mode: 'bot' }))
  assert.deepEqual([...live], [])
})

test('remount takes a mounted group off and installs it again', (t) => {
  t.mock.method(console, 'warn', () => {})
  const log = []
  const groups = recordingGroups(log)
  groups.reconcile(groupsFor({ mode: 'bot' }))
  log.length = 0
  groups.remount('shell', groupsFor({ mode: 'bot' }))
  assert.deepEqual(log, ['conversation cells', 'conversation tokens', 'conversation styles', 'shell theme', 'shell styles', 'install shell', 'install conversation'])
  log.length = 0
  // Without a wanted set remount falls back to the last reconciled one.
  groups.remount('shell')
  assert.deepEqual(log, ['conversation cells', 'conversation tokens', 'conversation styles', 'shell theme', 'shell styles', 'install shell', 'install conversation'])
  log.length = 0
  // A group the surface does not want stays off — remount only retries mounts.
  groups.reconcile(groupsFor({ mode: 'agent' }))
  log.length = 0
  groups.remount('shell', groupsFor({ mode: 'agent' }))
  assert.deepEqual(log, [])
  groups.dispose()
})

// A withdraw that throws on the way down does not strand the conversation
// group: the remount still takes the shell off and puts both back.
test('a failed shell withdraw does not strand the conversation group', (t) => {
  t.mock.method(console, 'warn', () => {})
  const log = []
  const groups = recordingGroups(log, { failing: 'shell theme' })
  groups.reconcile(groupsFor({ mode: 'bot' }))
  log.length = 0
  groups.remount('shell', groupsFor({ mode: 'bot' }))
  assert.deepEqual(log, ['conversation cells', 'conversation tokens', 'conversation styles', 'shell theme', 'shell styles', 'install shell', 'install conversation'])
  groups.dispose()
})

test('a shadow goes below every entry of its cell, so a same-priority plugin does not block it', () => {
  const entry = options => ({ options })
  assert.equal(freePriority([], { priority: -100 }), -100)
  assert.equal(freePriority([entry({}), entry({ priority: -10 })], { priority: -100 }), -100)
  assert.equal(freePriority([entry({}), entry({ priority: -100 })], { priority: -100 }), -101)
  assert.equal(freePriority([entry({ priority: -200 })], { priority: -100 }), -201)
  // Keyed and list cells: only the same key or id share the cell.
  assert.equal(freePriority([entry({ key: 'tool-call', priority: -100 }), entry({ key: 'user', priority: -300 })], { key: 'tool-call', priority: -100 }), -101)
  assert.equal(freePriority([entry({ id: 'usage', priority: -100 })], { id: 'activity', priority: -100 }), -100)
  assert.equal(freePriority([entry({ priority: -100 })], {}), undefined)
})

test('readMode falls back to bot when storage throws', () => {
  assert.equal(readMode({ getItem: () => { throw new Error('denied') } }), 'bot')
})

test('ordinary blank reuse excludes all Host-owned identities and waits for complete ownership', () => {
  const ownedSessionIds = ['bot', 'current-part', 'past-part', 'group-current', 'group-past', 'private-archive']
  const roster = { ready: true, ownedSessionIds }
  for (const id of ownedSessionIds) assert.equal(canReuseOrdinarySession(id, roster), false)
  assert.equal(canReuseOrdinarySession('ordinary', roster), true)
  assert.equal(canReuseOrdinarySession('ordinary', { ...roster, ready: false }), false)
  assert.equal(canReuseOrdinarySession('ordinary', { ready: true }), false)
})

test('each mode restores its own Session without changing models, drafts or running work', async () => {
  const { surfaceSelections } = await import('../src/client/surface.js')
  const saved = new Map()
  const storage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) }
  const bot = { id: 'writer', sessionId: 'bot-part', model: 'cloud/gemini', effort: 'high' }
  const roster = { mainBotId: 'writer', bots: [bot], rooms: [], byId: { writer: bot, 'bot-part': bot }, roomsById: {} }
  const list = { byId: {
    ordinary: { id: 'ordinary', updatedAt: 1, running: true, draft: 'keep me', model: 'cloud/deepseek' },
    'bot-part': { id: 'bot-part', updatedAt: 2, running: true, draft: 'another draft' },
    child: { id: 'child', updatedAt: 3, origin: 'subagent' },
  } }
  const original = structuredClone({ list, roster })
  const selections = surfaceSelections(storage)
  assert.equal(selections.target('agent', list, roster), 'ordinary')
  assert.equal(selections.target('bot', list, roster), 'bot-part')
  for (let attempt = 0; attempt < 3; attempt++) {
    selections.remember('agent', 'ordinary', roster)
    selections.remember('bot', 'bot-part', roster)
    assert.equal(selections.target('agent', list, roster), 'ordinary')
    assert.equal(selections.target('bot', list, roster), 'bot-part')
  }
  assert.deepEqual({ list, roster }, original)
  const reopened = surfaceSelections(storage)
  assert.equal(reopened.target('agent', list, roster), 'ordinary')
  assert.equal(reopened.target('bot', list, roster), 'bot-part')
  // A fresh Bot part is followed without dropping the ordinary selection.
  bot.sessionId = 'fresh-part'
  roster.byId['fresh-part'] = bot
  assert.equal(reopened.target('bot', list, roster), 'fresh-part')
  assert.equal(reopened.target('agent', list, roster), 'ordinary')
})

test('a mode without an ordinary Session requests creation only until a blank Session is listed', async () => {
  const { surfaceSelections } = await import('../src/client/surface.js')
  const selections = surfaceSelections({ getItem: () => null, setItem() {} })
  const bot = { id: 'chief' }
  const roster = { mainBotId: 'chief', bots: [bot], rooms: [], byId: { chief: bot }, roomsById: {} }
  const list = { byId: { chief: { id: 'chief', updatedAt: 2 } } }
  assert.equal(selections.target('agent', list, roster), undefined)
  list.byId.blank = { id: 'blank', blank: true, updatedAt: 3 }
  for (let attempt = 0; attempt < 3; attempt++) assert.equal(selections.target('agent', list, roster), 'blank')
})

function ordinaryCreationFixture() {
  const selections = surfaceSelections({ getItem: () => null, setItem() {} })
  const bot = { id: 'chief', sessionId: 'bot-blank' }
  const roster = { mainBotId: 'chief', bots: [bot], rooms: [], byId: { chief: bot, 'bot-blank': bot }, roomsById: {} }
  const list = { byId: { 'bot-blank': { id: 'bot-blank', blank: true, updatedAt: 2 } } }
  const requests = [], opened = []
  let mode = 'agent'
  let current = 'bot-blank'
  let finish, fail
  const starter = ordinarySessionStarter({
    create: options => {
      requests.push(options)
      return new Promise((resolve, reject) => {
        finish = () => {
          list.byId.ordinary = { id: 'ordinary', blank: true, updatedAt: 3 }
          resolve('ordinary')
        }
        fail = reject
      })
    },
    open: id => { current = id; opened.push(id) },
    current: () => current,
    isActive: () => mode === 'agent',
    remember: id => selections.remember('agent', id, roster),
  })
  return { starter, requests, opened, list, roster, selections, finish: () => finish(), fail: error => fail(error),
    leave: () => { mode = 'bot'; starter.cancel() }, enter: () => { mode = 'agent' },
    select: id => { current = id }, current: () => current }
}

test('the first ordinary Session is newly created once and never reuses the only blank Bot', async () => {
  const f = ordinaryCreationFixture()
  assert.equal(f.selections.target('agent', f.list, f.roster), undefined)
  const first = f.starter.start('workspace')
  await Promise.resolve()
  f.leave()
  f.enter()
  const again = f.starter.start('workspace')
  assert.equal(again, first)
  assert.deepEqual(f.requests, [{ workspaceId: 'workspace' }])
  f.finish()
  assert.equal(await first, 'ordinary')
  assert.deepEqual(f.opened, ['ordinary'])
  for (let attempt = 0; attempt < 3; attempt++) assert.equal(f.selections.target('agent', f.list, f.roster), 'ordinary')
  assert.equal(f.selections.target('bot', f.list, f.roster), 'bot-blank')
  assert.equal(f.roster.bots.length, 1)
  assert.equal(f.roster.byId.ordinary, undefined)
})

test('leaving the surface keeps a late-created Session without navigating into it', async () => {
  const f = ordinaryCreationFixture()
  const pending = f.starter.start('workspace')
  await Promise.resolve()
  f.leave()
  f.finish()
  await pending
  assert.deepEqual(f.opened, [])
  assert.equal(f.selections.target('agent', f.list, f.roster), 'ordinary')
  assert.equal(f.selections.target('bot', f.list, f.roster), 'bot-blank')
})

test('a late-created ordinary Session does not replace another Session opened in the same mode', async () => {
  const f = ordinaryCreationFixture()
  const pending = f.starter.start('workspace')
  await Promise.resolve()
  f.list.byId.another = { id: 'another', updatedAt: 4 }
  f.select('another')
  f.finish()
  assert.equal(await pending, 'ordinary')
  assert.deepEqual(f.opened, [])
  assert.equal(f.current(), 'another')
  assert.ok(f.list.byId.ordinary)
  f.selections.remember('agent', f.current(), f.roster)
  assert.equal(f.selections.target('agent', f.list, f.roster), 'another')
})

test('unloading the surface stops late navigation and leaves the created Session catalogued', async () => {
  const f = ordinaryCreationFixture()
  const pending = f.starter.start('workspace')
  await Promise.resolve()
  f.starter.dispose()
  f.finish()
  await pending
  assert.deepEqual(f.opened, [])
  assert.ok(f.list.byId.ordinary)
  await f.starter.start('workspace')
  assert.equal(f.requests.length, 1)
})

test('a failed ordinary Session creation can be retried without reusing the Bot identity', async () => {
  const f = ordinaryCreationFixture()
  const pending = f.starter.start('workspace')
  await Promise.resolve()
  f.fail(new Error('workspace unavailable'))
  await assert.rejects(pending, /workspace unavailable/)
  assert.deepEqual(f.opened, [])
  const retry = f.starter.start('workspace')
  await Promise.resolve()
  assert.deepEqual(f.requests, [{ workspaceId: 'workspace' }, { workspaceId: 'workspace' }])
  f.finish()
  await retry
  assert.deepEqual(f.opened, ['ordinary'])
})
