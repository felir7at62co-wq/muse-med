/** Real media and actual model dispatches for complete-episode observation. */
import { mkdtemp, realpath, rm, writeFile, appendFile, copyFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import NodeRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { LlmAdapter, ToolCallId, createUserMessage, createAssistantMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { afterEach, expect, it, vi } from 'vitest'
import * as Video from '../src/index.ts'
import * as ImageOffload from '@deepseek-ai/dsh-compaction-image-offload'
import { LlmError, IMAGE_OFFLOAD_REQUIRED_CODE } from '@deepseek-ai/dsh-llm'
import * as Present from '@deepseek-ai/dsh-tool-present'
import { runMedia } from '../src/media.ts'
import * as Media from '../src/media.ts'
import sharp from 'sharp'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import { scanReviewFrames, appearanceCandidates } from '../src/review-scan.ts'
import { reviewsOf, installReviewState, reviewImage, saveReview, VideoReviewId } from '../src/review-state.ts'
import { applyCompleteReview } from '../src/review.ts'
import { compareReviewDraft } from '../src/review-compare.ts'
import { z } from 'zod'

type Plan = { name: string; args: object } | (() => { name: string; args: object }) | 'fail' | 'offload' | 'offload-throw' | undefined
class Model extends LlmAdapter {
  plans: Plan[] = []
  requests: GenerateOptions[] = []
  override async resolveModel(provider: string, id: string) { return { provider, id, name: id, inputModalities: ['text', 'image'] as const } }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const next = this.plans.shift(), plan = typeof next === 'function' ? next() : next
    if (plan === 'offload-throw') throw new LlmError('Synthetic image budget', IMAGE_OFFLOAD_REQUIRED_CODE, { offloadImages: 1 })
    if (plan === 'offload') { yield { type: 'finish', reason: { kind: 'error', failure: { code: IMAGE_OFFLOAD_REQUIRED_CODE, message: 'Synthetic image budget', offloadImages: 1 } } }; return }
    if (plan === 'fail') { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'FIXTURE', message: 'Synthetic failure' } } }; return }
    if (plan === undefined) { yield { type: 'finish', reason: { kind: 'stop' } }; return }
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(`review-${this.requests.length}`), name: plan.name, arguments: JSON.stringify(plan.args) } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}
const fixtures: { ctx: Context; root: string }[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const { ctx, root } of fixtures.splice(0)) { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})
async function fixture(options: { ptc?: boolean; offload?: boolean; cutSeconds?: number; config?: Partial<Video.Config> } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-complete-video-'))), ctx = new Context()
  fixtures.push({ ctx, root })
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: options.ptc ? 'ptc' : 'native' } })
  await ctx.plugin(LocalFileSystem, { cwd: root }); await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalAttachmentStore, { dshHome: join(root, '.state') })
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: root }) } as never)
  if (options.ptc) { await ctx.plugin(LocalSandbox); await ctx.plugin(NodeRuntime).await() }
  if (options.offload) await ctx.plugin(ImageOffload).await()
  const config = Video.Config({ requireCompleteReview: true, reviewBatchFrames: 2, reviewChunkSeconds: 2, ...options.config })
  const plugin = ctx.plugin(Video, config); await plugin.await()
  await ctx.plugin(Present, { maxFiles: 8 })
  const manuscript = join(root, 'episode-80.md')
  await writeFile(manuscript, '# 第80集\n▲红色背景切换为蓝色背景。\n')
  for (const name of ['screenplay_export_docx']) ctx.tools.register(defineTool({ name,
    description: 'Test delivery sink.', parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'delivered' }))
  const input = join(root, 'episode-80.mp4'), ffmpeg = await ctx.subprocess.resolveExecutable('ffmpeg')
  const cutSeconds = options.cutSeconds ?? 1.5
  await runMedia(ctx, [ffmpeg, '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', `color=red:s=96x64:r=10:d=${cutSeconds}`,
    '-f', 'lavfi', '-i', `color=blue:s=96x64:r=10:d=${3 - cutSeconds}`, '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input], { mode: 'danger-full-access', workspaceRoot: root }, undefined,
  { timeoutMs: 20_000, maxBytes: 1024, graceMs: 1000 })
  const adapter = new Model(); ctx.llm.registerAdapter(['synthetic'], adapter)
  await mountAgentLoopTestHarness(ctx)
  const handle = await ctx.agents.create({ sessionId: SessionId(`episode-${fixtures.length}`),
    agentOptions: { provider: 'synthetic', model: 'vision' }, meta: { cwd: root } })
  const agent = handle.agent
  const call = (method: string, extra = {}) => ({ name: 'video_inspect', args: { file_path: input, method, episode: '第80集', ...extra } })
  const run = async (...plans: Plan[]) => {
    adapter.plans = plans
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Observe this complete original episode.' }] }))
    await agent.whenIdle()
  }
  const review = () => reviewsOf(ctx, agent.session)[input]!
  const record = () => call('observe', { observations: review().frames.filter(frame => frame.image !== undefined && frame.observation === undefined)
    .map(frame => ({ frame_id: frame.id, visible: `画面为完整的${frame.time < cutSeconds ? '红色' : '蓝色'}背景，没有可见人物和道具。`,
      change: '根据实际合成画面对照颜色变化。', uncertainty: '' })) })
  const results = () => agent.session.snapshotEvents().flatMap(event => event.type === 'tool/result' ? [event.data.message] : [])
  return { ctx, root, config, manuscript, handle, input, plugin, agent, adapter, run, call, review, record, results }
}

function reportPath(h: Awaited<ReturnType<typeof fixture>>): string {
  const block = h.results().at(-1)!.content.find(block => block.type === 'text')!
  if (block.type !== 'text') throw Error('Missing report')
  return z.object({ observation_report: z.string() }).parse(JSON.parse(block.text)).observation_report
}

it('rejects unknown review identities and observed frames whose original cache reference is absent', async () => {
  const h = await fixture()
  await h.run(h.call('scan'), h.record, undefined)
  const options = { windowSeconds: 1, maxTranscriptBytes: 4096, maxBytes: 100_000, maxFrames: 1 }
  await expect(Video.readVideoSourceTimeline(h.ctx, h.agent.session, VideoReviewId('missing'), options,
    new AbortController().signal)).rejects.toThrow('VIDEO_TIMELINE_REVIEW')
  const review = h.review(), frame = review.frames.find(value => value.observation !== undefined)!
  const { image: _image, ...withoutCache } = frame
  saveReview(h.ctx, h.agent.session, { ...review, frames: review.frames.map(value => value.id === frame.id ? withoutCache : value) })
  await expect(Video.readVideoSourceTimeline(h.ctx, h.agent.session, review.id, { ...options, frameIds: [frame.id] },
    new AbortController().signal)).rejects.toThrow('VIDEO_REVISIT_IMAGE_MISSING')
})

it.each([Error('ASR stat unavailable'), 'ASR stat unavailable'])(
  'keeps cached pictures but drops speech when the final ASR freshness check rejects: %s', async (failure) => {
    const h = await fixture(), transcript = join(h.root, 'final-asr.json')
    await writeFile(transcript, JSON.stringify([{ start: 0, end: 1, text: '原台词。' }]))
    await h.run(h.call('scan', { transcript_path: transcript }), h.record, undefined)
    const frame = h.review().frames.find(value => value.observation !== undefined)!
    const readImage = h.ctx.attachments.readImage.bind(h.ctx.attachments), stat = vi.spyOn(h.ctx.fs, 'stat')
    vi.spyOn(h.ctx.attachments, 'readImage').mockImplementation(async (...args) => {
      const image = await readImage(...args)
      stat.mockRejectedValueOnce(failure)
      return image
    })
    const result = await Video.readVideoSourceTimeline(h.ctx, h.agent.session, h.review().id,
      { windowSeconds: 1, maxTranscriptBytes: 4096, maxBytes: 100_000, maxFrames: 1, frameIds: [frame.id] }, new AbortController().signal)
    expect(result.timeline.speech).toBeUndefined()
    expect(result.timeline.speech_unavailable?.reason).toBe('ASR stat unavailable')
    expect(result.content.filter(block => block.type === 'image')).toHaveLength(1)
  },
)

it.each(['video', 'observations'] as const)('refuses source material replaced during a cached image read: %s', async (change) => {
  const h = await fixture()
  await h.run(h.call('scan'), h.record, undefined)
  const frame = h.review().frames.find(value => value.observation !== undefined)!
  const readImage = h.ctx.attachments.readImage.bind(h.ctx.attachments)
  vi.spyOn(h.ctx.attachments, 'readImage').mockImplementation(async (...args) => {
    const image = await readImage(...args)
    if (change === 'video') await appendFile(h.input, 'changed source')
    else saveReview(h.ctx, h.agent.session, { ...h.review(), frames: h.review().frames.map(value => value.id === frame.id
      ? { ...value, observation: { visible: '这是更新后的画面观察记录。', change: '记录已经更新。', uncertainty: '' } } : value) })
    return image
  })
  await expect(Video.readVideoSourceTimeline(h.ctx, h.agent.session, h.review().id,
    { windowSeconds: 1, maxTranscriptBytes: 4096, maxBytes: 100_000, maxFrames: 1, frameIds: [frame.id] },
    new AbortController().signal)).rejects.toThrow('VIDEO_REVIEW_SOURCE_CHANGED')
})

it('reports a non-Error cache failure without extracting replacement frames', async () => {
  const h = await fixture()
  await h.run(h.call('scan'), h.record, undefined)
  const frame = h.review().frames.find(value => value.observation !== undefined)!
  const spawn = vi.spyOn(h.ctx.subprocess, 'spawn')
  vi.spyOn(h.ctx.attachments, 'readImage').mockRejectedValueOnce('cache unavailable')
  await expect(Video.readVideoSourceTimeline(h.ctx, h.agent.session, h.review().id,
    { windowSeconds: 1, maxTranscriptBytes: 4096, maxBytes: 100_000, maxFrames: 1, frameIds: [frame.id] },
    new AbortController().signal)).rejects.toThrow('cache unavailable')
  expect(spawn).not.toHaveBeenCalled()
})

it('rejects a directory as explicit ASR and retains an implicit ASR provider failure as a diagnostic', async () => {
  const h = await fixture(), directory = join(h.root, 'directory.json'), transcript = join(h.root, 'asr.json')
  await mkdir(directory)
  await writeFile(transcript, JSON.stringify([{ start: 0, end: 1, text: '原台词。' }]))
  await h.run(h.call('scan', { transcript_path: transcript }), h.record, undefined)
  await h.run(h.call('status', { transcript_path: directory }), undefined)
  expect(JSON.stringify(h.results().at(-1))).toContain('VIDEO_TRANSCRIPT_SIZE')
  vi.spyOn(h.ctx.fs, 'readBytes').mockRejectedValueOnce('ASR unavailable')
  await h.run(h.call('status'), undefined)
  expect(h.results().at(-1)?.isError).toBe(false)
  expect(JSON.stringify(h.results().at(-1))).toContain('ASR unavailable')
})

