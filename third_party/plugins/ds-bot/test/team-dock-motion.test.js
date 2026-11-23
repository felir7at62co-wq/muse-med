import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUBBLE_RADIUS, PILL, createDockMotion, createSpring, dockShape, faceTravel, slideSeats, withLeaving } from '../src/client/team-dock-motion.js'
import { RADII } from '../scripts/style-debt.mjs'

// jsdom comes from the harness that test/harness-resolve.mjs found, like the dsh packages.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness'), 'package.json'))('jsdom')

// motion.js's SPRING_SHAPE (ω=20, ζ=0.78).
const SHAPE = { stiffness: 400, damping: 31.2, duration: 430, easing: 'linear(0,1)' }
const box = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height })

// The Main Bot's team capsule opens into one bubble. These pin how it gets there: where the
// surface and each avatar are on the way, that a turn round goes on from there, and that
// nothing of the flight is left on the page afterwards.
test('the surface goes from the capsule to the bubble, corners on the radius steps', () => {
  const pill = { width: 200, ...PILL }
  const bubble = { width: 360, height: 98, radius: BUBBLE_RADIUS }
  assert.deepEqual(dockShape(pill, bubble, 0), { width: 200, height: 32, radius: 16 })
  assert.deepEqual(dockShape(pill, bubble, 1), { width: 360, height: 98, radius: 18 })
  assert.deepEqual(dockShape(pill, bubble, 0.5), { width: 280, height: 65, radius: 17 })
  // A spring may pass the bubble a little before it settles.
  assert.equal(dockShape(pill, bubble, 1.02).height > 98, true)
  for (const radius of [PILL.radius, BUBBLE_RADIUS]) assert.equal(RADII.includes(`${radius}px`), true)
})

test('an avatar starts on its seat in the capsule and ends in its row', () => {
  const seat = box(121, 86, 20, 20)
  const slot = box(36, 76, 20, 20)
  assert.deepEqual(faceTravel(seat, slot, 0), { x: 85, y: 10, scale: 1 })
  assert.deepEqual(faceTravel(seat, slot, 1), { x: 0, y: 0, scale: 1 })
  assert.deepEqual(faceTravel(seat, slot, 0.5), { x: 42.5, y: 5, scale: 1 })
  // An avatar drawn larger in its row grows on the way.
  assert.deepEqual(faceTravel(seat, box(36, 76, 25, 25), 0), { x: 85, y: 10, scale: 0.8 })
  assert.equal(faceTravel(seat, box(36, 76, 25, 25), 1).scale, 1)
  assert.equal(faceTravel(seat, box(0, 0, 0, 0), 0.3).scale, 1)
})

test('an entry that left stays where it stood until its exit is over', () => {
  const keyOf = item => item.id
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(id => ({ id }))
  const first = withLeaving([], [a, b, c], keyOf, 1000, 400)
  assert.deepEqual(first.map(entry => [entry.key, entry.leaving]), [['a', false], ['b', false], ['c', false]])
  // b leaves and d joins: b keeps its place between a and c.
  const second = withLeaving(first, [a, c, d], keyOf, 2000, 400)
  assert.deepEqual(second.map(entry => [entry.key, entry.leaving, entry.until]), [['a', false, 0], ['b', true, 2400], ['c', false, 0], ['d', false, 0]])
  // Drawn again meanwhile, it keeps its own deadline; after it, it is gone.
  assert.deepEqual(withLeaving(second, [a, c, d], keyOf, 2300, 400).map(entry => [entry.key, entry.until]), [['a', 0], ['b', 2400], ['c', 0], ['d', 0]])
  assert.deepEqual(withLeaving(second, [a, c, d], keyOf, 2400, 400).map(entry => entry.key), ['a', 'c', 'd'])
  // The first one leaving stays in front; one that comes back is drawn as present again.
  assert.deepEqual(withLeaving(first, [b, c], keyOf, 2000, 400).map(entry => [entry.key, entry.leaving]), [['a', true], ['b', false], ['c', false]])
  assert.deepEqual(withLeaving(second, [a, b, c], keyOf, 2100, 400).map(entry => [entry.key, entry.leaving]), [['a', false], ['b', false], ['c', false], ['d', true]])
  // With motion off (no time for an exit) nothing is kept.
  assert.deepEqual(withLeaving(first, [a], keyOf, 2000, 0).map(entry => entry.key), ['a'])
})

