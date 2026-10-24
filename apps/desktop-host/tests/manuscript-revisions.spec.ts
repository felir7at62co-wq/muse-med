/** Real returned files and tool dispatch protect user revisions across a resumed refinement. */
import { afterEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
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
import Tools from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import * as RevisionPlugin from '../src/manuscript-revisions.ts'
import { Config, ManuscriptRevisions } from '../src/manuscript-revisions.ts'
import { readManuscript } from '../src/manuscript-document.ts'
import { LocalFileSystem } from '../../../packages/fs/fs-local/src/index.ts'
import * as FsPolicy from '../../../packages/fs/fs-observation-policy/src/index.ts'
import * as ToolFs from '../../../packages/fs/tool-fs/src/index.ts'

const roots: string[] = [], contexts: Context[] = []
const signal = new AbortController().signal
const baseline = '第1集\n甲：我不相信你。\n乙：我们回家。\n▲她转身。'
const returned = '第1集\n甲：证据就在这里，别再骗我。\n▲她转身。\n乙：等我说完。'
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(script = [textResponse('收到。')]) {
  const root = await mkdtemp(join(tmpdir(), 'muse-manuscript-')); roots.push(root)
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(Llm); await ctx.plugin(Sessions); await ctx.plugin(SessionProjections)
  await ctx.plugin(SystemPrompt); await ctx.plugin(Tools); await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter(script); ctx.llm.registerAdapter(['mock'], adapter)
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

it('returns exact user changes and candidate differences without preventing delivery', async () => {
  const f = await fixture()
  const comparison = await f.compare()
  expect(comparison).toContain('甲：证据就在这里，别再骗我。')
  expect(comparison).toContain('乙：我们回家。')
  expect(comparison).not.toContain('先说明具体原文并取得')
  await writeFile(join(f.root, 'candidate.md'), baseline)
  const review = z.object({ advisory: z.boolean(), differences: z.array(z.unknown()) }).parse(JSON.parse(await f.revisions.request({ action: 'review', candidate_paths: ['candidate.md'] }, f.agent, signal)))
  expect(review.advisory).toBe(true)
  expect(review.differences.length).toBeGreaterThan(0)
  await expect(f.revisions.delivered(f.root, f.agent.id, ['candidate.md'], signal)).resolves.toBeUndefined()
  expect(await readFile(join(f.root, 'returned.md'), 'utf8')).toBe(returned)
})

it('reports a missing baseline without claiming an unchanged manuscript', async () => {
  const f = await fixture()
  await expect(f.revisions.request({ action: 'compare', revised_path: 'returned.md' }, f.agent, signal)).rejects.toThrow('MANUSCRIPT_BASELINE_REQUIRED')
})

it('restores actual external changes as logged context on an ordinary user message', async () => {
  const f = await fixture()
  await f.ctx.plugin(RevisionPlugin, f.config)
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
  const resumed = new ManuscriptRevisions(f.config)
  expect(await resumed.refresh(f.root, f.agent.id, signal)).toContain('修改者尚未确认')
})

it('uses an explicitly supplied next baseline and refreshes changed returned bytes', async () => {
  const f = await fixture()
  await f.compare()
  await writeFile(join(f.root, 'next.md'), returned)
  await writeFile(join(f.root, 'returned.md'), returned + '\n甲：新的修改。')
  expect(await f.revisions.request({ action: 'status' }, f.agent, signal)).toContain('甲：新的修改。')
  expect(await f.revisions.request({ action: 'compare', baseline_path: 'next.md', revised_path: 'returned.md' }, f.agent, signal)).toContain('甲：新的修改。')
})

it('keeps the user turn running when an optional returned file is no longer available', async () => {
  const f = await fixture()
  await f.compare()
  await f.ctx.plugin(RevisionPlugin, f.config)
  await rm(join(f.root, 'returned.md'))
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '继续。' }] })
  const result = await agentEvents(f.ctx, f.agent).waterfall('agent/pre-step', {
    messages: [message], turn: 1, step: 1, signal,
  }, async () => ({ kind: 'enter' as const, messages: [message] }))
  expect(result.kind).toBe('enter')
  if (result.kind === 'enter') expect(JSON.stringify(result.messages)).toContain('返稿差异未能读取')
})

