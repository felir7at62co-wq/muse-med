// Muse: the animated avatars (src/client/animated-avatar.js), off until their switch is turned
// on: the seven default characters as open-bot-avatar definitions, what the wrapper hands the
// package, and where the drawn mark stays: everywhere while the switch is off, and on the Muse
// spider, a picture and the other characters when it is on.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { DONE_TURN_S, avatarFrame, validateAvatar } from 'open-bot-avatar'
import { buildDefinitions, moduleText } from '../dev/avatar-definitions.mjs'
import { AVATAR_DEFINITIONS } from '../src/client/avatar-definitions.js'
import { CHARACTERS, DEFAULT_SHAPES, MASK_ID, SHAPES, characterMarkup } from '../src/client/characters.js'
import { INKS } from '../src/client/inks.js'
import { copyOf, uniqueIds } from '../src/client/mark-flight.js'
import { SPIDER } from '../src/client/muse-spider.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
// jsdom comes from the harness that test/harness-resolve.mjs found, like the dsh packages.
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness'), 'package.json'))('jsdom')

// The client modules are bundled once, before any test is declared, as the other client tests do.
const { outputFiles } = await build({
  stdin: {
    contents: [
      "export * from './src/client/animated-avatar.js'",
      "export { inkHex } from './src/client/inks.js'",
      "export { BotAvatar, BotMark } from './src/client/mark.js'",
      "export { DetailsAvatar } from './src/client/details-avatar.js'",
      "export { SettingsDialog } from './src/client/settings.js'",
      "export { SHELL_CSS } from './src/client/styles.js'",
    ].join('\n'),
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives', 'open-bot-avatar/dom'],
})

// ---------------------------------------------------------------------------
// The definitions.

test('the seven default characters each have a definition the package accepts, and the spider has none', () => {
  assert.deepEqual(Object.keys(AVATAR_DEFINITIONS), DEFAULT_SHAPES)
  assert.equal(DEFAULT_SHAPES.length, 7)
  assert.equal(Object.hasOwn(AVATAR_DEFINITIONS, 'muse-spider'), false)
  for (const [id, definition] of Object.entries(AVATAR_DEFINITIONS)) {
    const result = validateAvatar(definition)
    assert.deepEqual(result.ok ? [] : result.errors, [], id)
    // The package returns the path as it reads it: nothing in it was rewritten.
    assert.deepEqual(result.value, definition, id)
    assert.equal(definition.id, id)
    assert.equal(definition.name, SHAPES[id].label)
  }
})

test('the definitions are what dev/avatar-definitions.mjs builds from the characters', () => {
  const built = buildDefinitions()
  assert.deepEqual(AVATAR_DEFINITIONS, built)
  assert.equal(readFileSync(join(PLUGIN, 'src/client/avatar-definitions.js'), 'utf8'), moduleText(built))
})

test('a definition keeps its character\'s outline, and eyes as tall and as far apart, near where they were', () => {
  for (const [id, definition] of Object.entries(AVATAR_DEFINITIONS)) {
    const { body, eyes: [left, right] } = CHARACTERS[id]
    // One corner for each step of the character's body, inside the box the package asks for.
    const numbers = definition.body.path.match(/-?\d+(?:\.\d+)?/g).map(Number)
    assert.equal(numbers.length / 2, body.match(/-?\d*\.?\d+/g).length / 2, id)
    assert.equal(Math.min(...numbers) >= 8 && Math.max(...numbers) <= 92, true, id)
    // Every body reaches 4..96 of its box, give or take a tenth, so it was scaled by 42/46.
    const scaled = value => 50 + (value - 50) * 42 / 46
    const apart = Math.hypot(right[0] - left[0], right[1] - left[1]) * 42 / 46
    assert.equal(Math.abs(definition.eyes.spacing - apart) < 0.15, true, `${id} spacing`)
    const moved = Math.hypot(definition.eyes.x - scaled((left[0] + right[0]) / 2), definition.eyes.y - scaled((left[1] + right[1]) / 2))
    assert.equal(moved < 7, true, `${id} moved ${moved.toFixed(1)}`)
    // Both eyes are drawn at rest, as tall as the character's capsules.
    const drawn = avatarFrame(definition, { reducedMotion: true }).shapes.filter(shape => shape.kind === 'eye')
    assert.equal(drawn.length, 2, id)
    const tall = (left[3] + right[3]) / 2 * 42 / 46
    for (const { mark } of drawn) assert.equal(Math.abs(mark.height / tall - 1) < 0.03, true, `${id} eye ${mark.height.toFixed(1)} of ${tall.toFixed(1)}`)
  }
  // The two characters drawn facing the viewer keep their eyes exactly where they were.
  for (const id of ['star', 'moon']) {
    const [left, right] = CHARACTERS[id].eyes
    const scaled = value => Math.round((50 + (value - 50) * 42 / 46) * 10) / 10
    assert.deepEqual([AVATAR_DEFINITIONS[id].eyes.x, AVATAR_DEFINITIONS[id].eyes.y], [scaled((left[0] + right[0]) / 2), scaled((left[1] + right[1]) / 2)])
  }
})

// ---------------------------------------------------------------------------
// The bundle runs over a small stand-in for React that keeps hook state between renders and
// runs effects when asked, and over a fake mountAvatar.

function load() {
  const mounts = []
  const observers = []
  // The delay of every timer a component starts.
  const timers = []
  const body = {
    attributes: new Set(), dataset: {},
    hasAttribute: name => body.attributes.has(name),
  }
  const surfaces = { '--bt-sidebar': '#f7f7f7', '--bt-main': '#fcfcfc' }
  // One component instance: its hook slots, in call order.
  let slots = []
  let cursor = 0
  let queued = []
  const slot = (make) => {
    if (cursor === slots.length) slots.push(make())
    return slots[cursor++]
  }
  class FakeComponent { constructor(props) { this.props = props } }
  const react = {
    Component: FakeComponent, Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
    createContext: initial => ({ value: initial }), useContext: context => context.value,
    useCallback: fn => fn, useMemo: make => make(), useId: () => 'id', useLayoutEffect() {},
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
    useRef: initial => slot(() => ({ current: initial })),
    useState: (initial) => {
      const state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
      return [state.value, (next) => { state.value = next }]
    },
    useEffect: (run, deps) => {
      const effect = slot(() => ({}))
      if (effect.deps === undefined || deps === undefined || deps.some((dep, index) => dep !== effect.deps[index])) queued.push([effect, run])
      effect.deps = deps
    },
  }
  const icons = new Proxy({}, { get: () => () => ({ type: 'svg', props: { children: [] } }) })
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports,
    document: { body, documentElement: { dataset: {}, addEventListener() {}, removeEventListener() {} }, addEventListener() {}, removeEventListener() {} },
    window: { matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} },
    getComputedStyle: () => ({ getPropertyValue: name => ` ${surfaces[name] ?? ''}` }),
    MutationObserver: class {
      constructor(run) { this.run = run; this.connected = false; observers.push(this) }
      observe(target, options) { this.connected = true; this.target = target; this.options = options }
      disconnect() { this.connected = false }
    },
    setTimeout: (run, ms) => { timers.push(ms); return 0 }, clearTimeout() {},
    cancelAnimationFrame() {}, requestAnimationFrame: () => 0,
    require: (name) => {
      if (name === 'react') return react
      if (name === 'react-dom') return { createPortal: node => node }
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return icons
      if (name === 'open-bot-avatar/dom') {
        return { mountAvatar: (host, options) => {
          const mount = { host, options, updates: [], destroyed: false }
          mounts.push(mount)
          return { update: next => mount.updates.push(next), destroy: () => { mount.destroyed = true } }
        } }
      }
      return {}
    },
  })
  // Every function component under `node`, run down to plain elements.
  const expand = (node) => {
    if (Array.isArray(node)) return node.map(expand)
    if (!node || typeof node !== 'object') return node
    if (typeof node.type === 'function') return expand(node.type.prototype?.render ? new node.type(node.props).render() : node.type(node.props))
    return { ...node, props: { ...node.props, children: expand(node.props?.children) } }
  }
  return {
    client: module.exports, react, mounts, observers, timers, body, surfaces, expand,
    // Mounts a whole tree as new instances: every component is run and every effect it queued
    // is run once, as on a first paint. Returns the plain elements.
    mount(element) {
      slots = []
      cursor = 0
      queued = []
      const tree = expand(element)
      for (const [effect, run] of queued) effect.cleanup = run()
      return tree
    },
    // Renders one component as the same instance each time, and runs the effects it queued.
    render(component, props, host) {
      cursor = 0
      queued = []
      const tree = component(props)
      if (host !== undefined && tree.props.ref) tree.props.ref.current = host
      for (const [effect, run] of queued) {
        effect.cleanup?.()
        effect.cleanup = run()
      }
      return tree
    },
    unmount() { for (const entry of slots) entry.cleanup?.() },
    reset() { slots = []; cursor = 0 },
  }
}

