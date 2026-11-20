// Muse: what runs in the background of a conversation, at the top of its details page — tasks,
// commands and open terminals, each with Stop. A Bot's page watches its current conversation; a
// group's page watches every member's conversation in that group and leads each row with the
// member's mark. The section stays when nothing runs, so an empty background is visible too.
import { createElement as h, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { BotMark } from './mark.js'
import { terminalCards } from './side-model.js'
import { useTerminals } from './terminal-cards.js'
import { t } from './i18n.js'

const NO_SUBSCRIBE = () => () => {}
const NO_ROWS = {}
const NO_TABS = []
// The job kinds the shell tools register; every other kind is a task.
const COMMAND_KINDS = new Set(['bash', 'pwsh'])
const TICK_MS = 30_000

// How long a job has run, to the minute; nothing in its first minute.
function runningFor(ms) {
  if (!(ms >= 60_000)) return ''
  return ms < 3_600_000 ? t('{n} min', { n: Math.floor(ms / 60_000) }) : t('{n} h', { n: Math.floor(ms / 3_600_000) })
}

// The rows of the section, grouped: live jobs of every watched conversation as tasks or
// commands, then the terminals that still run. `sources` name the conversations and, for a
// group, the member each belongs to.
export function backgroundView({ sources, rows = NO_ROWS, terminals = NO_TABS, now }) {
  const tasks = []
  const commands = []
  for (const source of sources) {
    for (const job of rows[source.sessionId] ?? []) {
      if (job.status !== 'running' && job.status !== 'stopping') continue
      const row = {
        key: `${source.sessionId}:${String(job.id)}`, sessionId: source.sessionId, jobId: job.id, label: job.label,
        note: job.progress || runningFor(now - job.startedAt), stopping: job.status === 'stopping', bot: source.bot,
      }
      if (COMMAND_KINDS.has(job.kind)) commands.push({ ...row, command: true })
      else tasks.push(row)
    }
  }
  const services = terminals.filter(card => card.state !== 'exited' && card.state !== 'failed')
    .map(card => ({ key: `terminal:${card.tab ?? card.id}`, label: card.title || t('Terminal'), note: card.state === 'starting' ? t('Starting…') : '', terminal: card }))
  const groups = [['Tasks', tasks], ['Commands', commands], ['Services', services]].filter(([, items]) => items.length > 0)
    .map(([title, items]) => ({ title, items }))
  return { count: tasks.length + commands.length + services.length, groups }
}

function useNow(every) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), every)
    return () => clearInterval(timer)
  }, [every])
  return now
}

function BackgroundRow({ row, onStop }) {
  return h('div', { className: 'bt-bg-row' },
    row.bot ? h(BotMark, { bot: row.bot, size: 18 }) : null,
    h('span', { className: 'bt-bg-label', 'data-command': row.command || undefined, title: row.label }, row.label),
    row.note ? h('span', { className: 'bt-bg-note' }, row.note) : null,
    row.stopping
      ? h('span', { className: 'bt-note' }, t('Stopping…'))
      : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', 'aria-label': t('Stop {name}', { name: row.label }), onClick: onStop }, t('Stop')))
}

// `sources` are `{ sessionId, bot? }`; `terminals` the terminal cards of a Bot's conversation and
// `onEndTerminal` what ends one.
export function BackgroundPanel({ sources, terminals = NO_TABS, onEndTerminal, actions }) {
  const jobs = actions.backgroundJobs?.() ?? null
  const watched = sources.map(source => source.sessionId).join('\n')
  useEffect(() => {
    if (!jobs) return undefined
    const stops = watched === '' ? [] : watched.split('\n').map(sessionId => jobs.watchRows(sessionId))
    return () => { for (const stop of stops) stop() }
  }, [jobs, watched])
  // The store's methods read `this`, so they are called on the store.
  const subscribe = useMemo(() => (jobs ? listener => jobs.state.subscribe(listener) : NO_SUBSCRIBE), [jobs])
  const rows = useSyncExternalStore(subscribe, () => (jobs ? jobs.state.getSnapshot().rows : undefined) ?? NO_ROWS)
  const now = useNow(TICK_MS)
  const view = backgroundView({ sources, rows, terminals, now })
  const stop = row => () => {
    if (row.terminal) return onEndTerminal?.(row.terminal)
    return void jobs.kill(row.sessionId, row.jobId).catch(error => actions.reportError?.(error, 'jobs'))
  }
  return h('div', { className: 'bt-bg' },
    h('div', { className: 'bt-section-title' }, view.count === 0 ? t('Background jobs') : t('Background jobs · {count}', { count: view.count })),
    view.count === 0
      ? h('div', { className: 'bt-note bt-bg-none' }, t('Nothing running'))
      : view.groups.map(group => h('div', { key: group.title, className: 'bt-bg-group', role: 'group', 'aria-label': t(group.title) },
        h('div', { className: 'bt-bg-kind' }, t(group.title)),
        group.items.map(row => h(BackgroundRow, { key: row.key, row, onStop: stop(row) })))))
}

// A Bot's background: its current conversation and that conversation's terminals.
export function BotBackground({ sessionId, part, tabs = NO_TABS, actions }) {
  const listed = useTerminals(part, actions)
  // Terminal tabs exist only where the terminal plugin gave the panel its calls.
  const terminals = useMemo(() => (actions.terminalOf ? terminalCards(listed, tabs, actions.terminalOf) : NO_TABS), [listed, tabs, actions.terminalOf])
  const sources = useMemo(() => [{ sessionId: part }], [part])
  return h(BackgroundPanel, {
    sources, terminals, actions,
    onEndTerminal: card => actions.endTerminal(sessionId, part, { tab: card.tab, terminalId: card.id ?? undefined }),
  })
}

// A group's background: each member's conversation in the group, and the group's own.
export function GroupBackground({ room, roster, actions }) {
  const members = room.memberSessions ?? {}
  const watched = [room.sessionId, ...room.members.map(id => members[id])].filter(Boolean).join('\n')
  const sources = useMemo(() => [
    ...(room.sessionId ? [{ sessionId: room.sessionId, bot: roster.byId[room.admin] }] : []),
    ...room.members.filter(id => members[id] && roster.byId[id]).map(id => ({ sessionId: members[id], bot: roster.byId[id] })),
  ], [watched, roster.byId])
  return h(BackgroundPanel, { sources, actions })
}

export const BACKGROUND_CSS = `
.bt-bg-group+.bt-bg-group{margin-top:6px}
.bt-bg-kind{font-size:11px;line-height:16px;color:var(--bt-ink-3)}
.bt-bg-row{display:flex;align-items:center;gap:8px;min-height:32px;font-size:12px;line-height:20px;color:var(--bt-ink)}
.bt-bg-row .bt-bg-label{flex:1 1 auto}
.bt-bg-label[data-command]{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px}
.bt-bg-note{flex:none;color:var(--bt-ink-2);font-variant-numeric:tabular-nums}
.bt-bg-row .bt-soft-sm{flex:none;margin:0}
.bt-bg-none{margin-top:0}
`
