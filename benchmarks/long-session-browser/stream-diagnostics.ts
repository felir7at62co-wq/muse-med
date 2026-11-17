/** Bounded timing witnesses for synthetic stream ingress, DOM commits and rendering opportunities. */
import { performance as controllerPerformance } from 'node:perf_hooks'
import type { CDPSession, Page } from 'playwright'
import { FIRST, DONE } from './synthetic-history.ts'

const LIMIT = 32
const MAX_WIRE_NODES = 512
const MAX_WIRE_DEPTH = 12
const MAX_WIRE_CHARACTERS = 1024 * 1024

interface MarkerObservation {
  atMs: number
  first: boolean
  done: boolean
}

interface PageTimings {
  installedAtMs: number
  timeOriginMs: number
  visibility: string
  documentFocused: boolean
  firstPollAtMs: number | null
  enter: { atMs: number; eventAtMs: number; trusted: boolean; focused: boolean } | null
  domFirst: MarkerObservation | null
  domDone: MarkerObservation | null
  rafFirst: MarkerObservation | null
  rafDone: MarkerObservation | null
  raf: { count: number; maxGapMs: number; gaps: { atMs: number; gapMs: number }[]; droppedGaps: number }
  longTasks: { atMs: number; durationMs: number }[]
  droppedLongTasks: number
  longTasksSupported: boolean
  visibilityChanges: { atMs: number; visibility: string; focused: boolean }[]
  droppedVisibilityChanges: number
}

interface PageRecorder {
  data: PageTimings
  read(): PageTimings
  stop(): void
}

declare global {
  interface Window {
    /** Private to this benchmark's synthetic page; contains no transcript text. */
    __dshSyntheticStreamTimings?: PageRecorder
  }
}

