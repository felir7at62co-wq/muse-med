import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionSkillCatalog } from '@deepseek-ai/dsh-api-session-controller/src/skill-catalog.ts'
import { join } from 'node:path'
import { rename, writeFile } from 'node:fs/promises'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
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
  it('binds blank Sessions exactly once before a step, delegates and preserves legacy selections', async () => {
    const f = await fixture(), blank = await f.harness.create(SessionId('bind-before-step'))
    const step = (agent: Agent, signal = new AbortController().signal) => agent.ctx.waterfall('agent/pre-step', {
      agent, messages: [], turn: 1, step: 1, signal, modelSelection: { provider: 'fixture', model: 'fixture' },
    }, async () => ({ kind: 'accept' as const, messages: [] }))
    expect(await step(blank)).toEqual({ kind: 'accept', messages: [] })
    expect((await f.service.binding({ sessionId: blank.id })).phase).toBe('bound')
    await step(blank)
    expect(blank.session.snapshotEvents().filter(event => event.type === 'muse-market/bound')).toHaveLength(1)
    const legacy = await f.harness.create(SessionId('legacy-before-step'))
    legacy.session.append('request/header', { header: { config: { provider: 'fixture', model: 'fixture' } }, reason: 'initial' })
    await step(legacy)
    expect(await f.skills.list({ scope: legacy })).toEqual([])
    expect(await f.service.binding({ sessionId: legacy.id })).toEqual({ phase: 'legacy', releases: [] })
    const aborted = await f.harness.create(SessionId('cancelled-before-binding')), controller = new AbortController()
    controller.abort(new Error('Caller left before admission'))
    await expect(step(aborted, controller.signal)).rejects.toThrow('Caller left before admission')
    expect((await f.service.binding({ sessionId: aborted.id })).phase).toBe('blank')
  })

  it('blocks removing any Session-bound release and permits an unused disabled release', async () => {
    const f = await fixture(), session = f.ctx.sessions.create(SessionId('retained-selection'))
    session.append('muse-market/bound', { releases: (await f.service.binding({ sessionId: session.id })).releases })
    await f.service.setDefault({ skillName: 'fixture-skill', expected: f.first.release.id, target: null })
    await expect(f.market.removePackage(f.first.release.id)).rejects.toMatchObject({ details: { code: 'release-in-use' } })
    await f.market.removePackage(f.second.release.id)
    expect(await f.market.installed()).toEqual([f.first])
  })

  it('keeps defaults committed when a notification observer throws and maps owner failures', async () => {
    const f = await fixture()
    const emit = f.ctx.emit.bind(f.ctx)
    const notification = vi.spyOn(f.ctx, 'emit').mockImplementation((...args) => {
      if (args[0] === 'muse-market/defaults-changed' || args[0] === 'skills/change') throw Error('Observer failed')
      emit(...args)
    })
    try { expect(await f.service.setDefault({ skillName: 'fixture-skill', expected: f.first.release.id, target: null }))
      .toEqual({ revision: 2, defaults: [] }) } finally { notification.mockRestore() }
    expect(await f.service.defaults()).toEqual({ revision: 2, defaults: [] })
    await expect(f.service.binding({ sessionId: SessionId('missing-session') })).rejects.toMatchObject({ details: { code: 'activation-unavailable' } })
    await writeFile(join(f.files.root, 'market', 'installations.json'), '{')
    await expect(f.service.defaults()).rejects.toMatchObject({ details: { code: 'invalid-ledger' } })
  })

  it('serves blank and legacy cold views without leaving registrations after empty selections', async () => {
    const f = await fixture(), catalog = new SessionSkillCatalog(f.ctx)
    const blank = f.ctx.sessions.create(SessionId('cold-blank'))
    expect((await catalog.list({ sessionId: blank.id }, new AbortController().signal)).skills).toHaveLength(1)
    const legacy = f.ctx.sessions.create(SessionId('cold-legacy'))
    legacy.append('request/header', { header: { config: { provider: 'fixture', model: 'fixture' } }, reason: 'initial' })
    expect((await catalog.list({ sessionId: legacy.id }, new AbortController().signal)).skills).toEqual([])
    await f.service.setDefault({ skillName: 'fixture-skill', expected: f.first.release.id, target: null })
    expect((await catalog.list({ sessionId: blank.id }, new AbortController().signal)).skills).toEqual([])
  })

  it('refuses unavailable query projections and missing cold registration scopes', async () => {
    const f = await fixture(), session = f.ctx.sessions.create(SessionId('projection-missing'))
    const observe = f.ctx.sessionQuery.observeSession.bind(f.ctx.sessionQuery)
    const missing = vi.spyOn(f.ctx.sessionQuery, 'observeSession').mockImplementation(async (...args) => {
      const result = await observe(...args)
      return { ...result, projections: { ...result.projections!, values: {} } }
    })
    try {
      await expect(f.service.binding({ sessionId: session.id })).rejects.toMatchObject({ details: { code: 'binding-projection-unavailable' } })
      await f.service.setDefault({ skillName: 'fixture-skill', expected: f.first.release.id, target: null })
      await expect(f.market.removePackage(f.first.release.id)).rejects.toMatchObject({ details: { code: 'binding-projection-unavailable' } })
    } finally { missing.mockRestore() }
    const projections: ProjectionSnapshot = { values: {}, asOfSeq: -1 }
    await expect(f.ctx.serial('session-skills/prepare-view', { sessionId: session.id, projections,
      context: () => f.ctx, signal: new AbortController().signal })).rejects.toThrow('binding-projection-unavailable')
    await f.service.setDefault({ skillName: 'fixture-skill', expected: null, target: f.first.release.id })
    using observation = await observe(session.id)
    if (observation.projections === undefined) throw Error('Missing actual projected observation')
    await expect(f.ctx.serial('session-skills/prepare-view', { sessionId: session.id, projections: observation.projections,
      context: () => f.ctx, signal: new AbortController().signal })).rejects.toThrow('binding-scope-unavailable')
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
})