it('returns the default whole-video timeline without requiring a transcript or explicit range', async () => {
  const h = await fixture()
  await h.run(h.call('scan'), h.record, undefined)
  expect(Video.videoReviewSummaries(h.ctx, h.agent.session)[0]).not.toHaveProperty('transcript_reference')
  await h.run(h.call('timeline'), undefined)
  const block = h.results().at(-1)?.content.find(value => value.type === 'text')
  if (block?.type !== 'text') throw Error('Missing source timeline')
  expect(JSON.parse(block.text)).toMatchObject({ source_timeline: { scope: { full_episode: true } } })
})

it.each(['status', 'timeline'])('refuses video changes during an explicit ASR read for %s', async (method) => {
  const h = await fixture(), transcript = join(h.root, 'asr.json')
  await h.run(h.call('scan'), h.record, undefined)
  await writeFile(transcript, JSON.stringify([{ start: 0, end: 1, text: '原台词。' }]))
  const readBytes = h.ctx.fs.readBytes.bind(h.ctx.fs)
  vi.spyOn(h.ctx.fs, 'readBytes').mockImplementation(async (...args) => {
    const bytes = await readBytes(...args)
    if (args[0].displayPath === transcript) await appendFile(h.input, 'changed video')
    return bytes
  })
  await h.run(h.call(method, { transcript_path: transcript }), undefined)
  expect(JSON.stringify(h.results().at(-1))).toContain('VIDEO_REVIEW_SOURCE_CHANGED')
  expect(h.review().transcript_reference).toBeUndefined()
})

it.each(['reference', 'bytes'])('reports missing revisit cache without rescanning: %s', async (kind) => {
  const h = await fixture()
  await h.run(h.call('scan'), h.record, undefined)
  const review = h.review(), frame = review.frames.find(value => value.observation !== undefined)!
  if (kind === 'reference') {
    const { image: _image, ...withoutCache } = frame
    saveReview(h.ctx, h.agent.session, { ...review, frames: review.frames.map(value => value.id === frame.id ? withoutCache : value) })
  } else vi.spyOn(h.ctx.attachments, 'readImage').mockRejectedValueOnce('cache missing')
  const spawn = vi.spyOn(h.ctx.subprocess, 'spawn')
  await h.run(h.call('revisit', { frame_ids: [frame.id] }), undefined)
  expect(JSON.stringify(h.results().at(-1))).toContain('VIDEO_REVISIT_IMAGE_MISSING')
  expect(spawn).not.toHaveBeenCalled()
})

it.each(['events', 'revisit'])('does not publish %s after its source changes at the final read', async (method) => {
  const h = await fixture()
  await h.run(h.call('scan'), h.record, undefined)
  const before = JSON.stringify(h.review()), frame = h.review().frames.find(value => value.observation !== undefined)!
  const stat = h.ctx.fs.stat.bind(h.ctx.fs)
  let videoReads = 0
  vi.spyOn(h.ctx.fs, 'stat').mockImplementation(async (...args) => {
    if (args[0].displayPath === h.input && ++videoReads === 2) await appendFile(h.input, 'changed video')
    return await stat(...args)
  })
  const args = method === 'revisit' ? { frame_ids: [frame.id] } : { event_groups: [{ event_id: 'E1', frame_ids: [frame.id],
    actor: '', action: '呈现红色背景', object: '', before: '', after: '', uncertainty: '' }] }
  await h.run(h.call(method, args), undefined)
  expect(JSON.stringify(h.results().at(-1))).toContain('VIDEO_REVIEW_SOURCE_CHANGED')
  expect(JSON.stringify(h.review())).toBe(before)
})

it('preserves required review output and compacts optional timeline metadata at exact byte budgets', async () => {
  const h = await fixture()
  await h.run(h.call('scan'), h.record, undefined)
  await h.run(h.call('status'), undefined)
  const block = h.results().at(-1)?.content.find(value => value.type === 'text')
  if (block?.type !== 'text') throw Error('Missing review result')
  const { source_timeline_index: _index, ...required } = z.object({ source_timeline_index: z.unknown().optional() })
    .loose().parse(JSON.parse(block.text))
  await h.plugin.dispose()
  const limitedPlugin = h.ctx.plugin(Video, Video.Config({ requireCompleteReview: true, reviewBatchFrames: 2, reviewChunkSeconds: 2,
    reviewCompareMaxBytes: Buffer.byteLength(JSON.stringify(required)) }))
  await limitedPlugin.await()
  await h.run(h.call('status'), undefined)
  expect(h.results().at(-1)?.isError).toBe(false)
  const limited = h.results().at(-1)?.content.find(value => value.type === 'text')
  if (limited?.type !== 'text') throw Error('Missing bounded review result')
  expect(JSON.parse(limited.text)).toEqual(required)
  await limitedPlugin.dispose()
  const { windows: _windows, ...summary } = z.object({ windows: z.array(z.unknown()) }).loose().parse(_index)
  const compact = { ...required, source_timeline_index: { ...summary, index_omitted_for_budget: true } }
  await h.ctx.plugin(Video, Video.Config({ requireCompleteReview: true, reviewBatchFrames: 2, reviewChunkSeconds: 2,
    reviewCompareMaxBytes: Buffer.byteLength(JSON.stringify(compact)) })).await()
  await h.run(h.call('status'), undefined)
  expect(h.results().at(-1)?.isError).toBe(false)
  const reduced = h.results().at(-1)?.content.find(value => value.type === 'text')
  if (reduced?.type !== 'text') throw Error('Missing compact review result')
  expect(JSON.parse(reduced.text)).toEqual(compact)
})

it('finds cuts across the full episode, requires every image and observation, and preserves progress after reload', async () => {
  const h = await fixture()
  await h.run(h.call('scan'), undefined)
  expect(h.results().filter(result => result.isError)).toEqual([])
  expect(h.review()).toMatchObject({ scan_complete: true, scanned_until: 3 })
  expect(h.review().frames.some(frame => frame.reasons.includes('after_cut') && frame.time > 1.5)).toBe(true)
  expect(h.review().frames.some(frame => frame.reasons.includes('closing') && frame.time > 2.5)).toBe(true)
  expect(h.review().frames.filter(frame => frame.exposed)).toHaveLength(2)
  await h.run({ name: 'screenplay_export_docx', args: {} }, undefined)
  expect(JSON.stringify(h.results().at(-1))).toContain('VIDEO_REVIEW_PENDING')
  await h.run(h.record, undefined)
  const recorded = h.review().frames.filter(frame => frame.observation !== undefined).length
  expect(recorded).toBe(2)
  await h.plugin.dispose()
  await h.ctx.plugin(Video, h.config).await()
  expect(h.review().frames.filter(frame => frame.observation !== undefined)).toHaveLength(recorded)
  while (h.review().frames.some(frame => frame.observation === undefined)) await h.run(h.call('next'), h.record, undefined)
  await h.run({ name: 'present', args: { files: [{ path: h.manuscript }] } }, undefined)
  expect(h.results().at(-1)).toMatchObject({ isError: false, content: [{ type: 'text', text: `Presented ${h.manuscript}` }] })
  const updates = h.agent.session.snapshotEvents().filter(event => event.type === 'video/review' && event.data.kind === 'update')
  expect(updates.length).toBeGreaterThan(2)
  await appendFile(h.input, 'source revision')
  await h.run({ name: 'present', args: { files: [{ path: h.manuscript }] } }, undefined)
  expect(JSON.stringify(h.results().at(-1))).toContain('VIDEO_REVIEW_SOURCE_CHANGED')
}, 30_000)

it('refuses unseen frame claims, caller-selected frame budgets, and failed image requests', async () => {
  const h = await fixture()
  await h.run(h.call('scan'), 'fail')
  expect(h.review().frames.some(frame => frame.exposed)).toBe(false)
  await h.run(h.call('observe', { observations: [{ frame_id: h.review().frames.at(-1)!.id,
    visible: '画面中有一名站立的人物。', change: '人物进入。', uncertainty: '' }] }), undefined)
  expect(JSON.stringify(h.results().at(-1))).toContain('VIDEO_FRAME_NOT_VIEWED')
  await h.run(h.call('next', { frame_count: 1 }), undefined)
  expect(h.results().at(-1)?.isError).toBe(true)
  expect(h.review().frames.every(frame => frame.observation === undefined)).toBe(true)
}, 30_000)

it('compares recorded observations with the actual draft without completing pending images or requiring comparison for delivery', async () => {
  const h = await fixture()
  await h.run(h.call('scan'), h.record, undefined)
  const before = JSON.stringify(h.review())
  const observed: string[] = []
  h.ctx.on('fs/observed', (target, _observation, actor) => { if (actor !== undefined) observed.push(target.displayPath) })
  await h.run(h.call('compare', { draft_path: h.manuscript }), undefined)
  const result = h.results().at(-1)!
  expect(result.isError).toBe(false)
  const block = result.content.find(block => block.type === 'text')!
  if (block.type !== 'text') throw Error('Missing comparison')
  const { comparison } = z.object({ comparison: z.object({ advisory: z.boolean(), semantic_assessment: z.string(),
    observation_scope: z.string(), observations: z.array(z.unknown()), checks: z.string(),
    draft: z.object({ path: z.string(), sha256: z.string(), numbered_text: z.string() }) }) }).parse(JSON.parse(block.text))
  expect(comparison).toMatchObject({ advisory: true, semantic_assessment: 'not_performed',
    observation_scope: 'recorded_frames_only', draft: { path: h.manuscript } })
  expect(comparison.observations).toHaveLength(2)
  expect(comparison.draft.numbered_text).toContain('2: ▲红色背景切换为蓝色背景。')
  expect(comparison.checks).toContain('无对白反应')
  expect(comparison.checks).toContain('切镜不等于换场')
  expect(JSON.stringify(h.review())).toBe(before)
  expect(observed).toContain(h.manuscript)
  expect(result.content.filter(block => block.type === 'image')).toHaveLength(0)
  await appendFile(h.manuscript, '甲（低声）：等一下。\n')
  await h.run(h.call('compare', { draft_path: h.manuscript }), undefined)
  expect(JSON.stringify(h.results().at(-1))).toContain('等一下')
  expect(JSON.stringify(h.results().at(-1))).not.toContain(comparison.draft.sha256)
  while (h.review().frames.some(frame => frame.observation === undefined)) await h.run(h.call('next'), h.record, undefined)
  await h.run({ name: 'present', args: { files: [{ path: h.manuscript }] } }, undefined)
  expect(h.results().at(-1)?.isError).toBe(false)
}, 30_000)

