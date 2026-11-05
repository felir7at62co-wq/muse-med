import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Group from '@deepseek-ai/cordis-plugin-group'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
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

async function historicalBot(root: string) {
  const local = new MuseMarketLocal({ root, limits, allowedPlugins: [] })
  await local.ready()
  const raw = Buffer.from(archive('1.0.0', 'bot', true), 'base64')
  const { manifest } = readMarketPackage(raw, limits, [])
  const digest = marketDigest(raw)
  const release: MarketRelease = { id: digest as MarketReleaseId, publisherId: 'a'.repeat(16) as MarketRelease['publisherId'],
    publisher: 'Historical publisher', manifest, sha256: digest, bytes: raw.length, status: 'published', reviewNote: '',
    revision: 1, createdAt: '2026-11-01T00:00:00.000Z' }
  await local.install(release, raw)
  await local.enable(release.id, true)
  await local.reference('historical-session', [release.id])
  return release
}

function historicalLoader(ctx: Context) {
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
}

it('restores installed historical Bot sessions while excluding them from market actions and creation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'market-historical-')); roots.push(root)
  const release = await historicalBot(root)
  let ctx = await start(root)
  historicalLoader(ctx)
  const preset = `market-${release.id}`
  expect(await ctx.museMarket.installed()).toEqual([])
  expect(await ctx.museMarket.sources()).not.toHaveProperty('bots')
  expect((await ctx.agentPresets.remoteExportList()).presets.map(row => row.id)).toEqual(['standard'])
  await expect(ctx.agentPresets.resolveForCreation(preset)).rejects.toMatchObject({ code: 'agent-preset/not-selectable' })
  const original = await agent(ctx, 'historical-session', preset)
  expect((await ctx.skills.get('review', { scope: original }))?.content).toBe('Version 1.0.0')
  for (const operation of [() => ctx.museMarket.enable(release.id, true), () => ctx.museMarket.exportPackage(release.id),
    () => ctx.museMarket.publishDraft(release.id, release.publisherId, 'archived-upload')]) {
    await expect(operation()).rejects.toMatchObject({ details: { code: 'skill-only' } })
  }
  await expect(ctx.museMarket.remove(release.id)).rejects.toMatchObject({ details: { code: 'release-in-use' } })
  await ctx.fiber.dispose(); contexts.splice(contexts.indexOf(ctx), 1)
  ctx = await start(root)
  historicalLoader(ctx)
  const restored = await agent(ctx, 'historical-session', preset)
  expect((await ctx.skills.get('review', { scope: restored }))?.content).toBe('Version 1.0.0')
  const provider = await ctx.museMarket.botSkillProvider(release.id)
  expect(await provider.list({})).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'review' })]))
  await expect(ctx.museMarket.botSkillProvider('invalid')).rejects.toThrow('invalid-release')
  await expect(ctx.museMarket.botSkillProvider('e'.repeat(32))).rejects.toThrow('not-installed')
})

it('rejects Bot archives before local import or authoring can create an installation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'market-skill-only-')); roots.push(root)
  const ctx = await start(root)
  const raw = archive('1.0.0', 'bot')
  await expect(ctx.museMarket.importPackage(raw)).rejects.toMatchObject({ details: { code: 'skill-only' } })
  const { manifest } = readMarketPackage(Buffer.from(raw, 'base64'), limits, [])
  await expect(ctx.museMarket.prepare(manifest, [])).rejects.toMatchObject({ details: { code: 'skill-only' } })
  expect(await ctx.museMarket.installed()).toEqual([])
  await writeFile(join(root, 'installations.json'), '{')
  await expect(ctx.museMarket.installed()).rejects.toMatchObject({ details: { code: 'market-unavailable' } })
})

it('imports, enables, exports and restores the original handoff Skill', async () => {
  const root = await mkdtemp(join(tmpdir(), 'market-skill-handoff-')); roots.push(root)
  const bytes = await readFile(new URL('./fixtures/handoff/storyboard-starter-1.0.0.zip', import.meta.url))
  let ctx = await start(root)
  const installation = await ctx.museMarket.importPackage(bytes.toString('base64'))
  expect(installation.release.manifest.kind).toBe('skill')
  await ctx.museMarket.enable(installation.release.id, true)
  expect(Buffer.from((await ctx.museMarket.exportPackage(installation.release.id)).base64, 'base64')).toEqual(bytes)
  await ctx.fiber.dispose(); contexts.splice(contexts.indexOf(ctx), 1)
  ctx = await start(root)
  expect(await ctx.museMarket.installed()).toEqual([{ ...installation, enabled: true }])
})

