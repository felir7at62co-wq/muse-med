// Muse: the spider is the approved artwork traced into flat layers (dev/spider.mjs). It
// takes the Bot's color like every character, shows the artwork's own purple for violet,
// keeps the artwork's eyes drawn on top, and wears the picker's ring along its outline.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { ARTWORK, fidelity, trace } from '../dev/spider.mjs'
import { CHARACTER_COLORS, MASK_ID, bodyOf, characterMarkup, maskOf, shapeOf } from '../src/client/characters.js'
import { SPIDER, SPIDER_SHAPE } from '../src/client/muse-spider.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
// The artwork lives in the Muse checkout around the plugin, not in the plugin itself.
const artwork = { skip: existsSync(ARTWORK) ? false : 'the Muse artwork is not beside this plugin' }
const layers = SPIDER.layers.map(([d, fill, opacity]) => `<path d="${d}" fill="${fill}" fill-opacity="${opacity}"/>`).join('')
const bodyIn = paint => `<g fill-rule="evenodd"><path d="${SPIDER.body}" fill="${paint}"/>${layers}`

// The picker runs as plain functions over a minimal React stand-in, as in sidebar-mains.test.js.
const { outputFiles } = await build({
  stdin: { contents: "export { CharacterGrid } from './src/client/bot-settings.js'", resolveDir: PLUGIN },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }), Fragment: Symbol('Fragment'),
  useEffect() {}, useLayoutEffect() {}, useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useMemo: make => make(), useCallback: fn => fn, useRef: current => ({ current }), useId: () => 'id',
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(), createContext: initial => ({ value: initial }), useContext: ctx => ctx.value,
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  window: { innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {} },
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
})
const { CharacterGrid } = module.exports
// A picker cell is a button holding the ring and the mark; `drawn` is each one's SVG markup.
const cells = (look) => {
  const [shapes] = CharacterGrid({ look, onShape() {}, onColor() {} }).props.children
  return shapes.props.children.flatMap(row => row.props.children).map((button) => {
    const [ring, mark] = button.props.children
    const svg = node => (node.type === 'svg' ? node : node.props.children.find(child => child?.type === 'svg'))
    const drawn = node => svg(node.type(node.props)).props.dangerouslySetInnerHTML.__html
    return { shape: mark.props.look.shape, pressed: button.props['aria-pressed'], ring: drawn(ring), mark: drawn(mark) }
  })
}

test('the committed layers are the trace of the artwork', artwork, () => {
  assert.deepEqual(trace(), SPIDER)
})

test('in the artwork\'s own purple the layers reproduce the artwork', artwork, () => {
  const { overlap, mean, p99 } = fidelity(SPIDER)
  // Measured: the outlines share 99.95% of their union; inside, the largest channel
  // difference is 1.7 of 255 on average and 6.2 at the 99th percentile.
  assert.ok(overlap >= 0.995, `outline overlap ${overlap}`)
  assert.ok(mean <= 2.5, `mean color difference ${mean}`)
  assert.ok(p99 <= 9, `99th percentile color difference ${p99}`)
})

test('the violet spider shows the artwork\'s own purple, in vector shapes alone', () => {
  const markup = characterMarkup('muse-spider', 'violet')
  assert.ok(markup.includes(bodyIn(SPIDER.base)))
  assert.doesNotMatch(markup, /<image|data:image/)
  assert.match(SPIDER.base, /^#[0-9a-f]{6}$/)
})

test('the mark moves against the box of the picture the drawing replaced', () => {
  assert.ok(characterMarkup('muse-spider', 'violet').includes('<rect x="-30.2083" y="-4.5833" width="160" height="106.6667" fill="none"/></g>'))
})

test('any other color fills the same drawing', () => {
  for (const color of CHARACTER_COLORS.filter(color => color !== 'violet' && color !== 'aurora')) {
    assert.ok(characterMarkup('muse-spider', color).includes(bodyIn(`var(--bt-ink-${color})`)), color)
  }
  assert.ok(characterMarkup('muse-spider', '#418fae').includes(bodyIn('#418fae')))
  const aurora = characterMarkup('muse-spider', 'aurora')
  assert.ok(aurora.includes(bodyIn(`url(#${MASK_ID}g)`)))
  assert.match(aurora, /<linearGradient id="%MASK%g"/)
  assert.doesNotMatch(aurora.replaceAll(MASK_ID, 'mark-7'), /%MASK%/)
})

test('the eyes are drawn on top, where the artwork has them', () => {
  assert.deepEqual(SPIDER_SHAPE.eyes, [[54.6, 47.4, 16.8, 17.7, -8], [74.3, 45.9, 15, 18.3, -8]])
  const markup = characterMarkup('muse-spider', 'cyan')
  assert.match(markup, /<g transform="translate\(54\.6 47\.4\) rotate\(-8\)"><g class="bt-eye"><ellipse rx="8\.4" ry="8\.85" fill="#21152f"\/>/)
  assert.match(markup, /<g transform="translate\(74\.3 45\.9\) rotate\(-8\)"><g class="bt-eye"><ellipse rx="7\.5" ry="9\.15" fill="#21152f"\/>/)
  assert.match(markup, /class="bt-eye-happy"/)
  // The body is whole under them: nothing is cut out of it.
  assert.doesNotMatch(markup, /<g mask="url\(#%MASK%\)">/)
})

test('masks and rings use the outline alone', () => {
  assert.equal(bodyOf(shapeOf('muse-spider'), '#000', true), `<g fill-rule="evenodd"><path d="${SPIDER.body}" fill="#000"/></g>`)
  assert.doesNotMatch(decodeURIComponent(maskOf('muse-spider')), /<image|fill-opacity/)
})

test('the tracing shared with the spider still gives the other characters their committed table', () => {
  const printed = execFileSync(process.execPath, ['dev/characters.mjs'], { cwd: PLUGIN, encoding: 'utf8', maxBuffer: 1 << 26 }).trim()
  const source = readFileSync(join(PLUGIN, 'src/client/characters.js'), 'utf8')
  const start = source.indexOf('export const CHARACTERS = {')
  assert.equal(printed, source.slice(start, source.indexOf('\n}\n', start) + 2))
})

test('the picker cell of a teal Bot shows a teal spider', () => {
  const all = cells({ shape: 'gumdrop', color: 'cyan' })
  const spider = all.find(cell => cell.shape === 'muse-spider')
  assert.equal(all.at(-1), spider)
  assert.equal(spider.pressed, false)
  assert.ok(spider.mark.includes(`<path d="${SPIDER.body}" fill="var(--bt-ink-cyan)"/>`))
  assert.ok(all.find(cell => cell.shape === 'acorn').mark.includes('fill="var(--bt-ink-cyan)"'))
})

test('a selected spider cell wears a ring along the spider\'s outline', () => {
  const spider = cells({ shape: 'muse-spider', color: 'cyan' }).find(cell => cell.shape === 'muse-spider')
  assert.equal(spider.pressed, true)
  // The ring is the outline stroked in the text color, with the body and a gap masked out.
  assert.match(spider.ring, /<g mask="url\(#bt-ring-\d+\)" stroke="currentColor" stroke-width="[\d.]+" stroke-linejoin="round">/)
  assert.ok(spider.ring.includes(`<path d="${SPIDER.body}" fill="currentColor"/>`))
  assert.ok(spider.ring.includes(`<path d="${SPIDER.body}" fill="#000"/>`))
  assert.doesNotMatch(spider.ring, /<image/)
})
