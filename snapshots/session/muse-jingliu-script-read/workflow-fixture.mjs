/** Exercise the production workflow tool against an offline Jingliu project. */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { apply as mountPreset } from '../muse-editing-tool-catalog/editing-preset-fixture.mjs'
import { importSnapshotModule, importSnapshotPackage } from '../muse-fixture-import.mjs'

const desktopOwner = new URL('../../../apps/desktop-host/package.json', import.meta.url)
const { composeEntries, loadOverlayPatches } = await importSnapshotPackage('@deepseek-ai/dsh-app-boot', desktopOwner)
const overlay = fileURLToPath(new URL('../../../apps/desktop-host/config/desktop.cordis.patch.yml', import.meta.url))
const project = '31dd6a12a591'
const text = '阿青推开老影院的门。'
const definition = {
  name: 'read_script', description: '读取指定项目的剧本。', role: 'viewer', risk: 'read',
  account_scoped: false, costs: false, needs_confirm: false, long_running: false,
  parameters: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'] },
}

/** Cordis fixture name. */
export const name = 'jingliu-script-read'
/** Host services exercised by this Headless scenario. */
export const inject = ['agentPresets', 'agents', 'llm', 'systemPrompt', 'tools', 'workingDirectory']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Shipped Headless services. */
export async function apply(ctx) {
  const patches = loadOverlayPatches('jingliu-script-read', overlay)
  const rows = composeEntries([patches])
  const preset = patches.find(row => row.id === 'agent-preset-registry')?.config.default
  const jingliuConnection = rows.find(row => row.id === 'jingliu-connection')
  const jingliuTool = rows.find(row => row.id === 'tool-jingliu')
  assert.equal(preset, 'short-drama')
  assert.equal(jingliuConnection?.name, '@deepseek-ai/dsh-jingliu-connection')
  assert.equal(jingliuTool?.name, '@deepseek-ai/dsh-tool-jingliu')
  assert.ok(!jingliuConnection.disabled && !jingliuTool.disabled, 'Jingliu stays mounted without a configured origin')
  assert.ok(!rows.some(row => row.name === '@deepseek-ai/dsh-tool-jubian'), 'Desktop cannot mount a legacy production provider')
  const plugin = await importSnapshotModule(
    new URL('../../../packages/drama/tool-jingliu/src/index.ts', import.meta.url),
    new URL('../../../packages/drama/tool-jingliu/lib/index.js', import.meta.url),
  )
  let reads = 0
  let modelSawScript = false
  ctx.effect(() => ctx.provide('jingliuConnection', { async connection() {
    return {
      identity: 'snapshot-reader',
      async request(path, options) {
        if (path === '/desktop-agent/tools') return { count: 1, tools: [definition] }
        assert.equal(path, '/desktop-agent/tool')
        assert.equal(options.method, 'POST')
        assert.deepEqual(options.body.args, { project_id: project })
        assert.equal(options.body.project_id, project)
        assert.equal(options.body.name, 'read_script')
        assert.equal(options.body.confirmed, false)
        reads++
        return { ok: true, text }
      },
    }
  } }))
  await ctx.plugin(plugin, jingliuTool.config)
  await mountPreset(ctx, { presetId: preset, hidePlatformShellTools: true })
  ctx.on('llm/stream', async function* (options, next) {
    const names = options.tools.map(tool => tool.name)
    for (const name of ['jingliu_workflows', 'jingliu_run', 'jingliu_narration']) {
      assert.ok(names.includes(name), `Missing Desktop tool ${name}`)
    }
    assert.deepEqual(names.filter(name => /^(?:jubian_|muse_production$)/u.test(name)), [],
      'No legacy production tools in the active preset')
    const system = options.messages.filter(message => message.role === 'system')
      .flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\n')
    assert.match(system, /jingliu_workflows/u)
    assert.doesNotMatch(system, /\bjubian_\w+|\bmuse_production\b/u)
    const result = options.messages.find(message => message.role === 'tool' && message.toolCallId === 'read-jingliu-script')
    if (result) {
      assert.equal(result.isError, false)
      const block = result.content.find(item => item.type === 'text')
      assert.deepEqual(JSON.parse(block.text), { workflow: 'read_script', project_id: project, result: { ok: true, text } })
      modelSawScript = true
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', () => {
    assert.equal(reads, 1)
    assert.ok(modelSawScript, 'The model receives the read result from the selected Jingliu project')
  })
}