const plain = value => JSON.parse(JSON.stringify(value))

test('what a Bot is doing becomes one of the package\'s six states', () => {
  const { client } = load()
  const states = ['idle', 'thinking', 'searching', 'working', 'sending', 'orbit', 'waiting', 'alert', 'done']
  assert.deepEqual(states.map(client.avatarState), ['idle', 'thinking', 'working', 'working', 'working', 'working', 'waiting', 'blocked', 'done'])
  // A Bot waiting for its teammates and a Bot waiting for the user do not look alike.
  assert.notEqual(client.avatarState('alert'), client.avatarState('waiting'))
  assert.equal(client.avatarState('juggling'), 'idle')
  assert.equal(client.avatarState('constructor'), 'idle')
  // A finished run shows the package's whole celebration.
  assert.equal(client.DONE_MS >= DONE_TURN_S * 1000, true)
})

test('a Bot color becomes a hex for the canvas, in the light or the dark mode', () => {
  const { client } = load()
  assert.equal(client.inkHex('violet', false), INKS.violet[0])
  assert.equal(client.inkHex('violet', true), INKS.violet[1])
  assert.equal(client.inkHex('black', false), '#000000')
  assert.equal(client.inkHex('black', true), '#FFFFFF')
  // A custom color is the same in both modes.
  assert.equal(client.inkHex('#12ab34', true), '#12ab34')
  // The gradient color has no single paint: it takes the ink that stands in for it in text.
  assert.deepEqual([client.inkHex('aurora', false), client.inkHex('aurora', true)], INKS.aurora)
  // A renamed ink still found in a saved Bot, and one nobody knows.
  assert.equal(client.inkHex('minimax', false), INKS.rose[0])
  assert.equal(client.inkHex('plaid', false), INKS.gray[0])
})

