import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Group from '@deepseek-ai/cordis-plugin-group'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Presets from '@deepseek-ai/dsh-agent-preset-registry'
import Skills from '@deepseek-ai/dsh-skill'
import MuseMarket from '../src/index.ts'
import * as BotSkills from '../src/bot-skills.ts'
import { MuseMarketLocal } from '../src/local.ts'
import { createMarketPackage, marketDigest, readMarketPackage } from '../src/package.ts'
import type { MarketManifest, MarketRelease, MarketReleaseId } from '../src/types.ts'

const contexts: Context[] = [], roots: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const limits = { archiveBytes: 1024 * 1024, expandedBytes: 1024 * 1024, fileCount: 32 }
async function start(root: string, allowedPlugins: string[] = []) {
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(Loader); ctx.loader.builtins.group = Group
  for (const plugin of [LlmRuntime, SessionStore, SessionProjections, Tools, Agents, Skills]) await ctx.plugin(plugin)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' }); await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Presets, { default: 'standard', selectablePresets: ['standard'] }); await ctx.agentPresets.register({ id: 'standard', plugins: [] })
  await ctx.plugin(MuseMarket, { baseUrl: 'https://market.example', root, requestTimeoutMs: 1000, ...limits, allowedPlugins })
  return ctx
}
async function agent(ctx: Context, id: string, preset = 'standard') {
  return (await ctx.agents.create({ sessionId: SessionId(id),
    setup: async (scope) => { await ctx.agentPresets.mount(scope, preset) } })).agent
}
function archive(version: string, kind: 'bot' | 'skill', botSkill = false) {
  const withSkill = kind === 'skill' || botSkill
  const manifest: MarketManifest = { formatVersion: 1, kind, name: 'review', title: 'Review', description: 'Review', version,
    license: 'MIT', category: 'script', examples: [], requirements: [],
    skills: withSkill ? [{ name: 'review', path: 'skills/review/SKILL.md' }] : [],
    ...(kind === 'bot' ? { plugins: [] } : {}) }
  return Buffer.from(createMarketPackage(manifest, withSkill
    ? { 'skills/review/SKILL.md': Buffer.from(`---\nname: review\ndescription: Review\n---\nVersion ${version}`) }
    : {}, limits, [])).toString('base64')
}

it('keeps both Bot versions selectable and restores the exact version referenced by an existing session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'market-bot-versions-')); roots.push(root)
  const startVersions = async () => {
    const ctx = await start(root)
    ctx.loader.internal = { version: 'v2', loadCache: new Map(),
      register() { throw Error('Unexpected loader hook') },
      getOrCreateModuleJob() { throw Error('Unexpected module job') },
      resolveSync() { throw Error('Unexpected module resolution') },
      load() { throw Error('Unexpected module load') },
      async import(name) {
        if (name !== '@deepseek-ai/dsh-muse-market/bot-skills') throw Error('Unexpected fixture plugin: ' + name)
        return BotSkills
      },
    }
    return ctx
  }
  let ctx = await startVersions()
  const first = await ctx.museMarket.importPackage(archive('1.0.0', 'bot', true))
  const firstPreset = `market-${first.release.id}`
  expect((await ctx.agentPresets.list()).map(row => row.id)).toEqual(['standard'])
  await ctx.museMarket.enable(first.release.id, true)
  expect(ctx.agentPresets.inspectCompositions().filter(row => row.id === firstPreset)).toHaveLength(0)
  const original = await agent(ctx, 'existing-bot-session')
  await ctx.agentPresets.select(original, firstPreset)
  original.session.append('turn/start', { turn: 1 })
  original.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  const second = await ctx.museMarket.importPackage(archive('2.0.0', 'bot', true))
  const secondPreset = `market-${second.release.id}`
  expect(secondPreset).not.toBe(firstPreset)
  await ctx.museMarket.enable(second.release.id, true)
  expect((await ctx.agentPresets.list()).map(row => row.id)).toEqual(expect.arrayContaining([firstPreset, secondPreset]))
  await expect(ctx.agentPresets.select(original, secondPreset)).rejects.toMatchObject({ code: 'agent-preset/locked' })
  const fresh = await agent(ctx, 'fresh-bot-session', secondPreset)
  expect(ctx.agentPresets.composedPreset(original.ctx)).toBe(firstPreset)
  expect(ctx.agentPresets.composedPreset(fresh.ctx)).toBe(secondPreset)
  expect((await ctx.skills.get('review', { scope: original }))?.content).toBe('Version 1.0.0')
  expect((await ctx.skills.get('review', { scope: fresh }))?.content).toBe('Version 2.0.0')

  const events = original.session.snapshotEvents()
  const header = original.session.header
  await ctx.fiber.dispose(); contexts.splice(contexts.indexOf(ctx), 1)
  ctx = await startVersions()
  await expect(ctx.museMarket.enable(first.release.id, false)).rejects.toMatchObject({ details: { code: 'release-in-use' } })
  await expect(ctx.museMarket.remove(first.release.id)).rejects.toMatchObject({ details: { code: 'release-in-use' } })
  const restoredLog = Session.create(original.id, events, header)
  const restoredPreset = ctx.sessionProjections.stateOf(restoredLog, 'agentPreset')
  expect(restoredPreset).toBe(firstPreset)
  const restored = await agent(ctx, original.id, restoredPreset ?? undefined)
  const newSession = await agent(ctx, 'new-bot-session-after-restart', secondPreset)
  expect((await ctx.skills.get('review', { scope: restored }))?.content).toBe('Version 1.0.0')
  expect((await ctx.skills.get('review', { scope: newSession }))?.content).toBe('Version 2.0.0')
})

