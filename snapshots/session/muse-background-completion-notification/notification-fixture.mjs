/** Live completed-Session notification policy with only native notification and window devices replaced. */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { importSnapshotModule } from '../muse-fixture-import.mjs'

const { attentionSoundForEvent } = await importSnapshotModule(
  new URL('../../../apps/desktop-host/src/attention-sound.ts', import.meta.url),
  new URL('../../../apps/desktop-host/lib/types/attention-sound.js', import.meta.url),
)
const { DesktopCompletionNotice } = await importSnapshotModule(
  new URL('../../../apps/desktop/src/completion-notice.ts', import.meta.url),
  new URL('../../../apps/desktop/lib/types/completion-notice.js', import.meta.url),
)
const { resolveDesktopLocale } = await importSnapshotModule(
  new URL('../../../apps/desktop/src/locale.ts', import.meta.url),
  new URL('../../../apps/desktop/lib/types/locale.js', import.meta.url),
)

export const name = 'snapshot-background-completion-notification'

function nativeBoundary(foreground) {
  const focus = new EventEmitter()
  const window = new EventEmitter()
  window.isDestroyed = () => false
  window.webContents = new EventEmitter()
  window.webContents.isDestroyed = () => false
  const notices = []
  let returns = 0
  const controller = new DesktopCompletionNotice(() => resolveDesktopLocale('en'), () => { returns++ }, {
    isSupported: () => true,
    isForeground: () => foreground,
    create(options) {
      const notification = new EventEmitter()
      const observed = { options, showCount: 0, closeCount: 0 }
      notification.show = () => { observed.showCount++ }
      notification.close = () => { observed.closeCount++ }
      notices.push({ notification, observed })
      return notification
    },
    onFocus(listener) {
      focus.on('focus', listener)
      return () => { focus.off('focus', listener) }
    },
  })
  return {
    controller, window, notices,
    returnCount: () => returns,
    observation: () => ({
      notices: notices.map(({ notification, observed }) => ({
        ...observed,
        remainingListeners: notification.eventNames().reduce((count, event) => count + notification.listenerCount(event), 0),
      })),
      returnToMuseCount: returns,
      focusListeners: focus.listenerCount('focus'),
      windowListeners: window.listenerCount('closed'),
      navigationListeners: window.webContents.listenerCount('did-start-navigation'),
    }),
  }
}

/** @param {import('@deepseek-ai/cordis').Context} ctx - Shipped Headless Loader context. */
export function apply(ctx) {
  const background = nativeBoundary(false)
  const foreground = nativeBoundary(true)
  const disposedBackground = nativeBoundary(false)
  const cues = []
  let completedSession
  let failure
  let finalized = false
  const detach = ctx.on('session/event', (session, event) => {
    const kind = attentionSoundForEvent(session.header, event)
    if (kind !== 'complete') return
    try {
      cues.push({ kind, eventType: event.type, turn: event.data.turn })
      completedSession = session
      background.controller.show(background.window)
      foreground.controller.show(foreground.window)
      disposedBackground.controller.show(disposedBackground.window)
    } catch (error) { failure = error }
    queueMicrotask(finish)
  })
  function finish() {
    if (finalized) return
    finalized = true
    detach()
    let late
    let detachLate
    let historicalCompletedTurns
    let lateClickIgnored
    try {
      if (failure !== undefined) throw failure
      assert.equal(cues.length, 1, 'One real root completion reaches each window state once')
      assert.equal(background.notices.length, 1)
      assert.equal(foreground.notices.length, 0)
      assert.equal(disposedBackground.notices.length, 1)
      const notification = background.notices[0].notification
      const queuedClick = notification.listeners('click')[0]
      assert.equal(typeof queuedClick, 'function')
      notification.emit('close')
      assert.equal(background.notices[0].observed.closeCount, 0, 'A dismissed banner remains clickable in the notification center')
      notification.emit('click')
      assert.equal(background.returnCount(), 1)
      queuedClick()
      assert.equal(background.returnCount(), 1, 'A queued click cannot activate an already cleared notice')

      historicalCompletedTurns = completedSession.snapshotEvents().filter(event =>
        event.type === 'turn/end' && event.data.reason.kind === 'completed').length
      assert.equal(historicalCompletedTurns, 1)
      late = nativeBoundary(false)
      detachLate = ctx.on('session/event', (session, event) => {
        if (attentionSoundForEvent(session.header, event) === 'complete') late.controller.show(late.window)
      })
      assert.equal(late.notices.length, 0, 'Attaching after completion does not replay the completed Session')
      background.controller.dispose()
      background.controller.dispose()
      queuedClick()
      lateClickIgnored = background.returnCount() === 1
      assert.equal(lateClickIgnored, true)
      const disposedClick = disposedBackground.notices[0].notification.listeners('click')[0]
      assert.equal(typeof disposedClick, 'function')
      disposedBackground.controller.dispose()
      disposedClick()
      assert.equal(disposedBackground.returnCount(), 0, 'Disposal invalidates a queued native click')
    } finally {
      detachLate?.()
      background.controller.dispose()
      foreground.controller.dispose()
      disposedBackground.controller.dispose()
      late?.controller.dispose()
    }
    writeFileSync(join(process.cwd(), 'notification-probe.json'), JSON.stringify({
      cues, background: background.observation(), foreground: foreground.observation(),
      disposedBackground: disposedBackground.observation(),
      historicalCompletedTurns, late: late.observation(), lateClickIgnored,
    }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  }
  ctx.effect(() => () => {
    detach()
    background.controller.dispose()
    foreground.controller.dispose()
    disposedBackground.controller.dispose()
  }, 'close native completion notice fixtures')
}
