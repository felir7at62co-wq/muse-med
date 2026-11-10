/** Cached original images and raw saved ASR travel through real isolated reviewer Sessions. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { importSnapshotModule, importSnapshotPackage } from '../../../../../snapshots/session/muse-fixture-import.mjs'

const owner = new URL('../../../package.json', import.meta.url)
const [{ LlmAdapter, ToolCallId }, { FsVersion }, { createVideoReviewReader }, { validateJsonSchemaValue }] = await Promise.all([
  importSnapshotPackage('@deepseek-ai/dsh-llm', owner), importSnapshotPackage('@deepseek-ai/dsh-fs', owner),
  importSnapshotPackage('@deepseek-ai/dsh-tool-video-inspect', owner), importSnapshotPackage('@deepseek-ai/dsh-tools', owner),
])
const revisions = await importSnapshotModule(new URL('../../../src/manuscript-revisions.ts', import.meta.url),
  new URL('../../../lib/manuscript-revisions.js', import.meta.url))
const PROVIDER = 'manuscript-video-source-fixture', MODEL = 'selected-visual-model'
const REVIEW_ID = 'fixture-video-source', FRAME_IDS = ['F00001', 'F00002']
const TASK = '只对明确映射的原片缓存图与保存ASR核对当前稿，保留未核实的身份与原音；不得修改文件。'
const PARENT_TASK = '检查视频转剧本的已映射来源材料，验证遗漏、伪造引用和材料变化不能获得已通过结论。'
const SOURCE = 'Synthetic local source bytes. Cached frames only; do not run a decoder.\n'
const DRAFT = '第1集\n1-1 门口 日 内\n人物：声音A、声音B\n声音A：旧床不要拆。\n▲床保持完整，两人站在门口。\n声音B：还没同意。\n'
const ASR_ROWS = [{ start: 1, end: 2, text: '旧床不要拆。', speaker_id: 'acoustic-A', raw_note: 'preserve raw row A' },
  { start: 3, end: 4, text: '还没同意。', speaker_id: 'acoustic-B', raw_note: 'preserve raw row B' }]
const ASR = JSON.stringify(ASR_ROWS) + '\n'
const OLD_OBSERVATION = 'UNTRUSTED_OLD_OBSERVATION_ALREADY_DEMOLISHED'
const CASES = ['complete', 'missing-frame', 'missing-speech', 'forged-draft-quote', 'forged-frame-id',
  'changed-video', 'changed-asr', 'changed-image']
const hash = value => createHash('sha256').update(value).digest('hex')

export const name = 'manuscript-video-source-fixture'
export const inject = ['llm', 'tools', 'fs', 'attachments', 'subagents', 'subprocess']

function* call(name, args, id) {
  const text = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: ToolCallId(id), name, argumentsDelta: text }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: text } }
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

function reviewerInput(options) {
  for (const message of options.messages) for (const block of message.content) {
    if (block.type !== 'text' || !block.text.startsWith('{')) continue
    try {
      const parsed = JSON.parse(block.text)
      if (parsed.materials && parsed.target) return parsed
    } catch (error) { assert.ok(error instanceof SyntaxError) }
  }
  throw Error('The real child must receive explicit manuscript and source review JSON')
}

function sourceManifest(input) {
  const manifest = input.source_manifest
  assert.ok(manifest, 'The source reviewer must receive its exact source manifest')
  return manifest
}

function anchor(input, line) {
  const target = input.materials.documents.find(document => document.role === input.target.role && document.path === input.target.path)
  assert.ok(target)
  const text = target.lines.find(item => item.number === line)
  assert.ok(text)
  return { role: target.role, path: target.path, file_sha256: target.file_sha256, text_sha256: target.text_sha256,
    line, quote: text.text }
}

function report(input, index) {
  const source = sourceManifest(input).sources[0]
  assert.ok(source)
  const item = (id, line) => ({ id, disposition: 'matched', explanation: '固定回复仅验证实际材料和引用的接线，不验证视觉或剧情判断质量。',
    draft_evidence: [anchor(input, line)] })
  const check = { mapping: source.mapping, status: 'consistent', explanation: '离线管道样例；不作原音或人物身份已验证的声明。',
    frame_checks: source.frames.map(frame => item(frame.frame_id, 5)),
    speech_checks: source.speech_segment_ids.map((id, position) => item(id, position === 0 ? 4 : 6)) }
  if (index === 1) check.frame_checks.pop()
  if (index === 2) check.speech_checks.pop()
  if (index === 3) check.frame_checks[0].draft_evidence[0].quote = '实际稿件没有这一句。'
  if (index === 4) check.frame_checks[0].id = 'F99999'
  return { status: 'consistent', findings: [], unknowns: [], source_checks: [check] }
}

function materializeArguments(text, input) {
  const value = JSON.parse(text)
  for (const check of value.source_checks) for (const item of [...check.frame_checks, ...check.speech_checks]) {
    for (const citation of item.draft_evidence) {
      assert.equal(citation.path, '{{cwd}}/current.md')
      citation.path = input.target.path
    }
  }
  return JSON.stringify(value)
}

function materializeChunk(chunk, input) {
  if (chunk.type === 'tool-call-delta' && chunk.name === 'structured_output') {
    return { ...chunk, argumentsDelta: materializeArguments(chunk.argumentsDelta, input) }
  }
  if (chunk.type === 'block-end' && chunk.block.type === 'tool-call' && chunk.block.name === 'structured_output') {
    return { ...chunk, block: { ...chunk.block, arguments: materializeArguments(chunk.block.arguments, input) } }
  }
  return chunk
}

class SourceAdapter extends LlmAdapter {
  constructor(state) { super(); this.state = state }
  async resolveModel(provider, model) { return { provider, id: model, name: model, inputModalities: ['text', 'image'] } }
  async *stream(options) {
    const state = this.state
    if (options.sessionId !== state.parent.id) {
      const child = state.children.get(options.sessionId)
      assert.ok(child)
      const value = report(child.input, child.index)
      const schema = options.tools.find(tool => tool.name === 'structured_output').parameters
      assert.deepEqual(validateJsonSchemaValue(schema, value), [], 'Every negative response must still satisfy the public JSON schema')
      yield* call('structured_output', value, `source-structured-${child.index + 1}`)
      return
    }
    const index = state.results.length
    if (index < CASES.length) {
      yield* call('manuscript_revision', { action: 'source_fidelity', task: TASK, documents: [{ role: 'current', path: 'current.md' }],
        video_sources: [{ review_id: REVIEW_ID, start_seconds: 0, end_seconds: 6,
          draft_lines: { start: 1, end: 6 }, frame_ids: FRAME_IDS }] }, `source-parent-${index + 1}`)
      return
    }
    const text = '离线管道确认原始缓存图与保存ASR进入独立会话；缺项、伪引用和证据变化没有保留已通过结论。固定回复不证明模型语义能力。'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Install only cached evidence and fixed responses; the real tool, files and spawned Sessions remain active. */
