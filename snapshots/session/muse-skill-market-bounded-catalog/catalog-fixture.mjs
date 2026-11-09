/** Complete metadata discovery and retained bodies through actual bounded Skill tools. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { importSnapshotModule } from '../muse-fixture-import.mjs'
import { apply as mountPreset } from '../muse-editing-tool-catalog/editing-preset-fixture.mjs'

export const name = 'market-bounded-catalog-fixture'
export const inject = ['tools', 'skills', 'agents', 'sessions', 'sessionProjections', 'workingDirectory', 'systemPrompt']
const hidden = 'human-only-control'
const bodyMarker = 'body-only-search-marker'
const limits = { archiveBytes: 1048576, expandedBytes: 2097152, fileCount: 32, recordBytes: 1048576 }

/**
 * Mount immutable publications and observe complete model-visible results from real tools.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Shipped Headless composition.
 * @param {{executor:'native'|'ptc'}} config - Native loader or the real creation preset.
 */
export async function apply(ctx, config) {
  const ptc = config.executor === 'ptc', count = ptc ? 14 : 3, cap = ptc ? 12 : 2
  const cwd = process.cwd(), root = join(cwd, '.dsh/bounded-market')
  const market = await importSnapshotModule(new URL('../../../packages/host/muse-market/src/index.ts', import.meta.url),
    new URL('../../../packages/host/muse-market/lib/index.js', import.meta.url))
  const activation = await importSnapshotModule(new URL('../../../packages/host/muse-market/src/activation.ts', import.meta.url),
    new URL('../../../packages/host/muse-market/lib/activation.js', import.meta.url))
  const packages = await importSnapshotModule(new URL('../../../packages/host/muse-market/src/package.ts', import.meta.url),
    new URL('../../../packages/host/muse-market/lib/package.js', import.meta.url))
  await ctx.plugin(market.default, { root, ...limits }).await()
  let local
  await ctx.inject(['museMarket'], owner => { local = owner.museMarket }).await()
  assert.ok(local)
  const releases = [], marketNames = [], bodies = new Map()
  for (let index = 1; index <= count; index++) {
    const name = `market-scene-${String(index).padStart(2, '0')}`
    const content = `${bodyMarker}. Preserve the original scene and dialogue (${name}).`
    marketNames.push(name); bodies.set(name, content)
    const description = 'Review a scene using a retained market publication.'
    const manifest = { name: `publication-${name}`, title: `Scene review ${index}`, description,
      version: '1.0.0', license: 'MIT', category: 'writing', examples: ['Review the supplied scene.'],
      requirements: ['The original scene.'], formatVersion: 1, kind: 'skill',
      skills: [{ name, path: `skills/${name}/SKILL.md` }] }
    const archive = packages.createMarketPackage(manifest, {
      [`skills/${name}/SKILL.md`]: Buffer.from(`---\nname: ${name}\ndescription: ${description}\nwhenToUse: For scene review.\n---\n${content}\n`),
      [`skills/${name}/references/rules.md`]: Buffer.from(`Original reference for ${name}.\n`),
    }, limits)
    const installation = await local.importPackage(Buffer.from(archive).toString('base64'))
    assert.equal(installation.enabled, false)
    releases.push(installation.release)
  }
  await ctx.plugin(activation.default).await()
  let active
  await ctx.inject(['museMarketActivation'], owner => { active = owner.museMarketActivation }).await()
  assert.ok(active)
  for (const release of releases) await active.setDefault({ skillName: release.manifest.skills[0].name,
    expected: null, target: release.id })
  const controls = ptc ? ['other-control-one'] : ['other-control-one', 'other-control-two', 'other-control-three']
  for (const name of controls) ctx.effect(() => ctx.skills.register({ name, description: `Unconfigured source ${name}.`,
    whenToUse: 'For another task.', source: 'custom', content: 'Unconfigured private instruction body.' }))
  ctx.effect(() => ctx.skills.register({ name: hidden, description: 'For a direct human Skill gesture only.',
    source: 'custom', content: 'Never authorize this body through model discovery.',
    invocation: { modelInvocable: false, userInvocable: true } }))
  if (ptc) await ctx.inject(['agentPresets'], owner => mountPreset(owner,
    { presetId: 'creation', hidePlatformShellTools: true })).await()

  const omitted = marketNames.at(-1), expectedNames = [...marketNames, ...controls].sort()
  const expectedVisible = [...marketNames.slice(0, cap), ...controls].sort()
  const results = new Map(), calls = new Map(), observed = new Set(), dispatches = [], settled = []
  const metadataPages = [], bindingEvents = []
  const directoryRefusals = { foreign: false, stale: false, invalid: false }
  const refusalCodes = { call_bounded_foreign: ['foreign', 'SKILL_CATALOG_FOREIGN_CURSOR'],
    call_bounded_stale: ['stale', 'SKILL_CATALOG_STALE_CURSOR'],
    call_bounded_invalid: ['invalid', 'SKILL_CATALOG_INVALID_REQUEST'] }
  let primary, requests = 0, catalogNames, proofWritten = false, loaded = false, disabledRefused = false
  ctx.on('agent/created', ({ agent }) => {
    assert.equal(primary, undefined); primary = agent
    if (!ptc) agent.ctx.effect(() => agent.ctx.tools.restrict({ allow: ['skill', 'skill_catalog'], includeOwn: true }))
  })
  function metadata(page) {
    assert.equal(page.catalogComplete, true)
    for (const entry of page.entries) {
      assert.deepEqual(Object.keys(entry).sort(), ['description', 'name', 'source', 'whenToUse'])
      assert.ok(expectedNames.includes(entry.name)); assert.notEqual(entry.name, hidden)
      assert.ok(!JSON.stringify(entry).includes(bodyMarker)); assert.ok(!JSON.stringify(entry).includes(cwd))
    }
  }
  ctx.on('session/event', (session, event) => {
    if (event.type === 'muse-market/bound') {
      assert.notEqual(event.ignorable, true); bindingEvents.push(event)
      assert.deepEqual(event.data.releases.map(entry => entry.release), releases)
    }
    if (event.type === 'tool/result') results.set(event.data.message.toolCallId, event.data.message)
    if (event.type === 'tool/call') calls.set(event.data.callId, JSON.parse(event.data.arguments))
    if (event.type === 'tool/ptc-dispatch-start') dispatches.push(event.data)
    if (event.type === 'tool/ptc-dispatch') {
      if (event.data.isError) {
        assert.equal(event.data.name, 'skill'); assert.equal(event.data.arguments.name, hidden)
      }
      settled.push(event.data)
    }
  })
  ctx.on('llm/stream', async function* (options, next) {
    const agent = ctx.agents.get(options.sessionId)
    assert.ok(agent); assert.equal(agent, primary); requests++
    const binding = await active.binding({ sessionId: agent.id })
    assert.equal(binding.phase, 'bound'); assert.equal(bindingEvents.length, 1)
    assert.deepEqual(binding.releases.map(entry => entry.release), releases)
    const projection = ctx.sessionProjections.snapshot(agent.session, ['museMarketBinding']).values.museMarketBinding
    assert.equal(projection.bound, true); assert.deepEqual(projection.releases, binding.releases)
    assert.deepEqual(options.tools.map(tool => tool.name).sort(), ptc ? ['run_code'] : ['skill', 'skill_catalog'])
    const catalog = options.messages.filter(message => message.source?.kind === 'skill-catalog').at(-1)
    assert.ok(catalog); assert.equal(catalog.source.bounded, true); assert.equal(catalog.source.incomplete, undefined)
    catalogNames = catalog.source.entries.map(entry => entry.name)
    assert.deepEqual([...catalogNames].sort(), expectedVisible)
    assert.ok(!catalogNames.includes(omitted)); assert.ok(catalog.content.some(block => block.type === 'text' && block.text.includes('skill_catalog')))
    for (const message of options.messages) {
      if (message.role !== 'tool' || !message.toolCallId.startsWith('call_bounded_')) continue
      assert.deepEqual(message.content, results.get(message.toolCallId).content)
      if (observed.has(message.toolCallId)) continue
      observed.add(message.toolCallId)
      if (ptc && message.toolCallId === 'call_bounded_ptc_catalog') {
        assert.equal(message.isError, false)
        const value = JSON.parse(message.content[0].text)
        value.pages.forEach(metadata); metadataPages.push(...value.pages)
        assert.deepEqual(value.query.entries.map(entry => entry.name), [omitted]); metadata(value.query)
        assert.deepEqual(value.bodyOnly, { entries: [], totalMatched: 0, catalogComplete: true })
        assert.deepEqual(value.hidden, { entries: [], totalMatched: 0, catalogComplete: true })
        assert.ok(value.disabledLoadError.includes('not available for model invocation')); disabledRefused = true
      } else if (!ptc && message.toolCallId.startsWith('call_bounded_page_')) {
        assert.equal(message.isError, false)
        if (metadataPages.length > 0) {
          assert.deepEqual(calls.get(message.toolCallId).cursor, metadataPages.at(-1).nextCursor)
        }
        const page = JSON.parse(message.content[0].text); metadata(page); metadataPages.push(page)
      } else if (!ptc && message.toolCallId === 'call_bounded_query') {
        const page = JSON.parse(message.content[0].text); metadata(page)
        assert.deepEqual(page.entries.map(entry => entry.name), [omitted])
      } else if (!ptc && ['call_bounded_body_query', 'call_bounded_disabled_query'].includes(message.toolCallId)) {
        assert.deepEqual(JSON.parse(message.content[0].text), { entries: [], totalMatched: 0, catalogComplete: true })
      } else if (!ptc && refusalCodes[message.toolCallId] !== undefined) {
        const [key, code] = refusalCodes[message.toolCallId]
        assert.equal(message.isError, true)
        assert.ok(message.content.some(block => block.type === 'text' && block.text.includes(code)))
        directoryRefusals[key] = true
      } else if (!ptc && message.toolCallId === 'call_bounded_disabled_load') {
        assert.equal(message.isError, true)
        assert.ok(message.content.some(block => block.type === 'text' && block.text.includes('not available for model invocation')))
        disabledRefused = true
      } else if (message.toolCallId === (ptc ? 'call_bounded_ptc_load' : 'call_bounded_load')) {
        assert.equal(message.isError, false)
        if (ptc) {
          const value = JSON.parse(message.content[0].text)
          assert.equal(value.name, omitted); assert.equal(value.content, bodies.get(omitted)); assert.equal(value.provider, 'muse-creation')
          assert.equal(value.resourceBase.kind, 'directory')
          assert.deepEqual(await readFile(join(value.resourceBase.path, 'references/rules.md')), Buffer.from(`Original reference for ${omitted}.\n`))
        } else assert.ok(message.content.some(block => block.type === 'text' && block.text.includes(bodies.get(omitted))))
        loaded = true
      }
    }
    if (loaded && disabledRefused && !proofWritten) {
      const found = metadataPages.flatMap(page => page.entries.map(entry => entry.name)).sort()
      assert.deepEqual(found, expectedNames)
      assert.equal(metadataPages[0].totalMatched, expectedNames.length)
      assert.equal(metadataPages.at(-1).nextCursor, undefined)
      if (ptc) {
        const pageCalls = dispatches.filter(call => call.name === 'skill_catalog' && call.arguments.query === undefined)
        assert.equal(pageCalls.length, metadataPages.length)
        for (let index = 1; index < pageCalls.length; index++) {
          assert.deepEqual(pageCalls[index].arguments.cursor, metadataPages[index - 1].nextCursor)
        }
        assert.equal(dispatches.length, 13); assert.equal(settled.length, 13)
        assert.equal(requests, 3)
      } else assert.deepEqual(directoryRefusals, { foreign: true, stale: true, invalid: true })
      const proof = { executor: config.executor, actualCreationPreset: ptc, marketArchives: count, sourceLimit: cap,
        initialVisibleCatalogNames: [...catalogNames].sort(), fullEligibleNames: found, omittedMarketName: omitted,
        metadataPageCount: metadataPages.length, metadataOnly: true, fullDirectoryComplete: true,
        omittedSkillLoaded: true, modelDisabledNotListed: true, modelDisabledLoadRefused: true,
        completeToolResultsReachedNextModel: true, bindingEventCount: bindingEvents.length,
        boundReleaseCount: binding.releases.length, eventAndProjectionIdentityMatch: true,
        modelRequests: requests, ptcDispatchStarts: dispatches.length, ptcDispatchSettles: settled.length,
        ...ptc ? {} : { directoryRefusals } }
      await writeFile(join(cwd, 'market-catalog-proof.json'), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' })
      proofWritten = true
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', () => { assert.equal(proofWritten, true) })
}
