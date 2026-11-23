import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/member-status.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports,
  require: (name) => {
    const platform = {
      react: { createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx }, useContext: ctx => ctx.value, useMemo: make => make(), useCallback: fn => fn, useId: () => 'dv-id', useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }), useState: initial => [initial, () => {}], useEffect: () => {}, useRef: initial => ({ current: initial }), useLayoutEffect: () => {}, Fragment: 'fragment' },
      'react-dom': {},
      '@deepseek-ai/dsh-client-ui-primitives': {},
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { busyMembers, summaryText, MemberDock, MemberState, StopMemberWork, StopRoomWork, memberWork, teamWork } = module.exports
// Values from the bundle's realm compare by content only.
const plain = value => JSON.parse(JSON.stringify(value))
// The dock's capsule in an element tree.
const capsuleOf = (node) => {
  if (node === null || typeof node !== 'object') return null
  // A component element renders in place, as React would.
  if (typeof node.type === 'function') return capsuleOf(node.type(node.props))
  if (node.props.className === 'bt-mw-pill' || node.props.className === 'bt-team-toggle') return node
  for (const child of node.children) {
    const found = capsuleOf(child)
    if (found) return found
  }
  return null
}

test('the members line names who waits for an approval first, then who is at work', () => {
  const names = { a: 'Anvil', b: 'Flint', c: 'Prism', d: 'Quill', e: 'King', f: 'Comet' }
  const roster = { byId: Object.fromEntries(Object.entries(names).map(([id, name]) => [id, { id, name }])) }
  const room = { id: 'r1', members: ['e', 'd', 'a', 'b', 'c', 'f'] }
  const work = {
    bots: { d: { since: 1, tool: 'edit' }, a: { since: 1, tool: 'pwsh' }, f: { since: 1 } },
    rooms: { r1: [{ botId: 'd', since: 1, tool: 'edit' }, { botId: 'f', since: 1 }] },
    approvals: [{ botId: 'a' }, { botId: 'b' }, { botId: 'c' }],
  }
  const busy = busyMembers(room, work, roster)
  assert.deepEqual(plain(busy.map(entry => [entry.bot.name, entry.state])), [['Anvil', 'ask'], ['Flint', 'ask'], ['Prism', 'ask'], ['Quill', 'work'], ['Comet', 'work']])
  assert.deepEqual(plain(summaryText(busy)), { waiting: 'Anvil, Flint and 1 more are waiting for your approval', doing: 'Quill · Writing changes… +1' })
  assert.deepEqual(plain(summaryText(busy.slice(1, 3))), { waiting: 'Flint and Prism are waiting for your approval', doing: '' })
  assert.deepEqual(plain(summaryText(busy.slice(4))), { waiting: '', doing: 'Comet · Thinking about it…' })
  assert.equal(busyMembers(room, { bots: {}, approvals: [] }, roster).length, 0)
})

const names = { a: 'Anvil', b: 'Flint', c: 'Prism', d: 'Quill' }
const team = {
  byId: Object.fromEntries(Object.entries(names).map(([id, name]) => [id, { id, name }])),
  roomsById: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b', 'c', 'd'] }, r2: { id: 'r2', name: 'Docs', members: ['a', 'b'] } },
}

// #156: a member waiting for an approval keeps its work here, so Stop stays.
test('a member waiting for approval in this group can still be stopped', async () => {
  const stopped = []
  const room = team.roomsById.r1
  const entry = busyMembers(room, { rooms: { r1: [{ botId: 'a', since: 1 }] }, approvals: [{ botId: 'a', roomId: 'r1', at: 1 }] }, team)[0]
  assert.equal(entry.state, 'ask')
  const node = StopMemberWork({ entry, bot: team.byId.a, room, actions: { stopMemberWork: (...args) => stopped.push(args) } })
  assert.ok(node, 'waiting for approval must not hide Stop')
  node.props.onClick()
  await Promise.resolve()
  assert.deepEqual(stopped, [['r1', 'a']])
})

test('an approval for work elsewhere never offers to stop work in this group', () => {
  const room = team.roomsById.r1
  const entry = busyMembers(room, { rooms: { r2: [{ botId: 'a', since: 1 }] }, approvals: [{ botId: 'a', roomId: 'r2', at: 1 }] }, team)[0]
  assert.equal(StopMemberWork({ entry, bot: team.byId.a, room, actions: {} }), null)
  // Work here stays stoppable while it runs.
  const working = busyMembers(room, { rooms: { r1: [{ botId: 'a', since: 1 }] }, approvals: [] }, team)[0]
  assert.ok(StopMemberWork({ entry: working, bot: team.byId.a, room, actions: {} }))
})

