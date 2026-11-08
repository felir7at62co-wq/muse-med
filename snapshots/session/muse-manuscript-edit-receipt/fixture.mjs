/** English editing requests require a real declaration and recover from an unsupported file claim. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { importSnapshotModule, importSnapshotPackage } from '../muse-fixture-import.mjs'

const owner = new URL('../../../apps/desktop-host/package.json', import.meta.url)
const { LlmAdapter, ToolCallId } = await importSnapshotPackage('@deepseek-ai/dsh-llm', owner)
const hostLib = process.env.MUSE_MANUSCRIPT_HOST_LIB
if (hostLib !== undefined) assert.equal(process.env.DSH_EXAMPLE_MODE, 'lib', 'The owned artifact override requires the built lane')
const hostArtifact = name => hostLib === undefined ? new URL(`../../../apps/desktop-host/lib/${name}.js`, import.meta.url) : pathToFileURL(join(hostLib, `${name}.js`))
const revisions = await importSnapshotModule(new URL('../../../apps/desktop-host/src/manuscript-revisions.ts', import.meta.url), hostArtifact('manuscript-revisions'))
const policy = await importSnapshotModule(new URL('../../../apps/desktop-host/src/editing-policy.ts', import.meta.url), hostArtifact('editing-policy'))
const present = await importSnapshotModule(new URL('../../../packages/deliverables/tool-present/src/index.ts', import.meta.url), new URL('../../../packages/deliverables/tool-present/lib/index.js', import.meta.url))
const accepted = await readFile(new URL('../../../apps/desktop-host/tests/fixtures/manuscript-continuity/accepted.md', import.meta.url), 'utf8')
const hash = value => createHash('sha256').update(value).digest('hex')
const PROVIDER = 'manuscript-edit-receipt-fixture'
const MODEL = 'selected-creative-model'
const REQUEST = 'Edit the screenplay and give me a Word file.'
const CLAIM = 'The Word file is ready: [Download screenplay](sandbox:/download-fake.docx)'
const FINAL = 'The guard rejected the unreviewed file, then accepted the explicitly compared Markdown test file. This pipeline check does not exercise Word export.'

export const name = 'manuscript-edit-receipt-fixture'
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
    { id: 'undeclared-present', name: 'present', args: { files: [{ path: 'final.md', description: 'Edited screenplay' }] }, error: 'MANUSCRIPT_DELIVERY_REQUIRED' },
    { id: 'actual-write', name: 'write', args: { file_path: 'final.md', content: accepted } },
    { id: 'actual-readback', name: 'read', args: { file_path: 'final.md' } },
    { id: 'actual-review', name: 'manuscript_revision', args: { action: 'continuity', task: 'Compare the original with the actual final screenplay without changing either file.',
      documents: [{ role: 'current', path: 'current.md' }, { role: 'candidate', path: 'final.md' }] } },
    { id: 'actual-declare', name: 'manuscript_revision', args: { action: 'delivery', delivery_mode: 'reviewed', candidate_paths: ['final.md'] } },
    { id: 'actual-present', name: 'present', args: () => ({ files: [{ path: 'final.md', description: state.declaration.files[0].label }] }) },
  ]
}
class ReceiptAdapter extends LlmAdapter {
  constructor(state) { super(); this.state = state }
  async *stream(options) {
    const state = this.state
    if (options.sessionId !== state.parent.id) { yield* call('structured_output', { status: 'consistent', findings: [], unknowns: [] }, 'actual-review-result'); return }
    if (state.results.length === 1 && !state.claimObserved) { yield* stop(CLAIM); return }
    if (state.results.length > 0) assert.equal(state.noticeReceived, true)
    const step = steps(state)[state.results.length]
    if (step) yield* call(step.name, typeof step.args === 'function' ? step.args() : step.args, step.id)
    else yield* stop(FINAL)
  }
}

/** @param {import('@deepseek-ai/cordis').Context} ctx - Shipped Headless services and real manuscript plugins. */
export async function apply(ctx) {
  await ctx.plugin(policy)
  await ctx.plugin(present, { maxFiles: 8 })
  await ctx.plugin(revisions, { continuityMaxOutputTokens: 4096 })
  const state = { parent: undefined, child: undefined, originalUser: undefined, childRequests: 0, claimObserved: false,
    noticeReceived: false, noticeIds: new Set(), deniedSeq: undefined, noticeSeq: undefined, recoverySeq: undefined,
    results: [], declaration: undefined, presented: 0, reviewerRoles: [] }
  ctx.effect(() => {
    const original = globalThis.fetch
    globalThis.fetch = async () => { throw Error('Editing receipt fixture refuses network access') }
    return () => { globalThis.fetch = original }
  })
  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.header.parentSession !== undefined) { assert.equal(state.child, undefined); state.child = agent; return }
    assert.equal(state.parent, undefined)
    state.parent = agent
    await writeFile(join(agent.session.header.cwd, 'current.md'), accepted)
    await writeFile(join(agent.session.header.cwd, 'final.md'), accepted)
  })
  ctx.on('session/event', (session, event) => {
    if (session !== state.parent?.session) return
    if (event.type === 'user/message' && event.data.source.kind === 'user') {
      const text = event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      assert.equal(text, REQUEST)
      state.originalUser = { message_id: event.data.id, text }
    }
    if (event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'text' && block.text === CLAIM)) state.claimObserved = true
    if (event.type === 'tool/result' && event.data.message.toolCallId === 'undeclared-present') state.deniedSeq = event.seq
    if (event.type === 'tool/call' && event.data.callId === 'actual-write') state.recoverySeq = event.seq
    if (event.type === 'user/message' && event.data.source.kind === 'muse-manuscript' && event.data.source.summary === '剧本文件尚无有效交付回执') {
      assert.equal(state.claimObserved, true)
      assert.equal(state.presented, 0)
      state.noticeIds.add(event.data.id)
      state.noticeSeq = event.seq
      const packet = event.data.content.filter(block => block.type === 'text').map(block => {
        try { return JSON.parse(block.text) } catch (error) { assert.ok(error instanceof SyntaxError); return null }
      }).find(value => value?.manuscript_delivery_notice)?.manuscript_delivery_notice
      assert.equal(packet?.fingerprint, 'no_verified_screenplay_delivery')
      assert.equal(packet.attempt, 1)
      assert.ok(!event.data.content.some(block => block.type === 'text' && block.text.includes('download-fake.docx')))
    }
    if (event.type === 'deliverables/presented') state.presented++
  })
  ctx.on('llm/stream', async function* (options, next) {
    if (options.provider !== PROVIDER || options.purpose !== undefined) { yield* next(); return }
    assert.equal(options.model, MODEL)
    if (options.sessionId === state.parent.id) {
      if (options.messages.some(message => message.role === 'user' && state.noticeIds.has(message.id))) state.noticeReceived = true
      const last = options.messages.findLast(message => message.role === 'tool')
      if (last && last.toolCallId !== state.results.at(-1)?.id) {
        const step = steps(state)[state.results.length]
        assert.equal(last.toolCallId, step.id)
        const text = last.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
        assert.equal(last.isError, step.error !== undefined, `${step.id}: ${text}`)
        if (step.error) { assert.ok(text.includes(step.error), text); assert.equal(state.presented, 0) }
        if (step.id === 'actual-review') { const result = JSON.parse(text); assert.equal(result.status, 'consistent'); assert.equal(result.file_verification, 'verified') }
        if (step.id === 'actual-declare') {
          state.declaration = JSON.parse(text)
          assert.equal(state.declaration.files[0].file_sha256, hash(accepted))
          assert.equal(state.declaration.files[0].label, '已复核本文件全部提取正文（仅当前版本）')
        }
        state.results.push({ id: step.id, name: step.name, error: step.error ?? null })
      }
    } else {
      assert.equal(options.sessionId, state.child.id)
      state.childRequests++
      assert.deepEqual((options.tools ?? []).map(tool => tool.name), ['structured_output'])
      assert.equal(options.maxTokens, 4096)
      const payload = options.messages.filter(message => message.role === 'user').flatMap(message => message.content)
        .filter(block => block.type === 'text').map(block => {
          try { return JSON.parse(block.text) } catch (error) { assert.ok(error instanceof SyntaxError); return null }
        }).find(value => value?.materials && value.target)
      assert.ok(payload)
      assert.deepEqual(payload.user_request, state.originalUser)
      state.reviewerRoles = payload.materials.documents.map(document => document.role)
      assert.deepEqual(state.reviewerRoles, ['current', 'candidate'])
      for (const document of payload.materials.documents) assert.equal(document.file_sha256, hash(accepted))
      assert.equal(payload.target.file_sha256, hash(accepted))
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (agent !== state.parent || state.results.length < steps(state).length) return
    assert.equal(state.claimObserved, true)
    assert.equal(state.noticeIds.size, 1)
    assert.equal(state.noticeReceived, true)
    assert.equal(state.childRequests, 1)
    assert.equal(state.presented, 1)
    assert.ok(state.deniedSeq < state.noticeSeq && state.noticeSeq < state.recoverySeq)
    await assert.rejects(access(join(agent.session.header.cwd, 'download-fake.docx')), { code: 'ENOENT' })
    for (const file of ['current.md', 'final.md']) assert.equal(await readFile(join(agent.session.header.cwd, file), 'utf8'), accepted)
    await writeFile(join(agent.session.header.cwd, '_edit-receipt-probe.json'), JSON.stringify({ pipelineOnly: true, wordExportExercised: false,
      originalRequest: REQUEST, toolResults: state.results, loggedGenericNotices: state.noticeIds.size,
      noticeActuallyReceived: state.noticeReceived, reminderAfterDeniedPresentBeforeRecovery: true,
      reviewerRequests: state.childRequests, reviewerRoles: state.reviewerRoles, originalAndFinalUnchanged: true,
      finalSha256: hash(accepted), finalLabel: state.declaration.files[0].label, successfulPresentEvents: state.presented }, null, 2) + '\n')
  })
  if (!process.env.DSH_SNAPSHOT || process.env.DSH_SNAPSHOT === 'record') ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], new ReceiptAdapter(state)))
}
