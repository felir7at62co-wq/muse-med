import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const bundle = await build({
  stdin: { contents: "export { botState, BotAvatar, BotMark } from './src/client/mark.js'\nexport { SHELL_CSS } from './src/client/styles.js'", resolveDir: dirname(dirname(fileURLToPath(import.meta.url))) },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
// A test can queue the values the next useState calls return, and read what was set.
const states = []
const sets = []
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: initial => [states.length > 0 ? states.shift() : initial, value => sets.push(value)], useEffect: () => {}, useRef: current => ({ current }), useLayoutEffect: () => {}, Fragment: 'fragment',
}
runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require: name => (name === 'react' ? react : {}) })
const { botState, BotAvatar, BotMark, SHELL_CSS } = module.exports

test('a Bot that waits for work it handed on has a mark of its own, behind a running turn and a question', () => {
  assert.equal(botState(false, 'waiting', false), 'waiting')
  // A turn of its own runs: the turn shows, not the wait.
  assert.equal(botState(true, 'waiting', false), 'working')
  assert.equal(botState(true, 'searching', false), 'searching')
  assert.equal(botState(false, 'waiting', true), 'alert')
  assert.equal(botState(false, undefined, false), 'idle')
  // It moves like a Bot coordinating its teammates.
  assert.match(SHELL_CSS, /\.bt-mark:is\(\[data-state=orbit\],\[data-state=waiting\]\) \.bt-b\{animation:bt-sway/)
})

test('a waiting Bot does not wear the working badge, since no turn of it runs', () => {
  const badges = state => BotAvatar({ bot: { id: 'b', name: 'Writer' }, size: 36, state }).children.slice(1).filter(Boolean).map(child => child.props.className)
  assert.deepEqual(badges('waiting'), [])
  assert.deepEqual(badges('working'), ['bt-badge bt-badge-working'])
})

test('a photo that does not load shows the Bot\'s character instead', () => {
  const photo = 'data:image/png;base64,iVBORw0KGgo='
  const bot = { id: 'b', name: 'Writer', avatar: { shape: 'fox', image: photo } }
  const img = BotMark({ bot }).children[0]
  assert.equal(img.type, 'img')
  sets.length = 0
  img.props.onError()
  assert.deepEqual(sets, [photo])
  // Rendered again with that photo marked broken: the character, not an empty image.
  states.push(false, photo)
  const mark = BotMark({ bot })
  assert.equal(mark.children[0].type, 'svg')
  assert.notEqual(mark.props['data-shape'], 'image')
  // A new photo is tried again.
  states.push(false, photo)
  assert.equal(BotMark({ bot: { ...bot, avatar: { ...bot.avatar, image: `${photo}AA` } } }).children[0].type, 'img')
})

test('Feishu identity appears with status while the Main Bot role remains accessible', () => {
  const badges = props => BotAvatar({ bot: { id: 'b', name: 'Writer' }, size: 36, ...props }).children.slice(1).filter(Boolean)
  const identityClass = 'bt-badge bt-badge-feishu'
  assert.deepEqual(badges({ feishu: true }).map(child => child.props.className), [identityClass])
  assert.deepEqual(badges({ feishu: true, main: true }).map(child => child.props.className), ['bt-badge bt-badge-main', `${identityClass} bt-badge-feishu-main`])
  assert.deepEqual(badges({ feishu: true, state: 'working' }).map(child => child.props.className), ['bt-badge bt-badge-working', identityClass])
  assert.deepEqual(badges({ feishu: true, state: 'alert' }).map(child => child.props.className), ['bt-badge bt-badge-alert', identityClass])
  assert.equal(badges({ feishu: true })[0].props['aria-label'], 'Feishu linked')
  assert.equal(badges({ main: true })[0].props['aria-label'], 'Main Bot')
  assert.deepEqual(badges({}), [])
  assert.match(SHELL_CSS, /\.bt-badge-feishu\{width:8px;height:8px;right:1px;bottom:13px;background:#fff/)
  assert.match(SHELL_CSS, /\.bt-badge-feishu-main\{bottom:calc\(clamp\(14px/)
  assert.match(SHELL_CSS, /\.bt-badge-working\{[^}]*width:8px;height:8px;right:1px;bottom:1px/)
})
