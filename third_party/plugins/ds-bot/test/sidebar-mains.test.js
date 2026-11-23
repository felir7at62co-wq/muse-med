// Muse: every Main Bot is a tile at the top of the open column, and a Bot linked to a chat
// app wears that app's mark on its avatar.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { imLinksOf, indexRoster } from '../src/client/sources.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))

// The components run as plain functions over a minimal React stand-in, as in
// sidebar-agent-rail.test.js.
const { outputFiles } = await build({
  stdin: {
    contents: [
      "export { TeamSidebar } from './src/client/sidebar.js'",
      "export { ContextMenu } from './src/client/context-menu.js'",
      "export { BotSettingsForm } from './src/client/bot-settings.js'",
      "export { BotAvatar } from './src/client/mark.js'",
      "export { SHELL_CSS } from './src/client/styles.js'",
    ].join('\n'),
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useCallback: fn => fn,
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }), Fragment: Symbol('Fragment'),
  useEffect() {}, useLayoutEffect() {}, useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useMemo: make => make(), useRef: current => ({ current }), useId: () => 'id',
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  window: { innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {} },
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
})
const { TeamSidebar, ContextMenu, BotSettingsForm, BotAvatar, SHELL_CSS } = module.exports

const walk = (node, match, out = []) => {
  if (Array.isArray(node)) { node.forEach(child => walk(child, match, out)); return out }
  if (!node || typeof node !== 'object') return out
  if (match(node)) out.push(node)
  walk(node.props?.children, match, out)
  return out
}
const classes = node => String(node.props?.className ?? '').split(' ')
const hasClass = name => node => classes(node).includes(name)
const isBotRow = node => node.type?.name === 'BotRow'
// One function component, run down to plain elements.
const expand = (node) => {
  if (Array.isArray(node)) return node.map(expand)
  if (!node || typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, props: { ...node.props, children: expand(node.props.children) } }
}
const textOf = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}

const BOTS = [
  { id: 'writer', name: 'Writer', role: 'Copy', createdAt: 5 },
  { id: 'scripts', name: '剧本管理', role: '剧本', createdAt: 4, pinned: true, sectionId: 'sec' },
  { id: 'chief', name: 'Muse', role: '主理人', createdAt: 1 },
  { id: 'editor', name: 'Editor', createdAt: 3 },
  { id: 'ops', name: 'Ops', role: 'Operations lead for the whole studio', createdAt: 2 },
  { id: 'intern', name: 'Intern', createdAt: 6 },
]
const team = (mainBotIds, im) => indexRoster({
  bots: BOTS, rooms: [], agents: [], sections: [{ id: 'sec', name: '飞书' }],
  mainBotIds, mainBotId: mainBotIds[0] ?? null, exchangeTurns: {}, questions: {},
  ...(im === undefined ? {} : { im }),
})
const ACTIONS = ['openSession', 'openAgent', 'openAgentSession', 'newAgentSession', 'openMenu', 'openPalette', 'openNewChat', 'toggleSidebar', 'clearUnread']
function sidebar(roster, pref = 'open') {
  return TeamSidebar({
    actions: Object.fromEntries(ACTIONS.map(name => [name, () => {}])), useSidebarPref: () => pref,
    useRoster: pick => pick(roster), useUi: pick => pick({ unread: {} }), useRegistry: pick => pick({}),
    useSessions: pick => pick({ ids: [], byId: {} }), useUpdate: () => ({}),
    useSessionStatus: pick => pick(new Map()), useSessionRetainInfo: () => null,
    useActivity: pick => pick({}), useWork: pick => pick({ waiting: {}, rooms: {}, approvals: [] }),
  })
}
const idsOf = rows => rows.map(row => row.props.bot.id)
// The open column's parts: the tiles on top, and the Bot rows of the list below them,
// those filed in a section included.
function openColumn(roster) {
  const tree = sidebar(roster, 'open')
  const [list] = walk(tree, hasClass('bt-list'))
  const tiles = walk(list, hasClass('bt-tiles'))
  const tileRows = tiles.flatMap(node => walk(node, isBotRow))
  const sections = walk(list, node => node.type?.name === 'SectionBlock')
  const listRows = [...walk(list, isBotRow).filter(row => !tileRows.includes(row)), ...sections.flatMap(node => walk(node.type(node.props), isBotRow))]
  return { tree, tiles, tileRows, listRows, sections }
}

