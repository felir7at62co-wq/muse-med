// Muse: the team capsule above a Main Bot's message box between its two shapes, the
// capsule and the bubble it opens into. member-status.js decides what is drawn and when
// it opens; this file owns how it moves: one spring takes the surface from one shape to
// the other, and everything that travels (the surface's box and corners, each avatar from
// its seat in the capsule to its row, the words of the capsule and of its first row, the chevron) is placed from that
// spring's value, so a turn round mid-way goes on from where everything stands.

/** The capsule's height and corner, and the bubble's corner (steps of the radius scale). */
export const PILL = { height: 32, radius: 16 }
export const BUBBLE_RADIUS = 18

const mix = (from, to, p) => from + (to - from) * p
const clamp = p => Math.min(1, Math.max(0, p))
const round = (value, digits = 2) => Number(value.toFixed(digits))

/**
 * The surface at progress `p` of its way from the capsule to the bubble.
 * @param {{width: number, height: number, radius: number}} pill
 * @param {{width: number, height: number, radius: number}} bubble
 * @param {number} p - 0 the capsule, 1 the bubble; a spring may pass either a little
 */
export function dockShape(pill, bubble, p) {
  return { width: mix(pill.width, bubble.width, p), height: mix(pill.height, bubble.height, p), radius: mix(pill.radius, bubble.radius, p) }
}

/**
 * What moves an avatar that is laid out in its row (`slot`) to where it is at progress
 * `p` of its way from its seat in the capsule: on the seat at 0, in the row at 1. Both
 * boxes are read in the same frame, and the transform's origin is the avatar's corner.
 * @param {{left: number, top: number, width: number}} seat
 * @param {{left: number, top: number, width: number}} slot
 */
export function faceTravel(seat, slot, p) {
  const left = 1 - p
  return { x: (seat.left - slot.left) * left, y: (seat.top - slot.top) * left, scale: slot.width > 0 ? mix(seat.width / slot.width, 1, p) : 1 }
}

/**
 * The list to draw after a change: `items` in their order, and each entry of `before`
 * that is no longer among them, kept where it stood and marked `leaving` until `ms` have
 * passed since it left.
 * @template T
 * @param {{key: string, item: T, leaving: boolean, until: number}[]} before - the list as last drawn
 * @param {T[]} items
 * @param {(item: T) => string} keyOf
 * @param {number} now
 * @param {number} ms - how long an exit lasts; 0 keeps nothing
 */
export function withLeaving(before, items, keyOf, now, ms) {
  const list = items.map(item => ({ key: keyOf(item), item, leaving: false, until: 0 }))
  const present = new Set(list.map(entry => entry.key))
  let after = -1
  for (const entry of before) {
    if (present.has(entry.key)) {
      after = list.findIndex(other => other.key === entry.key)
      continue
    }
    const until = entry.leaving ? entry.until : now + ms
    if (until <= now) continue
    after += 1
    list.splice(after, 0, { key: entry.key, item: entry.item, leaving: true, until })
  }
  return list
}

/**
 * One value on a damped spring, stepped by the time each frame took. A new target keeps
 * the speed the value has, so it turns round instead of starting over.
 * @param {{stiffness: number, damping: number}} curve - a spring of motion.js
 * @param {{rest?: number, restSpeed?: number}} [settle] - how near and how slow counts as there
 */
export function createSpring({ stiffness, damping }, { rest = 0.05, restSpeed = 1 } = {}) {
  const spring = {
    value: 0, velocity: 0, target: 0,
    get moving() { return spring.value !== spring.target || spring.velocity !== 0 },
    jump(to) { Object.assign(spring, { value: to, velocity: 0, target: to }) },
    /** @param {number} seconds @returns {boolean} whether it still moves */
    step(seconds) {
      const steps = Math.max(1, Math.ceil(seconds * 240))
      const h = seconds / steps
      for (let index = 0; index < steps; index += 1) {
        spring.velocity += (-stiffness * (spring.value - spring.target) - damping * spring.velocity) * h
        spring.value += spring.velocity * h
      }
      if (Math.abs(spring.value - spring.target) < rest && Math.abs(spring.velocity) < restSpeed) spring.jump(spring.target)
      return spring.moving
    },
  }
  return spring
}