test('interface motion picks between a moving avatar, a calm one and one still picture', () => {
  const { client } = load()
  assert.deepEqual(plain(client.avatarMotion('full')), { still: false, reducedMotion: 'system' })
  assert.deepEqual(plain(client.avatarMotion('reduced')), { still: false, reducedMotion: true })
  assert.deepEqual(plain(client.avatarMotion('off')), { still: true, reducedMotion: true })
})

test('the options name the Bot, paint the eyes like the surface and leave petting out when Bot animation is quiet', () => {
  const { client } = load()
  const avatar = { definition: AVATAR_DEFINITIONS.kitty, color: 'green', state: 'searching', label: 'Writer', gaze: true, still: false, happy: true }
  const page = { dark: false, effects: 'full', quiet: false, surface: '#f7f7f7' }
  assert.deepEqual(plain(client.avatarOptions(avatar, page)), {
    definition: AVATAR_DEFINITIONS.kitty, label: 'Writer', color: INKS.green[0], eyeColor: '#f7f7f7',
    state: 'working', mood: 'happy', followPointer: true, still: false, reducedMotion: 'system',
  })
  const quiet = client.avatarOptions(avatar, { ...page, dark: true, quiet: true })
  assert.deepEqual([quiet.color, quiet.mood, quiet.followPointer], [INKS.green[1], 'neutral', false])
  // A tile past the first few is one still picture whatever interface motion says.
  assert.equal(client.avatarOptions({ ...avatar, still: true }, page).still, true)
  assert.equal(client.avatarOptions(avatar, { ...page, effects: 'off' }).still, true)
  assert.equal(client.avatarOptions(avatar, { ...page, effects: 'reduced' }).reducedMotion, true)
})

test('the switch is off until it is turned on, and then only the first Main Bot tiles move', () => {
  const { client } = load()
  // A team that never set it, and the `false` an earlier build stored for off.
  for (const prefs of [undefined, {}, { animatedAvatars: false }, { animatedAvatars: null }, { animatedAvatars: 'true' }, { animatedAvatars: 1 }]) {
    assert.equal(client.animatedAvatarsOn(prefs), false, JSON.stringify(prefs))
    assert.deepEqual([0, 4].map(index => client.tileAvatar(prefs, index)), [undefined, undefined], JSON.stringify(prefs))
  }
  const on = { animatedAvatars: true }
  assert.equal(client.animatedAvatarsOn(on), true)
  assert.deepEqual([0, 3, 4, 9].map(index => client.tileAvatar(on, index)), ['live', 'live', 'still', 'still'])
})

test('a picture, the Muse spider and a character with no definition have nothing to animate', () => {
  const { client } = load()
  assert.deepEqual(plain(client.animatedDefinition({ shape: 'star', color: 'red' })), AVATAR_DEFINITIONS.star)
  assert.equal(client.animatedDefinition({ shape: 'star', color: 'red', image: 'data:image/png;base64,iVBORw0KGgo=' }), undefined)
  assert.equal(client.animatedDefinition({ shape: 'muse-spider', color: 'violet' }), undefined)
  assert.equal(client.animatedDefinition({ shape: 'whale', color: 'blue' }), undefined)
  assert.equal(client.animatedDefinition({ shape: 'toString', color: 'blue' }), undefined)
  // Only the seven default characters have one: the other thirteen and the spider have none.
  const others = Object.keys(SHAPES).filter(shape => !DEFAULT_SHAPES.includes(shape))
  assert.equal(others.length, 14)
  assert.equal(others.includes('muse-spider'), true)
  for (const shape of Object.keys(SHAPES)) {
    assert.equal(client.animatedDefinition({ shape, color: 'cyan' }) !== undefined, DEFAULT_SHAPES.includes(shape), shape)
  }
})