for (const mainBotIds of [['chief', 'scripts'], ['chief', 'ops', 'scripts']]) {
  test(`${mainBotIds.length} Main Bots are tiles side by side, in their order, and leave the list`, () => {
    const roster = team(mainBotIds)
    const { tiles, tileRows, listRows, sections } = openColumn(roster)
    assert.equal(tiles.length, 1)
    assert.deepEqual(idsOf(tileRows), mainBotIds)
    assert.deepEqual(idsOf(listRows).sort(), BOTS.map(bot => bot.id).filter(id => !mainBotIds.includes(id)).sort())
    // A Main Bot keeps no place in a section, whatever it was filed under before.
    for (const section of sections) assert.equal(section.props.entries.some(entry => mainBotIds.includes(entry.item.id)), false)
    for (const row of tileRows) {
      const root = row.type(row.props)
      assert.deepEqual(classes(root), ['bt-tile-wrap'])
      const [button] = root.props.children
      assert.deepEqual(classes(button), ['bt-tile'])
      assert.equal(button.props['data-bot-id'], row.props.bot.id)
      // A tile is neither dragged into a section nor shown as pinned.
      assert.equal(button.props.draggable, undefined)
      assert.doesNotMatch(button.props['aria-label'], /Pinned/)
      assert.match(button.props['aria-label'], /Main Bot/)
    }
    for (const row of listRows) assert.deepEqual(classes(row.type(row.props)), ['bt-row'])
  })
}

test('one Main Bot is the single tile it was: avatar, name and label', () => {
  const { tiles, tileRows, listRows } = openColumn(team(['chief']))
  assert.equal(tiles.length, 1)
  assert.deepEqual(idsOf(tileRows), ['chief'])
  assert.deepEqual(idsOf(listRows).sort(), ['editor', 'intern', 'ops', 'scripts', 'writer'])
  const root = tileRows[0].type(tileRows[0].props)
  assert.deepEqual(classes(root), ['bt-tile-wrap'])
  const [button] = root.props.children
  assert.equal(button.type, 'button')
  assert.deepEqual(classes(button), ['bt-tile'])
  const [avatar, name, chip] = button.props.children
  assert.equal(avatar.type.name, 'BotAvatar')
  assert.equal(avatar.props.size, 60)
  assert.equal(avatar.props.main, true)
  assert.equal(avatar.props.im, undefined)
  assert.deepEqual([classes(name), textOf(name)], [['bt-tile-name'], 'Muse'])
  assert.deepEqual([classes(chip), textOf(chip)], [['bt-chip'], '主理人'])
  // The other Bots keep their rows, pin included.
  const scripts = listRows.find(row => row.props.bot.id === 'scripts')
  assert.match(scripts.type(scripts.props).props['aria-label'], /Pinned/)
})

test('a team with no Main Bot yet draws no tile row', () => {
  const { tiles, listRows } = openColumn(team([]))
  assert.equal(tiles.length, 0)
  assert.equal(listRows.length, BOTS.length)
})

test('on the rail every Main Bot is an avatar row above the rule, in order', () => {
  const tree = sidebar(team(['chief', 'ops', 'scripts']), 'rail')
  assert.deepEqual(walk(tree, hasClass('bt-tiles')), [])
  const [top] = walk(tree, hasClass('bt-rail-top'))
  const mains = walk(top, isBotRow)
  assert.deepEqual(idsOf(mains), ['chief', 'ops', 'scripts'])
  const kids = top.props.children.filter(Boolean)
  assert.ok(classes(kids.at(-1)).includes('bt-rail-sep'))
  for (const row of mains) {
    const root = row.type(row.props)
    assert.deepEqual(classes(root), ['bt-row'])
    const [avatar] = root.props.children
    assert.equal(avatar.props.size, 44)
    assert.equal(avatar.props.main, true)
  }
  const [list] = walk(tree, hasClass('bt-list'))
  assert.deepEqual(idsOf(walk(list, isBotRow)).sort(), ['editor', 'intern', 'writer'])
})

