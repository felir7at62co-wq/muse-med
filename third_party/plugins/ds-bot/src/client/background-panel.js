// Live work and scheduled tasks owned by a Bot or group, shown in its details.
import { createElement as h, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { BotMark } from './mark.js'
import { PlusIcon } from './icons.js'
import { terminalCards } from './side-model.js'
import { nextScheduleText, publishSchedules, useSchedules } from './schedules.js'
import { hostText, t } from './i18n.js'
import { BackgroundThoughtBubbles, BACKGROUND_THOUGHT_CSS } from './background-thought-bubbles.js'

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
  const status = row.stopping ? t('Stopping…') : row.note || t('Run in progress')
  return h('div', { className: 'bt-bg-row', title: tooltip },
    row.bot ? h(BotMark, { bot: row.bot, size: 18 }) : null,
    h('div', { className: 'bt-bg-copy' },
      h('span', { className: 'bt-bg-label', 'data-command': row.command || undefined }, row.label),
      h('span', { className: 'bt-bg-note' }, status)),
    !row.stopping && onControl
      ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, 'aria-label': actionLabel, onClick: change }, t(action))
      : null)
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
      key: `schedule:${task.id}`, label: task.title,
      note: task.executionActive === true ? t('Run in progress') : nextScheduleText(task), task,
      bot: room !== undefined ? bots[task.botId] : undefined,
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

/** Attach one live background subscription and its controls to the details avatar. */
export function BackgroundAvatar({ avatar, children, sources, botId, room, bots, tabs = NO_TABS, turns, useSessions, readOnly, actions }) {
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
  const schedules = useSchedules(actions)
  const scheduled = schedules?.available ? backgroundSchedules(schedules.tasks, { botId, room, bots }) : []
  const groups = scheduled.length === 0 ? view.groups : [...view.groups, { title: 'Scheduled tasks', items: scheduled }]
  const stop = row => {
    if (readOnly) return undefined
    if (row.terminal) return () => actions.endTerminal(room?.id ?? botId, row.sessionId, { tab: row.terminal.tab, terminalId: row.terminal.id ?? undefined })
    if (row.turn) return () => actions.stopOpenPart(botId, row.sessionId)
    return () => jobs.kill(row.sessionId, row.jobId)
  }
  const summaries = groups.flatMap(group => group.items.map(row => ({
    key: row.key,
    label: row.bot ? `${row.bot.name} · ${row.label}` : row.label,
    state: row.stopping ? 'stopping' : row.task !== undefined && !row.task.executionActive
      ? row.task.status === 'paused' ? 'paused' : 'scheduled'
      : 'running',
  })))
  const renderRow = row => {
    if (row.task === undefined) {
      const props = { key: row.key, row, actions, action: 'Stop', onControl: stop(row) }
      return row.turn ? h(BackgroundTurnRow, { ...props, useSessions }) : h(BackgroundRow, props)
    }
    const active = row.task.status === 'active'
    const canSetActive = active || row.task.status === 'paused'
    return h(BackgroundRow, {
      key: row.key, row, actions, action: active ? 'Pause' : 'Resume',
      onControl: !readOnly && canSetActive && schedules?.canSetActive && actions.scheduleSetActive
        ? async () => publishSchedules(await actions.scheduleSetActive(row.task, !active))
        : undefined,
    })
  }
  const renderPanel = selectedKey => groups.map(group => {
    const visible = selectedKey === null ? group.items : group.items.filter(row => row.key === selectedKey)
    if (visible.length === 0) return null
    return h('div', { key: group.title, className: 'bt-bg-group', role: 'group', 'aria-label': t(group.title) },
      h('div', { className: 'bt-bg-group-head' },
        h('div', { className: 'bt-bg-kind' }, t(group.title)),
        group.title === 'Scheduled tasks' && !readOnly && actions.openSettings
          ? h('button', {
              type: 'button', className: 'bt-icon-btn', 'aria-label': t('New task'), title: t('New task'),
              onClick: () => actions.openSettings('schedules', room?.id ?? botId),
            }, h(PlusIcon))
          : null),
      visible.map(renderRow))
  })
  return h(BackgroundThoughtBubbles, { avatar, rows: summaries, renderPanel, group: room !== undefined }, children)
}

export const BACKGROUND_CSS = BACKGROUND_THOUGHT_CSS + `
.bt-bg-group+.bt-bg-group{margin-top:10px}
.bt-bg-group-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:22px}
.bt-bg-group-head>.bt-icon-btn{width:24px;height:24px}
.bt-bg-kind{font-size:11px;line-height:16px;color:var(--bt-ink-3)}
.bt-bg-row{display:flex;align-items:center;gap:8px;min-height:34px;padding:4px 0;font-size:12px;line-height:18px;color:var(--bt-ink)}
.bt-bg-copy{display:flex;flex:1;min-width:0;flex-direction:column}
.bt-bg-row .bt-bg-label{white-space:normal;overflow-wrap:anywhere}
.bt-bg-label[data-command]{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px}
.bt-bg-note{color:var(--bt-ink-2);overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.bt-bg-row .bt-soft-sm{flex:none;margin:0}
`
