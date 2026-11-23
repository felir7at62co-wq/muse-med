import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { outputFiles } = await build({
  stdin: {
    contents: `
      export { BackgroundPanel, backgroundView, botBackgroundSources, groupBackgroundSources } from './src/client/background-panel.js'
      export { publishSchedules } from './src/client/schedules.js'
    `,
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  Fragment: Symbol('Fragment'),
  useEffect() {}, useLayoutEffect() {}, useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useMemo: run => run(), useRef: current => ({ current }), useId: () => 'id',
  createContext: value => ({ Provider: 'Provider', value }), useContext: context => context.value,
  useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, require: name => (name === 'react' ? react : {}),
})
const { BackgroundPanel, backgroundView, botBackgroundSources, groupBackgroundSources, publishSchedules } = module.exports
const plain = value => JSON.parse(JSON.stringify(value))

function buttons(node) {
  if (node === null || typeof node !== 'object') return []
  if (typeof node.type === 'function') {
    return ['BackgroundSchedules', 'BackgroundRow', 'BackgroundTurnRow'].includes(node.type.name) ? buttons(node.type(node.props)) : []
  }
  return node.type === 'button' ? [node] : (node.children ?? []).flatMap(buttons)
}

const bot = { id: 'writer', name: 'Writer', sessionId: 'current', openParts: [{ sessionId: 'branch', parts: ['history'] }] }
const room = { id: 'room', sessionId: 'hub', members: ['writer'], memberSessions: { writer: 'member', former: 'retired' } }
const jobs = {
  current: [
    { id: 'real-job', owner: 'current', kind: 'bash', status: 'running', label: 'Make a backup', startedAt: 0 },
    { id: 'unowned', kind: 'bash', status: 'running', label: 'Shared', startedAt: 0 },
    { id: 'outside', owner: 'other', kind: 'bash', status: 'running', label: 'Wrong owner', startedAt: 0 },
    { id: 'done', owner: 'current', kind: 'bash', status: 'completed', label: 'Done', startedAt: 0 },
  ],
  branch: [{ id: 'other-task', owner: 'branch', kind: 'workflow', status: 'stopping', label: 'Export', startedAt: 0 }],
  member: [{ id: 'member-job', owner: 'member', kind: 'workflow', status: 'running', label: 'Storyboard', startedAt: 0 }],
}
const tasks = [
  { id: 'routine', botId: 'writer', sessionId: 'current', status: 'active', updatedAt: '2026-11-01T00:00:00.000Z', title: 'Report progress', scheduledAt: '2030-01-01T00:00:00.000Z' },
  { id: 'team-routine', roomId: 'room', sessionId: 'hub', status: 'paused', title: 'Standup' },
  { id: 'former-routine', botId: 'former', roomId: 'room', sessionId: 'retired', status: 'paused', title: 'Former standup' },
]
const scheduleView = { available: true, canSetActive: true, tasks }

test('a Bot sees its own live jobs, its other live conversation and that conversation’s terminal', () => {
  const sources = botBackgroundSources(bot, 'current')
  assert.deepEqual(plain(sources), [{ sessionId: 'current' }, { sessionId: 'branch', otherChat: true }])
  const view = backgroundView({
    sources, rows: jobs, turns: { current: 0, branch: 100 },
    terminals: { branch: [{ id: 'open', title: 'Encoder', state: 'running' }, { id: 'closed', state: 'exited' }] },
    now: 61_000,
  })
  assert.equal(view.count, 4)
  assert.deepEqual(plain(view.groups.map(group => group.items.map(row => [row.sessionId, row.label, row.stopping ?? false]))), [
    [['branch', 'Another conversation', false], ['branch', 'Export', true]], [['current', 'Make a backup', false]], [['branch', 'Encoder', false]],
  ])
})

test('the group watches only its own chat and its active members’ sessions in that group', () => {
  const sources = groupBackgroundSources(room, { writer: bot })
  assert.deepEqual(plain(sources.map(source => source.sessionId)), ['hub', 'member'])
  const view = backgroundView({ sources, rows: jobs, terminals: { hub: [{ id: 'open', state: 'running' }] }, now: 100 })
  assert.equal(view.count, 2)
  assert.equal(view.groups[0].items[0].bot.name, 'Writer')
  assert.equal(view.groups[1].items[0].sessionId, 'hub')
})

test('the details panel controls an exact job, an open conversation and scheduled delivery separately', async () => {
  publishSchedules(scheduleView)
  const calls = []
  const actions = {
    backgroundJobs: () => ({
      state: { getSnapshot: () => ({ rows: jobs }) },
      kill: (session, id) => calls.push(['stop', session, id]),
    }),
    stopOpenPart: (id, session) => calls.push(['stop-turn', id, session]),
    openSettings: (...args) => calls.push(args),
    scheduleSetActive: async (task, active) => {
      calls.push(['schedule', task.id, task.sessionId, task.updatedAt ?? null, active])
      return scheduleView
    },
  }
  const controls = buttons(BackgroundPanel({
    sources: botBackgroundSources(bot, 'current'), botId: bot.id, turns: { branch: Date.now() }, actions,
    useSessions: select => select({ byId: { branch: { displayTitle: 'Revising episode two' } } }),
  }))
  const byName = label => controls.find(button => button.props['aria-label'] === label)
  assert.equal(byName('Resume Standup'), undefined)
  assert.equal(byName('Stop Export'), undefined)
  assert.equal(byName('Stop Shared'), undefined)
  await byName('Stop Make a backup').props.onClick()
  await byName('Stop Revising episode two').props.onClick()
  await byName('Pause Report progress').props.onClick()
  byName('New task').props.onClick()

  const groupControls = buttons(BackgroundPanel({ sources: groupBackgroundSources(room, { writer: bot }), room, bots: { writer: bot }, actions }))
  assert.equal(groupControls.some(button => button.props['aria-label'] === 'Resume Former standup'), false)
  assert.equal(groupControls.some(button => button.props['aria-label'] === 'Pause Report progress'), false)
  await groupControls.find(button => button.props['aria-label'] === 'Resume Standup').props.onClick()
  assert.deepEqual(calls, [
    ['stop', 'current', 'real-job'],
    ['stop-turn', 'writer', 'branch'],
    ['schedule', 'routine', 'current', scheduleView.tasks[0].updatedAt, false],
    ['schedules', 'writer'],
    ['schedule', 'team-routine', 'hub', null, true],
  ])
})
