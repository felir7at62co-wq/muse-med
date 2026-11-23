import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { columnOpened, createSwitchWindow, drawerOpened, rightColumnOpen } from '../src/client/right-panel.js'

// jsdom comes from the harness that test/harness-resolve.mjs found, like the dsh packages.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness'), 'package.json'))('jsdom')

const document = attrs => new JSDOM(`<!doctype html><body><div ${attrs}><div data-rightbar-col></div></div></body>`).window.document

// 公开#456: the Bot drawer and DSH's right column never share the window; whichever
// the user asked for last wins. The column's state lives on the frame's attributes.
test('the frame attributes read as the column state', () => {
  assert.equal(rightColumnOpen(document('')), true)
  assert.equal(rightColumnOpen(document('data-rightbar-collapsed')), false)
  assert.equal(rightColumnOpen(document('data-rightbar-fullscreen')), true)
  // A narrow window presents the panel fullscreen with no track: both marks.
  assert.equal(rightColumnOpen(document('data-rightbar-collapsed data-rightbar-fullscreen')), true)
  // No frame at all reads as closed.
  assert.equal(rightColumnOpen(new JSDOM('<!doctype html><body></body>').window.document), false)
})

test('a drawer opening folds an open column back', () => {
  assert.equal(drawerOpened(true), 'collapse-column')
  assert.equal(drawerOpened(false), null)
})

test('a column the user opens takes the space from an open drawer', () => {
  assert.equal(columnOpened(true, false), 'close-drawer')
})

test('a column a Session switch revealed yields to the open drawer', () => {
  assert.equal(columnOpened(true, true), 'collapse-column')
})

test('with no drawer open the column opens on its own', () => {
  assert.equal(columnOpened(false, false), null)
  assert.equal(columnOpened(false, true), null)
})

// The switch window holds "the Session moved" until `settle` calls back: inside
// it a column opening is the switch revealing that Session's own column, past
// it the user's own. A newer move restarts it and a stale settle is ignored.
test('the switch window steers the verdict while it is open', () => {
  const ends = []
  const window = createSwitchWindow(done => ends.push(done))
  assert.equal(window.pending, false)
  window.moved()
  assert.equal(window.pending, true)
  assert.equal(columnOpened(true, window.pending), 'collapse-column')
  ends[0]()
  assert.equal(window.pending, false)
  assert.equal(columnOpened(true, window.pending), 'close-drawer')
})

test('a newer Session switch restarts the window and the old settle is stale', () => {
  const ends = []
  const window = createSwitchWindow(done => ends.push(done))
  window.moved()
  window.moved()
  ends[0]()
  assert.equal(window.pending, true)
  assert.equal(columnOpened(true, window.pending), 'collapse-column')
  ends[1]()
  assert.equal(window.pending, false)
})

// The drawer's top row, bundled once and run with a minimal React stand-in; the
// row's components are vnodes, so only the drawer's own body runs.
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/details-drawer.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
const element = (type, props, ...children) => ({
  type, props: children.length > 0
    ? { ...props, children: children.length === 1 ? children[0] : children }
    : props ?? {},
  children: (children.length > 0 ? children : [props?.children]).flat(Infinity),
})
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, URL, URLSearchParams, setTimeout, clearTimeout,
  require: (name) => {
    const platform = {
      react: { createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx }, useContext: ctx => ctx.value, useId: () => 'dv-id',
        createElement: element,
        useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}], useEffect: () => {}, useRef: current => ({ current }),
        useLayoutEffect: () => {}, useMemo: make => make(), useCallback: fn => fn,
        useSyncExternalStore: (subscribe, get) => { subscribe(() => {})(); return get() }, Fragment: 'fragment',
      },
      'react-dom': { createPortal: node => node },
      '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText: () => null },
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { DetailsDrawer } = module.exports

const bot = { id: 'a', name: 'Chief', sessionId: 'a' }
const room = { id: 'g', name: 'Writers', named: true, members: ['a'] }
const roster = { byId: { a: bot }, roomsById: { g: room }, bots: [], exchangeTurns: {}, questions: {}, memory: false }
const hook = value => select => select(value)
const drawer = (sessionId, actions, liveRoster = roster, more = {}) => DetailsDrawer({
  sessionId, roster: liveRoster, actions,
  useSessions: hook({ byId: {} }),
  useSessionStatus: hook(new Map()),
  useActivity: hook({}),
  useWork: hook({ bots: {}, approvals: [] }),
  useBrowserTabs: hook({}),
  useBrowserPages: hook({}),
  ...more,
})
// Muse: a row of tabs sits under the Bot's name, with each tab's content under it; an open
// Jingliu project has a strip tab of its own and takes the drawer's whole height.
const tabButtons = (node, out = []) => {
  if (Array.isArray(node)) { for (const child of node) tabButtons(child, out); return out }
  if (node === null || typeof node !== 'object') return out
  if (node.props?.['data-tab-key']) out.push(node)
  for (const child of node.children ?? []) tabButtons(child, out)
  return out
}
const tabKeys = node => tabButtons(node).map(button => button.props['data-tab-key'])
// Side chat, Terminal and Files are round tools beside the gear.
const toolButtons = node => find(node, child => child.props?.['data-tool-key'] !== undefined)
const toolKeys = node => toolButtons(node).map(button => button.props['data-tool-key'])
const find = (node, pick, out = []) => {
  if (Array.isArray(node)) { for (const child of node) find(child, pick, out); return out }
  if (node === null || typeof node !== 'object') return out
  if (pick(node)) out.push(node)
  for (const child of node.children ?? []) find(child, pick, out)
  return out
}
const identityOf = tree => find(tree, node => node.props?.className === 'bt-drawer-id')[0]
const slots = { hasDrawerSlot: name => name === 'bot.drawer.scripts' || name === 'bot.drawer.jingliu' || name === 'bot.drawer.assets' }

