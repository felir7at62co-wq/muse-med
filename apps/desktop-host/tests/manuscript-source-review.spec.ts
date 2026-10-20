/** Exact source materials and revision hints stay in the calling author session. */
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import Llm, { createUserMessage, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import LocalFs from '@deepseek-ai/dsh-fs-local'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import { MockAdapter, textResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import * as Review from '../src/manuscript-source-review.ts'

const roots: string[] = [], contexts: Context[] = []
const signal = new AbortController().signal
const source = '母亲把借书证交给姐姐。\n我把杯子放在窗台。\n她或许知道这件事。'
const draft = '▲姐姐把借书证攥在手里。\n▲妹妹从母亲手里接过借书证。\n旁白：她知道这件事。'
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture(options: Partial<Review.Config> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'muse-current-source-')); roots.push(root)
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(Llm); await ctx.plugin(Sessions); await ctx.plugin(SessionProjections)
  await ctx.plugin(SystemPrompt); await ctx.plugin(Tools); await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] }); await ctx.plugin(LocalFs, { cwd: root })
  const adapter = new MockAdapter([textResponse('收到。'), textResponse('继续。')], { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }] })
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('source-material-author'), {
    provider: 'mock', model: 'mock', reasoningEffort: ReasoningEffortId('high'), maxTokens: 12345,
  }, { cwd: root })
  await writeFile(join(root, 'source.txt'), source); await writeFile(join(root, 'draft.md'), draft)
  const config = Review.Config(options); const reviewFiber = await ctx.plugin(Review, config)
  const input = { source_paths: ['source.txt'], draft_paths: ['draft.md'], instructions: '保留原故事，修正交接。' }
  return { ctx, root, agent, adapter, config, input, reviewFiber,
    compare: () => Review.compareManuscriptSources(ctx, config, agent, input, signal) }
}

