// Live work and scheduled tasks owned by a Bot or group, shown in its details.
import { createElement as h, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { BotMark } from './mark.js'
import { PlusIcon } from './icons.js'
import { terminalCards } from './side-model.js'
import { nextScheduleText, publishSchedules, useSchedules } from './schedules.js'
import { hostText, t } from './i18n.js'

const NO_SUBSCRIBE = () => () => {}
const NO_ROWS = {}
const NO_TABS = []
const COMMAND_KINDS = new Set(['bash', 'pwsh'])
const TICK_MS = 30_000

function runningFor(ms) {
  if (!(ms >= 60_000)) return ''
  return ms < 3_600_000 ? t('{n} min', { n: Math.floor(ms / 60_000) }) : t('{n} h', { n: Math.floor(ms / 3_600_000) })
}

export function botBackgroundSources(bot, current) {
  return [
    { sessionId: current },
    ...(bot.openParts ?? []).filter(part => part.sessionId !== current)
      .map(part => ({ sessionId: part.sessionId, otherChat: true })),
  ]
}

export function groupBackgroundSources(room, bots) {
  return [
    { sessionId: room.sessionId ?? room.id },
    ...room.members.filter(id => room.memberSessions?.[id])
      .map(id => ({ sessionId: room.memberSessions[id], bot: bots[id] })),
  ]
}

export function backgroundView({ sources, rows = NO_ROWS, terminals = NO_ROWS, turns = NO_ROWS, now }) {
  const tasks = []
  const commands = []
  const services = []
  for (const { sessionId, bot, otherChat } of sources) {
    const extra = otherChat ? t('Another conversation') : undefined
    if (otherChat && turns[sessionId] !== undefined) {
      tasks.push({ key: `turn:${sessionId}`, sessionId, turn: true, label: extra, note: runningFor(now - turns[sessionId]) })
    }
    for (const job of rows[sessionId] ?? []) {
      // The shared Jobs stream also mirrors unowned jobs. This panel only shows work owned here.
      if (job.owner !== sessionId || (job.status !== 'running' && job.status !== 'stopping')) continue
      const row = {
        key: `job:${sessionId}:${job.id}`, sessionId, jobId: job.id, label: job.label,
        note: job.progress || runningFor(now - job.startedAt), stopping: job.status === 'stopping', bot, extra,
      }
      if (COMMAND_KINDS.has(job.kind)) commands.push({ ...row, command: true })
      else tasks.push(row)
    }
    for (const card of terminals[sessionId] ?? []) {
      if (card.state === 'exited' || card.state === 'failed') continue
      services.push({
        key: `terminal:${sessionId}:${card.tab ?? card.id}`, sessionId, terminal: card, bot, extra,
        label: card.title || t('Terminal'), note: card.state === 'starting' ? t('Starting…') : '',
      })
    }
  }
  const groups = [['Tasks', tasks], ['Commands', commands], ['Services', services]]
    .filter(([, items]) => items.length > 0).map(([title, items]) => ({ title, items }))
  return { count: tasks.length + commands.length + services.length, groups }
}

function useNow() {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [])
  return now
}

function BackgroundRow({ row, action, onControl, actions }) {
  const [busy, setBusy] = useState(false)
  const change = async () => {
    setBusy(true)
    try {
      await onControl()
    } catch (error) {
      actions.reportError?.(new Error(hostText(error?.message ?? String(error))), 'background')
    } finally {
      setBusy(false)
    }
  }
  const name = row.bot ? `${row.bot.name}: ${row.label}` : row.label
  const tooltip = row.extra ? `${row.extra} · ${name}` : name
  const actionLabel = action === 'Pause' ? t('Pause {name}', { name }) : action === 'Resume' ? t('Resume {name}', { name }) : t('Stop {name}', { name })
  return h('div', { className: 'bt-bg-row', title: tooltip },
    row.bot ? h(BotMark, { bot: row.bot, size: 18 }) : null,
    h('span', { className: 'bt-bg-label', 'data-command': row.command || undefined }, row.label),
    row.note ? h('span', { className: 'bt-bg-note', title: row.note }, row.note) : null,
    row.stopping
      ? h('span', { className: 'bt-note' }, t('Stopping…'))
      : onControl && h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, 'aria-label': actionLabel, onClick: change }, t(action)))
}

function BackgroundTurnRow({ row, useSessions, ...props }) {
  const title = useSessions(list => list.byId[row.sessionId]?.displayTitle ?? list.byId[row.sessionId]?.title)
  return h(BackgroundRow, { ...props, row: { ...row, label: title || row.label } })
}

function backgroundSchedules(tasks, { botId, room, bots }) {
  return tasks.filter(task => (task.status === 'active' || task.status === 'paused' || task.executionActive === true)
    && (room === undefined
      ? task.roomId === undefined && task.botId === botId
      : task.roomId === room.id && (task.botId === undefined || room.members.includes(task.botId))))
    .map(task => ({
      key: task.id, label: task.title, note: task.executionActive === true ? t('Run in progress') : nextScheduleText(task), task,
      bot: room !== undefined ? bots[task.botId] : undefined,
    }))
}

