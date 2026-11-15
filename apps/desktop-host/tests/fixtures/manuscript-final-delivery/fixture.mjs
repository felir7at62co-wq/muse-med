/** Real screenplay delivery gates with deterministic model replies; no semantic-quality claim. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { importSnapshotModule, importSnapshotPackage } from '../../../../../snapshots/session/muse-fixture-import.mjs'
import { manuscriptDocx } from './docx.mjs'

const owner = new URL('../../../package.json', import.meta.url)
const { LlmAdapter, ToolCallId } = await importSnapshotPackage('@deepseek-ai/dsh-llm', owner)
const revisions = await importSnapshotModule(new URL('../../../src/manuscript-revisions.ts', import.meta.url),
  new URL('../../../lib/manuscript-revisions.js', import.meta.url))
const editingPolicy = await importSnapshotModule(new URL('../../../src/editing-policy.ts', import.meta.url),
  new URL('../../../lib/editing-policy.js', import.meta.url))
const toolPresent = await importSnapshotModule(new URL('../../../../../packages/deliverables/tool-present/src/index.ts', import.meta.url),
  new URL('../../../../../packages/deliverables/tool-present/lib/index.js', import.meta.url))

/** Real Loader-owned file creation, review children and delivery tools. */
export const name = 'manuscript-final-delivery-fixture'
/** Only model response generation is replaced. */
export const inject = ['llm', 'tools', 'fs', 'subagents']

const PROVIDER = 'manuscript-final-delivery-fixture'
const MODEL = 'selected-creative-model'
const PARENT_TASK = '按认可稿写四集短剧并交付 Markdown 和 Word。新稿须核对剧情衔接；有待修问题时明确交付草稿。'
const TASK = '核对最终文件的事件先后和集间衔接；只按实际给出的范围报告，不修改稿件。'
const accepted = await readFile(new URL('../manuscript-continuity/accepted.md', import.meta.url), 'utf8')
const faulty = await readFile(new URL('../manuscript-continuity/case-a.md', import.meta.url), 'utf8')
const word = manuscriptDocx(accepted)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

function* call(name, args, id) {
  const text = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: ToolCallId(id), name, argumentsDelta: text }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: text } }
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