it('returns source time windows and cached original image blocks without extraction or observation changes', async () => {
  const h = await fixture({ config: { reviewTimelineWindowSeconds: 1 } })
  const transcript = join(h.root, 'timeline-asr.json')
  await writeFile(transcript, JSON.stringify([{ start: 0, end: 1, text: '先别走。', speaker_id: '1' }]))
  await h.run(h.call('scan', { transcript_path: transcript }), h.record, undefined)
  const automaticallyReturned = h.results().at(-1)?.content.find(block => block.type === 'text')
  if (automaticallyReturned?.type !== 'text') throw Error('Missing ordinary observation result')
  expect(JSON.parse(automaticallyReturned.text)).toMatchObject({ source_timeline_index: {
    available: true, total_windows: 3, scan_complete: true, pending_frames: h.review().frames.length - 2,
    speech_status: 'available', speech_segment_count: 1,
    windows: [{ window_id: 'W00001', speech_segment_ids: ['S00001'] }, { window_id: 'W00002' }, { window_id: 'W00003' }],
  } })
  const before = JSON.stringify(h.review()), options = { windowSeconds: 1, maxTranscriptBytes: 4096,
    maxBytes: 100_000, maxFrames: 2 }
  const summary = Video.videoReviewSummaries(h.ctx, h.agent.session)[0]!
  expect(summary).toMatchObject({ path: h.input, transcript_reference: { path: transcript } })
  const frame = h.review().frames.find(value => value.observation !== undefined)!
  const extraction = vi.spyOn(h.ctx.subprocess, 'spawn')
  const result = await Video.readVideoSourceTimeline(h.ctx, h.agent.session, summary.review_id,
    { ...options, frameIds: [frame.id] }, new AbortController().signal)
  expect(result.timeline.speech?.segments[0]?.text).toBe('先别走。')
  expect(result.timeline.windows).toHaveLength(3)
  expect(result.content.filter(block => block.type === 'image')).toHaveLength(1)
  expect(result.content.some(block => block.type === 'text' && block.text.startsWith('VIDEO_FRAME '))).toBe(true)
  expect(extraction).not.toHaveBeenCalled()
  expect(JSON.stringify(h.review())).toBe(before)
  await h.run(h.call('timeline', { timeline_start_seconds: 1, timeline_end_seconds: 2 }), undefined)
  expect(h.results().at(-1)?.isError).toBe(false)
  const timelineText = h.results().at(-1)?.content.find(block => block.type === 'text')
  if (timelineText?.type !== 'text') throw Error('Missing source timeline')
  expect(JSON.parse(timelineText.text)).toMatchObject({ source_timeline: { scope: { full_episode: false } } })
  expect(JSON.stringify(h.review())).toBe(before)
}, 30_000)

it('keeps source timeline failures advisory and refuses stale sources, missing cache and oversized full results', async () => {
  const h = await fixture()
  const transcript = join(h.root, 'timeline-asr.json')
  await writeFile(transcript, JSON.stringify([{ start: 0, end: 1, text: '原台词。', speaker_id: '1' }]))
  await h.run(h.call('scan', { transcript_path: transcript }), h.record, undefined)
  const id = h.review().id, frame = h.review().frames.find(value => value.observation !== undefined)!
  const options = { windowSeconds: 1, maxTranscriptBytes: 4096, maxBytes: 100_000, maxFrames: 1 }
  const read = (extra = {}) => Video.readVideoSourceTimeline(h.ctx, h.agent.session, id,
    { ...options, ...extra }, new AbortController().signal)
  await expect(read({ frameIds: [frame.id], startSeconds: 2, endSeconds: 3 })).rejects.toThrow('VIDEO_TIMELINE_FRAME')
  await expect(read({ frameIds: [frame.id, frame.id] })).rejects.toThrow('VIDEO_TIMELINE_IMAGES')
  await expect(read({ maxBytes: 1 })).rejects.toThrow('VIDEO_TIMELINE_SIZE')
  await writeFile(transcript, JSON.stringify([{ start: 0, end: 1, text: '新台词。' }]))
  const stale = await read()
  expect(stale.timeline.speech).toBeUndefined()
  expect(stale.timeline.speech_unavailable).toBeDefined()
  expect(JSON.stringify(stale)).not.toContain('新台词')
  const cached = vi.spyOn(h.ctx.attachments, 'readImage').mockRejectedValueOnce(Error('missing cache'))
  await expect(read({ frameIds: [frame.id] })).rejects.toThrow('VIDEO_REVISIT_IMAGE_MISSING')
  cached.mockRestore()
  await appendFile(h.input, 'changed source')
  await expect(read()).rejects.toThrow('VIDEO_REVIEW_SOURCE_CHANGED')
  expect(h.review().frames.at(-1)?.observation).toBeUndefined()
}, 30_000)

it('returns same-directory successful-read ASR candidates and cached images when scan omitted an explicit transcript', async () => {
  const h = await fixture(), transcript = join(h.root, 'candidate-asr.json')
  await writeFile(transcript, JSON.stringify([{ start: 1, end: 2, text: '先放下茶杯。', speaker_id: '1' }]))
  await h.run(h.call('scan'), h.record, undefined)
  const before = JSON.stringify(h.review()), frame = h.review().frames.find(value => value.observation !== undefined)!
  const result = await Video.readVideoSourceTimeline(h.ctx, h.agent.session, h.review().id,
    { windowSeconds: 1, maxTranscriptBytes: 4096, maxBytes: 100_000, maxFrames: 1, frameIds: [frame.id],
      transcriptCandidates: { taskStartSeq: SessionSeq(0), reads: [{ path: transcript,
        readCallId: ToolCallId('successful-read'), readResultSeq: SessionSeq(1) },
      { path: join(h.root, 'missing.json'), readCallId: ToolCallId('missing-read'), readResultSeq: SessionSeq(2) }] } }, new AbortController().signal)
  expect(result.timeline.transcript_resolution).toMatchObject({ kind: 'successful_read_candidate', same_source_verified: false,
    reference: { path: transcript }, read_receipts: [{ readCallId: 'successful-read' }] })
  expect(result.timeline.speech?.segments[0]?.text).toBe('先放下茶杯。')
  expect(result.content.filter(block => block.type === 'image')).toHaveLength(1)
  expect(JSON.stringify(h.review())).toBe(before)
  expect(h.review().transcript_reference).toBeUndefined()
}, 30_000)

it.each(['explicit', 'candidate'])('drops %s ASR that changes while cached frames are read without resubmitting transcription or changing observations', async (association) => {
  const h = await fixture(), transcript = join(h.root, 'timeline-asr.json')
  await writeFile(transcript, JSON.stringify([{ start: 0, end: 1, text: '旧台词。', speaker_id: '1' }]))
  await h.run(h.call('scan', association === 'explicit' ? { transcript_path: transcript } : {}), h.record, undefined)
  const before = JSON.stringify(h.review()), frame = h.review().frames.find(value => value.observation !== undefined)!
  const original = h.ctx.attachments.readImage.bind(h.ctx.attachments)
  vi.spyOn(h.ctx.attachments, 'readImage').mockImplementation(async (...args) => {
    const image = await original(...args)
    await writeFile(transcript, JSON.stringify([{ start: 0, end: 1, text: '新台词。' }]))
    return image
  })
  const result = await Video.readVideoSourceTimeline(h.ctx, h.agent.session, h.review().id,
    { windowSeconds: 1, maxTranscriptBytes: 4096, maxBytes: 100_000, maxFrames: 1, frameIds: [frame.id],
      transcriptCandidates: { taskStartSeq: SessionSeq(0), reads: [{ path: transcript,
        readCallId: ToolCallId('successful-read'), readResultSeq: SessionSeq(1) },
      { path: join(h.root, 'missing.json'), readCallId: ToolCallId('missing-read'), readResultSeq: SessionSeq(2) }] } }, new AbortController().signal)
  expect(result.timeline.speech).toBeUndefined()
  expect(result.timeline.speech_unavailable?.reason).toContain('VIDEO_TRANSCRIPT_CHANGED')
  expect(result.timeline.transcript_resolution?.kind).toBe(association === 'explicit' ? 'explicit_reference' : 'unavailable')
  expect(result.content.filter(block => block.type === 'image')).toHaveLength(1)
  expect(JSON.stringify(result)).not.toContain('旧台词')
  expect(JSON.stringify(result)).not.toContain('新台词')
  expect(JSON.stringify(h.review())).toBe(before)
}, 30_000)

it('bounds the entire UTF-8 comparison and leaves delivery and observations unchanged after comparison failure', async () => {
  const h = await fixture({ config: { reviewCompareMaxBytes: 180 } })
  await h.run(h.call('scan'), h.record, undefined)
  while (h.review().frames.some(frame => frame.observation === undefined)) await h.run(h.call('next'), h.record, undefined)
  const before = JSON.stringify(h.review())
  await h.run(h.call('compare', { draft_path: h.manuscript }), undefined)
  expect(JSON.stringify(h.results().at(-1))).toContain('VIDEO_COMPARE_SIZE')
  expect(JSON.stringify(h.review())).toBe(before)
  expect(await readFile(h.manuscript, 'utf8')).toBe('# 第80集\n▲红色背景切换为蓝色背景。\n')
  await h.run({ name: 'present', args: { files: [{ path: h.manuscript }] } }, undefined)
  expect(h.results().at(-1)?.isError).toBe(false)
}, 30_000)

it('requires a saved bounded regular draft and preserves observations for invalid comparison inputs', async () => {
  const h = await fixture({ config: { reviewCompareMaxBytes: 180 } })
  await h.run(h.call('scan'), h.record, undefined)
  const before = JSON.stringify(h.review())
  await h.run(h.call('compare'), undefined)
  expect(JSON.stringify(h.results().at(-1))).toContain('VIDEO_COMPARE_DRAFT')
  for (const draft_path of [h.root, join(h.root, 'missing.md')]) {
    await h.run(h.call('compare', { draft_path }), undefined)
    expect(JSON.stringify(h.results().at(-1))).toContain('VIDEO_COMPARE_SIZE')
  }
  await writeFile(h.manuscript, '甲'.repeat(181))
  await h.run(h.call('compare', { draft_path: h.manuscript }), undefined)
  expect(JSON.stringify(h.results().at(-1))).toContain('VIDEO_COMPARE_SIZE')
  expect(JSON.stringify(h.review())).toBe(before)
}, 30_000)

it.each(['draft', 'video'] as const)('rejects comparison if the %s changes during the draft read', async (changed) => {
  const h = await fixture()
  await h.run(h.call('scan'), h.record, undefined)
  const before = JSON.stringify(h.review()), readBytes = h.ctx.fs.readBytes.bind(h.ctx.fs)
  const observed: string[] = []
  h.ctx.on('fs/observed', (target, _observation, actor) => { if (actor !== undefined) observed.push(target.displayPath) })
  vi.spyOn(h.ctx.fs, 'readBytes').mockImplementation(async (...args) => {
    const bytes = await readBytes(...args)
    if (args[0].displayPath === h.manuscript) await appendFile(changed === 'draft' ? h.manuscript : h.input, 'revision')
    return bytes
  })
  await h.run(h.call('compare', { draft_path: h.manuscript }), undefined)
  expect(JSON.stringify(h.results().at(-1))).toContain('VIDEO_COMPARE_CHANGED')
  expect(JSON.stringify(h.review())).toBe(before)
  expect(observed).not.toContain(h.manuscript)
}, 30_000)

