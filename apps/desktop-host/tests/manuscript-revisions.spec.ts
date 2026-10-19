/** Real returned files and tool dispatch protect user revisions across a resumed refinement. */
import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { Context } from '@deepseek-ai/cordis'
import Llm, { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import * as RevisionPlugin from '../src/manuscript-revisions.ts'
import { Config, ManuscriptRevisions } from '../src/manuscript-revisions.ts'
import { readManuscript } from '../src/manuscript-document.ts'

const roots: string[] = [], contexts: Context[] = []
const signal = new AbortController().signal
const baseline = '第1集\n甲：我不相信你。\n乙：我们回家。\n▲她转身。'
const returned = '第1集\n甲：证据就在这里，别再骗我。\n▲她转身。\n乙：等我说完。'
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'muse-manuscript-')); roots.push(root)
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(Llm); await ctx.plugin(Sessions); await ctx.plugin(SessionProjections)
  await ctx.plugin(SystemPrompt); await ctx.plugin(Tools); await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter([textResponse('收到。')]); ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('manuscript-test'), { provider: 'mock', model: 'mock' }, { cwd: root })
  await writeFile(join(root, 'baseline.md'), baseline); await writeFile(join(root, 'returned.md'), returned)
  const config = Config({}), revisions = new ManuscriptRevisions(config)
  const compare = () => revisions.request({ action: 'compare', baseline_path: 'baseline.md', revised_path: 'returned.md' }, agent, signal)
  return { root, ctx, agent, adapter, config, revisions, compare }
}

function docx(xml: string): Uint8Array {
  return zipSync({ 'word/document.xml': strToU8(xml) })
}

it('compares a real renamed Word return and retains exact text including table paragraphs and visible hyphens', async () => {
  const f = await fixture()
  const xml = '<w:document xmlns:w="urn:test"><w:body><w:p><w:r><w:t>甲：A</w:t><w:noBreakHyphen/><w:t>B&amp;C。</w:t></w:r></w:p>'
    + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格中的台词。</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'
  await writeFile(join(f.root, '用户返稿.docx'), docx(xml))
  const extracted = await readManuscript('用户返稿.docx', f.root, f.config, signal)
  expect(extracted.text).toBe('甲：A‑B&C。\n表格中的台词。')
  expect(extracted.sha256).toHaveLength(64)
  expect(await f.revisions.request({ action: 'compare', baseline_path: 'baseline.md', revised_path: '用户返稿.docx' }, f.agent, signal))
    .toContain('表格中的台词。')
})

it.each([
  ['<w:ins><w:r><w:t>尚未确认修订</w:t></w:r></w:ins>', 'TRACKED_CHANGES'],
  ['<w:p><w:r><w:txbxContent><w:p><w:r><w:t>浮动文本</w:t></w:r></w:p></w:txbxContent></w:r></w:p>', 'TEXTBOX'],
  ['<!DOCTYPE w:document [<!ENTITY example "X">]>', 'INVALID_DOCX'],
])('refuses ambiguous Word content instead of claiming complete comparison: %s', async (body, code) => {
  const f = await fixture()
  await writeFile(join(f.root, 'unsupported.docx'), docx(`<w:document xmlns:w="urn:test"><w:body>${body}</w:body></w:document>`))
  await expect(readManuscript('unsupported.docx', f.root, f.config, signal)).rejects.toThrow(code)
})

