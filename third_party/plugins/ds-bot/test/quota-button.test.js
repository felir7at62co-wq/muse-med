import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { createSource } from '../src/client/sources.js'

// The quota button and its Jingliu read, bundled once and run with a stateful stand-in React
// (useState/useRef slots persist across renders; effects run after each render, cleaning up first
// when their dependencies change; refs attach to stand-in elements), stand-in timers, clock and
// listeners, so a test drives the read loop and the popover by hand.
const { outputFiles } = await build({
  stdin: {
    contents: "export { QuotaButton, installQuota, QUOTA_INJECT, QUOTA_REFRESH_MS, QUOTA_HIDDEN_REFRESH_MS } from './src/client/quota.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const slots = []
let cursor = 0
const layoutEffects = []
const passiveEffects = []
const effect = queue => (run, deps) => {
  const i = cursor++
  if (slots[i] === undefined) slots[i] = { deps: undefined, ran: false, cleanup: undefined }
  const slot = slots[i]
  if (slot.ran && deps !== undefined && deps.length === slot.deps.length && deps.every((dep, k) => Object.is(dep, slot.deps[k]))) return
  slot.ran = true
  slot.deps = deps
  queue.push(() => {
    if (typeof slot.cleanup === 'function') slot.cleanup()
    slot.cleanup = run()
  })
}
const react = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useCallback: fn => fn,
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
  useState(initial) {
    const i = cursor++
    if (slots[i] === undefined) slots[i] = { v: typeof initial === 'function' ? initial() : initial }
    const slot = slots[i]
    return [slot.v, v => { slot.v = typeof v === 'function' ? v(slot.v) : v }]
  },
  useRef(initial) { const i = cursor++; if (slots[i] === undefined) slots[i] = { current: initial }; return slots[i] },
  useMemo: make => make(), useEffect: effect(passiveEffects), useLayoutEffect: effect(layoutEffects),
  useSyncExternalStore: (subscribe, get) => get(), useId: () => 'id',
}
// Each element with a ref gets one of these, matched by class name; `focused` lists what took focus.
const focused = []
class FakeElement {
  constructor(className = '') { this.className = className }
  closest(selector) { return this.className.split(' ').includes(selector.replace(/^\./, '')) ? this : null }
  contains(target) { return target === this }
  focus() { focused.push(this.className) }
  getBoundingClientRect() { return { left: 170, top: 700, right: 206, bottom: 736 } }
}
const listening = () => {
  const map = new Map()
  return {
    map,
    addEventListener(name, run) { if (!map.has(name)) map.set(name, new Set()); map.get(name).add(run) },
    removeEventListener(name, run) { map.get(name)?.delete(run) },
  }
}
const fire = (target, name, event) => { for (const run of [...(target.map.get(name) ?? [])]) run(event) }
const win = listening()
const page = { hidden: false, body: {}, ...listening() }
// Pending timers by id; the quota read's are the long ones, `useLinger`'s the short ones.
const timers = new Map()
let timerSeq = 0
let now = 1_000_000
class FakeDate extends Date { static now() { return now } }
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, AbortController, Element: FakeElement, Date: FakeDate,
  window: { innerHeight: 800, innerWidth: 1200, addEventListener: win.addEventListener, removeEventListener: win.removeEventListener },
  document: page,
  setTimeout: (run, ms) => {
    const id = ++timerSeq
    timers.set(id, { ms, run: () => { timers.delete(id); run() } })
    return id
  },
  clearTimeout: id => timers.delete(id),
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
})
const { QuotaButton, installQuota, QUOTA_INJECT, QUOTA_REFRESH_MS, QUOTA_HIDDEN_REFRESH_MS } = module.exports

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const walk = (node, match, out = []) => {
  if (Array.isArray(node)) { node.forEach(child => walk(child, match, out)); return out }
  if (!node || typeof node !== 'object') return out
  if (match(node)) out.push(node)
  walk(node.props?.children, match, out)
  return out
}
const textOf = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}
const byClass = (tree, name) => walk(tree, node => node.props?.className === name)
const ok = value => ({ ok: true, value })
const failed = code => ({ ok: false, error: { code, message: '请先在 Muse 的账号设置中登录。', details: {} } })
const MENU = 'bt-menu bt-menu-up bt-quota-menu'
// The one scheduled quota read: an earlier one left pending would make two.
const readTimer = () => {
  const pending = [...timers.values()].filter(timer => timer.ms >= 1000)
  assert.equal(pending.length, 1)
  return pending[0]
}
const runLinger = () => { for (const timer of [...timers.values()]) if (timer.ms < 1000) timer.run() }

