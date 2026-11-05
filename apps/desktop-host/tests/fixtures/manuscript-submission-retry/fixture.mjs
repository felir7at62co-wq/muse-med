/** A rejected inconsistent declaration continues the same real reviewer without erasing uncertainty. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { importSnapshotModule, importSnapshotPackage } from '../../../../../snapshots/session/muse-fixture-import.mjs'

const owner = new URL('../../../package.json', import.meta.url)
const { LlmAdapter, ToolCallId } = await importSnapshotPackage('@deepseek-ai/dsh-llm', owner)
const revisions = await importSnapshotModule(new URL('../../../src/manuscript-revisions.ts', import.meta.url), new URL('../../../lib/manuscript-revisions.js', import.meta.url))
const text = await readFile(new URL('../manuscript-continuity/heldout/case-h02.md', import.meta.url), 'utf8')
const sha256 = createHash('sha256').update(text).digest('hex')
const UNKNOWN = ['离线管道样例：片段未说明谁打开三号木箱，无法确认钥匙交接与披风取用过程。']
const PROVIDER = 'manuscript-submission-retry-fixture'
const MODEL = 'selected-creative-model'

export const name = 'manuscript-submission-retry-fixture'
export const inject = ['llm', 'tools', 'fs', 'subagents']

function* call(name, args, id) {
  const value = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: ToolCallId(id), name, argumentsDelta: value }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: value } }
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

class SubmissionAdapter extends LlmAdapter {
  constructor(state) { super(); this.state = state }
  async *stream(options) {
    const state = this.state
    if (options.sessionId !== state.parent.id) {
      const first = state.childRequests === 1
      yield* call('structured_output', { status: first ? 'consistent' : 'unknown', findings: [], unknowns: [...UNKNOWN] },
        first ? 'submission-invalid-consistent' : 'submission-valid-unknown')
      return
    }
    if (!state.parentResult) {
      yield* call('manuscript_revision', { action: 'continuity', task: '审校实际四集正文，保留未能核实的承接事项，不修改文件。',
        documents: [{ role: 'current', path: 'current.md' }] }, 'submission-review')
      return
    }
    const message = '真实工具拒绝了与未知项冲突的一致性声明；同一子会话在总预算内保留原未知项，返回 unknown。固定回复只验证管道。'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: message }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: message } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** @param {import('@deepseek-ai/cordis').Context} ctx - Shipped headless services and actual tool pipeline. */
export async function apply(ctx) {
  await ctx.plugin(revisions, { continuityMaxRequests: 2, continuityMaxOutputTokens: 4096 })
  const state = { parent: undefined, child: undefined, childRequests: 0, parentRequests: 0,
    parentResult: undefined, denied: false, denialObservedByReviewer: false, missingOutputNotices: 0 }
  ctx.effect(() => {
    const original = globalThis.fetch
    globalThis.fetch = async () => { throw Error('Submission retry fixture refuses network access') }
    return () => { globalThis.fetch = original }
  })
  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.header.parentSession !== undefined) {
      assert.equal(state.child, undefined, 'A correction must continue the same real reviewer')
      assert.equal(agent.session.header.parentSession, state.parent.id)
      state.child = agent
      return
    }
    assert.equal(state.parent, undefined)
    state.parent = agent
    await writeFile(join(agent.session.header.cwd, 'current.md'), text)
  })
  ctx.on('session/event', (session, event) => {
    if (session !== state.child?.session) return
    if (event.type === 'tool/result' && event.data.message.toolCallId === 'submission-invalid-consistent') {
      assert.equal(event.data.message.isError, true)
      const feedback = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      assert.match(feedback, /CONTINUITY_INVALID_SUBMISSION/u)
      assert.match(feedback, /Do not discard actual unknowns/u)
      state.denied = true
    }
    if (event.type === 'user/message' && event.data.source.kind === 'muse-manuscript'
      && event.data.source.summary === '审校结构化结果尚未提交') state.missingOutputNotices++
  })
  ctx.on('llm/stream', async function* (options, next) {
    if (options.provider !== PROVIDER || options.purpose !== undefined) { yield* next(); return }
    assert.equal(options.model, MODEL)
    if (options.sessionId === state.parent.id) {
      state.parentRequests++
      const result = options.messages.findLast(message => message.role === 'tool')
      if (result) {
        assert.equal(result.toolCallId, 'submission-review')
        assert.equal(result.isError, false)
        const value = JSON.parse(result.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
        assert.equal(value.status, 'unknown')
        assert.equal(value.reason, 'reviewed')
        assert.equal(value.file_verification, 'verified')
        assert.deepEqual(value.unknowns, UNKNOWN)
        assert.deepEqual(value.findings, [])
        assert.equal(value.reviewer.requests, 2)
        assert.equal(value.reviewer.session_id, state.child.id)
        assert.deepEqual(value.reviewer.selection, { provider: PROVIDER, model: MODEL })
        assert.equal(value.target.file_sha256, sha256)
        state.parentResult = value
      }
    } else {
      assert.equal(options.sessionId, state.child.id)
      state.childRequests++
      assert.ok(state.childRequests <= 2, 'Invalid and corrected submissions share the same total request cap')
      assert.equal(options.maxTokens, 4096)
      assert.deepEqual((options.tools ?? []).map(tool => tool.name), ['structured_output'])
      if (state.childRequests === 2) {
        const result = options.messages.findLast(message => message.role === 'tool')
        assert.equal(result?.toolCallId, 'submission-invalid-consistent')
        assert.equal(result.isError, true)
        assert.match(result.content.filter(block => block.type === 'text').map(block => block.text).join('\n'), /Do not discard actual unknowns/u)
        state.denialObservedByReviewer = true
      }
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (agent !== state.parent) return
    assert.equal(state.parentRequests, 2)
    assert.equal(state.childRequests, 2)
    assert.equal(state.denied, true)
    assert.equal(state.denialObservedByReviewer, true)
    assert.equal(state.missingOutputNotices, 0)
    assert.deepEqual(state.parentResult.unknowns, UNKNOWN)
    assert.equal(await readFile(join(agent.session.header.cwd, 'current.md'), 'utf8'), text)
    await writeFile(join(agent.session.header.cwd, '_submission-retry-probe.json'), JSON.stringify({
      parentRequests: 2, reviewerSessions: 1, reviewerRequests: 2, reviewerTotalRequestCap: 2,
      actualInvalidSubmissionRejected: true, actualDenialReceivedByReviewer: true,
      extraMissingOutputCorrections: 0, parentReceivedStatus: 'unknown', parentReceivedReason: 'reviewed',
      originalUnknownsPreserved: UNKNOWN, currentFileSha256: sha256, inputFileUnchanged: true,
    }, null, 2) + '\n')
  })
  if (!process.env.DSH_SNAPSHOT || process.env.DSH_SNAPSHOT === 'record') ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], new SubmissionAdapter(state)))
}