test('the spring settles on its target without a visible bounce, and a new target keeps its speed', () => {
  const spring = createSpring(SHAPE, { rest: 0.001, restSpeed: 0.02 })
  spring.target = 1
  let peak = 0
  let frames = 0
  while (spring.step(1 / 60)) {
    peak = Math.max(peak, spring.value)
    frames += 1
    assert.equal(frames < 60, true, 'the spring settles within a second')
  }
  assert.equal(spring.value, 1)
  assert.equal(spring.velocity, 0)
  assert.equal(peak < 1.03, true, `passes its target by ${peak - 1}`)
  // Settled by about 0.4 s.
  assert.equal(frames >= 18 && frames <= 30, true, `${frames} frames`)
  // Sent back mid-way, it goes on a little the way it was going before it turns.
  spring.jump(0)
  spring.target = 1
  for (let index = 0; index < 5; index += 1) spring.step(1 / 60)
  const [value, velocity] = [spring.value, spring.velocity]
  spring.target = 0
  spring.step(1 / 60)
  assert.equal(velocity > 0 && spring.value > value, true)
  assert.equal(spring.velocity < velocity, true)
  assert.equal(Math.abs(spring.value - value) < 0.1, true)
})

// A page with the dock's markup, where every box is given: jsdom lays nothing out.
function dockPage({ rows = ['a', 'b'], lead = true, seats = rows } = {}) {
  const { document } = new JSDOM(`<!doctype html><body><div class="bt-team-shell">
    <button class="bt-team-toggle"><span class="bt-team-summary">
      <span class="bt-mw-faces">${seats.map(id => `<span class="bt-mw-face" data-bot="${id}"></span>`).join('')}</span>
      <span class="bt-mw-label"><span class="bt-mw-doing">A · working…</span><span class="bt-team-more">+1</span></span></span></button>
    <div class="bt-team-reveal"><div class="bt-team-panel">${rows.map((id, index) => `<div class="bt-team-row"${lead && index === 0 ? ' data-lead' : ''}>
      <button class="bt-team-work"><span class="bt-mw-face" data-bot="${id}"></span><span class="bt-team-text"><strong>${id}</strong><span class="bt-team-time">· 1s</span></span></button></div>`).join('')}</div></div>
  </div></body>`).window
  const find = selector => document.querySelector(selector)
  const give = (node, rect, size = {}) => {
    node.getBoundingClientRect = () => rect
    for (const [name, value] of Object.entries(size)) Object.defineProperty(node, name, { value, configurable: true, writable: true })
  }
  const nodes = { shell: find('.bt-team-shell'), summary: find('.bt-team-summary'), reveal: find('.bt-team-reveal'), panel: find('.bt-team-panel') }
  give(nodes.summary, box(100, 80, 200, 32), { offsetWidth: 200 })
  give(nodes.reveal, box(20, 14, 360, 98), { offsetWidth: 360 })
  give(nodes.panel, box(20, 14, 360, 98), { offsetHeight: 98, scrollTop: 40 })
  give(find('.bt-mw-label'), box(149, 87, 120, 18))
  // Seats sit 15 px apart in the capsule; each row's avatar sits 46 px under the last.
  document.querySelectorAll('.bt-team-summary .bt-mw-face').forEach((seat, index) => give(seat, box(106 + index * 15, 86, 20, 20), { offsetLeft: index * 15 }))
  document.querySelectorAll('.bt-team-panel .bt-mw-face').forEach((slot, index) => give(slot, box(36, 30 + index * 46, 20, 20)))
  document.querySelectorAll('.bt-team-text').forEach((text, index) => give(text, box(66, 18 + index * 46, 260, 44)))
  return { document, nodes, find }
}

// The browser's frames and size observer, run by hand.
function byHand({ still = false } = {}) {
  const queue = []
  let time = 1000
  let resize = null
  const env = {
    shape: SHAPE, still: () => still,
    frame: (run) => { queue.push(run); return run },
    unframe: (run) => { const at = queue.indexOf(run); if (at >= 0) queue.splice(at, 1) },
    now: () => time,
    observe: (nodes, run) => { resize = run; return () => { resize = null } },
  }
  return {
    env, pending: () => queue.length,
    // One display frame, 1/60 s after the last.
    frame() { time += 1000 / 60; for (const run of queue.splice(0)) run(time) },
    resize: entries => resize(entries),
    observing: () => resize !== null,
  }
}

const translateOf = (node) => {
  const match = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(node.style.transform)
  return match ? [Number(match[1]), Number(match[2])] : null
}
const number = text => Number.parseFloat(text)

