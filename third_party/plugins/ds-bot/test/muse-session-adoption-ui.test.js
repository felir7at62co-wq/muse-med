import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import { botDisplayName } from '../src/client/sources.js'

const dom = new JSDOM('<body></body>', { url: 'http://127.0.0.1:3397/', pretendToBeVisual: true })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.IS_REACT_ACT_ENVIRONMENT = true
after(() => dom.window.close())
const require = createRequire(new URL('../../../../packages/client/ui-primitives/package.json', import.meta.url))
const { createElement: h, act } = require('react')
const { createRoot } = require('react-dom/client')
const root = fileURLToPath(new URL('../', import.meta.url))
const bundle = await build({
  stdin: { contents: "export { AdoptSession, adoptableSessions } from './src/client/session-adoption.js'; export { SettingsDialog } from './src/client/settings.js'", resolveDir: root },
  bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, window: dom.window, document: dom.window.document,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  require: name => name === '@deepseek-ai/dsh-client-ui-primitives' ? {} : require(name), setTimeout, clearTimeout })
const { AdoptSession, adoptableSessions, SettingsDialog } = module.exports
const roster = { prefs: {}, bots: [], byId: {}, rooms: [], roomsById: {}, mainBotIds: [] }
const session = { id: 'source', displayTitle: 'Episode continuity', cwd: '/existing/project', updatedAt: 42 }

async function mount(t, component, props) {
  const container = document.createElement('div')
  document.body.append(container)
  const app = createRoot(container)
  await act(async () => app.render(h(component, props)))
  t.after(async () => { await act(() => app.unmount()); container.remove() })
  return container
}
const button = (container, text) => [...container.querySelectorAll('button')].find(entry => entry.textContent === text)

void test('adoption includes ordinary forks in recent order and excludes owned Sessions and subagents', () => {
  const rows = [session, { ...session, id: 'older', updatedAt: 1 }, { ...session, id: 'fork', parentId: 'source', updatedAt: 20 },
    { ...session, id: 'child', parentId: 'source', origin: 'subagent' }, { ...session, id: 'child-origin', origin: 'subagent' },
    { ...session, id: 'bot' }, { ...session, id: 'bot-live' }, { ...session, id: 'bot-part' },
    { ...session, id: 'room' }, { ...session, id: 'room-part' }, { ...session, id: 'agent-session' }]
  const available = adoptableSessions({ ids: rows.map(row => row.id), byId: Object.fromEntries(rows.map(row => [row.id, row])) },
    { ...roster, bots: [{ id: 'bot', sessionId: 'bot-live', parts: ['bot-part'] }], rooms: [{ id: 'room', parts: ['room-part'] }],
      agents: [{ id: 'agent', sessions: ['agent-session'] }] })
  assert.deepEqual(Array.from(available, row => row.id), ['source', 'fork', 'older'])
})

void test('manual registration keeps the default title and opens the original Session only after submission', async t => {
  const calls = []
  const actions = { closeSettings: () => calls.push('close'), openSettings: () => {}, folders: async () => ({}),
    adoptableSessions: () => [session], adoptSession: async payload => { calls.push({ ...payload }); return { botId: 'source', sessionId: 'source' } },
    openSession: id => calls.push(['open', id]) }
  const container = await mount(t, SettingsDialog, { page: 'bots', roster, actions, useUpdate: read => read({}) })
  await act(() => button(container, 'Use an existing conversation').click())
  assert.deepEqual(calls, [])
  assert.ok(container.textContent.includes('/existing/project'))
  assert.ok(container.textContent.includes('Keep its history, workspace and current model.'))
  const name = container.querySelector('input[aria-label="Name"]')
  assert.equal(name.value, '')
  assert.equal(name.placeholder, session.displayTitle)
  assert.equal(container.querySelector('select[aria-label="Conversation"]').value, session.id)
  assert.equal(container.querySelector('input[aria-label="Model"]'), null)
  await act(() => button(container, 'Use as Bot').click())
  assert.deepEqual(calls, [{ sessionId: 'source' }, ['open', 'source'], 'close'])
})

void test('failed registration preserves the source choice for retry and does not navigate', async t => {
  let count = 0
  const actions = { adoptableSessions: () => [session], adoptSession: async () => { count++; throw new Error('Source unavailable') } }
  const container = await mount(t, AdoptSession, { actions, onBack: () => {}, onAdopted: () => assert.fail('no registration') })
  await act(() => button(container, 'Use as Bot').click())
  assert.equal(container.querySelector('[role="alert"]').textContent, 'Source unavailable')
  assert.equal(container.querySelector('select').value, 'source')
  assert.equal(button(container, 'Use as Bot').disabled, false)
  assert.equal(count, 1)
})

void test('an empty catalog offers cancellation without creating a replacement Session', async t => {
  let cancelled = 0
  const container = await mount(t, AdoptSession, { actions: { adoptableSessions: () => [] }, onBack: () => cancelled++, onAdopted: () => assert.fail() })
  assert.ok(container.textContent.includes('No available conversations.'))
  assert.equal(button(container, 'Use as Bot').disabled, true)
  await act(() => button(container, 'Cancel').click())
  assert.equal(cancelled, 1)
})

void test('matching Feishu titles stay visible beside distinct addressable Bot names', async t => {
  const bots = [{ id: 'chat-one', name: '编剧组', channelName: '编剧组', nameSource: 'channel' },
    { id: 'chat-two', name: '编剧组 2', channelName: '编剧组', nameSource: 'channel' }]
  const container = await mount(t, SettingsDialog, { page: 'bots', roster: { ...roster, bots, byId: Object.fromEntries(bots.map(bot => [bot.id, bot])) },
    actions: { closeSettings: () => {}, openSettings: () => {} }, useUpdate: read => read({}) })
  assert.deepEqual([...container.querySelectorAll('.bt-set-bot .bt-row-title')].map(node => node.textContent), ['编剧组', '编剧组'])
  assert.ok([...container.querySelectorAll('.bt-set-bot .bt-tag')].some(node => node.textContent === '编剧组 2'))
  assert.equal(botDisplayName({ ...bots[1], name: '我的编剧', nameSource: 'user' }), '我的编剧')
  assert.equal(botDisplayName({ id: 'legacy', name: '原来手工名字', channelName: '编剧组' }), '原来手工名字')
  assert.equal(botDisplayName({ id: 'ordinary', name: 'Muse' }), 'Muse')
  const originalTitle = '原会话完整标题'.repeat(12)
  assert.equal(botDisplayName({ id: 'long', name: originalTitle.slice(0, 40), sessionTitle: originalTitle, nameSource: 'session' }), originalTitle)
  assert.equal(botDisplayName({ id: 'renamed', name: '我的编导', sessionTitle: originalTitle, nameSource: 'user' }), '我的编导')
})
