import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
import { isMainOf } from './sources.js'
import { currentPart, runStatsOf, usageOf } from './text.js'
import { AlertIcon, PlusIcon, CloseIcon, ChevronLeftIcon, GearIcon, ShareIcon, SideIcon, TerminalIcon, FolderIcon, MonitorIcon } from './icons.js'
import { BotMark } from './mark.js'
import { DetailsAvatar } from './details-avatar.js'
import { GlobeIcon, Favicon } from './browser-pane.js'
import { useEscape } from './overlay-hooks.js'
import { BotSettingsForm, InlineText } from './bot-settings.js'
import { GroupSettingsForm, ROOM_MODES, roomSubtitle, shownMode } from './group-settings.js'
import { ModelMenu, modelOf } from './model-menu.js'
import { FolderMenu } from './folder-menu.js'
import { MemoryRow } from './memory-panel.js'
import { useGlide, useMorph } from './motion.js'
import { MemberApprovals, MemberState, StopMemberWork, StopRoomWork, useMemberWork, workState } from './member-status.js'
import { canSetGoal, goalView, hasGoalAdmin } from './goal.js'
import { PermissionPicker, presetDanger, presetName } from './permission-picker.js'
import { TaskBoard } from './task-board.js'
import { ComputerView } from './computer.js'
import { t } from './i18n.js'
import { DRAWER_TAB_LABELS, drawerTabOf, drawerTabs, drawerTools, listTabOf, platformOfTab, projectOfTab, scriptOfTab, terminalOfTab } from './side-model.js'
import { TerminalCards } from './terminal-cards.js'
import { BackgroundAvatar, botBackgroundSources, groupBackgroundSources } from './background-panel.js'
import { FilesTree } from './files-tree.js'