it('imports, enables, exports and restores the handoff Bot and Skill without calling a model or cloud service', async () => {
  const root = await mkdtemp(join(tmpdir(), 'market-handoff-')); roots.push(root)
  const allowed = ['@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-tool-skill']
  let ctx = await start(root, allowed)
  const base = new URL('./fixtures/handoff/', import.meta.url)
  const expected = JSON.parse(await readFile(new URL('local-installations.json', base), 'utf8')) as {
    installations: {
      release: { id: string; sha256: string; bytes: number; createdAt: string; manifest: MarketManifest }
      enabled: boolean
    }[]
  }
  for (const [index, filename] of ['storyboard-director-1.0.0.zip', 'storyboard-starter-1.0.0.zip'].entries()) {
    const archive = await readFile(new URL(filename, base))
    const installation = await ctx.museMarket.importPackage(archive.toString('base64'))
    const { createdAt: _fixtureDate, ...record } = expected.installations[index]!.release
    expect(installation).toMatchObject({ release: record, enabled: false })
    expect(Number.isNaN(Date.parse(installation.release.createdAt))).toBe(false)
    expect(installation.enabled).toBe(false)
    const enabled = await ctx.museMarket.enable(installation.release.id, true)
    expect(enabled.enabled).toBe(true)
    expect(await ctx.museMarket.importPackage(archive.toString('base64'))).toEqual(enabled)
    expect(Buffer.from((await ctx.museMarket.exportPackage(installation.release.id)).base64, 'base64')).toEqual(archive)
  }
  expect((await ctx.museMarket.installed()).map(row => row.release.manifest.kind).sort()).toEqual(['bot', 'skill'])
  await ctx.fiber.dispose(); contexts.splice(contexts.indexOf(ctx), 1)
  ctx = await start(root, allowed)
  expect((await ctx.museMarket.installed()).every(row => row.enabled)).toBe(true)
  expect((await ctx.agentPresets.list()).some(row => row.id === `market-${expected.installations[0]!.release.id}`)).toBe(true)
})

it('builds a verified provider from only the exact enabled Bot release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'market-bot-skills-')); roots.push(root)
  const ctx = await start(root)
  const local = await ctx.museMarket.importPackage(archive('1.0.0', 'bot', true))
  await expect(ctx.museMarket.botSkillProvider('market-unknown')).rejects.toThrow('invalid-release')
  await expect(ctx.museMarket.botSkillProvider(local.release.id)).rejects.toThrow('not-installed')
  await ctx.museMarket.enable(local.release.id, true)
  await expect(ctx.museMarket.enable(local.release.id, true)).resolves.toMatchObject({ enabled: true })
  const provider = await ctx.museMarket.botSkillProvider(local.release.id)
  const candidates = await provider.list({})
  const rows = 'candidates' in candidates ? candidates.candidates : candidates
  expect(rows[0]).toMatchObject({ name: 'review', description: 'Review' })
  expect(rows[0]).not.toHaveProperty('content')
  expect(await provider.get(rows[0]!, {})).toMatchObject({ name: 'review', content: 'Version 1.0.0' })
  await writeFile(join(root, 'packages', local.release.sha256, 'skills', 'review', 'SKILL.md'), 'changed')
  await expect(provider.list({})).rejects.toThrow('modified-installation')
  await ctx.museMarket.enable(local.release.id, false)
  await expect(ctx.museMarket.botSkillProvider(local.release.id)).rejects.toThrow('not-installed')
})