// ---------------------------------------------------------------------------
// The wrapper.

const props = (more = {}) => ({ definition: AVATAR_DEFINITIONS.bunny, color: 'magenta', size: 60, state: 'idle', label: 'Writer', ...more })

test('the wrapper mounts the package\'s avatar into its square host, updates it and destroys it', () => {
  const page = load()
  const host = { tag: 'host' }
  const tree = page.render(page.client.AnimatedAvatar, props(), host)
  assert.equal(tree.type, 'span')
  assert.deepEqual(tree.props.className.split(' '), ['bt-mark', 'bt-mark-live'])
  assert.deepEqual(plain(tree.props.style), { width: 60, height: 60 })
  assert.deepEqual(tree.props.children, [])
  assert.equal(page.mounts.length, 1)
  const [mount] = page.mounts
  assert.equal(mount.host, host)
  assert.deepEqual(plain(mount.options), {
    definition: AVATAR_DEFINITIONS.bunny, label: 'Writer', color: INKS.magenta[0], eyeColor: '#f7f7f7',
    state: 'idle', mood: 'neutral', followPointer: false, still: false, reducedMotion: 'system',
  })
  assert.deepEqual(mount.updates, [])

  // The same props again change nothing; a new state reaches the avatar as one update.
  page.render(page.client.AnimatedAvatar, props())
  assert.deepEqual(mount.updates, [])
  page.render(page.client.AnimatedAvatar, props({ state: 'alert' }))
  assert.deepEqual(mount.updates.map(update => update.state), ['blocked'])
  page.render(page.client.AnimatedAvatar, props({ state: 'alert', color: '#123456', label: 'Editor' }))
  assert.deepEqual(mount.updates.slice(1).map(update => [update.color, update.label]), [['#123456', 'Editor']])
  assert.equal(page.mounts.length, 1)

  // Unmounting stops watching the page and removes the avatar.
  assert.equal(page.observers.length, 1)
  assert.equal(page.observers[0].connected, true)
  page.unmount()
  assert.equal(mount.destroyed, true)
  assert.equal(page.observers[0].connected, false)
})

test('the theme and the motion settings reach a mounted avatar without a render', () => {
  const page = load()
  page.render(page.client.AnimatedAvatar, props({ gaze: true, surface: 'main' }), {})
  const [mount] = page.mounts
  const [observer] = page.observers
  assert.equal(observer.target, page.body)
  assert.deepEqual(plain(observer.options), { attributes: true, attributeFilter: ['data-ds-dark-theme', 'data-bt-effects', 'data-bt-motion'] })
  // The details page stands on the panel, and its avatar follows the pointer.
  assert.deepEqual([mount.options.eyeColor, mount.options.followPointer], ['#fcfcfc', true])

  // An attribute written again with the same value redraws nothing.
  observer.run()
  assert.deepEqual(mount.updates, [])
  page.body.attributes.add('data-ds-dark-theme')
  page.surfaces['--bt-main'] = '#141414'
  observer.run()
  assert.deepEqual(mount.updates.map(update => [update.color, update.eyeColor]), [[INKS.magenta[1], '#141414']])
  page.body.dataset.btEffects = 'reduced'
  observer.run()
  assert.deepEqual([mount.updates[1].still, mount.updates[1].reducedMotion], [false, true])
  page.body.dataset.btEffects = 'off'
  observer.run()
  assert.equal(mount.updates[2].still, true)
  page.body.dataset.btEffects = 'full'
  page.body.dataset.btMotion = 'quiet'
  observer.run()
  assert.deepEqual([mount.updates[3].still, mount.updates[3].followPointer], [false, false])
  // A skin's translucent surface is no color for a canvas: the eyes are the page's plain black or white.
  page.surfaces['--bt-main'] = 'rgba(20, 20, 20, 0.6)'
  observer.run()
  assert.equal(mount.updates[4].eyeColor, '#000000')
  page.body.attributes.delete('data-ds-dark-theme')
  observer.run()
  assert.equal(mount.updates[5].eyeColor, '#FFFFFF')
})

