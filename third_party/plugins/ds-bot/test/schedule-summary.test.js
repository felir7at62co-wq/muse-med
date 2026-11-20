import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// Muse: the details page's scheduled-tasks line, bundled with a React stand-in whose state is
// the schedule view under test.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { outputFiles } = await build({
  stdin: { contents: "export { ScheduleSummary } from './src/client/schedules.js'", resolveDir: PLUGIN },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
let view = null
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }), Fragment: Symbol('Fragment'),
  useEffect() {}, useLayoutEffect() {}, useState: () => [view, () => {}], useMemo: make => make(), useRef: current => ({ current }), useId: () => 'id',
  createContext: value => ({ Provider: 'Provider', value }), useContext: context => context.value,
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: name => (name === 'react' ? react : {}),
  window: { innerWidth: 1280, addEventListener() {}, removeEventListener() {} },
  document: { addEventListener() {}, removeEventListener() {}, querySelector: () => null, documentElement: { setAttribute() {}, removeAttribute() {} } },
  setTimeout: () => 0, clearTimeout() {},
})
const { ScheduleSummary } = module.exports

const buttons = (node, out = []) => {
  if (Array.isArray(node)) { for (const child of node) buttons(child, out); return out }
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (node.type === 'button') out.push(node)
  return buttons(node.children, out)
}
const bot = { id: 'writer', name: 'Writer' }
const task = { id: 't1', botId: 'writer', status: 'active', title: 'Report progress', kind: 'daily', time: '09:00:00.000' }

test('with tasks listed, the plus beside the title starts a new task for this Bot', () => {
  view = { available: true, tasks: [task, { ...task, id: 't2', botId: 'other' }] }
  const opened = []
  const shown = ScheduleSummary({ bot, actions: { openSettings: (...args) => opened.push(args) } })
  const plus = buttons(shown).find(button => button.props['aria-label'] === 'New task')
  assert.ok(plus)
  plus.props.onClick()
  assert.equal(JSON.stringify(opened), JSON.stringify([['schedules', 'writer']]))
  // The Bot's own active task is the only row.
  assert.equal(buttons(shown).filter(button => button.props.className === 'bt-task-line').length, 1)
})

test('with no task, the empty line is the only way in', () => {
  view = { available: true, tasks: [] }
  const shown = ScheduleSummary({ bot, actions: { openSettings() {} } })
  assert.equal(buttons(shown).some(button => button.props['aria-label'] === 'New task'), false)
  assert.equal(buttons(shown).filter(button => button.props.className === 'bt-more').length, 1)
})