// A client whose Jingliu namespace mounts on `mount()`: each `balance` call answers with the next
// entry of `answers` (a result, or a function of the signal returning one), the last one repeating.
function client(answers = [ok({ unlimited: false, available: '88.50', usedFen: 1150, heldFen: 300 })], actions = {}) {
  slots.length = 0
  timers.clear()
  win.map.clear()
  page.map.clear()
  page.hidden = false
  focused.length = 0
  const injected = []
  const signals = []
  const remoteEvents = new Map()
  const events = new Map()
  const disposers = []
  let callback = null
  let attached = new Set()
  const scope = {
    remote: {
      jingliuConnection: {
        balance: (signal) => {
          signals.push(signal)
          const answer = answers[Math.min(signals.length, answers.length) - 1]
          return typeof answer === 'function' ? answer(signal) : Promise.resolve(answer)
        },
      },
      $on: (name, listener) => { remoteEvents.set(name, listener); return () => remoteEvents.delete(name) },
    },
    on: (name, listener) => { events.set(name, listener); return () => events.delete(name) },
    effect: (make) => { disposers.push(make()) },
  }
  const ui = createSource({ details: null })
  installQuota({ inject: (names, run) => { injected.push(names); callback = run } }, { ui, actions })
  const props = { actions, useUi: select => select(ui.getSnapshot()) }
  // Renders, attaches refs (a ref whose element left the tree goes back to null), then runs effects.
  const render = () => {
    cursor = 0
    const tree = QuotaButton(props)
    const seen = new Set()
    for (const node of walk(tree, node => node.props?.ref !== undefined)) {
      seen.add(node.props.ref)
      node.props.ref.current ??= new FakeElement(node.props.className)
    }
    for (const ref of attached) if (!seen.has(ref)) ref.current = null
    attached = seen
    for (const queue of [layoutEffects, passiveEffects]) for (const run of queue.splice(0)) run()
    return tree
  }
  const open = () => {
    const [button] = byClass(render(), 'bt-account bt-quota')
    button.props.onClick()
    return render()
  }
  const mount = async () => { callback(scope); await tick() }
  const dispose = () => { for (const off of disposers.splice(0)) off() }
  const show = (hidden) => { page.hidden = hidden; fire(page, 'visibilitychange') }
  return { injected, signals, remoteEvents, events, ui, actions, render, open, mount, dispose, show }
}

test('the quota read lists remote with the Jingliu namespace, so the real app runs it', () => {
  const side = client()
  // Spread: the lists come from the bundle's own realm.
  assert.deepEqual(side.injected.map(names => [...names]), [['remote', 'remote.jingliuConnection']])
  assert.deepEqual([...QUOTA_INJECT], ['remote', 'remote.jingliuConnection'])
})

test('no button renders without the Jingliu remote, nor once it goes away', async () => {
  const side = client()
  assert.equal(side.render(), null)
  await side.mount()
  assert.ok(side.render() !== null)
  side.dispose()
  assert.equal(side.ui.getSnapshot().quota, undefined)
  assert.equal(side.actions.refreshQuota, undefined)
  assert.equal(side.render(), null)
  assert.equal(page.map.get('visibilitychange').size, 0)
})

test('a Host without the Jingliu service keeps the button out', async () => {
  for (const code of ['gateway/invocation-unavailable', 'gateway/service-unavailable', 'gateway/method-unavailable', 'gateway/definition-unavailable']) {
    const side = client([failed(code)])
    await side.mount()
    assert.equal(side.render(), null, code)
  }
})