// Muse: a row of tabs sits under the Bot's name and each tab's content shows under it: the
// details, the Bot's browser, the computer, or a slot another plugin fills — the finalized
// scripts, the Jingliu project list, the asset library and the data station. Side chat,
// Terminal and Files are round tools in the top bar; Side chat and Terminal open elsewhere. A
// script, Jingliu project or data platform opened from its list has a tab of its own in the
// panel's strip (browser-pane.js) and takes the drawer's whole height. Each slot gets the Bot's
// current conversation as `sessionId`, and `quote` / `compose` to put a reference or a prepared
// request into its message box; the list slots also get the open entry (`script`, `project`,
// `platform`; null on the list) and a call that opens one as a tab (`openScript`,
// `openProject`, `openPlatform`).
const TAB_SLOTS = { scripts: 'bot.drawer.scripts', jingliu: 'bot.drawer.jingliu', assets: 'bot.drawer.assets', data: 'bot.drawer.data' }
const TOOL_ICONS = { side: SideIcon, terminal: TerminalIcon, files: FolderIcon, computer: MonitorIcon }
// One open terminal, in its own strip tab; the Terminal row tab lists them (terminal-cards.js).
const TERMINAL_SLOT = 'bot.drawer.terminal'
export const DRAWER_SLOTS = Object.fromEntries([...Object.values(TAB_SLOTS), TERMINAL_SLOT].map(name => [name, { kind: 'single', scope: 'root' }]))
const NO_PROJECTS = []

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' } }
const shortUrl = url => String(url ?? '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '')
const EMPTY_TABS = { ids: [], active: null }

// The Bot's permission preset, from the presets DeepSeek Harness offers.
function PermissionRow({ bot, roster, actions, run }) {
  const catalog = roster.permissions
  if (!catalog?.options?.length) return null
  return h('div', { className: 'bt-drawer-permission' },
    h('div', { className: 'bt-section-title' }, t('Permissions')),
    // A Bot without its own preset may run on another one set in DSH, so its first pick always applies.
    h(PermissionPicker, { catalog, saved: bot.permission ?? catalog.defaultPreset, repick: bot.permission === undefined, onPick: permission => run(actions.updateBot(bot.id, { permission })) }))
}

// The current part's turns, speed, cache hits and context, refreshed when a turn starts or ends.
export function RunStats({ bot, part, running, actions }) {
  const scope = `${bot.id}:${part ?? ''}`
  const [read, setRead] = useState(null)
  useEffect(() => {
    if (!actions.runStats) return undefined
    let current = true
    actions.runStats(bot.id).then(
      (values) => { if (current) setRead({ scope, values }) },
      // The line stays as it was until the next read works.
      () => {},
    )
    return () => { current = false }
  }, [scope, bot.id, running, actions])
  const shown = runStatsOf(read?.scope === scope ? read.values : null)
  if (shown.length === 0) return null
  return h('div', { className: 'bt-run-stats' },
    shown.map((entry, index) => h(Fragment, { key: entry.key },
      index > 0 ? h('span', { className: 'bt-run-sep', 'aria-hidden': true }, '·') : null,
      h('span', { title: entry.title }, entry.text))))
}

// The Bot's browser inside the details page: its tabs as small window cards in the
// desktop apps, a pointer there on web.
function BrowserCards({ bot, sessionId, roster, actions, useBrowserTabs, useBrowserPages }) {
  const state = useBrowserTabs(map => map[bot.id] ?? EMPTY_TABS)
  const pages = useBrowserPages(map => map)
  useEffect(() => { actions.browserEnsure?.(bot.id) }, [bot.id])
  if (roster.browser !== true || !actions.browserShow) {
    return h('div', { className: 'bt-muted' }, t('The browser is in DSH Desktop and the DS Bot app.'))
  }
  if (state.ids.length === 0) {
    return h('div', { className: 'bt-browser-empty-mark' },
      h(BotMark, { bot, size: 40, state: 'idle', live: true }),
      h('div', { className: 'bt-browser-empty-title' }, t("{name}'s browser", { name: bot.name })),
      h('div', { className: 'bt-muted' }, t('Open a page here and {name} can read it with you. Logins and cookies stay with {name}; other Bots never see them.', { name: bot.name })),
      h('button', { type: 'button', className: 'bt-browser-retry', onClick: () => actions.openBrowser(sessionId) }, t('Open browser')))
  }
  return h('div', { className: 'bt-bcards' },
    state.ids.map((tabId, index) => {
      const page = pages[tabId] ?? {}
      const label = page.title || shortUrl(page.url) || t('New tab')
      return h('div', { key: tabId, className: 'bt-bcard', 'data-active': state.active === tabId || undefined, style: { animationDelay: `${index * 30}ms` } },
        h('button', { type: 'button', className: 'bt-bcard-shot', 'aria-label': t('Open {title}', { title: label }), title: page.url, onClick: () => actions.browserPick(sessionId, tabId) },
          page.excerpt
            ? h('span', { className: 'bt-bcard-preview' },
                h('span', { className: 'bt-bcard-ptitle' }, label),
                h('span', { className: 'bt-bcard-excerpt' }, page.excerpt))
            : h('span', { className: 'bt-bcard-blank' }, h(GlobeIcon), h('span', null, label))),
        h('button', {
          type: 'button', className: 'bt-bcard-x', 'aria-label': t('Close tab'), title: t('Close tab'),
          onClick: () => { void actions.browserCloseTab(bot.id, tabId) },
        }, '×'),
        h('div', { className: 'bt-bcard-row' },
          h(Favicon, { src: page.favicon, className: 'bt-bcard-fav' }),
          h('span', { className: 'bt-bcard-title' }, label),
          page.url ? h('span', { className: 'bt-bcard-host' }, hostOf(page.url)) : null))
    }),
    h('button', { type: 'button', className: 'bt-bcard-new', style: { animationDelay: `${state.ids.length * 30}ms` }, onClick: () => actions.browserNewTab(sessionId) }, h(PlusIcon), t('New tab')))
}

// A saved value shows as soon as it is typed and until the host has answered, so the
// old text does not flash back between the blur and the roster update. `save` returns
// the promise of the save.
function useSaved(value, save) {
  const [pending, setPending] = useState(null)
  const commit = (next) => {
    setPending({ next })
    return Promise.resolve(save(next)).then(
      (ok) => { setPending(null); return ok },
      () => { setPending(null); return false },
    )
  }
  return [pending ? pending.next : value, commit]
}

// The Bot's label under its name, a field that reads as plain text until it is hovered.
function BotLabel({ bot, actions, run }) {
  const [role, save] = useSaved(bot.role ?? '', next => run(actions.updateBot(bot.id, { role: next })))
  return h(InlineText, { label: t('Label'), value: role, placeholder: t('Add a label'), maxLength: 24, className: 'bt-drawer-role-input', onSave: save })
}

// About: a Bot's instructions or a group's notice in the overview, folded to five lines.
// With `onSave` the Bot's text is edited in place: a click turns it into a field, and an
// empty one is a field already.
function About({ text, title = 'About', label, placeholder, onSave }) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [shown, save] = useSaved(text, next => onSave(next))
  const long = shown.split('\n').length > 5 || shown.length > 240
  const body = useRef(null)
  useMorph(body, open)
  const field = onSave !== undefined && (editing || shown === '')
  // A click that ends a text selection is a copy, not an edit.
  const edit = () => { if (!window.getSelection?.()?.toString()) setEditing(true) }
  return h('div', null,
    h('div', { className: 'bt-section-title' }, t(title)),
    field
      ? h(InlineText, { label, value: shown, multiline: true, placeholder, autoFocus: editing, className: 'bt-input bt-input-area', onSave: save, onDone: () => setEditing(false) })
      : h('div', {
          ref: body, className: 'bt-about', 'data-open': open || undefined,
          ...(onSave ? { role: 'button', tabIndex: 0, title: t('Edit'), 'data-editable': '', onClick: edit, onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setEditing(true) } } } : {}),
        }, shown),
    long && !field ? h('button', { type: 'button', className: 'bt-more', onClick: () => setOpen(value => !value) }, open ? t('Show less') : t('Show more')) : null)
}

