/** The actual pinned Vue entry reports readiness only after its mount and initial render. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import { planEmbeddedStudio } from '../compatibility/embedded-studio.mjs'

const root = resolve(process.env.LOCALMINIDRAMA_SOURCE || '.local/localminidrama')
const path = resolve(root, 'frontweb/src/main.js')
const available = existsSync(path)
const revision = '3fbcda9713ca545979dff9e75d21bed53694188f'
let original
function pristine(filename) {
  assert.equal(filename, path)
  original ??= execFileSync('git', ['-C', root, 'show', `${revision}:${relative(root, filename).split(sep).join('/')}`], { encoding: 'utf8' })
  return original
}
function deferred() {
  let resolvePromise, rejectPromise
  const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

function studio(options = {}) {
  const source = planEmbeddedStudio(root, pristine)[0][1].replace(/^import .*\n/gm, '')
  const route = deferred(), tick = deferred(), tickStarted = deferred()
  const messages = [], warnings = [], listeners = new Map()
  const parent = { postMessage(data, origin) { messages.push({ data: JSON.parse(JSON.stringify(data)), origin }) } }
  const window = {
    parent,
    addEventListener(type, listener) { listeners.set(type, listener) },
  }
  if (options.standalone) window.parent = window
  let rendered = options.rendered !== false
  let mounts = 0
  const app = {
    component() {}, use() {},
    mount(selector) {
      mounts++
      assert.equal(selector, '#app')
      if (options.mountError) throw new Error('fixture mount failed')
      return options.missingMount ? undefined : {}
    },
  }
  const context = createContext({
    createApp: () => app, createPinia: () => ({}), ElementPlusIconsVue: {}, ElementPlus: {}, zhCn: {},
    router: { isReady: () => route.promise },
    nextTick: () => { tickStarted.resolve(); return tick.promise },
    document: { querySelector(selector) { assert.equal(selector, '#app > *'); return rendered ? {} : null } },
    window, console: { warn: text => warnings.push(text) },
  })
  const start = () => runInContext(source, context)
  return {
    route, tick, tickStarted, messages, warnings, parent, window,
    start, completed: () => runInContext('museEmbeddedReadiness', context),
    mounts: () => mounts,
    render: () => { rendered = true },
    send(source, data, origin = 'dsh-app://app') { listeners.get('message')?.({ source, data, origin }) },
  }
}

test('embedding planner validates pinned anchors and preserves other staged edits', { skip: !available }, () => {
  const planned = planEmbeddedStudio(root, pristine)
  assert.equal(planned.length, 2)
  assert.equal(planned[0][0], path)
  assert.ok(planEmbeddedStudio(root, filename => '// staged fixture\n' + pristine(filename))[0][1].startsWith('// staged fixture\n'))
  assert.throws(() => planEmbeddedStudio(root, () => planned[0][1]), /pinned source/)
  assert.throws(() => planEmbeddedStudio(root, filename => pristine(filename).replace("app.mount('#app')", "app.mount('#other')")), /pinned source/)
  assert.throws(() => planEmbeddedStudio(root, filename => pristine(filename) + "\napp.mount('#app')\n"), /pinned source/)
})

test('ready waits for the initial route and Vue render, not the document load event', { skip: !available }, async () => {
  const page = studio({ rendered: false })
  page.start()
  assert.equal(page.mounts(), 1)
  page.send(page.parent, { type: 'muse-localminidrama:ping', version: 1 })
  assert.deepEqual(page.messages, [])
  page.route.resolve()
  await page.tickStarted.promise
  assert.deepEqual(page.messages, [])
  page.render()
  page.tick.resolve()
  await page.completed()
  assert.deepEqual(page.messages, [{ data: { type: 'muse-localminidrama:ready', version: 1 }, origin: '*' }])
  assert.deepEqual(page.warnings, [])
})

test('only a parent ping with the supported protocol receives an origin-scoped ready reply', { skip: !available }, async () => {
  const page = studio()
  page.start()
  page.route.resolve()
  page.tick.resolve()
  await page.completed()
  page.messages.length = 0
  const ping = { type: 'muse-localminidrama:ping', version: 1 }
  page.send({}, ping)
  page.send(page.window, ping)
  for (const data of [null, 1, 'ping', {}, { ...ping, version: '1' }, { ...ping, version: 2 }, { ...ping, type: 'other' }]) page.send(page.parent, data)
  assert.deepEqual(page.messages, [])
  page.send(page.parent, ping, 'https://muse.fixture.invalid')
  page.send(page.parent, ping, 'null')
  assert.deepEqual(page.messages, [
    { data: { type: 'muse-localminidrama:ready', version: 1 }, origin: 'https://muse.fixture.invalid' },
    { data: { type: 'muse-localminidrama:ready', version: 1 }, origin: '*' },
  ])
})

test('a failed mount or route and an empty application never report successful readiness', { skip: !available }, async () => {
  const failedMount = studio({ mountError: true })
  assert.throws(failedMount.start, /mount failed/)
  assert.deepEqual(failedMount.messages, [])
  const failedRoute = studio()
  failedRoute.start()
  failedRoute.route.reject(new Error('fixture route failed'))
  await failedRoute.completed()
  assert.deepEqual(failedRoute.messages, [])
  assert.equal(failedRoute.warnings.length, 1)
  for (const options of [{ missingMount: true }, { rendered: false }, { standalone: true }]) {
    const page = studio(options)
    page.start()
    page.route.resolve()
    page.tick.resolve()
    await page.completed()
    page.send(page.parent, { type: 'muse-localminidrama:ping', version: 1 })
    assert.deepEqual(page.messages, [])
  }
})