test('several tiles share the row inside the column, and one keeps the size it had', () => {
  const rules = [...SHELL_CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.replace(/\/\*[\s\S]*?\*\//g, '').trim(), body }))
  const bodyOf = selector => rules.filter(rule => rule.selector === selector).map(rule => rule.body).pop() ?? ''
  const valueOf = (selector, property) => bodyOf(selector).match(new RegExp(`(?:^|;)${property}:([^;]+)`))?.[1]
  // The row takes over the single tile's own spacing, and a lone tile grows to its old width.
  assert.equal(valueOf('.bt-tiles', 'padding'), valueOf('.bt-tile-wrap', 'padding'))
  assert.equal(valueOf('.bt-tiles>.bt-tile-wrap', 'padding'), '0')
  assert.equal(valueOf('.bt-tiles>.bt-tile-wrap', 'max-width'), valueOf('.bt-tile', 'width'))
  assert.equal(valueOf('.bt-tiles', 'flex-wrap'), 'wrap')
  assert.equal(valueOf('.bt-tiles', 'justify-content'), 'center')
  // Three tiles and their two gaps fit the narrowest open column: 264px less the column's
  // 24px of padding, its hairline border and the list's 12px scrollbar gutter.
  const basis = Number(valueOf('.bt-tiles>.bt-tile-wrap', 'flex').match(/^1 1 (\d+)px$/)[1])
  const gap = Number(valueOf('.bt-tiles', 'gap').match(/ (\d+)px$/)[1])
  assert.ok(basis * 3 + gap * 2 <= 264 - 24 - 1 - 12, `${basis}px tiles with ${gap}px gaps`)
  // A tile that narrow still holds the 60px avatar, and cuts a long name or label with an ellipsis.
  const shared = '.bt-tiles>.bt-tile-wrap:not(:only-child)'
  const side = Number(valueOf(`${shared} .bt-tile`, 'padding-left').replace('px', ''))
  assert.equal(valueOf(`${shared} .bt-tile`, 'padding-right'), `${side}px`)
  assert.ok(basis - side * 2 >= 60)
  // The avatar's hover area reaches 20% past it on a wide tile; on a shared one it stops at
  // the tile's edge, so the last tile adds nothing to the list's width.
  const reach = Number(valueOf(`${shared} .bt-tile>.bt-mark::before`, 'left').replace('px', ''))
  assert.equal(valueOf(`${shared} .bt-tile>.bt-mark::before`, 'right'), `${reach}px`)
  assert.ok(reach < 0 && 60 - reach * 2 <= basis, `${-reach}px past a 60px avatar in a ${basis}px tile`)
  assert.equal(valueOf(`${shared} :is(.bt-tile-name,.bt-chip)`, 'max-width'), '100%')
  for (const selector of ['.bt-tile-name', '.bt-chip']) {
    assert.equal(valueOf(selector, 'overflow'), 'hidden')
    assert.equal(valueOf(selector, 'text-overflow'), 'ellipsis')
  }
  // Nothing narrows a tile that stands alone.
  assert.deepEqual(rules.filter(rule => /\.bt-tiles/.test(rule.selector) && /padding-left|max-width:100%|left:/.test(rule.body) && !rule.selector.includes(':not(:only-child)')), [])
})

// ---------------------------------------------------------------------------
// Everything that asks "is this Bot the tile" answers for every Main Bot.

const menuButtons = (tree) => walk(tree, node => node.type === 'button')
const labelOf = button => textOf(walk(button, hasClass('bt-menu-label')))
function botMenu(id, roster) {
  const calls = []
  const actions = { closeMenu() {}, reportError() {}, setFlags: (...args) => calls.push(['setFlags', ...args]), markUnread() {}, setMain: (...args) => calls.push(['setMain', ...args]) }
  const tree = ContextMenu({ menu: { kind: 'bot', id, x: 10, y: 10 }, roster, actions, useWork: pick => pick({ waiting: {} }) })
  return { calls, buttons: menuButtons(tree) }
}

test('a Main Bot tile\'s menu offers no pin and no section, and still gives the role up', () => {
  const roster = team(['chief', 'scripts'])
  for (const id of ['chief', 'scripts']) {
    const { buttons, calls } = botMenu(id, roster)
    const labels = buttons.map(labelOf)
    for (const gone of ['Pin', 'Unpin', '飞书', 'Remove from section', 'Move to new section…', 'Hide from sidebar', 'Delete']) assert.equal(labels.includes(gone), false, `${id}: ${gone}`)
    const giveUp = buttons.find(button => labelOf(button) === 'Remove Main Bot role')
    assert.ok(giveUp !== undefined, id)
    giveUp.props.onClick()
    assert.deepEqual(calls, [['setMain', id, false]])
  }
  // A Bot of the list keeps them.
  const labels = botMenu('writer', roster).buttons.map(labelOf)
  for (const kept of ['Pin', '飞书', 'Move to new section…', 'Make Main Bot']) assert.ok(labels.includes(kept), kept)
})

test('a section\'s add list leaves every Main Bot out', () => {
  const roster = team(['chief', 'scripts'])
  const menu = ContextMenu({ menu: { kind: 'section-add', id: 'sec', x: 10, y: 10 }, roster, actions: { closeMenu() {} } })
  const labels = menuButtons(menu.type(menu.props)).map(labelOf)
  for (const name of ['Muse', '剧本管理']) assert.equal(labels.includes(name), false, name)
  for (const name of ['Writer', 'Editor', 'Ops', 'Intern']) assert.ok(labels.includes(name), name)
})

test('Bot settings offer a Main Bot tile no sidebar place, and its switch gives the role up', () => {
  const roster = { ...team(['chief', 'scripts']), models: [], memory: false }
  const form = (id) => {
    const calls = []
    const actions = { setMain: (...args) => { calls.push(args) } }
    return { calls, nodes: walk(BotSettingsForm({ bot: roster.byId[id], roster, actions, run: value => value }), () => true) }
  }
  const titles = nodes => nodes.filter(node => typeof node.props?.title === 'string').map(node => node.props.title)
  for (const id of ['chief', 'scripts']) assert.equal(titles(form(id).nodes).includes('Sidebar'), false, id)
  assert.ok(titles(form('writer').nodes).includes('Sidebar'))
  const { calls, nodes } = form('scripts')
  const role = nodes.find(node => node.props?.label === 'Main Bot' && typeof node.props.onChange === 'function')
  assert.equal(role.props.on, true)
  role.props.onChange(false)
  assert.deepEqual(calls, [['scripts', false]])
})

// ---------------------------------------------------------------------------
// The chat-app mark.

const IM = {
  platforms: ['feishu'],
  connections: [
    {
      id: 'im_1', platform: 'feishu', enabled: true, botId: 'chief', settings: { domain: 'feishu' },
      chats: {
        oc_group: { kind: 'group', title: '剧本组', target: { botId: 'writer' }, auto: true },
        oc_room: { kind: 'group', title: 'Team', target: { roomId: 'room' } },
        ou_owner: { kind: 'direct', title: 'Owner' },
      },
    },
    { id: 'im_2', platform: 'feishu', enabled: false, botId: 'editor', settings: {}, chats: { oc_off: { kind: 'group', target: { botId: 'ops' } } } },
  ],
}
const imBadges = node => walk(node, hasClass('bt-badge-im'))

test('the Bot of an enabled connection and the Bot a chat is bound to are linked; a disabled connection links none', () => {
  assert.deepEqual([...imLinksOf(IM)], [['chief', 'feishu'], ['writer', 'feishu']])
  assert.deepEqual([...imLinksOf(undefined)], [])
  assert.deepEqual([...imLinksOf({ connections: [], platforms: [] })], [])
  const direct = { ...IM.connections[0], chats: { ou_reader: { kind: 'direct', target: { botId: 'reader' } } } }
  assert.deepEqual([...imLinksOf({ connections: [direct] })], [['chief', 'feishu'], ['reader', 'feishu']])
  // Lark is Feishu's other edition and takes precedence over other chat apps.
  const two = [
    { id: 'a', platform: 'feishu', enabled: true, botId: 'chief', settings: { domain: 'lark' }, chats: {} },
    { id: 'b', platform: 'telegram', enabled: true, botId: 'chief', settings: {}, chats: { 1: { kind: 'group', target: { botId: 'ops' } } } },
  ]
  assert.deepEqual([...imLinksOf({ connections: two })], [['chief', 'lark'], ['ops', 'telegram']])
  assert.deepEqual([...imLinksOf({ connections: two.toReversed() })], [['chief', 'lark'], ['ops', 'telegram']])
})

test('a linked Bot wears the chat app\'s mark in the sidebar, on its tile and on its row', () => {
  const badgesOf = (pref) => {
    const rows = walk(sidebar(team(['chief'], IM), pref), isBotRow)
    return Object.fromEntries(rows.map(row => [row.props.bot.id, imBadges(expand(row))]))
  }
  for (const pref of ['open', 'rail']) {
    const badges = badgesOf(pref)
    for (const id of ['chief', 'writer']) {
      assert.equal(badges[id].length, 1, `${pref}: ${id}`)
      assert.equal(badges[id][0].props['aria-label'], 'Linked to Feishu')
      assert.equal(badges[id][0].props.role, 'img')
      assert.equal(walk(badges[id][0], node => node.type === 'svg').length, 1)
    }
    // The disabled connection's Bot, the Bot its chat is bound to, and an unlinked Bot.
    for (const id of ['editor', 'ops', 'intern']) assert.deepEqual(badges[id], [], `${pref}: ${id}`)
  }
  // The row's own name says it too: a button's name hides what its marks say.
  const names = Object.fromEntries(walk(sidebar(team(['chief'], IM), 'open'), isBotRow).map(row => [row.props.bot.id, walk(row.type(row.props), node => node.type === 'button')[0].props['aria-label']]))
  assert.equal(names.chief, 'Muse, Main Bot, Linked to Feishu')
  assert.equal(names.writer, 'Writer, Linked to Feishu')
  assert.equal(names.editor, 'Editor')
  // On the Main Bot the mark sits above the star; on a plain row above where a state badge goes.
  const open = badgesOf('open')
  assert.deepEqual(classes(open.chief[0]), ['bt-badge', 'bt-badge-im', 'bt-badge-im-main'])
  assert.deepEqual(classes(open.writer[0]), ['bt-badge', 'bt-badge-im'])
  // No chat app on the team: no mark anywhere.
  const none = walk(sidebar(team(['chief']), 'open'), isBotRow)
  for (const row of none) assert.deepEqual(imBadges(expand(row)), [])
})

test('the mark keeps its place beside the state, Main and admin badges', () => {
  const bot = { id: 'b', name: 'Writer' }
  const badges = props => walk(BotAvatar({ bot, size: 36, ...props }), hasClass('bt-badge')).map(node => node.props.className)
  assert.deepEqual(badges({ im: 'feishu' }), ['bt-badge bt-badge-im'])
  assert.deepEqual(badges({ im: 'feishu', main: true }), ['bt-badge bt-badge-main', 'bt-badge bt-badge-im bt-badge-im-main'])
  assert.deepEqual(badges({ im: 'feishu', main: true, state: 'working' }), ['bt-badge bt-badge-working', 'bt-badge bt-badge-im'])
  assert.deepEqual(badges({ im: 'feishu', state: 'alert' }), ['bt-badge bt-badge-alert', 'bt-badge bt-badge-im'])
  assert.deepEqual(badges({ im: 'feishu', admin: true }), ['bt-badge bt-badge-admin', 'bt-badge bt-badge-im'])
  // An avatar drawn without badges carries none, and a chat app with no mark of its own shows none.
  assert.deepEqual(badges({ im: 'feishu', badge: false }), [])
  assert.deepEqual(badges({ im: 'dingtalk' }), [])
  assert.deepEqual(badges({}), [])
  const label = im => walk(BotAvatar({ bot, size: 36, im }), hasClass('bt-badge-im'))[0].props['aria-label']
  assert.equal(label('lark'), 'Linked to Lark')
  assert.equal(label('telegram'), 'Linked to Telegram')
  // It sits on the avatar's right edge, clear of the badge in the corner below it.
  assert.match(SHELL_CSS, /\.bt-badge-im\{width:14px;height:14px;right:-1px;bottom:15px;/)
  assert.match(SHELL_CSS, /\.bt-badge-im-main\{bottom:calc\(clamp\(14px,calc\(var\(--bt-size,36px\) \* \.36\),22px\) - var\(--bt-size,36px\) \* \.07 \+ 5px\)\}/)
})
