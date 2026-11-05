/** Synthetic manuscript roles checked through real model requests and the registered revision tool. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { importSnapshotModule, importSnapshotPackage } from '../../../../../snapshots/session/muse-fixture-import.mjs'

const owner = new URL('../../../package.json', import.meta.url)
const { LlmAdapter, ToolCallId } = await importSnapshotPackage('@deepseek-ai/dsh-llm', owner)
const revisions = await importSnapshotModule(new URL('../../../src/manuscript-revisions.ts', import.meta.url),
  new URL('../../../lib/manuscript-revisions.js', import.meta.url))

/** Loader name for the shared offline manuscript scenario. */
export const name = 'manuscript-materials-fixture'
/** Real model, filesystem and tool services required by the scenario. */
export const inject = ['llm', 'tools', 'fs']

const PROVIDER = 'manuscript-materials-fixture'
const hash = value => createHash('sha256').update(value).digest('hex')

/** Four accepted episodes distinguish arrival, a request, consent and the resulting action. */
export const currentText = [
  '第1集', '1-1 院门 日 外', '人物：林青、陈岚', '▲陈岚把行李放在院门外，林青打开院门。',
  '林青：客房准备好了。', '【下集钩子】', '▲陈岚望向院内的主卧。',
  '第2集', '2-1 客房 日 内', '人物：林青、陈岚', '▲林青把客房钥匙交给陈岚，主卧门保持关闭。',
  '林青：住客房，主卧里的旧床不动。', '【下集钩子】', '▲陈岚把钥匙放在客房桌上。',
  '第3集', '3-1 主卧门口 日 内', '人物：林青、陈岚、工人', '▲工人推来新床垫。林青站到主卧门前。',
  '陈岚：我想换床，能搬进去吗？', '【下集钩子】', '▲工人停在门外，等林青回答。',
  '第4集', '4-1 客房 日 内', '人物：林青、陈岚、工人', '▲林青指向客房，工人把新床垫送进客房。',
  '林青：可以换客房的床，主卧保留原样。', '【下集钩子】', '▲主卧门关闭，旧床仍在原位。',
].join('\n') + '\n'

/** The reference deliberately conflicts with the accepted manuscript's bed state. */
export const referenceText = currentText.replace('▲陈岚把行李放在院门外，林青打开院门。', '▲旧床已经拆成两块，客人还没有到院门。')
  .replace('主卧里的旧床不动。', '主卧里的旧床已经拆掉。')

/** The candidate contains the broken consent-before-request transition being inspected. */
export const candidateText = currentText.replace('▲工人推来新床垫。林青站到主卧门前。', '▲客人刚到院门，工人尚未出现。')
  .replace('陈岚：我想换床，能搬进去吗？', '林青：好，搬！')

const documents = { 'current.md': currentText, 'reference.md': referenceText, 'candidate.md': candidateText }
const calls = [
  { label: 'full', input: { documents: [
    { role: 'reference', path: 'reference.md' }, { role: 'current', path: 'current.md' }, { role: 'candidate', path: 'candidate.md' },
  ] } },
  { label: 'episodes', input: { documents: [
    { role: 'current', path: 'current.md', episodes: [2] }, { role: 'reference', path: 'reference.md', episodes: [2] },
    { role: 'candidate', path: 'candidate.md', episodes: [4] },
  ] } },
  { label: 'lines', input: { documents: [{ role: 'current', path: 'current.md', lines: { start: 9, end: 11 } }] } },
  { label: 'conflicting-selectors', error: true, input: { documents: [
    { role: 'current', path: 'current.md', episodes: [2], lines: { start: 9, end: 11 } },
  ] } },
  { label: 'missing-current', error: true, input: { documents: [{ role: 'reference', path: 'reference.md' }] } },
  { label: 'oversized', error: true, input: { documents: [{ role: 'current', path: 'oversized-current.md' }] } },
]

function expectedLines(text, start, end) {
  return text.split('\n').slice(start - 1, end).map((text, index) => ({ number: start + index, text }))
}

function verifyDocument(document, role, filename) {
  const text = documents[filename]
  assert.equal(document.role, role)
  assert.equal(basename(document.path), filename)
  assert.equal(document.file_sha256, hash(text))
  assert.equal(document.text_sha256, hash(text))
  assert.equal(document.line_count, text.split('\n').length)
  assert.equal(document.unchanged_since_read, true)
  assert.equal(document.coverage.basis, 'returned_text_lines')
  assert.equal(document.episode_index.state, 'indexed')
  assert.deepEqual(document.episode_index.episodes, [
    { episode: 1, start: 1, end: 7 }, { episode: 2, start: 8, end: 14 },
    { episode: 3, start: 15, end: 21 }, { episode: 4, start: 22, end: 29 },
  ])
  return text
}

