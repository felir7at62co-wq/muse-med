import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionSkillCatalog } from '@deepseek-ai/dsh-api-session-controller/src/skill-catalog.ts'
import { join } from 'node:path'
import { rename } from 'node:fs/promises'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import MuseMarket from '../src/index.ts'
import MuseMarketActivation from '../src/activation.ts'
import { createMarketPackage } from '../src/package.ts'
import { MuseMarketLocal } from '../src/local.ts'
import { directory, limits, manifest, resources } from './fixtures.ts'

class PointQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> { return Promise.reject(new Error('Search is not used')) }
  override searchEvents(): Promise<never> { return Promise.reject(new Error('Search is not used')) }
}
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture() {
  const files = await directory(); cleanups.push(files.cleanup)
  const ctx = new Context(); cleanups.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(SkillRegistry).await(); await ctx.plugin(PointQuery).await()
  await ctx.plugin(MuseMarket, { root: join(files.root, 'market'), ...limits }).await()
  const activation = ctx.plugin(MuseMarketActivation); await activation.await()
  const service = ctx.get('museMarketActivation'), market = ctx.get('museMarket'), skills = ctx.get('skills')
  if (service === undefined || market === undefined || skills === undefined) throw new Error('Missing actual providers')
  const first = await market.importPackage(Buffer.from(createMarketPackage(manifest, resources, limits)).toString('base64'))
  const second = await market.importPackage(Buffer.from(createMarketPackage({ ...manifest, version: '2.0.0' }, resources, limits)).toString('base64'))
  await service.setDefault({ skillName: 'fixture-skill', expected: null, target: first.release.id })
  const harness = await mountAgentLoopTestHarness(ctx)
  return { ctx, files, activation, service, market, skills, first, second, harness }
}

describe('activation-owned Session Skill views', () => {
  it('retires scoped providers on activation unload while the actual Agent remains alive', async () => {
    const f = await fixture(), agent = await f.harness.create(SessionId('market-live'))
    expect((await f.skills.get('fixture-skill', { scope: agent }))?.source).toBe('muse-market')
    await f.activation.dispose()
    expect(f.ctx.agents.get(agent.id)).toBe(agent)
    expect(await f.skills.list({ scope: agent })).toEqual([])
    await f.activation.dispose()
    await agent.ctx.fiber.dispose()
  })

  it('allows an Agent to close before activation without retaining its provider', async () => {
    const f = await fixture(), agent = await f.harness.create(SessionId('market-close-first'))
    expect(await f.skills.list({ scope: agent })).toHaveLength(1)
    await agent.ctx.fiber.dispose()
    expect(await f.skills.list({ scope: agent })).toEqual([])
    await f.activation.dispose()
  })

  it('invalidates blank views on a default switch while preserving an executed selection', async () => {
    const f = await fixture(), old = await f.harness.create(SessionId('bound-v1')), blank = await f.harness.create(SessionId('blank-v2'))
    const selected = await f.service.binding({ sessionId: old.id })
    old.session.append('muse-market/bound', { releases: selected.releases })
    expect((await f.skills.list({ scope: blank }))[0]?.path).toContain(f.first.release.id)
    await f.service.setDefault({ skillName: 'fixture-skill', expected: f.first.release.id, target: f.second.release.id })
    expect((await f.skills.list({ scope: blank }))[0]?.path).toContain(f.second.release.id)
    expect((await f.skills.list({ scope: old }))[0]?.path).toContain(f.first.release.id)
  })

  it('reconstructs a persisted cold binding after live state is absent and global defaults changed', async () => {
    const f = await fixture()
    await f.ctx.plugin(Jsonl, { root: join(f.files.root, 'sessions'), compression: 'none' }).await()
    const session = Session.create(SessionId('persisted-v1'))
    const local = new MuseMarketLocal({ root: join(f.files.root, 'market'), limits })
    session.append('muse-market/bound', { releases: await local.captureDefaults() })
    const writer = await f.ctx.sessionPersistence.create(session.header)
    try { await writer.append(session.snapshotEvents()); await writer.flush() } finally { await writer.close() }
    await f.service.setDefault({ skillName: 'fixture-skill', expected: f.first.release.id, target: f.second.release.id })
    expect(f.ctx.sessions.get(session.id)).toBeUndefined()
    expect(f.ctx.agents.get(session.id)).toBeUndefined()
    expect((await f.service.binding({ sessionId: session.id })).releases[0]?.release.id).toBe(f.first.release.id)
    const catalog = new SessionSkillCatalog(f.ctx)
    expect((await catalog.list({ sessionId: session.id }, new AbortController().signal)).skills[0]?.path).toContain(f.first.release.id)
    expect(await f.skills.list()).toEqual([])
  })

  it('serves an inactive Session from its recorded version and removes only its temporary registrations', async () => {
    const f = await fixture(), session = f.ctx.sessions.create(SessionId('cold-v1'))
    const selected = await f.service.binding({ sessionId: session.id })
    session.append('muse-market/bound', { releases: selected.releases })
    await f.service.setDefault({ skillName: 'fixture-skill', expected: f.first.release.id, target: f.second.release.id })
    expect(f.ctx.agents.get(session.id)).toBeUndefined()
    const catalog = new SessionSkillCatalog(f.ctx)
    const result = await catalog.list({ sessionId: session.id }, new AbortController().signal)
    expect(result.skills).toHaveLength(1)
    expect(result.skills[0]?.path).toContain(f.first.release.id)
    expect(await f.skills.list()).toEqual([])
    await rename(join(f.files.root, 'market', 'packages', f.first.release.id), join(f.files.root, 'missing-cache'))
    expect((await catalog.list({ sessionId: session.id }, new AbortController().signal)).skills[0]?.path).toContain(f.first.release.id)
    expect(await f.skills.list()).toEqual([])
    const during = new AbortController()
    const off = f.ctx.on('session-skills/prepare-view', async () => { during.abort(new Error('Stopped during preparation')) })
    try {
      await expect(catalog.list({ sessionId: session.id }, during.signal)).rejects.toThrow('Stopped during preparation')
      expect(await f.skills.list()).toEqual([])
    } finally { off() }
    const aborted = new AbortController(); aborted.abort(new Error('Caller left'))
    await expect(catalog.list({ sessionId: session.id }, aborted.signal)).rejects.toThrow('Caller left')
    expect(await f.skills.list()).toEqual([])
  })
})