test('the row under the Bot\'s name lists the details, browser, scripts, Jingliu and the asset library; side chat, terminal and files are tools', () => {
  const picks = { newSideChat: [], newTerminal: [] }
  const actions = { ...slots, ...Object.fromEntries(Object.keys(picks).map(name => [name, (...args) => { picks[name].push([...args]) }])), canOpenTerminal: () => true }
  const tree = drawer('a', actions, { ...roster, browser: true }, { renderSlot: () => null })
  assert.deepEqual(tabKeys(tree), ['details', 'browser', 'scripts', 'jingliu', 'assets'])
  assert.deepEqual(toolKeys(tree), ['side', 'terminal', 'files'])
  // Side chat and Terminal open in their own places; Files shows under the row.
  for (const button of toolButtons(tree).filter(button => ['side', 'terminal'].includes(button.props['data-tool-key']))) button.props.onClick()
  assert.deepEqual(picks, { newSideChat: [['a']], newTerminal: [[]] })
  assert.equal(identityOf(tree).props.hidden, undefined)
})

test('a Bot without the terminal or the plugins still gets Details and Browser, with Side chat and Files as tools', () => {
  assert.deepEqual(tabKeys(drawer('a', {})), ['details', 'browser'])
  assert.deepEqual(toolKeys(drawer('a', {})), ['side', 'files'])
})

test('the data tab lists platforms under the Bot\'s name; an open platform takes the whole drawer', () => {
  const opened = []
  const drawn = []
  const actions = { hasDrawerSlot: name => name === 'bot.drawer.data', openDataPlatform: (id, platform) => opened.push([id, platform]), quote: () => {} }
  const renderSlot = (name, owner) => { drawn.push([name, owner]); return null }
  const list = drawer('a', actions, roster, { startTab: 'data', renderSlot })
  const platform = drawer('a', actions, roster, { startTab: 'data:hongguo', renderSlot })
  assert.deepEqual(JSON.parse(JSON.stringify(drawn.map(([name, owner]) => [name, owner.sessionId, owner.platform]))), [
    ['bot.drawer.data', 'a', null],
    ['bot.drawer.data', 'a', 'hongguo'],
  ])
  assert.deepEqual(tabKeys(list), ['details', 'browser', 'data'])
  assert.equal(identityOf(list).props.hidden, undefined)
  assert.equal(identityOf(platform).props.hidden, true)
  assert.deepEqual(tabKeys(platform), [])
  drawn[0][1].openPlatform({ id: 'fanqie', title: '番茄小说' })
  assert.deepEqual(JSON.parse(JSON.stringify(opened)), [['a', { id: 'fanqie', title: '番茄小说' }]])
})

// Muse: the 剧本 tab lists finalized scripts; an open script, like a Jingliu project, takes the whole drawer.
test('the scripts tab lists finalized scripts under the Bot\'s name; an open script takes the whole drawer', () => {
  const opened = []
  const drawn = []
  const actions = { ...slots, openScript: (id, script) => opened.push([id, script]), quote: () => {} }
  const renderSlot = (name, owner) => { drawn.push([name, owner]); return null }
  const list = drawer('a', actions, roster, { startTab: 'scripts', renderSlot })
  const script = drawer('a', actions, roster, { startTab: 'script:7', scripts: [{ id: '7', title: '好一个乖乖女' }], renderSlot })
  assert.deepEqual(JSON.parse(JSON.stringify(drawn.map(([name, owner]) => [name, owner.sessionId, owner.script]))), [
    ['bot.drawer.scripts', 'a', null],
    ['bot.drawer.scripts', 'a', { id: '7', title: '好一个乖乖女' }],
  ])
  assert.equal(tabButtons(list).find(button => button.props['data-tab-key'] === 'scripts').props['aria-selected'], true)
  assert.equal(identityOf(list).props.hidden, undefined)
  assert.equal(identityOf(script).props.hidden, true)
  assert.deepEqual(tabKeys(script), [])
  drawn[0][1].openScript({ id: '8', title: '家里家外' })
  assert.deepEqual(JSON.parse(JSON.stringify(opened)), [['a', { id: '8', title: '家里家外' }]])
})

