/** Named-profile wire fixture with a deliberately foreign current guardian PID. */
import { bindGuardianInput } from '../../src/episode-guardian-protocol.ts'
import { guardianParsers } from '../../src/episode-guardian-journal.ts'

export const name = 'episode-guardian-wire-fixture'
export const inject = ['appReady', 'appExit']

/** Own the test-only request pipe and emit one complete malformed semantic reply. */
export function apply(ctx) {
  const transport = bindGuardianInput(process.stdin, 4096, guardianParsers.parseRequest)
  const ready = new Promise(resolve => { ctx.effect(() => ctx.appReady.onReady(resolve)) })
  let settled = Promise.resolve()
  ctx.effect(() => async () => { transport.cancel(); await settled; transport.dispose() })
  settled = (async () => {
    const request = await transport.request; await ready
    const proof = { version: 1, kind: 'drained', identity: request.identity, guardianPid: process.pid + 1,
      commands: 0, result: 'failed' }
    await new Promise((resolve, reject) => {
      process.stdout.write(JSON.stringify({ version: 1, kind: 'result', identity: request.identity,
        result: { kind: 'drained', proof } }) + '\n', error => { if (error) reject(error); else resolve() })
    })
    ctx.appExit(0)
  })().catch(() => { ctx.appExit(1) })
}
