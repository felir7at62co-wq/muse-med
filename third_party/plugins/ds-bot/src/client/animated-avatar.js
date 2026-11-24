// Muse: animated avatars, on until Settings → Bots → Animation turns them off. open-bot-avatar
// draws a character from one outline and an eye pair (avatar-definitions.js) and moves it for
// what the Bot is doing. It shows in two places, the Main Bot tiles of the sidebar and the avatar
// of a Bot's details page; a Bot with a picture, the Muse spider and every other character keep
// the drawn mark of mark.js. While the switch is off nothing here runs past `animatedAvatarsOn`.
import { createElement as h, useEffect, useRef, useState } from 'react'
import { mountAvatar } from 'open-bot-avatar/dom'
import { AVATAR_DEFINITIONS } from './avatar-definitions.js'
import { INKS, inkHex, isHex } from './inks.js'
import { effectsTier } from './motion.js'

/**
 * Whether the animated avatars are on (Settings → Bots → Animation).
 * @param {object | undefined} prefs - The team preferences.
 * @returns {boolean} True unless the switch was turned off. The stored `animatedAvatars` reads:
 *   no key, on (the default; also a team that turned it on and off again while off was the
 *   default, which left no key); `true`, on (stored while off was the default); `false`, off.
 */
export const animatedAvatarsOn = prefs => prefs?.animatedAvatars !== false

// A live avatar repaints its own canvas every frame, so only the first Main Bot tiles move.
// With the avatar of the details page that is five canvases at most.
const LIVE_TILES = 4

/**
 * How the tile of the Main Bot at `index` draws its avatar.
 * @param {object | undefined} prefs - The team preferences.
 * @param {number} index - The Bot's place among the Main Bots.
 * @returns {'live' | 'still' | undefined} Undefined keeps the drawn mark.
 */
export const tileAvatar = (prefs, index) => (!animatedAvatarsOn(prefs) ? undefined : index < LIVE_TILES ? 'live' : 'still')

// The Muse spider is the product's own mark (muse-spider.js): it is never handed to the package,
// whatever the definitions hold.
const DRAWN_ONLY = 'muse-spider'

/**
 * The definition that draws a look.
 * @param {{ shape: string, image?: string }} look - What lookOf returned.
 * @returns {object | undefined} Undefined for a picture, for the Muse spider and for a shape with no definition.
 */
export const animatedDefinition = look => (look.image || look.shape === DRAWN_ONLY || !Object.hasOwn(AVATAR_DEFINITIONS, look.shape) ? undefined : AVATAR_DEFINITIONS[look.shape])

// What the Bot is doing (botState and toolState in mark.js) as one of the package's six states.
// Searching, sending and coordinating are all work to it. `waiting` is a Bot whose handed-on work
// has not come back: the package's bored lean. `alert` is a Bot that cannot go on until the user
// answers or approves, which is the package's `blocked`, an exclamation mark that jumps: the one
// state that asks for attention, and the only sign of the question on the details page, which
// shows no badge. `waiting` would also make it look like a Bot waiting for a teammate.
const AVATAR_STATES = { idle: 'idle', thinking: 'thinking', searching: 'working', working: 'working', sending: 'working', orbit: 'working', waiting: 'waiting', alert: 'blocked', done: 'done' }

/**
 * The package's state for a mark state.
 * @param {string} state - A state of mark.js.
 * @returns {'idle' | 'thinking' | 'working' | 'waiting' | 'blocked' | 'done'} `idle` for a state it does not know.
 */
export const avatarState = state => (Object.hasOwn(AVATAR_STATES, state) ? AVATAR_STATES[state] : 'idle')

// A finished run celebrates once: the package's turn inside its ribbons lasts 3.87 s.
export const DONE_MS = 3900

/**
 * Interface motion (Settings → General) as the package's options.
 * @param {'full' | 'reduced' | 'off'} tier - What effectsTier returned.
 * @returns {{ still: boolean, reducedMotion: boolean | 'system' }} Off is one still picture; reduced holds a calm pose.
 */
export const avatarMotion = tier => (tier === 'off' ? { still: true, reducedMotion: true } : { still: false, reducedMotion: tier === 'reduced' ? true : 'system' })

