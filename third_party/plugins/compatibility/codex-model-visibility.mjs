/** Keep subscription-only models out of the picker until a Codex account is connected. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Patch private build staging without modifying the retained upstream snapshot.
 * @param directory - Staged community package root.
 */
export function applyCodexModelVisibility(directory) {
  const patches = {
    'src/index.js': [[
      'const adapter = new PiAiAdapter({',
      `const adapter = new class extends PiAiAdapter {
    async listModels(provider) {
      const credential = await store.read(provider)
      return credential?.type === 'oauth' ? super.listModels(provider) : []
    }
  }({`,
    ]],
    'tests/plugin-integration.test.mjs': [[
      `test('every advertised Codex model resolves and prepares without reading credentials', async () => {
  const host = fakeContext()
  applyPlugin(host.ctx)
  // Activation may inspect account state; model metadata must not require it.
  host.ctx.credentials.resolve = async () => assert.fail('model metadata must not read credentials')
  const adapter = host.registered[0].adapter
  const models = await adapter.listModels('openai-codex')
  assert.ok(models.length > 0)`,
      `test('Codex models appear only while a subscription account is connected', async () => {
  const host = fakeContext()
  applyPlugin(host.ctx)
  const adapter = host.registered[0].adapter
  assert.deepEqual(await adapter.listModels('openai-codex'), [])
  await host.ctx.credentials.set(undefined, JSON.stringify({ type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: Date.now() + 3600000 }))
  const models = await adapter.listModels('openai-codex')
  assert.ok(models.length > 0)
  await host.ctx.credentials.unset()
  assert.deepEqual(await adapter.listModels('openai-codex'), [])`,
    ], [
      "assert.ok(models.length > 0, 'the supported DSH adapter must receive auth before creating its model registry')",
      "assert.deepEqual(models, [], 'an unconnected subscription must not advertise selectable models')",
    ]],
  }
  for (const [file, replacements] of Object.entries(patches)) {
    const path = join(directory, file)
    let source = readFileSync(path, 'utf8')
    for (const [before, after] of replacements) {
      if (source.split(before).length !== 2) throw new Error(`Codex model visibility needs source review: ${file}`)
      source = source.replace(before, after)
    }
    writeFileSync(path, source)
  }
}
