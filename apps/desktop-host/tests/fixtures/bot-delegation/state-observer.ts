/** Read canonical Session events rather than Bot self-reported completion. */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'

/** Return the actual Main Session's canonical events. */
export function mainEvents(ctx: Context) {
  const session = ctx.sessions.get(SessionId('delegation-main'))
  if (session === undefined) throw new Error('Real Main Session not loaded')
  return session.snapshotEvents()
}

/** Return committed todo snapshots, including the unfinished range. */
export function todoSnapshots(ctx: Context) {
  return mainEvents(ctx).filter(event => event.type === 'todo/write').map(event => event.data.todos)
}
