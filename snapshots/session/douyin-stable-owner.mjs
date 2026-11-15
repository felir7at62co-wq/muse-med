/** Persist a real replay owner before the supported Headless resume path derives durable task identities. */
import { importSnapshotPackage } from './muse-fixture-import.mjs'

const { SessionId } = await importSnapshotPackage('@deepseek-ai/dsh-session', new URL('../../apps/cli/package.json', import.meta.url))

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - Fixture with the real Session factory and persistence provider.
 * @param {string} id - Scenario-owned identity inside its private Harness home.
 * @returns {Promise<void>} Completion after the validated header is flushed and its write lease is closed.
 */
export async function persistDouyinReplayOwner(ctx, id) {
  const session = ctx.sessions.prepare(SessionId(id), { meta: {
    cwd: process.cwd(), createdAt: Date.parse('2026-11-04T15:00:00.000Z'), delegationDepth: 0,
  } })
  const handle = await ctx.sessionPersistence.create(session.header)
  try { await handle.flush() }
  finally { await handle.close() }
}