const measuredSchema = z.object({
  state: z.literal('measured'), advisory: z.literal(true),
  source_files: z.array(z.object({ path: z.string(), sha256: z.string(), lettersAndNumbers: z.number() })),
  candidate_files: z.array(z.object({ path: z.string(), sha256: z.string(), lettersAndNumbers: z.number() })),
  source: z.object({ nonWhitespaceCharacters: z.number(), lettersAndNumbers: z.number() }),
  candidate: z.object({ nonWhitespaceCharacters: z.number(), lettersAndNumbers: z.number() }),
  difference: z.number(), ratio: z.number().nullable(), growthPercent: z.number().nullable(),
  maxGrowthPercent: z.number().optional(), assessment: z.string(), notice: z.string(),
})

it('measures corresponding complete Word, Markdown, and text files without a revision baseline or ledger', async () => {
  const f = await fixture()
  const source = docx('<w:document xmlns:w="urn:test"><w:body><w:p><w:r><w:t>甲：A𠮷2。</w:t></w:r></w:p></w:body></w:document>')
  await writeFile(join(f.root, 'source.docx'), source)
  await writeFile(join(f.root, 'source-2.txt'), '乙：去。')
  await writeFile(join(f.root, 'candidate.md'), '甲：A𠮷2。\n乙：去。\n▲停。')
  const result = measuredSchema.parse(JSON.parse(await f.revisions.request({ action: 'measure',
    source_paths: ['source.docx', 'source-2.txt'], candidate_paths: ['candidate.md'], max_growth_percent: 10 }, f.agent, signal)))
  expect(result.source.lettersAndNumbers).toBe(6)
  expect(result.candidate.lettersAndNumbers).toBe(7)
  expect(result.difference).toBe(1)
  expect(result.ratio).toBe(7 / 6)
  expect(result.assessment).toBe('above_requested_growth')
  expect(result.source_files[0]?.sha256).toBe(createHash('sha256').update(source).digest('hex'))
  expect(result.source_files[0]?.path).toBe(await realpath(join(f.root, 'source.docx')))
  expect(result.notice).toContain('不是精准净正文字数或Word字数')
  expect(result.notice).toContain('原始ASR通常只有对白')
  expect(await readFile(join(f.root, 'source.docx'))).toEqual(Buffer.from(source))
  await expect(readFile(join(f.root, '.muse/manuscript-revisions/ledger.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('keeps an existing returned-draft baseline unchanged while measuring different source files', async () => {
  const f = await fixture()
  await f.compare()
  const ledgerPath = join(f.root, '.muse/manuscript-revisions/ledger.json')
  const ledgerBefore = await readFile(ledgerPath, 'utf8')
  await writeFile(join(f.root, 'source.txt'), '字'.repeat(30_000))
  await writeFile(join(f.root, 'candidate.md'), '字'.repeat(80_000))
  const result = measuredSchema.parse(JSON.parse(await f.revisions.request({ action: 'measure',
    source_paths: ['source.txt'], candidate_paths: ['candidate.md'] }, f.agent, signal)))
  expect(result.source.lettersAndNumbers).toBe(30_000)
  expect(result.candidate.lettersAndNumbers).toBe(80_000)
  expect(result.difference).toBe(50_000)
  expect(result.maxGrowthPercent).toBeUndefined()
  expect(result.assessment).toBe('no_growth_limit')
  expect(await readFile(ledgerPath, 'utf8')).toBe(ledgerBefore)
})

it('reports an empty source without claiming the length target has been met', async () => {
  const f = await fixture()
  await writeFile(join(f.root, 'empty.txt'), '？！\n')
  const result = measuredSchema.parse(JSON.parse(await f.revisions.request({ action: 'measure',
    source_paths: ['empty.txt'], candidate_paths: ['returned.md'], max_growth_percent: 10 }, f.agent, signal)))
  expect(result.ratio).toBeNull()
  expect(result.growthPercent).toBeNull()
  expect(result.assessment).toBe('empty_source')
})

it('does not double-count canonical aliases or infer a source from the returned-draft ledger', async () => {
  const f = await fixture()
  await f.compare()
  await expect(f.revisions.request({ action: 'measure', candidate_paths: ['returned.md'] }, f.agent, signal))
    .rejects.toThrow('measure 需要 source_paths')
  await expect(f.revisions.request({ action: 'measure', source_paths: ['baseline.md', './baseline.md'],
    candidate_paths: ['returned.md'] }, f.agent, signal)).rejects.toThrow('MANUSCRIPT_DUPLICATE_PATH')
  await expect(f.revisions.request({ action: 'measure', source_paths: ['baseline.md'],
    candidate_paths: ['returned.md', './returned.md'] }, f.agent, signal)).rejects.toThrow('MANUSCRIPT_DUPLICATE_PATH')
})

it('bounds the number of requested files and validates an explicitly supplied tolerance', async () => {
  const f = await fixture()
  const limited = new ManuscriptRevisions(Config({ maxDocuments: 1 }))
  await expect(limited.request({ action: 'measure', source_paths: ['baseline.md'],
    candidate_paths: ['returned.md'] }, f.agent, signal)).rejects.toThrow('MANUSCRIPT_DOCUMENT_LIMIT')
  await expect(f.revisions.request({ action: 'measure', source_paths: ['baseline.md'],
    candidate_paths: ['returned.md'], max_growth_percent: -1 }, f.agent, signal)).rejects.toThrow()
})

it('makes a real scene read usable by the ordinary guarded edit tool without another full-file read', async () => {
  const f = await fixture()
  await f.ctx.plugin(LocalFileSystem, { cwd: f.root })
  await f.ctx.plugin(FsPolicy)
  await f.ctx.plugin(ToolFs)
  await f.ctx.plugin(RevisionPlugin, f.config)
  let serial = 0
  const call = (name: string, args: object) => f.ctx.tools.execute({ signal,
    callId: ToolCallId(`scene-observation-${++serial}`), name, arguments: args, agent: f.agent })
  expect((await call('edit', { file_path: 'returned.md', old_string: '乙：等我说完。', new_string: '乙：先听我说。' })).isError).toBe(true)
  expect((await call('manuscript_work', { action: 'bind', task_key: '返稿', mode: 'edit',
    source_paths: ['baseline.md'], candidate_paths: ['returned.md'] })).isError).toBe(false)
  expect((await call('manuscript_work', { action: 'scene', scene_id: 'file-1/1:body' })).isError).toBe(false)
  const result = await call('edit', { file_path: 'returned.md', old_string: '乙：等我说完。', new_string: '乙：先听我说。' })
  expect(result.isError).toBe(false)
  expect(await readFile(join(f.root, 'returned.md'), 'utf8')).toContain('乙：先听我说。')
})

it.each([
  ['忠实转写这集。', 'no_literal_user_text_found'],
  ['不合并台词。', 'literal_user_text_found'],
])('logs guidance attribution in the real tool result without denying the write: %s', async (request, basis) => {
  const f = await fixture([
    toolCallResponse('guide-write', 'write', { file_path: '写作规范.md', content: '不合并台词。' }),
    toolCallResponse('guide-read', 'read', { file_path: '写作规范.md' }),
    textResponse('继续处理正文。'),
  ])
  await f.ctx.plugin(LocalFileSystem, { cwd: f.root })
  await f.ctx.plugin(ToolFs)
  await f.ctx.plugin(RevisionPlugin, f.config)
  f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: request }] }))
  await f.agent.whenIdle()
  expect(await readFile(join(f.root, '写作规范.md'), 'utf8')).toBe('不合并台词。')
  const logged = f.agent.session.deriveMessages().filter(message => message.role === 'tool').map(message => JSON.stringify(message))
  expect(logged).toHaveLength(2)
  expect(logged[0]).toContain('current_model_tool_mutation')
  expect(logged[1]).toContain('document_read_authorship_unknown')
  expect(logged.join('')).toContain(basis)
  const lastRequest = JSON.stringify(f.adapter.requests.at(-1)?.messages)
  expect(lastRequest).toContain('manuscript_guidance')
  expect(lastRequest).toContain('不等于与用户冲突')
  expect(f.adapter.requests).toHaveLength(3)
})

it('does not repeat an unchanged guidance read advisory or inspect arbitrary manuscript prose as project rules', async () => {
  const f = await fixture()
  await f.ctx.plugin(LocalFileSystem, { cwd: f.root })
  await f.ctx.plugin(ToolFs)
  await f.ctx.plugin(RevisionPlugin, f.config)
  await writeFile(join(f.root, '写作规范.md'), '不合并台词。')
  await writeFile(join(f.root, '正文.md'), '甲：不合并台词。')
  let serial = 0
  const read = (path: string) => f.ctx.tools.execute({ signal, callId: ToolCallId(`guidance-read-${++serial}`),
    name: 'read', arguments: { file_path: path }, agent: f.agent })
  expect(JSON.stringify((await read('写作规范.md')).content)).toContain('manuscript_guidance')
  expect(JSON.stringify((await read('写作规范.md')).content)).not.toContain('manuscript_guidance')
  expect(JSON.stringify((await read('正文.md')).content)).not.toContain('manuscript_guidance')
})
