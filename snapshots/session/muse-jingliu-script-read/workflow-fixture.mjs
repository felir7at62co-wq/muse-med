/** Exercise the production workflow tool against an offline Jingliu project. */
import assert from 'node:assert/strict'
import { importSnapshotModule } from '../muse-fixture-import.mjs'

const plugin = await importSnapshotModule(
  new URL('../../../packages/drama/tool-jingliu/src/index.ts', import.meta.url),
  new URL('../../../packages/drama/tool-jingliu/lib/index.js', import.meta.url),
)
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
export const inject = ['tools', 'llm']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Shipped Headless services. */
export async function apply(ctx) {
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
  await ctx.plugin(plugin)
  ctx.on('llm/stream', async function* (options, next) {
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
    assert.ok(modelSawScript)
  })
}