it('tracks overlapping Bot selections without reserving unrelated or stale preset IDs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'market-selection-events-')); roots.push(root)
  const ctx = await start(root)
  const bot = await ctx.museMarket.importPackage(archive('1.0.0', 'bot'))
  const skill = await ctx.museMarket.importPackage(archive('1.0.0', 'skill'))
  await ctx.museMarket.enable(bot.release.id, true)
  const first = SessionId('selection-first'), second = SessionId('selection-second'), unrelated = SessionId('selection-unrelated')
  const staleId = 'f'.repeat(32)
  ctx.emit('agent-preset/selected', unrelated, 'standard')
  ctx.emit('agent-preset/selected', unrelated, 'market-invalid')
  ctx.emit('agent-preset/selected', unrelated, `market-${staleId}`)
  ctx.emit('agent-preset/selected', unrelated, `market-${staleId}`)
  ctx.emit('agent-preset/selected', unrelated, `market-${skill.release.id}`)
  ctx.emit('agent-preset/selected', first, `market-${bot.release.id}`)
  ctx.emit('agent-preset/selected', second, `market-${bot.release.id}`)
  await ctx.museMarket.installed()
  const ledger = JSON.parse(await readFile(join(root, 'installations.json'), 'utf8')) as { references: Record<string, readonly MarketReleaseId[]> }
  expect(ledger.references).toEqual({ [first]: [bot.release.id], [second]: [bot.release.id] })
  await ctx.museMarket.remove(skill.release.id)
  await expect(ctx.museMarket.remove(staleId as MarketReleaseId)).rejects.toMatchObject({ details: { code: 'not-installed' } })
})

it.each([false, true])('rolls back enablement after preset registration fails with restricted roster=%s', async (restricted) => {
  const root = await mkdtemp(join(tmpdir(), 'market-registration-failure-')); roots.push(root)
  const ctx = await start(root)
  if (!restricted) delete ctx.agentPresets.config.selectablePresets
  const selectable = ctx.agentPresets.config.selectablePresets
  const local = await ctx.museMarket.importPackage(archive('1.0.0', 'bot'))
  const preset = `market-${local.release.id}`
  const remove = await ctx.agentPresets.register({ id: preset, name: 'Existing declaration', plugins: [] })
  try {
    await expect(ctx.museMarket.enable(local.release.id, true)).rejects.toMatchObject({ details: { code: 'market-unavailable' } })
    expect(await ctx.museMarket.installed()).toEqual([local])
    expect(ctx.agentPresets.config.selectablePresets).toEqual(selectable)
    expect((await ctx.agentPresets.list()).find(row => row.id === preset)?.name).toBe('Existing declaration')
  } finally { await remove() }
  await expect(ctx.museMarket.enable(local.release.id, true)).resolves.toMatchObject({ enabled: true })
})

it('retains an enabled Bot when its preset disposer fails and supports a later disable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'market-disposal-failure-')); roots.push(root)
  const ctx = await start(root)
  const local = await ctx.museMarket.importPackage(archive('1.0.0', 'bot'))
  const preset = `market-${local.release.id}`
  const register = ctx.agentPresets.register.bind(ctx.agentPresets)
  const dispose = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('preset disposal failed'))
  const registration = vi.spyOn(ctx.agentPresets, 'register').mockImplementationOnce(async (...args) => {
    dispose.mockImplementation(await register(...args))
    return dispose
  })
  try { await ctx.museMarket.enable(local.release.id, true) }
  finally { registration.mockRestore() }
  await expect(ctx.museMarket.enable(local.release.id, false)).rejects.toMatchObject({ details: { code: 'market-unavailable' } })
  expect((await ctx.museMarket.installed())[0]?.enabled).toBe(true)
  await expect(ctx.museMarket.enable(local.release.id, false)).resolves.toMatchObject({ enabled: false })
  expect((await ctx.agentPresets.list()).some(row => row.id === preset)).toBe(false)
})