function verifyResult(message, index) {
  const planned = calls[index]
  assert.ok(planned, 'Every model-visible result belongs to a planned real tool call')
  assert.equal(message.toolCallId, `materials-${index + 1}`)
  assert.equal(message.isError, planned.error === true, planned.label)
  const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  if (planned.error) {
    assert.ok(text.length > 0)
    if (planned.label === 'oversized') assert.match(text, /MANUSCRIPT_MATERIALS_BUDGET/)
    return { case: planned.label, isError: true }
  }
  const value = JSON.parse(text)
  assert.equal(value.state, 'materials')
  assert.equal(value.advisory, true)
  assert.equal(value.semantic_assessment, 'not_performed')
  assert.equal(value.position_basis, 'extracted_text_lines')
  assert.equal(value.documents.length, planned.input.documents.length)
  if (planned.label === 'full') {
    for (const [role, filename] of [['current', 'current.md'], ['reference', 'reference.md'], ['candidate', 'candidate.md']]) {
      const document = value.documents.find(item => item.role === role)
      const original = verifyDocument(document, role, filename)
      assert.deepEqual(document.lines, expectedLines(original, 1, 29))
      assert.deepEqual(document.selection, { kind: 'full' })
      assert.deepEqual(document.coverage, { basis: 'returned_text_lines', read_ranges: [{ start: 1, end: 29 }], unread_ranges: [], full_document: true })
    }
  } else if (planned.label === 'episodes') {
    for (const [role, filename, requested, included, adjacent, start, end, unread] of [
      ['current', 'current.md', [2], [1, 2, 3], [1, 3], 1, 21, [{ start: 22, end: 29 }]],
      ['reference', 'reference.md', [2], [2], [], 8, 14, [{ start: 1, end: 7 }, { start: 15, end: 29 }]],
      ['candidate', 'candidate.md', [4], [3, 4], [3], 15, 29, [{ start: 1, end: 14 }]],
    ]) {
      const document = value.documents.find(item => item.role === role)
      const original = verifyDocument(document, role, filename)
      assert.deepEqual(document.lines, expectedLines(original, start, end))
      assert.deepEqual(document.selection, { kind: 'episodes', requested, included, adjacent })
      assert.deepEqual(document.coverage, { basis: 'returned_text_lines', read_ranges: [{ start, end }], unread_ranges: unread, full_document: false })
    }
  } else {
    const document = value.documents[0]
    verifyDocument(document, 'current', 'current.md')
    assert.deepEqual(document.lines, expectedLines(currentText, 9, 11))
    assert.deepEqual(document.selection, { kind: 'lines', start: 9, end: 11 })
    assert.deepEqual(document.coverage, { basis: 'returned_text_lines', read_ranges: [{ start: 9, end: 11 }], unread_ranges: [{ start: 1, end: 8 }, { start: 12, end: 29 }], full_document: false })
  }
  return { case: planned.label, isError: false, documents: value.documents.map(document => ({
    role: document.role, file: basename(document.path), file_sha256: document.file_sha256, text_sha256: document.text_sha256,
    line_count: document.line_count, selection: document.selection, coverage: document.coverage,
  })) }
}

class MaterialsAdapter extends LlmAdapter {
  constructor(state) { super(); this.state = state }

  async *stream() {
    const index = this.state.results.length
    const planned = calls[index]
    if (planned) {
      const id = ToolCallId(`materials-${index + 1}`)
      const args = JSON.stringify({ action: 'materials', ...planned.input })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'manuscript_revision', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'manuscript_revision', arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      const text = '已读取当前认可稿、参考稿与候选稿；选集与未读范围已列出，尚未进行语义审校。'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

/**
 * Register the real manuscript tool, seed three distinct manuscripts and inspect exact model requests.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Isolated Loader-owned context.
 */
export async function apply(ctx) {
  await ctx.plugin(revisions, { maxMaterialChars: 10000 })
  ctx.effect(() => {
    const original = globalThis.fetch
    globalThis.fetch = async () => { throw Error('Manuscript materials fixture refuses network access') }
    return () => { globalThis.fetch = original }
  })
  const state = { results: [], modelRequests: 0 }
  ctx.on('agent/created', async ({ agent }) => {
    const cwd = agent.session.header.cwd
    assert.ok(cwd)
    for (const [filename, text] of Object.entries(documents)) await writeFile(join(cwd, filename), text)
    await writeFile(join(cwd, 'oversized-current.md'), '超'.repeat(10001) + '\n')
  })
  ctx.on('llm/stream', (options, next) => {
    if (options.provider !== PROVIDER || options.purpose !== undefined) return next()
    state.modelRequests += 1
    assert.ok(ctx.tools.get('manuscript_revision'), 'Loader must register the production manuscript tool')
    const result = options.messages.findLast(message => message.role === 'tool')
    if (result) state.results.push(verifyResult(result, state.results.length))
    return next()
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    assert.equal(state.modelRequests, calls.length + 1)
    assert.equal(state.results.length, calls.length)
    const cwd = agent.session.header.cwd
    for (const [filename, text] of Object.entries(documents)) assert.equal(await readFile(join(cwd, filename), 'utf8'), text)
    const events = agent.session.snapshotEvents()
    const callsLogged = events.filter(event => event.type === 'tool/call' && event.data.name === 'manuscript_revision')
    const resultsLogged = events.filter(event => event.type === 'tool/result')
    assert.equal(callsLogged.length, calls.length)
    assert.equal(resultsLogged.length, calls.length)
    assert.deepEqual(resultsLogged.map(event => event.data.message.isError), [false, false, false, true, true, true])
    await writeFile(join(cwd, '_materials-probe.json'), JSON.stringify({ modelRequests: state.modelRequests, results: state.results }, null, 2) + '\n')
  })
  if (!process.env.DSH_SNAPSHOT || process.env.DSH_SNAPSHOT === 'record') {
    ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], new MaterialsAdapter(state)))
  }
}
