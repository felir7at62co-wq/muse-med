/** Original synthetic FFmpeg media, real PTC dispatches, and keyless model-input evidence. */
import { mkdtemp, rm, writeFile, readFile, appendFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import NodeRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import { LlmAdapter, ToolCallId, createUserMessage, createDeveloperMessage, createToolResultMessage, projectOffloadedImages,
  type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { installVideoEvidence } from '../src/evidence.ts'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { afterEach, expect, it, vi } from 'vitest'
import * as Video from '../src/index.ts'
import { runMedia } from '../src/media.ts'

class Query extends SessionQueryEngine {
  async searchSessions(): Promise<never> { throw Error('This fixture only reads original Session logs') }
  async searchEvents(): Promise<never> { throw Error('This fixture only reads original Session logs') }
}
class Model extends LlmAdapter {
  plans: Array<{ name: string; args: object } | 'fail' | undefined> = []
  requests: GenerateOptions[] = []
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, inputModalities: model === 'text' ? ['text'] : ['text', 'image'] }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const plan = this.plans.shift()
    if (plan === 'fail') { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'FIXTURE', message: 'Synthetic request failure' } } }; return }
    if (plan === undefined) { yield { type: 'finish', reason: { kind: 'stop' } }; return }
    const id = ToolCallId(`synthetic-${this.requests.length}`)
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: plan.name, arguments: JSON.stringify(plan.args) } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}
const fixtures: Array<{ ctx: Context; root: string }> = []
function inputDigest(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
  return createHash('sha256').update(canonical).digest('hex')
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const fixture of fixtures.splice(0)) { await fixture.ctx.fiber.dispose(); await rm(fixture.root, { recursive: true, force: true }) }
})
async function fixture(options: { duration?: number; range?: number; ptc?: boolean; trusted?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-video-evidence-')), ctx = new Context()
  const errors: string[] = []
  ctx.on('agent/error', ({ error }) => { errors.push(String(error)) })
  fixtures.push({ ctx, root })
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: options.ptc ? 'ptc' : 'native' } })
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalAttachmentStore, { dshHome: join(root, '.state') })
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: root }) } as never)
  if (options.ptc) { await ctx.plugin(LocalSandbox); await ctx.plugin(NodeRuntime).await() }
  await ctx.plugin(Query)
  const plugin = ctx.plugin(Video, Video.Config({ trustedEvidence: options.trusted ?? true,
    maxRangeSeconds: options.range ?? 120, defaultFrames: 1 }))
  await plugin.await()
  const input = join(root, 'original-colors.mp4')
  const ffmpeg = await ctx.subprocess.resolveExecutable('ffmpeg')
  await runMedia(ctx, [ffmpeg, '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', `color=c=red:size=64x48:rate=10:d=${options.duration ?? 4}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input], { mode: 'danger-full-access', workspaceRoot: root }, undefined,
  { timeoutMs: 20_000, maxBytes: 1024, graceMs: 1000 })
  const adapter = new Model()
  ctx.llm.registerAdapter(['synthetic'], adapter)
  const driver = await mountAgentLoopTestHarness(ctx)
  const handle = await ctx.agents.create({ sessionId: SessionId('original-synthetic-video'),
    agentOptions: { provider: 'synthetic', model: 'vision' }, meta: { cwd: root } })
  const { agent } = handle
  const method = (value: string, extra = {}) => ({ name: 'video_inspect', args: { file_path: input, method: value,
    manifest_path: value === 'metadata' ? 'metadata.json' : 'sample.json', ...extra } })
  const program = (extra = '') => ({ name: 'run_code', args: { description: 'Inspect original synthetic media.',
    code: `await tools.video_inspect(${JSON.stringify(method('metadata').args)});`
    + `await tools.video_inspect(${JSON.stringify(method('sample').args)});${extra}` } })
  const run = async (plans: Model['plans'], extra: Parameters<typeof createUserMessage>[0]['content'] = []) => {
    adapter.plans = plans
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Inspect this original synthetic video.' }, ...extra] }))
    await agent.whenIdle()
  }
  const manifest = async () => JSON.parse(await readFile(join(root, 'sample.json'), 'utf8')) as Video.VideoInspection
  const resolve = (value: unknown, persisted?: unknown) => Video.resolveTrustedVideoEvidence(ctx,
    persisted === undefined ? agent.session : undefined, value, new AbortController().signal, persisted)
  return { root, ctx, agent, handle, adapter, plugin, input, method, program, run, manifest, resolve, errors, driver }
}

it.each([false, true])('recovers logged ASR candidate context after plugin disposal with PTC=%s', async (ptc) => {
  const h = await fixture({ ptc })
  const transcript = join(h.root, 'original-transcript.json')
  await writeFile(transcript, JSON.stringify([
    { start: 0, end: 1, text: '别走。', speaker_id: 'job-a:0' },
    { start: 2, end: 3, text: '我会回来。', speaker_id: 'job-a:1' },
  ]))
  const metadata = h.method('metadata'), sample = h.method('sample', { strategy: 'scene_dialogue', transcript_path: transcript })
  await h.run(ptc ? [{ name: 'run_code', args: { description: 'Inspect original utterance candidates.',
    code: `await tools.video_inspect(${JSON.stringify(metadata.args)});await tools.video_inspect(${JSON.stringify(sample.args)});` } }, undefined]
    : [metadata, sample, undefined])
  expect(h.errors).toEqual([])
  const manifest = await h.manifest()
  expect(manifest.sampling_plan?.selected[0]?.utterances).toEqual([
    { start: 2, end: 3, text: '我会回来。', text_truncated: false, speaker_id: 'job-a:1' },
  ])
  expect(manifest.sampling_plan?.deferred[0]).toEqual({ time: 0.5, reasons: ['speaker_change_utterance'] })
  expect(JSON.stringify(manifest.sampling_plan)).not.toContain('别走。')
  expect(JSON.stringify(h.agent.session.snapshotEvents().filter(event => event.type === 'tool/result'
    || event.type === 'tool/ptc-dispatch'))).toContain('job-a:1')
  const receipt = await h.resolve(manifest)
  await h.plugin.dispose()
  expect(await h.resolve(manifest, receipt)).toEqual(receipt)
}, 30_000)

it('shows a contact sheet to the next actual model request without issuing detail approval', async () => {
  const h = await fixture({ ptc: true })
  await h.run([{ name: 'run_code', args: { description: 'View a six-cell overview.',
    code: `return await tools.video_contact_sheet(${JSON.stringify({ file_path: h.input,
      columns: 3, rows: 2, timestamps_seconds: [1, 3], manifest_path: 'overview.json' })});` } }, undefined])
  expect(h.errors).toEqual([])
  expect(h.adapter.requests).toHaveLength(2)
  const images = h.adapter.requests[1]!.messages.flatMap(message => message.content).filter(block => block.type === 'image')
  expect(images).toHaveLength(1)
  expect(h.adapter.requests[1]!.messages.flatMap(message => message.content)
    .filter(block => block.type === 'text').map(block => block.text).join('\n'))
    .toContain('first obtain successful video_inspect method=metadata')
  const value: unknown = JSON.parse(await readFile(join(h.root, 'overview.json'), 'utf8'))
  expect(value).toMatchObject({ columns: 3, rows: 2, pages: [{ frames: [
    { index: 1, cell: 1, timestamp_seconds: 1 }, { index: 2, cell: 2, timestamp_seconds: 3 },
  ] }] })
  await expect(h.resolve(value)).rejects.toThrow('sampled_frames')
  expect(h.agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    .map(event => ({ isError: event.data.message.isError,
      images: event.data.message.content.filter(block => block.type === 'image').map(block => ({
        width: block.attachment.width, height: block.attachment.height,
      })) }))).toMatchSnapshot('six-cell overview reaches the model without detail evidence')
}, 30_000)

it('issues real metadata and image-input evidence, retaining the actual PTC outer result and recovering accepted records', async () => {
  const h = await fixture({ ptc: true })
  let sameProgram = ''
  const outcomes: unknown[] = []
  h.ctx.on('tools/result', (exec, result) => { if (exec.name === 'run_code') outcomes.push(result) })
  h.ctx.tools.register(defineTool({ name: 'inspect_evidence', description: 'Test-only same-program observation check.', parameters: {},
    output: { schema: { type: 'json' }, render: () => [] },
    async execute() {
      try { await h.resolve(await h.manifest()); sameProgram = 'unexpected success' } catch (error) { sameProgram = String(error) }
      return {}
    } }))
  await h.run([h.program('await tools.inspect_evidence({});'), undefined])
  expect(sameProgram, JSON.stringify({ outcomes, requests: h.adapter.requests, errors: h.errors })).toContain('video_evidence_pending')
  const manifest = await h.manifest(), receipt = await h.resolve(manifest)
  expect(receipt).toMatchObject({ version: 'trusted-video-inspection-v2', duration_seconds: 4,
    plan: [{ start_seconds: 0, end_seconds: 4 }],
    windows: [{ start_seconds: 0, end_seconds: 4, sample_requested_seconds: [2], decoded_pts_seconds: [2] }] })
  expect(receipt.evidence.sample_ancestors).toHaveLength(1)
  expect(receipt.evidence.sample_root_result.seq).toBeLessThan(receipt.model_input_step)
  expect(h.adapter.requests[1]?.messages.some(message => message.content.some(block => block.type === 'image'))).toBe(true)
  expect(receipt.evidence.model_input_sha256).toBe(inputDigest(h.adapter.requests[1]?.messages))
  await h.plugin.dispose()
  await expect(h.resolve(manifest)).rejects.toThrow('video_evidence_pending')
  expect(await h.resolve(manifest, receipt)).toEqual(receipt)
  const forged = structuredClone(receipt); forged.evidence.sample_result.sha256 = '0'.repeat(64)
  await expect(h.resolve(manifest, forged)).rejects.toThrow('Session event is missing or changed')
}, 30_000)

it('plans the entire real duration but a local 60-second sample remains only a local interval', async () => {
  const h = await fixture({ duration: 125.3 })
  await h.run([h.method('metadata'), h.method('sample'), undefined])
  const receipt = await h.resolve(await h.manifest())
  expect(receipt.duration_seconds).toBe(125.3)
  expect(receipt.plan).toEqual([{ start_seconds: 0, end_seconds: 60 }, { start_seconds: 60, end_seconds: 120 },
    { start_seconds: 120, end_seconds: 125.3 }])
  expect(receipt.windows).toHaveLength(1)
  expect(receipt.windows[0]?.end_seconds).toBe(60)
  expect(receipt.plan.length).toBeGreaterThan(receipt.windows.length)
}, 30_000)

it('respects deployment range limits, keeps planned windows unviewed, and leaves ordinary results unchanged', async () => {
  const h = await fixture({ range: 1 })
  await h.run([h.method('metadata'), h.method('sample'), undefined])
  const receipt = await h.resolve(await h.manifest())
  expect(receipt.plan.map(row => row.end_seconds - row.start_seconds)).toEqual([1, 1, 1, 1])
  const ordinary = await fixture({ trusted: false })
  await ordinary.run([ordinary.method('sample'), undefined])
  expect((await ordinary.manifest()).window_plan).toBeUndefined()
  await expect(ordinary.resolve(await ordinary.manifest())).rejects.toThrow('video_evidence_pending')
}, 30_000)

it('rejects fabricated JSON, altered attachment bindings, another Session, and changed source versions', async () => {
  const h = await fixture()
  await h.run([h.method('metadata'), h.method('sample'), undefined])
  const original = await h.manifest(), receipt = await h.resolve(original)
  for (const changed of [{ ...original, source_version: 'forged' }, { ...original, duration_seconds: 999 },
    { ...original, manifest_path: 'copied-sample.json' },
    { ...original, frames: original.frames.map(row => ({ ...row, requested_seconds: row.requested_seconds + 1 })) },
    { ...original, frames: original.frames.map(row => ({ ...row, image: { ...row.image, bytes: row.image.bytes + 1 } })) }]) {
    await expect(h.resolve(changed)).rejects.toThrow('video_evidence_pending')
  }
  await expect(Video.resolveTrustedVideoEvidence(h.ctx, undefined, original, new AbortController().signal)).rejects.toThrow('video_evidence_pending')
  const copied = structuredClone(receipt); copied.evidence.session_id = SessionId('unrelated-session')
  await expect(h.resolve(original, copied)).rejects.toThrow()
  await appendFile(h.input, 'source changed')
  await expect(h.resolve(original)).rejects.toThrow('source version changed')
  await expect(h.resolve(original, receipt)).rejects.toThrow('source version changed')
}, 30_000)

it.each(['exception', 'abort'] as const)('does not issue proof when the PTC outer program ends with %s', async (failure) => {
  const h = await fixture({ ptc: true })
  if (failure === 'exception') await h.run([h.program('throw new Error("Synthetic outer failure");'), undefined])
  else {
    const sampled = Promise.withResolvers<undefined>()
    h.ctx.on('tools/result', (exec, result) => { if (exec.name === 'video_inspect' && !result.isError && typeof exec.arguments === 'object'
      && exec.arguments !== null && 'method' in exec.arguments && exec.arguments.method === 'sample') sampled.resolve(undefined) })
    const running = h.run([h.program('await new Promise(() => {});')])
    await sampled.promise
    h.agent.cancel({ kind: 'user' })
    await running
  }
  await expect(h.resolve(await h.manifest())).rejects.toThrow('video_evidence_pending')
}, 30_000)

it('rejects post-result replacements and a failed next-model request even if the media files exist', async () => {
  const replaced = await fixture()
  replaced.ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    return exec.name === 'video_inspect' && result.content.some(block => block.type === 'image')
      ? { kind: 'accept', content: [{ type: 'text', text: 'Only a JSON/path claim.' }] } : decision
  })
  await replaced.run([replaced.method('metadata'), replaced.method('sample'), undefined])
  await expect(replaced.resolve(await replaced.manifest())).rejects.toThrow('video_evidence_pending')
  const failed = await fixture()
  await failed.run([failed.method('metadata'), failed.method('sample'), 'fail'])
  await expect(failed.resolve(await failed.manifest())).rejects.toThrow('video_evidence_pending')
}, 30_000)

it('requires actual metadata before trusted sampling and refuses manifest mutation during accepted recovery', async () => {
  const h = await fixture()
  await h.run([h.method('sample'), undefined])
  await expect(h.manifest()).rejects.toMatchObject({ code: 'ENOENT' })
  await h.run([h.method('metadata'), h.method('sample'), undefined])
  const value = await h.manifest(), receipt = await h.resolve(value)
  await writeFile(join(h.root, 'sample.json'), JSON.stringify({ ...value, verified_readback: true, duration_seconds: 999 }))
  await expect(h.resolve(value, receipt)).rejects.toThrow('manifest is missing or changed')
}, 30_000)

it('does not treat images projected away on the following text-only route as visual observation', async () => {
  const h = await fixture()
  h.ctx.on('agent/request', async (_payload, next) => {
    const config = await next()
    return h.adapter.requests.length >= 2 ? { ...config, model: 'text' } : config
  })
  await h.run([h.method('metadata'), h.method('sample'), undefined])
  expect(h.adapter.requests[2]?.messages.every(message => message.content.every(block => block.type !== 'image'))).toBe(true)
  await expect(h.resolve(await h.manifest())).rejects.toThrow('video_evidence_pending')
}, 30_000)

it('does not treat returned frames marked offloaded before the next request as visual observation', async () => {
  const h = await fixture()
  h.ctx.on('agent/request', async (_payload, next) => {
    const config = await next()
    if (h.adapter.requests.length !== 2) return config
    const source = h.agent.session.snapshotEvents().findLast(event => event.type === 'tool/result'
      && event.data.message.content.some(block => block.type === 'image'))
    if (source?.type !== 'tool/result') throw Error('Synthetic sample result is missing')
    h.agent.session.append('tool/result', { ...source.data, message: { ...source.data.message,
      content: source.data.message.content.map(block => block.type === 'image' ? { ...block, offloaded: true } : block) } },
    { surfaceOp: { op: 'replace', startSeq: source.seq, endSeq: source.seq }, sourceEventSeqs: [source.seq] })
    return config
  })
  await h.run([h.method('metadata'), h.method('sample'), undefined])
  const messages = h.adapter.requests[2]?.messages
  expect(messages?.some(message => message.content.some(block => block.type === 'image' && block.offloaded === true))).toBe(true)
  expect(messages === undefined ? undefined : projectOffloadedImages(messages, () => 'Synthetic offloaded image placeholder')
    .every(message => message.content.every(block => block.type !== 'image'))).toBe(true)
  const sample = await h.manifest()
  await expect(h.resolve(sample)).rejects.toThrow('video_evidence_pending')
  const metadataText = await readFile(join(h.root, 'metadata.json'), 'utf8')
  const metadata = JSON.parse(metadataText) as Video.VideoInspection
  const events = h.agent.session.snapshotEvents()
  const metadataResult = events.find(event => event.type === 'tool/result'
    && inputDigest(event.data.message.content) === inputDigest(Video.inspectionContent(metadata)))
  const sampleResult = events.find(event => event.type === 'tool/result'
    && inputDigest(event.data.message.content) === inputDigest(Video.inspectionContent(sample)))
  const response = events.findLast(event => event.type === 'assistant/message')
  const step = events.findLast(event => event.type === 'step/start')
  if (metadataResult === undefined || sampleResult === undefined || response === undefined || step === undefined) {
    throw Error('Synthetic inspection or model events are missing')
  }
  const eventRef = (event: typeof metadataResult) => ({ seq: event.seq, sha256: inputDigest(event) })
  const forged = Video.TRUSTED_VIDEO_INSPECTION_RECEIPT.parse({ version: 'trusted-video-inspection-v2',
    video_path: sample.path, source_version: sample.source_version, duration_seconds: sample.duration_seconds,
    metadata_manifest_path: metadata.manifest_path, manifest_path: sample.manifest_path,
    metadata_manifest_sha256: createHash('sha256').update(metadataText).digest('hex'),
    manifest_sha256: createHash('sha256').update(await readFile(join(h.root, 'sample.json'))).digest('hex'),
    plan: metadata.window_plan, windows: [{ ...sample.interval, frames: sample.frames,
      sample_requested_seconds: sample.frames.map(frame => frame.requested_seconds),
      decoded_pts_seconds: sample.frames.map(frame => frame.timestamp_seconds) }], model_input_step: step.seq, unresolved: [],
    evidence: { session_id: h.agent.session.id, metadata_result: eventRef(metadataResult), metadata_root_result: eventRef(metadataResult),
      sample_result: eventRef(sampleResult), sample_root_result: eventRef(sampleResult), metadata_ancestors: [], sample_ancestors: [],
      model_response: eventRef(response), model_input_sha256: inputDigest(messages) } })
  await expect(h.resolve(sample, forged)).rejects.toThrow('images were not in the recorded model input')
}, 30_000)

it('keeps issuance isolated across real Sessions, scoped tool proxies, and another registration disposal', async () => {
  const h = await fixture()
  await h.run([h.method('metadata'), h.method('sample'), undefined])
  const original = await h.manifest(), first = await h.resolve(original)
  expect(h.ctx.tools).not.toBe(h.agent.ctx.tools)
  const scoped = h.agent.ctx.plugin({ name: 'fixture-scoped-video', inject: Video.inject, Config: Video.Config, apply: Video.apply },
    Video.Config({ trustedEvidence: true, defaultFrames: 1 }))
  await scoped.await()
  await h.run([h.method('metadata', { manifest_path: 'scoped-metadata.json' }),
    h.method('sample', { manifest_path: 'scoped-sample.json' }), undefined])
  const scopedInput: unknown = JSON.parse(await readFile(join(h.root, 'scoped-sample.json'), 'utf8'))
  const scopedReceipt = await h.resolve(scopedInput)
  expect(scopedReceipt.manifest_path).not.toBe(first.manifest_path)
  expect(scopedReceipt.evidence.model_input_sha256).toBe(inputDigest(h.adapter.requests.at(-1)?.messages))
  await scoped.dispose()
  expect(await h.resolve(original)).toEqual(first)
  const second = await h.driver.create(SessionId('second-synthetic-video'), { provider: 'synthetic', model: 'vision' }, { cwd: h.root })
  await expect(Video.resolveTrustedVideoEvidence(h.ctx, second.session, original, new AbortController().signal))
    .rejects.toThrow('video_evidence_pending')
  h.adapter.plans = [h.method('metadata', { manifest_path: 'second-metadata.json' }),
    h.method('sample', { manifest_path: 'second-sample.json' }), undefined]
  second.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Inspect in this distinct real Session.' }] }))
  await second.whenIdle()
  const secondInput: unknown = JSON.parse(await readFile(join(h.root, 'second-sample.json'), 'utf8'))
  const secondReceipt = await Video.resolveTrustedVideoEvidence(h.ctx, second.session, secondInput, new AbortController().signal)
  expect(secondReceipt.evidence.session_id).toBe(second.session.id)
  expect(await h.resolve(original)).toEqual(first)
  await expect(h.resolve(secondInput)).rejects.toThrow('video_evidence_pending')
}, 30_000)

it.each(['metadata_kind', 'metadata_path', 'metadata_version', 'metadata_manifest', 'sample_manifest', 'metadata_duration',
  'sample_path', 'sample_version', 'sample_duration', 'plan_gap', 'plan_reversed', 'plan_overflow', 'plan_short',
  'requested_before', 'requested_after', 'decoded_before', 'decoded_after'] as const)(
  'refuses persisted media evidence with %s even when manifest hashes are refreshed', async (variant) => {
    const h = await fixture(); await h.run([h.method('metadata'), h.method('sample'), undefined])
    const sample = await h.manifest(), receipt = await h.resolve(sample)
    const metadata = JSON.parse(await readFile(join(h.root, 'metadata.json'), 'utf8')) as Video.VideoInspection
    if (variant === 'metadata_kind') metadata.inspection = 'sampled_frames'
    if (variant === 'metadata_path') metadata.path += '.other'
    if (variant === 'metadata_version') metadata.source_version = FsVersion(sample.source_version + '-other')
    if (variant === 'metadata_manifest') metadata.manifest_path += '.other'
    if (variant === 'sample_manifest') sample.manifest_path += '.other'
    if (variant === 'metadata_duration') metadata.duration_seconds += 1
    if (variant === 'sample_path') sample.path += '.other'
    if (variant === 'sample_version') sample.source_version = FsVersion(metadata.source_version + '-other')
    if (variant === 'sample_duration') sample.duration_seconds += 1
    if (variant === 'plan_gap') receipt.plan[0]!.start_seconds = 1
    if (variant === 'plan_reversed') { receipt.plan[0]!.end_seconds = 0.5; receipt.plan[0]!.start_seconds = 0.5 }
    if (variant === 'plan_overflow') receipt.plan[0]!.end_seconds = 5
    if (variant === 'plan_short') receipt.plan[0]!.end_seconds = 3
    if (variant.startsWith('plan_')) metadata.window_plan = receipt.plan
    if (variant === 'requested_before' || variant === 'decoded_before') sample.interval.start_seconds = 3
    if (variant === 'requested_before') sample.frames[0]!.timestamp_seconds = 3
    if (variant === 'requested_after') sample.frames[0]!.requested_seconds = 4
    if (variant === 'decoded_before') sample.frames[0]!.requested_seconds = 3
    if (variant === 'decoded_after') sample.frames[0]!.timestamp_seconds = 4
    receipt.windows = [{ ...sample.interval,
      sample_requested_seconds: sample.frames.map(frame => frame.requested_seconds),
      decoded_pts_seconds: sample.frames.map(frame => frame.timestamp_seconds), frames: sample.frames }]
    const metadataText = JSON.stringify(metadata), sampleText = JSON.stringify(sample)
    await writeFile(receipt.metadata_manifest_path, metadataText); await writeFile(receipt.manifest_path, sampleText)
    receipt.metadata_manifest_sha256 = inputTextDigest(metadataText); receipt.manifest_sha256 = inputTextDigest(sampleText)
    const failure = variant.startsWith('plan_') ? /metadata plan/ : variant.includes('before') || variant.includes('after')
      ? /outside its actual sampled interval/ : /does not match the trusted source/
    await expect(h.resolve(sample, receipt)).rejects.toThrow(failure)
  },
)

function inputTextDigest(value: string): string { return createHash('sha256').update(value).digest('hex') }

it.each(['wrong_event', 'missing_step', 'wrong_step', 'wrong_response', 'early_response', 'changed_input', 'missing_outer'] as const)(
  'refuses accepted recovery with %s and intact media files', async (variant) => {
    const h = await fixture({ ptc: true }); await h.run([h.program(), undefined])
    const sample = await h.manifest(), receipt = await h.resolve(sample), events = h.agent.session.snapshotEvents()
    const user = events.find(event => event.type === 'user/message')!
    const reference = { seq: user.seq, sha256: inputDigest(user) }
    if (variant === 'wrong_event') receipt.evidence.sample_result = reference
    if (variant === 'missing_step') receipt.model_input_step = SessionSeq(receipt.evidence.model_response.seq + 100)
    if (variant === 'wrong_step') receipt.model_input_step = user.seq
    if (variant === 'wrong_response') receipt.evidence.model_response = reference
    if (variant === 'early_response') {
      const first = events.find(event => event.type === 'assistant/message')!
      receipt.evidence.model_response = { seq: first.seq, sha256: inputDigest(first) }
    }
    if (variant === 'changed_input') receipt.evidence.model_input_sha256 = '0'.repeat(64)
    if (variant === 'missing_outer') { receipt.evidence.sample_ancestors = []; receipt.evidence.sample_root_result = receipt.evidence.sample_result }
    await expect(h.resolve(sample, receipt)).rejects.toThrow(/Video evidence/)
  },
)

it('preserves optional frame dimensions and names when parsing a saved receipt', async () => {
  const h = await fixture(); await h.run([h.method('metadata'), h.method('sample'), undefined])
  const receipt = await h.resolve(await h.manifest()), image = receipt.windows[0]!.frames[0]!.image
  image.name = 'frame.png'; image.originalDimensions = { width: 128, height: 96 }
  expect(Video.TRUSTED_VIDEO_INSPECTION_RECEIPT.parse(receipt).windows[0]!.frames[0]!.image)
    .toMatchObject({ name: 'frame.png', originalDimensions: { width: 128, height: 96 } })
  delete image.name
  expect(Video.TRUSTED_VIDEO_INSPECTION_RECEIPT.parse(receipt).windows[0]!.frames[0]!.image.name).toBeUndefined()
})

it('does not count detail images carried only by developer messages that the model route removes', async () => {
  const h = await fixture()
  h.ctx.on('agent/request', async (_payload, next) => {
    const config = await next()
    if (h.adapter.requests.length !== 2) return config
    const source = h.agent.session.snapshotEvents().findLast(event => event.type === 'tool/result'
      && event.data.message.content.some(block => block.type === 'image'))
    if (source?.type !== 'tool/result') throw Error('Fixture sample result is missing')
    const images = source.data.message.content.filter(block => block.type === 'image')
    h.agent.session.append('tool/result', { ...source.data, message: { ...source.data.message,
      content: source.data.message.content.filter(block => block.type !== 'image') } },
    { surfaceOp: { op: 'replace', startSeq: source.seq, endSeq: source.seq }, sourceEventSeqs: [source.seq] })
    h.agent.session.append('developer/message', { turn: source.data.turn, step: source.data.step,
      message: createDeveloperMessage({ source: { kind: 'fixture' }, content: images }) }, { surfaceOp: 'append' })
    return config
  })
  await h.run([h.method('metadata'), h.method('sample'), undefined])
  expect(h.adapter.requests.at(-1)?.messages.flatMap(message => message.content).some(block => block.type === 'image')).toBe(false)
  await expect(h.resolve(await h.manifest())).rejects.toThrow('video_evidence_pending')
})

it('requires Session and LLM composition before installing trusted inspection', async () => {
  const empty = new Context()
  expect(() => installVideoEvidence(empty)).toThrow('Session and LLM services')
  await empty.fiber.dispose()
  const h = await fixture()
  const isolated = new Context()
  isolated.provide('sessions', h.ctx.sessions)
  expect(() => installVideoEvidence(isolated)).toThrow('Session and LLM services')
  await isolated.fiber.dispose()
})

it('rejects unowned and outside-step inspection executions, and discards disposed live evidence', async () => {
  const h = await fixture()
  await h.run([h.method('metadata'), h.method('sample'), undefined])
  const sample = await h.manifest(), receipt = await h.resolve(sample)
  const ledger = installVideoEvidence(h.ctx)
  h.ctx.tools.register(defineTool({ name: 'fixture_issue', description: 'Issue inspection using actual Host execution.', parameters: {},
    output: { schema: { type: 'json' }, render: () => [] }, async execute(_args, exec) {
      ledger.issue(exec, sample, JSON.stringify(sample)); return {}
    } }))
  h.ctx.tools.register(defineTool({ name: 'fixture_metadata', description: 'Read inspection metadata using actual Host execution.', parameters: {},
    output: { schema: { type: 'json' }, render: () => [] }, async execute(_args, exec) {
      ledger.metadata(exec, sample.path, sample.source_version, sample.duration_seconds); return {}
    } }))
  const call = (name: string, withAgent: boolean) => h.ctx.tools.execute({ callId: ToolCallId(`fixture-${name}-${withAgent}`),
    name, arguments: {}, signal: new AbortController().signal, ...withAgent ? { agent: h.agent } : {} })
  expect((await call('fixture_issue', false)).content.filter(block => block.type === 'text').map(block => block.text).join('\n')).toContain('initiating Session')
  expect((await call('fixture_metadata', false)).isError).toBe(true)
  expect((await call('fixture_issue', true)).content.filter(block => block.type === 'text').map(block => block.text).join('\n')).toContain('running model step')
  await h.handle.dispose()
  await expect(h.resolve(sample)).rejects.toThrow('video_evidence_pending')
  await expect(h.resolve(sample, receipt)).rejects.toThrow('not found')
})

it.each(['mapped', 'unmapped', 'unavailable'] as const)('preserves frame observation with %s file handles in the same input', async (mapping) => {
  const h = await fixture(), file = await h.ctx.attachments.saveFile({ data: Buffer.from('Original source notes.'), name: 'notes.txt' })
  if (mapping === 'unmapped') vi.spyOn(h.ctx.attachments, 'fileHostPath').mockReturnValue(undefined)
  if (mapping === 'unavailable') vi.spyOn(h.ctx.attachments, 'fileHostPath').mockImplementation(() => { throw Error('File storage is temporarily unavailable') })
  await h.run([h.method('metadata'), h.method('sample'), undefined], [{ type: 'file', attachment: file }])
  const sample = await h.manifest(), receipt = await h.resolve(sample)
  expect(h.adapter.requests.at(-1)?.messages.flatMap(message => message.content).filter(block => block.type === 'text')
    .some(block => block.text.includes('notes.txt'))).toBe(true)
  expect(await h.resolve(sample, receipt)).toEqual(receipt)
})

it('does not issue image observation from an auxiliary model call or foreign replay state', async () => {
  const h = await fixture()
  for await (const _chunk of h.ctx.llm.stream({ provider: 'synthetic', model: 'vision', messages: [] })) { /* Consume an auxiliary request. */ }
  h.adapter.requests = []
  const stream = h.adapter.stream.bind(h.adapter)
  vi.spyOn(h.adapter, 'stream').mockImplementation(async function* (options) {
    for await (const chunk of stream(options)) yield chunk.type === 'finish'
      ? { ...chunk, replayState: { response: { fixture: 'original-provider-state' } } } : chunk
  })
  h.ctx.llm.registerAdapter(['other'], h.adapter)
  h.ctx.on('agent/request', async (_payload, next) => {
    const config = await next()
    return h.adapter.requests.length >= 2 ? { ...config, provider: 'other' } : config
  })
  await h.run([h.method('metadata'), h.method('sample'), undefined])
  await expect(h.resolve(await h.manifest())).rejects.toThrow('video_evidence_pending')
})

it.each(['query', 'sessions', 'model'] as const)('requires the original %s services for accepted recovery', async (missing) => {
  const h = await fixture(); await h.run([h.method('metadata'), h.method('sample'), undefined])
  const sample = await h.manifest(), receipt = await h.resolve(sample), isolated = new Context()
  isolated.provide('fs', h.ctx.fs); isolated.provide('attachments', h.ctx.attachments)
  if (missing !== 'query') isolated.provide('sessionQuery', h.ctx.sessionQuery)
  if (missing !== 'sessions') isolated.provide('sessions', h.ctx.sessions)
  if (missing !== 'model') isolated.provide('llm', h.ctx.llm)
  try {
    await expect(Video.resolveTrustedVideoEvidence(isolated, undefined, sample, new AbortController().signal, receipt))
      .rejects.toThrow(missing === 'model' ? 'original model route' : 'Session query access')
  } finally { await isolated.fiber.dispose() }
})

it.each(['invalid_manifest', 'empty_attachment', 'changed_attachment'] as const)('refuses accepted recovery with %s', async (failure) => {
  const h = await fixture(); await h.run([h.method('metadata'), h.method('sample'), undefined])
  const sample = await h.manifest(), receipt = await h.resolve(sample)
  if (failure === 'invalid_manifest') {
    const invalid = JSON.stringify({ ...sample, verified_readback: 'unverified' })
    await writeFile(receipt.manifest_path, invalid); receipt.manifest_sha256 = inputTextDigest(invalid)
  } else {
    const read = h.ctx.attachments.readImage.bind(h.ctx.attachments)
    vi.spyOn(h.ctx.attachments, 'readImage').mockImplementation(async (image, signal) => {
      const stored = await read(image, signal)
      return { ...stored, data: stored.data.subarray(0, failure === 'empty_attachment' ? 0 : stored.data.length - 1) }
    })
  }
  await expect(h.resolve(sample, receipt)).rejects.toThrow(failure === 'invalid_manifest' ? 'manifest fields are invalid' : 'attachment is empty or changed')
})

it.each(['missing_call', 'wrong_name', 'wrong_content', 'wrong_parent', 'reversed_ancestor', 'metadata_after_sample'] as const)(
  'refuses accepted recovery from %s log evidence', async (failure) => {
    const h = await fixture({ ptc: true }); await h.run([h.program(), undefined])
    const sample = await h.manifest(), receipt = await h.resolve(sample)
    const observe = h.ctx.sessionQuery.observeSession.bind(h.ctx.sessionQuery)
    using original = await observe(receipt.evidence.session_id, { projectionMode: 'none' })
    const events = [...structuredClone(original.events)]
    if (failure === 'missing_call' || failure === 'wrong_name' || failure === 'wrong_content') {
      const index = receipt.evidence.sample_result.seq, result = events[index]!
      if (result.type !== 'tool/ptc-dispatch') throw Error('Fixture requires a PTC dispatch')
      if (failure === 'missing_call') {
        const outer = events.find(event => event.type === 'tool/result')!
        if (outer.type !== 'tool/result') throw Error('Fixture requires an outer tool result')
        events[index] = { ...outer, seq: result.seq, data: { ...outer.data,
          message: createToolResultMessage({ callId: ToolCallId('unrecorded-video-call'), content: result.data.content, isError: false }) } }
      } else if (failure === 'wrong_name') result.data.name = 'different_tool'
      else result.data.content = [{ type: 'text', text: 'Changed result' }]
      receipt.evidence.sample_result.sha256 = inputDigest(events[index])
    }
    if (failure === 'wrong_parent') {
      const result = events[receipt.evidence.sample_result.seq]!
      if (result.type !== 'tool/ptc-dispatch') throw Error('Fixture requires a PTC dispatch')
      result.data.parentCallId = ToolCallId('different-outer-call'); receipt.evidence.sample_result.sha256 = inputDigest(result)
    }
    if (failure === 'reversed_ancestor') receipt.evidence.sample_ancestors = [receipt.evidence.metadata_result]
    if (failure === 'metadata_after_sample') {
      const metadata = events[receipt.evidence.metadata_result.seq]!, result = events[receipt.evidence.sample_result.seq]!
      if (metadata.type !== 'tool/ptc-dispatch' || result.type !== 'tool/ptc-dispatch') throw Error('Fixture requires PTC results')
      events[result.seq] = { ...metadata, seq: result.seq }
      events[metadata.seq] = { ...result, seq: metadata.seq }
      const metadataRef = { seq: result.seq, sha256: inputDigest(events[result.seq]) }
      const sampleRef = { seq: metadata.seq, sha256: inputDigest(events[metadata.seq]) }
      receipt.evidence.metadata_result = metadataRef; receipt.evidence.sample_result = sampleRef
    }
    vi.spyOn(h.ctx.sessionQuery, 'observeSession').mockImplementation(async (id, options) => {
      const observation = await observe(id, options)
      return { ...observation, events, [Symbol.dispose]: () => { observation[Symbol.dispose]() } }
    })
    await expect(h.resolve(sample, receipt)).rejects.toThrow(/Video evidence/)
  },
)