test('the pointer on an avatar makes it happy, as petting does a drawn mark', () => {
  const page = load()
  const tree = page.render(page.client.AnimatedAvatar, props(), {})
  const [mount] = page.mounts
  tree.props.onPointerEnter()
  const petted = page.render(page.client.AnimatedAvatar, props())
  assert.deepEqual(mount.updates.map(update => update.mood), ['happy'])
  petted.props.onPointerLeave()
  page.render(page.client.AnimatedAvatar, props())
  assert.deepEqual(mount.updates.map(update => update.mood), ['happy', 'neutral'])
})

// ---------------------------------------------------------------------------
// Where it shows, and where the drawn mark stays.

const BOT = { id: 'writer', name: 'Writer', avatar: { shape: 'kitty' }, color: 'green' }
const classesOf = node => String(node.props?.className ?? '').split(' ')

test('an animated Bot avatar stands in the box of the drawn mark, under the same badges', () => {
  const page = load()
  const avatar = more => { page.reset(); return page.render(page.client.BotAvatar, { bot: BOT, size: 60, ...more }) }
  const drawn = avatar({ state: 'alert', main: true, im: 'feishu' })
  const animated = avatar({ state: 'alert', main: true, im: 'feishu', animated: 'live' })
  // The same outer box, and the same badges after the first child.
  assert.deepEqual(plain(animated.props.style), plain(drawn.props.style))
  assert.deepEqual(plain(animated.props.style), { width: 60, height: 60, '--bt-size': '60px' })
  const badges = tree => tree.props.children.slice(1).filter(Boolean).map(child => child.props.className)
  assert.deepEqual(badges(animated), badges(drawn))
  assert.deepEqual(badges(animated), ['bt-badge bt-badge-alert', 'bt-badge bt-badge-im'])
  assert.deepEqual(badges(avatar({ state: 'working', animated: 'live' })), ['bt-badge bt-badge-working'])
  assert.deepEqual(badges(avatar({ main: true, im: 'feishu', animated: 'live' })), ['bt-badge bt-badge-main', 'bt-badge bt-badge-im bt-badge-im-main'])
  // The first child is the animated avatar, in the size of the mark it replaces.
  assert.equal(drawn.props.children[0].type, page.client.BotMark)
  const [first] = animated.props.children
  assert.equal(first.type, page.client.AnimatedAvatar)
  assert.deepEqual(plain({ ...first.props, definition: first.props.definition.id }), {
    definition: 'kitty', color: 'green', size: 60, state: 'alert', label: 'Writer', gaze: false, still: false, children: [],
  })
  assert.equal(avatar({ animated: 'still' }).props.children[0].props.still, true)
  const host = first.type(first.props)
  assert.deepEqual(plain(host.props.style), { width: 60, height: 60 })
})

// A Bot of every kind: the seven default characters, the Muse spider, a picture and the other thirteen.
const botOf = (shape, more = {}) => ({ id: `bot-${shape}`, name: `Bot ${shape}`, avatar: { shape }, color: 'cyan', ...more })
const SPIDER_BOT = botOf('muse-spider')
const PICTURE_BOT = botOf('kitty', { avatar: { shape: 'kitty', image: 'data:image/png;base64,iVBORw0KGgo=' } })
const OTHER_SHAPES = Object.keys(SHAPES).filter(shape => !DEFAULT_SHAPES.includes(shape) && shape !== 'muse-spider')
// The plain elements of a mounted tree as text. A function keeps its place, and the serial each
// drawn mark numbers its mask with reads the same in two mounts.
const written = tree => JSON.stringify(tree, (key, value) => (typeof value === 'function' ? '[function]' : value)).replace(/bt-mark-\d+/g, 'bt-mark-N')
const find = (node, match, out = []) => {
  if (Array.isArray(node)) { for (const child of node) find(child, match, out); return out }
  if (!node || typeof node !== 'object') return out
  if (match(node)) out.push(node)
  return find(node.props?.children, match, out)
}
// The markup of the one drawn mark in a mounted tree, with the mask's serial put back.
const drawingOf = (tree) => {
  const svgs = find(tree, node => node.type === 'svg' && node.props.dangerouslySetInnerHTML !== undefined)
  assert.equal(svgs.length, 1)
  return svgs[0].props.dangerouslySetInnerHTML.__html.replace(/bt-mark-\d+/g, MASK_ID)
}
const isLive = node => classesOf(node).includes('bt-mark-live') || node.type === 'canvas'

