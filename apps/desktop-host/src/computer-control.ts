/** Desktop input ownership, physical-user interruption, and shell status publication. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { PhysicalInputMonitor } from './computer-input-monitor.ts'

/** Content-free status displayed by the Electron shell. */
export type ComputerControlState = 'active' | 'paused' | 'idle'

const PREFIX = 'mcp__muse-computer__'
const PAUSED = 'COMPUTER_USE_PAUSED_USER_INPUT: 检测到你正在使用鼠标或键盘，电脑操作已暂停。请在会话中回复后再继续。Do not retry, relaunch, or use shell input to bypass this pause. An in-flight action may have partially completed; inspect fresh state after the user resumes.'
const ENDED = 'COMPUTER_USE_ENDED: 本次电脑操作已退出，提示框已关闭。Stop computer work and report that control was released. Do not resume without a fresh user instruction.'
const UNAVAILABLE = 'COMPUTER_USE_OBSERVER_UNAVAILABLE: Physical input observation is unavailable. Computer input is paused; do not bypass it using another tool.'

/** Send shell state and require an acknowledgement before input starts.
 * @returns Publisher and async-safe listener cleanup.
 */
export function createComputerStatePublisher(): {
  publish(state: ComputerControlState): Promise<void>
  close(): void
} {
  let nextId = 0
  const pending = new Map<number, { resolve(): void; reject(error: Error): void }>()
  const receive = (message: unknown): void => {
    if (typeof message !== 'object' || message === null || !('type' in message)
      || message.type !== 'computer-use-state-ready' || !('requestId' in message)
      || typeof message.requestId !== 'number' || !('ok' in message) || typeof message.ok !== 'boolean') return
    const item = pending.get(message.requestId)
    if (message.ok) item?.resolve()
    else item?.reject(new Error('Computer-use indicator could not be displayed'))
  }
  process.on('message', receive)
  return {
    async publish(state) {
      if (!process.connected || process.send === undefined) throw new Error('Computer-use Desktop status channel is unavailable')
      const requestId = ++nextId
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await new Promise<void>((resolve, reject) => {
          pending.set(requestId, { resolve, reject })
          timer = setTimeout(() => { reject(new Error('Computer-use indicator acknowledgement timed out')) }, 5_000)
          process.send?.({ type: 'computer-use-state', requestId, state }, (error) => {
            if (error !== null) reject(error)
          })
        })
      } finally { clearTimeout(timer); pending.delete(requestId) }
    },
    close() {
      process.off('message', receive)
      for (const item of pending.values()) item.reject(new Error('Computer-use status channel closed'))
      pending.clear()
    },
  }
}

/** Install single-owner input admission and a pause latch cleared only by fresh human input.
 * @param ctx - Desktop plugin scope.
 * @param monitor - Content-free Windows physical activity observation.
 * @param publish - Shell indicator acknowledgement.
 * @returns Cleanup that releases callbacks and cancels owned pending input.
 */
export function installComputerControl(
  ctx: Context,
  monitor: PhysicalInputMonitor,
  publish: (state: ComputerControlState) => Promise<void>,
): () => void {
  let owner: Agent | undefined
  let epoch = 0
  let escapeEpoch = monitor.sample().escapeEpoch
  let dismissed = false
  let indicatorReady: Promise<void> | undefined
  let paused: string | undefined
  const pauseReason = (): string | undefined => paused
  let inFlight: AbortController | undefined
  let disposed = false
  const affected = (exec: ToolExecution): boolean => exec.name.startsWith(PREFIX) && exec.name !== PREFIX + 'end_session'
  const show = (state: ComputerControlState): void => {
    void publish(state).catch((_error: unknown) => {
      if (state === 'active') pause(UNAVAILABLE)
    })
  }
  const pause = (reason: string): void => {
    if (paused !== undefined || disposed) return
    paused = reason
    inFlight?.abort(new Error(reason))
    show('paused')
  }
  const end = (): void => {
    if (disposed) return
    dismissed = true
    paused = ENDED
    inFlight?.abort(new Error(ENDED))
    show('idle')
  }
  const observe = (): void => {
    if (disposed) return
    const current = monitor.sample()
    if (current.escapeEpoch !== escapeEpoch) {
      escapeEpoch = current.escapeEpoch
      if (owner !== undefined || paused !== undefined) end()
    }
    if (owner === undefined || dismissed) return
    if (!current.available) pause(UNAVAILABLE)
    else if (current.epoch !== epoch) pause(PAUSED)
  }
  const unsubscribe = monitor.subscribe(observe)
  const heartbeat = setInterval(observe, 100)
  heartbeat.unref()
  ctx.on('agent/inbox/claimed', ({ message }) => {
    // A generated follow-up, subagent dispatch, or elapsed timeout cannot resume input.
    if (owner === undefined && message.source.kind === 'user') {
      paused = undefined
      dismissed = false
      escapeEpoch = monitor.sample().escapeEpoch
      show('idle')
    }
  })
  ctx.on('agent/status', ({ agent, status }) => {
    if (agent !== owner || status !== 'idle') return
    owner = undefined
    show(paused === undefined || dismissed ? 'idle' : 'paused')
  })
  ctx.on('agent/disposed', ({ agent }) => {
    if (agent !== owner) return
    inFlight?.abort(new Error('Computer-use agent disposed'))
    owner = undefined
    show(paused === undefined || dismissed ? 'idle' : 'paused')
  })
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === PREFIX + 'end_session' && owner !== undefined && owner !== exec.agent) {
      return { kind: 'deny', reason: 'COMPUTER_USE_BUSY: Only the owning Agent can release this desktop session.' }
    }
    if (!affected(exec)) return next()
    if (disposed) return { kind: 'deny', reason: UNAVAILABLE }
    observe()
    if (paused !== undefined) return { kind: 'deny', reason: paused }
    const current = monitor.sample()
    if (!current.available) return { kind: 'deny', reason: UNAVAILABLE }
    if (current.idleMs < 500) {
      pause(PAUSED)
      return { kind: 'deny', reason: PAUSED }
    }
    if (exec.agent === undefined) return { kind: 'deny', reason: 'Computer input requires a live Muse Agent session.' }
    if (owner !== undefined && owner !== exec.agent) {
      return { kind: 'deny', reason: 'COMPUTER_USE_BUSY: Another Muse Agent owns this desktop. Wait for it to finish; do not run competing input.' }
    }
    if (owner === undefined) {
      owner = exec.agent
      epoch = current.epoch
      indicatorReady = publish('active').catch((_error: unknown) => { pause(UNAVAILABLE) })
    }
    await indicatorReady
    observe()
    const reason = pauseReason()
    if (reason !== undefined) return { kind: 'deny', reason }
    return next()
  })
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name === PREFIX + 'end_session') end()
    if (!affected(exec)) return next()
    observe()
    if (paused !== undefined) throw new Error(paused)
    if (inFlight !== undefined) throw new Error('COMPUTER_USE_BUSY: A computer action is still settling.')
    const controller = new AbortController()
    const original = exec.signal
    inFlight = controller
    exec.signal = AbortSignal.any([original, controller.signal])
    try { return await next() }
    finally { exec.signal = original; if (inFlight === controller) inFlight = undefined }
  })
  ctx.on('tools/post-execute', async (exec, _result, next) => {
    if (affected(exec) && paused !== undefined) {
      return { kind: 'block', feedback: [{ type: 'text', text: paused }] }
    }
    return next()
  })
  return () => {
    disposed = true
    clearInterval(heartbeat)
    unsubscribe()
    inFlight?.abort(new Error('Computer-use control closed'))
    owner = undefined
    show('idle')
  }
}
