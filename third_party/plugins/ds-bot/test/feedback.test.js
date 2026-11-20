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
const ISSUES = 'https://github.com/Fei2411/DS-Bot/issues/new'

// Settings → Feedback in a window whose `open` is `open`, with every state change kept.
function page(window, globals = {}) {
  const notes = []
  const react = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useMemo: make => make(),
  useCallback: fn => fn,
  useId: () => 'dv-id',
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    Fragment: 'fragment',
    useState: initial => [initial, (next) => { if (typeof next === 'string') notes.push(next) }],
    useEffect: () => {},
    useRef: current => ({ current }),
    useLayoutEffect: () => {},
  }
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, window, URL, URLSearchParams, setTimeout, clearTimeout, ...globals,
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    require: (name) => {
      if (name === 'react') return react
      if (name === 'react-dom' || name === '@deepseek-ai/dsh-client-ui-primitives') return {}
      throw new Error(`no platform module ${name}`)
    },
  })
  const actions = { diagnostics: async () => ({ markdown: '| DS Bot | 0.1.6 |', issuesUrl: ISSUES, entries: [], total: 0 }) }
  let pending
  const run = (promise) => { pending = promise; return promise }
  const tree = module.exports.FeedbackPage({ actions, run, Section: 'section', Row: 'row' })
  const find = node => (Array.isArray(node) ? node.flatMap(find) : node && typeof node === 'object' ? [...(node.props?.className === 'bt-fb-primary' ? [node] : []), ...find(node.children)] : [])
  return {
    notes,
    tree,
    report: async () => {
      find(tree)[0].props.onClick()
      await pending
    },
  }
}

// Muse: problems go to the product's own suggestion box, whose address the account plugin
// publishes on the page; the page has no GitHub issue button.
const nodes = (node, pick) => (Array.isArray(node) ? node.flatMap(one => nodes(one, pick))
  : node && typeof node === 'object' ? [...(pick(node) ? [node] : []), ...nodes(node.children, pick)] : [])

test('the suggestion box opens the published feedback address, and nothing reports on GitHub', () => {
  const address = 'https://feedback.test/box'
  const { tree } = page({ open: () => null }, { __MUSE_FEEDBACK_CONFIG__: { feedbackUrl: address } })
  const [row] = nodes(tree, node => node.props?.label === 'Suggestion box')
  const [link] = nodes(row?.children ?? [], node => node.type === 'a')
  assert.equal(link.props.href, address)
  assert.equal(link.props.rel, 'noopener noreferrer')
  assert.equal(nodes(tree, node => node.type === 'button' && /GitHub/.test(String(node.children[0]))).length, 0)
})

test('without a published https or loopback address there is no suggestion box', () => {
  for (const globals of [{}, { __MUSE_FEEDBACK_CONFIG__: { feedbackUrl: 'http://feedback.test/box' } }, { __MUSE_FEEDBACK_CONFIG__: { feedbackUrl: 'javascript:alert(1)' } }]) {
    const { tree } = page({ open: () => null }, globals)
    assert.equal(nodes(tree, node => node.props?.label === 'Suggestion box').length, 0)
  }
  const { tree } = page({ open: () => null }, { __MUSE_FEEDBACK_CONFIG__: { feedbackUrl: 'http://127.0.0.1:8080/feedback' } })
  assert.equal(nodes(tree, node => node.props?.label === 'Suggestion box').length, 1)
})
