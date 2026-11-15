/** Independent Loader controls for delivery intent, shell writes and Session/turn isolation. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { importSnapshotModule, importSnapshotPackage } from '../../../../../snapshots/session/muse-fixture-import.mjs'
import { manuscriptDocx } from './docx.mjs'

const owner = new URL('../../../package.json', import.meta.url)
const { LlmAdapter, ToolCallId, createUserMessage } = await importSnapshotPackage('@deepseek-ai/dsh-llm', owner)
const { SessionId } = await importSnapshotPackage('@deepseek-ai/dsh-session', owner)
const revisions = await importSnapshotModule(new URL('../../../src/manuscript-revisions.ts', import.meta.url),
  new URL('../../../lib/manuscript-revisions.js', import.meta.url))
const editingPolicy = await importSnapshotModule(new URL('../../../src/editing-policy.ts', import.meta.url),
  new URL('../../../lib/editing-policy.js', import.meta.url))
const toolPresent = await importSnapshotModule(new URL('../../../../../packages/deliverables/tool-present/src/index.ts', import.meta.url),
  new URL('../../../../../packages/deliverables/tool-present/lib/index.js', import.meta.url))
const accepted = await readFile(new URL('../manuscript-continuity/accepted.md', import.meta.url), 'utf8')
const faulty = await readFile(new URL('../manuscript-continuity/case-a.md', import.meta.url), 'utf8')
const words = { accepted: manuscriptDocx(accepted), faulty: manuscriptDocx(faulty) }
const PROVIDER = 'manuscript-delivery-controls-fixture'
const MODEL = 'selected-creative-model'
const shellTool = process.platform === 'win32' ? 'pwsh' : 'bash'
const mode = process.env.MUSE_DELIVERY_CONTROL
const modes = ['report', 'translation', 'format', 'mixed', 'shell', 'session-isolation', 'cancel-followup', 'new-input']
assert.ok(modes.includes(mode), `Unknown delivery control ${mode}`)

/** Installed only inside the shipped headless control process. */
export const name = 'manuscript-delivery-controls-fixture'
/** The actual Agent registry supplies independent Sessions and actual cancellation. */
export const inject = ['llm', 'tools', 'fs', 'agents']

function* call(name, args, id) {
  const text = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: ToolCallId(id), name, argumentsDelta: text }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: text } }
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

function* stop() {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: '本次离线交付对照已完成。' }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: '本次离线交付对照已完成。' } }
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

