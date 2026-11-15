import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { MAIN_LOOK, SHAPES, PICKER_SHAPES, DEFAULT_SHAPES, characterMarkup, lookOf, maskOf } from '../src/client/characters.js'
import { SPIDER_SHAPE } from '../src/client/muse-spider.js'
import { installLocale, t, hostText } from '../src/client/i18n.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const { outputFiles } = await build({
  stdin: { contents: "export { BrandName, BrandMark, BotReturn, TeamSidebar } from './src/client/sidebar.js'; export { AboutPage } from './src/client/about.js'; export { ModelChoiceDock, DeepSeekSignIn } from './src/client/model-menu.js'; export { FeedbackPage, openMuseFeedback } from './src/client/feedback.js'; export { CharacterGrid } from './src/client/bot-settings.js'; export { installLocale } from './src/client/i18n.js'", resolveDir: root },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(child => child !== null && child !== undefined) }),
  Fragment: 'fragment', useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {}, useLayoutEffect: () => {}, useMemo: read => read(), useRef: current => ({ current }),
  useSyncExternalStore: (_subscribe, read) => read(),
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, URL, URLSearchParams, setTimeout, clearTimeout,
  window: { innerWidth: 1400, innerHeight: 900 }, document: { documentElement: { clientHeight: 900 } },
  require: name => name === 'react' ? react : {},
})
const ui = module.exports
const find = (node, pick) => Array.isArray(node) ? Array.from(node).flatMap(child => find(child, pick))
  : node && typeof node === 'object' ? [...(pick(node) ? [node] : []), ...find(node.children ?? [], pick)] : []
const textOf = node => Array.isArray(node) ? node.map(textOf).join(' ') : typeof node === 'string' ? node
  : node && typeof node === 'object' ? [node.props?.label, node.props?.hint, textOf(node.children)].filter(Boolean).join(' ') : ''

function chineseLocale() {
  let dictionary
  return { register: (_ns, _lang, values) => { dictionary = values; return () => {} },
    bind: () => key => dictionary?.[key] ?? key, getLocale: () => ({ active: 'zh' }) }
}