it('orders context frames by source time and retains uncertainty without inventing correspondence', () => {
  const frame = (id: string, time: number, uncertainty: string) => ({ id, time, reasons: ['uncertainty_context'], exposed: true,
    observation: { visible: '男子在门边抬起手臂，女子背向他。', change: '手臂位置发生变化。', uncertainty } })
  const result = compareReviewDraft({ id: VideoReviewId('review'), path: 'video.mp4', episode: '第1集', source_version: 'v1',
    duration: 3, scan_complete: true, scanned_until: 3,
    frames: [frame('F00001', 2, '是否碰到手臂不清楚'), frame('F00002', 1, '')] },
  { path: 'draft.md', version: 'v2', text: '甲（抬手）：等一下。' })
  expect(result.observations.map(frame => frame.frame_id)).toEqual(['F00002', 'F00001'])
  expect(result.observations[1]?.uncertainty).toBe('是否碰到手臂不清楚')
  expect(result).not.toHaveProperty('coverage_passed')
})

it('records optional event groups and saved speech, resumes them, and compares current evidence without changing observation completion', async () => {
  const h = await fixture()
  const transcript = join(h.root, 'episode-asr.json')
  const segments = [{ start: 0, end: 0.8, text: '等一下，', speaker_id: '1' },
    { start: 0.9, end: 1.2, text: '先别走。', speaker_id: '1' },
    { start: 1.3, end: 2, text: '啊？', speaker_id: '2' }]
  await writeFile(transcript, JSON.stringify(segments))
  await h.run(h.call('scan', { transcript_path: transcript }), h.record, undefined)
  expect(JSON.stringify(h.results())).toContain('continuous_speech_candidates')
  const count = h.review().frames.filter(frame => frame.observation !== undefined).length
  const event = { event_id: 'E1', frame_ids: [h.review().frames[0]!.id, h.review().frames[1]!.id],
    actor: '', action: '背景色发生变化', object: '', before: '合成背景', after: '合成背景', uncertainty: '纯合成画面，无人物动作' }
  await h.run(h.call('events', { event_groups: [event], transcript_path: transcript }), undefined)
  expect(h.results().at(-1)?.isError).toBe(false)
  expect(h.review().event_groups).toHaveLength(1)
  expect(h.review().frames.filter(frame => frame.observation !== undefined)).toHaveLength(count)
  await h.plugin.dispose()
  await h.ctx.plugin(Video, h.config).await()
  expect(h.review().event_groups?.[0]?.event_id).toBe('E1')
  const observed: string[] = []
  h.ctx.on('fs/observed', (target, _observation, actor) => { if (actor !== undefined) observed.push(target.displayPath) })
  await h.run(h.call('compare', { draft_path: h.manuscript, transcript_path: transcript }), undefined)
  expect(h.results().at(-1)?.isError).toBe(false)
  const text = JSON.stringify(h.results().at(-1))
  expect(text).toContain('speaker_identity_unverified')
  expect(text).toContain('literal_draft_candidates')
  expect(text).toContain('ungrouped_recorded_frame_ids')
  expect(text).toContain('asr.json')
  expect(observed).toEqual(expect.arrayContaining([h.manuscript, transcript]))
  await h.run(h.call('observe', { observations: [{ frame_id: event.frame_ids[0],
    visible: '画面是完整红色背景，没有可见人物。', change: '重新核对过的观察。', uncertainty: '' }] }), undefined)
  await h.run(h.call('compare', { draft_path: h.manuscript }), undefined)
  expect(JSON.stringify(h.results().at(-1))).toContain('evidence_current\\\":false')
  await h.run(h.call('events', { event_groups: [] }), undefined)
  expect(h.review().event_groups).toEqual([])
  while (h.review().frames.some(frame => frame.observation === undefined)) await h.run(h.call('next'), h.record, undefined)
  await h.run({ name: 'present', args: { files: [{ path: h.manuscript }] } }, undefined)
  expect(h.results().at(-1)?.isError).toBe(false)
}, 30_000)

it('rejects invalid or oversized event notes before committing optional event state', async () => {
  const h = await fixture({ config: { reviewCompareMaxBytes: 180 } })
  await h.run(h.call('scan'), h.record, undefined)
  const before = JSON.stringify(h.review())
  await h.run(h.call('events'), undefined)
  expect(JSON.stringify(h.results().at(-1))).toContain('VIDEO_EVENT_INPUT')
  const event = { event_id: 'E1', frame_ids: [h.review().frames[0]!.id],
    actor: '', action: '背景颜色没有变化', object: '', before: '', after: '', uncertainty: '' }
  await h.run(h.call('events', { event_groups: [event] }), undefined)
  expect(JSON.stringify(h.results().at(-1))).toContain('VIDEO_COMPARE_SIZE')
  expect(JSON.stringify(h.review())).toBe(before)
  await h.run(h.call('events', { event_groups: [{ ...event, frame_ids: ['missing'] }] }), undefined)
  expect(JSON.stringify(h.results().at(-1))).toContain('VIDEO_EVENT_FRAME')
  expect(JSON.stringify(h.review())).toBe(before)
}, 30_000)

it('publishes event reports under distinct content filenames without replacing the completed frame-only report', async () => {
  const h = await fixture()
  await h.run(h.call('scan'), h.record, undefined)
  while (h.review().frames.some(frame => frame.observation === undefined)) await h.run(h.call('next'), h.record, undefined)
  const before = reportPath(h), contents = await readFile(before, 'utf8')
  await h.run(h.call('events', { event_groups: [{ event_id: 'E1', frame_ids: [h.review().frames[0]!.id],
    actor: '', action: '呈现红色背景', object: '', before: '', after: '红色背景', uncertainty: '' }] }), undefined)
  expect(h.results().at(-1)?.isError).toBe(false)
  const after = reportPath(h)
  expect(after).not.toBe(before)
  expect(await readFile(before, 'utf8')).toBe(contents)
  expect(await readFile(after, 'utf8')).toContain('"event_groups"')
  await h.run(h.call('status'), undefined)
  expect(reportPath(h)).toBe(after)
}, 30_000)

it('keeps transcript-linked report digests stable across workspace roots while distinguishing relative ASR locations', async () => {
  const digest = (path: string) => /([a-f0-9]{64})\.json$/.exec(path)?.[1]
  const first = await fixture(), second = await fixture()
  const source = JSON.stringify([{ start: 0, end: 1, text: '同一份原始转写。' }])
  for (const h of [first, second]) {
    const transcript = join(h.root, 'episode-asr.json')
    await writeFile(transcript, source)
    const stat = h.ctx.fs.stat.bind(h.ctx.fs)
    vi.spyOn(h.ctx.fs, 'stat').mockImplementation(async (...args) => {
      const value = await stat(...args)
      return args[0].displayPath.endsWith('-asr.json') && value !== undefined ? { ...value, version: FsVersion('asr-v1') } : value
    })
    await h.run(h.call('scan', { transcript_path: transcript }), h.record, undefined)
    while (h.review().frames.some(frame => frame.observation === undefined)) await h.run(h.call('next'), h.record, undefined)
  }
  const firstPath = reportPath(first), secondPath = reportPath(second)
  expect(digest(firstPath)).toMatch(/^[a-f0-9]{64}$/)
  expect(digest(firstPath)).toBe(digest(secondPath))
  const before = await readFile(firstPath, 'utf8')
  expect(before).toContain(JSON.stringify(join(first.root, 'episode-asr.json')))
  expect(await readFile(secondPath, 'utf8')).toContain(JSON.stringify(join(second.root, 'episode-asr.json')))
  const different = join(first.root, 'alternate-asr.json')
  await writeFile(different, source)
  await first.run(first.call('status', { transcript_path: different }), undefined)
  expect(first.results().at(-1)?.isError).toBe(false)
  expect(digest(reportPath(first))).not.toBe(digest(firstPath))
  expect(await readFile(firstPath, 'utf8')).toBe(before)
}, 30_000)

it('uses the complete serialized UTF-8 byte length at an exact comparison limit', async () => {
  const h = await fixture()
  await h.run(h.call('scan'), h.record, undefined)
  await writeFile(h.manuscript, '# 第80集\n▲红色背景。\n甲：等一下。\n')
  await h.run(h.call('compare', { draft_path: h.manuscript }), undefined)
  const block = h.results().at(-1)!.content.find(block => block.type === 'text')!
  if (block.type !== 'text') throw Error('Missing comparison')
  const bytes = Buffer.byteLength(block.text)
  expect(bytes).toBeGreaterThan(block.text.length)
  const limited = (reviewCompareMaxBytes: number) => Video.Config({ requireCompleteReview: true, reviewBatchFrames: 2,
    reviewChunkSeconds: 2, reviewCompareMaxBytes })
  await h.plugin.dispose()
  const exact = h.ctx.plugin(Video, limited(bytes))
  await exact.await()
  await h.run(h.call('compare', { draft_path: h.manuscript }), undefined)
  expect(h.results().at(-1)?.isError).toBe(false)
  await exact.dispose()
  await h.ctx.plugin(Video, limited(bytes - 1)).await()
  await h.run(h.call('compare', { draft_path: h.manuscript }), undefined)
  expect(JSON.stringify(h.results().at(-1))).toContain('VIDEO_COMPARE_SIZE')
}, 30_000)

it('checks the completed event report wrapper before committing event notes at an exact byte limit', async () => {
  const h = await fixture()
  await h.run(h.call('scan'), h.record, undefined)
  while (h.review().frames.some(frame => frame.observation === undefined)) await h.run(h.call('next'), h.record, undefined)
  const event = { event_id: 'E1', frame_ids: [h.review().frames[0]!.id],
    actor: '', action: '呈现红色背景', object: '', before: '', after: '红色背景', uncertainty: '' }
  await h.run(h.call('events', { event_groups: [event] }), undefined)
  const block = h.results().at(-1)!.content.find(block => block.type === 'text')!
  if (block.type !== 'text') throw Error('Missing event result')
  const { source_timeline_index: _optionalIndex, ...requiredResult } = z.object({ source_timeline_index: z.unknown().optional() })
    .loose().parse(JSON.parse(block.text))
  const bytes = Buffer.byteLength(JSON.stringify(requiredResult))
  await h.run(h.call('events', { event_groups: [] }), undefined)
  const before = JSON.stringify(h.review()), reportRoot = join(h.root, '.muse/video-observations')
  const reports = await readdir(reportRoot)
  const reportBytes = await Promise.all(reports.map(name => readFile(join(reportRoot, name), 'utf8')))
  const limited = (reviewCompareMaxBytes: number) => Video.Config({ requireCompleteReview: true, reviewBatchFrames: 2,
    reviewChunkSeconds: 2, reviewCompareMaxBytes })
  await h.plugin.dispose()
  const short = h.ctx.plugin(Video, limited(bytes - 1))
  await short.await()
  await h.run(h.call('events', { event_groups: [{ ...event, event_id: 'E2' }] }), undefined)
  expect(JSON.stringify(h.results().at(-1))).toContain('VIDEO_COMPARE_SIZE')
  expect(JSON.stringify(h.review())).toBe(before)
  expect(await readdir(reportRoot)).toEqual(reports)
  expect(await Promise.all(reports.map(name => readFile(join(reportRoot, name), 'utf8')))).toEqual(reportBytes)
  await short.dispose()
  await h.ctx.plugin(Video, limited(bytes)).await()
  await h.run(h.call('events', { event_groups: [{ ...event, event_id: 'E2' }] }), undefined)
  expect(h.results().at(-1)?.isError).toBe(false)
  expect(h.review().event_groups?.[0]?.event_id).toBe('E2')
}, 30_000)