const FACE = '.bt-mw-face[data-bot]'

/**
 * Where the capsule's avatars and words stand in it, and a slide for each one that a
 * change of the team moved, from where it stood to where it stands now.
 * @param {Element} summary
 * @param {Map<string, number> | null} before - what the last call returned
 * @param {{duration: number, easing: string} | null} shape - null places without motion
 */
export function slideSeats(summary, before, shape) {
  const places = new Map()
  for (const node of summary.querySelectorAll(`.bt-mw-label,${FACE}:not([data-leaving])`)) {
    const name = node.dataset.bot ?? ''
    const left = node.offsetLeft
    places.set(name, left)
    const was = before?.get(name)
    if (shape && was !== undefined && Math.abs(was - left) > 0.5) node.animate?.([{ translate: `${was - left}px 0` }, { translate: '0 0' }], { duration: shape.duration, easing: shape.easing })
  }
  return places
}

/**
 * Drives one capsule. `attach` takes its nodes once they are in the page, `toggle` sends
 * it to the bubble or back, `detach` lets go of them.
 *
 * The capsule's own width follows its summary on a second spring, so a longer line or one
 * more avatar widens it without a step; the bubble's width and height are read each frame
 * from the rows as they are laid out, so a row that opens or closes takes the surface
 * along. While the surface is on its way the shell carries `data-flight`: the summary's
 * avatars are hidden and each row's avatar is drawn in their place, on its way to its row.
 * @param {{shape: {stiffness: number, damping: number}, still?: () => boolean,
 *   frame?: (run: (now: number) => void) => unknown, unframe?: (id: unknown) => void, now?: () => number,
 *   observe?: (nodes: Element[], run: (entries: {target: Element, borderBoxSize?: {inlineSize: number}[]}[]) => void) => () => void}} env
 *   `shape` is the spring; `still` answers whether motion is off; the rest are the
 *   browser's clock and size observer, swapped in tests.
 */
