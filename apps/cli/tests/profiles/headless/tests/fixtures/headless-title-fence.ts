/** Keep auxiliary title publication ahead of the parent stream in replay fixtures. */
import type { Context } from '@deepseek-ai/cordis'
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm'

/** Loader identity for the headless replay fixture. */
export const name = 'headless-title-fence'

/** Services that identify the first root-session model request. */
export const inject = ['sessions', 'llm']

/**
 * Wait for the replayed provider title before allowing the parent stream.
 * @param ctx - context of a replay with one root session.
 */
export function apply(ctx: Context): void {
  const accepted = Promise.withResolvers<undefined>()
  let published = false
  ctx.effect(() => {
    const disposeEvent = ctx.root.on('session/event', (session, event) => {
      if (session.header.parentSession === undefined && event.type === 'session/title' && event.data.source.kind === 'provider') {
        published = true
        accepted.resolve(undefined)
      }
    })
    const disposeStream = ctx.root.on('llm/stream', async function* (options, next) {
      if (!published && options.sessionId !== undefined && isAgentLoopRequest(options)) {
        const session = ctx.sessions.get(options.sessionId)
        if (session !== undefined && session.header.parentSession === undefined) {
          await accepted.promise
          options.signal?.throwIfAborted()
        }
      }
      yield* next()
    }, { global: true })
    return () => {
      disposeStream()
      disposeEvent()
      accepted.resolve(undefined)
    }
  }, 'headless-title-fence.listeners')
}
