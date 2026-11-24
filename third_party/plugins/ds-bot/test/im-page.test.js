import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// React, React DOM and jsdom come from the harness that test/harness-resolve.mjs found.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const HARNESS = process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness')
const { JSDOM } = createRequire(join(HARNESS, 'package.json'))('jsdom')
const requireWeb = createRequire(join(HARNESS, 'apps/web/package.json'))
const { act, createElement } = requireWeb('react')
const { createRoot } = requireWeb('react-dom/client')

const { outputFiles } = await build({
  stdin: { contents: "export { ImPage } from './src/client/im-page.js'", resolveDir: PLUGIN },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

const bots = [{ id: 'bot-main', name: 'Muse' }, { id: 'bot-writer', name: 'Writer' }]
const rooms = [{ id: 'room-story', name: 'Story room' }]
const connection = (chats, botId = 'bot-main') => ({
  id: 'im_test', platform: 'feishu', enabled: true, botId, chatBots: false, requests: [], paired: [],
  chats,
})

// Settings → IM in jsdom, opened on its one IM bot. `imChat` records what the chats list sends.
function openConnection(t, conn) {
  const dom = new JSDOM('<!doctype html><body><main></main></body>')
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true }
  const descriptors = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value })
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    ...globals, navigator: dom.window.navigator, module, exports: module.exports, require: requireWeb,
    setTimeout, clearTimeout, requestAnimationFrame: fn => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
  })
  const sent = []
  // The page runs in its own realm: a clone gives its bodies this realm's prototypes.
  const actions = { imChat: (id, body) => { sent.push([id, structuredClone(body)]); return Promise.resolve(true) } }
  const roster = { bots, rooms, im: { connections: [conn], platforms: ['feishu'] }, imStatus: { [conn.id]: { state: 'ready' } } }
  const container = dom.window.document.querySelector('main')
  const root = createRoot(container)
  t.after(() => {
    act(() => root.unmount())
    dom.window.close()
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  })
  act(() => root.render(createElement(module.exports.ImPage, { roster, actions })))
  act(() => container.querySelector('.bt-im-bot').click())
  const rows = () => Object.fromEntries([...container.querySelectorAll('.bt-im-chat')].map(row => [row.querySelector('.bt-im-name').textContent, row]))
  const textIn = (node, selector) => node.querySelector(selector)?.textContent ?? null
  const shown = trigger => ({ name: textIn(trigger, '.bt-model-name'), mark: textIn(trigger, '.bt-model-provider') })
  const openMenu = (row) => {
    act(() => row.querySelector('.bt-im-target').click())
    return [...dom.window.document.querySelectorAll('.bt-im-menu:not([data-leaving]) [role=menuitemradio]')].map(item => ({
      item, name: textIn(item, '.bt-menu-label'), mark: textIn(item, '.bt-model-provider'), checked: item.getAttribute('aria-checked') === 'true',
    }))
  }
  return { rows, shown, openMenu, sent }
}

const chats = {
  'chat-group': { kind: 'group', title: 'Ops group', target: { botId: 'bot-writer' } },
  'chat-owner': { kind: 'direct', title: 'Owner' },
  'chat-guest': { kind: 'direct', title: 'Guest', target: { botId: 'bot-writer' } },
}

test('every chat row, group or private, has the same Bot picker', async t => {
  const page = openConnection(t, connection(chats))
  const rows = page.rows()
  assert.deepEqual(Object.keys(rows), ['Ops group', 'Owner', 'Guest'])
  for (const row of Object.values(rows)) assert.equal(row.querySelector('.bt-im-target')?.getAttribute('aria-label'), 'Bound to')
  assert.deepEqual(page.shown(rows['Ops group'].querySelector('.bt-im-target')), { name: 'Writer', mark: null })
  assert.deepEqual(page.shown(rows.Guest.querySelector('.bt-im-target')), { name: 'Writer', mark: null })
  // A group's empty choice stays Not bound.
  assert.deepEqual(page.openMenu(rows['Ops group']).map(({ name, mark }) => [name, mark]), [
    ['Not bound', null], ['Muse', null], ['Writer', null], ['Story room', null],
  ])
})

