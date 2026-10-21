/** Real returned files and tool dispatch protect user revisions across a resumed refinement. */
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { Context } from '@deepseek-ai/cordis'
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
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
