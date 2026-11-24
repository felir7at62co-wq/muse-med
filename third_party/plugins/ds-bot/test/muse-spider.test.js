// Muse: the spider is the approved artwork traced into flat layers (dev/spider.mjs). It
// takes the Bot's color like every character, shows the artwork's own purple for violet,
// keeps the artwork's eyes drawn on top, and wears the picker's ring along its outline.
// The same drawing comes apart into the torso and six legs for a mark whose legs move
// (spider-motion.js); at rest the parts are the same picture.
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
import { SPIDER_MOTION_CSS } from '../src/client/spider-motion.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
// The artwork lives in the Muse checkout around the plugin, not in the plugin itself.
const artwork = { skip: existsSync(ARTWORK) ? false : 'the Muse artwork is not beside this plugin' }
const overlays = paths => paths.map((d, index) => (d ? `<path d="${d}" fill="${SPIDER.steps[index][0]}" fill-opacity="${SPIDER.steps[index][1]}"/>` : '')).join('')
const layers = overlays(SPIDER.layers)
const BOX = '<rect x="-30.2083" y="-4.5833" width="160" height="106.6667" fill="none"/>'
const bodyIn = paint => `<g fill-rule="evenodd"><path d="${SPIDER.body}" fill="${paint}"/>${layers}`