test('a private chat without a target of its own shows the connection\'s Bot as following Talks to', async t => {
  const page = openConnection(t, connection(chats))
  const owner = page.rows().Owner
  assert.deepEqual(page.shown(owner.querySelector('.bt-im-target')), { name: 'Muse', mark: 'Follows “Talks to”' })
  const menu = page.openMenu(owner)
  assert.deepEqual(menu.map(({ name, mark, checked }) => [name, mark, checked]), [
    ['Muse', 'Follows “Talks to”', true], ['Muse', null, false], ['Writer', null, false], ['Story room', null, false],
  ])
})

test('a private chat bound to a group chat shows that group chat', async t => {
  const page = openConnection(t, connection({ 'chat-owner': { kind: 'direct', title: 'Owner', target: { roomId: 'room-story' } } }))
  const owner = page.rows().Owner
  assert.deepEqual(page.shown(owner.querySelector('.bt-im-target')), { name: 'Story room', mark: null })
  assert.deepEqual(page.openMenu(owner).filter(entry => entry.checked).map(entry => entry.name), ['Story room'])
})

test('a private chat whose connection has no Bot is not bound', async t => {
  const page = openConnection(t, connection({ 'chat-owner': { kind: 'direct', title: 'Owner' } }, 'bot-gone'))
  const owner = page.rows().Owner
  assert.deepEqual(page.shown(owner.querySelector('.bt-im-target')), { name: 'Not bound', mark: null })
  assert.deepEqual(page.openMenu(owner)[0].name, 'Not bound')
})

test('picking a Bot binds a private chat, and picking the follow choice clears its binding', async t => {
  const page = openConnection(t, connection(chats))
  const writer = page.openMenu(page.rows().Owner).find(entry => entry.name === 'Writer' && !entry.checked)
  await act(async () => writer.item.click())
  const follow = page.openMenu(page.rows().Guest)[0]
  assert.deepEqual([follow.name, follow.mark, follow.checked], ['Muse', 'Follows “Talks to”', false])
  await act(async () => follow.item.click())
  assert.deepEqual(page.sent, [
    ['im_test', { chatKey: 'chat-owner', target: { botId: 'bot-writer' } }],
    ['im_test', { chatKey: 'chat-guest', target: null }],
  ])
})

test('dsh-im accounts that no connection takes are listed with a Bot picker that links them', async t => {
  const dom = new JSDOM('<!doctype html><body><main></main></body>')
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true }
  const descriptors = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value })
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    ...globals, navigator: dom.window.navigator, module, exports: module.exports, require: requireWeb,
    setTimeout, clearTimeout, requestAnimationFrame: fn => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
  })
  const links = []
  let opened = 0
  const actions = { imLink: (body) => { links.push(structuredClone(body)); return Promise.resolve(true) } }
  const roster = {
    bots, rooms, im: { connections: [], platforms: ['feishu'] }, imStatus: {},
    imAvailable: [{ botId: 'wx_one', channel: 'weixin', name: 'Studio WeChat', connected: true }, { botId: 'wecomapp_one', channel: 'wecom-app', name: 'HR app', connected: false }],
  }
  const container = dom.window.document.querySelector('main')
  const root = createRoot(container)
  t.after(() => {
    act(() => root.unmount())
    dom.window.close()
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  })
  act(() => root.render(createElement(module.exports.ImPage, { roster, actions, openImPlugin: () => { opened += 1 } })))
  const rows = [...container.querySelectorAll('.bt-im-bot')]
  assert.deepEqual(rows.map(row => [row.querySelector('.bt-im-title').textContent, row.querySelector('.bt-im-status').textContent, row.getAttribute('data-state')]),
    [['Studio WeChat', 'WeChat', 'ready'], ['HR app', 'WeCom app', 'connecting']])
  assert.equal(rows[0].querySelector('.bt-im-target').getAttribute('aria-label'), 'Talks to')
  act(() => rows[0].querySelector('.bt-im-target').click())
  const writer = [...dom.window.document.querySelectorAll('.bt-im-menu:not([data-leaving]) [role=menuitemradio]')].find(item => item.textContent.includes('Writer'))
  await act(async () => writer.click())
  assert.deepEqual(links, [{ dshImBotId: 'wx_one', botId: 'bot-writer' }])
  const add = [...container.querySelectorAll('button')].find(button => button.textContent === 'Add account')
  act(() => add.click())
  assert.equal(opened, 1)
})