test('the button comes in only once a read says the Host serves Jingliu, and rereads never bring it back without', async () => {
  let first
  let later
  const side = client([
    () => new Promise((resolve) => { first = resolve }),
    failed('gateway/service-unavailable'),
    () => new Promise((resolve) => { later = resolve }),
  ])
  await side.mount()
  // No grey coin while the first read is out.
  assert.equal(side.ui.getSnapshot().quota, undefined)
  assert.equal(side.render(), null)
  first(failed('gateway/service-unavailable'))
  await tick()
  assert.equal(side.ui.getSnapshot().quota.state, 'absent')
  side.remoteEvents.get('muse-account/session-changed')()
  assert.equal(side.render(), null)
  await tick()
  assert.equal(side.signals.length, 2)
  assert.equal(side.render(), null)
  side.events.get('connection/reset')()
  assert.equal(side.render(), null)
  await tick()
  assert.equal(side.signals.length, 3)
  assert.equal(side.render(), null)
  // A Host that serves it after the reconnect brings the button in.
  later(ok({ unlimited: false, available: '7', usedFen: 0, heldFen: 0 }))
  await tick()
  assert.equal(byClass(side.render(), 'bt-account bt-quota')[0].props['data-state'], 'known')
})

test('an unlimited account shows Unlimited with what was used and held', async () => {
  const side = client([ok({ unlimited: true, available: '0', usedFen: 1234, heldFen: 0 })])
  await side.mount()
  const tree = side.open()
  const [button] = byClass(tree, 'bt-account bt-quota')
  assert.equal(button.props['data-state'], 'unlimited')
  assert.equal(button.props['aria-label'], 'Quota: Unlimited')
  assert.equal(button.props.title, 'Quota')
  assert.equal(textOf(byClass(tree, 'bt-quota-figure')), 'Unlimited')
  assert.equal(textOf(byClass(tree, 'bt-quota-rows')), 'Used¥12.34On hold¥0.00')
  assert.equal(byClass(tree, 'bt-quota-dot').length, 0)
  assert.equal(byClass(tree, 'bt-quota-stop').length, 0)
})

test('a positive balance is the main figure, with used and held below', async () => {
  const side = client([ok({ unlimited: false, available: '88.5', usedFen: 1150, heldFen: 300 })])
  await side.mount()
  const tree = side.open()
  const [menu] = byClass(tree, MENU)
  assert.equal(menu.props.role, 'dialog')
  assert.equal(menu.props.style.left, 170)
  assert.equal(menu.props.style.bottom, 800 - 700 + 5)
  const [button] = byClass(tree, 'bt-account bt-quota')
  assert.equal(button.props['data-state'], 'known')
  // The figure is spoken with the name, without opening the popover; the tooltip is the name.
  assert.equal(button.props['aria-label'], 'Quota: ¥88.50')
  assert.equal(button.props.title, 'Quota')
  assert.equal(textOf(byClass(tree, 'bt-quota-figure')), '¥88.50')
  assert.equal(textOf(byClass(tree, 'bt-quota-rows')), 'Used¥11.50On hold¥3.00')
  assert.equal(byClass(tree, 'bt-quota-dot').length, 0)
  assert.equal(byClass(tree, 'bt-quota-stop').length, 0)
})

test('a used-up balance marks the button and says generation has stopped', async () => {
  for (const [available, figure] of [['0.00', '¥0.00'], ['-1.5', '-¥1.50']]) {
    const side = client([ok({ unlimited: false, available, usedFen: 50000, heldFen: 0, enforced: true })])
    await side.mount()
    const [button] = byClass(side.render(), 'bt-account bt-quota')
    assert.equal(button.props['data-state'], 'exhausted')
    assert.equal(button.props['aria-label'], 'Quota used up')
    assert.equal(button.props.title, 'Quota used up')
    assert.equal(byClass(button, 'bt-quota-dot').length, 1)
    const tree = side.open()
    assert.equal(textOf(byClass(tree, 'bt-quota-figure')), figure)
    assert.equal(textOf(byClass(tree, 'bt-quota-stop')), 'Quota used up. Generation has stopped; ask your team lead to grant more.')
  }
})

