/** Exercise located scene failures and lossless-return recovery through the actual creation preset and Node PTC. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { apply as mountPreset } from '../muse-editing-tool-catalog/editing-preset-fixture.mjs'
import { importSnapshotModule } from '../muse-fixture-import.mjs'
const Jubian = await importSnapshotModule(new URL('../../../packages/jubian/tool-jubian/src/index.ts', import.meta.url),
  new URL('../../../packages/jubian/tool-jubian/lib/index.js', import.meta.url))
export const name = 'snapshot-creation-preset'
export const inject = ['agentPresets', 'tools', 'systemPrompt', 'skills', 'llm', 'agents', 'credentials']
/** Mount a synthetic readonly project and assert located failures without partial publication. @param ctx - Headless services. */
export async function apply(ctx) {
  await ctx.plugin(Jubian, { baseUrl: 'https://snapshot-jubian.invalid', workspaceSecrets: false }).await()
  await mountPreset(ctx, { presetId: 'creation', hidePlatformShellTools: true })
  let requests = 0
  const originals = new Map()
  ctx.on('agent/created', async ({ agent }) => {
    const sourceText = '乙在画外说：门开了。'
    const hash = createHash('sha256').update(sourceText).digest('hex')
    const id = `s:${hash}:text`, unit = `${id}:u1`
    const time = '2026-10-11T00:00:00.000Z'
    const project = { format_version: 1, id: 'p:stage-diagnostics', revision: 2,
      mode: 'faithful', instructions: '合成的工具错误定位验收，不是视频内容或质量证据。', created_at: time, updated_at: time,
      sources: [{ id, path: 'diagnostic-source.txt', sha256: hash, kind: 'text',
        units: [{ id: unit, ordinal: 1, text: sourceText }] }],
      facts: [{ id: 'f:voice-fixture', kind: 'speech', origin: 'source', layer: 'present', actor: '乙',
        summary: '乙在画外说门开了。', anchors: [{ unit_id: unit, quote: sourceText }], proposer: 'fixture-writer', created_at: time,
        review: { actor: 'fixture-reviewer', time, decision: 'approve', reason: '合成声音来源字段一致。' } }],
      candidates: [], accepted: [] }
    const scene = { location: '门前', time: '日', setting: '内', layer: 'present', transition: 'opening',
      characters: ['甲'], voice_only_characters: ['乙'],
      beats: [{ kind: 'vo', actor: '乙', text: '门开了。', fact_ids: ['f:voice-fixture'],
        requires_knowledge: [], witnesses: ['甲'], audible_in_scene: true }] }
    for (const [name, bytes] of [['diagnostic-source.txt', sourceText], ['stage-diagnostic-project.json', JSON.stringify(project)],
      ['diagnostic-scene.json', JSON.stringify(scene)],
      ['invalid-scene.json', JSON.stringify({ ...scene, beats: [{ kind: 'vo', actor: '乙', text: '门开了。', fact_ids: ['f:voice-fixture'] }] })]]) {
      const path = join(agent.session.header.cwd, name)
      originals.set(path, bytes)
      await writeFile(path, bytes, { flag: 'wx' })
    }
  })
  ctx.on('agent/turn-stopping', async () => {
    assert.equal(requests, 5)
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
      assert.equal(results[0].isError, false)
      const text = results[0].content.filter(block => block.type === 'text').map(block => block.text).join('')
      assert.ok(text.includes('scene_file_missing'))
      assert.ok(text.includes('missing-scene.json'))
      const value = JSON.parse(text)
      assert.equal(value.batch_failure, 'fact_batch: 本次批量审校 21 条，允许 1–20 条。')
      assert.ok(value.schema_failure.includes('scene_file_invalid:'))
      assert.ok(value.schema_failure.includes('invalid-scene.json'))
      assert.ok(value.schema_failure.includes('beats.0.requires_knowledge'))
      assert.ok(value.schema_failure.includes('beats.0.witnesses'))
    }
    if (requests >= 2) {
      assert.equal(results[1].isError, false)
      const text = results[1].content.filter(block => block.type === 'text').map(block => block.text).join('')
      assert.ok(text.includes('voice_characters: 第1场 乙'))
      assert.ok(text.includes('须同时列入 characters'))
    }
    if (requests >= 3) {
      assert.equal(results[2].isError, true)
      const text = results[2].content.filter(block => block.type === 'text').map(block => block.text).join('')
      assert.ok(text.includes('invalid-output'))
      assert.ok(text.includes('lossless JSON'))
    }
    if (requests >= 4) {
      assert.equal(results[3].isError, false)
      const value = JSON.parse(results[3].content.filter(block => block.type === 'text').map(block => block.text).join(''))
      assert.equal(value.revision, 2)
      assert.equal(value.pending.length, 0)
    }
    requests++
    yield* next()
  })
}
