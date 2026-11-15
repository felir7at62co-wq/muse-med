/** Real Loader review receipts retain the human revision request and require an explicit original/candidate comparison. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { importSnapshotModule, importSnapshotPackage } from '../../../../../snapshots/session/muse-fixture-import.mjs'

const owner = new URL('../../../package.json', import.meta.url)
const { LlmAdapter, ToolCallId, createUserMessage } = await importSnapshotPackage('@deepseek-ai/dsh-llm', owner)
const revisions = await importSnapshotModule(new URL('../../../src/manuscript-revisions.ts', import.meta.url), new URL('../../../lib/manuscript-revisions.js', import.meta.url))
const editing = await importSnapshotModule(new URL('../../../src/editing-policy.ts', import.meta.url), new URL('../../../lib/editing-policy.js', import.meta.url))
const present = await importSnapshotModule(new URL('../../../../../packages/deliverables/tool-present/src/index.ts', import.meta.url), new URL('../../../../../packages/deliverables/tool-present/lib/index.js', import.meta.url))
const current = await readFile(new URL('./original.md', import.meta.url), 'utf8')
const final = await readFile(new URL('../manuscript-continuity/accepted.md', import.meta.url), 'utf8')
const sha = value => createHash('sha256').update(value).digest('hex')
const mode = process.env.MUSE_REVISION_BASIS_CASE ?? 'revision'
assert.ok(['revision', 'creation'].includes(mode))
const PROVIDER = 'manuscript-revision-basis-fixture', MODEL = 'selected-creative-model'
export const name = 'manuscript-revision-basis-fixture'
export const inject = ['llm', 'tools', 'fs', 'subagents']

function* call(name, args, id) {
  const value = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: ToolCallId(id), name, argumentsDelta: value }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: value } }
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
const selfReview = { action: 'continuity', task: '核对 final.md 的实际正文与本轮原始用户要求，保留所有未核实项。', documents: [{ role: 'current', path: 'final.md' }] }
const baselineReview = { action: 'continuity', task: '对照原稿和最终候选，核对本轮原始用户要求；原稿不是替换候选的来源。', documents: [
  { role: 'current', path: 'original.md' }, { role: 'candidate', path: 'final.md' },
] }
function steps(state) {
  const declare = { action: 'delivery', delivery_mode: 'reviewed', candidate_paths: ['final.md'] }
  return mode === 'revision' ? [
    { id: 'self-only-review', name: 'manuscript_revision', args: selfReview },
    { id: 'self-only-reviewed-denied', name: 'manuscript_revision', args: declare, error: 'MANUSCRIPT_DELIVERY_BASELINE_REQUIRED' },
    { id: 'explicit-baseline-review', name: 'manuscript_revision', args: baselineReview },
    { id: 'baseline-reviewed', name: 'manuscript_revision', args: declare },
    { id: 'baseline-present', name: 'present', args: () => ({ files: [{ path: 'final.md', description: state.declaration.files[0].label }] }) },
  ] : [
    { id: 'creation-self-review', name: 'manuscript_revision', args: selfReview },
    { id: 'creation-reviewed', name: 'manuscript_revision', args: declare },
    { id: 'creation-present', name: 'present', args: () => ({ files: [{ path: 'final.md', description: state.declaration.files[0].label }] }) },
  ]
}
class SourceReviewAdapter extends LlmAdapter {
  constructor(state) { super(); this.state = state }
  async *stream(options) {
    const state = this.state
    if (options.sessionId !== state.parent.id) {
      yield* call('structured_output', { status: 'consistent', findings: [], unknowns: [] }, `source-review-result-${state.children.size}`)
      return
    }
    if (mode === 'revision' && !state.continued) { yield* stop('会先对照原稿与修订稿，检查事件顺序和需要保留的新增对白。'); return }
    const list = steps(state), step = list[state.results.length]
    if (step) yield* call(step.name, typeof step.args === 'function' ? step.args() : step.args, step.id)
    else yield* stop('实际审校结果与交付标签已按本轮任务使用；固定回复仅验证管道。')
  }
}
export async function apply(ctx) {
  await ctx.plugin(editing)
  await ctx.plugin(present, { maxFiles: 4 })
  await ctx.plugin(revisions, { continuityMaxOutputTokens: 4096 })
  const state = { parent: undefined, children: new Map(), originalUser: undefined, continuations: [],
    continued: false, continuationQueued: false, results: [], declaration: undefined, presented: 0, parentRequests: 0 }
  ctx.effect(() => {
    const original = globalThis.fetch
    globalThis.fetch = async () => { throw Error('Source review fixture refuses all network access') }
    return () => { globalThis.fetch = original }
  })
  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.header.parentSession !== undefined) { state.children.set(agent.id, { requests: 0, payload: undefined }); return }
    assert.equal(state.parent, undefined)
    state.parent = agent
    await writeFile(join(agent.session.header.cwd, 'original.md'), current)
    await writeFile(join(agent.session.header.cwd, 'final.md'), final)
  })
  ctx.on('session/event', (session, event) => {
    if (session !== state.parent?.session) return
    if (event.type === 'deliverables/presented') state.presented++
    if (event.type === 'user/message' && event.data.source.kind === 'user') {
      const text = event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      if (!state.originalUser) state.originalUser = { message_id: event.data.id, text }
      else { assert.equal(text, '继续'); state.continued = true; state.continuations.push({ message_id: event.data.id, text }) }
    }
  })
  ctx.on('llm/stream', async function* (options, next) {
    if (options.purpose !== undefined || options.provider !== PROVIDER) { yield* next(); return }
    assert.equal(options.model, MODEL)
    if (options.sessionId === state.parent.id) {
      state.parentRequests++
      const result = options.messages.findLast(message => message.role === 'tool')
      if (result && result.toolCallId !== state.results.at(-1)?.id) {
        const step = steps(state)[state.results.length]
        assert.equal(result.toolCallId, step.id)
        const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
        assert.equal(result.isError, step.error !== undefined, `${step.id}: ${text}`)
        if (step.error) assert.ok(text.includes(step.error), text)
        if (!result.isError && step.name === 'manuscript_revision') {
          const value = JSON.parse(text)
          if (value.state === 'continuity') { assert.equal(value.status, 'consistent'); assert.equal(value.file_verification, 'verified') }
          if (value.state === 'delivery') state.declaration = value
        }
        state.results.push({ id: step.id, name: step.name, error: step.error ?? null })
      }
    } else {
      const child = state.children.get(options.sessionId); assert.ok(child)
      child.requests++
      assert.deepEqual((options.tools ?? []).map(tool => tool.name), ['structured_output'])
      assert.equal(options.maxTokens, 4096)
      const payload = options.messages.filter(message => message.role === 'user').flatMap(message => message.content)
        .filter(block => block.type === 'text').map(block => {
          try { return JSON.parse(block.text) } catch (error) { assert.ok(error instanceof SyntaxError); return null }
        }).find(value => value?.materials && value.target)
      assert.ok(payload)
      child.payload = payload
      const expectedRoles = mode === 'revision' && state.children.size === 2 ? ['current', 'candidate'] : ['current']
      assert.deepEqual(payload.materials.documents.map(document => document.role), expectedRoles)
      assert.equal(basename(payload.target.path), 'final.md')
      assert.equal(payload.target.file_sha256, sha(final))
      assert.equal(payload.target.role, expectedRoles.includes('candidate') ? 'candidate' : 'current')
      if (expectedRoles.includes('candidate')) assert.equal(payload.materials.documents[0].file_sha256, sha(current))
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (agent === state.parent && mode === 'revision' && !state.continuationQueued) {
      state.continuationQueued = true
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] }))
      return
    }
    if (agent !== state.parent || state.results.length !== steps(state).length) return
    assert.equal(state.presented, 1)
    assert.equal(state.children.size, mode === 'revision' ? 2 : 1)
    for (const child of state.children.values()) {
      assert.equal(child.requests, 1)
      assert.deepEqual(child.payload.user_request, state.originalUser)
      assert.deepEqual(child.payload.user_continuations ?? [], state.continuations)
    }
    assert.equal(await readFile(join(agent.session.header.cwd, 'original.md'), 'utf8'), current)
    assert.equal(await readFile(join(agent.session.header.cwd, 'final.md'), 'utf8'), final)
    await writeFile(join(agent.session.header.cwd, '_revision-basis-probe.json'), JSON.stringify({ mode, pipelineOnly: true,
      parentRequests: state.parentRequests, originalRequestRestored: true, continuations: state.continuations.map(message => message.text),
      results: state.results, reviewerRequests: [...state.children.values()].map(child => child.requests),
      reviewerRoles: [...state.children.values()].map(child => child.payload.materials.documents.map(document => document.role)),
      originalSha256: sha(current), finalSha256: sha(final), finalLabel: state.declaration.files[0].label,
      presented: state.presented, originalAndFinalUnchanged: true }, null, 2) + '\n')
  })
  if (!process.env.DSH_SNAPSHOT || process.env.DSH_SNAPSHOT === 'record') ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], new SourceReviewAdapter(state)))
}
