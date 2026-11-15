/** Offline cross-episode review retains grounded pair evidence and rejects duplicated coverage. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { importSnapshotModule, importSnapshotPackage } from '../../../../../snapshots/session/muse-fixture-import.mjs'

const owner = new URL('../../../package.json', import.meta.url)
const { LlmAdapter, ToolCallId } = await importSnapshotPackage('@deepseek-ai/dsh-llm', owner)
const { validateJsonSchemaValue } = await importSnapshotPackage('@deepseek-ai/dsh-tools', owner)
const revisions = await importSnapshotModule(new URL('../../../src/manuscript-revisions.ts', import.meta.url),
  new URL('../../../lib/manuscript-revisions.js', import.meta.url))
export const name = 'manuscript-cross-episode-fixture'
export const inject = ['llm', 'tools']
const provider = 'manuscript-cross-episode-fixture'
const current = await readFile(new URL('./current.md', import.meta.url), 'utf8')
const candidate = await readFile(new URL('./candidate.md', import.meta.url), 'utf8')
const initial = '只读核对 current.md 与 candidate.md 的跨集衔接，逐对检查铜钱计数、人物知情和尾钩承接；普通切场本身不算矛盾，不修改文件。'
const calls = ['cross-episode-valid', 'cross-episode-duplicated-pair']
const expectedPairs = [[1, 2], [2, 3]]

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
  assert.ok(input, 'A real reviewer must receive its logged material prompt')
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
  const countEvidence = [cite(target, 3), cite(target, 7), cite(target, 8)]
  const first = { from_episode: 1, to_episode: 2, status: 'issues',
    explanation: '第一集已有七次正面，第二集再抛三次应累计十次，候选却写九连；两集计数不一致。', evidence: countEvidence }
  const next = { from_episode: 2, to_episode: 3, status: 'consistent',
    explanation: '第二集收好铜钱，第三集明确次日在客厅取出；普通切场与次日推进没有构成矛盾。',
    evidence: [cite(target, 9), cite(target, 12)] }
  if (index === 0) return { status: 'issues', findings: [{ category: 'object_state',
    description: '离线管道样例：七加三却写成九连，铜钱计数在跨集承接处不一致。', evidence: countEvidence }],
  unknowns: [], episode_checks: [first, next] }
  const duplicated = { ...first, status: 'consistent', explanation: '覆盖反例：重复提交同一集对，遗漏第二至第三集。' }
  return { status: 'consistent', findings: [], unknowns: [], episode_checks: [duplicated, duplicated] }
}

function replayArguments(text, input) {
  const report = JSON.parse(text)
  const evidence = [...report.findings.flatMap(finding => finding.evidence),
    ...report.episode_checks.flatMap(check => check.evidence)]
  for (const anchor of evidence) {
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

class CrossEpisodeAdapter extends LlmAdapter {
  constructor(state) { super(); this.state = state }
  async *stream(options) {
    if (options.sessionId !== this.state.parent.id) {
      const child = this.state.children.get(options.sessionId)
      assert.ok(child)
      const report = reportFor(child.input, child.index)
      const schema = options.tools.find(tool => tool.name === 'structured_output').parameters
      assert.deepEqual(validateJsonSchemaValue(schema, report), [], 'The missing-pair counterexample passes the tool JSON schema')
      yield* call('structured_output', report, `cross-episode-child-${child.index + 1}`)
      return
    }
    const id = calls[this.state.results.length]
    if (id) {
      yield* call('manuscript_revision', { action: 'cross_episode',
        documents: [{ role: 'current', path: 'current.md' }, { role: 'candidate', path: 'candidate.md' }],
        task: '逐对核对完整相邻集，检查已完成事实和计数，区分有明确时间推进的普通切场；只读，不修改稿件。' }, id)
    } else {
      const text = '跨集只读检查保留了计数冲突及普通切场依据；重复集对未形成有效审校结论。离线固定回复不代表真实模型语义能力。'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

export async function apply(ctx) {
  await ctx.plugin(revisions)
  const state = { parent: undefined, children: new Map(), results: [], parentRequests: 0 }
  ctx.effect(() => {
    const prior = globalThis.fetch
    globalThis.fetch = async () => { throw Error('Cross-episode fixture refuses network access') }
    return () => { globalThis.fetch = prior }
  })
  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.header.parentSession !== undefined) {
      assert.equal(agent.session.header.parentSession, state.parent.id)
      state.children.set(agent.id, { index: state.children.size, input: undefined, requests: 0 })
      return
    }
    assert.equal(state.parent, undefined); state.parent = agent
    await writeFile(join(agent.session.header.cwd, 'current.md'), current)
    await writeFile(join(agent.session.header.cwd, 'candidate.md'), candidate)
  })
  ctx.on('llm/stream', async function* (options, next) {
    if (options.provider !== provider || options.purpose !== undefined) { yield* next(); return }
    let reviewer
    if (options.sessionId === state.parent.id) {
      state.parentRequests++
      const last = options.messages.findLast(message => message.role === 'tool')
      if (last && last.toolCallId !== state.results.at(-1)?.call_id) {
        const index = state.results.length
        assert.equal(last.toolCallId, calls[index]); assert.equal(last.isError, false)
        const value = JSON.parse(last.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
        assert.equal(value.state, 'continuity')
        assert.equal(value.status, index === 0 ? 'issues' : 'unknown')
        assert.equal(value.reason, index === 0 ? 'reviewed' : 'invalid_evidence')
        const planned = value.episode_plan.checks.map(check => [check.from_episode, check.to_episode])
        assert.deepEqual(planned, expectedPairs)
        assert.equal(value.episode_plan.path, join(state.parent.session.header.cwd, 'candidate.md'))
        state.results.push({ call_id: last.toolCallId, status: value.status, reason: value.reason,
          planned_pairs: planned, checked_pairs: (value.episode_checks ?? []).map(check => [check.from_episode, check.to_episode]),
          finding_categories: value.findings.map(finding => finding.category), file_verification: value.file_verification })
      }
    } else {
      reviewer = state.children.get(options.sessionId)
      assert.ok(reviewer); reviewer.requests++
      assert.deepEqual(options.tools.map(tool => tool.name), ['structured_output'])
      reviewer.input = inputOf(options)
      assert.equal(reviewer.input.user_request.text, initial)
      assert.equal(reviewer.input.target.role, 'candidate')
      assert.deepEqual(reviewer.input.episode_plan.checks.map(check => [check.from_episode, check.to_episode]), expectedPairs)
      assert.equal(reviewer.input.episode_plan.file_sha256, reviewer.input.target.file_sha256)
    }
    for await (const chunk of next()) {
      yield process.env.DSH_SNAPSHOT === 'replay' && reviewer !== undefined ? replayChunk(chunk, reviewer.input) : chunk
    }
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (agent !== state.parent) return
    assert.equal(state.results.length, 2); assert.equal(state.parentRequests, 3); assert.equal(state.children.size, 2)
    const childRequests = [...state.children.values()].map(child => child.requests)
    assert.deepEqual(childRequests, [1, 1])
    const cwd = agent.session.header.cwd
    assert.equal(await readFile(join(cwd, 'current.md'), 'utf8'), current)
    assert.equal(await readFile(join(cwd, 'candidate.md'), 'utf8'), candidate)
    await writeFile(join(cwd, '_cross-episode-probe.json'), JSON.stringify({ parentRequests: state.parentRequests, childRequests,
      childTools: ['structured_output'], results: state.results, currentUnchanged: true, candidateUnchanged: true,
    }, null, 2) + '\n')
  })
  if (!process.env.DSH_SNAPSHOT || process.env.DSH_SNAPSHOT === 'record') {
    ctx.effect(() => ctx.llm.registerAdapter([provider], new CrossEpisodeAdapter(state)))
  }
}