test('with the switch off a tile and a details page draw the marks they drew before, and the package is never asked', () => {
  const bots = [...DEFAULT_SHAPES.map(shape => botOf(shape)), SPIDER_BOT, PICTURE_BOT, botOf('whale')]
  // A team that never touched the switch, and the `false` an earlier build stored.
  for (const prefs of [undefined, {}, { animatedAvatars: false }]) {
    const page = load()
    const { BotAvatar, DetailsAvatar, tileAvatar, animatedAvatarsOn } = page.client
    const h = page.react.createElement
    for (const bot of bots) {
      // The tile as sidebar.js builds it, beside the avatar it built before the animated avatars.
      const tile = page.mount(h(BotAvatar, { bot, size: 60, state: 'working', main: true, im: 'feishu', animated: tileAvatar(prefs, 0) }))
      assert.equal(written(tile), written(page.mount(h(BotAvatar, { bot, size: 60, state: 'working', main: true, im: 'feishu' }))), bot.id)
      // The details page as details-drawer.js builds it, beside what DetailsAvatar returned before.
      const details = page.mount(h(DetailsAvatar, { bot, main: true, running: true, activity: 'thinking', awaitingInput: false, animated: animatedAvatarsOn(prefs) }))
      if (bot !== SPIDER_BOT) {
        assert.equal(written(details), written(page.mount(h(BotAvatar, { bot, size: 64, main: true, state: 'thinking', badge: false, gaze: true, pokeable: true }))), bot.id)
      }
      for (const tree of [tile, details]) {
        assert.deepEqual(find(tree, isLive), [], bot.id)
        // The drawing is the character's own markup, from characters.js.
        if (bot !== PICTURE_BOT) assert.equal(drawingOf(tree), characterMarkup(bot.avatar.shape, 'cyan'), bot.id)
      }
    }
    assert.equal(page.mounts.length, 0)
  }
})

test('with the switch on the seven default characters are the package\'s avatars, on a tile and on the details page', () => {
  const page = load()
  const { BotAvatar, DetailsAvatar, AnimatedAvatar, tileAvatar, animatedAvatarsOn } = page.client
  const h = page.react.createElement
  const prefs = { animatedAvatars: true }
  for (const shape of DEFAULT_SHAPES) {
    const bot = botOf(shape)
    page.mounts.length = 0
    const tile = page.mount(h(BotAvatar, { bot, size: 60, state: 'working', main: true, im: 'feishu', animated: tileAvatar(prefs, 0) }))
    assert.equal(find(tile, isLive).length, 1, shape)
    assert.equal(find(tile, node => node.type === 'svg' && node.props.dangerouslySetInnerHTML !== undefined).length, 0, shape)
    const details = page.mount(h(DetailsAvatar, { bot, main: true, running: true, activity: 'thinking', awaitingInput: false, animated: animatedAvatarsOn(prefs) }))
    assert.equal(find(details, isLive).length, 1, shape)
    assert.deepEqual(page.mounts.map(mount => [mount.options.definition.id, mount.options.state, mount.options.color, mount.options.label, mount.options.eyeColor]), [
      [shape, 'working', INKS.cyan[0], bot.name, '#f7f7f7'],
      [shape, 'thinking', INKS.cyan[0], bot.name, '#fcfcfc'],
    ])
  }
  page.reset()
  const [first] = page.render(BotAvatar, { bot: botOf('kitty'), size: 60, animated: 'live' }).props.children
  assert.equal(first.type, AnimatedAvatar)
})

test('with the switch on a spider Bot still renders the vector spider, in the Bot\'s color, and no canvas', () => {
  const page = load()
  const { BotAvatar, BotMark, DetailsAvatar, tileAvatar, animatedAvatarsOn } = page.client
  const h = page.react.createElement
  const prefs = { animatedAvatars: true }
  const spiderIn = paint => `<path d="${SPIDER.body}" fill="${paint}"/>`
  for (const [bot, paint] of [[SPIDER_BOT, 'var(--bt-ink-cyan)'], [botOf('muse-spider', { color: 'violet' }), SPIDER.base], [botOf('muse-spider', { color: '#418fae' }), '#418fae']]) {
    // Every tile place, moving and still.
    for (const index of [0, 3, 4]) {
      const tile = page.mount(h(BotAvatar, { bot, size: 60, state: 'working', main: true, animated: tileAvatar(prefs, index) }))
      assert.deepEqual(find(tile, isLive), [])
      assert.equal(drawingOf(tile), characterMarkup('muse-spider', bot.color))
      assert.ok(drawingOf(tile).includes(spiderIn(paint)), paint)
      // The avatar is the one a team with the switch off has.
      assert.equal(written(tile), written(page.mount(h(BotAvatar, { bot, size: 60, state: 'working', main: true }))))
    }
    // The details page keeps the spider's own motion: SpiderDetail around the drawn mark.
    const element = h(DetailsAvatar, { bot, main: true, running: true, activity: 'thinking', awaitingInput: false, animated: animatedAvatarsOn(prefs) })
    page.reset()
    const spider = DetailsAvatar(element.props)
    assert.equal(spider.type.name, 'SpiderDetail')
    assert.equal('animated' in spider.props, false)
    const drawn = spider.type(spider.props)
    assert.deepEqual(classesOf(drawn), ['bt-spider-detail'])
    assert.equal(drawn.props.children[0].type, BotMark)
    const details = page.mount(element)
    assert.deepEqual(find(details, isLive), [])
    assert.ok(drawingOf(details).includes(spiderIn(paint)), paint)
    assert.equal(written(details), written(page.mount(h(DetailsAvatar, { bot, main: true, running: true, activity: 'thinking', awaitingInput: false }))))
  }
  assert.equal(page.mounts.length, 0)
})