it('returns complete source/current text and actual passages without model calls, writes or approval', async () => {
  const f = await fixture(); const value = await f.compare()
  expect(Review.inject).toEqual(['tools', 'fs'])
  expect(value).toMatchObject({ advisory: true, semantic_review: 'not_performed_by_tool', scope: 'current_passages' })
  expect(value.sources[0]?.numbered_text).toBe('1: 母亲把借书证交给姐姐。\n2: 我把杯子放在窗台。\n3: 她或许知道这件事。')
  expect(value.changes[0]?.after).toBe(draft)
  expect(value).not.toHaveProperty('approval'); expect(value).not.toHaveProperty('child_session')
  expect(f.adapter.requests).toHaveLength(0)
  expect(await readFile(join(f.root, 'source.txt'), 'utf8')).toBe(source)
  expect(await readFile(join(f.root, 'draft.md'), 'utf8')).toBe(draft)
})
it('extracts verbatim source ranges and flags invalid ranges without inventing quotations', async () => {
  const f = await fixture(); const value = await Review.compareManuscriptSources(f.ctx, f.config, f.agent, { ...f.input,
    source_ranges: [{ document: 'S1', start_line: 1, end_line: 2 }, { document: 'X1', start_line: 1, end_line: 1 },
      { document: 'S1', start_line: 0, end_line: 1 }, { document: 'S1', start_line: 2, end_line: 1 },
      { document: 'S1', start_line: 1, end_line: 99 }] }, signal)
  expect(value.source_excerpts[0]).toMatchObject({ literal_match: true, quote: source.split('\n').slice(0, 2).join('\n') })
  expect(value.source_excerpts.slice(1).every(range => !range.literal_match && !('quote' in range))).toBe(true)
})
it('provides the full initial draft even with an identical explicitly supplied baseline', async () => {
  const f = await fixture(); await writeFile(join(f.root, 'before.md'), draft)
  const value = await Review.compareManuscriptSources(f.ctx, f.config, f.agent, { ...f.input, previous_draft_paths: ['before.md'] }, signal)
  expect(value.scope).toBe('current_passages'); expect(value.changes).toHaveLength(1)
  expect(value.revisions_since_requested_baseline).toEqual([])
})
it('reuses actual last-supplied draft versions without claiming they were reviewed', async () => {
  const f = await fixture(); await f.compare()
  await writeFile(join(f.root, 'draft.md'), draft.replace('她知道', '她或许知道'))
  const value = await f.compare()
  expect(value.scope).toBe('changed_passages')
  expect(value.changes).toMatchObject([{ line: 3, before: '旁白：她知道这件事。', after: '旁白：她或许知道这件事。' }])
  const same = await f.compare(); expect(same.changes).toEqual([])
  expect(same.semantic_review).toBe('not_performed_by_tool')
  expect(same.sources).toHaveLength(1); expect(same.drafts).toHaveLength(1)
})
it('resets incremental materials when source text or selected draft paths change', async () => {
  const f = await fixture(); await f.compare(); await writeFile(join(f.root, 'source.txt'), source + '\n新原句')
  expect((await f.compare()).scope).toBe('current_passages')
  await writeFile(join(f.root, 'other.md'), draft)
  expect((await Review.compareManuscriptSources(f.ctx, f.config, f.agent, { ...f.input, draft_paths: ['other.md'] }, signal)).scope).toBe('current_passages')
})
it('resets the supplied-version record for a new actual user request without adding model work', async () => {
  const f = await fixture(); await f.compare()
  f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '再核对人称。' }] }))
  await f.agent.whenIdle(); const count = f.adapter.requests.length
  expect((await f.compare()).scope).toBe('current_passages'); expect(f.adapter.requests).toHaveLength(count)
})
it('keeps author concerns and supplied baseline differences separate from source text', async () => {
  const f = await fixture(); await writeFile(join(f.root, 'before.md'), '改前'); await writeFile(join(f.root, 'notes.md'), '作者自述不是来源')
  const value = await Review.compareManuscriptSources(f.ctx, f.config, f.agent, { ...f.input,
    draft_paths: ['draft.md', 'notes.md'], previous_draft_paths: ['before.md', 'notes.md'] }, signal)
  expect(value.drafts.map(document => document.id)).toEqual(['D1', 'D2'])
  expect(value.author_notes).toBe(f.input.instructions)
  expect(value.revisions_since_requested_baseline[0]).toMatchObject({ before: '改前', after: draft })
  expect(value.revisions_since_requested_baseline[0]).not.toHaveProperty('id')
})
it('bounds paragraph indices while preserving CRLF text and complete draft context', async () => {
  const f = await fixture({ maxPassageLines: 2 }); await writeFile(join(f.root, 'draft.md'), '一\r\n二\r\n三\r\n\r\n四')
  const value = await f.compare()
  expect(value.changes.map(change => [change.line, change.after])).toEqual([[1, '一\r\n二\r'], [3, '三'], [5, '四']])
  expect(value.drafts[0]?.numbered_text).toContain('5: 四')
})
it('reports deletion-only revisions and empty manuscripts as factual material', async () => {
  const f = await fixture(); await f.compare(); await writeFile(join(f.root, 'draft.md'), '')
  const value = await f.compare(); expect(value.changes[0]).toMatchObject({ before: draft, after: '' })
  expect((await f.compare()).changes).toEqual([])
})
it('preserves whitespace text without inventing passages or author notes', async () => {
  const f = await fixture(); await writeFile(join(f.root, 'draft.md'), '   \n\n\t')
  const value = await Review.compareManuscriptSources(f.ctx, f.config, f.agent,
    { source_paths: ['source.txt'], draft_paths: ['draft.md'] }, signal)
  expect(value.changes).toEqual([]); expect(value.author_notes).toBe('')
  expect(value.drafts[0]?.numbered_text).toBe('1:    \n2: \n3: \t')
})
it('does not cache materials as current if a file changes during the read', async () => {
  const f = await fixture(); const original = f.ctx.fs.readText.bind(f.ctx.fs); let reads = 0
  vi.spyOn(f.ctx.fs, 'readText').mockImplementation(async (...args) => {
    const text = await original(...args); if (++reads === 2) await writeFile(join(f.root, 'draft.md'), '最新稿'); return text
  })
  expect((await f.compare()).inputs.find(document => document.kind === 'draft')?.unchanged_since_read).toBe(false)
  expect((await f.compare()).scope).toBe('current_passages')
})
it.each(['missing.txt', '.'])('reports unreadable input %s without affecting manuscript writes', async (path) => {
  const f = await fixture(); await expect(Review.compareManuscriptSources(f.ctx, f.config, f.agent, { ...f.input, source_paths: [path] }, signal)).rejects.toThrow('MANUSCRIPT_REVIEW_FILE')
})
it('checks known file bytes and actual read bytes before returning materials', async () => {
  const f = await fixture(); const config = Review.Config({ maxFileBytes: 10 })
  await expect(Review.compareManuscriptSources(f.ctx, config, f.agent, f.input, signal)).rejects.toThrow('MANUSCRIPT_REVIEW_FILE')
  vi.spyOn(f.ctx.fs, 'stat').mockResolvedValue({ type: 'file', version: FsVersion('grown'), size: 0 })
  await expect(Review.compareManuscriptSources(f.ctx, config, f.agent, f.input, signal)).rejects.toThrow('file grew')
})
it('requires a known regular file size', async () => {
  const f = await fixture(); vi.spyOn(f.ctx.fs, 'stat').mockResolvedValue({ type: 'file', version: FsVersion('unknown') })
  await expect(f.compare()).rejects.toThrow('MANUSCRIPT_REVIEW_FILE')
})
it('returns an explicit size error instead of silently truncating full documents or serialized materials', async () => {
  const f = await fixture()
  for (const maxInputChars of [10, 1000]) await expect(Review.compareManuscriptSources(f.ctx, Review.Config({ maxInputChars }), f.agent, f.input, signal)).rejects.toThrow('MANUSCRIPT_REVIEW_SIZE')
  expect((await f.compare()).scope).toBe('current_passages')
})
it('requires matching baseline counts and an explicit author workspace', async () => {
  const f = await fixture()
  await expect(Review.compareManuscriptSources(f.ctx, f.config, f.agent, { ...f.input, previous_draft_paths: [] }, signal)).rejects.toThrow('must correspond')
  const agent = await f.ctx.agentLoop.create(SessionId('no-workspace'), { provider: 'mock', model: 'mock' })
  await expect(Review.compareManuscriptSources(f.ctx, f.config, agent, f.input, signal)).rejects.toThrow('MANUSCRIPT_REVIEW_CWD')
})
it('rejects empty selections and agentless calls without changing the tool registry', async () => {
  const f = await fixture()
  for (const input of [{ source_paths: [], draft_paths: ['draft.md'] }, { source_paths: ['source.txt'], draft_paths: [] }]) {
    const value = await f.ctx.tools.execute({ name: 'manuscript_source_review', arguments: input, callId: ToolCallId('empty'), agent: f.agent, signal }); expect(value.isError).toBe(true)
  }
  const value = await f.ctx.tools.execute({ name: 'manuscript_source_review', arguments: f.input, callId: ToolCallId('agentless'), signal })
  expect(value.isError).toBe(true); expect(f.ctx.tools.get('manuscript_source_review')).toBeDefined()
})
it('logs serializable read-only materials through the ordinary calling tool', async () => {
  const f = await fixture(); const value = await f.ctx.tools.execute({ name: 'manuscript_source_review', arguments: f.input, callId: ToolCallId('materials'), agent: f.agent, signal })
  expect(value.isError).toBe(false); expect(JSON.stringify(value.content)).toContain('not_performed_by_tool')
  expect(f.ctx.tools.get('manuscript_source_review')?.presentCall?.(f.input)).toMatchObject({ title: 'Source comparison', kind: 'read' })
  expect(f.adapter.requests).toHaveLength(0)
})
it('cancels material reads and unregisters the tool when its owner unloads', async () => {
  const f = await fixture(); const controller = new AbortController(); controller.abort('cancel')
  await expect(Review.compareManuscriptSources(f.ctx, f.config, f.agent, f.input, controller.signal)).rejects.toBeDefined()
  await f.reviewFiber.dispose()
  expect(f.ctx.tools.get('manuscript_source_review')).toBeUndefined()
})