async function restoredLegacy(coding: boolean, known = true) {
  const root = await mkdtemp(join(tmpdir(), 'market-historical-legacy-')); roots.push(root)
  const allowed = ['@deepseek-ai/dsh-tool-skill']
  const local = new MuseMarketLocal({ root, limits, allowedPlugins: allowed })
  await local.ready()
  const original = readMarketPackage(Buffer.from(archive('0.1.0', 'bot'), 'base64'), limits, []).manifest
  const bytes = createMarketPackage({ ...original,
    plugins: [{ name: allowed[0]!, config: { scopedCatalogOwner: true } }],
  }, {}, limits, allowed)
  const sha256 = known ? coding ? '29f298d04e2b77a5313170a2bff4c06c907c9d5d5a65f94adb7e8e88d357272d'
    : 'e2d576d0766eccf5c348aab4a9dbc63f1246c4f37e2a269c20c6cedc1bda4653' : 'a'.repeat(64)
  const release: MarketRelease = { id: sha256 as MarketReleaseId, publisherId: 'a'.repeat(16) as MarketRelease['publisherId'],
    publisher: 'Historical publisher', manifest: readMarketPackage(bytes, limits, allowed).manifest,
    sha256: marketDigest(bytes), bytes: bytes.length, status: 'published', reviewNote: '', revision: 1,
    createdAt: '2026-11-01T00:00:00.000Z' }
  await local.install(release, bytes, { id: coding ? 'muse/bots/codex-coding' : 'muse/bots/short-drama-director', sha256 })
  await local.enable(release.id, true)
  return { ctx: await start(root, allowed), preset: `market-${release.id}` }
}

it.each([true, false])('restores the current audited legacy composition with coding=%s', async (coding) => {
  const { ctx, preset } = await restoredLegacy(coding)
  const loader = '@deepseek-ai/dsh-tool-skill'
  const delegates = [{ id: 'tool-subagent-codex', name: '@deepseek-ai/dsh-tool-subagent', disabled: true },
    { id: 'tool-subagent-codex', name: 'fixture', disabled: true },
    { id: 'tool-subagent-claude-code', name: '@deepseek-ai/dsh-tool-subagent', disabled: true }]
  const product = [{ name: '@deepseek-ai/dsh-persona' }, { name: loader, disabled: !coding },
    { id: 'general', name: 'fixture' }, { id: 'delegation', name: 'fixture' },
    { id: 'delegation', name: 'fixture', group: true, config: {} },
    { id: 'delegation', name: 'cordis:group', group: true, config: delegates }]
  const read = ctx.agentPresets.presetPlugins.bind(ctx.agentPresets)
  const spy = vi.spyOn(ctx.agentPresets, 'presetPlugins').mockImplementation(id => id === preset ? read(id) : product)
  try {
    const rows = ctx.agentPresets.presetPlugins(preset)
    expect(rows?.some(row => row.name === '@deepseek-ai/dsh-persona')).toBe(false)
    expect(rows?.filter(row => row.name === loader && row.disabled !== true)).toHaveLength(1)
    const group = rows?.find(row => row.name === 'cordis:group')
    expect(group?.config).toEqual(coding ? [{ ...delegates[0], disabled: false }, ...delegates.slice(1)] : delegates)
  } finally { spy.mockRestore() }
})

it('refuses an unknown historical archive and an unavailable current preset', async () => {
  const unknown = await restoredLegacy(true, false)
  expect(() => unknown.ctx.agentPresets.presetPlugins(unknown.preset)).toThrow('legacy-not-supported')
  const known = await restoredLegacy(true)
  const read = known.ctx.agentPresets.presetPlugins.bind(known.ctx.agentPresets)
  const spy = vi.spyOn(known.ctx.agentPresets, 'presetPlugins').mockImplementation(id => id === known.preset ? read(id) : undefined)
  try { expect(() => known.ctx.agentPresets.presetPlugins(known.preset)).toThrow('legacy-not-supported') }
  finally { spy.mockRestore() }
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