test('with the switch on a Bot with a picture and the other thirteen characters keep the drawn mark', () => {
  const page = load()
  const { BotAvatar, BotMark, DetailsAvatar } = page.client
  const h = page.react.createElement
  assert.equal(OTHER_SHAPES.length, 13)
  for (const bot of [PICTURE_BOT, ...OTHER_SHAPES.map(shape => botOf(shape))]) {
    page.reset()
    const [mark] = page.render(BotAvatar, { bot, size: 60, animated: 'live' }).props.children
    assert.equal(mark.type, BotMark, bot.id)
    assert.deepEqual(plain(mark.props), { bot: plain(bot), size: 60, state: 'idle', live: true, gaze: false, pokeable: false, children: [] })
    for (const animated of ['live', 'still']) {
      const tile = page.mount(h(BotAvatar, { bot, size: 60, state: 'working', main: true, animated }))
      assert.deepEqual(find(tile, isLive), [], bot.id)
      assert.equal(written(tile), written(page.mount(h(BotAvatar, { bot, size: 60, state: 'working', main: true }))), bot.id)
    }
    const details = page.mount(h(DetailsAvatar, { bot, main: false, running: false, animated: true }))
    assert.deepEqual(find(details, isLive), [], bot.id)
    assert.equal(written(details), written(page.mount(h(DetailsAvatar, { bot, main: false, running: false }))), bot.id)
    if (bot === PICTURE_BOT) assert.equal(find(details, node => node.type === 'img').length, 1)
    else assert.equal(drawingOf(details), characterMarkup(bot.avatar.shape, 'cyan'), bot.id)
  }
  assert.equal(page.mounts.length, 0)
})

test('a finished run holds the drawn mark\'s squash as long as before, and only an animated avatar\'s celebration longer', () => {
  // Runs BotAvatar through a run that finishes, and gives the delay of the timer that ends the hold.
  const holdOf = (props) => {
    const page = load()
    page.render(page.client.BotAvatar, { ...props, state: 'working' })
    page.render(page.client.BotAvatar, { ...props, state: 'idle' })
    return page.timers
  }
  const kitty = botOf('kitty')
  assert.deepEqual(holdOf({ bot: kitty, size: 60 }), [1800])
  assert.deepEqual(holdOf({ bot: SPIDER_BOT, size: 60, animated: 'live' }), [1800])
  assert.deepEqual(holdOf({ bot: PICTURE_BOT, size: 60, animated: 'live' }), [1800])
  assert.deepEqual(holdOf({ bot: botOf('whale'), size: 60, animated: 'live' }), [1800])
  const page = load()
  assert.deepEqual(holdOf({ bot: kitty, size: 60, animated: 'live' }), [page.client.DONE_MS])
})

test('the details page hands its avatar to the package only when the switch is on', () => {
  const page = load()
  const details = (bot, animated) => { page.reset(); return page.render(page.client.DetailsAvatar, { bot, running: true, activity: 'thinking', animated }) }
  const on = details(BOT, true)
  assert.equal(on.type, page.client.BotAvatar)
  assert.deepEqual([on.props.size, on.props.badge, on.props.animated, on.props.surface, on.props.state], [64, false, 'live', 'main', 'thinking'])
  // Off, and with nothing said, the avatar gets what it got before.
  for (const off of [details(BOT, false), details(BOT, undefined)]) {
    assert.deepEqual(plain(off.props), { bot: BOT, size: 64, state: 'thinking', badge: false, gaze: true, pokeable: true, children: [] })
  }
})

