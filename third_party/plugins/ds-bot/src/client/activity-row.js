import { createElement as h, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BotMark, RoomAvatar } from './mark.js'
import { Elapsed, Shimmer } from './cells.js'
import { noteClientError } from './diagnostics.js'
import { reducedMotion } from './motion.js'
import { t } from './i18n.js'

// -------------------------------------------------------------------------
// The activity row shows the current observed work and the elapsed Turn time.

const PHRASE_HOLD_MS = 800
export { reducedMotion }

export const rowVisible = ({ running, relaying, bot, room }) =>
  running && !relaying && (bot !== undefined || room !== undefined)

// The turn clock starts at the turn, not the last request or a later steer.
export const activityClockStart = ({ moveAt, turnAt, runAt }) => moveAt !== 0 ? moveAt : turnAt ?? runAt
export const activityClockLabel = turnAt => t(turnAt === undefined ? 'Observed elapsed' : 'Turn elapsed')

// A new steer takes precedence over activity from an older step.
export function activityChoice({ inputAt, texts, tool }) {
  const textAt = Math.max(0, ...texts.map(entry => entry.at ?? 0))
  if (inputAt > Math.max(textAt, tool?.at ?? 0)) return { key: `input:${inputAt}`, label: t('Waiting for model reply'), state: 'thinking' }
  if (tool) return { key: tool.label ? `tool:${tool.label}` : 'working', label: tool.label ?? t('Working'), state: tool.state ?? 'working' }
  if (texts.length) return { key: 'receiving', label: t('Receiving reply'), state: 'working' }
  return { key: 'waiting', label: t('Waiting for model reply'), state: 'thinking' }
}

// The shell's running slot can sit under wrappers it adds around the flow, so the
// search is a descendant one; without the slot the row mounts at the flow's tail.
// No flow at all is a mount failure, noted once per page — the observer keeps
// retrying in case the transcript is only mid-mount.
let mountMissed = false
export function findHost() {
  const node = document.querySelector('[data-chat-flow] [data-chat-running]')
    ?? document.querySelector('[data-chat-flow]')
  if (node === null && !mountMissed) {
    mountMissed = true
    noteClientError('activity row', new Error('[data-chat-flow] not found'))
  }
  return node
}

function useRunningHost(active) {
  const [host, setHost] = useState(null)
  useEffect(() => {
    if (!active) { setHost(null); return undefined }
    let frame = 0
    const find = () => {
      frame = 0
      setHost(prev => {
        const node = findHost()
        return prev === node ? prev : node
      })
    }
    const observer = new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(find) })
    observer.observe(document.querySelector('[data-conversation-scroll]') ?? document.body, { childList: true, subtree: true })
    find()
    return () => { cancelAnimationFrame(frame); observer.disconnect() }
  }, [active])
  return host
}

// New rows slide in. The first paint of a transcript, history
// loaded above, and bulk loads arrive without motion.
function useRowEntrances(replacing) {
  const check = useRef(replacing)
  check.current = replacing
  useEffect(() => {
    const seen = new WeakSet()
    const started = Date.now()
    let column = null
    let frame = 0
    const settle = (event) => {
      if (event.target !== event.currentTarget || !/^bt-row/.test(event.animationName)) return
      delete event.currentTarget.dataset.btEnter
      event.currentTarget.removeEventListener('animationend', settle)
    }
    const scan = () => {
      frame = 0
      const next = document.querySelector('[data-chat-flow]')
      if (next !== column) {
        observer.disconnect()
        column = next
        if (column) observer.observe(column, { childList: true, subtree: true })
      }
      if (!column) return
      const items = [...column.querySelectorAll(':scope > [data-chat-flow-key]')]
      let last = -1
      items.forEach((item, index) => { if (seen.has(item)) last = index })
      const fresh = items.filter(item => !seen.has(item) && item.offsetHeight > 0)
      for (const item of fresh) seen.add(item)
      if (last < 0 || Date.now() - started < 800 || fresh.length > 3) return
      for (const item of fresh) {
        if (items.indexOf(item) < last) continue
        const reply = [undefined, 'assistant-step', 'tool-call'].includes(item.dataset.chatFlowKind)
        item.dataset.btEnter = reply && check.current() ? 'after-collapse' : 'new'
        item.addEventListener('animationend', settle)
      }
    }
    const observer = new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(scan) })
    scan()
    return () => { cancelAnimationFrame(frame); observer.disconnect() }
  }, [])
}