test('a failed stop is reported and never answers the approval', async () => {
  const reported = []
  const room = team.roomsById.r1
  const entry = busyMembers(room, { rooms: { r1: [{ botId: 'a', since: 1 }] }, approvals: [{ botId: 'a', roomId: 'r1', at: 1 }] }, team)[0]
  const node = StopMemberWork({ entry, bot: team.byId.a, room, actions: {
    stopMemberWork: () => Promise.reject(new Error('connection lost')),
    reportError: (error, action) => reported.push([error.message, action]),
  } })
  assert.ok(node)
  node.props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(reported, [['connection lost', 'stop']])
})
// #592: DSH's own stop reaches only the round; a member the round moved on from kept working.
test('the stop button of a group\'s details stops all work there, and shows only while work is here', async () => {
  const stopped = []
  const room = team.roomsById.r1
  const actions = { stopRoomWork: id => stopped.push(id) }
  const shown = work => StopRoomWork({ room, entries: memberWork(room, work), actions })
  const button = shown({ bots: {}, rooms: { r1: [{ botId: 'a', since: 1, tool: 'pwsh' }] }, approvals: [] })
  assert.equal(button.props['aria-label'], 'Stop all work in this group')
  button.props.onClick()
  await Promise.resolve()
  assert.deepEqual(stopped, ['r1'])
  // Members busy only in their own chats or in another group have nothing here to stop.
  assert.equal(shown({ bots: { a: { since: 1, tool: 'pwsh' }, b: { since: 1, roomId: 'r2' } }, rooms: { r2: [{ botId: 'b', since: 1 }] }, approvals: [] }), null)
  assert.equal(shown({ bots: {}, rooms: { r2: [{ botId: 'a', since: 1 }] }, approvals: [{ botId: 'a', roomId: 'r2', at: 1 }] }), null)
  // A turn waiting for an approval here still holds its work.
  assert.ok(shown({ bots: {}, rooms: { r1: [{ botId: 'a', since: 1 }] }, approvals: [{ botId: 'a', roomId: 'r1', at: 1 }] }))
})

test('a failed stop of a group\'s work is reported', async () => {
  const reported = []
  const room = team.roomsById.r1
  const button = StopRoomWork({ room, entries: memberWork(room, { bots: {}, rooms: { r1: [{ botId: 'a', since: 1 }] }, approvals: [] }), actions: {
    stopRoomWork: () => Promise.reject(new Error('connection lost')),
    reportError: (error, action) => reported.push([error.message, action]),
  } })
  button.props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(reported, [['connection lost', 'stop']])
})
// The capsule's label and what a click on it asks for.
const dock = (sessionId, work) => {
  const calls = []
  const actions = { showDetails: id => calls.push(['details', id]), openSession: id => calls.push(['session', id]) }
  const capsule = capsuleOf(MemberDock({ sessionId, useRoster: pick => pick(team), useWork: pick => pick(work), actions }))
  if (!capsule) return null
  capsule.props.onClick()
  return { label: capsule.props['aria-label'], calls }
}

test('one capsule names who waits and who works, without the round\'s speaker, and opens the details', () => {
  const work = {
    // Anvil runs in its own chat too; its work here wins. Coral's work in r2 shows
    // there and on its own chat, not here (#473).
    bots: { a: { since: 1, tool: 'pwsh' }, b: { since: 1, roomId: 'r2', tool: 'edit' } },
    rooms: { r1: [{ botId: 'a', since: 1, tool: 'write' }, { botId: 'd', since: 1, speaking: true }], r2: [{ botId: 'b', since: 1, tool: 'edit' }] },
    approvals: [{ botId: 'c', roomId: 'r1' }],
  }
  assert.deepEqual(plain(dock('r1', work)), { label: 'Prism is waiting for your approval · Anvil · Writing changes…', calls: [['details', 'r1']] })
  assert.equal(dock('r1', { bots: {}, rooms: { r1: [{ botId: 'd', since: 1, speaking: true }] }, approvals: [] }), null)
})