// A group's face in its details: its first members side by side, each on a disc that
// cuts into the one before, and how many more there are.
const PILE_MAX = 4
function MemberPile({ room, roster }) {
  const members = room.members.map(id => roster.byId[id]).filter(Boolean)
  const shown = members.length > PILE_MAX ? members.slice(0, PILE_MAX - 1) : members
  const more = members.length - shown.length
  return h('span', { className: 'bt-pile', 'aria-hidden': true },
    shown.map((bot, index) => h('span', { key: bot.id, className: 'bt-pile-face', style: { animationDelay: `${index * 40}ms` } }, h(BotMark, { bot, size: 44, live: true }))),
    more > 0 ? h('span', { key: 'more', className: 'bt-pile-face bt-pile-more', style: { animationDelay: `${shown.length * 40}ms` } }, `+${more}`) : null)
}

const markOf = entry => (entry?.state === 'ask' ? 'alert' : entry?.state === 'work' ? workState(entry.doing) : 'idle')

// One member: its mark, name and what it is doing on one surface that opens its chat;
// Stop beside it while it works here, and the approvals it waits on below.
function MemberRow({ member, entry, room, roster, actions }) {
  return h('div', { role: 'listitem', className: 'bt-member' },
    h('div', { className: 'bt-member-row' },
      h('button', { type: 'button', className: 'bt-member-open', title: t("Open {name}'s chat", { name: member.name }), onClick: () => actions.openSession(member.id) },
        h(BotMark, { bot: member, size: 32, state: markOf(entry) }),
        h('span', { className: 'bt-member-text' },
          h('span', { className: 'bt-member-line' },
            h('span', { className: 'bt-member-name' }, member.name),
            room.admin === member.id ? h('span', { className: 'bt-tag' }, t('Admin')) : null),
          h(MemberState, { entry, bot: member, room, roster }))),
      h(StopMemberWork, { entry, bot: member, room, actions })),
    h(MemberApprovals, { entry, bot: member, actions }))
}