// Muse: Computer is a tool in the capsule beside the gear, not a row tab; it shows its view under the Bot's name.
test('the computer is a tool beside the gear where the desktop offers it', () => {
  const withComputer = { ...roster, computer: { enabled: true } }
  const tree = drawer('a', { ...slots, canOpenTerminal: () => true }, withComputer, { renderSlot: () => null })
  assert.deepEqual(toolKeys(tree), ['side', 'terminal', 'files', 'computer'])
  assert.ok(!tabKeys(tree).includes('computer'))
  const shown = drawer('a', slots, withComputer, { startTab: 'computer', renderSlot: () => null })
  assert.equal(toolButtons(shown).find(button => button.props['data-tool-key'] === 'computer').props['aria-pressed'], true)
  assert.equal(find(shown, node => typeof node.type === 'function' && node.type.name === 'ComputerView').length, 1)
  assert.equal(identityOf(shown).props.hidden, undefined)
  assert.ok(!toolKeys(drawer('a', slots, roster, { renderSlot: () => null })).includes('computer'))
})

// Muse: a group opens the same libraries as a Bot; the browser, the computer and the tools are a Bot's own.
test('a group\'s drawer lists the libraries the plugins fill; a plain conversation shows no tab row', () => {
  const actions = { ...slots, canOpenTerminal: () => true }
  const drawn = []
  const renderSlot = (name, owner) => { drawn.push([name, owner.sessionId]); return null }
  const group = drawer('g', actions, roster, { renderSlot })
  assert.deepEqual(tabKeys(group), ['details', ...['scripts', 'jingliu', 'assets', 'data'].filter(key => slots.hasDrawerSlot(`bot.drawer.${key}`))])
  assert.equal(find(group, node => node.props?.['data-tool-key'] !== undefined).length, 0, 'no Bot tools on a group')
  assert.deepEqual(tabKeys(drawer('g', {})), [], 'without a library the group keeps its details alone')
  // A library tab in a group hands what it picks to the group's own message box.
  const quoted = []
  drawer('g', { ...actions, quote: (...args) => quoted.push(args) }, roster, { startTab: 'jingliu', renderSlot: (name, owner) => { owner.compose('请出第 3 集'); return null } })
  assert.deepEqual(JSON.parse(JSON.stringify(quoted)), [['g', '请出第 3 集', { plain: true }]])
  assert.deepEqual(tabKeys(drawer('plain', actions, roster, { renderSlot })), [])
})

test('the files tab shows the working folder\'s tree under the Bot\'s name', () => {
  const files = drawer('a', {}, roster, { startTab: 'files' })
  assert.equal(identityOf(files).props.hidden, undefined)
  assert.equal(find(files, node => typeof node.type === 'function' && node.type.name === 'FilesTree').length, 1)
  assert.equal(toolButtons(files).find(button => button.props['data-tool-key'] === 'files').props['aria-pressed'], true)
})

test('the Jingliu tab lists projects under the Bot\'s name; an open project takes the whole drawer', () => {
  const opened = []
  const drawn = []
  const actions = { ...slots, openJingliuProject: (id, project) => opened.push([id, project]), quote: () => {} }
  const renderSlot = (name, owner) => { drawn.push([name, owner]); return null }
  const list = drawer('a', actions, roster, { startTab: 'jingliu', renderSlot })
  const project = drawer('a', actions, roster, { startTab: 'jingliu:p1', projects: [{ id: 'p1', title: 'Bridge Lions' }], renderSlot })
  // Values made in the bundle's realm compare by content.
  assert.deepEqual(JSON.parse(JSON.stringify(drawn.map(([name, owner]) => [name, owner.sessionId, owner.project]))), [
    ['bot.drawer.jingliu', 'a', null],
    ['bot.drawer.jingliu', 'a', { id: 'p1', title: 'Bridge Lions' }],
  ])
  assert.equal(identityOf(list).props.hidden, undefined)
  assert.equal(identityOf(project).props.hidden, true)
  assert.deepEqual(tabKeys(project), [])
  assert.equal(find(project, node => node.props?.['data-info-row'] === 'settings').length, 0, 'no settings gear on a project tab')
  drawn[0][1].openProject({ id: 'p2', title: 'Harbor Night' })
  assert.deepEqual(JSON.parse(JSON.stringify(opened)), [['a', { id: 'p2', title: 'Harbor Night' }]])
})

test('the drawer\'s export button downloads the conversation log where the log export runs', () => {
  const asked = []
  const log = node => node.props?.['data-info-row'] === 'log'
  const actions = { canDownloadLog: () => true, downloadLog: (id) => { asked.push(id); return Promise.resolve() } }
  const [button] = find(drawer('a', actions), log)
  assert.equal(button.props['aria-label'], 'Download conversation log')
  button.props.onClick()
  find(drawer('g', actions), log)[0].props.onClick()
  assert.deepEqual(asked, ['a', 'g'])
  assert.equal(find(drawer('a', {}), log).length, 0)
  assert.equal(find(drawer('a', { canDownloadLog: () => false }), log).length, 0)
})

