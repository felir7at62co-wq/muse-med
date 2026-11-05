/** Ordinary named-profile Host fixture; its stdin owns the guardian lifetime. */
import { launchGuardian } from '../../src/episode-guardian-launcher.ts'
import { guardianParsers } from '../../src/episode-guardian-journal.ts'

export const name = 'episode-guardian-host-fixture'
export const inject = ['appReady', 'appExit']

/** Own preparation, the raw child, and all close/result observations. */
export function apply(ctx, config) {
  const children = new Set()
  let guardian
  let closing = false
  let settled = Promise.resolve()
  const stop = () => { closing = true; guardian?.stop() }
  process.stdin.once('end', stop)
  process.stdin.once('close', stop)
  process.stdin.resume()
  ctx.effect(() => async () => {
    stop(); await settled
    for (const child of children) child.stdin.end()
    await Promise.all([...children].map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve()
      : new Promise(resolve => { child.once('close', resolve) })))
    process.stdin.off('end', stop); process.stdin.off('close', stop); process.stdin.pause()
  })
  ctx.effect(() => ctx.appReady.onReady(() => {
    settled = (async () => {
      guardian = await launchGuardian({ ...config, parsers: guardianParsers, rawChildren: children })
      if (closing) guardian.stop()
      console.log(JSON.stringify({ kind: 'guardian-started', pid: guardian.pid }))
      const [reply, closed] = await Promise.allSettled([guardian.result, guardian.closed])
      console.log(JSON.stringify({ kind: 'guardian-closed', reply: reply.status === 'fulfilled' ? reply.value : 'rejected',
        closed: closed.status === 'fulfilled' ? closed.value : 'rejected', diagnostic: guardian.diagnostic() }))
      ctx.appExit(closed.status === 'fulfilled' && closed.value.code === 0 ? 0 : 1)
    })().catch(error => { console.error(error); ctx.appExit(1) })
  }))
}
