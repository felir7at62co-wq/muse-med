/** Real native visualization calls in the product's default short-drama preset. */
import assert from 'node:assert/strict'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { apply as mountPreset } from '../muse-editing-tool-catalog/editing-preset-fixture.mjs'
import { importSnapshotModule } from '../muse-fixture-import.mjs'

const Discovery = await importSnapshotModule(new URL('../../../packages/core/tool-discovery/src/index.ts', import.meta.url),
  new URL('../../../packages/core/tool-discovery/lib/index.js', import.meta.url))

/** Loader identity for the native visualization conversation. */
export const name = 'snapshot-muse-visualize'
/** Product preset, real Skill catalog, tool and Session services. */
export const inject = ['agentPresets', 'tools', 'systemPrompt', 'workingDirectory', 'skills', 'llm', 'agents', 'sessions']

/**
 * Stage the runtime under the private home and retain its real file writes and result metadata.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Isolated Headless context.
 * @returns {Promise<void>} Readiness after the real tool, preset and discovery are active.
 */
export async function apply(ctx) {
  const cwd = process.cwd()
  const currentEvents = new Map()
  ctx.on('session/event', (session, event) => {
    if (session.header.origin === 'subagent') return
    const events = currentEvents.get(session.id) ?? []
    assert.ok(events.length < 256, 'The bounded native visualization scenario must not grow extra turns')
    events.push(event)
    currentEvents.set(session.id, events)
  })
  const plugin = join(cwd, '.dsh', 'plugins', 'dsh-visualize')
  await mkdir(plugin, { recursive: true })
  const source = process.env.MUSE_VISUALIZE_PACKAGE
    ?? fileURLToPath(new URL('../../../third_party/plugins/dsh-visualize/', import.meta.url))
  for (const part of ['src', 'assets', 'package.json']) await cp(join(source, part), join(plugin, part), { recursive: true })
  if (process.env.MUSE_VISUALIZE_PACKAGE) await cp(join(source, 'lib'), join(plugin, 'lib'), { recursive: true })
  const entry = process.env.MUSE_VISUALIZE_PACKAGE ? 'lib/index.js' : 'src/index.ts'
  const visualize = await import(pathToFileURL(join(plugin, entry)).href)
  await ctx.plugin(visualize, {}).await()
  await mountPreset(ctx, { presetId: 'short-drama', hidePlatformShellTools: true })
  const row = loadOverlayPatches('visualize-residency', fileURLToPath(new URL(
    '../../../apps/desktop-host/config/desktop.cordis.patch.yml', import.meta.url,
  ))).flatMap(patch => patch.insert ?? []).find(entry => entry.id === 'tool-discovery')
  assert.ok(row)
  assert.ok(row.config.alwaysLoad.includes('visualize'))
  assert.ok(row.config.excludeFromSearch.includes('visualize'))
  await ctx.plugin(Discovery, Discovery.Config(row.config)).await()
  let requests = 0, skillRead = false, createRead = false, updateRead = false
  ctx.on('llm/stream', async function* (options, next) {
    assert.equal(options.provider, 'snapshot-visualize')
    assert.equal(options.model, 'local-fixture')
    assert.ok(options.tools.some(tool => tool.name === 'visualize'), 'Visualization must be available without search')
    assert.ok(options.tools.some(tool => tool.name === 'skill'))
    const agent = ctx.agents.get(options.sessionId)
    assert.ok(agent)
    assert.ok(ctx.agentPresets.inspectCompositions(agent.ctx).some(preset => preset.id === 'short-drama'))
    assert.ok(options.messages.some(message => message.role === 'system'
      && message.content.some(block => block.type === 'text' && block.text.includes('你是 muse-med 短剧编导 Agent'))))
    for (const message of options.messages) {
      if (message.role !== 'tool') continue
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      if (message.toolCallId === 'call_visualize_skill') {
        assert.ok(text.includes('<skill_content name="visualize">'))
        assert.ok(text.includes('dshViz'))
        skillRead = true
      }
      if (message.toolCallId === 'call_visualize_create') { assert.ok(text.includes('Rendered')); createRead = true }
      if (message.toolCallId === 'call_visualize_update') { assert.ok(text.includes('Patched'), text); updateRead = true }
    }
    requests++
    yield* next()
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const events = currentEvents.get(agent.session.id)
    assert.ok(events)
    const calls = events.filter(event => event.type === 'tool/call')
    assert.deepEqual(calls.map(event => event.data.name), ['skill', 'visualize', 'visualize'])
    const results = events.filter(event => event.type === 'tool/result')
    assert.equal(results.length, 3)
    for (const result of results) assert.equal(result.data.message.isError, false,
      result.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
    const created = results[1].data.meta
    const updated = results[2].data.meta
    assert.equal(created.kind, 'visualize')
    assert.equal(updated.kind, 'visualize')
    assert.equal(created.path, updated.path)
    const homePath = ctx.get('dshHomePath')
    assert.equal(typeof homePath, 'function')
    assert.ok(created.path.startsWith(homePath('visualize', 'sessions') + '/'),
      JSON.stringify({ path: created.path, home: homePath('visualize'), cwd, sessionId: agent.session.id }))
    assert.ok(created.fragment.includes('预算方案 V1'))
    assert.ok(updated.fragment.includes('预算方案 V2'))
    assert.ok(!updated.fragment.includes('预算方案 V1'))
    assert.equal(await readFile(updated.path, 'utf8'), updated.fragment)
    assert.ok(skillRead && createRead && updateRead)
    const header = events.find(event => event.type === 'request/header')
    assert.ok(header.data.header.tools.some(tool => tool.name === 'visualize'))
    await writeFile(join(cwd, 'visualization.html'), updated.fragment + '\n', { flag: 'wx' })
    await writeFile(join(cwd, 'visualize-proof.json'), JSON.stringify({
      preset: 'short-drama', requests, firstRequestIncludesVisualize: true, skillRead,
      calls: calls.map(event => event.data.name), discoveryCalls: 0,
      createdAndUpdated: true, stableCardPath: created.path === updated.path,
      persistedMeta: true, savedFileMatchesMeta: true, externalResources: false,
    }, null, 2) + '\n', { flag: 'wx' })
  })
  ctx.provide('snapshotVisualizeReady', { ready: true })
}