// A group's overview: what members read, who is in it, who answers, and what it
// remembers. Changes are made in its settings. Muse leaves out the group's to-do list:
// production work is tracked in Jingliu.
function GroupOverview({ room, roster, actions, usage, useWork, openSettings }) {
  const members = room.members.map(id => roster.byId[id]).filter(Boolean)
  const { entries } = useMemberWork(room, useWork)
  return [
    room.notice
      ? h(About, { key: 'notice', title: 'Notice', text: room.notice })
      : h('button', { key: 'notice', type: 'button', className: 'bt-more', onClick: openSettings }, t('Add a notice in group settings')),
    h('div', { key: 'members' },
      h('div', { className: 'bt-members-head' },
        h('div', { className: 'bt-section-title' }, t('Members · {count}', { count: members.length })),
        h(StopRoomWork, { room, entries, actions })),
      h('div', { className: 'bt-members', role: 'list' }, members.map(member => h(MemberRow, {
        key: member.id, member, entry: entries.find(item => item.id === member.id), room, roster, actions,
      })))),
    h('div', { key: 'tasks' }, h(TaskBoard, { room, roster, actions })),
    h('div', { key: 'goal' }, h('div', { className: 'bt-section-title' }, t('Goal')),
      h('div', { className: 'bt-kv' },
        room.goal
          ? [h('span', { key: 't' }, room.goal.title, ' ', h('span', { className: 'bt-note' }, goalView(room.goal, { roster })?.barLabel ?? '')),
            h('button', {
              key: 's', type: 'button', className: 'bt-soft bt-soft-sm',
              onClick: () => {
                actions.toggleGoal(room.id)
                // On a narrow layout the panel is a drawer over the header: leave it.
                if (typeof document !== 'undefined' && document.querySelector('[data-rightbar-fullscreen]')) actions.closeOverlay()
              },
            }, t('Show'))]
          : h('button', {
            type: 'button', className: 'bt-soft bt-soft-sm', disabled: !canSetGoal(room, roster),
            title: hasGoalAdmin(room, roster) ? undefined : t('This group has no admin'),
            onClick: () => actions.composeGoal(room.id),
          }, t('Set a goal')))),
    h('div', { key: 'mode' }, h('div', { className: 'bt-section-title' }, t('Who answers')),
      h('div', { className: 'bt-kv' }, h('span', null, t(ROOM_MODES.find(([id]) => id === shownMode(room, roster))?.[1] ?? 'Everyone')))),
    room.permission ? h('div', { key: 'permission' }, h('div', { className: 'bt-section-title' }, t('Permissions')),
      h('div', { className: 'bt-kv' }, h('span', { className: presetDanger(room.permission) ? 'bt-perm-danger' : undefined }, presetName(room.permission, roster.permissions)))) : null,
    roster.memory === false ? null : h(MemoryRow, { key: 'memory', owner: { id: room.id, name: room.name, group: true }, actions }),
    usage ? h('div', { key: 'usage' }, h('div', { className: 'bt-section-title' }, t('Usage')),
      h('div', { className: 'bt-kv' }, h('span', null, t('Language model')), h('span', null, usage))) : null,
  ]
}