test('a zero balance is not called used up where Jingliu does not stop generation, or does not say', async () => {
  for (const enforced of [false, null, undefined]) {
    const side = client([ok({ unlimited: false, available: '0.00', usedFen: 50000, heldFen: 0, ...(enforced === undefined ? {} : { enforced }) })])
    await side.mount()
    const [button] = byClass(side.render(), 'bt-account bt-quota')
    assert.equal(button.props['data-state'], 'known')
    assert.equal(byClass(button, 'bt-quota-dot').length, 0)
    const tree = side.open()
    assert.equal(textOf(byClass(tree, 'bt-quota-figure')), '¥0.00')
    assert.equal(byClass(tree, 'bt-quota-stop').length, 0)
  }
})

test('the usage button closes the popover and opens Settings at Usage', async () => {
  const opened = []
  const side = client(undefined, { openSettings: (...args) => opened.push(args) })
  await side.mount()
  const [usage] = byClass(side.open(), 'bt-quota-usage')
  assert.equal(textOf(usage), 'Usage')
  usage.props.onClick()
  assert.deepEqual(opened, [['usage']])
  assert.equal(byClass(side.render(), 'bt-account bt-quota')[0].props['aria-expanded'], false)
  runLinger()
  assert.equal(byClass(side.render(), MENU).length, 0)
})

test('opening the popover moves focus into it, and Escape closes it and gives focus back', async () => {
  const side = client()
  await side.mount()
  const tree = side.open()
  const [menu] = byClass(tree, MENU)
  assert.equal(menu.props.tabIndex, -1)
  assert.deepEqual(focused, [MENU])
  // Re-renders while open, as on a resize, leave focus where the user moved it.
  side.render()
  assert.deepEqual(focused, [MENU])
  // Other keys pass through.
  fire(win, 'keydown', { key: 'Tab', stopPropagation() { assert.fail('Tab is not the popover’s') } })
  assert.equal(byClass(side.render(), 'bt-account bt-quota')[0].props['aria-expanded'], true)
  let stopped = false
  fire(win, 'keydown', { key: 'Escape', stopPropagation() { stopped = true } })
  assert.equal(stopped, true)
  assert.deepEqual(focused, [MENU, 'bt-account bt-quota'])
  const closed = side.render()
  assert.equal(byClass(closed, 'bt-account bt-quota')[0].props['aria-expanded'], false)
  assert.equal(byClass(closed, MENU)[0].props['data-leaving'], true)
  assert.equal(win.map.get('keydown').size, 0)
  assert.equal(win.map.get('mousedown').size, 0)
  runLinger()
  assert.equal(byClass(side.render(), MENU).length, 0)
  // Opening again focuses it again.
  side.open()
  assert.deepEqual(focused, [MENU, 'bt-account bt-quota', MENU])
})

test('a press outside the popover closes it, and one inside it or on the button does not', async () => {
  const side = client()
  await side.mount()
  const tree = side.open()
  const [menu] = byClass(tree, MENU)
  const [button] = byClass(tree, 'bt-account bt-quota')
  for (const target of [menu.props.ref.current, button.props.ref.current]) {
    fire(win, 'mousedown', { target })
    assert.equal(byClass(side.render(), 'bt-account bt-quota')[0].props['aria-expanded'], true)
  }
  fire(win, 'mousedown', { target: new FakeElement('bt-list') })
  assert.equal(byClass(side.render(), 'bt-account bt-quota')[0].props['aria-expanded'], false)
})

test('the popover closes when the Jingliu namespace goes away, so it does not come back open', async () => {
  const side = client()
  await side.mount()
  side.open()
  side.dispose()
  assert.equal(side.render(), null)
  assert.equal(side.render(), null)
  runLinger()
  await side.mount()
  const tree = side.render()
  assert.equal(byClass(tree, 'bt-account bt-quota')[0].props['aria-expanded'], false)
  assert.equal(byClass(tree, MENU).length, 0)
})