it('adds one factual source-comparison hint after saved text changes without running a review or blocking writes', async () => {
  const f = await fixture()
  f.ctx.tools.register(defineTool({ name: 'edit', description: 'Save test revision.', parameters: {},
    output: { schema: { type: 'object', properties: {}, additionalProperties: true }, render: () => [{ type: 'text', text: 'saved' }] },
    execute: async () => ({ path: 'episodes.md', before: '改前', after: '改后' }),
  }))
  const run = () => f.ctx.tools.execute({ name: 'edit', arguments: {}, callId: ToolCallId('edit-test'), agent: f.agent, signal })
  const first = await run(), second = await run()
  expect(first.isError).toBe(false)
  expect(first.content).toHaveLength(2)
  expect(JSON.stringify(first.content)).toContain('source_comparison_tool_for_saved_version')
  expect(second.content).toHaveLength(1)
  expect(f.adapter.requests).toHaveLength(0)
})

function registerEdit(ctx: Context, value: Record<string, string | null>) {
  ctx.tools.register(defineTool({ name: 'edit', description: 'Save a fixture edit.', parameters: {},
    output: { schema: { type: 'object', properties: {}, additionalProperties: true },
      render: () => [{ type: 'text', text: 'saved' }] }, execute: async () => value,
  }))
}

