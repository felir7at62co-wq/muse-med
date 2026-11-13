import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
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
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

class PointQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> { return Promise.reject(new Error('Search is not used')) }
  override searchEvents(): Promise<never> { return Promise.reject(new Error('Search is not used')) }
}
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture(beforeActivation?: (ctx: Context) => Promise<void>) {
  const files = await directory(); cleanups.push(files.cleanup)
  const ctx = new Context(); cleanups.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(SkillRegistry).await(); await ctx.plugin(PointQuery).await()
  await ctx.plugin(MuseMarket, { root: join(files.root, 'market'), ...limits }).await()
  await beforeActivation?.(ctx)
  const activation = ctx.plugin(MuseMarketActivation); await activation.await()
  const service = ctx.get('museMarketActivation'), market = ctx.get('museMarket'), skills = ctx.get('skills')
  if (service === undefined || market === undefined || skills === undefined) throw new Error('Missing actual providers')
  const first = await market.importPackage(Buffer.from(createMarketPackage(manifest, resources, limits)).toString('base64'))
  const second = await market.importPackage(Buffer.from(createMarketPackage({ ...manifest, version: '2.0.0' }, resources, limits)).toString('base64'))
  await service.setDefault({ skillName: 'fixture-skill', expected: null, target: first.release.id })
  const harness = await mountAgentLoopTestHarness(ctx)
  return { ctx, files, activation, service, market, skills, first, second, harness }
}

async function staleProjectionFixture() {
  const sessionId = SessionId('observed-before-market-activation')
  let observed: Awaited<ReturnType<SessionQueryEngine['observeSession']>> | undefined
  const f = await fixture(async (ctx) => {
    ctx.sessions.create(sessionId)
    const lease = await ctx.sessionQuery.observeSession(sessionId)
    observed = lease
    cleanups.push(async () => { lease[Symbol.dispose]() })
  })
  if (observed?.projections === undefined) throw new Error('Missing actual pre-activation projection snapshot')
  expect(observed.projections.values.museMarketBinding).toBeUndefined()
  return { ...f, sessionId, observed, projections: observed.projections }
}