test('a Bot\'s own chat shows the groups it is at work in, unless its own chat runs', () => {
  const away = { bots: { a: { since: 1, roomId: 'r1', tool: 'pwsh' } }, rooms: { r1: [{ botId: 'a', since: 1, tool: 'pwsh' }], r2: [{ botId: 'a', since: 1 }] }, approvals: [] }
  assert.deepEqual(plain(dock('a', away)), { label: 'in Ops · Running shell commands… +1', calls: [['session', 'r1']] })
  assert.equal(dock('a', { ...away, bots: { a: { since: 1 } } }), null)
  assert.equal(dock('b', away), null)
})

test('the capsule says what a member does in its call\'s own words, and that it moves to a fresh conversation', () => {
  const label = doing => dock('r1', { bots: {}, rooms: { r1: [{ botId: 'a', since: 1, ...doing }] }, approvals: [] }).label
  assert.equal(label({ tool: 'pwsh', note: 'Download Ghidra 12.1.4 and check its hash.' }), 'Anvil · Download Ghidra 12.1.4 and check its hash…')
  assert.equal(label({ tool: 'read', target: 'dump.py' }), 'Anvil · Opening a file · dump.py…')
  assert.equal(label({ switching: true }), 'Anvil · Moving to a fresh conversation…')
  assert.equal(label({ switching: true, folder: true }), 'Anvil · Switching working folder…')
  assert.equal(label({ tool: 'pwsh', said: '解压 Ghidra，顺便写脚本。', note: 'Expand-Archive' }), 'Anvil · 解压 Ghidra，顺便写脚本…')
})

test('a member\'s line runs a clock from its turn\'s start or its approval\'s', () => {
  // The clock renders as `{since}` here; it ticks on its own.
  const flat = node => (node === null || node === '' ? '' : typeof node === 'string' ? node
    : node.props.at !== undefined ? `{${node.props.at}}` : node.children.map(flat).join(''))
  const stateText = entry => flat(MemberState({ entry, bot: { id: 'a', name: 'Anvil' }, room: { id: 'r1' }, roster: team }))
  assert.equal(stateText({ state: 'work', doing: { roomId: 'r1', tool: 'pwsh', since: 1_000 } }), 'Running shell commands…{1000}')
  assert.equal(stateText({ state: 'ask', approvals: [{ at: 2_000 }] }), 'Waiting for your approval{2000}')
  assert.equal(flat(MemberState({ entry: { state: 'idle' }, bot: { id: 'a', name: 'Anvil', role: 'Writer' }, room: { id: 'r1' }, roster: team })), 'Writer')
})

// Muse: a Main Bot's own chat shows the whole team in one capsule.
test('a Main Bot sees who waits for an approval or an answer first, then who is at work', () => {
  const bots = { m: { id: 'm', name: 'Muse' }, a: { id: 'a', name: 'Anvil' }, b: { id: 'b', name: 'Flint' }, d: { id: 'd', name: 'Quill' } }
  const roster = {
    byId: { ...bots, 's-b': bots.b }, roomsById: {}, mainBotIds: ['m'],
    questions: { 's-b': { id: 'q1', question: 'How does episode 10 end?', options: [{ label: 'Cliffhanger' }, { label: 'Close it' }] } },
  }
  const work = { bots: { m: { since: 1 }, d: { since: 1, tool: 'edit' } }, approvals: [{ id: 'p1', botId: 'a', tool: 'image_generate' }] }
  const { asking, working } = teamWork(bots.m, roster, work)
  assert.deepEqual(plain(asking.map(entry => [entry.bot.name, entry.approvals.length, entry.question?.id ?? null])), [['Anvil', 1, null], ['Flint', 0, 'q1']])
  assert.deepEqual(plain(working.map(entry => entry.bot.name)), ['Quill'])
  const capsule = capsuleOf(MemberDock({ sessionId: 'm', useRoster: pick => pick(roster), useWork: pick => pick(work), actions: {} }))
  assert.equal(capsule.props['aria-label'], 'Anvil and Flint are waiting for you · Quill · Writing changes…')
  // Another Bot's own chat keeps the group capsule, which has nothing to show here.
  assert.equal(capsuleOf(MemberDock({ sessionId: 'd', useRoster: pick => pick(roster), useWork: pick => pick(work), actions: {} })), null)
})

