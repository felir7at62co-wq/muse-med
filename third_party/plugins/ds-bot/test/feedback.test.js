import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/feedback.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
// Settings → Feedback delegates to the existing Muse draft for the visible conversation.
function page(window, { visible = true, available = true } = {}) {
  const notes = []
  const events = []
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    Fragment: 'fragment',
    useState: initial => [initial, (next) => { if (typeof next === 'string') notes.push(next) }],
    useEffect: () => {},
    useRef: current => ({ current }),
    useLayoutEffect: () => {},
  }
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, window, URL, URLSearchParams, setTimeout, clearTimeout,
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    require: (name) => {
      if (name === 'react') return react
      if (name === 'react-dom' || name === '@deepseek-ai/dsh-client-ui-primitives') return {}
      throw new Error(`no platform module ${name}`)
    },
  })
  const ctx = {
    sessions: { list: { getSnapshot: () => ({ byId: {
      background: { id: 'background', retainedBy: { mainView: 0 } },
      current: { id: 'current', retainedBy: { mainView: visible ? 1 : 0 } },
    } }) } },
    get: name => name === 'feedbackUi' && available
      ? { openSession: id => events.push(['draft', id]) }
      : undefined,
  }
  const actions = {
    diagnostics: async () => ({ markdown: '| Muse Bot | 0.2.2 |', entries: [], total: 0 }),
    openFeedback: () => module.exports.openMuseFeedback(ctx, () => events.push(['close-settings'])),
  }
  let pending
  const run = (promise) => { pending = promise; return promise }
  const tree = module.exports.FeedbackPage({ actions, run, Section: 'section', Row: 'row' })
  const find = node => (Array.isArray(node) ? node.flatMap(find) : node && typeof node === 'object'
    ? [...(node.type === 'button' && node.children.includes('Open feedback form') ? [node] : []), ...find(node.children)] : [])
  return {
    notes,
    events,
    report: async () => {
      const buttons = find(tree)
      assert.equal(buttons.length, 1)
      buttons[0].props.onClick()
      await pending
    },
  }
}

test('on the Desktop, one feedback click opens one native draft for the visible conversation', async () => {
  const opened = []
  const window = { dshDesktop: { protocolVersion: 1 }, open: (url = '') => { opened.push(String(url)); return null } }
  const { notes, events, report } = page(window)
  await report()
  assert.deepEqual(events, [['close-settings'], ['draft', 'current']])
  assert.deepEqual(opened, [])
  assert.deepEqual(notes, [])
})

test('in a browser, feedback uses the same Muse draft without reserving or navigating a window', async () => {
  const reserved = { location: { href: '' } }
  let opened = 0
  const window = { open: () => { opened += 1; return reserved } }
  const { events, report } = page(window)
  await report()
  assert.deepEqual(events, [['close-settings'], ['draft', 'current']])
  assert.equal(opened, 0)
  assert.equal(reserved.location.href, '')
  assert.equal(reserved.opener, undefined)
})

test('an unavailable draft service or missing visible conversation reports failure without a fallback submission', async () => {
  for (const [options, message] of [
    [{ available: false }, /Feedback is unavailable/],
    [{ visible: false }, /Open a conversation/],
  ]) {
    let opened = 0
    const { events, notes, report } = page({ open: () => { opened += 1; return null } }, options)
    await assert.rejects(report(), message)
    assert.deepEqual(events, [])
    assert.deepEqual(notes, [])
    assert.equal(opened, 0)
  }
})