describe('activation-owned Session Skill views', () => {
  it('refuses a cold view retained before activation registered its projection', async () => {
    const f = await staleProjectionFixture()
    await expect(f.ctx.serial('session-skills/prepare-view', { sessionId: f.sessionId, projections: f.projections,
      context: () => f.ctx, signal: new AbortController().signal })).rejects.toThrow('binding-projection-unavailable')
    expect(await f.skills.list()).toEqual([])
  })

  it('refuses an unscoped cold-view registration context without registering a global provider', async () => {
    const f = await fixture(), session = f.ctx.sessions.create(SessionId('unscoped-market-view'))
    using observed = await f.ctx.sessionQuery.observeSession(session.id)
    if (observed.projections === undefined) throw new Error('Missing actual Session projections')
    await expect(f.ctx.serial('session-skills/prepare-view', { sessionId: session.id, projections: observed.projections,
      context: () => f.ctx, signal: new AbortController().signal })).rejects.toThrow('binding-scope-unavailable')
    expect(await f.skills.list()).toEqual([])
  })

  it('rejects a stale public query observation and accepts a later fresh binding read', async () => {
    const f = await staleProjectionFixture()
    const query = vi.spyOn(f.ctx.sessionQuery, 'observeSession').mockResolvedValueOnce(f.observed)
    try {
      await expect(f.service.binding({ sessionId: f.sessionId })).rejects.toMatchObject({
        details: { code: 'binding-projection-unavailable' },
      })
      expect(query).toHaveBeenCalledExactlyOnceWith(f.sessionId)
    } finally { query.mockRestore() }
    expect(await f.service.binding({ sessionId: f.sessionId })).toMatchObject({ phase: 'blank' })
    expect(await f.skills.list()).toEqual([])
  })

  it('refuses removal while a public query still reports the pre-activation projection and permits a later fresh check', async () => {
    const f = await staleProjectionFixture()
    await f.service.setDefault({ skillName: 'fixture-skill', expected: f.first.release.id, target: null })
    const query = vi.spyOn(f.ctx.sessionQuery, 'observeSession').mockResolvedValueOnce(f.observed)
    try {
      await expect(f.market.removePackage(f.first.release.id)).rejects.toMatchObject({
        details: { code: 'binding-projection-unavailable' },
      })
      expect(query).toHaveBeenCalledExactlyOnceWith(f.sessionId)
    } finally { query.mockRestore() }
    expect(await f.market.installed()).toEqual([f.first, f.second])
    await f.market.removePackage(f.first.release.id)
    expect(await f.market.installed()).toEqual([f.second])
  })

  it.each(['bound', 'legacy'] as const)('retains the %s selection admitted by the public Agent factory before later defaults change', async (kind) => {
    const f = await fixture()
    const local = new MuseMarketLocal({ root: join(f.files.root, 'market'), limits })
    const releases = await local.captureDefaults()
    const handle = await f.ctx.agents.create({ sessionId: SessionId(`factory-market-${kind}`), setup(_ctx, agent) {
      if (kind === 'bound') agent.session.append('muse-market/bound', { releases })
      else agent.session.append('request/header', { header: { config: { provider: 'fixture', model: 'fixture' } }, reason: 'initial' })
    } })
    cleanups.push(() => handle.dispose())
    const before = await f.skills.list({ scope: handle.agent })
    expect(before).toHaveLength(kind === 'bound' ? 1 : 0)
    if (kind === 'bound') expect((await f.skills.get('fixture-skill', { scope: handle.agent }))?.path).toContain(f.first.release.id)
    await f.service.setDefault({ skillName: 'fixture-skill', expected: f.first.release.id, target: f.second.release.id })
    expect(await f.skills.list({ scope: handle.agent })).toEqual(before)
    expect(await f.service.binding({ sessionId: handle.agent.id })).toMatchObject({ phase: kind, releases: kind === 'bound' ? releases : [] })
    await handle.dispose()
    expect(await f.skills.list()).toEqual([])
  })

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

  it('binds the selected default before the first request and retains it for later turns and removal checks', async () => {
    const f = await fixture(), adapter = new MockAdapter([textResponse('First review.'), textResponse('Second review.')])
    f.ctx.llm.registerAdapter(['market-fixture'], adapter)
    const agent = await f.harness.create(SessionId('first-request-binding'), { provider: 'market-fixture', model: 'reviewer' })
    const send = async (text: string) => {
      const idle = Promise.withResolvers<undefined>()
      const off = f.ctx.on('agent/status', ({ agent: subject, status }) => {
        if (subject === agent && status === 'idle') idle.resolve(undefined)
      })
      try {
        agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
        await idle.promise
      } finally { off() }
    }
    await send('Review the first scene.')
    const first = agent.session.snapshotEvents()
    const boundIndex = first.findIndex(event => event.type === 'muse-market/bound')
    expect(boundIndex).toBeGreaterThanOrEqual(0)
    expect(boundIndex).toBeLessThan(first.findIndex(event => event.type === 'request/header'))
    expect(await f.service.binding({ sessionId: agent.id })).toMatchObject({ phase: 'bound',
      releases: [{ release: { id: f.first.release.id } }] })
    await f.service.setDefault({ skillName: 'fixture-skill', expected: f.first.release.id, target: f.second.release.id })
    await send('Review the second scene.')
    expect(agent.session.snapshotEvents().filter(event => event.type === 'muse-market/bound')).toHaveLength(1)
    expect(adapter.requests).toHaveLength(2)
    expect((await f.skills.get('fixture-skill', { scope: agent }))?.path).toContain(f.first.release.id)
    await expect(f.market.removePackage(f.first.release.id)).rejects.toMatchObject({ details: { code: 'release-in-use' } })
    await f.service.setDefault({ skillName: 'fixture-skill', expected: f.second.release.id, target: null })
    await f.market.removePackage(f.second.release.id)
    expect((await f.market.installed()).map(item => item.release.id)).toEqual([f.first.release.id])
  })

  it('leaves legacy and blank cold Sessions empty without registering a market provider', async () => {
    const f = await fixture(), legacy = f.ctx.sessions.create(SessionId('legacy-market-empty'))
    legacy.append('request/header', { header: { config: { provider: 'fixture', model: 'fixture' } }, reason: 'initial' })
    expect(await f.service.binding({ sessionId: legacy.id })).toEqual({ phase: 'legacy', releases: [] })
    const catalog = new SessionSkillCatalog(f.ctx)
    expect((await catalog.list({ sessionId: legacy.id }, new AbortController().signal)).skills).toEqual([])
    await f.service.setDefault({ skillName: 'fixture-skill', expected: f.first.release.id, target: null })
    const blank = f.ctx.sessions.create(SessionId('blank-market-empty'))
    expect(await f.service.binding({ sessionId: blank.id })).toEqual({ phase: 'blank', releases: [] })
    expect((await catalog.list({ sessionId: blank.id }, new AbortController().signal)).skills).toEqual([])
    expect(await f.skills.list()).toEqual([])
  })

  it('retains committed defaults after observer failure and refuses calls after activation unload', async () => {
    const f = await fixture(), warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
    const off = f.ctx.on('muse-market/defaults-changed', () => { throw new Error('Observer failed') })
    try {
      expect(await f.service.defaults()).toMatchObject({ revision: 1 })
      expect(await f.service.setDefault({ skillName: 'fixture-skill', expected: f.first.release.id, target: f.second.release.id }))
        .toMatchObject({ revision: 2 })
      expect(warn).toHaveBeenCalled()
      expect(await f.service.defaults()).toEqual({ revision: 2,
        defaults: [{ skillName: 'fixture-skill', releaseId: f.second.release.id }] })
    } finally { off(); warn.mockRestore() }
    await expect(f.service.binding({ sessionId: SessionId('missing-market-session') }))
      .rejects.toMatchObject({ details: { code: 'activation-unavailable' } })
    await f.activation.dispose()
    await expect(f.service.defaults()).rejects.toMatchObject({ details: { code: 'activation-closed' } })
  })
})
