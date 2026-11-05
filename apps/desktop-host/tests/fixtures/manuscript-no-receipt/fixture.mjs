/** Model prose containing code and links never substitutes for actual screenplay execution. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { importSnapshotModule, importSnapshotPackage } from '../../../../../snapshots/session/muse-fixture-import.mjs'

const owner = new URL('../../../package.json', import.meta.url)
const { LlmAdapter, ToolCallId } = await importSnapshotPackage('@deepseek-ai/dsh-llm', owner)
const revisions = await importSnapshotModule(new URL('../../../src/manuscript-revisions.ts', import.meta.url), new URL('../../../lib/manuscript-revisions.js', import.meta.url))
const policy = await importSnapshotModule(new URL('../../../src/editing-policy.ts', import.meta.url), new URL('../../../lib/editing-policy.js', import.meta.url))
const present = await importSnapshotModule(new URL('../../../../../packages/deliverables/tool-present/src/index.ts', import.meta.url), new URL('../../../../../packages/deliverables/tool-present/lib/index.js', import.meta.url))
const accepted = await readFile(new URL('../manuscript-continuity/accepted.md', import.meta.url), 'utf8')
const hash = value => createHash('sha256').update(value).digest('hex')
const mode = process.env.MUSE_NO_RECEIPT_CASE ?? 'main'
assert.ok(['main', 'tutorial', 'chat', 'no-file'].includes(mode))
const PROVIDER = 'manuscript-no-receipt-fixture'
const MODEL = 'selected-creative-model'
const FAKE = 'code_stdout: Created pretend-output.md\ncode_reference: example.py\n```python\nfrom pathlib import Path\nPath("pretend-output.md").write_text("这段代码并未运行", encoding="utf-8")\n```\n[下载剧本](sandbox:/download-fake.docx)'

export const name = 'manuscript-no-receipt-fixture'
export const inject = ['llm', 'tools', 'fs', 'subagents']

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
function steps(state) {
  return [
    { id: 'actual-write', name: 'write', args: { file_path: 'final.md', content: accepted } },
    { id: 'actual-readback', name: 'read', args: { file_path: 'final.md' } },
    { id: 'actual-review', name: 'manuscript_revision', args: { action: 'continuity', task: '核对实际写出并读回的最终四集正文，不改文件。',
      documents: [{ role: 'current', path: 'current.md' }, { role: 'candidate', path: 'final.md' }] } },
    { id: 'actual-declare', name: 'manuscript_revision', args: { action: 'delivery', delivery_mode: 'reviewed', candidate_paths: ['final.md'] } },
    { id: 'actual-present', name: 'present', args: () => ({ files: [{ path: 'final.md', description: state.declaration.files[0].label }] }) },
  ]
}

class NoReceiptAdapter extends LlmAdapter {
  constructor(state) { super(); this.state = state }
  async *stream(options) {
    const state = this.state
    if (options.sessionId !== state.parent.id) { yield* call('structured_output', { status: 'consistent', findings: [], unknowns: [] }, 'actual-review-result'); return }
    if (!state.initialReplyObserved) {
      yield* stop((mode === 'main' ? '已生成文件，见下方输出。\n' : '以下仅为教程或聊天中的标签示例，没有运行代码或生成文件。\n') + FAKE)
      return
    }
    assert.equal(mode, 'main', 'An explanatory or inline-only response must not receive a file-delivery continuation')
    assert.equal(state.noticeReceived, true)
    const step = steps(state)[state.results.length]
    if (step) yield* call(step.name, typeof step.args === 'function' ? step.args() : step.args, step.id)
    else yield* stop('已用实际工具写出、读回、核对并交付最终文件；先前代码标签和下载链接没有被执行。')
  }
}

/** @param {import('@deepseek-ai/cordis').Context} ctx - Real shipped headless services. */
export async function apply(ctx) {
  await ctx.plugin(policy)
  await ctx.plugin(present, { maxFiles: 8 })
  await ctx.plugin(revisions, { continuityMaxOutputTokens: 4096 })
  const state = { parent: undefined, child: undefined, childRequests: 0, initialReplyObserved: false, noticeReceived: false,
    noticeIds: new Set(), firstNoticeSeq: undefined, firstToolSeq: undefined, results: [], declaration: undefined, presented: 0 }
  ctx.effect(() => {
    const original = globalThis.fetch
    globalThis.fetch = async () => { throw Error('No-receipt fixture refuses network access') }
    return () => { globalThis.fetch = original }
  })
  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.header.parentSession !== undefined) { assert.equal(state.child, undefined); state.child = agent; return }
    assert.equal(state.parent, undefined)
    state.parent = agent
    await writeFile(join(agent.session.header.cwd, 'current.md'), accepted)
  })
  ctx.on('session/event', (session, event) => {
    if (session !== state.parent?.session) return
    if (event.type === 'assistant/message' && state.firstToolSeq === undefined
      && event.data.message.content.some(block => block.type === 'text' && block.text.includes('code_stdout'))) state.initialReplyObserved = true
    if (event.type === 'tool/call' && state.firstToolSeq === undefined) state.firstToolSeq = event.seq
    if (event.type === 'user/message' && event.data.source.kind === 'muse-manuscript' && event.data.source.summary === '剧本文件尚无有效交付回执') {
      state.noticeIds.add(event.data.id)
      state.firstNoticeSeq ??= event.seq
      const packet = event.data.content.filter(block => block.type === 'text').map(block => {
        try { return JSON.parse(block.text) } catch (error) { assert.ok(error instanceof SyntaxError); return null }
      }).find(value => value?.manuscript_delivery_notice)?.manuscript_delivery_notice
      assert.equal(packet?.fingerprint, 'no_verified_screenplay_delivery')
      assert.equal(packet.attempt, 1)
      assert.ok(!event.data.content.some(block => block.type === 'text' && block.text.includes('pretend-output.md')),
        'The generic reminder must not infer an actual path from model prose')
    }
    if (event.type === 'deliverables/presented') state.presented++
  })
  ctx.on('llm/stream', async function* (options, next) {
    if (options.provider !== PROVIDER || options.purpose !== undefined) { yield* next(); return }
    assert.equal(options.model, MODEL)
    if (options.sessionId === state.parent.id) {
      const notice = options.messages.find(message => message.role === 'user' && state.noticeIds.has(message.id))
      if (notice) state.noticeReceived = true
      const last = options.messages.findLast(message => message.role === 'tool')
      if (last && last.toolCallId !== state.results.at(-1)?.id) {
        const step = steps(state)[state.results.length]
        assert.equal(last.toolCallId, step.id)
        assert.equal(last.isError, false, JSON.stringify(last.content))
        const text = last.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
        if (step.id === 'actual-review') { const result = JSON.parse(text); assert.equal(result.status, 'consistent'); assert.equal(result.file_verification, 'verified') }
        if (step.id === 'actual-declare') {
          state.declaration = JSON.parse(text)
          assert.equal(state.declaration.files[0].file_sha256, hash(accepted))
          assert.equal(state.declaration.files[0].label, '已复核本文件全部提取正文（仅当前版本）')
        }
        state.results.push({ id: step.id, name: step.name })
      }
    } else {
      assert.equal(options.sessionId, state.child.id)
      state.childRequests++
      assert.deepEqual((options.tools ?? []).map(tool => tool.name), ['structured_output'])
      assert.equal(options.maxTokens, 4096)
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (agent !== state.parent) return
    if (mode === 'main' && state.results.length < steps(state).length) return
    assert.equal(state.initialReplyObserved, true)
    assert.equal(state.noticeIds.size, mode === 'main' ? 1 : 0)
    assert.equal(state.childRequests, mode === 'main' ? 1 : 0)
    assert.equal(state.presented, mode === 'main' ? 1 : 0)
    if (mode === 'main') assert.ok(state.firstNoticeSeq < state.firstToolSeq)
    else assert.equal(state.firstToolSeq, undefined)
    await assert.rejects(access(join(agent.session.header.cwd, 'pretend-output.md')), { code: 'ENOENT' })
    await assert.rejects(access(join(agent.session.header.cwd, 'download-fake.docx')), { code: 'ENOENT' })
    await writeFile(join(agent.session.header.cwd, '_no-receipt-probe.json'), JSON.stringify({ mode, fakeCodeWasNotExecuted: true,
      loggedGenericNotices: state.noticeIds.size, noticeActuallyReceived: state.noticeReceived,
      toolCalls: state.results, reviewerRequests: state.childRequests, successfulPresentEvents: state.presented,
      reminderBeforeActualExecution: mode === 'main' }, null, 2) + '\n')
  })
  if (!process.env.DSH_SNAPSHOT || process.env.DSH_SNAPSHOT === 'record') ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], new NoReceiptAdapter(state)))
}