/** One synthetic text-delta's existing Host timestamp and observed CDP ingress clocks. */
export interface WireMarkerTiming {
  marker: 'first' | 'done'
  providerTimeMs: number
  cdpReceivedAtSeconds: number
  controllerAtMs: number
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Extract only synthetic chunk marker timestamps, without retaining payload text.
 * @param payload - One text WebSocket frame received by CDP.
 * @param cdpReceivedAtSeconds - CDP's monotonic network-event timestamp.
 * @param controllerAtMs - Node performance.now when its listener runs.
 * @returns At most one timing per marker, plus whether traversal reached its bound.
 */
export function wireMarkerTimings(payload: string, cdpReceivedAtSeconds: number, controllerAtMs: number): {
  markers: WireMarkerTiming[]; truncated: boolean
} {
  if (payload.length > MAX_WIRE_CHARACTERS) return { markers: [], truncated: true }
  if (!payload.includes(FIRST) && !payload.includes(DONE)) return { markers: [], truncated: false }
  let parsed: unknown
  try { parsed = JSON.parse(payload) }
  catch { return { markers: [], truncated: false } }
  const markers: WireMarkerTiming[] = []
  const seen = new Set<string>()
  const pending = [{ value: parsed, depth: 0 }]
  let visited = 0, truncated = false
  while (pending.length > 0 && visited++ < MAX_WIRE_NODES) {
    const item = pending.pop()
    if (item === undefined) break
    const { value, depth } = item
    if (record(value) && value.type === 'chunk' && typeof value.time === 'number' && Number.isFinite(value.time)
      && record(value.chunk) && value.chunk.type === 'text-delta' && typeof value.chunk.text === 'string') {
      for (const [marker, text] of [['first', FIRST], ['done', DONE]] as const) {
        if (value.chunk.text.includes(text) && !seen.has(marker)) {
          seen.add(marker); markers.push({ marker, providerTimeMs: value.time, cdpReceivedAtSeconds, controllerAtMs })
        }
      }
    }
    const values: unknown[] = Array.isArray(value) ? value : record(value) ? Object.values(value) : []
    if (depth >= MAX_WIRE_DEPTH) { if (values.length > 0) truncated = true; continue }
    for (const child of values) {
      if (pending.length >= MAX_WIRE_NODES) { truncated = true; break }
      pending.push({ value: child, depth: depth + 1 })
    }
  }
  return { markers, truncated: truncated || pending.length > 0 }
}

/** Install passive bounded witnesses before the timed submission.
 * @param page - The real product page already holding the focused draft.
 * @param cdp - Its existing Chromium debugging session.
 * @returns A reader and disposer; ongoing recorder overhead remains inside the measured interval.
 */
export async function installStreamDiagnostics(page: Page, cdp: CDPSession): Promise<{
  snapshot(controllerStartedAtMs: number): Promise<{ page: PageTimings; wire: WireMarkerTiming[]; truncatedWireFrames: number; controllerStartedAtMs: number }>
  dispose(): Promise<void>
}> {
  const wire: WireMarkerTiming[] = []
  let truncatedWireFrames = 0
  const onFrame = (event: { timestamp: number; response: { opcode: number; payloadData: string } }) => {
    if (event.response.opcode !== 1 || wire.length === 2) return
    const found = wireMarkerTimings(event.response.payloadData, event.timestamp, controllerPerformance.now())
    if (found.truncated) truncatedWireFrames++
    for (const timing of found.markers) if (!wire.some(prior => prior.marker === timing.marker)) wire.push(timing)
  }
  cdp.on('Network.webSocketFrameReceived', onFrame)
  try {
    await cdp.send('Network.enable')
    await page.evaluate(({ first, done, limit }) => {
      window.__dshSyntheticStreamTimings?.stop()
      const data: PageTimings = {
        installedAtMs: performance.now(), timeOriginMs: performance.timeOrigin,
        visibility: document.visibilityState, documentFocused: document.hasFocus(), firstPollAtMs: null, enter: null,
        domFirst: null, domDone: null, rafFirst: null, rafDone: null,
        raf: { count: 0, maxGapMs: 0, gaps: [], droppedGaps: 0 },
        longTasks: [], droppedLongTasks: 0, longTasksSupported: PerformanceObserver.supportedEntryTypes.includes('longtask'),
        visibilityChanges: [], droppedVisibilityChanges: 0,
      }
      const markers = (): { first: boolean; done: boolean } => {
        const text = Array.from(document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')).at(-1)?.textContent ?? ''
        return { first: text.includes(first), done: text.includes(done) }
      }
      const mutation = new MutationObserver(() => {
        const state = markers(), observation = { atMs: performance.now(), ...state }
        if (state.first && data.domFirst === null) data.domFirst = observation
        if (state.done && data.domDone === null) data.domDone = observation
        if (data.domFirst !== null && data.domDone !== null) mutation.disconnect()
      })
      mutation.observe(document.body, { childList: true, characterData: true, subtree: true })
      const acceptTasks = (entries: readonly PerformanceEntry[]) => {
        for (const entry of entries) {
          if (data.longTasks.length < limit) data.longTasks.push({ atMs: entry.startTime, durationMs: entry.duration })
          else data.droppedLongTasks++
        }
      }
      const tasks = new PerformanceObserver(entries => acceptTasks(entries.getEntries()))
      if (data.longTasksSupported) tasks.observe({ type: 'longtask' })
      let frame = 0, previous: number | undefined, stopped = false
      const poll = (atMs: number) => {
        if (stopped) return
        data.raf.count++
        if (previous !== undefined) {
          const gapMs = atMs - previous
          data.raf.maxGapMs = Math.max(data.raf.maxGapMs, gapMs)
          if (gapMs >= 50) {
            if (data.raf.gaps.length < limit) data.raf.gaps.push({ atMs, gapMs })
            else data.raf.droppedGaps++
          }
        }
        previous = atMs
        const state = markers(), observation = { atMs: performance.now(), ...state }
        if (state.first && data.rafFirst === null) data.rafFirst = observation
        if (state.done && data.rafDone === null) data.rafDone = observation
        frame = requestAnimationFrame(poll)
      }
      frame = requestAnimationFrame(poll)
      const enter = (event: KeyboardEvent) => {
        if (event.key !== 'Enter' || data.enter !== null) return
        const composer = Array.from(document.querySelectorAll('[data-composer-input][contenteditable="true"]')).at(-1)
        data.enter = { atMs: performance.now(), eventAtMs: event.timeStamp, trusted: event.isTrusted,
          focused: document.activeElement === composer }
      }
      document.addEventListener('keydown', enter, true)
      const visibility = () => {
        if (data.visibilityChanges.length < limit) data.visibilityChanges.push({ atMs: performance.now(),
          visibility: document.visibilityState, focused: document.hasFocus() })
        else data.droppedVisibilityChanges++
      }
      document.addEventListener('visibilitychange', visibility)
      const stop = () => {
        stopped = true; cancelAnimationFrame(frame); mutation.disconnect(); tasks.disconnect()
        document.removeEventListener('keydown', enter, true)
        document.removeEventListener('visibilitychange', visibility)
      }
      window.__dshSyntheticStreamTimings = { data, stop, read: () => {
        acceptTasks(tasks.takeRecords())
        return data
      } }
    }, { first: FIRST, done: DONE, limit: LIMIT })
  } catch (error) {
    cdp.off('Network.webSocketFrameReceived', onFrame)
    throw error
  }
  return {
    async snapshot(controllerStartedAtMs) {
      const data = await page.evaluate(() => {
        const recorder = window.__dshSyntheticStreamTimings
        if (recorder === undefined) throw new Error('Synthetic stream diagnostics are not installed')
        return recorder.read()
      })
      return { page: data, wire: [...wire], truncatedWireFrames, controllerStartedAtMs }
    },
    async dispose() {
      cdp.off('Network.webSocketFrameReceived', onFrame)
      await page.evaluate(() => {
        window.__dshSyntheticStreamTimings?.stop()
        delete window.__dshSyntheticStreamTimings
      })
    },
  }
}