it('preserves user text and deletions while allowing refinement of untouched paragraphs', async () => {
  const f = await fixture(); const text = await f.compare()
  expect(text).toContain('甲：我不相信你。'); expect(text).toContain('甲：证据就在这里，别再骗我。')
  expect(text).toContain('乙：我们回家。'); expect(text).toContain('默认逐字保留')
  await writeFile(join(f.root, 'good.md'), returned.replace('▲她转身。', '▲她握紧证据，转身离开。'))
  const fresh = new ManuscriptRevisions(f.config)
  await expect(fresh.validate(f.root, f.agent.id, ['good.md'], signal)).resolves.toBeUndefined()
  await writeFile(join(f.root, 'bad.md'), baseline)
  await expect(fresh.validate(f.root, f.agent.id, ['bad.md'], signal)).rejects.toThrow('USER_EDIT_PROTECTED')
  await writeFile(join(f.root, 'bad.md'), returned + '\n乙：我们回家。')
  await expect(fresh.validate(f.root, f.agent.id, ['bad.md'], signal)).rejects.toThrow('deleted_paragraph_restored')
  expect(await readFile(join(f.root, 'returned.md'), 'utf8')).toBe(returned)
})

it('snapshots a delivered file before external edits and appends its actual diff on an ordinary human message', async () => {
  const f = await fixture()
  await ctxPlugin(f)
  await f.revisions.delivered(f.root, f.agent.id, ['baseline.md'], signal)
  await writeFile(join(f.root, 'baseline.md'), returned)
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '继续吧。' }] })
  const result = await agentEvents(f.ctx, f.agent).waterfall('agent/pre-step', {
    messages: [message], turn: 1, step: 1, signal,
  }, async () => ({ kind: 'enter' as const, messages: [message] }))
  expect(result.kind).toBe('enter')
  if (result.kind !== 'enter') throw Error('Expected admitted step')
  expect(result.messages.at(-1)?.source.kind).toBe('muse-manuscript')
  expect(JSON.stringify(result.messages.at(-1))).toContain('甲：证据就在这里，别再骗我。')
  await expect(f.revisions.validateWrite(f.root, f.agent.id, join(f.root, 'baseline.md'), signal)).rejects.toThrow('SOURCE_PROTECTED')
})

async function ctxPlugin(f: Awaited<ReturnType<typeof fixture>>) {
  await f.ctx.plugin(RevisionPlugin, f.config)
}

it('does not clear active protection by comparing a return to itself or using an unrelated baseline', async () => {
  const f = await fixture(); await f.compare()
  await f.revisions.delivered(f.root, f.agent.id, ['returned.md'], signal)
  const result = await f.revisions.request({ action: 'compare', baseline_path: 'returned.md', revised_path: 'returned.md' }, f.agent, signal)
  expect(result).toContain('甲：我不相信你。'); expect(result).toContain('甲：证据就在这里，别再骗我。')
  await writeFile(join(f.root, 'other.md'), returned)
  await expect(f.revisions.request({ action: 'compare', baseline_path: 'other.md', revised_path: 'returned.md' }, f.agent, signal)).rejects.toThrow('ACTIVE_COMPARISON')
  await writeFile(join(f.root, 'returned.md'), baseline)
  await expect(f.revisions.request({ action: 'compare', baseline_path: 'baseline.md', revised_path: 'returned.md' }, f.agent, signal)).rejects.toThrow('BASELINE_REQUIRED')
})

it('does not infer an absent baseline from a first import', async () => {
  const f = await fixture()
  await expect(f.revisions.request({ action: 'compare', revised_path: 'returned.md' }, f.agent, signal)).rejects.toThrow('BASELINE_REQUIRED')
})

it('does not adopt a model candidate as a new return that drops earlier user edits', async () => {
  const f = await fixture(); await f.compare()
  await writeFile(join(f.root, 'model-draft.md'), baseline + '\n无关新增。')
  await expect(f.revisions.request({ action: 'compare', baseline_path: 'baseline.md', revised_path: 'model-draft.md' }, f.agent, signal))
    .rejects.toThrow('USER_EDIT_PROTECTED')
})