export function createDockMotion(env) {
  const {
    shape, still = () => false,
    frame = run => requestAnimationFrame(run), unframe = id => cancelAnimationFrame(id), now = () => performance.now(),
    observe = (nodes, run) => {
      if (typeof ResizeObserver !== 'function') return () => {}
      const observer = new ResizeObserver(run)
      for (const node of nodes) observer.observe(node)
      return () => observer.disconnect()
    },
  } = env
  const open = createSpring(shape, { rest: 0.001, restSpeed: 0.02 })
  const pill = createSpring(shape)
  let nodes = null
  let unobserve = null
  let tick = null
  let last = 0
  let flying = false
  let sized = false

  // Each row's avatar on its way between its seat and its row. The capsule's words and
  // the first row's (`data-lead`: the same Bot and the same words) keep one place
  // between the two, so one line turns into the other; without such a row the
  // capsule's words go with the first avatar.
  function place(p) {
    const { summary, panel } = nodes
    const label = summary.querySelector('.bt-mw-label')
    const lead = panel.querySelector('.bt-team-row[data-lead]:not([data-leaving]) .bt-team-text')
    // The row's clock stays at the row's end, where the surface uncovers it.
    const clock = lead?.querySelector('.bt-team-time')
    const slots = [...panel.querySelectorAll(FACE)]
    for (const node of [...slots, label, lead, clock]) if (node) node.style.transform = ''
    if (!flying) {
      for (const slot of slots) slot.style.opacity = ''
      return
    }
    const seats = new Map([...summary.querySelectorAll(`${FACE}:not([data-leaving])`)].map(seat => [seat.dataset.bot, seat]))
    const pairs = slots.map((slot) => {
      const seat = slot.closest('[data-leaving]') ? undefined : seats.get(slot.dataset.bot)
      return { slot, from: seat?.getBoundingClientRect(), to: seat ? slot.getBoundingClientRect() : undefined }
    })
    const words = label && lead ? [label.getBoundingClientRect(), lead.getBoundingClientRect()] : null
    let ride = null
    for (const { slot, from, to } of pairs) {
      // A row past the capsule's avatars has no seat to come from: it clears in place.
      if (!from) {
        slot.style.opacity = String(round(clamp(p)))
        continue
      }
      const move = faceTravel(from, to, p)
      slot.style.opacity = ''
      slot.style.transform = `translate(${round(move.x)}px,${round(move.y)}px)${Math.abs(move.scale - 1) > 0.001 ? ` scale(${round(move.scale, 4)})` : ''}`
      ride ??= { x: to.left - from.left, y: to.top - from.top }
    }
    if (words) {
      const [from, to] = words
      ride = { x: to.left - from.left, y: to.top + to.height / 2 - from.top - from.height / 2 }
      const back = { x: round(-ride.x * (1 - p)), y: round(-ride.y * (1 - p)) }
      lead.style.transform = `translate(${back.x}px,${back.y}px)`
      if (clock) clock.style.transform = `translate(${-back.x}px,${-back.y}px)`
    }
    if (label && ride) label.style.transform = `translate(${round(ride.x * p)}px,${round(ride.y * p)}px)`
  }

  function paint() {
    const { shell, reveal, panel } = nodes
    const p = open.value
    const capsule = { width: pill.value, ...PILL }
    // The closed capsule never reads the rows' layout.
    const bubble = p === 0 ? capsule : { width: reveal.offsetWidth, height: panel.offsetHeight, radius: BUBBLE_RADIUS }
    const box = dockShape(capsule, bubble, p)
    shell.style.width = `${round(box.width)}px`
    shell.style.height = `${round(box.height)}px`
    shell.style.setProperty('--bt-team-radius', `${round(box.radius)}px`)
    shell.style.setProperty('--bt-team-p', String(round(p, 4)))
    // The summary keeps the capsule's place in the middle of the surface.
    shell.style.setProperty('--bt-team-pill', `${round(pill.value)}px`)
    place(p)
  }

  function land() {
    flying = false
    delete nodes.shell.dataset.flight
    if (open.target === 0) nodes.panel.scrollTop = 0
    paint()
  }

  function step(time) {
    tick = null
    if (!nodes) return
    const seconds = Math.min(0.5, Math.max(0.001, (time - last) / 1000))
    last = time
    const moving = [open.step(seconds), pill.step(seconds)].some(Boolean)
    if (flying && !open.moving) land()
    else paint()
    if (moving) tick = frame(step)
  }

  function run() {
    if (tick !== null) return
    last = now()
    tick = frame(step)
  }

  function resized(entries = []) {
    if (!nodes) return
    let width = pill.target
    for (const entry of entries) {
      if (entry.target === nodes.summary) width = entry.borderBoxSize?.[0]?.inlineSize ?? nodes.summary.offsetWidth
    }
    if (!sized || still()) pill.jump(width)
    else if (width !== pill.target) {
      pill.target = width
      run()
    }
    sized = true
    paint()
  }

  return {
    /** @param {{shell: HTMLElement, summary: HTMLElement, reveal: HTMLElement, panel: HTMLElement}} given */
    attach(given) {
      nodes = given
      sized = false
      flying = false
      open.jump(open.target)
      pill.jump(nodes.summary.offsetWidth)
      paint()
      unobserve = observe([nodes.summary, nodes.reveal, nodes.panel], resized)
    },
    detach() {
      if (tick !== null) unframe(tick)
      tick = null
      unobserve?.()
      unobserve = null
      if (nodes) delete nodes.shell.dataset.flight
      nodes = null
      flying = false
    },
    /** @param {boolean} wanted - true for the bubble */
    toggle(wanted) {
      const to = wanted ? 1 : 0
      if (open.target === to) return
      if (!nodes || still()) {
        open.jump(to)
        if (nodes) land()
        return
      }
      open.target = to
      flying = true
      nodes.shell.dataset.flight = ''
      paint()
      run()
    },
    /** 0 the capsule, 1 the bubble, as drawn now. */
    progress: () => open.value,
    flying: () => flying,
  }
}
