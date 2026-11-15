/** Real spawned reviewer sessions with deterministic structured responses and external-edit controls. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { importSnapshotModule, importSnapshotPackage } from '../../../../../snapshots/session/muse-fixture-import.mjs'

const owner = new URL('../../../package.json', import.meta.url)
const { LlmAdapter, ToolCallId } = await importSnapshotPackage('@deepseek-ai/dsh-llm', owner)
const { validateJsonSchemaValue } = await importSnapshotPackage('@deepseek-ai/dsh-tools', owner)
const revisions = await importSnapshotModule(new URL('../../../src/manuscript-revisions.ts', import.meta.url),
  new URL('../../../lib/manuscript-revisions.js', import.meta.url))

/** Loader identity for the real parent-to-reviewer tool scenario. */
export const name = 'manuscript-continuity-fixture'
/** The fixture replaces only model responses; product services and tool execution stay real. */
export const inject = ['llm', 'tools', 'fs', 'subagents']

const PROVIDER = 'manuscript-continuity-fixture'
const MODEL = 'selected-creative-model'
const REVIEW_OUTPUT_TOKENS = 4096
const TASK = '核对候选稿四集的事件先后、物件状态和集间衔接，引用实际已读原句，不修改稿件。'
const PARENT_TASK = '对显式选中的候选稿执行只读衔接审校，保留实际证据和未知项。'
const EDIT = '\n外部返稿补充：此文件在审校尚未结束时已经保存了新内容。\n'
const hash = value => createHash('sha256').update(value).digest('hex')
const currentText = await readFile(new URL('./accepted.md', import.meta.url), 'utf8')
const referenceText = await readFile(new URL('./case-b.md', import.meta.url), 'utf8')
const candidateText = await readFile(new URL('./case-a.md', import.meta.url), 'utf8')
const documents = { 'current.md': currentText, 'reference.md': referenceText, 'candidate.md': candidateText }
const roles = [
  { role: 'reference', path: 'reference.md' }, { role: 'current', path: 'current.md' }, { role: 'candidate', path: 'candidate.md' },
]

function* call(name, args, id) {
  const argumentsText = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: ToolCallId(id), name, argumentsDelta: argumentsText }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: argumentsText } }
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

function reviewInput(options) {
  for (const message of options.messages) {
    if (message.role !== 'user') continue
    for (const block of message.content) {
      if (block.type !== 'text') continue
      try {
        const value = JSON.parse(block.text)
        if (value.materials && value.target) return value
      } catch (error) {
        // Child context also contains ordinary delegation instructions that are not JSON materials.
        assert.ok(error instanceof SyntaxError)
      }
    }
  }
  throw Error('The real reviewer request must contain its explicit JSON materials and target')
}

function evidence(document, line) {
  const actual = document.lines.find(item => item.number === line)
  assert.ok(actual)
  return { role: document.role, path: document.path, file_sha256: document.file_sha256,
    text_sha256: document.text_sha256, line, quote: actual.text }
}

function childReport(input, index) {
  const candidate = input.materials.documents.find(document => document.role === 'candidate')
  assert.ok(candidate)
  const anchors = [evidence(candidate, 19), evidence(candidate, 25)]
  if (index === 2) return { status: 'consistent', findings: [], unknowns: [] }
  if (index === 1) anchors[0].quote += '（此句并不存在于实际稿件）'
  return {
    status: 'issues',
    findings: [{ category: 'object_state', description: '离线管道样例：同一木床的两处状态需要核对；此固定回复不构成真实模型语义能力证明。', evidence: anchors }],
    unknowns: [],
  }
}

function materializeCitationArguments(argumentsText, input) {
  const report = JSON.parse(argumentsText)
  for (const finding of report.findings) for (const anchor of finding.evidence) {
    const document = input.materials.documents.find(item => item.role === anchor.role
      && item.file_sha256 === anchor.file_sha256 && item.text_sha256 === anchor.text_sha256)
    assert.ok(document, 'Recorded citation role and hashes must identify one supplied document')
    assert.equal(anchor.path, `{{cwd}}/${basename(document.path)}`, 'Recorded citation filename must match the supplied document')
    anchor.path = document.path
  }
  return JSON.stringify(report)
}

function materializeReplayChunk(chunk, input) {
  if (chunk.type === 'tool-call-delta' && chunk.name === 'structured_output') {
    return { ...chunk, argumentsDelta: materializeCitationArguments(chunk.argumentsDelta, input) }
  }
  if (chunk.type === 'block-end' && chunk.block.type === 'tool-call' && chunk.block.name === 'structured_output') {
    return { ...chunk, block: { ...chunk.block, arguments: materializeCitationArguments(chunk.block.arguments, input) } }
  }
  return chunk
}

