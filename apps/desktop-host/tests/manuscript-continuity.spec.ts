/** Grounded citations, real isolated review loops, bounded requests and awaited cancellation. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { createUserMessage, ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it, vi } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { continuityFilesUnchanged, installManuscriptContinuityPreset, ManuscriptContinuity,
  buildContinuityOutputSchema, CONTINUITY_OUTPUT_SCHEMA, CONTINUITY_REVIEW_PRESET,
  validateContinuityAssessment, type ContinuityAssessment, type ContinuityTarget,
  type ManuscriptContinuityConfig } from '../src/manuscript-continuity.ts'
import * as ReviewPreset from '../src/manuscript-continuity-preset.ts'
import * as Reader from '../src/manuscript-document.ts'
import { readManuscriptMaterials, type ManuscriptMaterialsDocument } from '../src/manuscript-materials.ts'

const contexts: Context[] = [], roots: string[] = []
const signal = new AbortController().signal
const config: ManuscriptContinuityConfig = { maxFileBytes: 65536, maxTextChars: 20000,
  maxDocuments: 8, maxMaterialChars: 40000, continuityMaxRequests: 3,
  continuityMaxOutputTokens: 4096, continuityTimeoutMs: 120000, continuityMaxFindings: 8, continuityMaxCorrections: 1 }
const text = '第1集\n1-1 门口 日 外\n▲甲尚未进门。\n第2集\n2-1 主卧 日 内\n▲甲已经拆开旧床。'

afterEach(async () => {
  vi.useRealTimers()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function materialFixture() {
  const root = await mkdtemp(join(tmpdir(), 'muse-continuity-')); roots.push(root)
  await writeFile(join(root, 'current.md'), text)
  const materials = await readManuscriptMaterials([{ role: 'current', path: 'current.md' }], root, config, signal)
  const current = materials.documents[0]!
  const target: ContinuityTarget = { role: current.role, path: current.path,
    file_sha256: current.file_sha256, text_sha256: current.text_sha256 }
  return { root, materials, current, target }
}

function issue(document: ManuscriptMaterialsDocument): ContinuityAssessment {
  return { status: 'issues', unknowns: [], findings: [{ category: 'character_state', description: '进门前后的人物位置缺少衔接。',
    evidence: [3, 6].map(line => ({ role: document.role, path: document.path,
      file_sha256: document.file_sha256, text_sha256: document.text_sha256,
      line, quote: document.lines.find(value => value.number === line)!.text })) }] }
}

function reasoningResponse(finish: 'stop' | 'max-tokens' = 'stop'): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'I have reviewed the supplied lines but have not submitted the tool result.' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Review analysis remains separate from the result.' } },
    { type: 'finish', reason: { kind: finish } }]
}

it('accepts two exact target locations and keeps the assessment limited to the supplied material', async () => {
  const { materials, current, target } = await materialFixture()
  expect(validateContinuityAssessment(issue(current), materials, target, 8)).toMatchObject({ status: 'issues', reason: 'reviewed' })
  expect(validateContinuityAssessment({ status: 'consistent', findings: [], unknowns: [] }, materials, target, 8))
    .toEqual({ status: 'consistent', findings: [], unknowns: [], reason: 'reviewed' })
})

it.each(['quote', 'line', 'file_sha256', 'text_sha256', 'role'] as const)('rejects the entire result when %s is fabricated', async (key) => {
  const { materials, current, target } = await materialFixture()
  const report = issue(current), evidence = report.findings[0]!.evidence[0]!
  if (key === 'line') evidence.line = 99
  else if (key === 'role') evidence.role = 'candidate'
  else if (key === 'quote') evidence.quote = '没有出现在原稿的描述。'
  else evidence[key] = '0'.repeat(64)
  expect(validateContinuityAssessment(report, materials, target, 8)).toMatchObject({ status: 'unknown', reason: 'invalid_evidence', findings: [] })
})

it('rejects duplicate anchors, missing target evidence, excess findings and inconsistent status', async () => {
  const { materials, current, target } = await materialFixture()
  const repeated = issue(current)
  repeated.findings[0]!.evidence[1] = repeated.findings[0]!.evidence[0]!
  expect(validateContinuityAssessment(repeated, materials, target, 8).reason).toBe('invalid_evidence')
  const unrelatedTarget = { ...target, role: 'candidate' as const, path: `${target.path}.candidate.md` }
  expect(validateContinuityAssessment(issue(current), materials, unrelatedTarget, 8).reason).toBe('invalid_evidence')
  expect(validateContinuityAssessment(issue(current), materials, target, 0).reason).toBe('invalid_result')
  expect(validateContinuityAssessment({ ...issue(current), status: 'consistent' }, materials, target, 8).status).toBe('unknown')
  expect(validateContinuityAssessment({ status: 'unknown', findings: [], unknowns: [] }, materials, target, 8).reason).toBe('invalid_result')
  expect(validateContinuityAssessment(undefined, materials, target, 8).reason).toBe('invalid_result')
})

it('does not accept a quote from an unread line and invalidates raw file changes after a receipt', async () => {
  const { root, materials, current, target } = await materialFixture()
  const partial = { ...materials, documents: [{ ...current, lines: current.lines.filter(line => line.number <= 3) }] }
  expect(validateContinuityAssessment(issue(current), partial, target, 8).reason).toBe('invalid_evidence')
  expect(await continuityFilesUnchanged(materials.documents, config, signal)).toBe(true)
  await writeFile(join(root, 'current.md'), text.replace('尚未', '已经'))
  expect(await continuityFilesUnchanged(materials.documents, config, signal)).toBe(false)
})

it('restricts the real tool schema to supplied identities without changing the static result vocabulary', async () => {
  const { materials, current } = await materialFixture()
  const wrong = issue(current)
  wrong.findings[0]!.evidence[0]!.role = 'reference'
  expect(validateJsonSchemaValue(CONTINUITY_OUTPUT_SCHEMA, wrong)).toEqual([])
  expect(validateJsonSchemaValue(buildContinuityOutputSchema(materials), wrong).length).toBeGreaterThan(0)
  expect(validateJsonSchemaValue(buildContinuityOutputSchema(materials), issue(current))).toEqual([])
  expect(validateJsonSchemaValue(CONTINUITY_OUTPUT_SCHEMA, wrong)).toEqual([])
})

it.each(['role', 'quote'] as const)('keeps strict Host %s checks when all three document roles are actually supplied', async (field) => {
  const { root } = await materialFixture()
  await writeFile(join(root, 'reference.md'), text)
  await writeFile(join(root, 'candidate.md'), text)
  const materials = await readManuscriptMaterials([
    { role: 'current', path: 'current.md' }, { role: 'reference', path: 'reference.md' }, { role: 'candidate', path: 'candidate.md' },
  ], root, config, signal)
  const candidate = materials.documents.find(document => document.role === 'candidate')!
  const report = issue(candidate), anchor = report.findings[0]!.evidence[0]!
  if (field === 'role') anchor.role = 'reference'
  else anchor.quote = '这句在对应行中不存在。'
  expect(validateJsonSchemaValue(buildContinuityOutputSchema(materials), report)).toEqual([])
  expect(validateContinuityAssessment(report, materials, candidate, 8))
    .toMatchObject({ status: 'unknown', reason: 'invalid_evidence', findings: [] })
})

async function runtime(script: ConstructorParameters<typeof MockAdapter>[0], overrides: Partial<ManuscriptContinuityConfig> = {}) {
  const fixture = await materialFixture(), ctx = new Context(); contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(fixture.root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.internal = { version: 'v2', loadCache: new Map(),
    register() { throw Error('Unexpected loader hooks') }, getOrCreateModuleJob() { throw Error('Unexpected loader job') },
    resolveSync() { throw Error('Unexpected loader resolution') }, load() { throw Error('Unexpected loader load') },
    async import(specifier: string) {
      if (specifier === new URL('../src/manuscript-continuity-preset.ts', import.meta.url).href) return ReviewPreset
      throw Error(`Unexpected review module ${specifier}`)
    } }
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Persistence, { root: join(fixture.root, 'sessions') })
  await ctx.plugin(Subagents)
  await ctx.plugin(Spawn)
  await ctx.plugin(AgentPresets, { default: 'editing-parent' })
  await ctx.agentPresets.register({ id: 'editing-parent', plugins: [] })
  const removePreset = await installManuscriptContinuityPreset(ctx, { ...config, ...overrides })
  const adapter = new MockAdapter([textResponse('Parent-only history.'), ...script], {
    efforts: [{ id: ReasoningEffortId('high'), name: 'High' }], defaultEffort: ReasoningEffortId('high'),
  })
  ctx.llm.registerAdapter(['mock'], adapter)
  const handle = await ctx.agents.create({ sessionId: SessionId('editing-parent'),
    meta: { cwd: fixture.root, agentPreset: 'editing-parent' }, agentOptions: { provider: 'mock', model: 'old-route' },
    setup: async (agentCtx) => {
      await ctx.agentPresets.mount(agentCtx, 'editing-parent')
      agentCtx.tools.restrict({ futureAllow: ['parent_tool'], includeOwn: true })
    } })
  const parent = handle.agent
  parent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '保持原有事实，检查事件先后。' }] }))
  await parent.whenIdle()
  parent.model.select({ provider: 'mock', model: 'selected-review-model', reasoningEffort: ReasoningEffortId('high') })
  const childSessions: Session[] = []
  ctx.on('session/created', (session) => { if (session.header.parentSession === parent.id) childSessions.push(session) })
  let service: ManuscriptContinuity | undefined
  const owner = await ctx.plugin(Object.assign((ownerCtx: Context) => {
    const instance = new ManuscriptContinuity(ownerCtx, { ...config, ...overrides })
    service = instance
    ownerCtx.effect(() => () => instance.dispose())
  }, { inject: ['agents', 'subagents'] }))
  if (service === undefined) throw Error('Review service did not initialize')
  return { ...fixture, ctx, parent, adapter, childSessions, service, owner, removePreset }
}

it('uses the newly selected model in a real isolated child and records its material prompt and structured result', async () => {
  let request: GenerateOptions | undefined
  const fixture = await runtime([(options) => {
    request = options
    return toolCallResponse('review-result', 'structured_output', { status: 'consistent', findings: [], unknowns: [] })
  }])
  const result = await fixture.service.review([{ role: 'current', path: 'current.md' }], '检查前后衔接', fixture.parent, signal)
  expect(request?.tools?.map(tool => tool.name)).toEqual(['structured_output'])
  const encoded = request?.messages.flatMap(message => message.role === 'user'
    ? message.content.flatMap(block => block.type === 'text' ? [block.text] : []) : []).join('\n')
  expect(encoded).toContain('保持原有事实，检查事件先后。')
  expect(encoded).not.toContain('Parent-only history.')
  expect(encoded).toContain('whose cited statements cannot both be true in the relevant time and circumstances')
  expect(encoded).toContain('An omitted routine action, an ordinary scene cut, or one location contained in another')
  expect(encoded).toContain('do not require extra scenes for ordinary transitions')
  expect(encoded).toContain('lie or deliberate concealment as an established narrated fact without supporting text')
  expect(encoded).toContain('Evaluate explicitly timed recollections in their own time')
  expect(encoded).toContain('Do not invent findings to cover every category; combine findings with the same underlying conflict')
  expect(encoded).toContain('Put substantive missing information in unknowns')
  expect(result).toMatchObject({ status: 'consistent', reason: 'reviewed', scope: 'returned_text_lines_only',
    file_verification: 'verified', reviewer: { requests: 1, selection: { provider: 'mock', model: 'selected-review-model', reasoningEffort: 'high' } } })
  const child = fixture.adapter.requests.filter(request => request.sessionId !== fixture.parent.id)
  expect(child).toHaveLength(1)
  expect(child[0]).toMatchObject({ model: 'selected-review-model', reasoningEffort: 'high', maxTokens: 4096 })
  const events = fixture.childSessions[0]!.snapshotEvents()
  expect(events.some(event => event.type === 'user/message' && JSON.stringify(event.data).includes(fixture.current.file_sha256))).toBe(true)
  expect(events.some(event => event.type === 'tool/call' && event.data.name === 'structured_output')).toBe(true)
  expect(fixture.ctx.agents.list().map(agent => agent.id)).toEqual([fixture.parent.id])
})

it('rejects reference as an identity in a current-only child through the actual structured tool', async () => {
  const fixture = await runtime([
    (options) => {
      const wrong = issue(current)
      wrong.findings[0]!.evidence[0]!.role = 'reference'
      const schema = options.tools!.find(tool => tool.name === 'structured_output')!.parameters
      expect(validateJsonSchemaValue(schema, wrong).length).toBeGreaterThan(0)
      return toolCallResponse('wrong-identity', 'structured_output', wrong)
    },
    () => {
      return toolCallResponse('corrected-identity', 'structured_output', issue(current))
    },
  ])
  const current = fixture.current
  const result = await fixture.service.review([{ role: 'current', path: 'current.md' }], '核对因果并原样引用材料身份', fixture.parent, signal)
  expect(result).toMatchObject({ status: 'issues', reason: 'reviewed', reviewer: { requests: 2 } })
  const results = fixture.childSessions[0]!.snapshotEvents().filter(event => event.type === 'tool/result')
  expect(results).toHaveLength(2)
  expect(results[0]?.data.message.isError).toBe(true)
  expect(results[1]?.data.message.isError ?? false).toBe(false)
})

it('refuses using the internal reviewer preset as an ordinary root conversation before any model request', async () => {
  const fixture = await runtime([])
  const handle = await fixture.ctx.agents.create({ sessionId: SessionId('invalid-review-entry'),
    meta: { cwd: fixture.root, agentPreset: CONTINUITY_REVIEW_PRESET },
    agentOptions: { provider: 'mock', model: 'selected-review-model' },
    setup: async (childCtx) => { await fixture.ctx.agentPresets.mount(childCtx, CONTINUITY_REVIEW_PRESET) } })
  handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Start a normal chat.' }] }))
  await handle.agent.whenIdle()
  expect(fixture.adapter.requests).toHaveLength(1)
  expect(JSON.stringify(handle.agent.session.snapshotEvents())).toContain('CONTINUITY_REVIEW_ONLY')
})

it('returns unknown when the child stops with prose instead of structured output', async () => {
  const fixture = await runtime([textResponse('Everything is fine, without a structured result.')], { continuityMaxCorrections: 0 })
  const result = await fixture.service.review([{ role: 'current', path: 'current.md' }], '检查', fixture.parent, signal)
  expect(result).toMatchObject({ status: 'unknown', reason: 'reviewer_failed', findings: [] })
})

it('distinguishes child setup failure from a semantic judgment without exposing exception contents', async () => {
  const fixture = await runtime([])
  await fixture.removePreset()
  const result = await fixture.service.review([{ role: 'current', path: 'current.md' }], '检查', fixture.parent, signal)
  expect(result).toMatchObject({ status: 'unknown', reason: 'setup_failed', reviewer: { requests: 0 } })
  expect(result.unknowns).toEqual(['Reviewer setup failed; application logs identify this child session and preset module.'])
  expect(fixture.adapter.requests).toHaveLength(1)
})

it.each(['reasoning', 'text'] as const)('requests one logged structured submission after a %s-only normal stop', async (kind) => {
  const first = kind === 'reasoning' ? reasoningResponse() : textResponse('The review is ready, without a tool submission.')
  const fixture = await runtime([first,
    toolCallResponse('submitted-after-notice', 'structured_output', { status: 'consistent', findings: [], unknowns: [] })])
  const result = await fixture.service.review([{ role: 'current', path: 'current.md' }], '检查', fixture.parent, signal)
  expect(result).toMatchObject({ status: 'consistent', reason: 'reviewed', reviewer: { requests: 2 } })
  expect(fixture.childSessions).toHaveLength(1)
  const notices = fixture.childSessions[0]!.snapshotEvents().filter(event => event.type === 'user/message'
    && event.data.source.kind === 'muse-manuscript')
  expect(notices).toHaveLength(1)
  expect(JSON.stringify(notices)).toContain('No structured result was submitted')
  const child = fixture.adapter.requests.filter(request => request.sessionId !== fixture.parent.id)
  expect(child.map(request => ({ model: request.model, effort: request.reasoningEffort, maxTokens: request.maxTokens })))
    .toEqual([{ model: 'selected-review-model', effort: 'high', maxTokens: 4096 },
      { model: 'selected-review-model', effort: 'high', maxTokens: 4096 }])
})

it('does not continue indefinitely when the one correction still has no structured submission', async () => {
  const fixture = await runtime([reasoningResponse(), textResponse('Still no structured submission.')])
  const result = await fixture.service.review([{ role: 'current', path: 'current.md' }], '检查', fixture.parent, signal)
  expect(result).toMatchObject({ status: 'unknown', reason: 'reviewer_failed', reviewer: { requests: 2 } })
  expect(fixture.adapter.requests).toHaveLength(3)
})

it('does not issue a normal-stop correction for an output-limited response', async () => {
  const fixture = await runtime([reasoningResponse('max-tokens')])
  const result = await fixture.service.review([{ role: 'current', path: 'current.md' }], '检查', fixture.parent, signal)
  expect(result.status).toBe('unknown')
  expect(result.reviewer.requests).toBe(1)
})

it('keeps the total request cap even when a normal-stop correction asks for another submission', async () => {
  const fixture = await runtime([reasoningResponse()], { continuityMaxRequests: 1 })
  const result = await fixture.service.review([{ role: 'current', path: 'current.md' }], '检查', fixture.parent, signal)
  expect(result).toMatchObject({ status: 'unknown', reason: 'budget', reviewer: { requests: 1 } })
  expect(fixture.adapter.requests).toHaveLength(2)
})

it('counts a failed tool call against the request cap and blocks the next model request', async () => {
  const fixture = await runtime([toolCallResponse('denied-write', 'write', { path: 'forbidden.md', content: 'bad' })], { continuityMaxRequests: 1 })
  const result = await fixture.service.review([{ role: 'current', path: 'current.md' }], '检查', fixture.parent, signal)
  expect(result).toMatchObject({ status: 'unknown', reason: 'budget', reviewer: { requests: 1 } })
  expect(fixture.adapter.requests).toHaveLength(2)
  await expect(readFile(join(fixture.root, 'forbidden.md'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('times out a pending child request and waits until the child is released', async () => {
  const fixture = await runtime(['hang'], { continuityTimeoutMs: 20 })
  const entered = Promise.withResolvers<undefined>()
  fixture.ctx.on('llm/stream', (options, next) => { if (options.sessionId !== fixture.parent.id) entered.resolve(undefined); return next() })
  vi.useFakeTimers()
  const reviewing = fixture.service.review([{ role: 'current', path: 'current.md' }], '检查', fixture.parent, signal)
  await entered.promise
  await vi.advanceTimersByTimeAsync(20)
  const result = await reviewing
  expect(result).toMatchObject({ status: 'unknown', reason: 'timeout', reviewer: { requests: 1 } })
  expect(fixture.ctx.agents.list().map(agent => agent.id)).toEqual([fixture.parent.id])
})

it('propagates user cancellation after releasing the child rather than returning an unknown success', async () => {
  const fixture = await runtime(['hang']), controller = new AbortController()
  const entered = Promise.withResolvers<undefined>()
  fixture.ctx.on('llm/stream', (options, next) => { if (options.sessionId !== fixture.parent.id) entered.resolve(undefined); return next() })
  const reviewing = fixture.service.review([{ role: 'current', path: 'current.md' }], '检查', fixture.parent, controller.signal)
  const rejected = expect(reviewing).rejects.toThrow('User cancelled review')
  await entered.promise
  controller.abort(Error('User cancelled review'))
  await rejected
  expect(fixture.ctx.agents.list().map(agent => agent.id)).toEqual([fixture.parent.id])
})

it('drains an active review before its owning plugin finishes unloading and stops new admission', async () => {
  const fixture = await runtime(['hang'])
  const entered = Promise.withResolvers<undefined>()
  fixture.ctx.on('llm/stream', (options, next) => { if (options.sessionId !== fixture.parent.id) entered.resolve(undefined); return next() })
  const reviewing = fixture.service.review([{ role: 'current', path: 'current.md' }], '检查', fixture.parent, signal)
  const rejected = expect(reviewing).rejects.toMatchObject({ code: 'CONTINUITY_OWNER_DISPOSED' })
  await entered.promise
  await fixture.owner.dispose()
  await rejected
  expect(fixture.ctx.agents.list().map(agent => agent.id)).toEqual([fixture.parent.id])
  expect(fixture.adapter.requests).toHaveLength(2)
  await expect(fixture.service.review([{ role: 'current', path: 'missing.md' }], '检查', fixture.parent, signal))
    .rejects.toMatchObject({ code: 'CONTINUITY_OWNER_DISPOSED' })
  expect(fixture.adapter.requests).toHaveLength(2)
})

it.each([1, 3])('owns extraction and final file verification while read number %s overlaps plugin unload', async (readNumber) => {
  const fixture = await runtime([toolCallResponse('review-result', 'structured_output', { status: 'consistent', findings: [], unknowns: [] })])
  const paused = Promise.withResolvers<AbortSignal>(), release = Promise.withResolvers<undefined>()
  const read = Reader.readManuscript
  let reads = 0
  vi.spyOn(Reader, 'readManuscript').mockImplementation(async (...args) => {
    if (++reads === readNumber) { paused.resolve(args[3]); await release.promise }
    return read(...args)
  })
  const reviewing = fixture.service.review([{ role: 'current', path: 'current.md' }], '检查', fixture.parent, signal)
  const rejected = expect(reviewing).rejects.toMatchObject({ code: 'CONTINUITY_OWNER_DISPOSED' })
  const readingSignal = await paused.promise
  const aborted = readingSignal.aborted ? Promise.resolve() : new Promise<void>((resolve) => {
    readingSignal.addEventListener('abort', () => { resolve() }, { once: true })
  })
  const closing = fixture.owner.dispose()
  try { await aborted }
  finally { release.resolve(undefined) }
  await closing
  await rejected
  expect(fixture.ctx.agents.list().map(agent => agent.id)).toEqual([fixture.parent.id])
  expect(fixture.adapter.requests).toHaveLength(readNumber === 1 ? 1 : 2)
})

it('keeps denying requests if a faulty child disposal rejects while the child remains resident', async () => {
  const fixture = await runtime(['hang'], { continuityTimeoutMs: 20 })
  const start = fixture.ctx.subagents.startActivation.bind(fixture.ctx.subagents)
  let release: (() => Promise<void>) | undefined
  const starting = vi.spyOn(fixture.ctx.subagents, 'startActivation').mockImplementation(async (spec) => {
    // Model a backend that ignores cancellation and then fails its disposal obligation.
    const activation = await start({ ...spec, signal: new AbortController().signal })
    release = () => activation.dispose()
    if (activation.messageId === undefined) throw Error('Expected a local child inbox receipt')
    return { ...activation, messageId: activation.messageId, dispose: () => Promise.reject(Error('Injected disposal failure')) }
  })
  const entered = Promise.withResolvers<undefined>()
  fixture.ctx.on('llm/stream', (options, next) => { if (options.sessionId !== fixture.parent.id) entered.resolve(undefined); return next() })
  vi.useFakeTimers()
  try {
    const reviewing = fixture.service.review([{ role: 'current', path: 'current.md' }], '检查', fixture.parent, signal)
    await entered.promise
    await vi.advanceTimersByTimeAsync(20)
    const result = await reviewing
    expect(result).toMatchObject({ status: 'unknown', reason: 'cleanup_failed' })
    expect(fixture.ctx.agents.get(result.reviewer.session_id!)).toBeDefined()
    const originalRequest = fixture.adapter.requests[1]!
    await expect(async () => {
      for await (const _chunk of fixture.ctx.llm.stream({ ...originalRequest, signal: new AbortController().signal })) {
        throw Error('Stopped child must not reach the adapter')
      }
    }).rejects.toThrow('no longer active')
    expect(fixture.adapter.requests).toHaveLength(2)
  } finally {
    starting.mockRestore()
    await release?.()
  }
})
