/** Current-version screenplay declarations, actual dispatch receipts, recovery and owner teardown. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, unsupportedModel, createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createToolResultMessage, createUserMessage, ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as Present from '@deepseek-ai/dsh-tool-present'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createManuscriptDelivery, hasManuscriptDeliveryStructure, manuscriptDeliveryIntent, manuscriptDeliveryMetadata,
  type ManuscriptDelivery } from '../src/manuscript-delivery.ts'
import { readManuscriptMaterials } from '../src/manuscript-materials.ts'
import * as Reader from '../src/manuscript-document.ts'

const cleanups: (() => Promise<unknown>)[] = []
const signal = new AbortController().signal
const config = { maxDocuments: 4, maxFileBytes: 65536, maxTextChars: 20000, maxMaterialChars: 20000,
  continuityDeliveryChecks: true, continuityMaxDeliveryCorrections: 1 }
const body = '第1集\n1-1 门口 日 外\n▲甲来到门口。\n甲：请开门。\n第2集\n2-1 客厅 日 内\n▲甲坐下。\n甲：谢谢。\n第3集\n3-1 院子 日 外\n▲甲离开。'
let serial = 0

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

function human(session: Session, text: string) {
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
}
function logResult(session: Session, name: string, args: object, value: object) {
  const id = ToolCallId(`delivery-unit-${++serial}`)
  session.append('tool/call', { turn: 1, step: serial, callId: id, name, arguments: JSON.stringify(args) })
  return session.append('tool/result', { turn: 1, step: serial,
    message: createToolResultMessage({ callId: id, content: [{ type: 'text', text: JSON.stringify(value) }], isError: false }) }, { surfaceOp: 'append' })
}
async function runtime(seed?: { session: Session; root: string }) {
  const root = seed?.root ?? await mkdtemp(join(tmpdir(), 'muse-delivery-unit-'))
  if (seed === undefined) {
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    await writeFile(join(root, 'final.md'), body)
  }
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(Present, { maxFiles: 4 })
  const id = SessionId(`delivery-owner-${++serial}`)
  const session = seed === undefined ? Session.create(id, [], { id, version: SESSION_FORMAT_VERSION, createdAt: 0,
    cwd: root, isSeeded: false }) : Session.create(seed.session.id, seed.session.snapshotEvents(), seed.session.header)
  const injected: UserMessage[] = []
  let scope!: Scope
  const agent: Agent = { id: session.id, session, options: {}, model: unsupportedModel(), inbox: createInboxStub(), status: 'idle',
    get ctx() { return scope.ctx }, send() {}, followup() {}, steer: () => ({ outcome: Promise.resolve({ status: 'rejected' }) }),
    inject(message) { injected.push(message); session.append('user/message', message, { surfaceOp: 'append' }) },
    cancel() {}, runMaintenance: task => task(signal), whenIdle: () => Promise.resolve() }
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, { inject: ['tools'] }))
  await ctx.agents.register(agent)
  let service!: ManuscriptDelivery
  const owner = await ctx.plugin(Object.assign(async (inner: Context) => { service = await createManuscriptDelivery(inner, config) }, { inject: ['tools', 'sessionProjections'] }))
  if (seed === undefined) {
    session.append('turn/start', { turn: 1 })
    human(session, '重写三集短剧剧本，交付最终文件。')
  }
  async function declare(mode: 'reviewed' | 'draft', paths = ['final.md'], note?: string) {
    const result = await service.declare(paths, mode, note, agent, signal)
    logResult(session, 'manuscript_revision', { action: 'delivery', candidate_paths: paths, delivery_mode: mode }, result)
    return result
  }
  async function review(status: 'consistent' | 'issues' | 'unknown', lines?: { start: number; end: number }, referenceVersion?: string) {
    const materials = await readManuscriptMaterials([{ role: 'current', path: 'final.md', ...(lines === undefined ? {} : { lines }) }], root, config, signal)
    const target = materials.documents[0]!
    if (referenceVersion !== undefined) materials.documents.push({ ...target, role: 'reference', path: join(root, 'reference.md'), file_sha256: referenceVersion })
    const value = { state: 'continuity', advisory: true, scope: 'returned_text_lines_only', status, reason: 'reviewed',
      target: { role: target.role, path: target.path, file_sha256: target.file_sha256, text_sha256: target.text_sha256 },
      documents: materials.documents.map(({ lines: _lines, unchanged_since_read: _unchanged, ...document }) => document),
      findings: status === 'issues' ? [{ category: 'transition', description: 'Fixture conflict',
        evidence: target.lines.slice(0, 2).map(line => ({ role: target.role, path: target.path, file_sha256: target.file_sha256,
          text_sha256: target.text_sha256, line: line.number, quote: line.text })) }] : [],
      unknowns: status === 'unknown' ? ['Missing facts'] : [], file_verification: 'verified', reviewer: { session_id: null, selection: null, requests: 1 } }
    return logResult(session, 'manuscript_revision', { action: 'continuity' }, value)
  }
  async function present(description?: string, path = 'final.md') {
    const id = ToolCallId(`present-unit-${++serial}`), args = { files: [{ path, ...(description === undefined ? {} : { description }) }] }
    session.append('tool/call', { turn: 1, step: serial, callId: id, name: 'present', arguments: JSON.stringify(args) })
    const result = await executeModelToolFixture(ctx, { callId: id, name: 'present', arguments: args, agent, signal })
    session.append('tool/result', { turn: 1, step: serial,
      message: createToolResultMessage({ callId: id, content: result.content, isError: result.isError }) }, { surfaceOp: 'append' })
    return result
  }
  return { root, ctx, owner, service, agent, session, injected, declare, review, present }
}

it.each([
  ['仅把已有四集剧本转换为 Word，正文逐字不变，不创作或修订剧情。', false],
  ['翻译剧本对白，不新增/改写剧情。', false],
  ['把这份剧本翻译成英文并生成 Word，不修改剧情', false],
  ['不改稿，只讨论结构。', false],
  ['不要改稿，只把剧本排版并生成Word', false],
  ['给剧本做格式转换，不做改稿', false],
  ['修订剧本后导出Word', true],
  ['重写剧本第2集，并翻译对白和导出Word，保留剧情衔接。', true],
  ['Write a Python script and save the report.', false],
])('classifies the human task without reading manuscript instructions: %s', (text, writing) => {
  expect(manuscriptDeliveryIntent(text).writing).toBe(writing)
})

it('requires actual scene and dramatic structure together', () => {
  expect(hasManuscriptDeliveryStructure(body)).toBe(true)
  expect(hasManuscriptDeliveryStructure('# 剧本报告\n第1集\n市场：稳步增长')).toBe(false)
})

it('blocks unreviewed direct present, accepts explicit draft and rejects a stale same-path declaration', async () => {
  const f = await runtime()
  expect(await f.present()).toMatchObject({ isError: true, error: { info: { code: 'MANUSCRIPT_DELIVERY_REQUIRED' } } })
  await expect(f.declare('draft')).rejects.toThrow('草稿交付必须说明')
  const declaration = await f.declare('draft', ['final.md'], '剧情尚未复核。')
  expect(await f.present()).toMatchObject({ isError: true, error: { info: { code: 'MANUSCRIPT_DELIVERY_LABEL_REQUIRED' } } })
  expect((await f.present(declaration.files[0]!.label)).isError).toBe(false)
  await writeFile(join(f.root, 'final.md'), body + '\n甲：稍等。')
  expect(await f.present(declaration.files[0]!.label)).toMatchObject({ isError: true, error: { info: { code: 'MANUSCRIPT_DELIVERY_STALE' } } })
})

it('requires fresh review dependencies and canonical uniqueness before declaring reviewed delivery', async () => {
  const f = await runtime()
  await expect(f.declare('reviewed')).rejects.toThrow('MANUSCRIPT_DELIVERY_REVIEW_REQUIRED')
  await f.review('consistent')
  const declaration = await f.declare('reviewed')
  expect(declaration.files[0]!.label).toBe('已复核本文件全部提取正文（仅当前版本）')
  expect((await f.present(declaration.files[0]!.label)).isError).toBe(false)
  await expect(f.declare('draft', ['final.md', './final.md'], '未复核')).rejects.toThrow('同一规范路径')
  await expect(f.declare('draft', Array.from({ length: 5 }, () => 'final.md'), '未复核')).rejects.toThrow('分批交付')
})

it.each(['issues', 'unknown'] as const)('does not clear earlier %s with an unrelated partial consistent review', async (status) => {
  const f = await runtime()
  await f.review(status, { start: 1, end: 4 })
  await f.review('consistent', { start: 5, end: 8 })
  await expect(f.declare('reviewed')).rejects.toThrow('MANUSCRIPT_DELIVERY_REVIEW_REQUIRED')
  await f.review('consistent', { start: 1, end: 4 })
  const result = await f.declare('reviewed')
  expect(result.files[0]!.label).toBe('已复核正文第1–4行（仅此范围）')
})

it('recovers valid reviewed receipts by replay and ignores a truncated compaction replacement', async () => {
  const f = await runtime()
  const original = await f.review('consistent')
  f.session.append('tool/result', { ...original.data, message: { ...original.data.message, content: [{ type: 'text', text: '[compacted]' }] } },
    { surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq }, sourceEventSeqs: [original.seq] })
  const recovered = await runtime({ session: f.session, root: f.root })
  expect((await recovered.declare('reviewed')).files[0]!.file_sha256).toBe((await f.declare('reviewed')).files[0]!.file_sha256)
  expect((await recovered.present((await recovered.declare('reviewed')).files[0]!.label)).isError).toBe(false)
})

it('joins the actual presented event before the logged result and does not remind after success', async () => {
  const f = await runtime()
  logResult(f.session, 'write', { file_path: 'final.md' }, {})
  const result = await f.declare('draft', ['final.md'], '未复核')
  expect((await f.present(result.files[0]!.label)).isError).toBe(false)
  await f.service.remind(f.agent, signal)
  expect(f.injected).toHaveLength(0)
})

it('logs a bounded reminder, gives new human input priority and clears an unrelated task', async () => {
  const f = await runtime()
  logResult(f.session, 'write', { file_path: 'final.md' }, {})
  const newer = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '仅转换文件，不改写剧情。' }] })
  f.agent.inbox.append('next-step', newer)
  await f.service.remind(f.agent, signal)
  expect(f.injected).toHaveLength(0)
  f.agent.inbox.clear()
  await f.service.remind(f.agent, signal)
  await f.service.remind(f.agent, signal)
  expect(f.injected).toHaveLength(1)
  expect(f.injected[0]!.source).toMatchObject({ kind: 'muse-manuscript', form: 'notice' })
  human(f.session, '仅把已有剧本转换为Word，不创作或修订剧情。')
  expect((await f.present()).isError).toBe(false)
})

it('drains an in-flight read on owner unload and refuses new operations', async () => {
  const f = await runtime()
  let entered!: () => void
  const reading = new Promise<void>((resolveEntered) => { entered = resolveEntered })
  vi.spyOn(Reader, 'readManuscript').mockImplementation(async (_path, _cwd, _limits, readSignal) => {
    entered()
    await new Promise<void>((_resolve, reject) => {
      readSignal.addEventListener('abort', () => { reject(new Error('Manuscript delivery owner was disposed')) }, { once: true })
    })
    throw Error('unreachable')
  })
  const request = f.service.declare(['final.md'], 'draft', '未复核', f.agent, signal)
  const rejected = expect(request).rejects.toThrow('owner was disposed')
  await reading
  await f.owner.dispose()
  await rejected
  await expect(f.service.declare(['final.md'], 'draft', '未复核', f.agent, signal)).rejects.toThrow('owner was disposed')
})

it('does not reuse another Session declaration in the same working directory', async () => {
  const f = await runtime()
  await f.declare('draft', ['final.md'], '未复核')
  const id = SessionId(`delivery-independent-${++serial}`)
  const session = Session.create(id, [], { ...f.session.header, id })
  const independent = await runtime({ session, root: f.root })
  independent.session.append('turn/start', { turn: 1 })
  human(independent.session, '重写三集短剧剧本，交付最终文件。')
  expect(await independent.present()).toMatchObject({ isError: true, error: { info: { code: 'MANUSCRIPT_DELIVERY_REQUIRED' } } })
})


it('bounds unresolved reference versions conservatively until the target bytes change', async () => {
  const f = await runtime()
  for (let index = 1; index <= 12; index++) await f.review('unknown', undefined, index.toString(16).padStart(64, '0'))
  expect(f.ctx.sessionProjections.checkpoint(f.session)['muse.manuscript-delivery']?.val)
    .toMatchObject({ rows: [{ unresolved_overflow: true }] })
  const checkpoint = z.object({ rows: z.array(z.object({ unresolved: z.array(z.unknown()) })) })
    .parse(f.ctx.sessionProjections.checkpoint(f.session)['muse.manuscript-delivery']?.val)
  expect(checkpoint.rows[0]!.unresolved.length).toBeLessThanOrEqual(config.maxDocuments)
  await f.review('consistent')
  await expect(f.declare('reviewed')).rejects.toThrow('MANUSCRIPT_DELIVERY_REVIEW_REQUIRED')
  expect((await f.declare('draft', ['final.md'], '审校历史超过当前可合并范围，尚未核实。')).mode).toBe('draft')
  await writeFile(join(f.root, 'final.md'), body + '\n甲：再见。')
  await f.review('consistent')
  expect((await f.declare('reviewed')).mode).toBe('reviewed')
})

it('restores its checkpoint suffix with delivery completion and reminder counts unchanged', async () => {
  const f = await runtime()
  logResult(f.session, 'write', { file_path: 'final.md' }, {})
  await f.service.remind(f.agent, signal)
  const checkpoint = f.ctx.sessionProjections.checkpoint(f.session)
  const base = f.session.snapshotEvents().length
  const declared = await f.declare('draft', ['final.md'], '未复核')
  await f.present(declared.files[0]!.label)
  const events = f.session.snapshotEvents()
  const { SessionLogOffset } = await import('@deepseek-ai/dsh-session')
  const restored = f.ctx.sessionProjections.restore(checkpoint, events.slice(base), SessionLogOffset(base),
    f.session.header, SessionLogOffset(0))
  expect(restored.checkpoint['muse.manuscript-delivery']).toEqual(f.ctx.sessionProjections.checkpoint(f.session)['muse.manuscript-delivery'])
  expect(restored.checkpoint['muse.manuscript-delivery']?.val).toMatchObject({ corrections: 1, rows: [{ presented: true }] })
})

it('also pairs a logged successful result with its later actual presented event', async () => {
  const f = await runtime()
  const declared = await f.declare('draft', ['final.md'], '未复核')
  const id = ToolCallId('reverse-order-present')
  f.session.append('tool/call', { turn: 1, step: 1, callId: id, name: 'present', arguments: JSON.stringify({ files: [{ path: 'final.md' }] }) })
  f.session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: id, isError: false,
    content: [{ type: 'text', text: JSON.stringify({ manuscript_delivery_receipt: { task_id: declared.task_id, call_id: id, mode: declared.mode, files: declared.files } }) }] }) }, { surfaceOp: 'append' })
  expect(f.ctx.sessionProjections.checkpoint(f.session)['muse.manuscript-delivery']?.val).toMatchObject({ rows: [{ presented: false }] })
  f.session.append('deliverables/presented', { turn: 1, callId: id, files: [{ path: 'final.md', description: declared.files[0]!.label }] })
  expect(f.ctx.sessionProjections.checkpoint(f.session)['muse.manuscript-delivery']?.val).toMatchObject({ rows: [{ presented: true }] })
})


it.each(['delayed', 'rejected', 'disposed'] as const)('handles %s projection readiness before exposing hooks', async (mode) => {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  // The spy calls the method with its actual registry receiver.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = SessionProjectionRegistry.prototype.register
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>((resolveStarted) => { entered = resolveStarted })
  const released = new Promise<void>((resolveReleased) => { release = resolveReleased })
  vi.spyOn(SessionProjectionRegistry.prototype, 'register').mockImplementationOnce(async function (this: SessionProjectionRegistry, definition) {
    entered()
    await released
    if (mode === 'rejected') throw Error('Controlled registration failure')
    return original.call(this, definition)
  })
  let ready = false
  let failure: unknown
  let service: ManuscriptDelivery | undefined
  const owner = ctx.plugin(Object.assign(async (inner: Context) => {
    try { service = await createManuscriptDelivery(inner, config); ready = true }
    catch (error) { failure = error; throw error }
  }, { inject: ['tools', 'sessionProjections'] }))
  await started
  expect(ready).toBe(false)
  const unloading = mode === 'disposed' ? owner.dispose() : undefined
  release()
  try { await owner } catch (error) { expect(error).toBeInstanceOf(Error) }
  await unloading
  if (mode === 'delayed') {
    expect(ready).toBe(true)
    await service?.dispose()
  } else {
    expect(ready).toBe(false)
    expect(failure).toBeInstanceOf(Error)
  }
})


it('retains a protected present execution until owner unload cancels its actual body', async () => {
  const f = await runtime()
  const declaration = await f.declare('draft', ['final.md'], '未复核')
  let entered!: () => void
  let release!: () => void
  const bodyEntered = new Promise<void>((resolveEntered) => { entered = resolveEntered })
  const released = new Promise<void>((resolveReleased) => { release = resolveReleased })
  f.ctx.on('tools/execute', async (exec, next) => {
    if (exec.name === 'present') { entered(); await released }
    return next()
  })
  const request = f.present(declaration.files[0]!.label)
  await bodyEntered
  const unloading = f.owner.dispose()
  await writeFile(join(f.root, 'final.md'), body + '\n甲：改稿。')
  release()
  expect((await request).isError).toBe(true)
  await unloading
  expect(f.session.snapshotEvents().filter(event => event.type === 'deliverables/presented')).toHaveLength(0)
})

it('recovers reviewed PTC facts from canonical metadata while preview-only text cannot approve delivery', async () => {
  const source = await runtime()
  const baseline = source.session.snapshotEvents()
  const reviewed = await source.review('consistent')
  const text = reviewed.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  const metadata = manuscriptDeliveryMetadata(text)
  expect(metadata).not.toBeNull()
  const fresh = () => Session.create(source.session.id, baseline, source.session.header)
  const f = await runtime({ session: fresh(), root: source.root })
  const negative = await runtime({ session: fresh(), root: source.root })
  const parent = ToolCallId('ptc-root')
  const reviewId = ToolCallId('ptc-root:ptc:1')
  for (const current of [f, negative]) {
    const data = { rootCallId: parent, parentCallId: parent, subCallId: reviewId, name: 'manuscript_revision', arguments: { action: 'continuity' } }
    current.session.append('tool/ptc-dispatch-start', data)
    current.session.append('tool/ptc-dispatch', { ...data, isError: false, content: [{ type: 'text', text: '[spilled preview]' }],
      ...(current === f && metadata !== null ? { meta: metadata } : {}) })
  }
  await expect(negative.declare('reviewed')).rejects.toThrow('MANUSCRIPT_DELIVERY_REVIEW_REQUIRED')
  const declaration = await f.service.declare(['final.md'], 'reviewed', undefined, f.agent, signal)
  const declarationMeta = manuscriptDeliveryMetadata(JSON.stringify(declaration))
  const declarationId = ToolCallId('ptc-root:ptc:2')
  const data = { rootCallId: parent, parentCallId: parent, subCallId: declarationId, name: 'manuscript_revision', arguments: { action: 'delivery' } }
  f.session.append('tool/ptc-dispatch-start', data)
  f.session.append('tool/ptc-dispatch', { ...data, isError: false, content: [{ type: 'text', text: '[spilled preview]' }],
    ...(declarationMeta === null ? {} : { meta: declarationMeta }) })
  const recovered = await runtime({ session: f.session, root: f.root })
  expect((await recovered.present(declaration.files[0]!.label)).isError).toBe(false)
})
