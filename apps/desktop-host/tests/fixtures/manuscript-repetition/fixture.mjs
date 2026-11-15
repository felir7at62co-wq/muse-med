/** Offline real-tool repetition scan and isolated review preserve literal evidence without condemning legitimate flashbacks. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { importSnapshotModule, importSnapshotPackage } from '../../../../../snapshots/session/muse-fixture-import.mjs'

const owner = new URL('../../../package.json', import.meta.url)
const { LlmAdapter, ToolCallId } = await importSnapshotPackage('@deepseek-ai/dsh-llm', owner)
const { validateJsonSchemaValue } = await importSnapshotPackage('@deepseek-ai/dsh-tools', owner)
const revisions = await importSnapshotModule(new URL('../../../src/manuscript-revisions.ts', import.meta.url),
  new URL('../../../lib/manuscript-revisions.js', import.meta.url))
export const name = 'manuscript-repetition-fixture'
export const inject = ['llm', 'tools']
const provider = 'manuscript-repetition-fixture'
const model = 'repetition-test-model'
const sources = Object.fromEntries(await Promise.all(['current.md', 'candidate.md', 'recap.md'].map(async filename =>
  [filename, await readFile(new URL(`./${filename}`, import.meta.url), 'utf8')])))
const shared = (await readFile(new URL('./shared-span.txt', import.meta.url), 'utf8')).trimEnd()
const initial = '只读检查 current.md 与 candidate.md、recap.md 的重复剧情；区分同一已完成事件重演与明确回忆带出新信息，不修改文件。'
const steps = [
  { id: 'repeat-scan-repeated', action: 'repeat_scan', target: 'candidate.md' },
  { id: 'repetition-review-repeated', action: 'repetitions', target: 'candidate.md' },
  { id: 'repeat-scan-recap', action: 'repeat_scan', target: 'recap.md' },
  { id: 'repetition-review-recap', action: 'repetitions', target: 'recap.md' },
  { id: 'repetition-review-omitted', action: 'repetitions', target: 'candidate.md' },
]
const expectedOccurrences = {
  'candidate.md': [{ start: { line: 3, column: 2 }, end: { line: 3, column: 181 }, episode: 1 },
    { start: { line: 7, column: 3 }, end: { line: 7, column: 182 }, episode: 2 }],
  'recap.md': [{ start: { line: 3, column: 2 }, end: { line: 3, column: 181 }, episode: 1 },
    { start: { line: 8, column: 5 }, end: { line: 8, column: 184 }, episode: 2 }],
}
const hash = text => createHash('sha256').update(text).digest('hex')

function* call(name, args, id) {
  const text = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: ToolCallId(id), name, argumentsDelta: text }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: text } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

function inputOf(options) {
  const input = options.messages.flatMap(message => message.role === 'user' ? message.content : [])
    .flatMap(block => block.type === 'text' && block.text.startsWith('{"task"') ? [JSON.parse(block.text)] : [])[0]
  assert.ok(input, 'A real repetition reviewer receives its logged material prompt')
  return input
}

function cite(document, line) {
  const original = document.lines.find(value => value.number === line)
  assert.ok(original)
  return { role: document.role, path: document.path, file_sha256: document.file_sha256,
    text_sha256: document.text_sha256, line, quote: original.text }
}

function reportFor(input, index) {
  const target = input.materials.documents.find(document => document.role === 'candidate')
  assert.ok(target)
  if (index === 2) return { status: 'consistent', findings: [], unknowns: [], repeat_checks: [] }
  const legitimate = index === 1
  const literalEvidence = legitimate ? [cite(target, 3), cite(target, 8)] : [cite(target, 3), cite(target, 7)]
  const repeat_checks = input.repeat_scan.candidates.map(candidate => ({ candidate_sha256: candidate.candidate_sha256,
    status: legitimate ? 'legitimate' : 'repeated_event',
    explanation: legitimate ? '第二处明确属于昨夜回忆，回到现实后发现红绳印记与调包线索，有新的剧情作用。'
      : '两集把已经完成的锁门交钥匙事件原样重新演出，没有回忆或新用途的说明。', evidence: literalEvidence }))
  return { status: legitimate ? 'consistent' : 'issues', findings: legitimate ? [] : [
    { category: 'event_repetition', description: '离线管道样例：锁门、交钥匙、离开老宅这一完整事件在下一集重新发生。', evidence: literalEvidence },
    { category: 'event_repetition', description: '离线语义样例：同一枚已成交并仍握在手里的铜钱，下一集又从首次报价和付款开始交易。',
      evidence: [cite(target, 11), cite(target, 14)] },
  ], unknowns: [], repeat_checks }
}

function replayArguments(text, input) {
  const report = JSON.parse(text)
  for (const anchor of [...report.findings.flatMap(finding => finding.evidence),
    ...report.repeat_checks.flatMap(check => check.evidence)]) {
    const document = input.materials.documents.find(value => value.role === anchor.role
      && value.file_sha256 === anchor.file_sha256 && value.text_sha256 === anchor.text_sha256)
    assert.ok(document)
    assert.equal(anchor.path, `{{cwd}}/${basename(document.path)}`)
    anchor.path = document.path
  }
  return JSON.stringify(report)
}

function replayChunk(chunk, input) {
  if (chunk.type === 'tool-call-delta' && chunk.name === 'structured_output') {
    return { ...chunk, argumentsDelta: replayArguments(chunk.argumentsDelta, input) }
  }
  if (chunk.type === 'block-end' && chunk.block.type === 'tool-call' && chunk.block.name === 'structured_output') {
    return { ...chunk, block: { ...chunk.block, arguments: replayArguments(chunk.block.arguments, input) } }
  }
  return chunk
}

function inspectScan(scan, filename) {
  assert.equal(scan.semantic_assessment, 'not_performed')
  assert.equal(scan.target.role, 'candidate'); assert.equal(scan.target.file_sha256, hash(sources[filename]))
  assert.equal(basename(scan.target.path), filename)
  assert.equal(scan.candidates.length, 1)
  assert.equal(scan.candidates[0].text, shared); assert.equal(scan.candidates[0].characters, 180)
  assert.deepEqual(scan.candidates[0].occurrences, expectedOccurrences[filename])
  assert.equal(scan.coverage.complete, true); assert.equal(scan.coverage.enumeration_complete, true)
  assert.equal(scan.coverage.full_document, true); assert.equal(scan.coverage.omitted_candidates, 0)
  return { target: filename, file_sha256: scan.target.file_sha256, characters: scan.candidates[0].characters,
    occurrences: scan.candidates[0].occurrences, complete: scan.coverage.complete,
    enumeration_complete: scan.coverage.enumeration_complete, omitted_candidates: scan.coverage.omitted_candidates }
}

class RepetitionAdapter extends LlmAdapter {
  constructor(state) { super(); this.state = state }
  async *stream(options) {
    if (options.sessionId !== this.state.parent.id) {
      const child = this.state.children.get(options.sessionId)
      assert.ok(child)
      const report = reportFor(child.input, child.index)
      const schema = options.tools.find(tool => tool.name === 'structured_output').parameters
      assert.deepEqual(validateJsonSchemaValue(schema, report), [], 'Omitted-check coverage passes schema but must fail Host validation')
      yield* call('structured_output', report, `repetition-child-${child.index + 1}`)
      return
    }
    const step = steps[this.state.results.length]
    if (step) {
      yield* call('manuscript_revision', { action: step.action,
        documents: [{ role: 'current', path: 'current.md' }, { role: 'candidate', path: step.target }],
        ...step.action === 'repetitions' ? {
          task: '只读检查目标全文中的同一已完成事件重演，既检查字面候选，也检查无长字面相同的换词重演；明确回忆带出新线索可以保留。',
        } : {},
      }, step.id)
    } else {
      const text = '字面候选已交给独立语义审校；已完成事件重演与合法回忆分别记录，遗漏候选判定没有形成有效结论。离线固定回复不代表真实模型语义能力。'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

export async function apply(ctx) {
  await ctx.plugin(revisions)
  assert.equal(Array.from(shared).length, 180)
  assert.equal(sources['current.md'], sources['candidate.md'])
  const paraphrases = sources['candidate.md'].split('\n')
  const firstWindows = Array.from(paraphrases[10]).flatMap((_, index, characters) => index + 32 <= characters.length
    ? [characters.slice(index, index + 32).join('')] : [])
  assert.equal(firstWindows.some(window => paraphrases[13].includes(window)), false)
  const state = { parent: undefined, children: new Map(), results: [], scans: new Map(), parentRequests: 0 }
  ctx.effect(() => {
    const prior = globalThis.fetch
    globalThis.fetch = async () => { throw Error('Repetition fixture refuses network access') }
    return () => { globalThis.fetch = prior }
  })
  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.header.parentSession !== undefined) {
      assert.equal(agent.session.header.parentSession, state.parent.id)
      state.children.set(agent.id, { index: state.children.size, input: undefined, requests: 0 })
      return
    }
    assert.equal(state.parent, undefined); state.parent = agent
    for (const [filename, text] of Object.entries(sources)) await writeFile(join(agent.session.header.cwd, filename), text)
  })
  ctx.on('llm/stream', async function* (options, next) {
    if (options.provider !== provider || options.purpose !== undefined) { yield* next(); return }
    assert.equal(options.model, model)
    let reviewer
    if (options.sessionId === state.parent.id) {
      state.parentRequests++
      const last = options.messages.findLast(message => message.role === 'tool')
      if (last && last.toolCallId !== state.results.at(-1)?.call_id) {
        const step = steps[state.results.length]
        assert.equal(last.toolCallId, step.id); assert.equal(last.isError, false)
        const value = JSON.parse(last.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
        if (step.action === 'repeat_scan') {
          const scan = inspectScan(value, step.target)
          state.scans.set(step.target, value)
          state.results.push({ call_id: last.toolCallId, kind: 'scan', ...scan })
        } else {
          const index = step.id === 'repetition-review-repeated' ? 0 : step.id === 'repetition-review-recap' ? 1 : 2
          assert.equal(value.state, 'continuity')
          assert.equal(value.status, ['issues', 'consistent', 'unknown'][index])
          assert.equal(value.reason, index === 2 ? 'invalid_evidence' : 'reviewed')
          if (index === 0) assert.deepEqual(value.findings.map(finding => finding.evidence.map(anchor => anchor.line)), [[3, 7], [11, 14]])
          state.results.push({ call_id: last.toolCallId, kind: 'review', status: value.status, reason: value.reason,
            finding_categories: value.findings.map(finding => finding.category),
            literal_check_statuses: (value.repeat_checks ?? []).map(check => check.status), file_verification: value.file_verification })
        }
      }
    } else {
      reviewer = state.children.get(options.sessionId)
      assert.ok(reviewer); reviewer.requests++
      assert.deepEqual(options.tools.map(tool => tool.name), ['structured_output'])
      reviewer.input = inputOf(options)
      assert.equal(reviewer.input.user_request.text, initial)
      assert.equal(reviewer.input.target.role, 'candidate')
      const filename = basename(reviewer.input.target.path)
      inspectScan(reviewer.input.repeat_scan, filename)
      assert.deepEqual(reviewer.input.repeat_scan.candidates, state.scans.get(filename).candidates)
      assert.deepEqual(reviewer.input.repeat_scan.target, reviewer.input.target)
    }
    for await (const chunk of next()) {
      yield process.env.DSH_SNAPSHOT === 'replay' && reviewer !== undefined ? replayChunk(chunk, reviewer.input) : chunk
    }
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (agent !== state.parent) return
    assert.equal(state.results.length, 5); assert.equal(state.parentRequests, 6); assert.equal(state.children.size, 3)
    const childRequests = [...state.children.values()].map(child => child.requests)
    assert.deepEqual(childRequests, [1, 1, 1])
    const cwd = agent.session.header.cwd
    for (const [filename, original] of Object.entries(sources)) assert.equal(await readFile(join(cwd, filename), 'utf8'), original)
    await writeFile(join(cwd, '_repetition-probe.json'), JSON.stringify({ parentRequests: state.parentRequests, childRequests,
      childTools: ['structured_output'], results: state.results, allFilesUnchanged: true, sourceCopyNotCounted: true,
      literalCandidatesAreAdvisory: true, semanticRephraseHasSeparateEvidence: true,
    }, null, 2) + '\n')
  })
  if (!process.env.DSH_SNAPSHOT || process.env.DSH_SNAPSHOT === 'record') {
    ctx.effect(() => ctx.llm.registerAdapter([provider], new RepetitionAdapter(state)))
  }
}