test('the terminal tab lists terminals under the Bot\'s name; an open terminal takes the whole drawer', () => {
  const drawn = []
  const calls = []
  const actions = {
    hasDrawerSlot: name => name === 'bot.drawer.terminal', canOpenTerminal: () => true, canHostTerminal: () => true,
    newTerminal: () => calls.push('elsewhere'), replaceTerminal: (...args) => calls.push(args),
  }
  const renderSlot = (name, owner) => { drawn.push([name, owner]); return null }
  const list = drawer('a', actions, roster, { startTab: 'terminal', renderSlot })
  assert.equal(identityOf(list).props.hidden, undefined)
  assert.equal(find(list, node => typeof node.type === 'function' && node.type.name === 'TerminalCards').length, 1)
  // The Terminal tool shows the list in place; nothing opens in DSH's right column.
  toolButtons(list).find(button => button.props['data-tool-key'] === 'terminal').props.onClick()
  assert.deepEqual(calls, [])
  assert.equal(drawn.length, 0)
  const open = drawer('a', actions, roster, { startTab: 'terminal:t1', terminals: [{ key: 't1', session: 'a-part2', terminalId: 'host-1' }], renderSlot })
  assert.equal(identityOf(open).props.hidden, true)
  assert.deepEqual(tabKeys(open), [])
  assert.deepEqual(JSON.parse(JSON.stringify(drawn.map(([name, owner]) => [name, owner.sessionId, owner.tabId, owner.terminalId, owner.visible]))),
    [['bot.drawer.terminal', 'a-part2', 't1', 'host-1', true]])
  drawn[0][1].replace()
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['a', 'a', 't1']])
})

// The group's Goal buttons act on `room.id`, never on the Session the header shows:
// a folder change moves the group's own Session to a fresh part.
const buttonsOf = (node, out = []) => {
  if (Array.isArray(node)) { for (const child of node) buttonsOf(child, out); return out }
  if (node === null || typeof node !== 'object') return out
  if (typeof node.type === 'function') return buttonsOf(node.type(node.props), out)
  if (node.type === 'button') out.push(node)
  for (const child of node.children ?? []) buttonsOf(child, out)
  return out
}
const textOf = (node) => {
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'string') return node
  if (node === null || node === undefined || typeof node !== 'object') return ''
  if (typeof node.type === 'function') return textOf(node.type(node.props))
  return (node.children ?? []).map(textOf).join('')
}
const movedRoster = (goal) => {
  const room = { id: 'g', sessionId: 'g-part2', name: 'Writers', named: true, members: ['a'], admin: 'a', goal }
  return { ...roster, roomsById: { g: room, 'g-part2': room } }
}

test('the drawer Set a goal button stores the room id when the Session moved', () => {
  const calls = []
  const moved = movedRoster()
  const tree = drawer('g-part2', { composeGoal: id => calls.push(['compose', id]) }, moved)
  const button = buttonsOf(tree).find(entry => textOf(entry).includes('Set a goal'))
  assert.ok(button)
  button.props.onClick()
  assert.deepEqual(calls, [['compose', 'g']])
})

test('the drawer Show button toggles the goal by the room id when the Session moved', () => {
  const calls = []
  const goal = { status: 'active', title: 'Ship it', stages: [], current: 0 }
  const moved = movedRoster(goal)
  const tree = drawer('g-part2', { toggleGoal: id => calls.push(['toggle', id]) }, moved)
  const button = buttonsOf(tree).find(entry => textOf(entry) === 'Show')
  assert.ok(button)
  button.props.onClick()
  assert.deepEqual(calls, [['toggle', 'g']])
})

// A Bot's label and instructions are edited in the drawer through the Settings page's own
// field. Finds the components the drawer returns by name, without running the others.
const named = (node, name, expand = false, out = []) => {
  if (Array.isArray(node)) { for (const child of node) named(child, name, expand, out); return out }
  if (node === null || typeof node !== 'object') return out
  if (typeof node.type === 'function') {
    if (node.type.name === name) { out.push(node); return out }
    if (expand) return named(node.type(node.props), name, expand, out)
  }
  for (const child of node.children ?? []) named(child, name, expand, out)
  return out
}
const hostStrings = (node, out = []) => {
  if (Array.isArray(node)) { for (const child of node) hostStrings(child, out); return out }
  if (typeof node === 'string') { out.push(node); return out }
  if (node === null || typeof node !== 'object' || typeof node.type === 'function') return out
  for (const child of node.children ?? []) hostStrings(child, out)
  return out
}
const editable = (patch, actions = {}) => drawer('a', actions, { ...roster, byId: { a: { ...bot, ...patch } } })
const aboutOf = (tree) => { const [about] = named(tree, 'About'); return about.type(about.props) }
const fieldOf = about => about.children.find(child => child?.props?.onSave)

