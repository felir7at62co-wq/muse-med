/** Replay exact source identities and repair through the actual creation preset and Node PTC. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { apply as mountPreset } from '../muse-editing-tool-catalog/editing-preset-fixture.mjs'
import { importSnapshotModule } from '../muse-fixture-import.mjs'
const Jubian = await importSnapshotModule(new URL('../../../packages/jubian/tool-jubian/src/index.ts', import.meta.url),
  new URL('../../../packages/jubian/tool-jubian/lib/index.js', import.meta.url))
const { PROJECT_FILE } = await importSnapshotModule(new URL('../../../packages/drama/screenplay-project/src/schema.ts', import.meta.url),
  new URL('../../../packages/drama/screenplay-project/lib/schema.js', import.meta.url))
export const name = 'snapshot-creation-preset'
export const inject = ['agentPresets', 'tools', 'systemPrompt', 'skills', 'llm', 'agents', 'credentials']
/** Mount the product preset and verify source diagnostics in later requests. */
export async function apply(ctx) {
  await ctx.plugin(Jubian, { baseUrl: 'https://snapshot-jubian.invalid', workspaceSecrets: false }).await()
  await mountPreset(ctx, { presetId: 'creation', hidePlatformShellTools: true })
  let requests = 0
  const originals = new Map()
  // Seed readonly source data; no model call creates a UUID or changes a durable project.
  ctx.on('agent/created', async ({ agent }) => {
    const sourceText = '原文：甲推开门。'
    const hash = createHash('sha256').update(sourceText).digest('hex')
    const id = `s:${hash}:text`
    const project = PROJECT_FILE.parse({ format_version: 1, id: 'p:source-id-fixture', revision: 1,
      mode: 'faithful', instructions: '来源编号读取验收，不生成剧本。',
      created_at: '2026-10-11T00:00:00.000Z', updated_at: '2026-10-11T00:00:00.000Z',
      sources: [{ id, path: 'id-source.txt', sha256: hash, kind: 'text',
        units: [{ id: `${id}:u1`, ordinal: 1, text: sourceText }] }],
      facts: [], candidates: [], accepted: [] })
    for (const [name, bytes] of [['id-source.txt', sourceText], ['source-id-project.json', JSON.stringify(project)]]) {
      const path = join(agent.session.header.cwd, name)
      originals.set(path, bytes)
      await writeFile(path, bytes, { flag: 'wx' })
    }
  })
  ctx.on('agent/turn-stopping', async () => {
    assert.equal(requests, 3)
    // The fixture removes only its own readonly inputs after proving byte-for-byte preservation.
    for (const [path, bytes] of originals) {
      assert.equal(await readFile(path, 'utf8'), bytes)
      await rm(path)
    }
  })
  ctx.on('llm/stream', async function* (options, next) {
    assert.deepEqual(options.tools.map(tool => tool.name), ['run_code'])
    const results = options.messages.filter(message => message.role === 'tool')
    assert.equal(results.length, requests)
    if (requests >= 1) {
      assert.equal(results[0].isError, true)
      const text = results[0].content.filter(block => block.type === 'text').map(block => block.text).join('')
      assert.ok(text.includes('编号须保留类型后缀'))
      assert.match(text, /s:[a-f0-9]{64}:text/u)
      assert.ok(text.includes('未读取来源'))
    }
    if (requests === 2) {
      assert.equal(results[1].isError, false)
      assert.ok(results[1].content.some(block => block.type === 'text' && block.text.includes('原文：甲推开门。')))
    }
    requests++
    yield* next()
  })
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'turn/end') assert.equal(requests, 3)
  })
}