it.each(['ledger', 'disposer'] as const)('preserves a Bot selected while disable waits for its %s', async (boundary) => {
  const root = await mkdtemp(join(tmpdir(), 'market-disable-late-selection-')); roots.push(root)
  const ctx = await start(root)
  const local = await ctx.museMarket.importPackage(archive('1.0.0', 'bot'))
  const preset = `market-${local.release.id}`
  const blank = await agent(ctx, `late-selection-${boundary}`)
  const entered = Promise.withResolvers<undefined>(), resume = Promise.withResolvers<undefined>()
  const register = ctx.agentPresets.register.bind(ctx.agentPresets)
  const registration = vi.spyOn(ctx.agentPresets, 'register').mockImplementationOnce(async (...args) => {
    const dispose = await register(...args)
    return async () => {
      if (boundary === 'disposer') { entered.resolve(undefined); await resume.promise }
      await dispose()
    }
  })
  try { await ctx.museMarket.enable(local.release.id, true) }
  finally { registration.mockRestore() }
  const ledger = new MuseMarketLocal({ root, limits, allowedPlugins: [] })
  const enable = ledger.enable.bind(ledger)
  const updating = vi.spyOn(MuseMarketLocal.prototype, 'enable').mockImplementationOnce(async (...args) => {
    const result = await enable(...args)
    if (boundary === 'ledger') { entered.resolve(undefined); await resume.promise }
    return result
  })
  const disabling = ctx.museMarket.enable(local.release.id, false)
  const rejection = expect(disabling).rejects.toMatchObject({ details: { code: 'release-in-use' } })
  try {
    await Promise.race([entered.promise, disabling])
    await ctx.agentPresets.recompose(blank.ctx, preset)
  } finally { resume.resolve(undefined); updating.mockRestore() }
  await rejection
  expect((await ctx.museMarket.installed())[0]?.enabled).toBe(true)
  await expect(ctx.agentPresets.resolveForCreation(preset)).resolves.toMatchObject({ id: preset })
  expect(ctx.agentPresets.composedPreset(blank.ctx)).toBe(preset)
})

it('uses the current coding preset and enables only the matching delegate for an audited legacy Bot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'market-legacy-coding-')); roots.push(root)
  const ctx = await start(root)
  const raw = Buffer.from(archive('0.1.0', 'bot'), 'base64')
  const { manifest } = readMarketPackage(raw, limits, [])
  const legacyId = 'muse/bots/codex-coding'
  const trustedDigest = '29f298d04e2b77a5313170a2bff4c06c907c9d5d5a65f94adb7e8e88d357272d'
  const local = new MuseMarketLocal({ root, limits, allowedPlugins: [] })
  const install = async (sha256: string) => await local.install({
    id: sha256 as MarketReleaseId, publisherId: 'a'.repeat(16) as MarketRelease['publisherId'], publisher: 'Muse',
    manifest, sha256: marketDigest(raw), bytes: raw.length, status: 'published', reviewNote: '', revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
  }, raw, { id: legacyId, sha256 })
  const unsupported = await install('a'.repeat(64))
  await expect(ctx.museMarket.enable(unsupported.release.id, true)).rejects.toMatchObject({ details: { code: 'legacy-not-supported' } })
  const known = await install(trustedDigest)
  const definition = vi.spyOn(ctx.agentPresets, 'presetPlugins').mockReturnValueOnce(undefined)
  try {
    await expect(ctx.museMarket.enable(known.release.id, true)).rejects.toMatchObject({ details: { code: 'legacy-not-supported' } })
  } finally { definition.mockRestore() }
  const preset = `market-${known.release.id}`
  const coding = { id: 'tool-subagent-codex', name: '@deepseek-ai/dsh-tool-subagent', disabled: true }
  const claude = { id: 'tool-subagent-claude-code', name: '@deepseek-ai/dsh-tool-subagent', disabled: true }
  const unaffected = [{ id: 'general', name: 'fixture' }, { id: 'delegation', name: 'fixture' },
    { id: 'delegation', name: 'fixture', group: true, config: {} }]
  const delegation = { id: 'delegation', name: 'cordis:group', group: true, config: [coding, claude] }
  const native = vi.spyOn(ctx.agentPresets, 'presetPlugins').mockReturnValueOnce([...unaffected, delegation])
  try { await ctx.museMarket.enable(known.release.id, true) }
  finally { native.mockRestore() }
  expect(ctx.agentPresets.presetPlugins(preset)).toEqual([...unaffected, {
    ...delegation, config: [{ ...coding, disabled: false }, claude],
  }])
  expect((await ctx.museMarket.installed()).map(row => row.enabled)).toEqual([false, true])
})