it.each([
  { path: 'code.ts', before: '一', after: '二' },
  { path: 'episodes.md', before: '相同', after: '相同' },
  { message: 'different output' },
])('leaves unrelated or unchanged mutation outcomes intact: %j', async (value) => {
  const f = await fixture(); registerEdit(f.ctx, value)
  const result = await f.ctx.tools.execute({ name: 'edit', arguments: {}, callId: ToolCallId('unrelated'), agent: f.agent, signal })
  expect(result.content).toHaveLength(1)
})

it('can disable saved-revision hints without removing the optional review tool', async () => {
  const f = await fixture({ revisionHints: false })
  registerEdit(f.ctx, { path: 'episodes.md', before: null, after: '创建' })
  const result = await f.ctx.tools.execute({ name: 'edit', arguments: {}, callId: ToolCallId('disabled-hints'), agent: f.agent, signal })
  expect(result.content).toHaveLength(1)
  expect(f.ctx.tools.get('manuscript_source_review')).toBeDefined()
})

it('renews a single revision hint on a new user request and preserves downstream policy content', async () => {
  const f = await fixture()
  registerEdit(f.ctx, { path: 'episodes.md', before: null, after: '创建' })
  f.ctx.on('tools/post-execute', async (_exec, _result, next) => {
    const decision = await next()
    return decision.kind === 'accept' ? { kind: 'accept', content: [{ type: 'text', text: 'downstream-content' }] } : decision
  })
  const run = () => f.ctx.tools.execute({ name: 'edit', arguments: {}, callId: ToolCallId('new-turn-hint'), agent: f.agent, signal })
  expect((await run()).content).toHaveLength(2)
  f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '继续修改。' }] }))
  await f.agent.whenIdle()
  const result = await run()
  expect(result.content[0]).toEqual({ type: 'text', text: 'downstream-content' })
  expect(result.content).toHaveLength(2)
})

it('does not replace failed saves, agentless outcomes or downstream value replacements with a hint', async () => {
  const f = await fixture()
  registerEdit(f.ctx, { path: 'episodes.md', before: null, after: '创建' })
  const agentless = await f.ctx.tools.execute({ name: 'edit', arguments: {}, callId: ToolCallId('agentless-save'), signal })
  expect(agentless.content).toHaveLength(1)
  f.ctx.on('tools/post-execute', async (_exec, _result, next) => {
    await next()
    return { kind: 'accept', value: { path: 'different.md', before: '', after: 'policy replacement' } }
  })
  const replaced = await f.ctx.tools.execute({ name: 'edit', arguments: {}, callId: ToolCallId('replaced'), agent: f.agent, signal })
  expect(JSON.stringify(replaced.content)).not.toContain('manuscript_revision')
  const failed = await f.ctx.tools.execute({ name: 'absent-tool', arguments: {}, callId: ToolCallId('failed-save'), agent: f.agent, signal })
  expect(failed.isError).toBe(true)
})

it('preserves sibling policy contexts when adding a revision status', async () => {
  const f = await fixture()
  registerEdit(f.ctx, { path: 'episodes.md', before: null, after: '创建' })
  const context = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'POLICY_CONTEXT' }] })
  f.ctx.on('tools/post-execute', async (_exec, _result, next) => {
    await next()
    return { kind: 'accept', additionalContexts: [context] }
  })
  const result = await f.ctx.tools.execute({ name: 'edit', arguments: {}, callId: ToolCallId('policy-context'), agent: f.agent, signal })
  expect(result.additionalContexts).toEqual([context])
  expect(result.content).toHaveLength(2)
})