it('rejects transcript changes and complete-result overflow without pretending partial ASR is complete', async () => {
  const h = await fixture({ config: { reviewCompareMaxBytes: 2000 } })
  await h.run(h.call('scan'), h.record, undefined)
  const transcript = join(h.root, 'episode-asr.json')
  await writeFile(transcript, JSON.stringify([{ start: 0, end: 1, text: '等一下。', speaker_id: '1' }]))
  const before = JSON.stringify(h.review()), readBytes = h.ctx.fs.readBytes.bind(h.ctx.fs)
  const read = vi.spyOn(h.ctx.fs, 'readBytes').mockImplementation(async (...args) => {
    const bytes = await readBytes(...args)
    if (args[0].displayPath === transcript) await appendFile(transcript, ' ')
    return bytes
  })
  await h.run(h.call('status', { transcript_path: transcript }), undefined)
  expect(JSON.stringify(h.results().at(-1))).toContain('VIDEO_TRANSCRIPT_CHANGED')
  read.mockRestore()
  await writeFile(transcript, JSON.stringify([{ start: 0, end: 1, text: '甲'.repeat(1000), speaker_id: '1' }]))
  await h.run(h.call('status', { transcript_path: transcript }), undefined)
  expect(JSON.stringify(h.results().at(-1))).toContain('VIDEO_COMPARE_SIZE')
  expect(JSON.stringify(h.review())).toBe(before)
}, 30_000)

it('reuses the saved transcript safely beside events and comparison after reload without requiring the path again', async () => {
  const h = await fixture()
  const transcript = join(h.root, 'episode-asr.json')
  await writeFile(transcript, JSON.stringify([{ start: 0, end: 1, text: '先别走。', speaker_id: '1' }]))
  await h.run(h.call('scan', { transcript_path: transcript }), h.record, undefined)
  const reference = h.review().transcript_reference
  expect(reference).toMatchObject({ path: transcript })
  const note = { event_id: 'E1', frame_ids: [h.review().frames[0]!.id],
    actor: '', action: '红色背景', object: '', before: '', after: '', uncertainty: '' }
  await h.run(h.call('events', { event_groups: [note] }), undefined)
  expect(h.results().at(-1)?.isError).toBe(false)
  expect(JSON.stringify(h.results().at(-1))).toContain('先别走')
  expect(JSON.stringify(h.results().at(-1))).toContain('model_authored_observations')
  await h.plugin.dispose()
  await h.ctx.plugin(Video, h.config).await()
  expect(h.review().transcript_reference).toEqual(reference)
  await h.run(h.call('compare', { draft_path: h.manuscript }), undefined)
  expect(h.results().at(-1)?.isError).toBe(false)
  expect(JSON.stringify(h.results().at(-1))).toContain('先别走')
  await writeFile(transcript, JSON.stringify([{ start: 0, end: 1, text: '全新ASR台词。', speaker_id: '1' }]))
  await h.run(h.call('events', { event_groups: [{ ...note, action: '仍为红色背景' }] }), undefined)
  expect(h.results().at(-1)?.isError).toBe(false)
  expect(JSON.stringify(h.results().at(-1))).toContain('speech_unavailable')
  expect(JSON.stringify(h.results().at(-1))).not.toContain('全新ASR台词')
  expect(h.review().transcript_reference).toEqual(reference)
  await h.run(h.call('compare', { draft_path: h.manuscript }), undefined)
  expect(h.results().at(-1)?.isError).toBe(false)
  expect(JSON.stringify(h.results().at(-1))).toContain('speech_unavailable')
  await h.run(h.call('status', { transcript_path: transcript }), undefined)
  expect(h.results().at(-1)?.isError).toBe(false)
  expect(JSON.stringify(h.results().at(-1))).toContain('全新ASR台词')
  expect(h.review().transcript_reference?.sha256).not.toBe(reference?.sha256)
  await rm(transcript)
  await h.run(h.call('events', { event_groups: [] }), undefined)
  expect(h.results().at(-1)?.isError).toBe(false)
  expect(h.review().event_groups).toEqual([])
  expect(JSON.stringify(h.results().at(-1))).toContain('speech_unavailable')
  const oldId = h.review().id
  await appendFile(h.input, 'new video revision')
  await h.run(h.call('scan'), undefined)
  expect(h.results().at(-1)?.isError).toBe(false)
  expect(h.review().id).not.toBe(oldId)
  expect(h.review().transcript_reference).toBeUndefined()
  expect(JSON.stringify(h.results().at(-1))).not.toContain('speech_unavailable')
}, 30_000)

it('keeps implicit ASR output optional when the whole result cannot retain its complete raw segments', async () => {
  const h = await fixture()
  const transcript = join(h.root, 'episode-asr.json')
  await writeFile(transcript, JSON.stringify([{ start: 0, end: 1, text: '甲'.repeat(5000), speaker_id: '1' }]))
  await h.run(h.call('scan', { transcript_path: transcript }), h.record, undefined)
  const reference = h.review().transcript_reference
  await h.plugin.dispose()
  await h.ctx.plugin(Video, Video.Config({ requireCompleteReview: true, reviewBatchFrames: 2, reviewChunkSeconds: 2,
    reviewCompareMaxBytes: 7000 })).await()
  await h.run(h.call('status'), undefined)
  expect(h.results().at(-1)?.isError).toBe(false)
  expect(JSON.stringify(h.results().at(-1))).toContain('speech_unavailable')
  expect(JSON.stringify(h.results().at(-1))).toContain('VIDEO_COMPARE_SIZE')
  await h.run(h.call('events', { event_groups: [] }), undefined)
  expect(h.results().at(-1)?.isError).toBe(false)
  expect(h.review().transcript_reference).toEqual(reference)
  await h.run(h.call('compare', { draft_path: h.manuscript }), undefined)
  expect(h.results().at(-1)?.isError).toBe(false)
  expect(JSON.stringify(h.results().at(-1))).toContain('speech_unavailable')
  await h.run(h.call('status', { transcript_path: transcript }), undefined)
  expect(JSON.stringify(h.results().at(-1))).toContain('VIDEO_COMPARE_SIZE')
}, 30_000)

it('does not persist a new explicit transcript reference or event notes when their complete output exceeds the limit', async () => {
  const h = await fixture({ config: { reviewCompareMaxBytes: 180 } })
  await h.run(h.call('scan'), h.record, undefined)
  const transcript = join(h.root, 'episode-asr.json')
  await writeFile(transcript, JSON.stringify([{ start: 0, end: 1, text: '小心。' }]))
  const before = JSON.stringify(h.review())
  await h.run(h.call('status', { transcript_path: transcript }), undefined)
  expect(JSON.stringify(h.results().at(-1))).toContain('VIDEO_COMPARE_SIZE')
  expect(JSON.stringify(h.review())).toBe(before)
  await h.run(h.call('revisit', { transcript_path: transcript, frame_ids: [h.review().frames[0]!.id] }), undefined)
  expect(JSON.stringify(h.results().at(-1))).toContain('VIDEO_COMPARE_SIZE')
  expect(JSON.stringify(h.review())).toBe(before)
  await h.run(h.call('events', { transcript_path: transcript, event_groups: [{ event_id: 'E1',
    frame_ids: [h.review().frames[0]!.id], actor: '', action: '红色背景', object: '', before: '', after: '', uncertainty: '' }] }), undefined)
  expect(JSON.stringify(h.results().at(-1))).toContain('VIDEO_COMPARE_SIZE')
  expect(JSON.stringify(h.review())).toBe(before)
}, 30_000)

it('detects a saved ASR digest mismatch even if its reported filesystem version is unchanged', async () => {
  const h = await fixture()
  const transcript = join(h.root, 'episode-asr.json')
  await writeFile(transcript, JSON.stringify([{ start: 0, end: 1, text: '原句。' }]))
  await h.run(h.call('scan', { transcript_path: transcript }), undefined)
  const reference = h.review().transcript_reference!
  await writeFile(transcript, JSON.stringify([{ start: 0, end: 1, text: '新句。' }]))
  const stat = h.ctx.fs.stat.bind(h.ctx.fs)
  vi.spyOn(h.ctx.fs, 'stat').mockImplementation(async (...args) => {
    const result = await stat(...args)
    return args[0].displayPath === transcript && result !== undefined ? { ...result, version: FsVersion(reference.version) } : result
  })
  await h.run(h.call('status'), undefined)
  expect(h.results().at(-1)?.isError).toBe(false)
  expect(JSON.stringify(h.results().at(-1))).toContain('文件摘要变化')
  expect(JSON.stringify(h.results().at(-1))).not.toContain('新句')
  expect(h.review().transcript_reference).toEqual(reference)
}, 30_000)

it('puts referenced event observations beside their summary even when those frames are outside the normal status batch', async () => {
  const h = await fixture()
  await h.run(h.call('scan'), h.record, undefined)
  while (h.review().frames.some(frame => frame.observation === undefined)) await h.run(h.call('next'), h.record, undefined)
  const frame = h.review().frames.at(-1)!
  await h.run(h.call('events', { event_groups: [{ event_id: 'E1', frame_ids: [frame.id],
    actor: '', action: '总结的蓝色背景', object: '', before: '', after: '', uncertainty: '' }] }), undefined)
  const block = h.results().at(-1)!.content.find(block => block.type === 'text')!
  if (block.type !== 'text') throw Error('Missing evidence')
  const parsed = z.object({ frames: z.array(z.object({ id: z.string() })), event_groups: z.array(z.object({
    evidence_source: z.string(), evidence: z.array(z.object({ frame_id: z.string(), visible: z.string() })),
  })) }).parse(JSON.parse(block.text))
  expect(parsed.frames.some(row => row.id === frame.id)).toBe(false)
  expect(parsed.event_groups[0]).toMatchObject({ evidence_source: 'model_authored_observations',
    evidence: [{ frame_id: frame.id, visible: frame.observation!.visible }] })
}, 30_000)

