/** Replay compiler diagnostics and repair through the actual creation preset and Node PTC. */
import assert from 'node:assert/strict'
import { apply as mountPreset } from '../muse-editing-tool-catalog/editing-preset-fixture.mjs'
import { importSnapshotModule } from '../muse-fixture-import.mjs'
const Jubian = await importSnapshotModule(new URL('../../../packages/jubian/tool-jubian/src/index.ts', import.meta.url),
  new URL('../../../packages/jubian/tool-jubian/lib/index.js', import.meta.url))
export const name = 'snapshot-creation-preset'
export const inject = ['agentPresets', 'tools', 'systemPrompt', 'skills', 'llm', 'agents', 'credentials']
/** Mount the product preset and verify compiler diagnostics in later requests. */
export async function apply(ctx) {
  await ctx.plugin(Jubian, { baseUrl: 'https://snapshot-jubian.invalid', workspaceSecrets: false }).await()
  await mountPreset(ctx, { presetId: 'creation', hidePlatformShellTools: true })
  let requests = 0
  ctx.on('llm/stream', async function* (options, next) {
    assert.deepEqual(options.tools.map(tool => tool.name), ['run_code'])
    const results = options.messages.filter(message => message.role === 'tool')
    assert.equal(results.length, requests)
    if (requests >= 1) {
      assert.equal(results[0].isError, true)
      const text = results[0].content.filter(block => block.type === 'text').map(block => block.text).join('')
      assert.ok(text.includes('PTC program line 2:'))
      assert.ok(text.includes('await tools.screenplay_project({ request: { facts: []});'))
      assert.ok(!text.includes('node:internal'))
    }
    if (requests === 2) {
      assert.equal(results[1].isError, false)
      assert.ok(results[1].content.some(block => block.type === 'text' && block.text.includes('42')))
    }
    requests++
    yield* next()
  })
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'turn/end') assert.equal(requests, 3)
  })
}
