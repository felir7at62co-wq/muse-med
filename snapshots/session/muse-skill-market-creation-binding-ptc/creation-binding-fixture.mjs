/** Actual creation preset, isolated Skill registry and immutable Session release selections. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { importSnapshotModule } from '../muse-fixture-import.mjs'
import { apply as mountPreset } from '../muse-editing-tool-catalog/editing-preset-fixture.mjs'
export const name = 'market-creation-binding-fixture'
export const inject = ['agentPresets', 'tools', 'systemPrompt', 'workingDirectory', 'skills', 'llm', 'agents', 'sessions', 'sessionProjections']
const skillName = 'version-bound-review'
const limits = { archiveBytes: 1048576, expandedBytes: 2097152, fileCount: 32, recordBytes: 65536 }
const bodies = { v1: 'Version one instructions. Keep the original action and dialogue.',
  v2: 'Version two instructions. Keep the original action and check continuity.' }
const descriptions = { v1: 'Review a scene using version one.', v2: 'Review a scene using version two.' }

/**
 * Change private defaults as an external operator while real creation Agents load their selected Skills.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Shipped Headless context with the real creation preset.
 */
export async function apply(ctx) {
  const cwd = process.cwd(), root = join(cwd, '.dsh/market-creation')
  const market = await importSnapshotModule(new URL('../../../packages/host/muse-market/src/index.ts', import.meta.url),
    new URL('../../../packages/host/muse-market/lib/index.js', import.meta.url))
  const activation = await importSnapshotModule(new URL('../../../packages/host/muse-market/src/activation.ts', import.meta.url),
    new URL('../../../packages/host/muse-market/lib/activation.js', import.meta.url))
  const packages = await importSnapshotModule(new URL('../../../packages/host/muse-market/src/package.ts', import.meta.url),
    new URL('../../../packages/host/muse-market/lib/package.js', import.meta.url))
  const { createUserMessage } = await importSnapshotModule(new URL('../../../packages/llm/llm/src/index.ts', import.meta.url),
    new URL('../../../packages/llm/llm/lib/index.js', import.meta.url))
  const { SessionId } = await importSnapshotModule(new URL('../../../packages/core/session/src/index.ts', import.meta.url),
    new URL('../../../packages/core/session/lib/index.js', import.meta.url))
  const creation = await importSnapshotModule(new URL('../../../apps/desktop-host/src/creation-skills.ts', import.meta.url),
    new URL('../../../apps/desktop-host/lib/creation-skills.js', import.meta.url))
  assert.ok(!creation.CREATION_SKILL_NAMES.includes(skillName))
  await ctx.plugin(market.default, { root, ...limits }).await()
  let local
  await ctx.inject(['museMarket'], owner => { local = owner.museMarket }).await()
  assert.ok(local)
  const releases = {}
  for (const [index, version] of ['v1', 'v2'].entries()) {
    const metadata = { name: 'version-bound-publication', title: 'Version-bound scene review',
      description: descriptions[version], version: `${index + 1}.0.0`, license: 'MIT', category: 'writing',
      examples: ['Review the supplied scene.'], requirements: ['The original scene.'] }
    const instructions = `---\nname: ${skillName}\ndescription: ${descriptions[version]}\nwhenToUse: When reviewing the supplied scene.\n---\n${bodies[version]}\n`
    const archive = packages.createMarketPackage({ ...metadata, formatVersion: 1, kind: 'skill',
      skills: [{ name: skillName, path: `skills/${skillName}/SKILL.md` }] }, {
      [`skills/${skillName}/SKILL.md`]: Buffer.from(instructions),
      [`skills/${skillName}/references/policy.md`]: Buffer.from(`Original resource ${version}.\n`),
    }, limits)
    const installed = await local.importPackage(Buffer.from(archive).toString('base64'))
    assert.equal(installed.enabled, false); releases[version] = installed.release
  }
  await ctx.plugin(activation.default).await()
  let active
  await ctx.inject(['museMarketActivation'], owner => { active = owner.museMarketActivation }).await()
  assert.ok(active)
  await active.setDefault({ skillName, expected: null, target: releases.v1.id })
  await mountPreset(ctx, { presetId: 'creation', hidePlatformShellTools: true })
  const roles = new Map(), events = new Map(), results = new Map(), requests = new Map(), seen = new Map()
  const handles = [], starts = [], settles = []
  let primary, blank, fresh, switched = false, proofWritten = false
  ctx.on('agent/created', ({ agent }) => {
    if (primary) return
    primary = agent; roles.set(agent.id, 'old')
  })
  ctx.effect(() => async () => { for (const handle of handles.reverse()) await handle.dispose() })
  const projected = agent => ctx.sessionProjections.snapshot(agent.session, ['museMarketBinding']).values.museMarketBinding
  async function assertBound(agent, version) {
    const binding = await active.binding({ sessionId: agent.id }), log = events.get(agent.id) ?? []
    const bound = log.filter(event => event.type === 'muse-market/bound'), firstHeader = log.find(event => event.type === 'request/header')
    assert.equal(binding.phase, 'bound'); assert.equal(bound.length, 1); assert.notEqual(bound[0].ignorable, true)
    assert.deepEqual(bound[0].data.releases.map(entry => entry.release), [releases[version]])
    assert.deepEqual(binding.releases, bound[0].data.releases)
    assert.equal(projected(agent).bound, true); assert.deepEqual(projected(agent).releases, binding.releases)
    if (firstHeader) assert.ok(bound[0].seq < firstHeader.seq)
  }
  async function create(role) {
    const handle = await ctx.agents.create({ sessionId: SessionId(randomUUID()), parentAgent: primary,
      meta: { cwd, parentSession: primary.id }, agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } })
    handles.push(handle); roles.set(handle.agent.id, role)
    return handle.agent
  }
  async function exercise(agent) {
    agent.send(createUserMessage({ content: [{ type: 'text', text: `Load ${skillName} through the creation Skill tool, read its complete result, then reply exactly CREATION_VERSION_TWO.` }], source: { kind: 'user' } }), 'next-turn', true)
    await agent.whenIdle(); await assertBound(agent, 'v2')
    assert.equal(requests.get(agent.id), 2); assert.equal(seen.get(agent.id).size, 1)
  }
  ctx.on('session/event', (session, event) => {
    const log = events.get(session.id) ?? []; log.push(event); events.set(session.id, log)
    if (event.type === 'tool/result') {
      assert.equal(event.data.message.isError, false)
      results.set(event.data.message.toolCallId, event.data.message)
    }
    if (event.type === 'tool/ptc-dispatch-start') { assert.equal(event.data.name, 'skill'); starts.push(event.data) }
    if (event.type === 'tool/ptc-dispatch') { assert.equal(event.data.name, 'skill'); assert.equal(event.data.isError, false); settles.push(event.data) }
  })
  ctx.on('llm/stream', async function* (options, next) {
    const agent = ctx.agents.get(options.sessionId), role = roles.get(options.sessionId)
    assert.ok(agent); assert.ok(role)
    const version = role === 'old' ? 'v1' : 'v2', count = (requests.get(agent.id) ?? 0) + 1
    requests.set(agent.id, count); await assertBound(agent, version)
    assert.deepEqual(options.tools.map(tool => tool.name), ['run_code'])
    const catalog = options.messages.filter(message => message.source?.kind === 'skill-catalog').at(-1)
    assert.ok(catalog)
    assert.deepEqual(catalog.source.entries, [{ name: skillName,
      description: `When to use: When reviewing the supplied scene. Description: ${descriptions[version]}` }])
    const observed = seen.get(agent.id) ?? new Set()
    for (const message of options.messages) {
      if (message.role !== 'tool' || !message.toolCallId.startsWith('call_creation_skill_')) continue
      assert.deepEqual(message.content, results.get(message.toolCallId).content)
      const value = JSON.parse(message.content[0].text)
      assert.equal(value.name, skillName); assert.equal(value.provider, 'muse-creation'); assert.equal(value.content, bodies[version])
      assert.equal(value.resourceBase.kind, 'directory'); assert.ok(value.resourceBase.path.includes(releases[version].id))
      assert.deepEqual(await readFile(join(value.resourceBase.path, 'references/policy.md')), Buffer.from(`Original resource ${version}.\n`))
      observed.add(message.toolCallId)
    }
    seen.set(agent.id, observed)
    if (role === 'old' && count === 2) {
      assert.equal(switched, false); assert.equal(observed.size, 1)
      blank = await create('blank')
      assert.equal((await active.binding({ sessionId: blank.id })).phase, 'blank')
      assert.deepEqual(projected(blank), { bound: false, requested: false, releases: [] })
      const changed = await active.setDefault({ skillName, expected: releases.v1.id, target: releases.v2.id })
      assert.deepEqual(changed.defaults, [{ skillName, releaseId: releases.v2.id }]); switched = true
      await assertBound(primary, 'v1'); await exercise(blank)
      fresh = await create('fresh'); await exercise(fresh)
    }
    if (role === 'old' && count === 3) {
      assert.equal(proofWritten, false); assert.equal(observed.size, 2); assert.equal(switched, true)
      await assertBound(primary, 'v1'); await assertBound(blank, 'v2'); await assertBound(fresh, 'v2')
      assert.equal(starts.length, 4); assert.equal(settles.length, 4)
      const proof = { oldReleaseSha256: releases.v1.sha256, newReleaseSha256: releases.v2.sha256,
        oldSessionReleaseSha256: releases.v1.sha256, blankFirstTaskReleaseSha256: releases.v2.sha256,
        freshFirstTaskReleaseSha256: releases.v2.sha256, outsideCreationAllowlist: true, actualCreationPresetAndPolicy: true,
        sourceScopePreserved: true, completeSkillResultsReachedNextModel: true, originalReferenceBytesMatch: true,
        bindingEventsPerSession: { old: 1, blank: 1, fresh: 1 }, eventAndProjectionIdentityMatch: true,
        blankWasUnboundBeforeFirstTask: true, modelRequests: { old: 3, blank: 2, fresh: 2 },
        ptcDispatchStarts: starts.length, ptcDispatchSettles: settles.length }
      await writeFile(join(cwd, 'market-creation-proof.json'), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' }); proofWritten = true
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', ({ agent }) => {
    if (agent === primary) { assert.equal(requests.get(agent.id), 3); assert.equal(proofWritten, true) }
  })
}