function BotSessions({ bot, part, roster, run, useSessions, actions, running, readOnly, openCurrent }) {
  const runningOf = id => running?.[id] === true
  const assignment = entry => roster.autoModels === true && entry.taskModel ? { model: entry.taskModel, effort: entry.taskEffort } : undefined
  const open = (bot.openParts ?? []).map(entry => ({ id: entry.sessionId, open: true, running: runningOf(entry.sessionId), task: assignment(entry) }))
  const backgroundRunning = open.some(entry => entry.running)
  const entries = [
    { id: part, current: true, running: runningOf(part), task: assignment(bot) },
    ...open,
    ...(bot.parts ?? []).filter(id => id !== part && !open.some(entry => entry.id === id)).reverse().map(id => ({ id })),
  ]
  const rows = useSessions(list => entries.map(entry => list.byId?.[entry.id]), rowsEqual)
  const total = entries.length
  const openPart = (entry) => {
    if (entry.current) return openCurrent
    return () => run(actions.openPart(bot.id, entry.id, entry.running))
  }
  return h('div', { className: 'bt-drawer-model' },
    h('div', { className: 'bt-agent-sessions-head' },
      h('div', { className: 'bt-section-title' }, t('Sessions')),
      h('button', { type: 'button', className: 'bt-agent-sessions-new', disabled: readOnly, onClick: () => run(actions.newPart(bot.id)) }, h(PlusIcon), t('New session'))),
    backgroundRunning
      ? h('div', { className: 'bt-agent-sessions-warn', role: 'status' },
          h(AlertIcon),
          h('span', null, t('A running session keeps using model calls in the background.')))
      : null,
    h('div', { className: 'bt-agent-sessions' }, entries.map((entry, index) => {
      const row = rows[index]
      const when = row?.updatedAt ?? row?.createdAt
      const label = row?.title && row.title.trim() !== '' ? row.title : t('Session {number}', { number: total - index })
      const title = entry.current ? t('Current session') : entry.open && entry.running ? t('Open this running session') : entry.open ? t('Open this session') : t('Open this earlier session')
      const model = entry.task === undefined ? undefined : modelOf(entry.task, roster)
      const effort = entry.task?.effort
      const thinking = model && (roster.models ?? []).find(candidate => candidate.ref === model.ref)?.reasoning?.efforts
      const selection = model ? `${model.name} · ${effort === undefined ? t('Default') : thinking?.find(level => level.id === effort)?.name ?? effort}` : undefined
      return h('button', {
        key: entry.id, type: 'button', 'aria-current': entry.current || undefined,
        disabled: readOnly && !entry.current,
        className: `bt-agent-session${entry.current ? ' is-current' : ''}${entry.running ? ' is-running' : ''}`,
        title, onClick: openPart(entry),
      },
        selection === undefined ? h('span', { className: 'bt-agent-session-name' }, label)
          : h('span', { className: 'bt-agent-session-copy' },
              h('span', { className: 'bt-agent-session-name' }, label),
              h('span', { className: 'bt-agent-session-name bt-agent-session-model', title: selection }, selection)),
        h('span', { className: 'bt-agent-session-meta' },
          entry.running ? h('span', { className: 'bt-agent-session-run', role: 'status' }, t('Running'))
            : entry.current ? t('Current')
              : when ? new Date(when).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''))
    })))
}
const rowsEqual = (a, b) => a.length === b.length && a.every((row, index) => row?.title === b[index]?.title && row?.updatedAt === b[index]?.updatedAt && row?.createdAt === b[index]?.createdAt)