test('the drawer label is a field that saves the Bot role, like the Settings page', async () => {
  const saved = []
  const tree = editable({ role: 'Writer' }, { updateBot: (id, patch) => { saved.push(JSON.stringify([id, patch])); return Promise.resolve() } })
  const [label] = named(tree, 'BotLabel')
  const field = label.type(label.props)
  assert.equal(field.props.label, 'Label')
  assert.equal(field.props.value, 'Writer')
  assert.equal(field.props.maxLength, 24)
  assert.equal(field.props.placeholder, 'Add a label')
  await field.props.onSave('Editor')
  assert.deepEqual(saved, ['["a",{"role":"Editor"}]'])
})

test('a refused save of the label or the instructions does not throw out of the field', async () => {
  const tree = editable({ role: 'Writer', instructions: '' }, { updateBot: () => Promise.reject(new Error('refused')) })
  const [label] = named(tree, 'BotLabel')
  await label.type(label.props).props.onSave('Editor')
  await fieldOf(aboutOf(tree)).props.onSave('Drafts notes.')
})

test('a Bot without instructions gets a field in the drawer, not a way into Settings', async () => {
  const saved = []
  const tree = editable({ instructions: undefined }, { updateBot: (id, patch) => { saved.push(JSON.stringify([id, patch])); return Promise.resolve() } })
  assert.equal(hostStrings(tree).some(text => text.includes('Bot settings')), false)
  const field = fieldOf(aboutOf(tree))
  assert.equal(field.props.multiline, true)
  assert.equal(field.props.label, 'Instructions')
  assert.equal(field.props.placeholder, 'What this Bot is responsible for…')
  assert.equal(field.props.autoFocus, false)
  assert.equal(field.props.value, '')
  await field.props.onSave('Drafts notes.')
  assert.deepEqual(saved, ['["a",{"instructions":"Drafts notes."}]'])
})

test('a Bot with instructions shows them as text that a click or Enter turns into the field', () => {
  const read = aboutOf(editable({ instructions: 'Drafts notes.' }))
  assert.equal(fieldOf(read), undefined)
  const text = read.children.find(child => child?.props?.className === 'bt-about')
  assert.ok(text, 'the instructions read as the folded text')
  assert.equal(text.props.role, 'button')
  assert.equal(text.props.tabIndex, 0)
  assert.equal(text.props.title, 'Edit')
  assert.equal(typeof text.props.onClick, 'function')
  assert.equal(typeof text.props.onKeyDown, 'function')
  assert.deepEqual([...text.children], ['Drafts notes.'])
})

test('a group notice stays read-only in the drawer', () => {
  const noticeRoster = { ...roster, roomsById: { g: { ...room, notice: 'Be kind.' } } }
  const tree = drawer('g', {}, noticeRoster)
  const [about] = named(tree, 'About', true)
  assert.equal(about.props.onSave, undefined)
  const shown = about.type(about.props)
  const text = shown.children.find(child => child?.props?.className === 'bt-about')
  assert.equal(text.props.role, undefined)
  assert.equal(text.props['data-editable'], undefined)
})

test('the Bot label and instructions are keyed by Bot id and stay read-only when another dsh holds the team', () => {
  const writable = editable({ role: 'Writer', instructions: 'Drafts notes.' })
  assert.equal(named(writable, 'BotLabel')[0].props.key, 'role:a')
  assert.equal(named(writable, 'About')[0].props.key, 'about:a')

  const locked = drawer('a', {}, { ...roster, readOnly: 'Another dsh holds this team.', byId: { a: { ...bot, role: 'Writer', instructions: 'Drafts notes.' } } })
  assert.equal(named(locked, 'BotLabel').length, 0)
  const [about] = named(locked, 'About')
  assert.equal(about.props.onSave, undefined)
})

test('Bot details open the current, running and earlier sessions or create a new session', () => {
  const calls = []
  const actions = {
    closeOverlay: () => calls.push(['close']),
    openSession: id => calls.push(['current', id]),
    openPart: (id, part, running = false) => calls.push(['open', id, part, running]),
    newPart: id => calls.push(['new', id]),
  }
  const owner = { ...bot, engine: 'claude-code', parts: ['a-old', 'a-running', 'a'], openParts: [{ sessionId: 'a-running' }] }
  const liveRoster = { ...roster, byId: { a: owner }, partsRunning: { 'a-running': true } }
  const useSessions = hook({ byId: { a: { title: 'Current script' }, 'a-old': { title: 'First draft' } } })
  const tree = drawer('a', actions, liveRoster, { useSessions })
  const section = named(tree, 'BotSessions')[0]
  assert.match(textOf(section), /SessionsNew session/)
  const [create, current, running, old] = buttonsOf(section)
  assert.equal(current.props['aria-current'], true)
  assert.equal(textOf(current), 'Current scriptCurrent')
  assert.equal(running.props.title, 'Open this running session')
  assert.equal(textOf(old), 'First draft')
  for (const button of [current, running, old, create]) button.props.onClick()
  assert.deepEqual(calls, [['close'], ['current', 'a'], ['open', 'a', 'a-running', true], ['open', 'a', 'a-old', false], ['new', 'a']])
  const locked = named(drawer('a', actions, { ...liveRoster, readOnly: 'Another dsh holds this team.' }, { useSessions }), 'BotSessions')[0]
  const [lockedCreate, lockedCurrent, lockedRunning, lockedOld] = buttonsOf(locked)
  assert.ok(lockedCreate.props.disabled && lockedRunning.props.disabled && lockedOld.props.disabled)
  assert.ok(!lockedCurrent.props.disabled)
})

