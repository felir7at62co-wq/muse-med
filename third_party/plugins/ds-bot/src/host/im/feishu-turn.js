// Preserve the text reply path. Progress and speech are independently best-effort.
const PROGRESS_INTERVAL_MS = 3_000
const INTRO_DELAY_MS = 5_000

/** Observe only confirmed tool activity from the Feishu-originated turn. */
export function createFeishuTurn({ mode, voice, isCurrent, sendProgress, t, warn, signal }) {
  const activeTools = new Set()
  let completed = 0
  let shown
  let timer
  let progressMessage
  let pending = false
  let stopped = false
  let progressUnavailable = false
  let outcome
  let lastReply
  const abortSignal = signal
  const active = () => !abortSignal?.aborted && isCurrent()
  const clearTimer = () => {
    clearTimeout(timer)
    timer = undefined
  }
  const cancel = () => {
    stopped = true
    clearTimer()
    abortSignal?.removeEventListener('abort', cancel)
  }

  const caption = () => outcome === undefined
    ? activeTools.size || completed ? t('feishuWorking', { active: activeTools.size, completed }) : t('feishuStarted')
    : t(outcome === 'success' ? 'feishuDone' : outcome === 'cancelled' ? 'feishuStopped' : 'feishuFailed')

  const show = async () => {
    timer = undefined
    if (stopped || progressUnavailable || pending || !active()) return
    const next = caption()
    if (next === shown || (outcome !== undefined && shown === undefined)) return
    pending = true
    shown = next
    try {
      progressMessage = await sendProgress(next, { messageId: mode === 'post' ? undefined : progressMessage, mode })
    } catch {
      // A provider timeout may still have created the message. Do not create another.
      progressUnavailable = true
      warn()
    } finally {
      pending = false
      if (!stopped && caption() !== shown) queue(outcome === undefined ? PROGRESS_INTERVAL_MS : 0)
    }
  }

  const queue = delay => {
    if (!mode || timer !== undefined || pending || stopped || progressUnavailable) return
    timer = setTimeout(() => { void show() }, delay)
    timer.unref?.()
  }

  const speak = entry => {
    if (stopped || !voice || lastReply !== entry || !entry.delivered || outcome !== 'success' || !active()) return
    lastReply = undefined
    void voice.reply(entry.body).catch(warn)
  }

  abortSignal?.addEventListener('abort', cancel, { once: true })
  queue(INTRO_DELAY_MS)
  return {
    cancel,
    observe(event) {
      if (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') {
        const id = event.data?.subCallId ?? event.data?.callId
        if (typeof id === 'string') activeTools.add(id)
      } else if (event.type === 'tool/result' || event.type === 'tool/ptc-dispatch') {
        const id = event.data?.subCallId ?? event.data?.callId
        if (activeTools.delete(id)) completed += 1
      } else {
        return
      }
      if (shown === undefined) clearTimer()
      queue(shown === undefined ? 0 : PROGRESS_INTERVAL_MS)
    },
    reply(body) {
      if (!voice || stopped || !body.trim()) return undefined
      const entry = { body, delivered: false }
      lastReply = entry
      return receipt => {
        if (!receipt?.messageId) return
        entry.delivered = true
        speak(entry)
      }
    },
    finish(status) {
      outcome = status ?? 'success'
      abortSignal?.removeEventListener('abort', cancel)
      clearTimer()
      if (shown !== undefined) queue(0)
      if (lastReply !== undefined) speak(lastReply)
    },
  }
}