// The team capsule opens in place. These render it with hooks that keep their state between
// renders, so a press and a change of the team show in the next tree.
function teamStage({ effects } = {}) {
  let slots = []
  let cursor = 0
  let own = false
  const clock = { now: 1_000_000 }
  const slot = (make) => {
    if (!own) return make()
    const index = cursor
    cursor += 1
    if (!(index in slots)) slots[index] = make()
    return slots[index]
  }
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
    useContext: ctx => ctx.value, useMemo: make => make(), useCallback: fn => fn, useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(), Fragment: 'fragment',
    useId: () => 'team-id', useEffect: () => {}, useLayoutEffect: () => {},
    useRef: initial => slot(() => ({ current: initial })),
    useState: (initial) => {
      const cell = slot(() => ({ value: typeof initial === 'function' && own ? initial() : initial }))
      return [cell.value, (next) => { cell.value = typeof next === 'function' ? next(cell.value) : next }]
    },
  }
  const exported = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, {
    module: exported, exports: exported.exports,
    Date: { now: () => clock.now },
    document: effects ? { body: { dataset: { btEffects: effects } } } : undefined,
    require: (name) => {
      if (name === 'react') return react
      if (name === 'react-dom' || name === '@deepseek-ai/dsh-client-ui-primitives') return {}
      throw new Error(`no platform module ${name}`)
    },
  })
  const bots = Object.fromEntries(Object.entries({ m: 'Muse', a: 'Anvil', b: 'Flint', c: 'Prism', d: 'Quill', e: 'King', f: 'Comet', g: 'Coral', h: 'Onyx' }).map(([id, name]) => [id, { id, name }]))
  const roster = { byId: bots, roomsById: {}, mainBotIds: ['m'], questions: {} }
  const state = { work: { bots: {}, approvals: [] } }
  // Only the capsule keeps state; what it draws inside renders in place, as in the tests above.
  const expand = (node) => {
    if (node === null || typeof node !== 'object') return node
    if (typeof node.type === 'function') {
      const team = node.type.name === 'TeamDock'
      if (team) { own = true; cursor = 0 }
      const drawn = node.type({ ...node.props, children: node.children })
      if (team) own = false
      return expand(drawn)
    }
    return { ...node, children: node.children.map(expand) }
  }
  return {
    clock, exports: exported.exports,
    set work(next) { state.work = next },
    render: () => expand(exported.exports.MemberDock({ sessionId: 'm', useRoster: pick => pick(roster), useWork: pick => pick(state.work), actions: {} })),
    reset: () => { slots = [] },
  }
}
const all = (node, test, found = []) => {
  if (node === null || typeof node !== 'object') return found
  if (test(node)) found.push(node)
  for (const child of node.children) all(child, test, found)
  return found
}
const named = (node, name) => all(node, item => String(item.props.className ?? '').split(' ').includes(name))
const textOf = node => (typeof node === 'string' ? node : node === null || typeof node !== 'object' ? '' : node.children.map(textOf).join(''))
const two = { bots: { a: { since: 1, said: 'On it' }, b: { since: 1, tool: 'edit' } }, approvals: [] }
const one = { bots: { a: { since: 1, said: 'On it' } }, approvals: [] }

test('the open team capsule is one surface: the same shell holds the capsule and its rows', () => {
  const stage = teamStage()
  stage.work = two
  const closed = stage.render()
  const [shell] = named(closed, 'bt-team-shell')
  assert.equal(named(closed, 'bt-team-shell').length, 1)
  assert.equal(shell.props['data-open'], undefined)
  // The capsule's button, then the rows, both inside the shell and nowhere else.
  assert.deepEqual(shell.children.map(child => child.props.className), ['bt-team-toggle', 'bt-team-reveal'])
  const [toggle, reveal] = shell.children
  assert.equal(toggle.props['aria-expanded'], false)
  assert.equal(toggle.props['aria-label'], 'Anvil · On it… +1')
  assert.equal(reveal.props['aria-hidden'], true)
  assert.equal(reveal.props.inert, '')
  const [panel] = named(reveal, 'bt-team-panel')
  assert.equal(toggle.props['aria-controls'], panel.props.id)
  assert.equal(panel.props.role, 'region')
  assert.equal(named(panel, 'bt-team-row').length, 2)
  assert.equal(named(closed, 'bt-team-row').length, 2)

  toggle.props.onClick()
  const open = stage.render()
  const [opened] = named(open, 'bt-team-shell')
  assert.equal(opened.props['data-open'], true)
  assert.deepEqual(opened.children.map(child => child.props.className), ['bt-team-toggle', 'bt-team-reveal'])
  assert.equal(opened.children[0].props['aria-expanded'], true)
  assert.equal(opened.children[0].props['aria-label'], 'Collapse')
  assert.equal(opened.children[1].props['aria-hidden'], false)
  assert.equal(opened.children[1].props.inert, undefined)
  // Escape closes it from anywhere inside.
  let stopped = false
  opened.props.onKeyDown({ key: 'Escape', defaultPrevented: false, stopPropagation: () => { stopped = true } })
  assert.equal(stopped, true)
  assert.equal(named(stage.render(), 'bt-team-shell')[0].props['data-open'], undefined)
})