function user(text) { return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }) }
function text(message) { return message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') }
function label(root, id) { return root.values.get(id).files[0].label }
function present(path, description) { return { files: [{ path, ...description === undefined ? {} : { description } }] } }
function declare(path, note = '草稿：尚未进行最终剧情复核。') {
  return { action: 'delivery', candidate_paths: [path], delivery_mode: 'draft', note }
}

function pythonWord(bytes) {
  const payload = Buffer.from(bytes).toString('base64')
  const python = process.platform === 'win32' ? 'python' : 'python3'
  return { command: `${python} -c "import base64; from pathlib import Path; Path('shell.docx').write_bytes(base64.b64decode('${payload}'))"`,
    description: 'Write the actual Word file through Python, outside filesystem tool hooks' }
}

function actions(root) {
  if (root.kind === 'isolated') return [
    { id: 'isolated-without-declaration', name: 'present', args: present('final.docx'), error: 'MANUSCRIPT_DELIVERY_REQUIRED' },
    { id: 'isolated-declare', name: 'manuscript_revision', args: declare('final.docx') },
    { id: 'isolated-present', name: 'present', args: () => present('final.docx', label(root, 'isolated-declare')) },
  ]
  if (['report', 'translation', 'format'].includes(mode)) return [{ id: 'ordinary-present', name: 'present', args: present('final.docx', '按本次普通文档任务交付。') }]
  if (mode === 'mixed') return [
    { id: 'mixed-without-declaration', name: 'present', args: present('final.docx'), error: 'MANUSCRIPT_DELIVERY_REQUIRED' },
    { id: 'mixed-declare', name: 'manuscript_revision', args: declare('final.docx') },
    { id: 'mixed-present', name: 'present', args: () => present('final.docx', label(root, 'mixed-declare')) },
  ]
  if (mode === 'shell') return [
    { id: 'python-word', name: shellTool, args: pythonWord(words.accepted) },
    { id: 'python-without-history', name: 'present', args: present('shell.docx'), error: 'MANUSCRIPT_DELIVERY_REQUIRED' },
    { id: 'python-review', name: 'manuscript_revision', args: { action: 'continuity', task: '核对最终Word真实正文，保持实际读取范围。', documents: [
      { role: 'current', path: 'current.md' }, { role: 'candidate', path: 'shell.docx' },
    ] } },
    { id: 'python-reviewed', name: 'manuscript_revision', args: { action: 'delivery', candidate_paths: ['shell.docx'], delivery_mode: 'reviewed' } },
    { id: 'python-present', name: 'present', args: () => present('shell.docx', label(root, 'python-reviewed')) },
    { id: 'python-rewrite', name: shellTool, args: pythonWord(words.faulty) },
    { id: 'python-stale', name: 'present', args: () => present('shell.docx', label(root, 'python-reviewed')), error: 'MANUSCRIPT_DELIVERY_STALE' },
    { id: 'python-draft', name: 'manuscript_revision', args: declare('shell.docx', '草稿：最终Word已重写，旧核验不适用。') },
    { id: 'python-draft-present', name: 'present', args: () => present('shell.docx', label(root, 'python-draft')) },
  ]
  if (mode === 'session-isolation') return [
    { id: 'parent-declare', name: 'manuscript_revision', args: declare('final.docx') },
    { id: 'parent-present', name: 'present', args: () => present('final.docx', label(root, 'parent-declare')) },
  ]
  if (mode === 'cancel-followup') return [
    { id: 'before-cancel-write', name: 'write', args: { file_path: 'final.md', content: accepted } },
    { id: 'before-cancel-declare', name: 'manuscript_revision', args: declare('final.md') },
    { id: 'after-cancel-present', name: 'present', args: present('final.md', '新任务只做格式转换。') },
  ]
  return [
    { id: 'before-new-input-write', name: 'write', args: { file_path: 'final.md', content: accepted } },
    { id: 'after-new-input-present', name: 'present', args: present('final.md', '新请求只做格式转换。') },
  ]
}

class ControlsAdapter extends LlmAdapter {
  constructor(ctx, state) { super(); this.ctx = ctx; this.state = state }
  async *stream(options) {
    const state = this.state
    const root = state.roots.get(options.sessionId)
    if (root === undefined) {
      const child = state.children.get(options.sessionId)
      assert.ok(child)
      child.requests++
      assert.deepEqual((options.tools ?? []).map(tool => tool.name), ['structured_output'])
      const materialMessage = options.messages.filter(message => message.role === 'user').flatMap(message => message.content)
        .filter(block => block.type === 'text').map(block => {
          try { return JSON.parse(block.text) } catch (error) { assert.ok(error instanceof SyntaxError); return null }
        }).find(value => value?.materials && value.target)
      assert.ok(materialMessage)
      assert.equal(materialMessage.target.path.endsWith(`${sep}shell.docx`), true)
      yield* call('structured_output', { status: 'consistent', findings: [], unknowns: [] }, 'python-structured-result')
      return
    }
    root.requests++
    const last = options.messages.findLast(message => message.role === 'tool')
    const list = actions(root)
    if (last && last.toolCallId !== root.results.at(-1)?.id) {
      const step = list[root.results.length]
      assert.equal(last.toolCallId, step.id)
      assert.equal(last.isError, step.error !== undefined, `${step.id}: ${text(last)}`)
      if (step.error !== undefined) assert.ok(text(last).includes(step.error), text(last))
      if (!last.isError && step.name === 'manuscript_revision') root.values.set(step.id, JSON.parse(text(last)))
      root.results.push({ id: step.id, name: step.name, error: step.error ?? null })
    }
    if (mode === 'session-isolation' && root.kind === 'parent' && root.results.length === 1 && !state.isolated) {
      state.isolated = true
      const handle = await this.ctx.agents.create({ sessionId: SessionId('manuscript-delivery-isolated-root'),
        meta: { cwd: root.agent.session.header.cwd }, agentOptions: { provider: PROVIDER, model: MODEL } })
      try {
        handle.agent.followup(user('请把这份新写的四集短剧最终稿交给我，保持剧情衔接。'))
        await handle.agent.whenIdle()
        assert.equal(state.roots.get(handle.agent.id).results.length, 3)
      } finally { await handle.dispose() }
    }
    if (mode === 'cancel-followup' && root.results.length === 2 && !state.cancelled) {
      state.cancelled = true
      root.agent.cancel({ kind: 'user' })
      root.agent.followup(user('现在仅把已经存在的稿件做格式转换，不新增、改写或调整剧情。'))
      assert.ok(options.signal)
      options.signal.throwIfAborted()
    }
    if (mode === 'new-input' && root.results.length === 1 && !state.steered) {
      state.steered = true
      root.agent.steer(user('现在仅做格式转换，请保持全部正文逐字不变。'))
      yield* stop()
      return
    }
    const step = list[root.results.length]
    if (step === undefined) yield* stop()
    else yield* call(step.name, typeof step.args === 'function' ? step.args() : step.args, step.id)
  }
}

/** @param {import('@deepseek-ai/cordis').Context} ctx - Shipped headless composition. */
export async function apply(ctx) {
  await ctx.plugin(editingPolicy)
  await ctx.plugin(toolPresent, { maxFiles: 8 })
  await ctx.plugin(revisions, { continuityMaxOutputTokens: 4096 })
  const state = { parent: undefined, roots: new Map(), children: new Map(), notices: [], isolated: false, cancelled: false, steered: false }
  ctx.effect(() => {
    const original = globalThis.fetch
    globalThis.fetch = async () => { throw Error('Manuscript delivery controls refuse network access') }
    return () => { globalThis.fetch = original }
  })
  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.header.parentSession !== undefined) { state.children.set(agent.id, { requests: 0 }); return }
    const kind = state.parent === undefined ? 'parent' : 'isolated'
    state.roots.set(agent.id, { agent, kind, requests: 0, results: [], values: new Map(), turns: [], presented: 0 })
    if (kind !== 'parent') return
    state.parent = agent
    await writeFile(join(agent.session.header.cwd, 'current.md'), accepted)
    const document = mode === 'report' ? '季度采购报告\n本季共收到三份采购报价，下一步等待审批。\n' : accepted
    await writeFile(join(agent.session.header.cwd, 'final.docx'), manuscriptDocx(document))
  })
  ctx.on('session/event', (session, event) => {
    const root = state.roots.get(session.id)
    if (root === undefined) return
    if (event.type === 'deliverables/presented') root.presented++
    if (event.type === 'turn/end') root.turns.push(event.data.reason.kind)
    if (event.type === 'user/message' && event.data.source.kind === 'muse-manuscript'
      && event.data.source.summary === '剧本文件尚无有效交付回执') state.notices.push(event.data.source)
  })
  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    if (agent !== state.parent || signal.aborted) return
    const root = state.roots.get(agent.id)
    if (root.results.length !== actions(root).length) return
    assert.equal(state.notices.length, 0, 'No delivery reminder may leak across an excluded request, cancellation or independent Session')
    assert.equal(state.children.size, mode === 'shell' ? 1 : 0)
    if (mode === 'shell') {
      assert.deepEqual(await readFile(join(agent.session.header.cwd, 'shell.docx')), Buffer.from(words.faulty))
      assert.deepEqual([...state.children.values()].map(child => child.requests), [1])
    }
    if (mode === 'session-isolation') assert.equal(state.roots.size, 2)
    if (mode === 'cancel-followup') { assert.equal(state.cancelled, true); assert.ok(root.turns.includes('aborted')) }
    if (mode === 'new-input') assert.equal(state.steered, true)
    await writeFile(join(agent.session.header.cwd, '_controls-probe.json'), JSON.stringify({ mode, noLeakedReminder: true,
      rootResults: [...state.roots.values()].map(item => ({ kind: item.kind, results: item.results, presented: item.presented })),
      reviewerRequests: [...state.children.values()].map(child => child.requests),
      cancelledThenFollowedUp: state.cancelled, newHumanInput: state.steered }, null, 2) + '\n')
  })
  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], new ControlsAdapter(ctx, state)))
}