it('revisits recorded cached images beside the original notes without decoding, resetting progress or rewriting reports', async () => {
  const h = await fixture()
  await h.run(h.call('scan'), h.record, undefined)
  while (h.review().frames.some(frame => frame.observation === undefined)) await h.run(h.call('next'), h.record, undefined)
  const before = JSON.stringify(h.review()), frames = h.review().frames.slice(-2)
  const reportRoot = join(h.root, '.muse/video-observations'), reports = await readdir(reportRoot)
  const reportBytes = await Promise.all(reports.map(name => readFile(join(reportRoot, name), 'utf8')))
  const media = vi.spyOn(Media, 'runMedia')
  await h.run(h.call('revisit', { frame_ids: frames.map(frame => frame.id) }), undefined)
  expect(h.results().at(-1)?.isError).toBe(false)
  expect(h.results().at(-1)!.content.filter(block => block.type === 'image').map(block => block.attachment.attachmentId))
    .toEqual(frames.map(frame => frame.image!.attachmentId))
  expect(JSON.stringify(h.results().at(-1))).toContain('重看缓存原图')
  expect(JSON.stringify(h.results().at(-1))).toContain('revisited')
  expect(JSON.stringify(h.review())).toBe(before)
  expect(media).not.toHaveBeenCalled()
  expect(await readdir(reportRoot)).toEqual(reports)
  expect(await Promise.all(reports.map(name => readFile(join(reportRoot, name), 'utf8')))).toEqual(reportBytes)
  await h.run({ name: 'present', args: { files: [{ path: h.manuscript }] } }, undefined)
  expect(h.results().at(-1)?.isError).toBe(false)
}, 30_000)

it('allows an explicit ASR association during revisit without changing frames or writing a replacement observation report', async () => {
  const h = await fixture()
  await h.run(h.call('scan'), h.record, undefined)
  while (h.review().frames.some(frame => frame.observation === undefined)) await h.run(h.call('next'), h.record, undefined)
  const before = JSON.stringify(h.review().frames), transcript = join(h.root, 'episode-asr.json')
  const reportRoot = join(h.root, '.muse/video-observations'), reports = await readdir(reportRoot)
  await writeFile(transcript, JSON.stringify([{ start: 0, end: 1, text: '回看这句。' }]))
  const frame_ids = [h.review().frames[0]!.id]
  await h.run(h.call('revisit', { frame_ids, transcript_path: transcript }), undefined)
  expect(h.results().at(-1)?.isError).toBe(false)
  expect(h.review().transcript_reference?.path).toBe(transcript)
  expect(JSON.stringify(h.results().at(-1))).toContain('回看这句')
  expect(JSON.stringify(h.review().frames)).toBe(before)
  expect(await readdir(reportRoot)).toEqual(reports)
  await h.run(h.call('revisit', { frame_ids }), undefined)
  expect(h.results().at(-1)?.isError).toBe(false)
  expect(JSON.stringify(h.results().at(-1))).toContain('回看这句')
  expect(await readdir(reportRoot)).toEqual(reports)
}, 30_000)

it('rejects invalid revisit selections and missing image caches without decoding or altering observations', async () => {
  const h = await fixture()
  await h.run(h.call('scan'), h.record, undefined)
  const before = JSON.stringify(h.review()), id = h.review().frames[0]!.id
  const media = vi.spyOn(Media, 'runMedia')
  for (const frame_ids of [[], [id, id], [id, 'F00002', 'F00003'], ['missing'], ['F00003']]) {
    await h.run(h.call('revisit', { frame_ids }), undefined)
    expect(h.results().at(-1)?.isError).toBe(true)
  }
  vi.spyOn(h.ctx.attachments, 'readImage').mockRejectedValue(new Error('cached image unavailable'))
  await h.run(h.call('revisit', { frame_ids: [id] }), undefined)
  expect(JSON.stringify(h.results().at(-1))).toContain('VIDEO_REVISIT_IMAGE_MISSING')
  expect(JSON.stringify(h.review())).toBe(before)
  expect(media).not.toHaveBeenCalled()
}, 30_000)

it('rejects a video revision change during cached-image revisit without replacing its recorded notes', async () => {
  const h = await fixture()
  await h.run(h.call('scan'), h.record, undefined)
  const before = JSON.stringify(h.review()), readImage = h.ctx.attachments.readImage.bind(h.ctx.attachments)
  vi.spyOn(h.ctx.attachments, 'readImage').mockImplementation(async (...args) => {
    const result = await readImage(...args)
    await appendFile(h.input, 'changed during revisit')
    return result
  })
  await h.run(h.call('revisit', { frame_ids: [h.review().frames[0]!.id] }), undefined)
  expect(JSON.stringify(h.results().at(-1))).toContain('VIDEO_REVIEW_SOURCE_CHANGED')
  expect(JSON.stringify(h.review())).toBe(before)
}, 30_000)

it('retains cumulative within-shot appearance changes rather than comparing only adjacent frames', () => {
  const config = Video.Config({ reviewAnalysisFps: 4, reviewChangeThreshold: 0.12, reviewCheckpointSeconds: 20 })
  const size = 48 * 32 * 3
  const bytes = Buffer.concat([0, 10, 20, 30, 40, 50].map(value => Buffer.alloc(size, value)))
  expect(appearanceCandidates(bytes, config, 0, 1.5)).toEqual([0, 1])
  expect(() => appearanceCandidates(bytes.subarray(1), config, 0, 1.5)).toThrow('VIDEO_SCAN_INCOMPLETE')
})

const acceptanceSource = process.env.MUSE_VIDEO_REVIEW_ACCEPT_SOURCE
it.runIf(Boolean(acceptanceSource))('scans the entire existing local episode without submitting transcription or rewriting source media', async () => {
  const defaults = Video.Config({})
  const h = await fixture({ config: { reviewChunkSeconds: defaults.reviewChunkSeconds, reviewBatchFrames: defaults.reviewBatchFrames } })
  await copyFile(acceptanceSource!, h.input)
  const started = Date.now()
  await h.run(h.call('scan'), undefined)
  const errors = h.results().filter(result => result.isError)
  expect(errors).toEqual([])
  const review = h.review()
  expect(review.scan_complete).toBe(true)
  expect(review.scanned_until).toBe(review.duration)
  expect(review.frames.at(-1)!.time).toBeGreaterThan(review.duration - 1)
  const output = join(process.cwd(), '.artifacts/video-observation-20261023')
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'local-episode-scan.json'), JSON.stringify({ source: acceptanceSource,
    seconds: review.duration, elapsedMs: Date.now() - started, frames: review.frames.length,
    config: { chunkSeconds: h.config.reviewChunkSeconds, batchFrames: h.config.reviewBatchFrames },
    cuts: review.frames.filter(frame => frame.reasons.includes('after_cut')).length,
    presented: review.frames.filter(frame => frame.exposed).length,
    pending: review.frames.filter(frame => frame.observation === undefined).length,
    observations: review.frames.map(({ image: _image, ...frame }) => frame) }, null, 2))
}, 120_000)

it('does not accept a same-program observation before the next actual image request', async () => {
  const h = await fixture({ ptc: true })
  await h.run({ name: 'run_code', args: { description: 'Try claiming a newly extracted frame without a model step.',
    code: `await tools.video_inspect(${JSON.stringify(h.call('scan').args)});`
      + `await tools.video_inspect(${JSON.stringify(h.call('observe', { observations: [{ frame_id: 'F00001',
        visible: '画面是合成的红色背景，没有人物或道具。', change: '初始画面。', uncertainty: '' }] }).args)});` } }, undefined)
  expect(JSON.stringify(h.results())).toContain('VIDEO_FRAME_NOT_VIEWED')
  expect(h.review().frames.every(frame => frame.observation === undefined)).toBe(true)
}, 30_000)