test('a failed read shows the unknown state and drops the figure it had', async () => {
  const side = client([ok({ unlimited: false, available: '88.50', usedFen: 0, heldFen: 0 }), failed('gateway/internal')])
  await side.mount()
  assert.equal(textOf(byClass(side.open(), 'bt-quota-figure')), '¥88.50')
  await tick()
  const tree = side.render()
  const [button] = byClass(tree, 'bt-account bt-quota')
  assert.equal(button.props['data-state'], 'unknown')
  assert.equal(button.props['aria-label'], 'Quota')
  assert.equal(textOf(byClass(tree, 'bt-quota-figure')), '—')
  assert.equal(textOf(byClass(tree, 'bt-quota-note')), 'Quota not available right now')
  assert.equal(byClass(tree, 'bt-quota-rows').length, 0)
  assert.equal(byClass(tree, 'bt-quota-dot').length, 0)
  // A call that throws and a balance that is no number are unknown too.
  for (const answer of [() => Promise.reject(new Error('client api: jingliuConnection/balance failed')), ok({ unlimited: false, available: 'n/a', usedFen: 0, heldFen: 0 })]) {
    const other = client([answer])
    await other.mount()
    assert.equal(byClass(other.render(), 'bt-account bt-quota')[0].props['data-state'], 'unknown')
  }
})

test('opening the popover reads the balance again', async () => {
  const side = client()
  await side.mount()
  assert.equal(side.signals.length, 1)
  side.open()
  await tick()
  assert.equal(side.signals.length, 2)
})

test('the balance is read every minute, and every five while hidden', async () => {
  const side = client()
  await side.mount()
  assert.equal(readTimer().ms, QUOTA_REFRESH_MS)
  readTimer().run()
  await tick()
  assert.equal(side.signals.length, 2)
  assert.equal(readTimer().ms, QUOTA_REFRESH_MS)
  page.hidden = true
  readTimer().run()
  await tick()
  assert.equal(side.signals.length, 3)
  assert.equal(readTimer().ms, QUOTA_HIDDEN_REFRESH_MS)
})

test('showing the window reads at once, or brings the next read to a minute after one that just started', async () => {
  const side = client()
  await side.mount()
  // A read while hidden puts the next one five minutes out.
  page.hidden = true
  readTimer().run()
  await tick()
  assert.equal(side.signals.length, 2)
  assert.equal(readTimer().ms, QUOTA_HIDDEN_REFRESH_MS)
  // Hiding does nothing.
  side.show(true)
  await tick()
  assert.equal(side.signals.length, 2)
  assert.equal(readTimer().ms, QUOTA_HIDDEN_REFRESH_MS)
  // Shown 10 s after that read: no read now, the next one a minute after it.
  now += 10_000
  side.show(false)
  await tick()
  assert.equal(side.signals.length, 2)
  assert.equal(readTimer().ms, QUOTA_REFRESH_MS - 10_000)
  readTimer().run()
  await tick()
  assert.equal(side.signals.length, 3)
  assert.equal(readTimer().ms, QUOTA_REFRESH_MS)
  // Hidden, then shown 20 s after the last read: it reads at once.
  side.show(true)
  now += 20_000
  side.show(false)
  await tick()
  assert.equal(side.signals.length, 4)
  assert.equal(readTimer().ms, QUOTA_REFRESH_MS)
})

test('a sign-in change or a reconnect drops the figure and replaces the read in flight', async () => {
  for (const event of ['muse-account/session-changed', 'connection/reset']) {
    const side = client([ok({ unlimited: false, available: '5', usedFen: 0, heldFen: 0 }), () => new Promise(() => {})])
    await side.mount()
    side.actions.refreshQuota()
    await tick()
    assert.equal(side.signals.length, 2)
    // Another account's figure does not stay while its own read runs.
    const run = event === 'connection/reset' ? side.events.get(event) : side.remoteEvents.get(event)
    run()
    assert.equal(side.ui.getSnapshot().quota.state, 'loading', event)
    await tick()
    assert.equal(side.signals.length, 3, event)
    assert.equal(side.signals[1].aborted, true, event)
    const [button] = byClass(side.render(), 'bt-account bt-quota')
    assert.equal(button.props['data-state'], 'loading', event)
    assert.equal(button.props['aria-label'], 'Quota', event)
  }
})

test('a read that a newer one replaced is ignored when it answers late', async () => {
  let late
  const side = client([
    () => new Promise((resolve) => { late = resolve }),
    ok({ unlimited: false, available: '3.00', usedFen: 0, heldFen: 0 }),
  ])
  await side.mount()
  side.actions.refreshQuota()
  await tick()
  late(ok({ unlimited: false, available: '999.00', usedFen: 0, heldFen: 0 }))
  await tick()
  assert.equal(textOf(byClass(side.open(), 'bt-quota-figure')), '¥3.00')
})
