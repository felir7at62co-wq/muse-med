/** Offline real-tool version capture survives a changed source and repeated reads. */
import assert from 'node:assert/strict'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { importSnapshotModule, importSnapshotPackage } from '../../../../../snapshots/session/muse-fixture-import.mjs'

const owner = new URL('../../../package.json', import.meta.url)
const { LlmAdapter, ToolCallId } = await importSnapshotPackage('@deepseek-ai/dsh-llm', owner)
const revisions = await importSnapshotModule(new URL('../../../src/manuscript-revisions.ts', import.meta.url), new URL('../../../lib/manuscript-revisions.js', import.meta.url))
export const name = 'manuscript-versions-fixture'
export const inject = ['llm', 'tools']
const original = '第1集\n1-1 茶馆 日 内\n人物：林青\n林青：第三集不要动。\n'
const changed = '第1集\n1-1 茶馆 日 内\n人物：林青\n林青：我只改开场。\n'
const steps = [
  { id: 'snapshot-original', action: 'snapshot' },
  { id: 'history-original', action: 'history' },
  { id: 'snapshot-return', action: 'snapshot' },
  { id: 'history-both', action: 'history' },
  { id: 'snapshot-unchanged', action: 'snapshot' },
]
function* response(step) {
  if (!step) {
    const text = '两版原件均已保留；当前稿未被历史版本替换，尚未作剧情审校。'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
    return
  }
  const args = JSON.stringify({ action: step.action, source_paths: ['current.md'] })
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: ToolCallId(step.id), name: 'manuscript_revision', argumentsDelta: args }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(step.id), name: 'manuscript_revision', arguments: args } }
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}
class VersionAdapter extends LlmAdapter {
  constructor(state) { super(); this.state = state }
  async *stream() { yield* response(steps[this.state.results.length]) }
}
export async function apply(ctx) {
  await ctx.plugin(revisions)
  const state = { parent: undefined, results: [], versions: [] }
  ctx.effect(() => {
    const prior = globalThis.fetch
    globalThis.fetch = async () => { throw Error('Version fixture refuses network access') }
    return () => { globalThis.fetch = prior }
  })
  ctx.on('agent/created', async ({ agent }) => {
    assert.equal(state.parent, undefined); state.parent = agent
    await writeFile(join(agent.session.header.cwd, 'current.md'), original)
  })
  ctx.on('llm/stream', async function* (options, next) {
    if (options.purpose !== undefined || options.provider !== 'manuscript-versions-fixture') { yield* next(); return }
    const result = options.messages.findLast(value => value.role === 'tool')
    if (result && result.toolCallId !== state.results.at(-1)?.id) {
      const step = steps[state.results.length]
      assert.equal(result.toolCallId, step.id); assert.equal(result.isError, false)
      const value = JSON.parse(result.content.filter(c => c.type === 'text').map(c => c.text).join('\n'))
      assert.equal(value.state, step.action === 'snapshot' ? 'snapshotted' : 'history')
      assert.equal(value.versions.length, step.id === 'history-both' ? 2 : 1)
      if (step.id === 'snapshot-original') {
        assert.equal(await readFile(value.versions[0].snapshot_path, 'utf8'), original)
        await writeFile(join(state.parent.session.header.cwd, 'current.md'), changed)
      }
      if (step.id === 'history-both') state.versions = value.versions
      state.results.push({ id: step.id, action: step.action })
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (agent !== state.parent || state.results.length !== steps.length) return
    assert.equal(await readFile(state.versions[0].snapshot_path, 'utf8'), original)
    assert.equal(await readFile(state.versions[1].snapshot_path, 'utf8'), changed)
    assert.equal(await readFile(join(agent.session.header.cwd, 'current.md'), 'utf8'), changed)
    const files = await readdir(join(agent.session.header.cwd, '.muse/manuscript-revisions/versions'))
    assert.equal(files.filter(path => path.endsWith('.md')).length, 2)
    await writeFile(join(agent.session.header.cwd, '_versions-probe.json'), JSON.stringify({
      results: state.results, versions: state.versions.map(value => ({ file_sha256: value.file_sha256, original: basename(value.snapshot_path) })),
      originalRetained: true, returnedRetained: true, currentUnchanged: true, reusedBytes: true,
    }, null, 2) + '\n')
  })
  if (!process.env.DSH_SNAPSHOT || process.env.DSH_SNAPSHOT === 'record') ctx.effect(() => ctx.llm.registerAdapter(['manuscript-versions-fixture'], new VersionAdapter(state)))
}