test('the capsule hands its avatars and words over to the rows', () => {
  const stage = teamStage()
  stage.work = two
  const tree = stage.render()
  const [shell] = named(tree, 'bt-team-shell')
  const [summary] = named(tree, 'bt-team-summary')
  const rows = named(tree, 'bt-team-row')
  // Each avatar in the capsule has its twin at the start of its Bot's row.
  assert.deepEqual(named(summary, 'bt-mw-face').map(face => face.props['data-bot']), ['a', 'b'])
  assert.deepEqual(rows.map(row => named(row, 'bt-mw-face')[0].props['data-bot']), ['a', 'b'])
  for (const row of rows) assert.equal(row.children[0].children[0].props.className, 'bt-mw-face')
  // The first row takes the capsule's words over; the others come in one after the other.
  assert.equal(shell.props['data-lead'], true)
  assert.deepEqual(rows.map(row => row.props['data-lead']), [true, undefined])
  assert.deepEqual(rows.map(row => row.props.style['--bt-team-row']), [0, 1])
  assert.deepEqual(rows.map(row => textOf(named(row, 'bt-team-text')[0])), ['AnvilOn it…· 1s', 'FlintWriting changes…· 1s'].map(text => text.replace('· 1s', textOf(named(rows[0], 'bt-team-time')[0]))))
  // The count is its own piece of the summary, so it can leave as the second row arrives.
  assert.equal(textOf(named(summary, 'bt-mw-doing')[0]), 'Anvil · On it…')
  const [more] = named(summary, 'bt-team-more')
  assert.equal(more.props['data-on'], true)
  assert.equal(textOf(more), '+1')

  // Somebody waiting comes first, and no row repeats the capsule's words.
  stage.reset()
  stage.work = { bots: { a: { since: 1 } }, approvals: [{ id: 'p1', botId: 'b', tool: 'image_generate' }] }
  const asking = stage.render()
  assert.equal(named(asking, 'bt-team-shell')[0].props['data-lead'], undefined)
  assert.deepEqual(named(asking, 'bt-team-row').map(row => [row.children[0].props.className, row.props['data-lead'], row.props.style['--bt-team-row']]), [['bt-team-ask', undefined, 0], ['bt-team-work', undefined, 1]])
  assert.deepEqual(named(named(asking, 'bt-team-summary')[0], 'bt-mw-face').map(face => [face.props['data-bot'], face.props['data-ask']]), [['b', true], ['a', undefined]])
  // Long lists stop adding to the wait.
  stage.reset()
  stage.work = { bots: Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(id => [id, { since: 1 }])), approvals: [] }
  const many = stage.render()
  assert.deepEqual(named(many, 'bt-team-row').map(row => row.props.style['--bt-team-row']), [0, 1, 2, 3, 4, 5, 5, 5])
  // The capsule shows four avatars; the rows past them have no seat to come from.
  assert.deepEqual(named(named(many, 'bt-team-summary')[0], 'bt-mw-face').map(face => face.props['data-bot']), ['a', 'b', 'c', 'd'])
  assert.equal(named(many, 'bt-team-more')[0].children[0], '+7')
})

