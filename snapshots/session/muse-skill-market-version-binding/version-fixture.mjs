/** Real publication defaults and first-task Session version binding through Native/PTC. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { importSnapshotModule } from '../muse-fixture-import.mjs'
export const name = 'market-version-binding-fixture'
export const inject = ['tools', 'skills', 'agents', 'sessions', 'sessionProjections']
const skillName = 'version-bound-review'
const limits = { archiveBytes: 1048576, expandedBytes: 2097152, fileCount: 32, recordBytes: 65536 }
const bodies = { v1: 'Version one instructions. Keep the original action and dialogue.\n',
  v2: 'Version two instructions. Keep the original action and check continuity.\n' }
const descriptions = { v1: 'Review a scene using version one.', v2: 'Review a scene using version two.' }

/**
 * Mount real storage/activation and observe every complete Skill result in the next request.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Shipped Headless context.
 * @param {{executor:'native'|'ptc'}} config - Real tool executor.
 */
export async function apply(ctx, config) {
  const cwd = process.cwd(), root = join(cwd, '.dsh/market-versions')
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
  await ctx.plugin(market.default, { root, ...limits }).await()
  let local
  await ctx.inject(['museMarket'], owner => { local = owner.museMarket }).await()
  assert.ok(local)
  const releases = {}
  for (const [index, version] of ['v1', 'v2'].entries()) {
    const metadata = { name: 'version-bound-publication', title: 'Version-bound scene review',
      description: descriptions[version], version: `${index + 1}.0.0`, license: 'MIT', category: 'writing',
      examples: ['Review the supplied scene.'], requirements: ['The original scene.'] }
    const instructions = `---\nname: ${skillName}\ndescription: ${descriptions[version]}\nwhenToUse: When reviewing the supplied scene.\n---\n${bodies[version]}`
    const files = { [`skills/${skillName}/SKILL.md`]: Buffer.from(instructions),
      [`skills/${skillName}/references/policy.md`]: Buffer.from(`Original resource ${version}.\n`) }
    const archive = packages.createMarketPackage({ ...metadata, formatVersion: 1, kind: 'skill',
      skills: [{ name: skillName, path: `skills/${skillName}/SKILL.md` }] }, files, limits)
    const installed = await local.importPackage(Buffer.from(archive).toString('base64'))
    assert.equal(installed.enabled, false); releases[version] = installed.release
  }
  await ctx.plugin(activation.default).await()
  let active
  await ctx.inject(['museMarketActivation'], owner => { active = owner.museMarketActivation }).await()
  assert.ok(active)
  await active.setDefault({ skillName, expected: null, target: releases.v1.id })
  const roles = new Map(), handles = [], modelObservations = new Map(), fullResults = new Map()
  let primary, blank, fresh, switched, outerCalls = 0, proofWritten = false
  const results = new Map(), observed = new Set(), eventsBySession = new Map(), starts = [], settles = []
  ctx.on('agent/created', ({ agent }) => {
    if (primary) return
    primary = agent; roles.set(agent.id, 'old')
  })
  const binding = agent => active.binding({ sessionId: agent.id })
  const projection = agent => ctx.sessionProjections.snapshot(agent.session, ['museMarketBinding']).values.museMarketBinding
  async function assertBound(agent, version) {
    const value = await binding(agent), events = (eventsBySession.get(agent.id) ?? []).filter(event => event.type === 'muse-market/bound')
    assert.equal(value.phase, 'bound'); assert.equal(events.length, 1)
    assert.notEqual(events[0].ignorable, true)
    assert.deepEqual(value.releases, events[0].data.releases)
    const firstRequest = (eventsBySession.get(agent.id) ?? []).find(event => event.type === 'request/header')
    if (firstRequest) assert.ok(events[0].seq < firstRequest.seq)
    assert.deepEqual(events[0].data.releases.map(entry => entry.release), [releases[version]])
    const projected = projection(agent)
    assert.equal(projected.bound, true); assert.deepEqual(projected.releases, value.releases)
    const definition = await ctx.skills.get(skillName, { cwd, scope: agent })
    assert.ok(definition); assert.equal(definition.content, bodies[version].trim()); assert.equal(definition.description, descriptions[version])
    assert.equal(definition.resourceBase.kind, 'directory')
    assert.ok(definition.resourceBase.path.includes(releases[version].id))
    assert.deepEqual(await readFile(join(definition.resourceBase.path, 'references/policy.md')), Buffer.from(`Original resource ${version}.\n`))
    return value
  }
  async function create(role) {
    const handle = await ctx.agents.create({ sessionId: SessionId(randomUUID()), parentAgent: primary, meta: { cwd, parentSession: primary.id },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      setup(agentCtx) { agentCtx.effect(() => agentCtx.tools.restrict({ allow: ['skill'], includeOwn: true })) } })
    handles.push(handle); roles.set(handle.agent.id, role)
    return handle.agent
  }
  async function exercise(agent) {
    agent.send(createUserMessage({ content: [{ type: 'text', text: `Load ${skillName} and follow its complete instructions. Reply exactly VERSION_TWO_OBSERVED.` }], source: { kind: 'user' } }), 'next-turn', true)
    await agent.whenIdle()
    const value = await assertBound(agent, 'v2')
    assert.equal(modelObservations.get(agent.id), 2)
    assert.equal(fullResults.get(agent.id).length, 1)
    return { binding: value, projection: projection(agent) }
  }
  ctx.effect(() => async () => { for (const handle of handles.reverse()) await handle.dispose() })
  ctx.effect(() => ctx.tools.register({ name: 'market_version',
    description: 'Exercise real default-version switching and first-task bindings for the fixture publications.',
    parameters: { type: 'object', required: ['operation'], properties: { operation: { type: 'string', enum: ['switch-default', 'exercise-blank', 'exercise-fresh'] } }, additionalProperties: false },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) {
      assert.ok(primary)
      if (args.operation === 'switch-default') {
        assert.equal(switched, undefined); await assertBound(primary, 'v1')
        blank = await create('blank')
        const before = await binding(blank); assert.equal(before.phase, 'blank')
        assert.deepEqual(projection(blank), { bound: false, requested: false, releases: [] })
        assert.equal((eventsBySession.get(blank.id) ?? []).filter(event => event.type === 'muse-market/bound').length, 0)
        switched = await active.setDefault({ skillName, expected: releases.v1.id, target: releases.v2.id })
        const after = await assertBound(primary, 'v1')
        return { defaults: switched, blankBeforeFirstTask: before, oldBindingAfterSwitch: after }
      }
      assert.ok(switched)
      if (args.operation === 'exercise-blank') return await exercise(blank)
      assert.equal(args.operation, 'exercise-fresh'); fresh = await create('fresh')
      return await exercise(fresh)
    },
  }))
  ctx.on('session/event', (session, event) => {
    const events = eventsBySession.get(session.id) ?? []; events.push(event); eventsBySession.set(session.id, events)
    if (event.type === 'tool/result') {
      assert.notEqual(event.data.message.isError, true)
      const list = fullResults.get(session.id) ?? []
      if (event.data.message.toolCallId.startsWith('call_version_skill')) { list.push(event.data.message); fullResults.set(session.id, list) }
      if (/^call_version_[1-5]$/.test(event.data.message.toolCallId)) { results.set(event.data.message.toolCallId, event.data.message); outerCalls++ }
    }
    if (event.type === 'tool/ptc-dispatch-start') starts.push(event.data)
    if (event.type === 'tool/ptc-dispatch') { assert.equal(event.data.isError, false); settles.push(event.data) }
  })
  ctx.on('llm/stream', async function* (options, next) {
    const agent = ctx.agents.get(options.sessionId)
    assert.ok(agent)
    const role = roles.get(agent.id); assert.ok(role)
    modelObservations.set(agent.id, (modelObservations.get(agent.id) ?? 0) + 1)
    const version = role === 'old' ? 'v1' : 'v2'
    await assertBound(agent, version)
    const catalog = options.messages.filter(message => message.source?.kind === 'skill-catalog').at(-1)
    assert.ok(catalog); assert.deepEqual(catalog.source.entries, [{ name: skillName, description: `When to use: When reviewing the supplied scene. Description: ${descriptions[version]}` }])
    for (const message of options.messages) {
      if (message.role !== 'tool') continue
      const actual = agent.session.deriveMessages().find(candidate => candidate.role === 'tool' && candidate.toolCallId === message.toolCallId)
      assert.ok(actual); assert.deepEqual(message.content, actual.content)
      if (message.toolCallId.startsWith('call_version_skill') || ['call_version_1', 'call_version_3'].includes(message.toolCallId)) {
        assert.ok(message.content.some(block => block.type === 'text' && block.text.includes(bodies[version].trim())))
      }
      if (/^call_version_[1-5]$/.test(message.toolCallId)) { assert.deepEqual(message.content, results.get(message.toolCallId).content); observed.add(message.toolCallId) }
    }
    if (!proofWritten && observed.size === 5) {
      await assertBound(primary, 'v1'); await assertBound(blank, 'v2'); await assertBound(fresh, 'v2')
      assert.equal(outerCalls, 5); assert.equal(modelObservations.get(primary.id), 6)
      assert.equal(starts.length, config.executor === 'ptc' ? 7 : 0); assert.equal(settles.length, starts.length)
      const proof = { oldReleaseSha256: releases.v1.sha256, newReleaseSha256: releases.v2.sha256,
        oldSessionReleaseSha256: releases.v1.sha256, blankFirstTaskReleaseSha256: releases.v2.sha256,
        freshFirstTaskReleaseSha256: releases.v2.sha256, oldBindingRetained: true, blankWasUnboundBeforeFirstTask: true,
        bindingEventsPerSession: { old: 1, blank: 1, fresh: 1 }, eventProjectionAndProviderIdentityMatch: true,
        completeSkillResultsReachedNextModel: true, completeLifecycleResultsReachedNextModel: true,
        modelRequests: { old: 6, blank: 2, fresh: 2 }, ptcDispatchStarts: starts.length, ptcDispatchSettles: settles.length, executor: config.executor }
      await writeFile(join(cwd, 'market-version-proof.json'), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' }); proofWritten = true
    }
    yield* next()
  })
}