// A second instance of the drawer bundle whose React runs effects at once and keeps
// one state slot, so the status line can resolve its host read and render.
const runStatsBundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/details-drawer.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
let runStatsState
const runStatsReact = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ children }) => children; return ctx },
  useContext: ctx => ctx.value, useId: () => 'rv-id',
  createElement: element,
  useState: () => [runStatsState, value => { runStatsState = value }],
  useEffect: effect => effect(), useRef: current => ({ current }), useLayoutEffect: () => {},
  useMemo: make => make(), useCallback: fn => fn,
  useSyncExternalStore: (_subscribe, get) => get(), Fragment: 'fragment',
}
const runStatsModule = { exports: {} }
runInNewContext(runStatsBundle.outputFiles[0].text, {
  module: runStatsModule, exports: runStatsModule.exports, URL, URLSearchParams, setTimeout, clearTimeout,
  require: (name) => {
    const platform = {
      react: runStatsReact,
      'react-dom': { createPortal: node => node },
      '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText: () => null },
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { RunStats } = runStatsModule.exports

test('the Bot status line needs the runStats action and then draws turns, speed, cache and context', () => {
  runStatsState = undefined
  const bot = { id: 'a', name: 'Chief', sessionId: 'a' }
  // Without the action the line stays away instead of drawing itself empty.
  assert.equal(RunStats({ bot, part: 'a', running: false, actions: {} }), null)
  // The host's figures, as the run-stats endpoint returns them.
  const values = {
    sessionStats: { turns: 12, decodeMs: 4000, decodeTokens: 150 },
    tokenUsage: { uncachedInputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 50, outputTokens: 400 },
    contextPressure: { pressureTokens: 41_000, contextWindow: 100_000 },
  }
  let asked
  const actions = { runStats: (id) => { asked = id; return { then: ok => { ok(values) } } } }
  // The first render starts the read; it has nothing to draw until the read lands.
  assert.equal(RunStats({ bot, part: 'a', running: false, actions }), null)
  const node = RunStats({ bot, part: 'a', running: false, actions })
  assert.equal(asked, 'a')
  const line = textOf(node)
  assert.match(line, /12 turns/)
  assert.match(line, /38 tok\/s/)
  assert.match(line, /Cache hit 90%/)
  assert.match(line, /Context 41%/)
  // Moving to another part clears the previous part's figures until the new read finishes.
  assert.equal(RunStats({ bot, part: 'a-2', running: false, actions: { runStats: () => ({ then() {} }) } }), null)
})

// The avatar bubbles read jobs and terminals from the same conversations as details.
const jobsOf = (rows, kills = []) => {
  const state = {
    rows, listeners: new Set(),
    getSnapshot() { return { rows: this.rows } },
    subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener) },
  }
  return { state, watchRows: () => () => {}, kill: (sessionId, id) => { kills.push([sessionId, id]); return Promise.resolve({ ok: true }) } }
}
const keyed = (node, key) => {
  if (Array.isArray(node)) return node.map(child => keyed(child, key)).find(Boolean)
  if (node === null || typeof node !== 'object') return undefined
  if (node.props?.key === key) return node
  return (node.children ?? []).map(child => keyed(child, key)).find(Boolean)
}
test('the avatar shows its conversation’s tasks and opens the exact stop controls', async () => {
  const kills = []
  const ended = []
  const jobs = jobsOf({ a: [
    { id: 'j1', owner: 'a', kind: 'workflow', label: 'render episode 3', status: 'running', progress: '3/8', startedAt: Date.now() },
    { id: 'j2', owner: 'a', kind: 'bash', label: 'ffmpeg -i ep05.mp4', status: 'running', progress: '15/30', startedAt: Date.now() },
    { id: 'j3', owner: 'a', kind: 'bash', label: 'finished', status: 'succeeded', startedAt: Date.now() },
    { id: 'j4', owner: 'a', kind: 'workflow', label: 'on its way out', status: 'stopping', startedAt: Date.now() },
  ] }, kills)
  const actions = {
    backgroundJobs: () => jobs, terminalOf: tab => tab.terminalId,
    endTerminal: (sessionId, part, target) => ended.push([sessionId, part, target]),
  }
  const tree = drawer('a', actions, roster, { terminals: [{ key: 't1', session: 'a', terminalId: 'term-1' }] })
  const block = keyed(identityOf(tree), 'background:a')
  const shown = block.type(block.props)
  const { props } = shown
  assert.equal(props.avatar.type.name, 'DetailsAvatar')
  assert.deepEqual(Array.from(props.rows, row => [row.label, row.state]), [
    ['render episode 3', 'running'], ['on its way out', 'stopping'], ['ffmpeg -i ep05.mp4', 'running'], ['Terminal', 'running'],
  ])
  assert.deepEqual(buttonsOf(shown).filter(button => button.props.className === 'bt-thoughts-chip').map(textOf), ['render episode 3', 'and 3 more tasks'])
  const render = props.renderPanel(null)
  const text = textOf(render)
  assert.match(text, /Tasks.*render episode 3.*Commands.*ffmpeg -i ep05.mp4.*Services.*Terminal/)
  assert.match(text, /render episode 33\/8/)
  assert.match(text, /on its way outStopping…/)
  assert.doesNotMatch(text, /finished/)
  const job = props.rows.find(row => row.label === 'ffmpeg -i ep05.mp4')
  const selected = props.renderPanel(job.key)
  assert.equal(textOf(selected), '15/30Stop')
  const stops = buttonsOf(render).filter(entry => textOf(entry) === 'Stop')
  assert.deepEqual(stops.map(entry => entry.props['aria-label']), ['Stop render episode 3', 'Stop ffmpeg -i ep05.mp4', 'Stop Terminal'])
  await buttonsOf(selected).find(entry => entry.props['aria-label'] === 'Stop ffmpeg -i ep05.mp4').props.onClick()
  assert.deepEqual(kills, [['a', 'j2']])
  await stops[2].props.onClick()
  // The target object comes from the bundle's own realm, so it is compared as JSON.
  assert.equal(JSON.stringify(ended), JSON.stringify([['a', 'a', { tab: 't1', terminalId: 'term-1' }]]))
})

test('the idle avatar has no task bubbles, with or without the jobs plugin', () => {
  for (const actions of [{ backgroundJobs: () => jobsOf({}) }, {}]) {
    const block = keyed(identityOf(drawer('a', actions)), 'background:a')
    const shown = block.type(block.props)
    assert.equal(shown.props.avatar.type.name, 'DetailsAvatar')
    assert.equal(shown.props.rows.length, 0)
    assert.ok(buttonsOf(shown).every(button => !button.props['aria-expanded']))
    assert.doesNotMatch(textOf(shown), /Background jobs|No live jobs/)
  }
})

test('the script tab keeps the avatar without mounting background work', () => {
  const tree = drawer('a', slots, roster, { startTab: 'scripts', renderSlot: () => null })
  const identity = identityOf(tree)
  assert.equal(keyed(identity, 'background:a'), undefined)
  assert.equal(named(identity, 'DetailsAvatar').length, 1)
})

test('a group’s avatar uses its own and current member conversations only', async () => {
  const kills = []
  const buildJob = { id: 'j1', owner: 'g-a', kind: 'bash', label: 'pnpm build', status: 'running', startedAt: Date.now() }
  const jobs = jobsOf({
    'g-a': [buildJob],
    'g-former': [{ ...buildJob, id: 'j2', owner: 'g-former', label: 'Former member job' }],
    a: [{ ...buildJob, id: 'j3', owner: 'a', label: 'Private member job' }],
  }, kills)
  const group = { ...room, sessionId: 'g-own', admin: 'a', memberSessions: { a: 'g-a', former: 'g-former' } }
  const live = { ...roster, roomsById: { g: group } }
  const block = keyed(identityOf(drawer('g', { backgroundJobs: () => jobs }, live)), 'background:g')
  assert.equal(JSON.stringify(block.props.sources.map(source => [source.sessionId, source.bot?.id])), JSON.stringify([['g-own', null], ['g-a', 'a']]))
  const { props } = block.type(block.props)
  assert.equal(props.avatar.type.name, 'MemberPile')
  assert.deepEqual(Array.from(props.rows, row => row.label), ['Chief · pnpm build'])
  const render = props.renderPanel(null)
  assert.doesNotMatch(textOf(render), /Former member job|Private member job/)
  const controls = buttonsOf(render).filter(entry => textOf(entry) === 'Stop')
  assert.deepEqual(controls.map(entry => entry.props['aria-label']), ['Stop Chief: pnpm build'])
  await controls[0].props.onClick()
  assert.deepEqual(kills, [['g-a', 'j1']])
})

test('a thought bubble opens over the details view, closes back to its trigger, and fades when work ends', async t => {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL('../src/client/background-thought-bubbles.js', import.meta.url))],
    bundle: true, format: 'cjs', platform: 'node', write: false, external: ['react'],
  })
  const dom = new JSDOM('<!doctype html><body><main></main></body>')
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true }
  const descriptors = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value })
  t.after(() => {
    dom.window.close()
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  })

  const requireWeb = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness'), 'apps/web/package.json'))
  const { act, createElement } = requireWeb('react')
  const { createRoot } = requireWeb('react-dom/client')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, { ...globals, module, exports: module.exports, require: requireWeb, setTimeout, clearTimeout })
  const { BackgroundThoughtBubbles } = module.exports
  const container = globals.document.querySelector('main')
  const root = createRoot(container)
  const paint = (rows, key = 'owner-a') => act(() => root.render(createElement(BackgroundThoughtBubbles, {
    key, rows, avatar: 'Muse', renderPanel: () => createElement('button', { type: 'button' }, 'Pause task'),
  })))
  const detailsOf = trigger => {
    const details = globals.document.getElementById(trigger.getAttribute('aria-controls'))
    return details?.hasAttribute('aria-hidden') ? null : details
  }
  const chips = () => Array.from(container.querySelectorAll('.bt-thoughts-chip'))
  const first = { key: 'job:first', label: 'First task', state: 'running' }
  const second = { key: 'job:second', label: 'Second task', state: 'running' }
  try {
    paint([])
    assert.equal(chips().length, 0)
    paint([first, second])
    const [left, right] = chips()
    assert.deepEqual([left.dataset.side, right.dataset.side], ['left', 'right'])
    const shell = left.closest('.bt-thoughts-slot')
    const rightShell = right.closest('.bt-thoughts-slot')
    assert.ok(shell && rightShell)
    const surface = left.closest('.bt-thoughts-surface')
    assert.ok(surface)
    assert.equal(shell.hasAttribute('data-overlay'), false)
    act(() => left.click())
    assert.deepEqual(chips(), [left, right])
    assert.equal(left.getAttribute('aria-expanded'), 'true')
    assert.equal(shell.hasAttribute('data-open'), true)
    assert.equal(shell.hasAttribute('data-overlay'), true)
    const details = detailsOf(left)
    assert.ok(details)
    assert.equal(left.closest('.bt-thoughts-slot'), shell)
    assert.equal(details.closest('.bt-thoughts-surface'), surface)
    assert.deepEqual(Array.from(container.querySelectorAll('.bt-thoughts-panel:not([aria-hidden])')), [details])
    assert.equal(globals.document.activeElement, details)
    const control = details.querySelector('button')
    assert.equal(control?.textContent, 'Pause task')

    act(() => {
      control.focus()
      control.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    assert.equal(detailsOf(left), null)
    assert.equal(left.getAttribute('aria-expanded'), 'false')
    assert.equal(shell.hasAttribute('data-open'), false)
    assert.equal(details.hasAttribute('inert'), true)
    assert.equal(globals.document.activeElement, left)
    act(() => t.mock.timers.tick(900))
    assert.equal(shell.hasAttribute('data-overlay'), false)

    act(() => right.click())
    assert.equal(detailsOf(right)?.closest('.bt-thoughts-slot'), rightShell)
    act(() => left.click())
    assert.ok(detailsOf(left))
    assert.equal(detailsOf(right), null)
    act(() => left.click())
    assert.equal(detailsOf(left), null)
    assert.equal(globals.document.activeElement, left)
    act(() => left.click())

    paint([second])
    const leaving = chips().find(chip => chip.hasAttribute('data-leaving'))
    assert.equal(leaving?.textContent, 'First task')
    assert.equal(leaving.dataset.side, 'left')
    assert.equal(leaving.disabled, true)
    assert.equal(leaving.getAttribute('aria-hidden'), 'true')
    assert.equal(leaving.hasAttribute('aria-controls'), false)
    assert.equal(detailsOf(left), null)
    assert.equal(container.querySelector('.bt-thoughts-panel:not([aria-hidden])'), null)
    assert.deepEqual(chips().filter(chip => !chip.hasAttribute('data-leaving')), [right])
    assert.equal(right.dataset.side, 'right')

    act(() => t.mock.timers.tick(450))
    assert.equal(chips().length, 2)
    paint([first, second])
    act(() => t.mock.timers.tick(900))
    assert.deepEqual(chips().map(chip => chip.textContent), ['First task', 'Second task'])
    assert.ok(chips().every(chip => !chip.disabled && !chip.hasAttribute('data-leaving')))

    paint([second])
    act(() => t.mock.timers.tick(899))
    assert.equal(chips().length, 2)
    act(() => t.mock.timers.tick(1))
    assert.deepEqual(chips(), [right])
    assert.equal(right.dataset.side, 'right')

    paint([])
    assert.equal(chips().length, 1)
    paint([], 'owner-b')
    assert.equal(chips().length, 0)
    act(() => t.mock.timers.tick(900))
    assert.equal(chips().length, 0)
  } finally {
    act(() => root.unmount())
  }
})