function* stop(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

function toolText(message) {
  return message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

function reviewInput(options) {
  for (const message of options.messages) {
    if (message.role !== 'user') continue
    for (const block of message.content) {
      if (block.type !== 'text') continue
      try {
        const value = JSON.parse(block.text)
        if (value.materials && value.target) return value
      } catch (error) { assert.ok(error instanceof SyntaxError) }
    }
  }
  throw Error('The real spawned reviewer must receive explicit numbered material')
}

function anchor(document, number) {
  const line = document.lines.find(line => line.number === number)
  assert.ok(line)
  return { role: document.role, path: document.path, file_sha256: document.file_sha256,
    text_sha256: document.text_sha256, line: number, quote: line.text }
}

function report(child) {
  if (child.index !== 1) return { status: 'consistent', findings: [], unknowns: [] }
  const document = child.input.materials.documents.find(document => document.role === 'candidate')
  return { status: 'issues', findings: [{ category: 'object_state',
    description: '离线固定回复仅验证交付管道：候选稿两处物件状态需要修改，不作为模型语义能力证据。',
    evidence: [anchor(document, 19), anchor(document, 25)] }], unknowns: [] }
}

function replayChunk(chunk, input) {
  const materialize = text => {
    const value = JSON.parse(text)
    for (const finding of value.findings) for (const evidence of finding.evidence) {
      const document = input.materials.documents.find(document => document.role === evidence.role
        && document.file_sha256 === evidence.file_sha256 && document.text_sha256 === evidence.text_sha256)
      assert.ok(document)
      assert.equal(evidence.path, `{{cwd}}/${basename(document.path)}`)
      evidence.path = document.path
    }
    return JSON.stringify(value)
  }
  if (chunk.type === 'tool-call-delta' && chunk.name === 'structured_output') return { ...chunk, argumentsDelta: materialize(chunk.argumentsDelta) }
  if (chunk.type === 'block-end' && chunk.block.type === 'tool-call' && chunk.block.name === 'structured_output') {
    return { ...chunk, block: { ...chunk.block, arguments: materialize(chunk.block.arguments) } }
  }
  return chunk
}

function continuity(path, episodes) {
  return { action: 'continuity', task: TASK, documents: [
    { role: 'current', path: 'current.md' }, { role: 'candidate', path, ...episodes === undefined ? {} : { episodes } },
  ] }
}

function declare(path, mode, note) {
  return { action: 'delivery', delivery_mode: mode, candidate_paths: [path], ...note === undefined ? {} : { note } }
}

function deliveredLabel(state, id) {
  const value = state.values.get(id)
  assert.equal(value?.state, 'delivery')
  assert.equal(value.files.length, 1)
  assert.ok(value.files[0].label)
  return value.files[0].label
}

function steps(state) {
  return [
    { id: 'word-without-history', name: 'present', args: { files: [{ path: 'final.docx' }] }, error: 'MANUSCRIPT_DELIVERY_REQUIRED' },
    { id: 'write-final', name: 'write', args: { file_path: 'final.md', content: accepted } },
    { id: 'without-review', name: 'present', args: { files: [{ path: 'final.md' }] }, error: 'MANUSCRIPT_DELIVERY_REQUIRED' },
    { id: 'review-full', name: 'manuscript_revision', args: continuity('final.md'), status: 'consistent' },
    { id: 'declare-full', name: 'manuscript_revision', args: declare('final.md', 'reviewed'), mode: 'reviewed', file: 'final.md' },
    { id: 'present-full', name: 'present', args: () => ({ files: [{ path: 'final.md', description: deliveredLabel(state, 'declare-full') }] }) },
    { id: 'rewrite-final', name: 'write', args: { file_path: 'final.md', content: faulty } },
    { id: 'present-stale', name: 'present', args: () => ({ files: [{ path: 'final.md', description: deliveredLabel(state, 'declare-full') }] }), error: 'MANUSCRIPT_DELIVERY_STALE' },
    { id: 'declare-stale', name: 'manuscript_revision', args: declare('final.md', 'reviewed'), error: 'MANUSCRIPT_DELIVERY_REVIEW_REQUIRED' },
    { id: 'review-issues', name: 'manuscript_revision', args: continuity('final.md'), status: 'issues' },
    { id: 'issues-are-not-reviewed', name: 'manuscript_revision', args: declare('final.md', 'reviewed'), error: 'MANUSCRIPT_DELIVERY_REVIEW_REQUIRED' },
    { id: 'declare-draft', name: 'manuscript_revision', args: declare('final.md', 'draft', '草稿：已识别的物件状态问题尚未修改，请先审阅。'), mode: 'draft', file: 'final.md' },
    { id: 'draft-needs-label', name: 'present', args: { files: [{ path: 'final.md', description: '最终完成稿' }] }, error: 'MANUSCRIPT_DELIVERY_LABEL_REQUIRED' },
    { id: 'present-draft', name: 'present', args: () => ({ files: [{ path: 'final.md', description: deliveredLabel(state, 'declare-draft') }] }) },
    { id: 'review-partial', name: 'manuscript_revision', args: continuity('partial.md', [2]), status: 'consistent' },
    { id: 'declare-partial', name: 'manuscript_revision', args: declare('partial.md', 'reviewed'), mode: 'reviewed', file: 'partial.md' },
    { id: 'partial-is-not-whole-play', name: 'present', args: () => ({ files: [{ path: 'partial.md', description: `${deliveredLabel(state, 'declare-partial')}；全剧已经全部通过。` }] }), error: 'MANUSCRIPT_DELIVERY_LABEL_REQUIRED' },
    { id: 'present-partial', name: 'present', args: () => ({ files: [{ path: 'partial.md', description: deliveredLabel(state, 'declare-partial') }] }) },
    { id: 'review-word', name: 'manuscript_revision', args: continuity('final.docx'), status: 'consistent' },
    { id: 'declare-word', name: 'manuscript_revision', args: declare('final.docx', 'reviewed'), mode: 'reviewed', file: 'final.docx' },
    { id: 'present-word', name: 'present', args: () => ({ files: [{ path: 'final.docx', description: deliveredLabel(state, 'declare-word') }] }) },
    { id: 'write-unpresented', name: 'write', args: { file_path: 'unpresented.md', content: accepted } },
  ]
}

function followupSteps(state) {
  return [
    { id: 'declare-after-notice', name: 'manuscript_revision', args: declare('unpresented.md', 'draft', '草稿：本文件尚未做最终剧情复核。'), mode: 'draft', file: 'unpresented.md' },
    { id: 'present-after-notice', name: 'present', args: () => ({ files: [{ path: 'unpresented.md', description: deliveredLabel(state, 'declare-after-notice') }] }) },
  ]
}

function inspectResult(state, message, step) {
  assert.equal(message.toolCallId, step.id)
  const text = toolText(message)
  assert.equal(message.isError, step.error !== undefined, `${step.id}: ${text}`)
  if (step.error !== undefined) assert.ok(text.includes(step.error), `${step.id}: ${text}`)
  let value
  if (!message.isError && step.name === 'manuscript_revision') {
    value = JSON.parse(text)
    state.values.set(step.id, value)
  }
  if (step.status !== undefined) {
    assert.equal(value.state, 'continuity')
    assert.equal(value.status, step.status)
    assert.equal(value.file_verification, 'verified')
    assert.deepEqual(value.reviewer.selection, { provider: PROVIDER, model: MODEL })
    assert.equal(value.reviewer.requests, 1)
  }
  if (step.mode !== undefined) {
    assert.equal(value.state, 'delivery')
    assert.equal(value.mode, step.mode)
    assert.equal(basename(value.files[0].path), step.file)
    const bytes = step.file === 'final.docx' ? word : step.file === 'final.md' && step.id === 'declare-draft' ? faulty : accepted
    assert.equal(value.files[0].file_sha256, hash(bytes))
    if (step.mode === 'draft') {
      assert.equal(value.files[0].label, '草稿：当前版本未完成语义复核')
      assert.equal(value.files[0].review_scope, null)
    } else if (step.id === 'declare-partial') {
      assert.equal(value.files[0].label, '已复核第1–3集（仅此范围）')
      assert.deepEqual(value.files[0].review_scope, {
        selection: { kind: 'episodes', requested: [2], included: [1, 2, 3], adjacent: [1, 3] },
        coverage: { basis: 'returned_text_lines', read_ranges: [{ start: 1, end: 21 }],
          unread_ranges: [{ start: 22, end: 29 }], full_document: false },
      })
    } else {
      assert.equal(value.files[0].label, '已复核本文件全部提取正文（仅当前版本）')
      assert.deepEqual(value.files[0].review_scope, { selection: { kind: 'full' },
        coverage: { basis: 'returned_text_lines', read_ranges: [{ start: 1, end: 29 }], unread_ranges: [], full_document: true } })
    }
  }
  state.results.push({ id: step.id, name: step.name, error: step.error ?? null,
    ...step.status === undefined ? {} : { status: value.status }, ...step.mode === undefined ? {} : { mode: value.mode } })
}

class DeliveryAdapter extends LlmAdapter {
  constructor(state) { super(); this.state = state }
  async *stream(options) {
    const state = this.state
    if (options.sessionId !== state.parent.id) {
      yield* call('structured_output', report(state.children.get(options.sessionId)), `delivery-review-${state.children.get(options.sessionId).index + 1}`)
      return
    }
    const stage = state.results.length
    const initial = steps(state)
    const trailing = followupSteps(state)
    const step = stage < initial.length ? initial[stage] : state.steerSeen ? trailing[stage - initial.length] : undefined
    if (step !== undefined) yield* call(step.name, typeof step.args === 'function' ? step.args() : step.args, step.id)
    else yield* stop(state.steerSeen ? '文件已按实际核验范围或草稿状态完成交付。离线固定回复只验证管道。' : '稿件已写出。')
  }
}

/** @param {import('@deepseek-ai/cordis').Context} ctx - Shipped headless composition. */
export async function apply(ctx) {
  await ctx.plugin(editingPolicy)
  await ctx.plugin(toolPresent, { maxFiles: 8 })
  await ctx.plugin(revisions, { continuityMaxOutputTokens: 4096 })
  const state = { parent: undefined, children: new Map(), values: new Map(), results: [], requests: 0,
    initialStop: false, steerSeen: false, notices: new Set(), presented: [] }
  ctx.effect(() => {
    const original = globalThis.fetch
    globalThis.fetch = async () => { throw Error('Manuscript final-delivery fixture refuses network access') }
    return () => { globalThis.fetch = original }
  })
  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.header.parentSession !== undefined) {
      assert.equal(agent.session.header.parentSession, state.parent.id)
      state.children.set(agent.id, { agent, index: state.children.size, requests: 0, input: undefined })
      return
    }
    assert.equal(state.parent, undefined)
    state.parent = agent
    const cwd = agent.session.header.cwd
    await writeFile(join(cwd, 'current.md'), accepted)
    await writeFile(join(cwd, 'partial.md'), accepted)
    await writeFile(join(cwd, 'final.docx'), word)
  })
  ctx.on('session/event', (session, event) => {
    if (session !== state.parent?.session) return
    if (event.type === 'deliverables/presented') state.presented.push(event.data)
    if (event.type === 'assistant/message' && state.results.length === steps(state).length
      && event.data.stream.some(record => record.type === 'chunk' && record.chunk.type === 'finish' && record.chunk.reason.kind === 'stop')) state.initialStop = true
    if (event.type === 'user/message' && event.data.source.kind === 'muse-manuscript'
      && event.data.source.summary === '剧本文件尚无有效交付回执') state.notices.add(event.data.id)
  })
  ctx.on('llm/stream', async function* (options, next) {
    if (options.provider !== PROVIDER || options.purpose !== undefined) { yield* next(); return }
    assert.equal(options.model, MODEL)
    let child
    if (options.sessionId === state.parent.id) {
      state.requests++
      const last = options.messages.findLast(message => message.role === 'tool')
      const all = [...steps(state), ...followupSteps(state)]
      if (last && state.results.length < all.length && last.toolCallId !== state.results.at(-1)?.id) {
        inspectResult(state, last, all[state.results.length])
      }
      if (state.initialStop && !state.steerSeen) {
        const notice = options.messages.filter(message => message.role === 'user' && message.source?.kind === 'muse-manuscript')
          .find(message => state.notices.has(message.id))
        assert.ok(notice, 'The model must actually receive the logged delivery steering after its attempted stop')
        state.steerSeen = true
      }
    } else {
      child = state.children.get(options.sessionId)
      assert.ok(child)
      child.requests++
      child.input = reviewInput(options)
      assert.equal(child.input.user_request.text, PARENT_TASK)
      assert.equal(child.input.task, TASK)
      assert.equal(options.maxTokens, 4096)
      assert.deepEqual((options.tools ?? []).map(tool => tool.name), ['structured_output'])
      const candidate = child.input.materials.documents.find(document => document.role === 'candidate')
      assert.ok(candidate)
      const expected = [accepted, faulty, accepted, accepted][child.index]
      const bytes = child.index === 3 ? word : expected
      assert.equal(candidate.file_sha256, hash(bytes))
      assert.equal(candidate.text_sha256, hash(expected))
      assert.deepEqual(candidate.lines, expected.split('\n').map((text, index) => ({ number: index + 1, text }))
        .filter(line => child.index !== 2 || line.number <= 21))
      assert.equal(candidate.coverage.full_document, child.index !== 2)
      if (child.index === 2) {
        assert.deepEqual(candidate.selection, { kind: 'episodes', requested: [2], included: [1, 2, 3], adjacent: [1, 3] })
        assert.deepEqual(candidate.coverage.unread_ranges, [{ start: 22, end: 29 }])
      }
    }
    for await (const chunk of next()) yield process.env.DSH_SNAPSHOT === 'replay' && child !== undefined ? replayChunk(chunk, child.input) : chunk
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (agent !== state.parent || state.results.length < steps(state).length + followupSteps(state).length) return
    assert.equal(state.children.size, 4)
    assert.deepEqual([...state.children.values()].map(child => child.requests), [1, 1, 1, 1])
    assert.equal(state.notices.size, 1)
    assert.equal(state.steerSeen, true)
    assert.deepEqual(state.presented.map(item => basename(item.files[0].path)), ['final.md', 'final.md', 'partial.md', 'final.docx', 'unpresented.md'])
    assert.equal(await readFile(join(agent.session.header.cwd, 'final.md'), 'utf8'), faulty)
    assert.deepEqual(await readFile(join(agent.session.header.cwd, 'final.docx')), Buffer.from(word))
    await writeFile(join(agent.session.header.cwd, '_delivery-probe.json'), JSON.stringify({
      selectedModel: { provider: PROVIDER, model: MODEL }, reviewerRequests: [1, 1, 1, 1],
      finalWordReadIndependently: true, actualPartialCoveragePreserved: true,
      loggedDeliveryNotices: state.notices.size, noticeReceivedByModel: state.steerSeen,
      presentedFiles: state.presented.map(item => basename(item.files[0].path)), results: state.results,
    }, null, 2) + '\n')
  })
  if (!process.env.DSH_SNAPSHOT || process.env.DSH_SNAPSHOT === 'record') {
    ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], new DeliveryAdapter(state)))
  }
}