test('a Bot that starts or finishes adds or removes its row and its avatar, and the one that left stays for its exit', () => {
  const stage = teamStage()
  stage.work = one
  const alone = stage.render()
  assert.equal(named(alone, 'bt-team-row').length, 1)
  assert.equal(named(alone, 'bt-team-more')[0].props['data-on'], undefined)
  assert.equal(named(named(alone, 'bt-team-summary')[0], 'bt-mw-face').length, 1)

  // One Bot to two: a second row, a second avatar and the count.
  stage.work = two
  const pair = stage.render()
  assert.deepEqual(named(pair, 'bt-team-row').map(row => [row.key ?? row.props.key, row.props['data-leaving']]), [['work:a', undefined], ['work:b', undefined]])
  assert.equal(named(pair, 'bt-team-more')[0].props['data-on'], true)
  assert.equal(capsuleOf(pair).props['aria-label'], 'Anvil · On it… +1')

  // Two to one: the row and the avatar that left are still drawn, marked as leaving.
  stage.clock.now += 50
  stage.work = one
  const leaving = stage.render()
  const rows = named(leaving, 'bt-team-row')
  assert.deepEqual(rows.map(row => [row.props.key, row.props['data-leaving'], row.props.inert]), [['work:a', undefined, undefined], ['work:b', true, '']])
  const seats = named(named(leaving, 'bt-team-summary')[0], 'bt-mw-face')
  assert.deepEqual(seats.map(face => [face.props['data-bot'], face.props['data-leaving'], face.props.style?.['--bt-team-seat']]), [['a', undefined, undefined], ['b', true, 1]])
  // The count goes, keeping its figure while it fades; the label already says what is true.
  const [more] = named(leaving, 'bt-team-more')
  assert.equal(more.props['data-on'], undefined)
  assert.equal(textOf(more), '+1')
  assert.equal(capsuleOf(leaving).props['aria-label'], 'Anvil · On it…')

  // Once the exit is over they are gone.
  stage.clock.now += 5000
  const settled = stage.render()
  assert.equal(named(settled, 'bt-team-row').length, 1)
  assert.equal(named(named(settled, 'bt-team-summary')[0], 'bt-mw-face').length, 1)

  // The last Bot finishing takes the capsule away, after its own exit.
  stage.work = { bots: {}, approvals: [] }
  const last = stage.render()
  assert.equal(named(last, 'bt-team-dock').length, 1, 'the fake useEffect never ends the linger')
  assert.equal(named(last, 'bt-team-row').length, 1)
})

test('with effects reduced or off nothing lingers and nothing travels', () => {
  for (const effects of ['reduced', 'off']) {
    const stage = teamStage({ effects })
    stage.work = two
    stage.render()
    stage.work = one
    const tree = stage.render()
    assert.deepEqual(named(tree, 'bt-team-row').map(row => row.props['data-leaving']), [undefined], effects)
    assert.equal(named(named(tree, 'bt-team-summary')[0], 'bt-mw-face').length, 1, effects)
  }
  const css = teamStage().exports.MEMBER_CSS
  const team = css.split('\n').filter(line => line.includes('.bt-team-'))
  // Both tiers and the system setting stop the capsule's own animations and leave its words a plain fade.
  const still = ':is(.bt-team-shell,.bt-team-row,.bt-team-shell .bt-mw-face,.bt-team-summary .bt-mw-doing){animation:none}'
  const plain = '.bt-team-shell :is(.bt-team-text,.bt-team-body,.bt-team-summary .bt-mw-label>*){transform:none;transition:opacity .12s ease-out}'
  assert.equal(css.includes(`body:is([data-bt-effects=reduced],[data-bt-effects=off]) ${still}`), true)
  assert.equal(css.includes(`body:is([data-bt-effects=reduced],[data-bt-effects=off]) ${plain}`), true)
  const media = team.find(line => line.startsWith('@media (prefers-reduced-motion:reduce)'))
  assert.equal(media.includes('.bt-team-shell,.bt-team-row,.bt-team-shell .bt-mw-face,.bt-team-summary .bt-mw-doing{animation:none}'), true)
  assert.equal(media.includes(plain), true)
  assert.equal(css.split(':is(.bt-team-shell,.bt-team-shell[data-open]) .bt-team-row[data-lead] .bt-team-time{transition:opacity .12s ease-out}').length, 3)
  // Every blur is one of the tokens those settings turn off.
  for (const line of team) {
    for (const [, value] of line.matchAll(/filter:([^;}]+)/g)) assert.match(value, /^(none|var\(--bt-fx-blur-\d,blur\(\dpx\)\))$/, line)
  }
  // The surface's box and corners come from the motion driver, not from a CSS transition.
  const shell = team.find(line => line.startsWith('.bt-team-shell{'))
  assert.equal(shell.includes('border-radius:var(--bt-team-radius,16px)'), true)
  assert.equal(shell.includes('transition'), false)
  assert.equal(css.includes('rotate:calc(var(--bt-team-p,0)*180deg)'), true)
  // Rows wait their turn: about 35 ms apart.
  assert.equal(css.includes('--bt-team-wait:calc(90ms + var(--bt-team-row,0)*35ms)'), true)
})