test('opening carries the surface, each avatar and the words from the capsule to the bubble', () => {
  const page = dockPage()
  const hand = byHand()
  const motion = createDockMotion(hand.env)
  motion.attach(page.nodes)
  const { shell } = page.nodes
  assert.equal(shell.style.width, '200px')
  assert.equal(shell.style.height, '32px')
  assert.equal(shell.style.getPropertyValue('--bt-team-radius'), '16px')
  assert.equal(shell.dataset.flight, undefined)
  assert.equal(hand.observing(), true)

  motion.toggle(true)
  // The first frame of the flight looks like the capsule: each row's avatar is on its seat.
  assert.equal(shell.dataset.flight, '')
  assert.equal(shell.style.width, '200px')
  const [first, second] = [...page.document.querySelectorAll('.bt-team-panel .bt-mw-face')]
  assert.deepEqual(translateOf(first), [70, 56])
  assert.deepEqual(translateOf(second), [85, 10])
  // The first row's words stand on the capsule's words (same left edge, same middle line).
  const lead = page.find('.bt-team-row[data-lead] .bt-team-text')
  assert.deepEqual(translateOf(lead), [83, 56])
  // Its clock stays at the row's end.
  assert.deepEqual(translateOf(page.find('.bt-team-row[data-lead] .bt-team-time')), [-83, -56])

  let before = { width: 200, height: 32, x: 70 }
  let frames = 0
  while (hand.pending()) {
    hand.frame()
    frames += 1
    const now = { width: number(shell.style.width), height: number(shell.style.height), x: translateOf(first)?.[0] ?? 0 }
    // No frame moves the surface or an avatar by more than a small step.
    assert.equal(Math.abs(now.width - before.width) < 30, true, `width stepped ${now.width - before.width}`)
    assert.equal(Math.abs(now.x - before.x) < 14, true, `avatar stepped ${now.x - before.x}`)
    if (frames === 4) {
      // Mid-way everything is between its two places, by the same share.
      const p = Number(shell.style.getPropertyValue('--bt-team-p'))
      assert.equal(p > 0.15 && p < 0.6, true)
      assert.equal(Math.abs(now.width - (200 + 160 * p)) < 0.02, true)
      assert.equal(Math.abs(now.height - (32 + 66 * p)) < 0.02, true)
      assert.equal(Math.abs(now.x - 70 * (1 - p)) < 0.02, true)
      assert.equal(Math.abs(translateOf(page.find('.bt-mw-label'))[0] - -83 * p) < 0.02, true)
    }
    before = now
    assert.equal(frames < 60, true)
  }
  // Landed: the bubble's own box, and nothing of the flight left on the page.
  assert.equal(shell.style.width, '360px')
  assert.equal(shell.style.height, '98px')
  assert.equal(shell.style.getPropertyValue('--bt-team-radius'), '18px')
  assert.equal(shell.style.getPropertyValue('--bt-team-p'), '1')
  assert.equal(shell.dataset.flight, undefined)
  for (const node of page.document.querySelectorAll('.bt-mw-face,.bt-mw-label,.bt-team-text,.bt-team-time')) assert.equal(node.style.transform, '')
  assert.equal(motion.flying(), false)
})

test('a second press mid-way turns the surface round from where it is', () => {
  const page = dockPage()
  const hand = byHand()
  const motion = createDockMotion(hand.env)
  motion.attach(page.nodes)
  const { shell, panel } = page.nodes
  motion.toggle(true)
  for (let index = 0; index < 5; index += 1) hand.frame()
  const turned = number(shell.style.width)
  assert.equal(turned > 230 && turned < 340, true)
  motion.toggle(false)
  // The press itself moves nothing.
  assert.equal(number(shell.style.width), turned)
  assert.equal(shell.dataset.flight, '')
  hand.frame()
  // It still carries its speed: one more frame goes on a little, then it comes back.
  assert.equal(number(shell.style.width) > turned, true)
  assert.equal(number(shell.style.width) - turned < 20, true)
  let widest = 0
  while (hand.pending()) {
    hand.frame()
    widest = Math.max(widest, number(shell.style.width))
  }
  assert.equal(widest < 360, true)
  assert.equal(shell.style.width, '200px')
  assert.equal(shell.style.height, '32px')
  assert.equal(shell.dataset.flight, undefined)
  // The closed capsule starts its next opening from the top of the list.
  assert.equal(panel.scrollTop, 0)
})

test('a row past the capsule\'s avatars clears in place, and a row that is leaving stays out of the flight', () => {
  const page = dockPage({ rows: ['a', 'b', 'c'], seats: ['a', 'b'], lead: false })
  page.document.querySelectorAll('.bt-team-row')[1].setAttribute('data-leaving', '')
  const hand = byHand()
  const motion = createDockMotion(hand.env)
  motion.attach(page.nodes)
  motion.toggle(true)
  for (let index = 0; index < 4; index += 1) hand.frame()
  const [first, second, third] = [...page.document.querySelectorAll('.bt-team-panel .bt-mw-face')]
  assert.notEqual(translateOf(first), null)
  for (const face of [second, third]) {
    assert.equal(face.style.transform, '')
    assert.equal(Number(face.style.opacity) > 0 && Number(face.style.opacity) < 1, true)
  }
  // Without a row that takes the capsule's words over, they go with the first avatar.
  const p = Number(page.nodes.shell.style.getPropertyValue('--bt-team-p'))
  assert.equal(Math.abs(translateOf(page.find('.bt-mw-label'))[0] - -70 * p) < 0.02, true)
  while (hand.pending()) hand.frame()
  for (const face of [first, second, third]) assert.equal(face.style.opacity, '')
})