it('detects cumulative changes during an actual pan even when cut detection is intentionally insensitive', async () => {
  const h = await fixture({ config: { sceneThreshold: 0.99 } })
  await rm(h.input)
  const ffmpeg = await h.ctx.subprocess.resolveExecutable('ffmpeg')
  await runMedia(h.ctx, [ffmpeg, '-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
    'color=gray:s=384x64:r=10:d=3,drawbox=x=180:y=0:w=100:h=64:c=red:t=fill,crop=96:64:x=8*n:y=0',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', h.input], { mode: 'danger-full-access', workspaceRoot: h.root }, undefined,
  { timeoutMs: 20_000, maxBytes: 1024, graceMs: 1000 })
  await h.run(h.call('scan'), undefined)
  expect(h.results().filter(result => result.isError)).toEqual([])
  expect(h.review().frames.filter(frame => frame.reasons.includes('appearance_or_continuity') && frame.time > 0.5).length).toBeGreaterThan(2)
}, 30_000)

it('adds bounded adjacent observations when a viewed frame remains uncertain', async () => {
  const h = await fixture()
  await h.run(h.call('scan'), undefined)
  const count = h.review().frames.length
  const first = h.review().frames[0]!
  await h.run(h.call('observe', { observations: [{ frame_id: first.id,
    visible: '画面是红色背景，没有可确认的人物或道具。', change: '初始画面。', uncertainty: '需要结合前后画面核实。' }] }), undefined)
  expect(h.review().frames.length).toBeGreaterThan(count)
  expect(h.review().frames.some(frame => frame.reasons.includes('uncertainty_context') && !frame.exposed)).toBe(true)
  await h.run({ name: 'present', args: { files: [{ path: h.manuscript }] } }, undefined)
  expect(JSON.stringify(h.results().at(-1))).toContain('VIDEO_REVIEW_PENDING')
}, 30_000)

it.each([false, true])('records omitted uncertainty as an empty string without context expansion in ptc=%s', async (ptc) => {
  const h = await fixture({ ptc })
  const route = (call: { name: string; args: object }) => ptc ? { name: 'run_code', args: {
    description: 'Record an observed frame without an uncertainty concern.', code: `await tools.video_inspect(${JSON.stringify(call.args)});`,
  } } : call
  await h.run(route(h.call('scan')), undefined)
  const count = h.review().frames.length, frame = h.review().frames[0]!
  await h.run(route(h.call('observe', { observations: [{ frame_id: frame.id,
    visible: '画面是合成红色背景，没有可见人物或道具。', change: '初始画面。' }] })), undefined)
  expect(h.results().at(-1)?.isError).toBe(false)
  expect(h.review().frames).toHaveLength(count)
  expect(h.review().frames[0]?.observation).toEqual({ visible: '画面是合成红色背景，没有可见人物或道具。',
    change: '初始画面。', uncertainty: '' })
}, 30_000)

it.each([null, 42])('rejects a non-string uncertainty value %j without recording or expanding frames', async (uncertainty) => {
  const h = await fixture()
  await h.run(h.call('scan'), undefined)
  const before = JSON.stringify(h.review())
  await h.run(h.call('observe', { observations: [{ frame_id: h.review().frames[0]!.id,
    visible: '画面是合成红色背景，没有可见人物或道具。', change: '初始画面。', uncertainty }] }), undefined)
  expect(h.results().at(-1)?.isError).toBe(true)
  expect(JSON.stringify(h.review())).toBe(before)
}, 30_000)

it.each(['无', '无。', '无疑点！', '无新增疑点', '没有新增疑点。', '未发现新增疑点', ' None. ', ' n / a； '])('retains the empty marker %s without expanding context frames', async (uncertainty) => {
  const h = await fixture()
  await h.run(h.call('scan'), undefined)
  const count = h.review().frames.length
  await h.run(h.call('observe', { observations: [{ frame_id: h.review().frames[0]!.id,
    visible: '画面是红色背景，没有可见人物或道具。', change: '初始画面。', uncertainty }] }), undefined)
  expect(h.results().at(-1)?.isError).toBe(false)
  expect(h.review().frames).toHaveLength(count)
  expect(h.review().frames[0]?.observation?.uncertainty).toBe(uncertainty.trim())
}, 30_000)

it.each(['status', 'next', 'observe'])('requires an episode scan before %s', async (method) => {
  const h = await fixture()
  await h.run(h.call(method), undefined)
  expect(JSON.stringify(h.results().at(-1))).toContain('VIDEO_REVIEW_REQUIRED')
})

it('keeps metadata-only queries outside the observation gate and supports cached scans and status', async () => {
  const h = await fixture()
  await h.run(h.call('metadata'), { name: 'present', args: { files: [{ path: h.manuscript }] } }, undefined)
  expect(h.results().some(result => result.isError)).toBe(false)
  await h.run(h.call('scan'), h.call('status'), h.call('scan'), undefined)
  expect(h.review().frames.filter(frame => frame.image !== undefined)).toHaveLength(2)
  expect(h.results().at(-1)?.isError).toBe(false)
})

it.each(['empty', 'excessive', 'duplicate', 'placeholder'])('rejects %s observation submissions without advancing pending frames', async (kind) => {
  const h = await fixture()
  await h.run(h.call('scan'), undefined)
  const note = { frame_id: 'F00001', visible: '画面为红色背景，没有可见人物或道具。', change: '初始画面。', uncertainty: '' }
  const observations = kind === 'empty' ? [] : kind === 'excessive' ? [note, note, note] : kind === 'duplicate' ? [note, note]
    : [{ ...note, visible: '已查看。。。。。' }]
  await h.run(h.call('observe', { observations }), undefined)
  expect(h.results().at(-1)?.isError).toBe(true)
  expect(h.review().frames.every(frame => frame.observation === undefined)).toBe(true)
})

it.each(['size', 'duration', 'pixels', 'candidates', 'scan_bytes'])('fails explicitly at the %s budget instead of claiming complete coverage', async (budget) => {
  const config = budget === 'size' ? { maxSourceBytes: 1 } : budget === 'duration' ? { maxDurationSeconds: 1 }
    : budget === 'pixels' ? { maxSourcePixels: 1 } : budget === 'scan_bytes' ? { reviewMaxScanBytes: 1 } : { reviewMaxFrames: 2 }
  const h = await fixture({ config })
  await h.run(h.call('scan'), undefined)
  expect(h.results().at(-1)?.isError).toBe(true)
  if (budget === 'candidates' || budget === 'scan_bytes') {
    expect(h.review().scan_complete).toBe(false)
    await h.run(h.call('next'), undefined)
    expect(JSON.stringify(h.results().at(-1))).toContain('VIDEO_SCAN_INCOMPLETE')
    await h.run({ name: 'present', args: { files: [{ path: h.manuscript }] } }, undefined)
    expect(JSON.stringify(h.results().at(-1))).toContain('VIDEO_REVIEW_PENDING')
  }
})

it('rejects non-image routes and missing video inputs', async () => {
  const h = await fixture()
  vi.spyOn(h.ctx.llm, 'resolveModelInfo').mockResolvedValue({ provider: 'synthetic', id: 'vision', name: 'vision', inputModalities: ['text'] })
  await h.run(h.call('scan'), undefined)
  expect(JSON.stringify(h.results().at(-1))).toContain('image-capable')
  await rm(h.input)
  await h.run(h.call('scan'), undefined)
  expect(JSON.stringify(h.results().at(-1))).toContain('regular file')
})

it('retains a pending scan when the source changes before scan completion', async () => {
  const h = await fixture(), stat = h.ctx.fs.stat.bind(h.ctx.fs)
  let reads = 0
  vi.spyOn(h.ctx.fs, 'stat').mockImplementation(async (target, signal) => {
    const value = await stat(target, signal)
    return target.displayPath === h.input && ++reads > 1 && value !== undefined ? { ...value, version: FsVersion('changed') } : value
  })
  await h.run(h.call('scan'), undefined)
  expect(JSON.stringify(h.results().at(-1))).toContain('VIDEO_REVIEW_SOURCE_CHANGED')
  expect(h.review().scan_complete).toBe(false)
})

it('rejects extraction without a verified timestamp and invalid scan metadata', async () => {
  const h = await fixture(), media = Media.runMedia
  const spy = vi.spyOn(Media, 'runMedia').mockImplementation(async (...args) => {
    const output = await media(...args)
    return args[1].some(argument => argument.includes('showinfo')) ? { ...output, diagnostic: '' } : output
  })
  await h.run(h.call('scan'), undefined)
  expect(JSON.stringify(h.results().at(-1))).toContain('source timestamp')
  expect(h.review().frames.every(frame => !frame.exposed)).toBe(true)
  spy.mockImplementation(async (...args) => {
    const output = await media(...args)
    return args[1].some(argument => argument.includes('gte(scene,0)')) ? { ...output, bytes: Buffer.from('invalid metadata') } : output
  })
  await appendFile(h.input, 'revision')
  await h.run(h.call('scan'), undefined)
  expect(JSON.stringify(h.results().at(-1))).toContain('VIDEO_SCAN_INCOMPLETE')
  expect(h.review().scan_complete).toBe(false)
})

it('uses path labels when no episode name is supplied and denies execution without a Session', async () => {
  const h = await fixture()
  await h.run({ name: 'video_inspect', args: { file_path: h.input, method: 'metadata' } },
    { name: 'video_inspect', args: { file_path: h.input } }, undefined)
  expect(h.review().episode).toBe(h.input)
  const result = await h.ctx.tools.execute({ name: 'video_inspect', arguments: { file_path: h.input, method: 'status' },
    callId: ToolCallId('no-session-review'), signal: new AbortController().signal })
  expect(JSON.stringify(result)).toContain('initiating Session')
  await h.handle.dispose()
})

it('blocks a separately registered overview tool from bypassing the fixed scan policy', async () => {
  const h = await fixture()
  h.ctx.tools.register(defineTool({ name: 'video_contact_sheet', description: 'Legacy overview.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'unused' }))
  await h.run({ name: 'video_contact_sheet', args: {} }, undefined)
  expect(JSON.stringify(h.results().at(-1))).toContain('VIDEO_REVIEW_REQUIRED')
})

it('requires observation services and handles a nameless image reference without inventing a name', async () => {
  const h = await fixture(), empty = new Context()
  try {
    expect(() =>{  installReviewState(empty) }).toThrow('sessionProjections')
    expect(() => reviewsOf(empty, h.agent.session)).toThrow('sessionProjections')
    expect(() =>{  applyCompleteReview(empty, h.config, async (exec, operation) => operation(exec.signal), async () => {}) })
      .toThrow('sessionProjections and llm')
    expect(reviewImage({ id: 'F00001', time: 0, reasons: [], exposed: false,
      image: { attachmentId: 'sha256:' + '0'.repeat(64), mediaType: 'image/png', bytes: 1, width: 1, height: 1 } })).not.toHaveProperty('name')
  } finally { await empty.fiber.dispose() }
  await h.plugin.dispose()
  expect(reviewsOf(h.ctx, h.agent.session)).toEqual({})
})

it('rejects malformed durable review updates during projection recovery', async () => {
  const h = await fixture()
  expect(() => {
    h.agent.session.append('video/review', { kind: 'update', path: h.input, id: VideoReviewId('missing'), frames: [],
      frame_count: 1, scanned_until: 1, scan_complete: false })
    reviewsOf(h.ctx, h.agent.session)
  }).toThrow('matching source revision')
})

it('rejects a durable update that omits a newly introduced frame', async () => {
  const h = await fixture()
  await h.run(h.call('scan'), undefined)
  expect(() => {
    h.agent.session.append('video/review', { kind: 'update', path: h.input, id: h.review().id, frames: [],
      frame_count: h.review().frames.length + 1, scanned_until: 3, scan_complete: true })
    reviewsOf(h.ctx, h.agent.session)
  }).toThrow('missing a frame')
})

it('checks thumbnail coverage and discards a duplicated sampling endpoint', () => {
  const config = Video.Config({ reviewAnalysisFps: 4, reviewCheckpointSeconds: 20 })
  const size = 48 * 32 * 3
  expect(() => appearanceCandidates(Buffer.alloc(size * 2), config, 0, 2)).toThrow('coverage')
  expect(appearanceCandidates(Buffer.alloc(size * 5), config, 0, 1)).toEqual([0])
})

it('rejects invalid scan times and removes candidates beyond the last decoded source frame', async () => {
  const h = await fixture(), media = Media.runMedia
  const spy = vi.spyOn(Media, 'runMedia').mockImplementation(async (...args) => {
    const output = await media(...args)
    return args[1].some(argument => argument.includes('gte(scene,0)'))
      ? { ...output, bytes: Buffer.from('frame:0 pts:0 pts_time:bad\nlavfi.scene_score=0.9\n') } : output
  })
  const ffmpeg = await h.ctx.subprocess.resolveExecutable('ffmpeg')
  const scan = () => scanReviewFrames(h.ctx, h.input, 1, ffmpeg, h.config, { mode: 'danger-full-access', workspaceRoot: h.root },
    new AbortController().signal, () => {})
  await expect(scan()).rejects.toThrow('invalid decoded timecode')
  spy.mockImplementation(async (...args) => {
    const output = await media(...args)
    return args[1].some(argument => argument.includes('gte(scene,0)'))
      ? { ...output, bytes: Buffer.from('frame:0 pts:0 pts_time:0.9\nlavfi.scene_score=0.9\n') } : output
  })
  expect((await scan()).every(frame => frame.time <= 0.9)).toBe(true)
})

it('refuses a changed video during batch extraction and requires scanning its new revision', async () => {
  const h = await fixture()
  await h.run(h.call('scan'), h.record, undefined)
  const stat = h.ctx.fs.stat.bind(h.ctx.fs)
  let reads = 0
  const spy = vi.spyOn(h.ctx.fs, 'stat').mockImplementation(async (target, signal) => {
    const value = await stat(target, signal)
    return target.displayPath === h.input && ++reads > 1 && value !== undefined ? { ...value, version: FsVersion('changed') } : value
  })
  await h.run(h.call('next'), undefined)
  expect(JSON.stringify(h.results().at(-1))).toContain('VIDEO_REVIEW_SOURCE_CHANGED')
  spy.mockRestore()
  await appendFile(h.input, 'new source')
  await h.run(h.call('status'), undefined)
  expect(JSON.stringify(h.results().at(-1))).toContain('VIDEO_REVIEW_SOURCE_CHANGED')
})

it('preserves pending frames when additional context exceeds the product budget', async () => {
  const h = await fixture()
  await h.run(h.call('scan'), undefined)
  const count = h.review().frames.length
  await h.plugin.dispose()
  await h.ctx.plugin(Video, Video.Config({ requireCompleteReview: true, reviewBatchFrames: 2,
    reviewChunkSeconds: 2, reviewMaxFrames: count })).await()
  await h.run(h.call('observe', { observations: [{ frame_id: 'F00001', visible: '画面是红色背景，没有可见人物或道具。',
    change: '初始画面。', uncertainty: '需核对邻近画面。' }] }), undefined)
  expect(JSON.stringify(h.results().at(-1))).toContain('VIDEO_SCAN_LIMIT')
  expect(h.review().frames.every(frame => frame.observation === undefined)).toBe(true)
})

it('keeps independent model requests outside the episode admission ledger', async () => {
  const h = await fixture()
  await h.run(h.call('scan'), undefined)
  const { sessionId: _session, ...request } = h.adapter.requests[0]!
  for await (const chunk of h.ctx.llm.stream(request)) { void chunk }
  expect(h.review().frames.filter(frame => frame.exposed)).toHaveLength(2)
})

it('publishes all observations, reuses unchanged reports, and refuses changed report bytes', async () => {
  const h = await fixture()
  await h.run(h.call('scan'), undefined)
  while (h.review().frames.some(frame => frame.observation === undefined)) await h.run(h.call('next'), h.record, undefined)
  const directory = join(h.root, '.muse/video-observations')
  const reports = await readdir(directory)
  expect(reports).toHaveLength(1)
  await h.run(h.call('status'), undefined)
  expect(h.results().at(-1)?.isError).toBe(false)
  await writeFile(join(directory, reports[0]!), 'changed report')
  await h.run(h.call('status'), undefined)
  expect(JSON.stringify(h.results().at(-1))).toContain('VIDEO_OBSERVATION_REPORT_CHANGED')
  expect(h.review().frames.every(frame => frame.observation !== undefined)).toBe(true)
})

it('reuses saved frames after a later extraction in the same batch fails', async () => {
  const h = await fixture(), media = Media.runMedia
  let extractions = 0
  vi.spyOn(Media, 'runMedia').mockImplementation(async (...args) => {
    if (args[1].includes('image2pipe') && ++extractions === 2) throw Error('Synthetic second-frame extraction failure')
    return media(...args)
  })
  await h.run(h.call('scan'), undefined)
  expect(h.results().at(-1)?.isError).toBe(true)
  expect(h.review().frames.filter(frame => frame.image !== undefined)).toHaveLength(1)
  expect(h.review().frames.every(frame => !frame.exposed)).toBe(true)
  await h.plugin.dispose()
  await h.ctx.plugin(Video, h.config).await()
  expect(h.review().frames.filter(frame => frame.image !== undefined)).toHaveLength(1)
  await h.run(h.call('next'), undefined)
  expect(h.results().at(-1)?.isError).toBe(false)
  expect(extractions).toBe(3)
  expect(h.review().frames.filter(frame => frame.exposed)).toHaveLength(2)
})

it('publishes revised observations separately and retains the previous report', async () => {
  const h = await fixture()
  await h.run(h.call('scan'), undefined)
  while (h.review().frames.some(frame => frame.observation === undefined)) await h.run(h.call('next'), h.record, undefined)
  const directory = join(h.root, '.muse/video-observations')
  const [previous] = await readdir(directory)
  const original = await readFile(join(directory, previous!), 'utf8')
  await h.run(h.call('observe', { observations: [{ frame_id: 'F00001', visible: '画面为红色背景，边缘没有可见人物。',
    change: '开头背景保持红色。', uncertainty: '' }] }), undefined)
  expect(h.results().at(-1)?.isError).toBe(false)
  expect(await readdir(directory)).toHaveLength(2)
  expect(await readFile(join(directory, previous!), 'utf8')).toBe(original)
})

it.each(['offload', 'offload-throw'] as const)('reduces transport batches after %s without marking omitted frames as viewed', async (failure) => {
  const h = await fixture({ offload: true })
  await h.run(h.call('scan'), failure, undefined)
  expect(h.agent.session.snapshotEvents().some(event => event.type === 'image/offload')).toBe(true)
  expect(h.review().frames.filter(frame => frame.exposed).length).toBeLessThan(2)
  await h.run(h.call('next'), undefined)
  expect(h.results().at(-1)!.content.filter(block => block.type === 'image')).toHaveLength(1)
  expect(h.review().frames.every(frame => frame.observation === undefined)).toBe(true)
})

it.each(['offload', 'offload-throw'] as const)('keeps transport batches after %s only removes previously viewed image history', async (failure) => {
  const h = await fixture({ offload: true })
  await h.run(h.call('scan'), h.record, h.call('next'), failure, undefined)
  expect(h.agent.session.snapshotEvents().some(event => event.type === 'image/offload')).toBe(true)
  expect(h.review().frames.filter(frame => frame.exposed)).toHaveLength(4)
  expect(h.review().frames.filter(frame => frame.observation !== undefined)).toHaveLength(2)
  await h.run(h.call('next'), undefined)
  expect(h.results().at(-1)!.content.filter(block => block.type === 'image')).toHaveLength(2)
  expect(h.review().frames.filter(frame => frame.observation !== undefined)).toHaveLength(2)
})

it('shrinks a partially oversized new batch to its retained pending count rather than always to one', async () => {
  const h = await fixture({ offload: true, config: { reviewBatchFrames: 3 } })
  await h.run(h.call('scan'), 'offload', undefined)
  expect(h.review().frames.filter(frame => frame.exposed)).toHaveLength(2)
  await h.run(h.call('next'), undefined)
  expect(h.results().at(-1)!.content.filter(block => block.type === 'image')).toHaveLength(2)
  expect(h.review().frames.every(frame => frame.observation === undefined)).toBe(true)
})

it('does not attribute unrelated image requests or their budget failures to an episode', async () => {
  const h = await fixture()
  await h.run(h.call('scan'), undefined)
  const { sessionId: _session, ...request } = h.adapter.requests[0]!
  const image = reviewImage(h.review().frames[0]!)
  if (image === undefined) throw Error('Expected extracted image')
  h.adapter.plans = ['offload']
  const messages = [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image', attachment: image }] }),
    createAssistantMessage({ source: { provider: 'synthetic', model: 'vision' }, content: [{ type: 'image', attachment: image }] })]
  for await (const chunk of h.ctx.llm.stream({ ...request, messages })) { void chunk }
  await h.run(h.call('next'), undefined)
  expect(h.results().at(-1)!.content.filter(block => block.type === 'image')).toHaveLength(2)
})

it('decodes the exact first frame after a cut in a later scan chunk', async () => {
  const h = await fixture()
  await rm(h.input)
  const ffmpeg = await h.ctx.subprocess.resolveExecutable('ffmpeg')
  await runMedia(h.ctx, [ffmpeg, '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=96x64:r=10:d=2.5',
    '-f', 'lavfi', '-i', 'color=blue:s=96x64:r=10:d=0.5', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', h.input], { mode: 'danger-full-access', workspaceRoot: h.root }, undefined,
  { timeoutMs: 20_000, maxBytes: 1024, graceMs: 1000 })
  await h.run(h.call('scan'), undefined)
  const first = h.review().frames.filter(frame => frame.image !== undefined).map(frame => ({ frame_id: frame.id,
    visible: '画面是红色背景，没有人物、动作或道具。', change: '此时仍是切镜前的红色画面。', uncertainty: '' }))
  await h.run(h.call('observe', { observations: first }), h.call('next'), undefined)
  const frame = h.review().frames.find(frame => frame.reasons.includes('cut'))!
  expect(frame.decode).toEqual({ start_seconds: 2, frame_index: 5 })
  expect(frame.decoded_time).toBe(2.5)
  const reference = reviewImage(frame)
  if (reference === undefined) throw Error('Expected decoded cut image')
  const image = await h.ctx.attachments.readImage(reference)
  const pixel = await sharp(image.data).removeAlpha().raw().toBuffer()
  expect(pixel[2]).toBeGreaterThan(200)
  expect(pixel[0]).toBeLessThan(30)
})

it('honors the configured JPEG encoding while preserving original frame evidence', async () => {
  const h = await fixture({ config: { frameFormat: 'jpeg', frameJpegQuality: 2 } })
  await h.run(h.call('scan'), undefined)
  const frame = h.review().frames[0]!
  expect(frame.image?.mediaType).toBe('image/jpeg')
  const reference = reviewImage(frame)
  if (reference === undefined) throw Error('Expected JPEG observation')
  const image = await h.ctx.attachments.readImage(reference)
  expect([...image.data.subarray(0, 2)]).toEqual([255, 216])
  expect(frame.exposed).toBe(true)
})

it('keeps a chunk-boundary cut when the output cutoff allows decoder lookahead', async () => {
  const h = await fixture({ cutSeconds: 2 }), media = Media.runMedia
  vi.spyOn(Media, 'runMedia').mockImplementation(async (ctx, argv, ...rest) => {
    if (!argv.some(argument => argument.includes('gte(scene,0)')) && !argv.includes('rawvideo')) {
      return media(ctx, argv, ...rest)
    }
    // Filter evaluation can run ahead of the output -t cutoff.
    // Delay only the output cutoff; retain real decoding and filter evaluation.
    const delayed = [...argv], duration = delayed.indexOf('-t') + 1
    delayed[duration] = String(Number(delayed[duration]) + 0.5)
    return media(ctx, delayed, ...rest)
  })
  await h.run(h.call('scan'), undefined)
  expect(h.results().filter(result => result.isError)).toEqual([])
  expect(h.review()).toMatchObject({ scan_complete: true, scanned_until: 3 })
  const cut = h.review().frames.find(frame => frame.reasons.includes('cut'))
  expect(cut).toMatchObject({ time: 2, decode: { start_seconds: 0, frame_index: 20 } })
  await h.run(h.record, h.call('next'), undefined)
  const observed = h.review().frames.find(frame => frame.id === cut?.id)
  if (observed === undefined) throw Error('Missing chunk-boundary cut')
  expect(observed.decoded_time).toBe(2)
  const reference = reviewImage(observed)
  if (reference === undefined) throw Error('Expected exact chunk-boundary image')
  const image = await h.ctx.attachments.readImage(reference)
  const pixel = await sharp(image.data).removeAlpha().raw().toBuffer()
  expect(pixel[2]).toBeGreaterThan(200)
  expect(pixel[0]).toBeLessThan(30)
})