it('keeps a committed late Bot selection reserved when durable reference recording fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'market-selection-failure-')); roots.push(root)
  const ctx = await start(root)
  const local = await ctx.museMarket.importPackage(archive('1.0.0', 'bot'))
  await ctx.museMarket.enable(local.release.id, true)
  const blank = await agent(ctx, 'failed-reference')
  const reference = vi.spyOn(MuseMarketLocal.prototype, 'reference')
    .mockRejectedValue(new Error('simulated durable reference failure'))
  await ctx.agentPresets.select(blank, `market-${local.release.id}`)
  await expect(ctx.museMarket.enable(local.release.id, false)).rejects.toMatchObject({ details: { code: 'release-in-use' } })
  await expect(ctx.museMarket.remove(local.release.id)).rejects.toMatchObject({ details: { code: 'release-in-use' } })
  reference.mockRestore()
})

it('rejects disable when a blank session selects the Bot during the disable operation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'market-selection-race-')); roots.push(root)
  const ctx = await start(root)
  const local = await ctx.museMarket.importPackage(archive('1.0.0', 'bot'))
  await ctx.museMarket.enable(local.release.id, true)
  const blank = await agent(ctx, 'racing-selection')
  let entered!: () => void, resume!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const paused = new Promise<void>((resolve) => { resume = resolve })
  const list = vi.spyOn(MuseMarketLocal.prototype, 'list').mockImplementationOnce(async () => {
    entered(); await paused; return [local]
  })
  const disabling = ctx.museMarket.enable(local.release.id, false)
  await started
  try { await expect(ctx.agentPresets.select(blank, `market-${local.release.id}`)).resolves.toBe(`market-${local.release.id}`) }
  finally { resume(); list.mockRestore() }
  await expect(disabling).rejects.toMatchObject({ details: { code: 'release-in-use' } })
  expect((await ctx.museMarket.installed()).find(item => item.release.id === local.release.id)?.enabled).toBe(true)
})

it('rejects disable while preset recomposition is bound but its selection event is not committed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'market-recompose-race-')); roots.push(root)
  const ctx = await start(root)
  const local = await ctx.museMarket.importPackage(archive('1.0.0', 'bot'))
  await ctx.museMarket.enable(local.release.id, true)
  const blank = await agent(ctx, 'recomposed-selection')
  await ctx.agentPresets.recompose(blank.ctx, `market-${local.release.id}`)
  await expect(ctx.museMarket.enable(local.release.id, false))
    .rejects.toMatchObject({ details: { code: 'release-in-use' } })
  expect((await ctx.museMarket.installed()).find(item => item.release.id === local.release.id)?.enabled).toBe(true)
})

it('adds enabled market Bots to a restricted creation roster and removes them again on disable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'market-selectable-')); roots.push(root)
  const ctx = await start(root)
  const local = await ctx.museMarket.importPackage(archive('1.0.0', 'bot'))
  const preset = `market-${local.release.id}`
  await expect(ctx.agentPresets.resolveForCreation(preset)).rejects.toMatchObject({ code: 'agent-preset/not-found' })
  await ctx.museMarket.enable(local.release.id, true)
  await expect(ctx.agentPresets.resolveForCreation(preset)).resolves.toMatchObject({ id: preset })
  await ctx.museMarket.enable(local.release.id, false)
  expect(ctx.agentPresets.config.selectablePresets).toEqual(['standard'])
  await expect(ctx.agentPresets.resolveForCreation(preset)).rejects.toMatchObject({ code: 'agent-preset/not-found' })
})

it('retains the original standalone Skill for live and recovered sessions when the enabled version changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'market-skills-')); roots.push(root)
  let ctx = await start(root)
  const first = await ctx.museMarket.importPackage(archive('1.0.0', 'skill'))
  await ctx.museMarket.enable(first.release.id, true)
  expect(await ctx.skills.get('review')).toBeUndefined()
  expect((await ctx.museMarket.sources()).skills.some(row => row.name === 'review')).toBe(false)
  const original = await agent(ctx, 'existing')
  await ctx.museMarket.enable(first.release.id, false)
  const second = await ctx.museMarket.importPackage(archive('2.0.0', 'skill')); await ctx.museMarket.enable(second.release.id, true)
  expect((await ctx.skills.get('review', { scope: original }))?.content).toBe('Version 1.0.0')
  const fresh = await agent(ctx, 'fresh')
  expect((await ctx.skills.get('review', { scope: fresh }))?.content).toBe('Version 2.0.0')
  await ctx.fiber.dispose(); contexts.splice(contexts.indexOf(ctx), 1)
  ctx = await start(root)
  const recovered = await agent(ctx, 'existing')
  expect((await ctx.skills.get('review', { scope: recovered }))?.content).toBe('Version 1.0.0')
  await expect(ctx.museMarket.remove(first.release.id)).rejects.toMatchObject({ details: { code: 'release-in-use' } })
})