test('the capsule widens with its summary on the spring, and the bubble follows its rows at once', () => {
  const page = dockPage()
  const hand = byHand()
  const motion = createDockMotion(hand.env)
  motion.attach(page.nodes)
  const { shell, summary, panel } = page.nodes
  // The first measure places it; later ones move it.
  hand.resize([{ target: summary, borderBoxSize: [{ inlineSize: 199.6 }] }])
  assert.equal(shell.style.width, '199.6px')
  assert.equal(shell.style.getPropertyValue('--bt-team-pill'), '199.6px')
  hand.resize([{ target: summary, borderBoxSize: [{ inlineSize: 235 }] }])
  assert.equal(shell.style.width, '199.6px')
  hand.frame()
  assert.equal(number(shell.style.width) > 199.6 && number(shell.style.width) < 235, true)
  while (hand.pending()) hand.frame()
  assert.equal(shell.style.width, '235px')
  assert.equal(shell.dataset.flight, undefined)
  // Open, a row that grows takes the surface along in the same frame.
  motion.toggle(true)
  while (hand.pending()) hand.frame()
  Object.defineProperty(panel, 'offsetHeight', { value: 121, configurable: true })
  hand.resize([{ target: panel }])
  assert.equal(shell.style.height, '121px')
})

test('with effects reduced or off the capsule changes at once, with no flight', () => {
  const page = dockPage()
  const hand = byHand({ still: true })
  const motion = createDockMotion(hand.env)
  motion.attach(page.nodes)
  const { shell } = page.nodes
  motion.toggle(true)
  assert.equal(shell.style.width, '360px')
  assert.equal(shell.style.height, '98px')
  assert.equal(shell.dataset.flight, undefined)
  assert.equal(hand.pending(), 0)
  for (const node of page.document.querySelectorAll('.bt-mw-face,.bt-mw-label,.bt-team-text')) assert.equal(node.style.transform, '')
  motion.toggle(false)
  assert.equal(shell.style.width, '200px')
  assert.equal(hand.pending(), 0)
  // A wider summary is taken at once too.
  hand.resize([{ target: page.nodes.summary, borderBoxSize: [{ inlineSize: 180 }] }])
  hand.resize([{ target: page.nodes.summary, borderBoxSize: [{ inlineSize: 240 }] }])
  assert.equal(shell.style.width, '240px')
  assert.equal(hand.pending(), 0)
})

test('letting go of the capsule stops its frames and its observer', () => {
  const page = dockPage()
  const hand = byHand()
  const motion = createDockMotion(hand.env)
  motion.attach(page.nodes)
  motion.toggle(true)
  hand.frame()
  assert.equal(hand.pending(), 1)
  motion.detach()
  assert.equal(hand.pending(), 0)
  assert.equal(hand.observing(), false)
  assert.equal(page.nodes.shell.dataset.flight, undefined)
})

test('one avatar more or fewer slides the others and the words to their new places', () => {
  const page = dockPage({ rows: ['a', 'b'] })
  const { summary } = page.nodes
  const slides = []
  const label = page.find('.bt-mw-label')
  Object.defineProperty(label, 'offsetLeft', { value: 43, configurable: true })
  for (const node of summary.querySelectorAll('.bt-mw-label,.bt-mw-face')) node.animate = (frames, timing) => slides.push([node.dataset.bot ?? 'label', frames[0].translate, timing.duration])
  const places = slideSeats(summary, null, SHAPE)
  assert.deepEqual([...places], [['a', 0], ['b', 15], ['', 43]])
  assert.deepEqual(slides, [])
  // The first avatar left: the second and the words move 15 px to the left, from where they stood.
  const [gone, stays] = [...summary.querySelectorAll('.bt-mw-face')]
  gone.setAttribute('data-leaving', '')
  Object.defineProperty(stays, 'offsetLeft', { value: 0, configurable: true })
  Object.defineProperty(label, 'offsetLeft', { value: 28, configurable: true })
  const after = slideSeats(summary, places, SHAPE)
  assert.deepEqual([...after], [['b', 0], ['', 28]])
  assert.deepEqual(slides, [['b', '15px 0', 430], ['label', '15px 0', 430]])
  // With motion off they are placed without a slide.
  slides.length = 0
  Object.defineProperty(label, 'offsetLeft', { value: 43, configurable: true })
  slideSeats(summary, after, null)
  assert.deepEqual(slides, [])
})
