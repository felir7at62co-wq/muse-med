/** Offline real-tool Word note retention and isolated child review across a later human request. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { importSnapshotModule, importSnapshotPackage } from '../../../../../snapshots/session/muse-fixture-import.mjs'

const owner = new URL('../../../package.json', import.meta.url)
const { LlmAdapter, ToolCallId, createUserMessage } = await importSnapshotPackage('@deepseek-ai/dsh-llm', owner)
const { zipSync, strToU8 } = await importSnapshotPackage('fflate', owner)
const revisions = await importSnapshotModule(new URL('../../../src/manuscript-revisions.ts', import.meta.url), new URL('../../../lib/manuscript-revisions.js', import.meta.url))
export const name = 'manuscript-notes-fixture'
export const inject = ['llm', 'tools']
const original = zipSync({ 'word/document.xml': strToU8(await readFile(new URL('./current.xml', import.meta.url), 'utf8')),
  'word/comments.xml': strToU8(await readFile(new URL('./comments.xml', import.meta.url), 'utf8')) }, { mtime: new Date(2026, 10, 9, 8, 0, 0) })
const candidate = await readFile(new URL('./candidate.md', import.meta.url), 'utf8')
const initial = '只读检查 current.docx 与 candidate.md；保留批注和完整要求，第三集不要动。'
const later = '第一集对白要自然，保留必要动作，不要把局部删词变成全剧禁词。'
const comment = '删这里的“死死”，保留抓住门框这个动作；不要全剧禁词。'
const steps = [
  { id: 'notes-first', action: 'notes' }, { id: 'review-first', action: 'continuity' },
  { id: 'notes-later', action: 'notes' }, { id: 'review-later', action: 'continuity' },
]
function* call(name, args, id) {
  const text = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: ToolCallId(id), name, argumentsDelta: text }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: text } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}
class NoteAdapter extends LlmAdapter {
  constructor(state) { super(); this.state = state }
  async *stream(options) {
    if (options.sessionId !== this.state.parent.id) {
      yield* call('structured_output', { status: 'consistent', findings: [], unknowns: [] }, `notes-child-${this.state.children.size}`)
      return
    }
    const step = steps[this.state.results.length]
    if (step) {
      yield* call('manuscript_revision', step.action === 'notes' ? { action: 'notes', source_paths: ['current.docx'] }
        : { action: 'continuity', documents: [{ role: 'current', path: 'current.docx' }, { role: 'candidate', path: 'candidate.md' }],
          task: '核对所选原稿与候选，结合批注和完整真人要求；只读，不修改文件。' }, step.id)
    } else {
      const text = '批注和两轮完整要求已保留并传入只读审校；离线固定回复不代表剧本创作验收。'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}
export async function apply(ctx) {
  await ctx.plugin(revisions)
  const state = { parent: undefined, children: new Set(), results: [], injected: false, restored: false, reviews: [] }
  ctx.effect(() => {
    const prior = globalThis.fetch
    globalThis.fetch = async () => { throw Error('Notes fixture refuses network access') }
    return () => { globalThis.fetch = prior }
  })
  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.header.parentSession !== undefined) { state.children.add(agent.id); return }
    assert.equal(state.parent, undefined); state.parent = agent
    await writeFile(join(agent.session.header.cwd, 'current.docx'), original)
    await writeFile(join(agent.session.header.cwd, 'candidate.md'), candidate)
  })
  ctx.on('tools/result', (execution, result) => {
    if (execution.callId !== 'notes-first' || result.isError || state.injected) return
    state.injected = true
    execution.agent.inject(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: later }] }))
  })
  ctx.on('llm/stream', async function* (options, next) {
    if (options.provider !== 'manuscript-notes-fixture' || options.purpose !== undefined) { yield* next(); return }
    if (options.sessionId === state.parent.id) {
      const last = options.messages.findLast(message => message.role === 'tool')
      if (last && last.toolCallId !== state.results.at(-1)?.id) {
        const step = steps[state.results.length]
        assert.equal(last.toolCallId, step.id); assert.equal(last.isError, false)
        const value = JSON.parse(last.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
        if (step.action === 'notes') {
          assert.equal(value.assessment, 'not_performed')
          assert.equal(value.documents[0].comments[0].text, comment)
          assert.deepEqual(value.documents[0].user_requests.map(request => request.text), step.id === 'notes-first' ? [initial] : [initial, later])
        } else {
          assert.equal(value.status, 'consistent'); assert.equal(value.reason, 'reviewed')
          assert.equal(value.notes_sha256, state.reviews.at(-1))
        }
        state.results.push({ id: step.id, action: step.action })
      }
      if (options.messages.some(message => message.role === 'user' && message.source.kind === 'muse-manuscript'
        && message.source.summary === '已保留的文稿批注与完整修改要求' && JSON.stringify(message.content).includes(comment))) state.restored = true
    } else {
      assert.deepEqual(options.tools.map(tool => tool.name), ['structured_output'])
      const input = options.messages.flatMap(message => message.role === 'user' ? message.content : [])
        .flatMap(block => block.type === 'text' && block.text.startsWith('{"task"') ? [JSON.parse(block.text)] : [])[0]
      assert.ok(input)
      assert.equal(input.user_request.text, later)
      assert.equal(input.revision_notes.documents[0].comments[0].text, comment)
      assert.equal(input.revision_notes.documents[0].comments[0].anchor.quote, '▲林青死死抓住门框。')
      assert.equal(input.revision_notes.documents[0].user_requests[0].text, initial)
      state.reviews.push(input.revision_notes.notes_sha256)
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (agent !== state.parent) return
    assert.equal(state.results.length, 4); assert.equal(state.children.size, 2); assert.equal(state.restored, true)
    assert.notEqual(state.reviews[0], state.reviews[1])
    const cwd = agent.session.header.cwd, index = JSON.parse(await readFile(join(cwd, '.muse/manuscript-revisions/notes.json'), 'utf8'))
    const row = index.documents[0]
    const archived = await readFile(join(cwd, '.muse/manuscript-revisions/versions', row.file_sha256 + '.docx'))
    assert.deepEqual(archived, Buffer.from(original)); assert.deepEqual(await readFile(join(cwd, 'current.docx')), Buffer.from(original))
    assert.equal(await readFile(join(cwd, 'candidate.md'), 'utf8'), candidate)
    await writeFile(join(cwd, '_notes-probe.json'), JSON.stringify({ actions: state.results.map(value => value.action),
      original_sha256: createHash('sha256').update(original).digest('hex'), comment: row.comments[0],
      requests: row.user_requests.map(value => value.text), originalsPreserved: true, contextRestored: state.restored,
      independentReviewReceivedNotes: true, reviewBoundToNotes: true, laterRequirementChangesDigest: true,
    }, null, 2) + '\n')
  })
  if (!process.env.DSH_SNAPSHOT || process.env.DSH_SNAPSHOT === 'record') ctx.effect(() => ctx.llm.registerAdapter(['manuscript-notes-fixture'], new NoteAdapter(state)))
}