function inspectChildMaterials(options, child) {
  assert.equal(options.provider, PROVIDER)
  assert.equal(options.model, MODEL)
  assert.equal(options.maxTokens, REVIEW_OUTPUT_TOKENS)
  assert.deepEqual((options.tools ?? []).map(tool => tool.name), ['structured_output'])
  const input = reviewInput(options)
  assert.equal(input.task, TASK)
  assert.ok(input.user_request.message_id)
  assert.equal(input.user_request.text, PARENT_TASK)
  assert.equal(input.materials.state, 'materials')
  assert.equal(input.materials.semantic_assessment, 'not_performed')
  assert.equal(input.target.role, 'candidate')
  assert.equal(input.target.file_sha256, hash(candidateText))
  for (const [role, filename] of [['current', 'current.md'], ['reference', 'reference.md'], ['candidate', 'candidate.md']]) {
    const document = input.materials.documents.find(item => item.role === role)
    const text = documents[filename]
    assert.ok(document)
    assert.equal(basename(document.path), filename)
    assert.equal(document.file_sha256, hash(text))
    assert.equal(document.text_sha256, hash(text))
    assert.deepEqual(document.lines, text.split('\n').map((text, index) => ({ number: index + 1, text })))
    assert.equal(document.coverage.full_document, true)
    assert.deepEqual(document.coverage.unread_ranges, [])
  }
  child.input = input
  if (child.index === 0 && child.requests === 1) {
    const recorded = childReport(input, 0)
    for (const anchor of recorded.findings[0].evidence) anchor.path = `{{cwd}}/${basename(anchor.path)}`
    assert.deepEqual(JSON.parse(materializeCitationArguments(JSON.stringify(recorded), input)), childReport(input, 0))
    recorded.findings[0].evidence[0].path = '{{cwd}}/different-document.md'
    assert.throws(() => materializeCitationArguments(JSON.stringify(recorded), input), /Recorded citation filename/)
  }
  const last = options.messages.findLast(message => message.role === 'tool')
  if (child.index === 0 && last) {
    assert.equal(last.toolCallId, 'continuity-forbidden-write')
    assert.equal(last.isError, true)
    assert.match(last.content.filter(block => block.type === 'text').map(block => block.text).join('\n'),
      /Manuscript continuity review permits only structured_output; no execution or file access is allowed\./)
    child.writeRejected = true
  }
}

function inspectParentResult(message, index, child) {
  assert.equal(message.toolCallId, `continuity-parent-${index + 1}`)
  assert.equal(message.isError, false, JSON.stringify(message.content))
  const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  const value = JSON.parse(text)
  assert.equal(value.state, 'continuity')
  assert.equal(value.advisory, true)
  assert.equal(value.scope, 'returned_text_lines_only')
  assert.equal(value.status, index === 0 ? 'issues' : 'unknown', JSON.stringify({ reason: value.reason,
    unknowns: value.unknowns, reviewer: value.reviewer }))
  assert.equal(value.reason, ['reviewed', 'invalid_evidence', 'file_changed'][index])
  assert.equal(value.file_verification, index === 2 ? 'changed' : 'verified')
  assert.equal(value.reviewer.session_id, child.agent.id)
  assert.deepEqual(value.reviewer.selection, { provider: PROVIDER, model: MODEL })
  assert.equal(value.reviewer.requests, index === 0 ? 2 : 1)
  assert.equal(value.target.role, 'candidate')
  assert.equal(value.target.file_sha256, hash(candidateText))
  if (index === 0) {
    assert.equal(value.findings.length, 1)
    assert.deepEqual(value.findings[0].evidence.map(anchor => ({ line: anchor.line, quote: anchor.quote })), [
      { line: 19, quote: candidateText.split('\n')[18] }, { line: 25, quote: candidateText.split('\n')[24] },
    ])
  } else assert.ok(value.unknowns.length > 0)
  return { case: ['valid-evidence', 'invalid-quote', 'changed-candidate'][index], status: value.status, reason: value.reason,
    file_verification: value.file_verification,
    target: { role: value.target.role, file: basename(value.target.path), file_sha256: value.target.file_sha256,
      text_sha256: value.target.text_sha256 } }
}

class ContinuityAdapter extends LlmAdapter {
  constructor(state) { super(); this.state = state }

