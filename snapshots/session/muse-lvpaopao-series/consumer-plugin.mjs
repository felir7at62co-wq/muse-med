/** Load the real Agent-scoped consumer and complete series executor. */
import { importLvpaopaoSnapshot } from '../muse-lvpaopao/plugin-import.mjs'
import { importSnapshotPackage } from '../muse-fixture-import.mjs'
const plugin = await importLvpaopaoSnapshot('index')
const { SessionId } = await importSnapshotPackage('@deepseek-ai/dsh-session', new URL('../../../apps/cli/package.json', import.meta.url))
export const { name, Config } = plugin
/** Preserve actual durable task ownership through the supported Headless resume path. */
export const inject = [...plugin.inject, 'sessions', 'sessionPersistence']

/**
 * Prepare a real persisted owner before registering the production series consumer.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Isolated Headless context.
 * @param {object} config - Resolved production plugin limits.
 * @returns {Promise<void>} Completion after persistence and registrations are ready.
 */
export async function apply(ctx, config) {
  const prepared = ctx.sessions.prepare(SessionId('snapshot-lvpaopao-series'), { meta: {
    cwd: process.cwd(), createdAt: Date.parse('2026-11-04T15:00:00.000Z'), delegationDepth: 0,
  } })
  const handle = await ctx.sessionPersistence.create(prepared.header)
  try { await handle.flush() }
  finally { await handle.close() }
  await plugin.apply(ctx, config)
  ctx.effect(() => ctx.provide('snapshotLvpaopaoSeriesReady', true))
}