export function ActivityIndicator({ sessionId, useRoster, useSessionStatus, useLive, useSession, useWork, actions }) {
  const roster = useRoster(value => value)
  const running = useSessionStatus(map => map.get(sessionId)?.running === true)
  const turnAt = useWork?.(work => work.turns?.[sessionId])
  // Until the host reports the turn's start, the clock counts from when this window
  // saw the run begin.
  const runAt = useRef(0)
  if (!running) runAt.current = 0
  else if (runAt.current === 0) runAt.current = Date.now()
  const liveKey = useLive(state => JSON.stringify(state[sessionId] ?? {}))
  // A queued message waits for the next turn, so only a transcript or steering
  // send counts as fresh input.
  const pendingInput = useSession(snapshot => Math.max(0, ...(snapshot?.pendingSubmissions ?? [])
    .filter(sub => sub.placement !== 'queued').map(sub => sub.time)))
  const bot = roster.byId[sessionId]
  const room = roster.roomsById[sessionId]
  // The one switch the row names: a working-folder move jumps the chat to a fresh
  // part while a turn is not running, so without it the conversation just empties.
  const moveAt = useWork?.((work) => {
    const entry = bot === undefined ? undefined : work.bots?.[bot.id]
    return entry?.switching === true && entry.folder === true && entry.roomId === undefined ? entry.since : 0
  }) ?? 0
  const entries = useMemo(() => Object.values(JSON.parse(liveKey)), [liveKey])
  const texts = entries.filter(entry => entry.text)
  const streaming = texts.length > 0
  const tools = entries.filter(entry => !entry.text).sort((a, b) => a.at - b.at)
  // Group chats show who is typing on their own while members speak.
  const relaying = tools.some(entry => entry.relay)
  const visible = moveAt !== 0 || rowVisible({ running, streaming, tools, relaying, bot, room })
  const tool = tools.at(-1)
  const inputRef = useRef(0)
  // A steer keeps the run going, so nothing else resets the row: fresh input is
  // the newest activity, and the phrase and the clock restart from the send.
  const inputAt = Math.max(inputRef.current, pendingInput)
  inputRef.current = inputAt
  const want = !visible ? null
    : moveAt !== 0 ? { key: 'move', label: t('Switching working folder'), state: 'thinking' }
      : activityChoice({ inputAt, texts, tool })
  const [shown, setShown] = useState(null)
  const wantKey = want?.key ?? null
  const markState = useRef('thinking')
  if (want) markState.current = want.state
  useEffect(() => {
    if (wantKey === null || shown?.key === wantKey) return undefined
    const make = () => setShown({ key: wantKey, text: want.label, at: Date.now() })
    const wait = shown ? shown.at + PHRASE_HOLD_MS - Date.now() : 0
    if (wait <= 0) { make(); return undefined }
    const timer = setTimeout(make, wait)
    return () => clearTimeout(timer)
  }, [wantKey, shown])
  const [phase, setPhase] = useState(null)
  const endedAt = useRef(0)
  const shift = useRef(null)
  const leaving = useRef(false)
  leaving.current = phase !== null && !visible
  useEffect(() => {
    if (visible) { setPhase('in'); return undefined }
    setPhase(current => (current === 'in' ? 'out' : current))
    const timer = setTimeout(() => {
      shift.current = document.querySelector('[data-conversation-scroll]')?.scrollTop ?? null
      setPhase(current => (current === 'out' ? null : current))
    }, 140)
    return () => clearTimeout(timer)
  }, [visible])
  // Removing the row at a pinned tail moves the transcript down; a tail
  // shift eases that collapse instead of jumping.
  useLayoutEffect(() => {
    if (phase !== null) return
    endedAt.current = Date.now()
    setShown(null)
    const before = shift.current
    shift.current = null
    const scroller = document.querySelector('[data-conversation-scroll]')
    if (before === null || !scroller || reducedMotion()) return
    const delta = before - scroller.scrollTop
    if (delta > 0) scroller.querySelector('[data-chat-flow]')?.animate([{ transform: `translateY(${-delta}px)` }, { transform: 'none' }], { duration: 140, easing: 'cubic-bezier(.23,1,.32,1)' })
  }, [phase])
  // Cancelled tools never report a result, so their notes end with the run.
  useEffect(() => { if (!running) actions.clearLive(sessionId) }, [running, sessionId])
  // Only rows that take the activity row's place grow out of it.
  useRowEntrances(() => leaving.current || Date.now() - endedAt.current < 300)
  const host = useRunningHost(running || moveAt !== 0)
  if (!host || phase === null || !shown) return null
  return createPortal(h('div', { className: 'bt-typing', 'data-exiting': phase === 'out' ? '' : undefined, 'aria-hidden': true },
    bot ? h(BotMark, { bot, size: 28, state: markState.current, live: true, pokeable: true }) : h(RoomAvatar, { room, roster, size: 28 }),
    h('span', { className: 'bt-typing-text' },
      h('span', { key: `${shown.key}:${shown.at}`, className: 'bt-typing-label' }, h(Shimmer, null, `${shown.text}…`)),
      moveAt === 0 ? h('span', { className: 'bt-typing-time' }, ` · ${activityClockLabel(turnAt)}`) : null,
      h(Elapsed, { at: activityClockStart({ moveAt, turnAt, runAt: runAt.current }), className: 'bt-typing-time' }))), host)
}