// The picker runs as plain functions over a minimal React stand-in, as in sidebar-mains.test.js.
const { outputFiles } = await build({
  stdin: { contents: "export { CharacterGrid } from './src/client/bot-settings.js'\nexport { BotAvatar, BotMark } from './src/client/mark.js'", resolveDir: PLUGIN },
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
const { CharacterGrid, BotAvatar, BotMark } = module.exports
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

test('the committed drawing, whole and in parts, is the trace of the artwork', artwork, () => {
  assert.deepEqual(trace(), SPIDER)
})

// Measured for both: the outlines share 99.94% to 99.95% of their union; inside, the largest
// channel difference is 1.7 of 255 on average and 6.2 to 7.0 at the 99th percentile.
const withinTheBar = ({ overlap, mean, p99 }) => {
  assert.ok(overlap >= 0.995, `outline overlap ${overlap}`)
  assert.ok(mean <= 2.5, `mean color difference ${mean}`)
  assert.ok(p99 <= 9, `99th percentile color difference ${p99}`)
}

test('in the artwork\'s own purple the whole drawing reproduces the artwork', artwork, () => {
  withinTheBar(fidelity({ ...SPIDER, parts: [{ body: SPIDER.body, layers: SPIDER.layers }] }))
})

test('at rest the parts reproduce the artwork too', artwork, () => {
  withinTheBar(fidelity(SPIDER))
})

test('the parts are three far legs, the torso and three near legs, each leg with a pivot inside the box', () => {
  assert.deepEqual(SPIDER.parts.map(part => part.id), ['far-upper', 'far-lower', 'far-right', 'torso', 'near-left', 'near-right', 'near-middle'])
  for (const part of SPIDER.parts) {
    assert.match(part.body, /^M[\d.]+ [\d.]+l/, part.id)
    assert.equal(part.layers.length, SPIDER.steps.length, part.id)
    if (part.id === 'torso') { assert.equal(part.pivot, undefined); continue }
    assert.equal(Boolean(part.near), part.id.startsWith('near-'), part.id)
    assert.ok(part.pivot.every(v => v > 0 && v < 100), `${part.id} pivot ${part.pivot}`)
  }
})

test('the violet spider shows the artwork\'s own purple, in vector shapes alone', () => {
  const markup = characterMarkup('muse-spider', 'violet')
  assert.ok(markup.includes(bodyIn(SPIDER.base)))
  assert.doesNotMatch(markup, /<image|data:image/)
  assert.match(SPIDER.base, /^#[0-9a-f]{6}$/)
})

test('the mark moves against the box of the picture the drawing replaced', () => {
  assert.ok(characterMarkup('muse-spider', 'violet').includes(`${BOX}</g>`))
  assert.ok(characterMarkup('muse-spider', 'violet', true).includes(`<g fill-rule="evenodd">${BOX}<g class="bt-torso">`))
})

const drawnPart = (part, paint) => `<path d="${part.body}" fill="${paint}"/>${overlays(part.layers)}`
const legOf = (part, paint) => `<g class="bt-leg" data-leg="${part.id}" style="transform-origin:${part.pivot[0]}px ${part.pivot[1]}px">${drawnPart(part, paint)}</g>`

test('a rigged mark draws the parts: the far legs and the eyes inside the torso, the near legs in front', () => {
  const far = SPIDER.parts.filter(part => part.pivot && !part.near)
  const near = SPIDER.parts.filter(part => part.near)
  const torso = SPIDER.parts.find(part => part.id === 'torso')
  for (const [color, paint] of [['violet', SPIDER.base], ['cyan', 'var(--bt-ink-cyan)'], ['#418fae', '#418fae'], ['aurora', `url(#${MASK_ID}g)`]]) {
    const markup = characterMarkup('muse-spider', color, true)
    const start = markup.indexOf('<g class="bt-torso">')
    const eyes = markup.indexOf('<g class="bt-gaze"><g class="bt-eyes"><g transform="translate(54.6 47.4) rotate(-8)">')
    assert.ok(markup.includes(`<g class="bt-torso">${far.map(part => legOf(part, paint)).join('')}${drawnPart(torso, paint)}<g class="bt-gaze">`), color)
    assert.ok(markup.endsWith(`</g></g></g>${near.map(part => legOf(part, paint)).join('')}</g></g>`), color)
    assert.ok(start > 0 && eyes > start, color)
    assert.doesNotMatch(markup, /<image/)
  }
  // A shape without a rig draws as it always does.
  assert.equal(characterMarkup('acorn', 'cyan', true), characterMarkup('acorn', 'cyan'))
})

test('a still or small mark keeps the whole drawing: no parts, nothing for the leg motion to hold', () => {
  for (const color of ['violet', 'cyan']) assert.doesNotMatch(characterMarkup('muse-spider', color), /bt-leg|bt-torso/)
  const span = BotMark({ look: { shape: 'muse-spider', color: 'violet' }, size: 36 })
  assert.equal(span.props['data-rig'], undefined)
  assert.doesNotMatch(span.props.children[0].props.dangerouslySetInnerHTML.__html, /bt-leg|bt-torso/)
  for (const cell of cells({ shape: 'muse-spider', color: 'cyan' })) assert.doesNotMatch(cell.mark, /bt-leg|bt-torso/, cell.shape)
})

test('the details avatar and a Main Bot tile ask for the rig; only the spider has one, and a picture never does', () => {
  const rigged = BotMark({ bot: { id: 'm' }, look: { shape: 'muse-spider', color: 'violet' }, size: 64, state: 'working', live: true, rig: true })
  assert.equal(rigged.props['data-rig'], '')
  assert.equal(rigged.props['data-state'], 'working')
  assert.match(rigged.props.children[0].props.dangerouslySetInnerHTML.__html, /class="bt-torso"/)
  assert.equal(BotMark({ look: { shape: 'acorn', color: 'violet' }, rig: true }).props['data-rig'], undefined)
  assert.equal(BotMark({ look: { shape: 'muse-spider', color: 'violet', image: 'data:image/png;base64,AA==' }, rig: true }).props['data-rig'], undefined)
  const tile = BotAvatar({ bot: { id: 'm', name: 'Muse', color: 'violet', avatar: { shape: 'muse-spider' } }, size: 60, main: true, rig: true })
  assert.equal(tile.props.children.find(child => child?.type === BotMark).props.rig, true)
  for (const [file, call] of [['details-avatar.js', /h\(BotMark, \{ bot, look, size: 64, state, [^}]*rig: true \}\)/], ['sidebar.js', /h\(BotAvatar, \{ bot, size: 60, [^}]*rig: true \}\)/]]) {
    assert.match(readFileSync(join(PLUGIN, 'src/client', file), 'utf8'), call, file)
  }
})

// The motion sheet as rules [selector, declarations] and keyframes { name: body }.
const sheet = SPIDER_MOTION_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
const keyframes = Object.fromEntries([...sheet.matchAll(/@keyframes ([\w-]+)\{((?:[^{}]*\{[^{}]*\})*)\}/g)].map(match => [match[1], match[2]]))
const rules = [...sheet.replace(/@keyframes [\w-]+\{(?:[^{}]*\{[^{}]*\})*\}/g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => [match[1].trim(), match[2]])
const moving = rules.filter(([, body]) => /animation:(?!none)/.test(body))

test('every state has its motion, on a rigged mark only', () => {
  for (const state of ['idle', 'thinking', 'working', 'searching', 'sending', 'orbit', 'alert', 'waiting', 'done']) {
    const own = moving.filter(([selector]) => selector.includes(`[data-state=${state}]`))
    assert.ok(own.some(([selector]) => /\.bt-leg/.test(selector)), `${state} moves a leg`)
  }
  for (const [selector] of rules) assert.match(selector, /\.bt-mark(-poke)?\[data-rig\]/, selector)
  // Whatever a rule plays is defined here or in the base sheet (the blink).
  for (const [selector, body] of moving) for (const name of body.match(/bt-[\w-]+(?= [\d.]+s)/g)) assert.ok(name in keyframes || name === 'bt-blink-idle', `${selector}: ${name}`)
})

test('every loop starts and ends on the drawing at rest', () => {
  for (const [name, body] of Object.entries(keyframes)) {
    const frames = Object.fromEntries([...body.matchAll(/([\d.%,]+)\{([^{}]*)\}/g)].flatMap(match => match[1].split(',').map(stop => [stop, match[2]])))
    // The eyes of a Bot waiting for an answer stay on the viewer until its state changes.
    if (name === 'bt-sp-attend-eyes') continue
    const rest = /opacity/.test(frames['0%']) ? frames['0%'] : 'transform:none'
    assert.equal(frames['0%'], rest, name)
    assert.equal(frames['100%'], rest, name)
  }
  assert.equal(keyframes['bt-sp-finish-open'].match(/0%[^{]*\{([^}]*)\}/)[1], 'opacity:1')
  assert.equal(keyframes['bt-sp-finish-smile'].match(/0%[^{]*\{([^}]*)\}/)[1], 'opacity:0')
})

test('Quiet leaves the spider still at rest; reduced motion only blinks; off stops everything', () => {
  for (const [selector] of moving.filter(([selector]) => selector.includes('[data-state=idle]') && !selector.includes(':hover'))) assert.ok(selector.startsWith('body:not([data-bt-motion=quiet]) '), selector)
  for (const [selector] of moving.filter(([selector]) => selector.includes(':hover') || selector.includes('.bt-mark-poke'))) assert.ok(selector.startsWith('body:not([data-bt-motion=quiet]) '), selector)
  const find = selector => rules.find(([own]) => own === selector)?.[1]
  assert.equal(find('body[data-bt-effects=reduced] .bt-mark[data-rig] :is(.bt-b,.bt-torso,.bt-leg,.bt-eyes,.bt-eye-happy)'), 'animation:none!important')
  assert.match(find('body[data-bt-effects=reduced] .bt-mark[data-rig][data-live] .bt-eye'), /^animation:bt-blink-idle [^;]*!important$/)
  assert.equal(find('body[data-bt-effects=off] .bt-mark[data-rig] *'), 'animation:none!important;transition:none!important')
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
