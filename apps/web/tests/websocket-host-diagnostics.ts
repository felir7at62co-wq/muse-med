/** Bounded Host WebSocket observations for browser connection-failure diagnostics. */
import { performance } from 'node:perf_hooks'
import { vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'

const MAX_SOCKETS = 8
const MAX_EVENTS = 32
const MAX_STACK_LINES = 8
const MAX_STACK_LINE_CHARS = 384
const CLOSE_REASONS = new Set([
  '', 'peer left', 'text messages required', 'invalid Remote stream request',
  'Remote stream failure could not be delivered',
])

interface SocketObservation {
  readonly id: number
  readonly openedAtMs: number
  pingQueued: number
  pingWritten: number
  pingWriteErrors: number
  pongReceived: number
  applicationMessages: number
  lastPingQueuedAtMs: number | null
  lastPingWrittenAtMs: number | null
  lastPongAtMs: number | null
  lastApplicationMessageAtMs: number | null
  closeCode: number | null
  closeReason: string | null
}

interface CloseObservation {
  readonly socketId: number
  readonly kind: 'terminate' | 'close'
  readonly atMs: number
  readonly code: number | null
  readonly reason: string | null
  readonly readyState: number
  readonly bufferedAmount: number
  readonly stack: readonly string[]
}

/** Scoped observations; restore only after the owning Host has finished closing. */
export interface WebSocketHostDiagnostics {
  /** Count of real Host upgrades observed by this worker, including truncated sockets. */
  readonly socketCount: number
  /**
   * Render bounded transport metadata without frame bodies, request URLs, or credentials.
   * @returns JSON containing observed sockets, closure callers, and truncation counts.
   */
  format(): string
  /** Remove owned hooks and listeners after browser and Host cleanup reaches quiescence. */
  restore(): void
}

/**
 * Observe this worker's real `ws` upgrades without changing carrier timing or protocol settings.
 * The caller owns the returned restoration for the complete scaffold lifetime.
 * @returns bounded observations and an idempotent restoration.
 */
export function observeHostWebSockets(): WebSocketHostDiagnostics {
  const start = performance.now()
  const elapsed = (): number => Math.round((performance.now() - start) * 1000) / 1000
  const sockets: SocketObservation[] = []
  const events: CloseObservation[] = []
  const restoreSockets: (() => void)[] = []
  let socketCount = 0
  let truncatedEvents = 0
  let restored = false

  const reasonOf = (reason: string | Buffer | undefined): string | null => {
    if (reason === undefined) return null
    const text = typeof reason === 'string' ? reason : reason.toString('utf8')
    return CLOSE_REASONS.has(text) ? text : 'unrecognized close reason'
  }
  const observe = (socket: WebSocket): void => {
    socketCount++
    if (sockets.length >= MAX_SOCKETS) return
    const state: SocketObservation = {
      id: socketCount, openedAtMs: elapsed(), pingQueued: 0, pingWritten: 0, pingWriteErrors: 0,
      pongReceived: 0, applicationMessages: 0, lastPingQueuedAtMs: null, lastPingWrittenAtMs: null,
      lastPongAtMs: null, lastApplicationMessageAtMs: null, closeCode: null, closeReason: null,
    }
    sockets.push(state)
    const recordClose = (kind: CloseObservation['kind'], code?: number, reason?: string | Buffer): void => {
      if (events.length >= MAX_EVENTS) { truncatedEvents++; return }
      events.push({
        socketId: state.id, kind, atMs: elapsed(), code: code ?? null, reason: reasonOf(reason),
        readyState: socket.readyState, bufferedAmount: socket.bufferedAmount,
        stack: (new Error(`WebSocket ${kind} owner`).stack ?? '').split('\n').slice(1, MAX_STACK_LINES + 1)
          .map(line => line.slice(0, MAX_STACK_LINE_CHARS)),
      })
    }
    const onPong = (): void => { state.pongReceived++; state.lastPongAtMs = elapsed() }
    const onMessage = (): void => { state.applicationMessages++; state.lastApplicationMessageAtMs = elapsed() }
    const onClose = (code: number, reason: Buffer): void => {
      state.closeCode = code
      state.closeReason = reasonOf(reason)
    }
    socket.on('pong', onPong)
    restoreSockets.push(() => { socket.off('pong', onPong) })
    socket.on('message', onMessage)
    restoreSockets.push(() => { socket.off('message', onMessage) })
    socket.on('close', onClose)
    restoreSockets.push(() => { socket.off('close', onClose) })

    const ping = socket.ping.bind(socket)
    const pingSpy = vi.spyOn(socket, 'ping').mockImplementation((data: unknown, mask, callback) => {
      state.pingQueued++
      state.lastPingQueuedAtMs = elapsed()
      const shorthand = typeof data === 'function'
      const supplied = shorthand ? data : callback
      ping(shorthand ? undefined : data, shorthand ? undefined : mask, (error) => {
        if (error == null) { state.pingWritten++; state.lastPingWrittenAtMs = elapsed() }
        else state.pingWriteErrors++
        supplied?.(error)
      })
    })
    restoreSockets.push(() => { pingSpy.mockRestore() })
    const terminate = socket.terminate.bind(socket)
    const terminateSpy = vi.spyOn(socket, 'terminate').mockImplementation(() => {
      recordClose('terminate')
      terminate()
    })
    restoreSockets.push(() => { terminateSpy.mockRestore() })
    const close = socket.close.bind(socket)
    const closeSpy = vi.spyOn(socket, 'close').mockImplementation((code, reason) => {
      recordClose('close', code, reason)
      close(code, reason)
    })
    restoreSockets.push(() => { closeSpy.mockRestore() })
  }

  const prototype: WebSocketServer = WebSocketServer.prototype
  // oxlint-disable-next-line typescript/unbound-method -- Every upgrade uses the intercepted server's receiver.
  const handleUpgrade = prototype.handleUpgrade
  const upgradeSpy = vi.spyOn(prototype, 'handleUpgrade').mockImplementation(function (
    this: WebSocketServer, request, socket, head, callback,
  ) {
    handleUpgrade.call(this, request, socket, head, (accepted, admittedRequest) => {
      observe(accepted)
      callback(accepted, admittedRequest)
    })
  })
  return {
    get socketCount(): number { return socketCount },
    format: () => JSON.stringify({ socketCount, truncatedSockets: socketCount - sockets.length, truncatedEvents, sockets, events }),
    restore: () => {
      if (restored) return
      restored = true
      upgradeSpy.mockRestore()
      for (const restore of restoreSockets.reverse()) restore()
    },
  }
}