it('requires a fresh comparison when the user return changes after the first comparison', async () => {
  const f = await fixture(); await f.compare()
  await writeFile(join(f.root, 'candidate.md'), returned)
  await writeFile(join(f.root, 'returned.md'), returned + '\n用户刚刚补的收尾。')
  await expect(f.revisions.validate(f.root, f.agent.id, ['candidate.md'], signal)).rejects.toThrow('RETURN_CHANGED')
  await expect(f.revisions.request({ action: 'review', candidate_paths: ['candidate.md'] }, f.agent, signal)).rejects.toThrow('RETURN_CHANGED')
  expect(await f.revisions.refresh(f.root, f.agent.id, signal)).toContain('用户刚刚补的收尾。')
  await expect(f.revisions.validate(f.root, f.agent.id, ['candidate.md'], signal)).rejects.toThrow('USER_EDIT_PROTECTED')
})

it('keeps automatic external-change discovery within the delivering session', async () => {
  const f = await fixture()
  await f.revisions.delivered(f.root, 'other-session', ['baseline.md'], signal)
  await writeFile(join(f.root, 'baseline.md'), returned)
  expect(await f.revisions.refresh(f.root, f.agent.id, signal)).toBeUndefined()
  expect(await f.revisions.refresh(f.root, 'other-session', signal)).toContain('修改者尚未确认')
})

it('does not extract an authorization substring from a negative human message', async () => {
  const f = await fixture(); const result = await f.compare()
  const parsed = JSON.parse(result.slice(result.indexOf('{'))) as { changes: Array<{ id: string; after: string[] }> }
  const change = parsed.changes.find(entry => entry.after.includes('甲：证据就在这里，别再骗我。'))
  if (!change) throw Error('Expected changed dialogue')
  const quote = '允许修改用户改稿：甲：证据就在这里，别再骗我。'
  f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '不要按这个授权：' + quote }] })); await f.agent.whenIdle()
  await expect(f.revisions.request({ action: 'authorize', change_id: change.id, authorization_quote: quote }, f.agent, signal))
    .rejects.toThrow('SCOPED_AUTHORIZATION')
})

it.each(['精修一下。', '不要修改甲：证据就在这里，别再骗我。', '允许修改用户改稿：甲：证据就在这里，别再骗我。'])
('requires a real, exact, scoped permission and refuses generic or negative intent: %s', async (quote) => {
  const f = await fixture(); const result = await f.compare()
  const parsed: unknown = JSON.parse(result.slice(result.indexOf('{')))
  const changeId = (parsed as { changes: Array<{ id: string; after: string[] }> }).changes.find(change => change.after.includes('甲：证据就在这里，别再骗我。'))?.id
  if (!changeId) throw Error('Expected changed dialogue')
  f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: quote }] })); await f.agent.whenIdle()
  const run = f.revisions.request({ action: 'authorize', change_id: changeId, authorization_quote: quote }, f.agent, signal)
  if (quote.startsWith('允许')) expect(await run).toContain('authorized_changes')
  else await expect(run).rejects.toThrow('SCOPED_AUTHORIZATION')
})

it('checks actual candidate bytes at export, GUI present and IM return instead of trusting an earlier review', async () => {
  const f = await fixture(); await ctxPlugin(f); await f.compare()
  for (const name of ['present', 'screenplay_export_docx', 'dsh_im_return_file']) {
    f.ctx.tools.register(defineTool({ name, description: 'Delivery test probe', parameters: {
      files: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' } } } },
      inputs: { type: 'array', items: { type: 'string' } }, path: { type: 'string' },
    }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: () => Promise.resolve('delivered') }))
  }
  await writeFile(join(f.root, 'candidate.md'), returned)
  expect(await f.revisions.request({ action: 'review', candidate_paths: ['candidate.md'] }, f.agent, signal)).toContain('passed')
  await writeFile(join(f.root, 'candidate.md'), baseline)
  for (const [name, args] of [
    ['present', { files: [{ path: 'candidate.md' }] }],
    ['screenplay_export_docx', { inputs: ['candidate.md'] }],
    ['dsh_im_return_file', { path: 'candidate.md' }],
  ] as const) {
    const result = await f.ctx.tools.execute({ name, arguments: args, callId: ToolCallId(name), agent: f.agent, signal })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('USER_EDIT_PROTECTED')
  }
})