export function DetailsDrawer({ sessionId, startRenaming, startTab, hasStrip, projects = NO_PROJECTS, scripts = NO_PROJECTS, terminals = NO_PROJECTS, roster, actions, useSessions, useSessionStatus, useActivity, useWork, useBrowserTabs, useBrowserPages, useComputer, renderSlot }) {
  const owner = roster.byId[sessionId]
  const part = owner ? currentPart(owner) : sessionId
  const isMainBot = isMainOf(roster, owner?.id)
  // Muse: the row under the Bot's name picks the tab. The drawer can also open straight on
  // one, as the sidebar's asset button does, or on an open Jingliu project's own tab.
  const [tab, setTab] = useState(drawerTabOf(startTab))
  useEffect(() => { actions.noteDrawerTab?.(tab) }, [tab])
  const glide = useGlide(tab)
  // Muse: the open terminal this tab shows; a terminal tab that is gone leaves its list in view.
  const terminal = terminals.find(entry => entry.key === terminalOfTab(tab))
  useEffect(() => { if (terminalOfTab(tab) !== null && terminal === undefined) setTab('terminal') }, [tab, terminal])
  const room = roster.roomsById[sessionId]
  // The info pane swaps its overview for the Bot or group settings view in place.
  const [view, setView] = useState(startTab === 'settings' && (owner || room) ? 'settings' : 'overview')
  const [editing, setEditing] = useState(Boolean(startRenaming && (roster.byId[sessionId] || roster.roomsById[sessionId])))
  const [draftName, setDraftName] = useState(roster.byId[sessionId]?.name ?? (roster.roomsById[sessionId]?.named ? roster.roomsById[sessionId].name : ''))
  const [error, setError] = useState('')
  // The settings view comes in from the right and the overview back from the left; a
  // new tab clears from a blur. The first view arrives with the panel.
  const last = useRef({ view, tab, move: undefined })
  if (last.current.view !== view) last.current = { view, tab, move: view === 'settings' ? 'in' : 'out' }
  else if (last.current.tab !== tab) last.current = { view, tab, move: 'tab' }
  const move = last.current.move
  const side = move === 'tab' ? undefined : move
  const close = () => actions.closeOverlay()
  useEscape(close)
  const bot = owner
  const running = useSessionStatus(map => map.get(part)?.running === true)
  const awaitingInput = useSessionStatus(map => map.get(part)?.pendingInteraction !== undefined)
  const completedAt = useWork(work => work.completed?.[part])
  const turns = useWork(work => work.turns)
  const doing = useActivity(map => map[bot?.id ?? sessionId])
  const usage = useSessions(list => usageOf(list, [part, ...(bot?.parts ?? room?.parts ?? [])]))
  const run = promise => Promise.resolve(promise)
    .then(() => { setError(''); return true })
    .catch(failure => { setError(failure?.message ?? String(failure)); return false })
  const errorLine = error ? h('div', { className: 'bt-error', role: 'alert', style: { padding: 0 } }, error) : null
  if ((bot || room) && view === 'settings') {
    return [
      h('div', { key: 'head', className: 'bt-subhead', 'data-move': move },
        h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Back to details'), onClick: () => setView('overview') }, h(ChevronLeftIcon)),
        h('span', { className: 'bt-subhead-title' }, bot ? t('Settings') : t('Group settings')),
        hasStrip ? null : h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close details'), onClick: close }, h(CloseIcon))),
      h('div', { key: 'set-body', className: 'bt-drawer-body bt-set-body', 'data-move': move }, errorLine,
        bot ? h(BotSettingsForm, { bot, roster, actions, run, lean: true }) : h(GroupSettingsForm, { room, roster, actions, run, onDeleted: close })),
    ]
  }
  // An open script, Jingliu project, data platform or terminal takes the whole drawer; every row tab keeps the Bot's top.
  const onDetails = projectOfTab(tab) === null && scriptOfTab(tab) === null && platformOfTab(tab) === null && terminalOfTab(tab) === null
  // A top-bar tool acts as its row tab did; `pick` is declared below and runs at click time.
  function pickTool(key) { return () => pick(key)() }
  const tools = bot ? drawerTools({ bot: true, canTerminal: actions.canOpenTerminal?.() === true, computer: roster.computer?.enabled === true }) : []
  const top = !onDetails ? null : h('div', { className: 'bt-drawer-top', 'data-move': side },
    tools.length > 0 ? h('div', { className: 'bt-dtools', role: 'group', 'aria-label': t('Tools') },
      tools.map(key => h('button', {
        key, type: 'button', className: 'bt-round bt-dtool', 'data-tool-key': key, 'aria-label': t(DRAWER_TAB_LABELS[key]), title: t(DRAWER_TAB_LABELS[key]),
        'aria-pressed': listTabOf(tab) === key, onClick: pickTool(key),
      }, h(TOOL_ICONS[key])))) : null,
    bot || room ? h('button', { type: 'button', className: 'bt-round', 'aria-label': bot ? t('Edit Bot') : t('Group settings'), title: bot ? t('Edit Bot') : t('Group settings'), 'data-info-row': 'settings', onClick: () => setView('settings') }, h(GearIcon)) : null,
    // Muse: the export button downloads the conversation's Session log, where DSH's log export runs.
    (bot || room) && actions.canDownloadLog?.() === true ? h('button', {
      type: 'button', className: 'bt-round', 'aria-label': t('Download conversation log'), title: t('Download conversation log'), 'data-info-row': 'log',
      onClick: () => { void run(actions.downloadLog(sessionId)) },
    }, h(ShareIcon)) : null,
    hasStrip ? null : h('button', { type: 'button', className: 'bt-round', 'aria-label': t('Close details'), onClick: close }, h(CloseIcon)))
  if (!bot && !room) {
    return [h(Fragment, { key: 'top' }, top),
      h('div', { key: 'body', className: 'bt-drawer-body' }, h('div', { className: 'bt-muted' }, t('This conversation is not part of your Bot team.')))]
  }
  const current = bot?.name ?? room.name
  const saveName = async () => {
    setEditing(false)
    const next = draftName.trim()
    if (next === current || (room && !room.named && next === '')) return
    if (bot && next) await run(actions.updateBot(bot.id, { name: next }))
    // An empty group name goes back to naming the group after its members.
    if (room) await run(actions.updateRoom(room.id, { name: next }))
  }
  const subtitle = bot ? undefined : roomSubtitle(room, roster)
  const projectId = projectOfTab(tab)
  const platformId = platformOfTab(tab)
  const scriptId = scriptOfTab(tab)
  const fills = name => typeof renderSlot === 'function' && actions.hasDrawerSlot?.(name) === true
  const slot = projectId !== null ? TAB_SLOTS.jingliu : scriptId !== null ? TAB_SLOTS.scripts : platformId !== null ? TAB_SLOTS.data : TAB_SLOTS[tab]
  const hosted = slot !== undefined && fills(slot)
  const hostsTerminal = fills(TERMINAL_SLOT) && actions.canHostTerminal?.() === true
  const tabs = !onDetails ? [] : drawerTabs({
    bot: bot !== undefined, room: room !== undefined, canBrowse: true,
    canScripts: fills(TAB_SLOTS.scripts), canJingliu: fills(TAB_SLOTS.jingliu), canAssets: fills(TAB_SLOTS.assets) || actions.canOpenAssets?.() === true, canData: fills(TAB_SLOTS.data),
  })
  // Side chat opens in its own place; so does Terminal where no plugin shows terminals in the panel,
  // and the asset library opens its page where no plugin fills the tab.
  const elsewhere = {
    side: () => actions.newSideChat(sessionId),
    ...(hostsTerminal ? {} : { terminal: () => actions.newTerminal() }),
    ...(fills(TAB_SLOTS.assets) ? {} : { assets: () => actions.openAssets() }),
  }
  const pick = key => (elsewhere[key]
    ? () => { void Promise.resolve(elsewhere[key]()).catch(failure => setError(failure?.message ?? String(failure))) }
    : () => setTab(key))
  const avatar = bot ? h(DetailsAvatar, { bot, main: isMainBot, running, activity: doing,
    awaitingInput: awaitingInput || roster.questions?.[part] !== undefined, completedAt })
    : h(MemberPile, { room, roster })
  const identity = h(Fragment, null,
      editing
        ? h('input', {
            className: 'bt-drawer-name-input', autoFocus: true, value: draftName, 'aria-label': bot ? t('Bot name') : t('Group name'),
            placeholder: room ? t('Name after members') : undefined,
            onChange: event => setDraftName(event.target.value), onBlur: saveName,
            onKeyDown: (event) => { if (event.key === 'Enter') void saveName(); if (event.key === 'Escape') { event.stopPropagation(); setEditing(false) } },
          })
        : h('button', { type: 'button', className: 'bt-drawer-name', 'aria-label': t('Rename {name}', { name: current }), title: t('Rename'), onClick: () => { setDraftName(room && !room.named ? '' : current); setEditing(true) } }, current),
      bot
        ? (roster.readOnly
            ? (bot.role ? h('span', { className: 'bt-drawer-role' }, bot.role) : null)
            : h(BotLabel, { key: `role:${bot.id}`, bot, actions, run }))
        : subtitle ? h('span', { className: 'bt-drawer-role' }, subtitle) : null)
  return [h(Fragment, { key: 'top' }, top),
    // An open project, script or platform tab takes the whole height.
    h('div', { key: 'id', className: 'bt-drawer-id', 'data-move': side, hidden: onDetails ? undefined : true },
      tab === 'details'
        ? h(BackgroundAvatar, {
            key: `background:${bot?.id ?? room.id}`,
            avatar, sources: bot ? botBackgroundSources(bot, part) : groupBackgroundSources(room, roster.byId),
            botId: bot?.id, room, bots: roster.byId, tabs: terminals, turns, useSessions, readOnly: roster.readOnly, actions,
          }, identity)
        : h(Fragment, null, avatar, identity)),
    tabs.length > 1 ? h('div', { key: 'tabs', ref: glide.box, className: 'bt-tabs bt-tabs-many', role: 'tablist', 'data-move': side },
      h('span', { ref: glide.thumb, className: 'bt-thumb', 'aria-hidden': true }),
      // Muse: the row spans the drawer in equal tabs.
      tabs.map(key => h('button', { key, type: 'button', role: 'tab', className: 'bt-tab', 'aria-selected': listTabOf(tab) === key, 'data-tab-key': key, onClick: pick(key) },
        t(DRAWER_TAB_LABELS[key])))) : null,
    h('div', { key: `body:${tab}`, className: 'bt-drawer-body', 'data-move': move, 'data-fill': terminal !== undefined || undefined },
      errorLine,
      room && tab === 'details' ? h(GroupOverview, { room, roster, actions, usage, useWork, openSettings: () => setView('settings') }) : null,
      bot && tab === 'computer' ? h(ComputerView, { bot, actions, hooks: { useComputer } }) : null,
      bot && tab === 'files' ? h(FilesTree, { sessionId: part, actions }) : null,
      bot && tab === 'terminal' && hostsTerminal ? h(TerminalCards, { sessionId, part, tabs: terminals, actions }) : null,
      bot && terminal !== undefined && hostsTerminal ? h('div', { key: terminal.key, className: 'bt-drawer-hosted' }, renderSlot(TERMINAL_SLOT, {
        sessionId: terminal.session, tabId: terminal.key, terminalId: terminal.terminalId, visible: true,
        replace: () => actions.replaceTerminal(sessionId, part, terminal.key),
      })) : null,
      // Muse: a group opens the same libraries; what they hand over goes to the group's message box.
      (bot || room) && hosted ? h('div', { className: 'bt-drawer-hosted' }, renderSlot(slot, {
        sessionId: part, quote: text => actions.quote(part, text), compose: text => actions.quote(part, text, { plain: true }),
        ...(slot === TAB_SLOTS.jingliu ? {
          project: projectId === null ? null : { id: projectId, title: projects.find(entry => entry.id === projectId)?.title ?? '' },
          openProject: project => actions.openJingliuProject(sessionId, project),
        } : {}),
        ...(slot === TAB_SLOTS.scripts ? {
          script: scriptId === null ? null : { id: scriptId, title: scripts.find(entry => entry.id === scriptId)?.title ?? '' },
          openScript: script => actions.openScript(sessionId, script),
        } : {}),
        ...(slot === TAB_SLOTS.data ? { platform: platformId, openPlatform: platform => actions.openDataPlatform(sessionId, platform) } : {}),
      })) : null,
      bot && tab === 'details' ? [
        h(BotSessions, {
          key: 'sessions', bot, part, roster, run, useSessions, actions,
          running: roster.partsRunning, readOnly: roster.readOnly,
          openCurrent: () => { close(); actions.openSession(part ?? sessionId) },
        }),
        h(RunStats, { key: 'stats', bot, part, running, actions }),
        h('div', { key: 'model', className: 'bt-drawer-model' },
          h('div', { className: 'bt-section-title' }, t('Model')),
          h(ModelMenu, { bot, roster, actions, run, wide: true, inline: true }),
          modelOf(bot, roster) ? null : h('div', { className: 'bt-note' }, t('Pick a model and {name} can start.', { name: bot.name })),
        ),
        h(PermissionRow, { key: 'permission', bot, roster, actions, run }),
        h('div', { key: 'folder', className: 'bt-drawer-model' },
          h('div', { className: 'bt-section-title' }, t('Working folder')),
          h(FolderMenu, { value: bot.workDir, actions, run, wide: true, onPick: workDir => run(actions.updateBot(bot.id, { workDir })) })),
        roster.readOnly
          ? (bot.instructions ? h(About, { key: `about:${bot.id}`, text: bot.instructions }) : null)
          : h(About, {
              key: `about:${bot.id}`, text: bot.instructions ?? '', label: t('Instructions'), placeholder: t('What this Bot is responsible for…'),
              onSave: instructions => run(actions.updateBot(bot.id, { instructions })),
            }),
        roster.memory === false ? null : h(MemoryRow, { key: 'memory', owner: { id: bot.id, name: bot.name }, actions }),
        usage ? h('div', { key: 'usage' }, h('div', { className: 'bt-section-title' }, t('Usage')),
          h('div', { className: 'bt-kv' }, h('span', null, t('Language model')), h('span', null, usage))) : null,
      ] : null,
      bot && tab === 'browser' ? h(BrowserCards, { bot, sessionId, roster, actions, useBrowserTabs, useBrowserPages }) : null)]
}