/**
 * The package's options for one avatar.
 * @param {{ definition: object, color: string, state: string, label: string, gaze: boolean, still: boolean, happy: boolean }} avatar - What to draw.
 * @param {{ dark: boolean, effects: 'full' | 'reduced' | 'off', quiet: boolean, surface: string }} page - What the page is set to.
 * @returns {object} Options for mountAvatar and its update.
 */
export function avatarOptions({ definition, color, state, label, gaze, still, happy }, { dark, effects, quiet, surface }) {
  return {
    definition, label,
    // A canvas cannot read a CSS variable and a still falls back to the package's own orange, so both colors are hex.
    color: inkHex(color, dark),
    eyeColor: surface,
    state: avatarState(state),
    // Bot animation set to quiet leaves out petting and eyes that follow the pointer, as for the drawn marks.
    mood: happy && !quiet ? 'happy' : 'neutral',
    followPointer: gaze && !quiet,
    ...avatarMotion(still ? 'off' : effects),
  }
}

// The eyes of a drawn mark are holes that show the surface behind it. A canvas paints its eyes,
// so they take that surface's color: the sidebar under a tile, the panel under a details avatar.
const SURFACES = { sidebar: '--bt-sidebar', main: '--bt-main' }
// What the page sets on the body: the theme's mode, interface motion and Bot animation.
const PAGE_ATTRIBUTES = ['data-ds-dark-theme', 'data-bt-effects', 'data-bt-motion']

function pageOf(host, surface) {
  const dark = document.body.hasAttribute('data-ds-dark-theme')
  const drawn = getComputedStyle(host).getPropertyValue(SURFACES[surface]).trim()
  // A skin may make the surface translucent; the eyes are then the page's plain white or black.
  return { dark, effects: effectsTier(), quiet: document.body.dataset.btMotion === 'quiet', surface: isHex(drawn) ? drawn : INKS.black[dark ? 0 : 1] }
}

/**
 * One animated avatar in a square box of `size` pixels.
 * @param {{ definition: object, color: string, size: number, state?: string, label: string, gaze?: boolean, still?: boolean, surface?: 'sidebar' | 'main' }} props -
 *   `color` is a Bot color; `gaze` follows the pointer; `still` draws one picture; `surface` names what the avatar stands on.
 * @returns {object} The host element. The package fills it and its canvas may paint past the box.
 */
export function AnimatedAvatar({ definition, color, size, state = 'idle', label, gaze = false, still = false, surface = 'sidebar' }) {
  const host = useRef(null)
  const mounted = useRef(null)
  const [happy, setHappy] = useState(false)
  const latest = useRef(null)
  latest.current = { definition, color, state, label, gaze, still, happy, surface }
  const shown = useRef('')
  // `update` redraws a still and wakes a sleeping canvas, so it runs only for options that changed.
  const sync = () => {
    const options = avatarOptions(latest.current, pageOf(host.current, latest.current.surface))
    const key = JSON.stringify({ ...options, definition: options.definition.id })
    if (mounted.current === null) mounted.current = mountAvatar(host.current, options)
    else if (key !== shown.current) mounted.current.update(options)
    shown.current = key
  }
  useEffect(() => {
    sync()
    // The theme and the two motion settings reach a canvas only through an update.
    const observer = new MutationObserver(sync)
    observer.observe(document.body, { attributes: true, attributeFilter: PAGE_ATTRIBUTES })
    return () => {
      observer.disconnect()
      mounted.current.destroy()
      mounted.current = null
    }
  }, [])
  useEffect(() => { if (mounted.current !== null) sync() }, [definition, color, state, label, gaze, still, surface, happy])
  return h('span', {
    ref: host, className: 'bt-mark bt-mark-live', style: { width: size, height: size },
    onPointerEnter: () => setHappy(true), onPointerLeave: () => setHappy(false),
  })
}

export const ANIMATED_AVATAR_CSS = `
.bt-mark-live>*{pointer-events:none}
.bt-list:has(.bt-mark-live){overflow-x:hidden}
.bt-tile:has(.bt-mark-live)>:is(.bt-tile-name,.bt-chip){position:relative}
`
