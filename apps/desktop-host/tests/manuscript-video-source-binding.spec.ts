/** Source facts, independent review purposes, delivery freshness and bounded recovery. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, unsupportedModel, createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture, executeModelToolFixture, executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as Present from '@deepseek-ai/dsh-tool-present'
import { VideoReviewId } from '@deepseek-ai/dsh-tool-video-inspect'
import { afterEach, expect, it, vi } from 'vitest'
import { createManuscriptDelivery, manuscriptDeliveryMetadata, type ManuscriptDelivery } from '../src/manuscript-delivery.ts'
import type { ContinuityResult, VideoSourceReviewResult } from '../src/manuscript-continuity.ts'
import { readManuscriptMaterials } from '../src/manuscript-materials.ts'
import { ManuscriptNotes } from '../src/manuscript-notes.ts'
import type { VideoSourceManifest } from '../src/manuscript-video-source-review.ts'
import * as Reader from '../src/manuscript-document.ts'

const cleanups: (() => Promise<unknown>)[] = [], signal = new AbortController().signal
const config = { maxDocuments: 4, maxFileBytes: 65536, maxTextChars: 20000, maxMaterialChars: 20000,
  maxNotes: 256, maxNoteChars: 40000, maxVersions: 256, maxVersionBytes: 1048576, maxLedgerBytes: 1048576, lockWaitMs: 5000,
  continuityDeliveryChecks: true, continuityMaxDeliveryCorrections: 1 }
const body = '第1集\n1-1 门口 日 外\n▲甲把钥匙放在桌上。\n甲：钥匙在这里。'
let serial = 0
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})
function human(session: Session, text: string) {
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
}
function logResult(session: Session, name: string, args: object, value: object, error = false) {
  const callId = ToolCallId(`source-binding-${++serial}`)
  session.append('tool/call', { turn: 1, step: serial, callId, name, arguments: JSON.stringify(args) })
  return session.append('tool/result', { turn: 1, step: serial, message: createToolResultMessage({ callId,
    content: [{ type: 'text', text: JSON.stringify(value) }], isError: error }) }, { surfaceOp: 'append' })
}
interface SourceOptions {
  status?: 'consistent' | 'issues' | 'unknown'
  lines?: { start: number; end: number }
  path?: string
  reviewId?: string
  version?: string
  frames?: string[]
  seconds?: { start: number; end: number }
  withoutManifest?: boolean
}
async function runtime(options: { callback?: boolean; maxDocuments?: number; seed?: { session: Session; root: string } } = {}) {
  const root = options.seed?.root ?? await mkdtemp(join(tmpdir(), 'muse-source-binding-'))
  if (options.seed === undefined) {
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    await writeFile(join(root, 'final.md'), body)
    await writeFile(join(root, 'adopted.md'), body)
  }
  const ctx = new Context(); cleanups.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(Present, { maxFiles: 4 })
  const id = SessionId(`binding-owner-${++serial}`)
  const session = options.seed === undefined ? Session.create(id, [], { id, version: SESSION_FORMAT_VERSION, createdAt: 0,
    cwd: root, isSeeded: false })
    : Session.create(options.seed.session.id, options.seed.session.snapshotEvents(), options.seed.session.header)
  let scope!: Scope
  const agent: Agent = { id: session.id, session, options: {}, model: unsupportedModel(), inbox: createInboxStub(), status: 'idle',
    get ctx() { return scope.ctx }, send() {}, followup() {}, steer: () => ({ outcome: Promise.resolve({ status: 'rejected' }) }),
    inject(message) { session.append('user/message', message, { surfaceOp: 'append' }) }, cancel() {},
    runMaintenance: task => task(signal), whenIdle: () => Promise.resolve() }
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, { inject: ['tools'] }))
  await ctx.agents.register(agent)
  const verify = vi.fn(async (_session: Session, _manifest: VideoSourceManifest, _signal: AbortSignal) => true)
  let service!: ManuscriptDelivery
  const owner = await ctx.plugin(Object.assign(async (inner: Context) => {
    service = await createManuscriptDelivery(inner, { ...config, maxDocuments: options.maxDocuments ?? config.maxDocuments },
      options.callback === false ? {} : { verifyVideoSource: verify })
  }, { inject: ['tools', 'sessionProjections'] }))
  if (options.seed === undefined) {
    session.append('turn/start', { turn: 1 })
    human(session, '重写短剧剧本并交付最终文件。')
  }
  async function materials(lines?: SourceOptions['lines']) {
    const value = await readManuscriptMaterials([{ role: 'current', path: 'adopted.md' },
      { role: 'candidate', path: 'final.md', ...lines === undefined ? {} : { lines } }], root, config, signal)
    const target = value.documents.find(document => document.role === 'candidate')!
    const notes = await new ManuscriptNotes(config).read(agent, [value.documents[0]!.path], signal)
    return { target: { role: target.role, path: target.path, file_sha256: target.file_sha256, text_sha256: target.text_sha256 },
      documents: value.documents.map(({ lines: _lines, unchanged_since_read: _unchanged, ...document }) => document),
      ...notes === undefined ? {} : { notes_sha256: notes.notes_sha256 } }
  }
  async function textReview(status: 'consistent' | 'issues' = 'consistent', lines?: SourceOptions['lines']) {
    const base = await materials(lines)
    const value: ContinuityResult = { ...base, state: 'continuity', scope: 'returned_text_lines_only', advisory: true,
      status, reason: 'reviewed', unknowns: [], file_verification: 'verified', reviewer: { session_id: null, selection: null, requests: 1 },
      findings: status === 'issues' ? [{ category: 'transition', description: '已知文本矛盾', evidence: [3, 4].map(line => ({
        ...base.target, line, quote: line === 3 ? '▲甲把钥匙放在桌上。' : '甲：钥匙在这里。' })) }] : [] }
    logResult(session, 'manuscript_revision', { action: 'continuity' }, value)
    return value
  }
  async function sourceFact(settings: SourceOptions = {}): Promise<VideoSourceReviewResult> {
    const base = await materials(settings.lines), lines = settings.lines ?? { start: 1, end: 4 }
    const seconds = settings.seconds ?? { start: 0, end: 4 }, frames = settings.frames ?? ['frame-1']
    const reviewId = VideoReviewId(settings.reviewId ?? 'source-review-1')
    const manifest: VideoSourceManifest = { scope: 'sampled_frames_and_saved_asr', audio_verification: 'not_performed',
      asr_origin_and_speaker_verified: false, target: base.target,
      inputs: [{ review_id: reviewId, start_seconds: seconds.start, end_seconds: seconds.end, frame_ids: frames, draft_lines: lines }],
      mapped_ranges: [lines], unmapped_lines: [], sources: [{ mapping: 1, review_id: reviewId, path: settings.path ?? '/videos/original.mp4',
        source_version: settings.version ?? 'source-v1', material_sha256: 'a'.repeat(64), packet_sha256: 'b'.repeat(64),
        start_seconds: seconds.start, end_seconds: seconds.end, draft_lines: lines,
        frames: frames.map(frame => ({ frame_id: frame, planned_seconds: seconds.start,
          decoded_seconds: seconds.start, image_sha256: 'c'.repeat(64) })), speech_segment_ids: [], context_only_segment_ids: [],
        speech_source: { path: '/videos/recognition.json', version: 'asr-v1', sha256: 'd'.repeat(64) },
        scan_complete: true, scanned_until: seconds.end, duration_seconds: 20 }] }
    const status = settings.status ?? 'consistent'
    return { ...base, state: 'video_source_review', scope: 'sampled_frames_and_saved_asr', advisory: true,
      status, reason: settings.withoutManifest ? 'source_unavailable' : 'reviewed', findings: [],
      unknowns: status === 'unknown' ? ['来源细节待确认。'] : [], file_verification: 'verified',
      source_verification: settings.withoutManifest ? 'unavailable' : 'verified',
      reviewer: { session_id: null, selection: null, requests: settings.withoutManifest ? 0 : 1 },
      ...settings.withoutManifest ? {} : { source_manifest: manifest } }
  }
  async function sourceReview(settings: SourceOptions = {}) {
    const value = await sourceFact(settings), lines = settings.lines ?? { start: 1, end: 4 }
    const seconds = settings.seconds ?? { start: 0, end: 4 }
    logResult(session, 'manuscript_revision', { action: 'source_fidelity', video_sources: value.source_manifest?.inputs ?? [{
      review_id: settings.reviewId ?? 'source-review-1', start_seconds: seconds.start, end_seconds: seconds.end,
      frame_ids: settings.frames ?? ['frame-1'], draft_lines: lines }] }, value)
    return value
  }
  async function declare(mode: 'reviewed' | 'draft' = 'reviewed', sourceMode?: 'video') {
    const value = await service.declare(['final.md'], mode, mode === 'draft' ? '来源尚待核实。' : undefined, agent, signal, sourceMode)
    logResult(session, 'manuscript_revision', { action: 'delivery', source_mode: sourceMode }, value)
    return value
  }
  async function present(description: string) {
    const callId = ToolCallId(`binding-present-${++serial}`), args = { files: [{ path: 'final.md', description }] }
    session.append('tool/call', { turn: 1, step: serial, callId, name: 'present', arguments: JSON.stringify(args) })
    const result = await executeModelToolFixture(ctx, { callId, name: 'present', arguments: args, agent, signal })
    session.append('tool/result', { turn: 1, step: serial,
      message: createToolResultMessage({ callId, content: result.content, isError: result.isError }) }, { surfaceOp: 'append' })
    return result
  }
  return { root, ctx, agent, session, service, owner, verify, textReview, sourceFact, sourceReview, declare, present }
}

it('requires independent text review and binds narrow source scope through actual present', async () => {
  const f = await runtime(), source = await f.sourceReview()
  await expect(f.declare()).rejects.toThrow('MANUSCRIPT_DELIVERY_REVIEW_REQUIRED')
  await f.textReview()
  const declaration = await f.declare()
  expect(declaration.source_mode).toBe('video')
  expect(declaration.files[0]?.source_reviews?.[0]?.source_manifest).toEqual(source.source_manifest)
  expect(declaration.files[0]?.label).toContain('0–4秒内1个原帧及保存ASR→正文第1–4行')
  expect(declaration.files[0]?.label).toContain('未校听原音，未核验全片')
  expect((await f.present(declaration.files[0]!.label)).isError).toBe(false)
  expect(f.verify).toHaveBeenCalledTimes(3)
})
it.each(['issues', 'unknown'] as const)('text consistency cannot clear source %s but matching source re-review can', async (status) => {
  const f = await runtime()
  await f.sourceReview({ status }); await f.textReview()
  await expect(f.declare()).rejects.toThrow('MANUSCRIPT_DELIVERY_SOURCE_REQUIRED')
  await f.sourceReview()
  expect((await f.declare()).mode).toBe('reviewed')
})
it('a source pass cannot clear text findings', async () => {
  const f = await runtime()
  await f.textReview('issues'); await f.sourceReview()
  await expect(f.declare()).rejects.toThrow('MANUSCRIPT_DELIVERY_REVIEW_REQUIRED')
  await f.textReview()
  expect((await f.declare()).mode).toBe('reviewed')
})
it('an unrelated source cannot clear an earlier source issue', async () => {
  const f = await runtime()
  await f.sourceReview({ status: 'issues' }); await f.textReview()
  await f.sourceReview({ path: '/videos/unrelated.mp4' })
  await expect(f.declare()).rejects.toThrow('MANUSCRIPT_DELIVERY_SOURCE_REQUIRED')
})
it('an earlier broad pass cannot clear a later local failure after an unrelated pass', async () => {
  const f = await runtime()
  await f.sourceReview({ frames: ['frame-a', 'frame-b'] })
  await f.sourceReview({ status: 'unknown', lines: { start: 1, end: 2 }, seconds: { start: 0, end: 2 }, frames: ['frame-a'] })
  await f.sourceReview({ path: '/videos/unrelated.mp4' }); await f.textReview()
  await expect(f.declare()).rejects.toThrow('MANUSCRIPT_DELIVERY_SOURCE_REQUIRED')
  await f.sourceReview({ frames: ['frame-a', 'frame-b'] })
  expect((await f.declare()).mode).toBe('reviewed')
})
it('source refresh changes review ID and source version without changing draft bytes', async () => {
  const f = await runtime()
  await f.sourceReview({ status: 'issues', frames: ['old-frame'] }); await f.textReview()
  await f.sourceReview({ reviewId: 'rescanned-review', version: 'source-v2', frames: ['new-frame'] })
  const result = await f.declare()
  expect(result.files[0]?.source_reviews).toHaveLength(1)
  expect(result.files[0]?.source_reviews?.[0]?.source_manifest.sources[0]?.review_id).toBe('rescanned-review')
})
it('same-version re-review must include an earlier problematic frame', async () => {
  const f = await runtime()
  await f.sourceReview({ status: 'issues', frames: ['problem-frame'] }); await f.textReview()
  await f.sourceReview({ reviewId: 'rescanned-review', frames: ['different-frame'] })
  await expect(f.declare()).rejects.toThrow('MANUSCRIPT_DELIVERY_SOURCE_REQUIRED')
  await f.sourceReview({ reviewId: 'rescanned-review', frames: ['problem-frame', 'different-frame'] })
  expect((await f.declare()).mode).toBe('reviewed')
})
it('combines partial passes only after failed draft and source ranges and frames are covered', async () => {
  const f = await runtime()
  await f.sourceReview({ status: 'issues', frames: ['frame-a', 'frame-b'] }); await f.textReview()
  await f.sourceReview({ lines: { start: 1, end: 2 }, seconds: { start: 0, end: 2 }, frames: ['frame-a'] })
  await expect(f.declare()).rejects.toThrow('MANUSCRIPT_DELIVERY_SOURCE_REQUIRED')
  await f.sourceReview({ lines: { start: 3, end: 4 }, seconds: { start: 2, end: 4 }, frames: ['frame-b'] })
  expect((await f.declare()).files[0]?.source_reviews).toHaveLength(2)
})
it('retains distinct partial source successes instead of using only the last result', async () => {
  const f = await runtime()
  await f.textReview()
  await f.sourceReview({ lines: { start: 1, end: 2 }, seconds: { start: 0, end: 2 } })
  await f.sourceReview({ lines: { start: 3, end: 4 }, seconds: { start: 2, end: 4 } })
  expect((await f.declare()).files[0]?.source_reviews).toHaveLength(2)
})
it('partial source mapping cannot upgrade full text scope but matching partial scope can be delivered', async () => {
  const f = await runtime()
  await f.textReview(); await f.sourceReview({ lines: { start: 3, end: 3 } })
  await expect(f.declare()).rejects.toThrow('非空行缺少来源对应：1、2、4')
  await f.textReview('consistent', { start: 3, end: 3 })
  const declaration = await f.declare()
  expect(declaration.files[0]?.label).toContain('已复核正文第3行')
  expect((await f.present(declaration.files[0]!.label)).isError).toBe(false)
})
it('blank lines do not need source mappings', async () => {
  const f = await runtime()
  await writeFile(join(f.root, 'final.md'), body + '\n\n')
  await f.textReview(); await f.sourceReview()
  expect((await f.declare()).mode).toBe('reviewed')
})
it('unavailable source evidence requires retry of the same selector', async () => {
  const f = await runtime()
  await f.sourceReview({ status: 'unknown', withoutManifest: true }); await f.textReview()
  await f.sourceReview({ reviewId: 'unrelated-review' })
  await expect(f.declare()).rejects.toThrow('MANUSCRIPT_DELIVERY_SOURCE_REQUIRED')
  await f.sourceReview({ frames: ['corrected-readable-frame'] })
  expect((await f.declare()).mode).toBe('reviewed')
})
it('source fact overflow remains explicit and permits draft delivery', async () => {
  const f = await runtime({ maxDocuments: 2 })
  await f.textReview()
  for (let index = 0; index < 3; index++) await f.sourceReview({ path: `/videos/${index}.mp4`, reviewId: `review-${index}` })
  await expect(f.declare()).rejects.toThrow('记录超限时在新任务分批重新核对')
  expect((await f.declare('draft')).mode).toBe('draft')
})
it('only a successful actual video skill load requires source evidence', async () => {
  const failed = await runtime()
  await failed.textReview()
  logResult(failed.session, 'skill', { name: 'video-to-screenplay' }, { error: 'unavailable' }, true)
  expect((await failed.declare()).files[0]?.source_reviews).toBeUndefined()
  const success = await runtime()
  await success.textReview()
  logResult(success.session, 'skill', { name: 'video-to-screenplay' }, { name: 'video-to-screenplay', content: '已加载。' })
  await expect(success.declare()).rejects.toThrow('MANUSCRIPT_DELIVERY_SOURCE_REQUIRED')
})
it('a source action error still requires source review across human continuations', async () => {
  const f = await runtime()
  logResult(f.session, 'manuscript_revision', { action: 'source_fidelity' }, { error: 'bad input' }, true)
  await f.textReview()
  await expect(f.declare()).rejects.toThrow('MANUSCRIPT_DELIVERY_SOURCE_REQUIRED')
  human(f.session, '继续，交付文件。')
  await expect(f.declare()).rejects.toThrow('MANUSCRIPT_DELIVERY_SOURCE_REQUIRED')
})
it('a known video workflow requires a declaration even when ordinary writing intent is absent', async () => {
  const f = await runtime()
  human(f.session, '把视频转成剧本。')
  logResult(f.session, 'skill', { name: 'video-to-screenplay' }, { name: 'video-to-screenplay', content: '已加载。' })
  const result = await f.present('已完成')
  expect(JSON.stringify(result.content)).toContain('MANUSCRIPT_DELIVERY_REQUIRED')
  expect(result.isError).toBe(true)
})
it('missing verifier preserves ordinary text delivery but refuses reviewed video', async () => {
  const f = await runtime({ callback: false })
  await f.textReview()
  expect((await f.declare()).mode).toBe('reviewed')
  await expect(f.declare('reviewed', 'video')).rejects.toThrow('MANUSCRIPT_DELIVERY_SOURCE_REQUIRED')
  await f.sourceReview()
  await expect(f.declare()).rejects.toThrow('MANUSCRIPT_DELIVERY_SOURCE_STALE')
  expect((await f.declare('draft')).mode).toBe('draft')
})
it.each(['declare', 'before_present', 'after_present'] as const)('rejects changed source dependencies at %s', async (stage) => {
  const f = await runtime()
  await f.sourceReview(); await f.textReview()
  if (stage === 'declare') {
    f.verify.mockResolvedValue(false)
    await expect(f.declare()).rejects.toThrow('MANUSCRIPT_DELIVERY_SOURCE_STALE')
    return
  }
  const declaration = await f.declare()
  if (stage === 'before_present') f.verify.mockResolvedValue(false)
  else f.verify.mockResolvedValueOnce(true).mockResolvedValue(false)
  const result = await f.present(declaration.files[0]!.label)
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('MANUSCRIPT_DELIVERY_SOURCE_STALE')
  expect(JSON.stringify(result.content)).not.toContain('manuscript_delivery_receipt')
})
it('source notes must be refreshed after newer text review sees imported human requirements', async () => {
  const f = await runtime()
  await f.sourceReview()
  await new ManuscriptNotes(config).capture(['adopted.md'], f.agent, signal)
  await f.textReview()
  await expect(f.declare()).rejects.toThrow('MANUSCRIPT_DELIVERY_SOURCE_STALE')
  await f.sourceReview()
  expect((await f.declare()).mode).toBe('reviewed')
})
it('a draft sibling in the same present batch cannot disable post-dispatch verification of reviewed sources', async () => {
  const f = await runtime()
  await f.sourceReview(); await f.textReview()
  const reviewed = await f.declare()
  await writeFile(join(f.root, 'draft.md'), body)
  const draft = await f.service.declare(['draft.md'], 'draft', '尚未核实。', f.agent, signal)
  logResult(f.session, 'manuscript_revision', { action: 'delivery' }, draft)
  f.verify.mockResolvedValueOnce(true).mockResolvedValue(false)
  const callId = ToolCallId(`mixed-source-batch-${++serial}`), args = { files: [
    { path: 'final.md', description: reviewed.files[0]!.label }, { path: 'draft.md', description: draft.files[0]!.label },
  ] }
  f.session.append('tool/call', { turn: 1, step: serial, callId, name: 'present', arguments: JSON.stringify(args) })
  const result = await executeModelToolFixture(f.ctx, { callId, name: 'present', arguments: args, agent: f.agent, signal })
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('MANUSCRIPT_DELIVERY_SOURCE_STALE')
  expect(JSON.stringify(result.content)).not.toContain('manuscript_delivery_receipt')
})
it('recovers compact PTC source metadata and bound manifests after service recreation', async () => {
  const f = await runtime()
  await f.textReview()
  const fact = await f.sourceFact(), meta = manuscriptDeliveryMetadata(JSON.stringify(fact))
  expect(meta).not.toBeNull()
  const root = ToolCallId('binding-ptc'), sub = ToolCallId('binding-ptc:1')
  const data = { rootCallId: root, parentCallId: root, subCallId: sub, name: 'manuscript_revision',
    arguments: { action: 'source_fidelity', video_sources: fact.source_manifest!.inputs } }
  f.session.append('tool/ptc-dispatch-start', data)
  f.session.append('tool/ptc-dispatch', { ...data, isError: false, content: [{ type: 'text', text: '[spilled preview]' }],
    ...meta === null ? {} : { meta } })
  const declaration = await f.declare(), recovered = await runtime({ seed: { session: f.session, root: f.root } })
  expect((await recovered.present(declaration.files[0]!.label)).isError).toBe(false)
  expect(recovered.verify).toHaveBeenCalledTimes(2)
})
it('waits for nested source commit and cancels that wait before filesystem reads', async () => {
  const f = await runtime()
  await f.textReview()
  const fact = await f.sourceFact(), root = ToolCallId('nested-binding'), sub = ToolCallId('nested-binding:1')
  const args = { action: 'source_fidelity', video_sources: fact.source_manifest!.inputs }
  const data = { rootCallId: root, parentCallId: root, subCallId: sub, name: 'manuscript_revision', arguments: args }
  f.ctx.effect(() => f.ctx.tools.register(defineContentToolFixture({ name: 'manuscript_revision', description: 'Fixture Host fact',
    parameters: { action: { type: 'string' }, video_sources: { type: 'json' } },
    async execute() { return [{ type: 'text', text: JSON.stringify(fact) }] } })))
  f.ctx.effect(() => f.ctx.tools.register(defineContentToolFixture({ name: 'binding_transport', description: 'Fixture nested transport',
    parameters: {}, async execute(_args, exec) {
      f.session.append('tool/ptc-dispatch-start', data)
      return (await executeToolFixture(f.ctx, { callId: sub, rootCallId: root, parent: exec.token,
        name: 'manuscript_revision', arguments: args, agent: f.agent, signal })).content
    } })))
  await executeModelToolFixture(f.ctx, { callId: root, name: 'binding_transport', arguments: {}, agent: f.agent, signal })
  const read = vi.spyOn(Reader, 'readManuscript'), controller = new AbortController()
  const declaration = f.service.declare(['final.md'], 'reviewed', undefined, f.agent, controller.signal)
  const rejected = expect(declaration).rejects.toThrow('cancel before commit')
  controller.abort(Error('cancel before commit'))
  await rejected
  expect(read).not.toHaveBeenCalled()
  const event = f.session.append('tool/ptc-dispatch', { ...data, isError: false, content: [{ type: 'text', text: '[preview]' }],
    meta: manuscriptDeliveryMetadata(JSON.stringify(fact))! })
  f.service.committed(f.session, event)
  expect((await f.declare()).mode).toBe('reviewed')
})
it('owner disposal cancels and drains source verification', async () => {
  const f = await runtime()
  await f.sourceReview(); await f.textReview()
  const entered = Promise.withResolvers<undefined>()
  f.verify.mockImplementation(async (_session, _manifest, readSignal) => {
    entered.resolve(undefined)
    await new Promise<undefined>((_resolve, reject) => {
      readSignal.addEventListener('abort', () => {
        reject(readSignal.reason instanceof Error ? readSignal.reason : Error('Source verification aborted'))
      }, { once: true })
    })
    return true
  })
  const declaration = f.declare(), rejected = expect(declaration).rejects.toThrow('owner was disposed')
  await entered.promise
  await f.owner.dispose()
  await rejected
  expect(f.verify).toHaveBeenCalledTimes(1)
})