test('the Muse spider is the shared selectable mark with animated eyes', () => {
  assert.deepEqual(MAIN_LOOK, { shape: 'muse-spider', color: 'violet' })
  assert.equal(SHAPES[MAIN_LOOK.shape], SPIDER_SHAPE)
  assert.ok(!PICKER_SHAPES.includes('muse-spider'), 'custom shapes use the custom picker enumeration')
  assert.ok(!DEFAULT_SHAPES.includes('muse-spider'))
  assert.equal(lookOf({ avatar: { shape: 'whale' } }).shape, 'whale', 'stored user avatar choices remain readable')
  assert.equal(lookOf({ avatar: { shape: 'muse-spider' } }).shape, 'muse-spider')
  const svg = characterMarkup('muse-spider', 'violet')
  assert.match(svg, /bt-eye/)
  assert.match(svg, /fill="#21152f"/)
  assert.match(svg, /bt-eye-happy/)
  assert.doesNotMatch(characterMarkup('whale', 'violet'), /fill="#21152f"/)
  assert.match(svg, /stroke-linecap="round"/)
  assert.match(svg, /<image href="data:image\/png;base64,/)
  assert.doesNotMatch(maskOf('muse-spider'), /base64/)
  assert.equal(SPIDER_SHAPE.eyes.length, 2)
})

test('English and Chinese product copy use Muse Bot without rewriting user or provider names', () => {
  assert.equal(t('DS Bot settings'), 'Muse Bot settings')
  assert.equal(hostText('DS Bot is still loading this chat.'), 'Muse Bot is still loading this chat.')
  assert.equal(t('Message {name}', { name: 'DS Bot test user' }), 'Message DS Bot test user')
  assert.equal(t('DeepSeek'), 'DeepSeek')
  const off = installLocale(chineseLocale())
  try {
    assert.equal(t('About DS Bot'), '关于 Muse Bot')
    assert.equal(t('Muse Bot'), 'Muse Bot')
    assert.equal(t('Muse Spider'), 'Muse 小蜘蛛')
    assert.equal(t('No models are set up in DeepSeek Harness yet.'), 'Muse 里还没有设置模型。')
  } finally { off() }
})

test('brand and classic-mode return entrance use the same spider and product name', () => {
  assert.equal(textOf(ui.BrandName()), 'Muse Bot')
  assert.ok(ui.BrandName().props.style.fontWeight <= 500)
  assert.equal(ui.BrandMark({}).children[0].props.look.shape, 'muse-spider')
  const tree = ui.BotReturn({ wide: true, useSurface: read => read({ mode: 'agent' }), actions: { setSurface: () => {} } })
  assert.equal(tree.props['aria-label'], 'Muse Bot')
  assert.equal(tree.children[0].props.look.shape, 'muse-spider')
  assert.match(textOf(tree), /Muse Bot/)
})

test('about does not offer the upstream updater or GitHub issue flow even with upstream update metadata', () => {
  const calls = []
  const update = { source: 'registry', current: '0.2.2', latest: '9.9.9', available: true,
    repoUrl: 'https://github.com/Fei2411/DeepSeek-Bot', notesUrl: 'https://github.com/Fei2411/DeepSeek-Bot/releases',
    dsh: { current: '1', available: true, verified: '2' } }
  const actions = new Proxy({}, { get: (_target, name) => () => calls.push(name) })
  const tree = ui.AboutPage({ useUpdate: read => read(update), actions, run: read => read, Section: 'section', Row: 'row' })
  assert.equal(find(tree, node => node.props?.className === 'bt-about-name')[0].children[0], 'Muse Bot')
  assert.equal(find(tree, node => node.props?.className === 'bt-about-version').length, 0, 'plugin version is not the Muse application version')
  assert.deepEqual(find(tree, node => node.type === 'button').map(node => textOf(node)), ['Open'])
  assert.equal(find(tree, node => node.props?.href).length, 0)
  assert.equal(find(tree, node => node.type === 'details').length, 0)
  assert.equal(find(tree, node => node.props?.title === 'Open-source licenses').length, 0)
  assert.doesNotMatch(textOf(tree), /DS Bot|Fei2411|Apache-2.0|Muse repository|Muse license/)
  assert.deepEqual(calls, [])
})

test('the Chinese About page omits the license section while the package retains upstream notices', () => {
  const off = ui.installLocale(chineseLocale())
  try {
    const tree = ui.AboutPage({ useUpdate: read => read({}), actions: {}, run: read => read, Section: 'section', Row: 'row' })
    assert.equal(find(tree, node => node.props?.href).length, 0)
    assert.equal(find(tree, node => node.type === 'details').length, 0)
    assert.doesNotMatch(textOf(tree), /开源软件许可|Muse 仓库|Muse 许可证|上游许可说明|DS Bot|Fei2411|Apache-2.0/)
  } finally { off() }
  assert.match(readFileSync(new URL('../LICENSE', import.meta.url), 'utf8'), /Apache License/)
  assert.match(readFileSync(new URL('../NOTICE', import.meta.url), 'utf8'), /Copyright 2026 Fei2411 and the DS Bot contributors/)
})

test('Muse app update status remains actionable through its own app actions', () => {
  const calls = []
  const tree = ui.AboutPage({ useUpdate: read => read({ source: 'app', productVersion: '1.2.0', ownApp: { phase: 'downloaded', version: '1.2.1' } }),
    actions: { installOwnApp: () => calls.push('muse-update'), openSettings: () => {} }, run: read => read, Section: 'section', Row: 'row' })
  assert.equal(find(tree, node => node.props?.className === 'bt-about-version')[0].children[0], 'Version 1.2.0')
  find(tree, node => node.type === 'button' && textOf(node) === 'Restart to update')[0].props.onClick()
  assert.deepEqual(calls, ['muse-update'])
})

test('model onboarding offers Muse model settings without DeepSeek sign-in or key onboarding', () => {
  let opened = 0
  const bot = { id: 'main', sessionId: 'main', name: 'Muse Bot' }
  const tree = ui.ModelChoiceDock({ sessionId: 'main', useRoster: read => read({ ready: true, byId: { main: bot }, models: [] }),
    actions: { openHarnessSettings: () => opened++, canSignIn: () => true,
      signIn: () => { throw new Error('unexpected DeepSeek sign-in') }, openHarnessOnboarding: () => { throw new Error('unexpected key onboarding') } } })
  const buttons = find(tree, node => node.type === 'button')
  assert.deepEqual(buttons.map(node => textOf(node)), ['Manage models'])
  buttons[0].props.onClick()
  assert.equal(opened, 1)
  assert.equal(ui.DeepSeekSignIn(), null)
})

test('diagnostics remain local and no longer offer upstream GitHub submission', () => {
  const tree = ui.FeedbackPage({ actions: {}, run: read => read, Section: 'section', Row: 'row' })
  assert.doesNotMatch(textOf(tree), /GitHub|issue|DS Bot/)
  assert.equal(find(tree, node => node.props?.href).length, 0)
  assert.match(textOf(tree), /Muse administrator/)
})

test('feedback opens the native draft for the visible conversation without submitting or opening a web page', () => {
  const events = []
  const ctx = { sessions: { list: { getSnapshot: () => ({ byId: {
    old: { id: 'old', retainedBy: { mainView: 0 } },
    current: { id: 'current', retainedBy: { mainView: 1 } },
  } }) } }, get: name => name === 'feedbackUi' ? { openSession: id => events.push(['draft', id]) } : undefined }
  ui.openMuseFeedback(ctx, () => events.push(['close-settings']))
  assert.deepEqual(events, [['close-settings'], ['draft', 'current']])
  events.length = 0
  assert.throws(() => ui.openMuseFeedback({ ...ctx, get: () => undefined }, () => events.push('closed')), /Feedback is unavailable/)
  assert.deepEqual(events, [])
  assert.throws(() => ui.openMuseFeedback({ ...ctx, sessions: { list: { getSnapshot: () => ({ byId: {} }) } } }, () => events.push('closed')), /Open a conversation/)
  assert.deepEqual(events, [])
})

test('Bot settings stay available in both sidebar widths without taking the Muse account seat', () => {
  for (const wide of [true, false]) {
    const calls = []
    const roster = { bots: [], byId: {}, rooms: [], agents: [], ready: true }
    const props = { wide, useRoster: read => read(roster), useUi: read => read({ unread: {} }),
      useRegistry: read => read({}), useSessions: read => read({ ids: [], byId: {} }),
      actions: { openSettings: page => calls.push(page) } }
    const tree = ui.TeamSidebar(props)
    const settings = find(tree, node => node.props?.['aria-label'] === 'Bot settings')
    assert.equal(settings.length, 1)
    settings[0].props.onClick()
    assert.deepEqual(calls, ['general'])
  }
  const styles = readFileSync(new URL('../src/client/styles.js', import.meta.url), 'utf8')
  assert.match(styles, /\.bt-brand-spider\{/)
})


test('the default Muse spider appears once in the real character picker with one selected cell', () => {
  const picked = []
  const tree = ui.CharacterGrid({ look: { shape: 'muse-spider', color: 'violet' }, onShape: value => picked.push(value), onColor: () => {} })
  const cells = find(tree, node => node.type === 'button' && node.props?.className === 'bt-shape')
  const spider = cells.filter(node => node.props['aria-label'] === 'Muse Spider')
  assert.equal(spider.length, 1)
  assert.equal(cells.filter(node => node.props['aria-pressed']).length, 1)
  spider[0].props.onClick()
  assert.deepEqual(picked, ['muse-spider'])
})