function BackgroundSchedules({ botId, room, bots, actions, readOnly }) {
  const view = useSchedules(actions)
  if (view === null || (!view.available && (readOnly || room !== undefined))) return null
  const rows = backgroundSchedules(view.tasks, { botId, room, bots })
  const target = room?.id ?? botId
  const settings = () => actions.openSettings('schedules', target)
  return h('div', { className: 'bt-bg-group', role: 'group', 'aria-label': t('Scheduled tasks') },
    h('div', { className: 'bt-members-head' },
      h('div', { className: 'bt-bg-kind' }, t('Scheduled tasks')),
      !readOnly && view.available && rows.length > 0 && h('button', {
        type: 'button', className: 'bt-icon-btn', 'aria-label': t('New task'), title: t('New task'), onClick: settings,
      }, h(PlusIcon))),
    rows.length === 0 && !readOnly && h('button', { type: 'button', className: 'bt-more', onClick: settings },
      view.available ? t('No scheduled tasks yet. Add one') : t('Configure scheduled tasks')),
    rows.map(row => {
      const active = row.task.status === 'active'
      const canSetActive = active || row.task.status === 'paused'
      return h(BackgroundRow, {
        key: row.key, row, actions, action: active ? 'Pause' : 'Resume',
        onControl: !readOnly && canSetActive && view.canSetActive && actions.scheduleSetActive
          ? async () => publishSchedules(await actions.scheduleSetActive(row.task, !active))
          : undefined,
      })
    }))
}

function useBackgroundTerminals(sessionKey, tabs, actions) {
  const [listed, setListed] = useState(NO_ROWS)
  useEffect(() => {
    if (!actions.watchTerminals || sessionKey === '') return undefined
    let live = true
    setListed(NO_ROWS)
    const stops = sessionKey.split('\n').map(id => actions.watchTerminals(id, entries => {
      if (live) setListed(previous => ({ ...previous, [id]: entries }))
    }))
    return () => {
      live = false
      for (const stop of stops) stop()
    }
  }, [actions, sessionKey])
  return useMemo(() => actions.terminalOf && sessionKey !== '' ? Object.fromEntries(sessionKey.split('\n')
    .map(id => [id, terminalCards(listed[id] ?? NO_TABS, tabs.filter(tab => tab.session === id), actions.terminalOf)])) : NO_ROWS,
  [actions, listed, tabs, sessionKey])
}

export function BackgroundPanel({ sources, botId, room, bots, tabs = NO_TABS, turns, useSessions, readOnly, actions }) {
  const jobs = actions.backgroundJobs?.() ?? null
  const sessionKey = [...new Set(sources.map(source => source.sessionId))].join('\n')
  useEffect(() => {
    if (!jobs || sessionKey === '') return undefined
    const stops = sessionKey.split('\n').map(sessionId => jobs.watchRows(sessionId))
    return () => { for (const stop of stops) stop() }
  }, [jobs, sessionKey])
  const subscribe = useMemo(() => (jobs ? listener => jobs.state.subscribe(listener) : NO_SUBSCRIBE), [jobs])
  const rows = useSyncExternalStore(subscribe, () => jobs?.state.getSnapshot().rows ?? NO_ROWS)
  const terminals = useBackgroundTerminals(sessionKey, tabs, actions)
  const now = useNow()
  const view = backgroundView({ sources, rows, terminals, turns, now })
  const stop = row => {
    if (readOnly) return undefined
    if (row.terminal) return () => actions.endTerminal(room?.id ?? botId, row.sessionId, { tab: row.terminal.tab, terminalId: row.terminal.id ?? undefined })
    if (row.turn) return () => actions.stopOpenPart(botId, row.sessionId)
    return () => jobs.kill(row.sessionId, row.jobId)
  }
  return h('section', { className: 'bt-bg', 'aria-label': t('Background jobs') },
    h('div', { className: 'bt-section-title' }, view.count === 0 ? t('Background jobs') : t('Background jobs · {count}', { count: view.count })),
    view.count === 0
      ? h('div', { className: 'bt-note bt-bg-none' }, t('No live jobs'))
      : view.groups.map(group => h('div', { key: group.title, className: 'bt-bg-group', role: 'group', 'aria-label': t(group.title) },
        h('div', { className: 'bt-bg-kind' }, t(group.title)),
        group.items.map(row => {
          const props = { key: row.key, row, actions, action: 'Stop', onControl: stop(row) }
          return row.turn ? h(BackgroundTurnRow, { ...props, useSessions }) : h(BackgroundRow, props)
        }))),
    h(BackgroundSchedules, { botId, room, bots, actions, readOnly }))
}

export const BACKGROUND_CSS = `
.bt-bg-group+.bt-bg-group,.bt-bg-none+.bt-bg-group{margin-top:8px}
.bt-bg-kind{font-size:11px;line-height:16px;color:var(--bt-ink-3)}
.bt-bg-row{display:flex;align-items:center;gap:8px;min-height:32px;font-size:12px;line-height:20px;color:var(--bt-ink)}
.bt-bg-row .bt-bg-label{flex:1 1 auto}
.bt-bg-label[data-command]{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px}
.bt-bg-note{max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--bt-ink-2);font-variant-numeric:tabular-nums}
.bt-bg-row .bt-soft-sm{flex:none;margin:0}
.bt-bg-none{margin-top:0}
`
