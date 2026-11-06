/** Registered manuscript tools retain exact reading receipts and source-bound relationships across owner reloads. */
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import Llm, { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import * as RevisionPlugin from '../src/manuscript-revisions.ts'
import { Config } from '../src/manuscript-revisions.ts'
import * as Reading from '../src/manuscript-reading.ts'
import { manuscriptCharacterSchema } from '../src/manuscript-relationships.ts'
import { manuscriptTextHash } from '../src/manuscript-scenes.ts'
import { readAuditCollections, reportedRelationshipSchema, recheckRelationshipSchema, sourcePageContextSchema } from './manuscript-test-schemas.ts'

const roots: string[] = [], contexts: Context[] = []
const signal = new AbortController().signal
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const coverageSchema = z.object({ path: z.string(), sha256: z.string(), complete: z.boolean(),
  total_characters: z.number(), returned_characters: z.number(),
  missing: z.array(z.object({ start_line: z.number(), end_line: z.number(), start_column: z.number(), end_column: z.number() })) })
const pageSchema = z.object({ source_path: z.string(), source_sha256: z.string(),
  lines: z.array(z.object({ number: z.number(), text: z.string() })),
  continuation: z.object({ offset: z.number(), column: z.number() }).nullable(), reading_coverage: coverageSchema,
  source_contexts: sourcePageContextSchema.nullable() })
const auditSchema = z.object({ task_key: z.string(), mode: z.string(), sources: z.array(z.object({ path: z.string(), sha256: z.string() })),
  missing_files: z.array(z.string()), reading_coverage: z.array(coverageSchema),
  characters: z.array(manuscriptCharacterSchema), relationships: z.array(reportedRelationshipSchema),
  relationships_needing_recheck: z.array(recheckRelationshipSchema) })

async function fixture(text = '甲（小甲）与乙站在门口。\n甲：乙可能是我的爸爸。') {
  const root = await mkdtemp(join(tmpdir(), 'manuscript-reading-loader-')); roots.push(root)
  await writeFile(join(root, 'source.txt'), text, { flag: 'wx' })
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(Llm); await ctx.plugin(Sessions); await ctx.plugin(SessionProjections)
  await ctx.plugin(SystemPrompt); await ctx.plugin(Tools); await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter([textResponse('继续处理可用材料。')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('reading-integration'), { provider: 'mock', model: 'mock' }, { cwd: root })
  const config = Config({ sourceReadMaxLines: 2, sourceReadMaxLineCharacters: 4, sourceReadMaxBytes: 64 })
  let owner = await ctx.plugin(RevisionPlugin, config), serial = 0
  const call = (args: object) => ctx.tools.execute({ name: 'manuscript_work', arguments: args, agent,
    callId: ToolCallId(`manuscript-integration-${++serial}`), signal })
  const request = async (args: object): Promise<unknown> => {
    const result = await call(args)
    if (result.isError || typeof result.value !== 'string') throw Error(JSON.stringify(result.content))
    return JSON.parse(result.value)
  }
  const audit = () => readAuditCollections(request).then(value => auditSchema.parse(value))
  const bind = () => request({ action: 'bind', task_key: '人物与阅读', mode: 'edit', source_paths: ['source.txt'], candidate_paths: ['future.md'] })
  await bind()
  const reload = async () => {
    await owner.dispose()
    expect(ctx.tools.get('manuscript_work')).toBeUndefined()
    owner = await ctx.plugin(RevisionPlugin, config)
    expect(ctx.tools.get('manuscript_work')).toBeDefined()
  }
  const statePath = join(root, '.muse', 'manuscript-work', manuscriptTextHash(agent.id), 'state.json')
  return { root, ctx, agent, adapter, config, call, request, audit, bind, reload, statePath }
}

async function relationFixture() {
  const f = await fixture('第1集\n1-1 日 内 门口\n甲（小甲）与乙站在门口。\n甲：乙可能是我的爸爸。')
  const initial = await f.audit(), source = initial.sources[0]
  if (!source) throw Error('Expected bound source')
  const evidence = (line: number, quote: string) => ({ source_path: 'source.txt', source_sha256: source.sha256,
    start_line: line, end_line: line, quote })
  const roster = [
    { character_id: 'a', name: '甲', aliases: ['小甲'], evidence: [evidence(3, '甲（小甲）与乙站在门口。')] },
    { character_id: 'b', name: '乙', evidence: [evidence(3, '甲（小甲）与乙站在门口。')] },
  ]
  await f.request({ action: 'characters', characters: roster })
  const relationship = { relationship_id: 'father', subject_id: 'b', object_id: 'a', relation: '父亲', status: 'uncertain',
    scope: { episode: '1', scene_id: '1-1', story_time: '日', context: '甲的猜测，仍需对照后续原文。' },
    contextual_name: { term: '爸爸', speaker_id: 'a', target_id: 'b' }, evidence: [evidence(4, '甲：乙可能是我的爸爸。')] }
  await f.request({ action: 'relationship', relationship })
  return { ...f, source, evidence, roster, relationship }
}

it('paginates Unicode and CRLF through registered JSON dispatch before a candidate exists', async () => {
  const original = '甲'.repeat(13) + '😀\r\n乙其实是甲的父亲。\r\n结尾'
  const f = await fixture(original), seen: string[] = []
  let cursor: { offset: number; column: number } | null = null, hash: string | undefined
  let finalCoverage: z.infer<typeof coverageSchema> | undefined
  for (let count = 0; count < 32; count++) {
    const page = pageSchema.parse(await f.request({ action: 'read_source', source_path: 'source.txt',
      ...(cursor ? { ...cursor, source_sha256: hash } : {}) }))
    seen.push(...page.lines.map(row => row.text))
    finalCoverage = page.reading_coverage
    if (page.continuation === null) break
    expect(finalCoverage.complete).toBe(false)
    cursor = page.continuation; hash = page.source_sha256
  }
  expect(seen.join('')).toBe(original.replaceAll('\r\n', ''))
  expect(finalCoverage).toMatchObject({ complete: true, returned_characters: Array.from(original.replaceAll('\r\n', '\n')).length,
    missing: [] })
  expect((await f.audit()).missing_files).toEqual([join(f.root, 'future.md')])
  expect(await readFile(join(f.root, 'source.txt'), 'utf8')).toBe(original)
})

it('accepts character and relation quotes copied from CRLF source pages', async () => {
  const f = await fixture('甲乙\r\n甲：爸爸。')
  const first = pageSchema.parse(await f.request({ action: 'read_source', source_path: 'source.txt', limit: 1 }))
  const quote = first.lines[0]?.text
  if (!quote) throw Error('Expected source line')
  const evidence = { source_path: first.source_path, source_sha256: first.source_sha256, start_line: 1, end_line: 1, quote }
  await f.request({ action: 'characters', characters: [
    { character_id: 'a', name: '甲', evidence: [evidence] }, { character_id: 'b', name: '乙', evidence: [evidence] },
  ] })
  const second = pageSchema.parse(await f.request({ action: 'read_source', source_path: 'source.txt',
    source_sha256: first.source_sha256, offset: 2 }))
  expect(second.lines[0]?.text).toBe('甲：爸爸')
  const rest = pageSchema.parse(await f.request({ action: 'read_source', source_path: 'source.txt',
    source_sha256: first.source_sha256, ...second.continuation }))
  expect(rest.lines[0]?.text).toBe('。')
  const relation = { relationship_id: 'r', subject_id: 'b', object_id: 'a', relation: '父亲', status: 'uncertain',
    scope: { context: '甲的称呼，是否亲生仍待核实。' }, evidence: [{ ...evidence, start_line: 2, end_line: 2, quote: '甲：爸爸。' }] }
  expect(auditSchema.parse(await f.request({ action: 'relationship', relationship: relation })).relationships)
    .toMatchObject([{ subject_id: 'b', object_id: 'a', status: 'uncertain' }])
})

it('rejects unknown IDs, stale source hashes, false quotes and caller-asserted reading coverage through real dispatch', async () => {
  const f = await relationFixture()
  for (const relationship of [
    { ...f.relationship, subject_id: 'unknown' },
    { ...f.relationship, evidence: [f.evidence(4, '乙：我是你的父亲。')] },
    { ...f.relationship, evidence: [{ ...f.evidence(4, '甲：乙可能是我的爸爸。'), source_sha256: 'a'.repeat(64) }] },
  ]) {
    const result = await f.call({ action: 'relationship', relationship })
    expect(result.isError).toBe(true)
  }
  expect((await f.call({ action: 'read_source', source_path: 'source.txt', complete: true })).isError).toBe(true)
  const audit = await f.audit()
  expect(audit.reading_coverage[0]).toMatchObject({ complete: false, returned_characters: 0 })
  expect(audit.relationships).toHaveLength(1)
  expect(audit.relationships[0]?.evidence[0]?.quote).toBe('甲：乙可能是我的爸爸。')
})

it('restores persisted reading receipts and relationship direction after the plugin owner unloads', async () => {
  const f = await relationFixture()
  const page = pageSchema.parse(await f.request({ action: 'read_source', source_path: 'source.txt' }))
  await f.reload()
  const restored = await f.audit()
  expect(restored.reading_coverage[0]?.returned_characters).toBe(page.reading_coverage.returned_characters)
  expect(restored.relationships[0]).toMatchObject({ subject_id: 'b', object_id: 'a', relation: '父亲', status: 'uncertain' })
  expect(restored.relationships[0]?.source_contexts[0]).toMatchObject({ start_line: 4, end_line: 4,
    sections: [{ episode: '1', scene_id: '1-1', heading_line: 2, heading: '1-1 日 内 门口' }],
    time_basis: [{ kind: 'scene_heading', start_line: 2, end_line: 2, value: '日' }] })
  const resumed = pageSchema.parse(await f.request({ action: 'read_source', source_path: 'source.txt',
    source_sha256: page.source_sha256, ...page.continuation }))
  expect(resumed.reading_coverage.returned_characters).toBeGreaterThan(page.reading_coverage.returned_characters)
})

it('opens the original version-one task ledger without new fields or a fresh bind', async () => {
  const f = await fixture()
  const before = await f.audit()
  const legacySchema = z.object({ version: z.literal(1), task_key: z.string(), mode: z.string(),
    sources: z.array(z.unknown()), paths: z.array(z.string()), current: z.array(z.unknown()),
    events: z.array(z.unknown()), notified: z.string().optional() })
  const legacy = legacySchema.parse(JSON.parse(await readFile(f.statePath, 'utf8')))
  await writeFile(f.statePath, JSON.stringify(legacy))
  await f.reload()
  const restored = await f.audit()
  expect(restored.task_key).toBe(before.task_key)
  expect(restored.sources).toEqual(before.sources)
  expect(restored.characters).toEqual([])
  expect(restored.relationships).toEqual([])
  expect(restored.reading_coverage[0]).toMatchObject({ complete: false, returned_characters: 0 })
  expect(pageSchema.parse(await f.request({ action: 'read_source', source_path: 'source.txt' })).lines.length).toBeGreaterThan(0)
})

it('invalidates a relationship whose third-person contextual speaker leaves the authoritative roster', async () => {
  const f = await fixture('甲乙丙。\n丙：爸爸。')
  const source = (await f.audit()).sources[0]
  if (!source) throw Error('Expected source')
  const anchor = (line: number, quote: string) => ({ source_path: 'source.txt', source_sha256: source.sha256,
    start_line: line, end_line: line, quote })
  const characters = ['甲', '乙', '丙'].map((name, i) => ({ character_id: String(i), name, evidence: [anchor(1, '甲乙丙。')] }))
  await f.request({ action: 'characters', characters })
  await f.request({ action: 'relationship', relationship: { relationship_id: 'r', subject_id: '1', object_id: '0',
    relation: '父亲', status: 'uncertain', scope: { context: '丙称乙为爸爸，与甲的关系尚待核实。' },
    contextual_name: { term: '爸爸', speaker_id: '2', target_id: '1' }, evidence: [anchor(2, '丙：爸爸。')] } })
  await f.request({ action: 'characters', characters: characters.slice(0, 2) })
  const audit = await f.audit()
  expect(audit.relationships).toEqual([])
  expect(audit.relationships_needing_recheck).toHaveLength(1)
})

it('does not retain old-version coverage or role notes after the source changes on disk', async () => {
  const f = await relationFixture()
  await f.request({ action: 'read_source', source_path: 'source.txt' })
  await writeFile(join(f.root, 'source.txt'), '甲乙另行离开。\n两人身份仍待核实。')
  const audit = await f.audit()
  expect(audit.reading_coverage[0]).toMatchObject({ complete: false, returned_characters: 0 })
  expect(audit.characters).toEqual([])
  expect(audit.relationships).toEqual([])
  expect(audit.relationships_needing_recheck).toHaveLength(1)
  expect((await f.call({ action: 'characters', characters: f.roster })).isError).toBe(true)
})

it('rejects a source changed between page creation and the second file read without recording its page', async () => {
  const f = await fixture('甲'.repeat(40)), originalRead = Reading.readManuscriptPage
  const spy = vi.spyOn(Reading, 'readManuscriptPage').mockImplementation(async (...args) => {
    const page = await originalRead(...args)
    await writeFile(join(f.root, 'source.txt'), '乙'.repeat(40))
    return page
  })
  const result = await f.call({ action: 'read_source', source_path: 'source.txt' })
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('MANUSCRIPT_READ_STALE')
  spy.mockRestore()
  expect((await f.audit()).reading_coverage[0]).toMatchObject({ complete: false, returned_characters: 0 })
})

it('keeps an ordinary model request usable when an optional bound source is no longer readable', async () => {
  const f = await fixture()
  await rm(join(f.root, 'source.txt'))
  const idle = new Promise<void>((resolve) => {
    const dispose = f.ctx.on('agent/status', ({ agent, status }) => {
      if (agent === f.agent && status === 'idle') { dispose(); resolve() }
    })
  })
  f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '先继续处理仍可用的资料。' }] }))
  await idle
  expect(f.adapter.requests).toHaveLength(1)
  expect(JSON.stringify(f.adapter.requests[0]?.messages)).toContain('不代表剧情检查通过')
  expect(f.agent.session.snapshotEvents().some(event => event.type === 'assistant/message')).toBe(true)
})