export async function apply(ctx) {
  await ctx.plugin(revisions, { continuityMaxRequests: 1, continuityMaxCorrections: 0, continuityMaxOutputTokens: 4096 }).await()
  const reader = await createVideoReviewReader(ctx)
  const state = { parent: undefined, children: new Map(), results: [], parentRequests: 0, decoded: 0, externalRequests: 0 }
  let originals, baseline
  const relativeSource = new Set(['source.mp4', 'source.asr.json'])
  ctx.effect(() => {
    const stat = ctx.fs.stat.bind(ctx.fs), resolve = ctx.fs.resolve.bind(ctx.fs), spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
    const fetch = globalThis.fetch
    globalThis.fetch = async () => { state.externalRequests++; throw Error('Cached source review fixture refuses external requests') }
    ctx.fs.resolve = async (path, options) => {
      const target = await resolve(path, options)
      return relativeSource.has(basename(target.displayPath))
        ? { ...target, displayPath: basename(target.displayPath) } : target
    }
    // Content hashes stabilize temporary stat metadata while preserving every actual source-byte change.
    ctx.fs.stat = async (target, signal) => {
      const info = await stat(target, signal)
      if (!info || !relativeSource.has(target.displayPath)) return info
      const bytes = await readFile(join(state.parent.session.header.cwd, target.displayPath))
      return { ...info, version: FsVersion(`source-fixture-${hash(bytes)}`) }
    }
    ctx.subprocess.spawn = () => { state.decoded++; throw Error('This cached source comparison must not run ffmpeg, ASR or any process') }
    return () => { ctx.fs.stat = stat; ctx.fs.resolve = resolve; ctx.subprocess.spawn = spawn; globalThis.fetch = fetch }
  })
  async function reset() {
    const cwd = state.parent.session.header.cwd
    await writeFile(join(cwd, 'source.mp4'), SOURCE)
    await writeFile(join(cwd, 'source.asr.json'), ASR)
    if (baseline !== undefined) state.parent.session.append('video/review', { kind: 'start', review: baseline })
  }
  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.header.parentSession !== undefined) {
      assert.equal(agent.session.header.parentSession, state.parent.id)
      state.children.set(agent.id, { agent, index: state.children.size, requests: 0, input: undefined })
      return
    }
    assert.equal(state.parent, undefined)
    state.parent = agent
    const cwd = agent.session.header.cwd
    await writeFile(join(cwd, 'current.md'), DRAFT)
    await reset()
    originals = await Promise.all(['frame-a.png', 'frame-b.png'].map(async name => ctx.attachments.saveImage({
      mediaType: 'image/png', data: await readFile(new URL(name, import.meta.url)) })))
    assert.notEqual(originals[0].attachmentId, originals[1].attachmentId)
    const source = await ctx.fs.resolve('source.mp4', { cwd }), sourceInfo = await ctx.fs.stat(source)
    const speech = await ctx.fs.resolve('source.asr.json', { cwd }), speechInfo = await ctx.fs.stat(speech)
    assert.ok(sourceInfo && speechInfo)
    baseline = { id: REVIEW_ID, episode: '1', path: 'source.mp4', source_version: sourceInfo.version,
      duration: 6, scanned_until: 6, scan_complete: true,
      transcript_reference: { path: 'source.asr.json', version: speechInfo.version, sha256: hash(ASR) },
      frames: FRAME_IDS.map((id, index) => ({ id, time: index === 0 ? 0.5 : 4.5, decoded_time: index === 0 ? 0.5 : 4.5,
        reasons: ['cached-test-frame'], image: originals[index], exposed: true,
        observation: { visible: OLD_OBSERVATION, change: '旧模型记录不构成原片事实。', uncertainty: '测试故意保存不可信的旧观察。' } })) }
    agent.session.append('video/review', { kind: 'start', review: baseline })
    assert.ok(reader(agent.session)['source.mp4'])
  })
  ctx.on('llm/stream', async function* (options, next) {
    if (options.provider !== PROVIDER || options.purpose !== undefined) { yield* next(); return }
    assert.equal(options.model, MODEL)
    let child
    if (options.sessionId === state.parent.id) {
      state.parentRequests++
      const result = options.messages.findLast(message => message.role === 'tool')
      if (result) {
        const index = state.results.length
        assert.equal(result.toolCallId, `source-parent-${index + 1}`)
        assert.equal(result.isError, false)
        const value = JSON.parse(result.content.filter(block => block.type === 'text').map(block => block.text).join(''))
        assert.equal(value.state, 'video_source_review')
        assert.equal(value.status, index === 0 ? 'consistent' : 'unknown', `${CASES[index]}: ${JSON.stringify({
          reason: value.reason, unknowns: value.unknowns, reviewer: value.reviewer })}`)
        assert.equal(value.reason, index === 0 ? 'reviewed' : index < 5 ? 'invalid_evidence' : 'source_changed')
        assert.equal(value.reviewer.requests, 1)
        assert.equal(value.reviewer.session_id, [...state.children.values()][index].agent.id)
        if (index === 0) {
          assert.equal(value.source_checks[0].frame_checks.length, 2)
          assert.equal(value.source_checks[0].speech_checks.length, 2)
        }
        state.results.push({ case: CASES[index], status: value.status, reason: value.reason })
        await reset()
      }
    } else {
      child = state.children.get(options.sessionId)
      assert.ok(child)
      child.requests++
      assert.equal(child.requests, 1)
      assert.equal(options.maxTokens, 4096)
      assert.deepEqual(options.tools.map(tool => tool.name), ['structured_output'])
      child.input = reviewerInput(options)
      assert.equal(child.input.task, TASK)
      assert.equal(child.input.user_request.text, PARENT_TASK)
      const manifest = sourceManifest(child.input)
      assert.equal(manifest.scope, 'sampled_frames_and_saved_asr')
      assert.equal(manifest.audio_verification, 'not_performed')
      assert.equal(manifest.asr_origin_and_speaker_verified, false)
      assert.deepEqual(manifest.sources[0].frames.map(frame => frame.frame_id), FRAME_IDS)
      assert.deepEqual(manifest.sources[0].speech_segment_ids, ['S00001', 'S00002'])
      const blocks = options.messages.flatMap(message => message.content)
      const images = blocks.filter(block => block.type === 'image')
      assert.equal(images.length, 2)
      assert.ok(images.every(image => image.offloaded !== true))
      assert.deepEqual(images.map(image => image.attachment), originals)
      for (const [index, image] of images.entries()) {
        assert.deepEqual((await ctx.attachments.readImage(image.attachment)).data,
          (await ctx.attachments.readImage(originals[index])).data)
      }
      const texts = blocks.filter(block => block.type === 'text').map(block => block.text)
      assert.ok(!texts.some(text => text.includes(OLD_OBSERVATION)), 'Previous model observations are not original visual evidence')
      const packet = texts.filter(text => text.startsWith('{')).map(text => JSON.parse(text)).find(value => value.saved_asr)
      assert.ok(packet)
      assert.deepEqual(packet.saved_asr.segments.map(segment => segment.raw), ASR_ROWS)
      assert.deepEqual(packet.saved_asr.segments.map(segment => [segment.start_seconds, segment.end_seconds]), [[1, 2], [3, 4]])
      const cwd = state.parent.session.header.cwd
      if (child.index === 5) await writeFile(join(cwd, 'source.mp4'), SOURCE + 'Changed source bytes.\n')
      if (child.index === 6) await writeFile(join(cwd, 'source.asr.json'), ASR.replace('不要拆', '已经拆'))
      if (child.index === 7) state.parent.session.append('video/review', { kind: 'start', review: { ...baseline,
        frames: baseline.frames.map((frame, index) => index === 0 ? { ...frame, image: originals[1] } : frame) } })
    }
    for await (const chunk of next()) yield process.env.DSH_SNAPSHOT === 'replay' && child !== undefined
      ? materializeChunk(chunk, child.input) : chunk
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (agent !== state.parent) return
    assert.equal(state.results.length, CASES.length)
    assert.equal(state.parentRequests, CASES.length + 1)
    assert.equal(state.children.size, CASES.length)
    assert.equal(state.decoded, 0)
    assert.equal(state.externalRequests, 0)
    const cwd = agent.session.header.cwd
    assert.equal(await readFile(join(cwd, 'current.md'), 'utf8'), DRAFT)
    assert.equal(await readFile(join(cwd, 'source.mp4'), 'utf8'), SOURCE)
    assert.equal(await readFile(join(cwd, 'source.asr.json'), 'utf8'), ASR)
    await writeFile(join(cwd, '_video-source-probe.json'), JSON.stringify({
      model: { provider: PROVIDER, model: MODEL }, parentRequests: state.parentRequests,
      childRequests: [...state.children.values()].map(child => child.requests),
      originalImagesReachedChild: true, savedAsrRowsAndTimesReachedChild: true,
      priorObservationNotSuppliedAsSource: true, decodedOrTranscribed: false, semanticModelQualityVerified: false,
      results: state.results,
    }, null, 2) + '\n')
  })
  if (!process.env.DSH_SNAPSHOT || process.env.DSH_SNAPSHOT === 'record') {
    ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], new SourceAdapter(state)))
  }
}