  async *stream(options) {
    if (options.sessionId === this.state.parent.id) {
      const index = this.state.results.length
      if (index < 3) yield* call('manuscript_revision', { action: 'continuity', documents: roles, task: TASK }, `continuity-parent-${index + 1}`)
      else {
        const text = '只读审校管道已返回实际证据；无效引用与审校中变更均未形成一致性结论。离线固定回复不证明语义审校质量。'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
      return
    }
    const child = this.state.children.get(options.sessionId)
    assert.ok(child)
    if (child.index === 0 && !child.writeRejected) {
      yield* call('write', { file_path: 'forbidden-child-write.md', content: 'This child must never write a file.\n' }, 'continuity-forbidden-write')
    } else {
      const report = childReport(child.input, child.index)
      const schema = options.tools.find(tool => tool.name === 'structured_output').parameters
      assert.deepEqual(validateJsonSchemaValue(schema, report), [])
      yield* call('structured_output', report, `continuity-structured-${child.index + 1}`)
    }
  }
}

/**
 * Install the real reviewer service through manuscript_revision and observe parent/child model requests.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Loader-owned isolated headless composition.
 */
export async function apply(ctx) {
  await ctx.plugin(revisions, { continuityMaxOutputTokens: REVIEW_OUTPUT_TOKENS })
  const state = { parent: undefined, children: new Map(), parentRequests: 0, results: [], mutated: false }
  ctx.effect(() => {
    const original = globalThis.fetch
    globalThis.fetch = async () => { throw Error('Manuscript continuity fixture refuses network access') }
    return () => { globalThis.fetch = original }
  })
  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.header.parentSession !== undefined) {
      assert.ok(state.parent)
      assert.equal(agent.session.header.parentSession, state.parent.id)
      state.children.set(agent.id, { agent, index: state.children.size, requests: 0, writeRejected: false, input: undefined })
      return
    }
    assert.equal(state.parent, undefined)
    state.parent = agent
    for (const [filename, text] of Object.entries(documents)) await writeFile(join(agent.session.header.cwd, filename), text)
  })
  ctx.on('llm/stream', async function* (options, next) {
    if (options.provider !== PROVIDER || options.purpose !== undefined) { yield* next(); return }
    assert.equal(options.model, MODEL)
    let reviewer
    if (options.sessionId === state.parent.id) {
      state.parentRequests += 1
      const last = options.messages.findLast(message => message.role === 'tool')
      if (last) state.results.push(inspectParentResult(last, state.results.length, [...state.children.values()][state.results.length]))
    } else {
      const child = state.children.get(options.sessionId)
      assert.ok(child, 'A real created child Session owns every reviewer request')
      reviewer = child
      child.requests += 1
      inspectChildMaterials(options, child)
      if (child.index === 2 && !state.mutated) {
        await writeFile(join(state.parent.session.header.cwd, 'candidate.md'), candidateText + EDIT)
        state.mutated = true
      }
    }
    for await (const chunk of next()) {
      yield process.env.DSH_SNAPSHOT === 'replay' && reviewer !== undefined
        ? materializeReplayChunk(chunk, reviewer.input) : chunk
    }
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (agent !== state.parent) return
    assert.equal(state.results.length, 3)
    assert.equal(state.parentRequests, 4)
    assert.equal(state.children.size, 3)
    const cwd = agent.session.header.cwd
    assert.equal(await readFile(join(cwd, 'current.md'), 'utf8'), currentText)
    assert.equal(await readFile(join(cwd, 'reference.md'), 'utf8'), referenceText)
    assert.equal(await readFile(join(cwd, 'candidate.md'), 'utf8'), candidateText + EDIT)
    await assert.rejects(access(join(cwd, 'forbidden-child-write.md')), { code: 'ENOENT' })
    const children = [...state.children.values()]
    assert.deepEqual(children.map(child => child.requests), [2, 1, 1])
    assert.equal(children[0].writeRejected, true)
    await writeFile(join(cwd, '_continuity-probe.json'), JSON.stringify({
      parentModel: { provider: PROVIDER, model: MODEL }, parentRequests: state.parentRequests,
      childRequests: children.map(child => child.requests), childTools: ['structured_output'],
      childWriteRejected: true, currentAndReferencePreserved: true, candidateChangedDuringReview: state.mutated,
      results: state.results,
    }, null, 2) + '\n')
  })
  if (!process.env.DSH_SNAPSHOT || process.env.DSH_SNAPSHOT === 'record') {
    ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], new ContinuityAdapter(state)))
  }
}
