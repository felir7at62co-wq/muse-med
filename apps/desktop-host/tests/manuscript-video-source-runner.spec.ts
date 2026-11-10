/** Source-review request admission and results share the actual isolated reviewer lifecycle. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { VideoReviewId } from '@deepseek-ai/dsh-tool-video-inspect'
import { afterEach, expect, it, vi } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { installManuscriptContinuityPreset, ManuscriptContinuity, validateContinuityAssessment,
  type ManuscriptContinuityConfig } from '../src/manuscript-continuity.ts'
import * as Preset from '../src/manuscript-continuity-preset.ts'
import { readManuscriptMaterials } from '../src/manuscript-materials.ts'
import { ManuscriptNotes } from '../src/manuscript-notes.ts'
import * as Source from '../src/manuscript-video-source-review.ts'

const contexts: Context[] = [], roots: string[] = []
const signal = new AbortController().signal
const limits: ManuscriptContinuityConfig = {
  maxFileBytes: 65536, maxTextChars: 20000, maxNotes: 256, maxNoteChars: 40000, maxVersions: 256,
  maxVersionBytes: 1048576, maxLedgerBytes: 1048576, lockWaitMs: 5000,
  maxDocuments: 8, maxMaterialChars: 40000, continuityMaxRequests: 3, continuityMaxOutputTokens: 4096,
  continuityTimeoutMs: 120000, continuityMaxFindings: 8, continuityMaxCorrections: 1, continuityMaxEpisodeChecks: 12,
  videoEvidenceWindowSeconds: 8, videoEvidenceMaxScenes: 4, videoEvidenceMaxFrames: 4,
  videoEvidenceMaxBytes: 262144, videoEvidenceMaxTranscriptBytes: 2097152,
  repeatMinChars: 32, repeatMaxSeedPairs: 50000, repeatMaxCandidates: 12, repeatMaxOutputChars: 20000,
}
const image: ImageAttachmentRef = { attachmentId: AttachmentId('cached-original'), mediaType: 'image/png', bytes: 67,
  width: 1, height: 1 }
const sources: Source.VideoSourceInputs = [{ review_id: VideoReviewId('explicit-video-review'), start_seconds: 0,
  end_seconds: 2, frame_ids: ['frame-1'], draft_lines: { start: 1, end: 1 } }]

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function runtime(options: { imageCapable?: boolean; content?: ContentBlock[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'muse-source-runner-')); roots.push(root)
  await writeFile(join(root, 'draft.md'), '▲甲把红色钥匙放在桌上。')
  const materials = await readManuscriptMaterials([{ role: 'current', path: 'draft.md' }], root, limits, signal)
  const document = materials.documents[0]!
  const target = { role: document.role, path: document.path, file_sha256: document.file_sha256, text_sha256: document.text_sha256 }
  const citation = { ...target, line: 1, quote: document.lines[0]!.text }
  const report: Source.VideoSourceAssessment = { status: 'consistent', findings: [], unknowns: [], source_checks: [{
    mapping: 1, status: 'consistent', explanation: '画面中的放钥匙动作与选区对应；只核对实际样本。',
    frame_checks: [{ id: 'frame-1', disposition: 'matched', explanation: '原图显示红钥匙在桌面。', draft_evidence: [citation] }],
    speech_checks: [{ id: 'speech-1', disposition: 'matched', explanation: '仅与保存ASR对应，未校听原音。', draft_evidence: [citation] }],
  }] }
  const bundle: Source.VideoSourceBundle = { manifest: { scope: 'sampled_frames_and_saved_asr', audio_verification: 'not_performed',
    asr_origin_and_speaker_verified: false, target, inputs: sources, mapped_ranges: [{ start: 1, end: 1 }], unmapped_lines: [],
    sources: [{ mapping: 1, review_id: sources[0]!.review_id, path: '/source/video.mp4', source_version: 'v1',
      material_sha256: 'a'.repeat(64), packet_sha256: 'b'.repeat(64), start_seconds: 0, end_seconds: 2,
      draft_lines: { start: 1, end: 1 }, frames: [{ frame_id: 'frame-1', planned_seconds: 1,
        decoded_seconds: 1.04, image_sha256: 'c'.repeat(64) }], speech_segment_ids: ['speech-1'], context_only_segment_ids: [],
      scan_complete: true, scanned_until: 2, duration_seconds: 2 }] },
  content: options.content ?? [{ type: 'image', attachment: image }], expectedImages: [image], timelines: [],
  coverage_complete: true, issues: [] }
  const read = vi.spyOn(Source, 'readVideoSourceReview').mockResolvedValue(bundle)
  const unchanged = vi.spyOn(Source, 'videoSourceReviewUnchanged').mockResolvedValue(true)
  const ctx = new Context(); contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.internal = { version: 'v2', loadCache: new Map(),
    register() { throw Error('Unexpected loader hooks') }, getOrCreateModuleJob() { throw Error('Unexpected loader job') },
    resolveSync() { throw Error('Unexpected loader resolution') }, load() { throw Error('Unexpected loader load') },
    async import(specifier: string) {
      if (specifier === new URL('../src/manuscript-continuity-preset.ts', import.meta.url).href) return Preset
      throw Error(`Unexpected module ${specifier}`)
    } }
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Persistence, { root: join(root, 'sessions') })
  await ctx.plugin(Subagents)
  await ctx.plugin(Spawn)
  await ctx.plugin(AgentPresets, { default: 'source-editor' })
  await ctx.agentPresets.register({ id: 'source-editor', plugins: [] })
  await installManuscriptContinuityPreset(ctx, limits)
  const adapter = new MockAdapter([textResponse('Private editing conversation.'),
    () => toolCallResponse('source-judgment', 'structured_output', report)])
  const originalResolve = adapter.resolveModel.bind(adapter)
  vi.spyOn(adapter, 'resolveModel').mockImplementation(async (provider, model) => ({
    ...await originalResolve(provider, model), inputModalities: options.imageCapable === false ? ['text'] : ['text', 'image'],
  }))
  ctx.llm.registerAdapter(['mock'], adapter)
  const handle = await ctx.agents.create({ sessionId: SessionId('source-editor'), meta: { cwd: root, agentPreset: 'source-editor' },
    agentOptions: { provider: 'mock', model: 'selected-model' },
    setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'source-editor') } })
  const parent = handle.agent
  parent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '对照原视频，保持关键动作和对白。' }] }))
  await parent.whenIdle()
  const children: Session[] = []
  ctx.on('session/created', (session) => { if (session.header.parentSession === parent.id) children.push(session) })
  const service = new ManuscriptContinuity(ctx, limits)
  ctx.effect(() => () => service.dispose())
  const review = () => service.reviewVideoSource([{ role: 'current', path: 'draft.md' }], '核对选区', sources, parent, signal, ctx)
  return { root, ctx, parent, adapter, service, review, bundle, report, target, materials, read, unchanged, children }
}

it('logs original image blocks and returns a separate, narrowly scoped source assessment with all dispositions', async () => {
  const fixture = await runtime()
  await new ManuscriptNotes(limits).capture(['draft.md'], fixture.parent, signal)
  const result = await fixture.review()
  expect(result).toMatchObject({ state: 'video_source_review', scope: 'sampled_frames_and_saved_asr', status: 'consistent',
    reason: 'reviewed', source_manifest: fixture.bundle.manifest, source_checks: fixture.report.source_checks,
    source_verification: 'verified', file_verification: 'verified', reviewer: { requests: 1, selection: { model: 'selected-model' } } })
  const request = fixture.adapter.requests[1]!
  expect(request.messages.some(message => message.content.some(block => block.type === 'image'
    && block.attachment.attachmentId === image.attachmentId))).toBe(true)
  expect(request.tools?.[0]?.parameters.required).toContain('source_checks')
  const encoded = JSON.stringify(request.messages)
  expect(encoded).toContain('source_manifest')
  expect(encoded).toContain('revision_notes')
  expect(encoded).toContain('not original-audio verification')
  expect(encoded).toContain('对照原视频，保持关键动作和对白。')
  expect(encoded).not.toContain('Private editing conversation.')
  const childId = result.reviewer.session_id!
  expect(fixture.ctx.agents.get(childId)).toBeUndefined()
  expect(fixture.children[0]?.snapshotEvents().some(event => event.type === 'user/message'
    && JSON.stringify(event.data).includes(image.attachmentId))).toBe(true)
  expect(validateContinuityAssessment(fixture.report, fixture.materials, fixture.target, 8)).toMatchObject({ status: 'unknown', reason: 'invalid_result' })
})

it('rejects an image-incapable selected model before spawning a child or spending a reviewer request', async () => {
  const fixture = await runtime({ imageCapable: false })
  expect(await fixture.review()).toMatchObject({ status: 'unknown', reason: 'source_image_unsupported',
    reviewer: { session_id: null, requests: 0 }, source_verification: 'verified' })
  expect(fixture.adapter.requests).toHaveLength(1)
})

it.each(['absent', 'offloaded'] as const)('rejects %s required images in the actual child request', async (kind) => {
  const fixture = await runtime({ content: kind === 'absent' ? [] : [{ type: 'image', attachment: image, offloaded: true }] })
  expect(await fixture.review()).toMatchObject({ status: 'unknown', reason: 'source_images_missing', reviewer: { requests: 0 } })
  expect(fixture.adapter.requests).toHaveLength(1)
  expect(fixture.ctx.agents.list().map(agent => agent.id)).toEqual([fixture.parent.id])
})

it('does not start a reviewer when selected nonempty draft lines lack an explicit mapping', async () => {
  const fixture = await runtime()
  fixture.bundle.coverage_complete = false
  fixture.bundle.issues = ['Target lines without source mappings: 1.']
  expect(await fixture.review()).toMatchObject({ status: 'unknown', reason: 'source_scope', reviewer: { session_id: null, requests: 0 } })
  expect(fixture.adapter.requests).toHaveLength(1)
})

it('retains the local source-read diagnostic without starting a reviewer', async () => {
  const fixture = await runtime()
  fixture.read.mockRejectedValue(Error('VIDEO_SOURCE_BUDGET: Narrow the explicit mappings.'))
  expect(await fixture.review()).toMatchObject({ status: 'unknown', reason: 'source_unavailable',
    unknowns: ['VIDEO_SOURCE_BUDGET: Narrow the explicit mappings.'], source_verification: 'unavailable', reviewer: { requests: 0 } })
})

it('invalidates a semantic pass when the source dependency reread changes', async () => {
  const fixture = await runtime()
  fixture.unchanged.mockResolvedValue(false)
  expect(await fixture.review()).toMatchObject({ status: 'unknown', reason: 'source_changed', source_verification: 'changed',
    reviewer: { requests: 1 } })
})

it('invalidates a semantic pass when the assessed draft changes during the child request', async () => {
  const fixture = await runtime()
  fixture.ctx.on('llm/stream', async function* (options, next) {
    if (options.sessionId !== fixture.parent.id) await writeFile(join(fixture.root, 'draft.md'), '▲甲把蓝色钥匙带走。')
    yield* next()
  })
  expect(await fixture.review()).toMatchObject({ status: 'unknown', reason: 'file_changed', file_verification: 'changed' })
})