test('Settings → Bots has one switch for the animated avatars, with no hint', () => {
  const page = load()
  const text = node => (typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : node?.props ? text(node.props.children) : '')
  const dialog = (prefs) => {
    const calls = []
    page.reset()
    const tree = page.expand(page.react.createElement(page.client.SettingsDialog, {
      page: 'bots', roster: { bots: [], byId: {}, rooms: [], roomsById: {}, mainBotIds: [], prefs },
      actions: { setPrefs: (patch) => { calls.push(patch); return Promise.resolve() }, openSettings() {}, closeSettings() {} },
      dsh: { items: [], sections: [], renderSlot: () => null },
    }))
    return { calls, switches: find(tree, node => node.props?.role === 'switch' && node.props['aria-label'] === 'Animated avatars'), tree }
  }
  // A team that never touched it sees the switch off.
  const first = dialog({})
  assert.equal(first.switches.length, 1)
  assert.equal(first.switches[0].props['aria-checked'], false)
  // Its row sits in the Animation card under Bot animation, and says nothing more than its label.
  const [row] = find(first.tree, node => classesOf(node).includes('bt-set-row') && find(node, child => child === first.switches[0]).length === 1)
  assert.equal(text(row), 'Animated avatars')
  assert.equal(find(row, node => classesOf(node).includes('bt-set-hint')).length, 0)
  const [card] = find(first.tree, node => classesOf(node).includes('bt-set-card') && find(node, child => child === row).length === 1)
  assert.deepEqual(find(card, node => classesOf(node).includes('bt-set-row')).map(text).map(label => label.replace(/Quiet.*$/, '')), ['Bot animation', 'Animated avatars'])
  first.switches[0].props.onClick()
  assert.deepEqual(plain(first.calls), [{ animatedAvatars: true }])
  const on = dialog({ animatedAvatars: true })
  assert.equal(on.switches[0].props['aria-checked'], true)
  on.switches[0].props.onClick()
  assert.deepEqual(plain(on.calls), [{ animatedAvatars: false }])
  // The `false` an earlier build stored shows as off, and one click turns it on.
  const stored = dialog({ animatedAvatars: false })
  assert.equal(stored.switches[0].props['aria-checked'], false)
  stored.switches[0].props.onClick()
  assert.deepEqual(plain(stored.calls), [{ animatedAvatars: true }])
})

test('the host of an animated avatar takes no pointer inside, and its tile keeps the name on top', () => {
  const { client } = load()
  assert.match(client.SHELL_CSS, /\.bt-mark-live>\*\{pointer-events:none\}/)
  assert.match(client.SHELL_CSS, /\.bt-list:has\(\.bt-mark-live\)\{overflow-x:hidden\}/)
  assert.match(client.SHELL_CSS, /\.bt-tile:has\(\.bt-mark-live\)>:is\(\.bt-tile-name,\.bt-chip\)\{position:relative\}/)
})

test('a copy of an animated avatar shows the picture of the canvas it copies', () => {
  const { document } = new JSDOM('<!doctype html><body><span id="mark" class="bt-mark"><span class="bt-mark bt-mark-live"><div><canvas width="90" height="90"></canvas></div></span></span></body>').window
  const original = document.getElementById('mark')
  const painted = []
  // jsdom has no canvas: a context that records what is drawn onto it.
  const context = canvas => ({ drawImage: (...args) => painted.push([canvas, ...args]) })
  Object.getPrototypeOf(original.querySelector('canvas')).getContext = function getContext() { return context(this) }
  const copy = copyOf(original)
  assert.notEqual(copy.id, 'mark')
  const canvas = copy.querySelector('canvas')
  assert.notEqual(canvas, original.querySelector('canvas'))
  assert.deepEqual(painted, [[canvas, original.querySelector('canvas'), 0, 0]])
  // A canvas that has no size yet is left blank instead of throwing.
  original.querySelector('canvas').width = 0
  painted.length = 0
  copyOf(original)
  assert.deepEqual(painted, [])
})

test('a copy of anything else is the clone with ids of its own that it was, canvases left alone', () => {
  const html = '<!doctype html><body><div id="view"><span id="mark" class="bt-mark"><svg><mask id="m"></mask><g mask="url(#m)"></g></svg></span><canvas width="300" height="150"></canvas></div></body>'
  const { document } = new JSDOM(html).window
  const view = document.getElementById('view')
  const painted = []
  Object.getPrototypeOf(view.querySelector('canvas')).getContext = function getContext() { painted.push(this); return { drawImage() {} } }
  const copy = copyOf(view)
  // No canvas is read or painted where no animated avatar stands.
  assert.deepEqual(painted, [])
  // The same markup as the clone made before copyOf, up to the serial of the ids.
  const before = uniqueIds(new JSDOM(html).window.document.getElementById('view').cloneNode(true))
  const even = markup => markup.replace(/-f\d+/g, '-fN')
  assert.equal(even(copy.outerHTML), even(before.outerHTML))
  assert.match(copy.outerHTML, /<mask id="m-f\d+"><\/mask><g mask="url\(#m-f\d+\)">/)
})
