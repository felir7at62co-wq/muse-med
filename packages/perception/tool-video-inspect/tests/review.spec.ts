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
import { SessionId } from '@deepseek-ai/dsh-session'
import { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
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
import { reviewsOf, installReviewState, reviewImage, VideoReviewId } from '../src/review-state.ts'
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

it('does not attribute unrelated image requests or their budget failures to an episode', async () => {
  const h = await fixture()
  await h.run(h.call('scan'), undefined)
  const { sessionId: _session, ...request } = h.adapter.requests[0]!
  const image = reviewImage(h.review().frames[0]!)
  if (image === undefined) throw Error('Expected extracted image')
  h.adapter.plans = ['offload']
  const messages = [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image', attachment: image }] })]
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
