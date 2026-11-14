/** Real PTC programs bind independent video and text assessments to bounded file delivery. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parsePtcFixtureResult } from '../ptc-result.mjs'
import { importSnapshotModule, importSnapshotPackage } from '../../../../../snapshots/session/muse-fixture-import.mjs'
import { evidence, DRAFT, SOURCE, ASR, SELECTION, ROWS } from './evidence.mjs'

const owner = new URL('../../../package.json', import.meta.url)
const { LlmAdapter, ToolCallId } = await importSnapshotPackage('@deepseek-ai/dsh-llm', owner)
const revisions = await importSnapshotModule(new URL('../../../src/manuscript-revisions.ts', import.meta.url),
  new URL('../../../lib/manuscript-revisions.js', import.meta.url))
const present = await importSnapshotPackage('@deepseek-ai/dsh-tool-present', owner)
const PROVIDER = 'manuscript-video-binding-fixture', MODEL = 'selected-visual-model'
const TASK = '请依据这段视频新写一集短剧并交付Markdown文件；仅对实际抽样画面和保存ASR声明来源范围。'
const LABEL = '已复核本文件全部提取正文（仅当前版本）；来源仅核对抽样范围：source.mp4 0–6秒内2个原帧及保存ASR→正文第1–6行（未校听原音，未核验全片）'
const sourceArgs = (task = '核对明确映射的缓存原图和保存ASR，不声称原音或全片已核验。') => ({ action: 'source_fidelity', task,
  documents: [{ role: 'current', path: 'final.md' }], video_sources: SELECTION })
const textArgs = (task = '核对最终稿全部提取正文的因果衔接，不编辑文件。') => ({ action: 'continuity', task,
  documents: [{ role: 'current', path: 'final.md' }] })
const deliveryArgs = { action: 'delivery', source_mode: 'video', delivery_mode: 'reviewed', candidate_paths: ['final.md'] }
const invoke = args => `JSON.parse(await tools.manuscript_revision(${JSON.stringify(args)}))`
const deliver = `const delivery = ${invoke(deliveryArgs)};`
const show = 'await tools.present({files:[{path:"final.md",description:delivery.files[0].label}]});'
const caught = code => `let blocked=false,error=null;try{${code}}catch(cause){blocked=true;error=String(cause).match(/MANUSCRIPT_[A-Z_]+/)?.[0]??String(cause)}return {blocked,error};`
const programs = [
  { kind: 'review-and-present', code: `await tools.write({file_path:"final.md",content:${JSON.stringify(DRAFT)}});\nconst source=${invoke(sourceArgs())};\nconst text=${invoke(textArgs())};\n${deliver}\n${show}\nreturn {source:source.status,text:text.status,label:delivery.files[0].label};` },
  { kind: 'recover-compact-facts', code: `${deliver}\n${show}\nreturn {recovered:true,label:delivery.files[0].label};` },
  { kind: 'text-cannot-clear-source', error: 'MANUSCRIPT_DELIVERY_SOURCE_REQUIRED', code: `await tools.manuscript_revision(${JSON.stringify(sourceArgs('固定管道样例：保留来源问题，不宣称已解决。'))});\nawait tools.manuscript_revision(${JSON.stringify(textArgs())});\n${caught(deliver)}` },
  { kind: 'source-cannot-clear-text', error: 'MANUSCRIPT_DELIVERY_REVIEW_REQUIRED', code: `await tools.manuscript_revision(${JSON.stringify(textArgs('固定管道样例：保留文字问题，不宣称已解决。'))});\nawait tools.manuscript_revision(${JSON.stringify(sourceArgs())});\n${caught(deliver)}` },
  { kind: 'changed-before-declare', error: 'MANUSCRIPT_DELIVERY_SOURCE_STALE', code: `await tools.manuscript_revision(${JSON.stringify(textArgs())});\n${caught(deliver)}` },
  { kind: 'changed-before-dispatch', error: 'MANUSCRIPT_DELIVERY_SOURCE_STALE', code: caught(`${deliver}\n${show}`) },
  { kind: 'changed-during-dispatch', error: 'MANUSCRIPT_DELIVERY_SOURCE_STALE', code: caught(`${deliver}\n${show}`) },
  { kind: 'final-current-source', code: `${deliver}\n${show}\nreturn {currentSource:true,label:delivery.files[0].label};` },
]

export const name = 'manuscript-video-source-binding-fixture'
export const inject = ['llm', 'tools', 'fs', 'attachments', 'subagents', 'agentPresets']

function* call(name, args, id) {
  const text = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: ToolCallId(id), name, argumentsDelta: text }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: text } }
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

function reviewInput(options) {
  for (const message of options.messages) for (const block of message.content) {
    if (block.type !== 'text' || !block.text.startsWith('{')) continue
    try { const value = JSON.parse(block.text); if (value.materials && value.target) return value }
    catch (error) { assert.ok(error instanceof SyntaxError) }
  }
  throw Error('The actual child must receive numbered manuscript review material')
}

function anchor(input, number) {
  const document = input.materials.documents.find(document => document.path === input.target.path && document.role === input.target.role)
  const line = document?.lines.find(line => line.number === number)
  assert.ok(document && line)
  return { role: document.role, path: document.path, file_sha256: document.file_sha256,
    text_sha256: document.text_sha256, line: number, quote: line.text }
}

function report(input) {
  const faulty = input.task.includes('保留来源问题') || input.task.includes('保留文字问题')
  if (input.source_manifest) {
    const source = input.source_manifest.sources[0]
    const item = (id, line, mismatch = false) => ({ id, disposition: mismatch ? 'mismatch' : 'matched',
      explanation: '固定回复仅模拟待处理来源问题或通过状态，不证明视觉判断或剧情理解能力。', draft_evidence: [anchor(input, line)] })
    return { status: faulty ? 'issues' : 'consistent', findings: [], unknowns: [], source_checks: [{ mapping: source.mapping,
      status: faulty ? 'issues' : 'consistent', explanation: '仅按实际缓存材料测试绑定与失效，不宣称原音或全片已核验。',
      frame_checks: source.frames.map((frame, index) => item(frame.frame_id, 5, faulty && index === 0)),
      speech_checks: source.speech_segment_ids.map((id, index) => item(id, index === 0 ? 4 : 6)) }] }
  }
  return { status: faulty ? 'issues' : 'consistent', findings: faulty ? [{ category: 'object_state',
    description: '固定回复模拟文字审校待处理问题，仅验证来源通过不会清除文字问题。', evidence: [anchor(input, 4), anchor(input, 5)] }] : [], unknowns: [] }
}

function replayChunk(chunk, input) {
  const materialize = text => {
    const value = JSON.parse(text)
    const anchors = value.source_checks ? value.source_checks.flatMap(check => [...check.frame_checks, ...check.speech_checks]
      .flatMap(item => item.draft_evidence)) : value.findings.flatMap(finding => finding.evidence)
    for (const citation of anchors) {
      assert.equal(citation.path, '{{cwd}}/final.md')
      citation.path = input.target.path
    }
    return JSON.stringify(value)
  }
  if (chunk.type === 'tool-call-delta' && chunk.name === 'structured_output') return { ...chunk, argumentsDelta: materialize(chunk.argumentsDelta) }
  if (chunk.type === 'block-end' && chunk.block.type === 'tool-call' && chunk.block.name === 'structured_output') {
    return { ...chunk, block: { ...chunk.block, arguments: materialize(chunk.block.arguments) } }
  }
  return chunk
}

class BindingAdapter extends LlmAdapter {
  constructor(state) { super(); this.state = state }
  async resolveModel(provider, model) { return { provider, id: model, name: model, inputModalities: ['text', 'image'] } }
  async *stream(options) {
    const state = this.state
    if (options.sessionId !== state.parent.id) {
      const child = state.children.get(options.sessionId)
      assert.ok(child)
      yield* call('structured_output', report(child.input), `binding-review-${child.index + 1}`)
      return
    }
    const planned = programs[state.results.length]
    if (planned) { yield* call('run_code', { description: planned.kind, code: planned.code }, `binding-program-${state.results.length + 1}`); return }
    const text = '真实PTC已恢复紧凑来源事实并按限定范围交付；独立文字与来源问题互不清除，三处来源变化均无已复核成功回执。固定回复不证明语义质量。'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Install the real creation executor, durable metadata compaction and final-file guards. */
export async function apply(ctx) {
  const dispose = await ctx.agentPresets.register({ id: 'video-binding-creation', name: 'Video source binding PTC',
    description: 'Actual product creation policy and PTC executor with independent native reviewers.',
    plugins: [{ name: new URL('../manuscript-final-delivery/creation-preset.mjs', import.meta.url).href }] })
  ctx.effect(() => dispose)
  await ctx.plugin(present)
  const config = { continuityMaxOutputTokens: 4096, continuityMaxDeliveryCorrections: 0 }
  let fiber = await ctx.plugin(revisions, config)
  const state = { parent: undefined, children: new Map(), results: [], source: undefined, reloaded: false, sourceFact: undefined,
    compactSource: 0, compactText: 0, compactDelivery: 0, presentEvents: [], receipts: [], failedPresents: [], mutations: [], externalRequests: 0 }
  ctx.effect(() => {
    const fetch = globalThis.fetch
    globalThis.fetch = async () => { state.externalRequests++; throw Error('Source binding fixture refuses external requests') }
    return () => { globalThis.fetch = fetch }
  })
  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.header.parentSession !== undefined) {
      assert.equal(agent.session.header.parentSession, state.parent.id)
      state.children.set(agent.id, { index: state.children.size, input: undefined, requests: 0 })
      return
    }
    assert.equal(state.parent, undefined)
    state.parent = agent
    await ctx.agentPresets.select(agent, 'video-binding-creation')
    state.source = await evidence(ctx, agent)
  })
  ctx.on('tools/ptc-dispatch-log', async (dispatch, next) => {
    const content = await next()
    if (dispatch.agent !== state.parent || dispatch.name !== 'manuscript_revision' || dispatch.isError) return content
    const value = JSON.parse(dispatch.content.filter(block => block.type === 'text').map(block => block.text).join(''))
    if (!['continuity', 'video_source_review', 'delivery'].includes(value.state)) return content
    if (value.state === 'video_source_review') state.compactSource++
    else if (value.state === 'continuity') state.compactText++
    else state.compactDelivery++
    return [{ type: 'text', text: '[compact manuscript fact; authoritative metadata retained]' }]
  })
  ctx.on('session/event', (session, event) => {
    if (session !== state.parent?.session) return
    if (event.type === 'tool/ptc-dispatch' && !event.data.isError && event.data.name === 'manuscript_revision') {
      assert.deepEqual(event.data.content, [{ type: 'text', text: '[compact manuscript fact; authoritative metadata retained]' }])
      const fact = event.data.meta?.manuscript_delivery_fact
      assert.ok(fact)
      if (fact.state === 'video_source_review') {
        assert.equal(fact.source_manifest.scope, 'sampled_frames_and_saved_asr')
        if (fact.status === 'consistent') state.sourceFact = fact.source_manifest
      }
      if (fact.state === 'delivery') {
        assert.equal(fact.source_mode, 'video')
        assert.equal(fact.files[0].label, LABEL)
        assert.deepEqual(fact.files[0].source_reviews[0].source_manifest, state.sourceFact)
      }
    }
    if (event.type === 'deliverables/presented') {
      assert.equal(event.data.files.length, 1)
      assert.equal(event.data.files[0].description, LABEL)
      state.presentEvents.push(String(event.data.callId).split(':')[0])
    }
    if (event.type === 'tool/ptc-dispatch' && event.data.name === 'present') {
      const packets = event.data.content.flatMap(block => {
        if (block.type !== 'text' || !block.text.startsWith('{')) return []
        const value = JSON.parse(block.text)
        return value.manuscript_delivery_receipt ? [value.manuscript_delivery_receipt] : []
      })
      if (event.data.isError) { assert.equal(packets.length, 0); state.failedPresents.push(String(event.data.rootCallId)); return }
      assert.equal(packets.length, 1)
      assert.equal(packets[0].mode, 'reviewed')
      assert.deepEqual(packets[0].files[0].source_reviews[0].source_manifest, state.sourceFact)
      state.receipts.push(String(event.data.rootCallId))
    }
  })
  ctx.on('tools/pre-execute', async (execution, next) => {
    if (execution.agent === state.parent) {
      if (String(execution.callId).startsWith('binding-program-5:') && execution.name === 'manuscript_revision'
        && execution.arguments.action === 'delivery') {
        await state.source.mutate('video'); state.mutations.push('before-declare')
      }
      if (String(execution.callId).startsWith('binding-program-6:') && execution.name === 'present') {
        await state.source.mutate('asr'); state.mutations.push('before-dispatch')
      }
    }
    return next()
  })
  ctx.on('tools/execute', async (execution, next) => {
    const result = await next()
    if (execution.agent === state.parent && String(execution.callId).startsWith('binding-program-7:') && execution.name === 'present') {
      await state.source.mutate('image'); state.mutations.push('during-dispatch')
    }
    return result
  })
  ctx.on('tools/post-execute', async (execution, result, next) => {
    const decision = await next()
    if (execution.agent === state.parent && execution.callId === 'binding-program-1'
      && !result.isError && decision.kind === 'accept' && !state.reloaded) {
      await fiber.dispose()
      fiber = await ctx.plugin(revisions, config)
      state.reloaded = true
    }
    return decision
  })
  ctx.on('llm/stream', async function* (options, next) {
    if (options.provider !== PROVIDER || options.purpose !== undefined) { yield* next(); return }
    let child
    if (options.sessionId === state.parent.id) {
      assert.deepEqual(options.tools.map(tool => tool.name), ['run_code'])
      const result = options.messages.findLast(message => message.role === 'tool')
      if (result && result.toolCallId !== state.results.at(-1)?.call) {
        const index = state.results.length, planned = programs[index]
        assert.equal(result.toolCallId, `binding-program-${index + 1}`)
        const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('')
        assert.equal(result.isError, false, `${planned.kind}: ${text}`)
        const value = parsePtcFixtureResult(text)
        if (planned.error) { assert.equal(value.blocked, true); assert.equal(value.error, planned.error) }
        else {
          assert.equal(value.label, LABEL)
          if (index === 0) { assert.equal(value.source, 'consistent'); assert.equal(value.text, 'consistent') }
          if (index === 1) { assert.equal(value.recovered, true); assert.equal(state.reloaded, true) }
          if (index === 7) assert.equal(value.currentSource, true)
        }
        state.results.push({ call: result.toolCallId, case: planned.kind, error: planned.error ?? null })
        await state.source.reset()
      }
    } else {
      child = state.children.get(options.sessionId)
      assert.ok(child)
      child.requests++
      assert.equal(child.requests, 1)
      assert.deepEqual(options.tools.map(tool => tool.name), ['structured_output'])
      child.input = reviewInput(options)
      assert.equal(child.input.user_request.text, TASK)
      if (child.input.source_manifest) {
        const blocks = options.messages.flatMap(message => message.content)
        assert.deepEqual(blocks.filter(block => block.type === 'image').map(block => block.attachment), state.source.images)
        const packet = blocks.filter(block => block.type === 'text' && block.text.startsWith('{'))
          .map(block => JSON.parse(block.text)).find(value => value.saved_asr)
        assert.ok(packet)
        assert.deepEqual(packet.saved_asr.segments.map(segment => segment.raw), ROWS)
      }
    }
    for await (const chunk of next()) yield process.env.DSH_SNAPSHOT === 'replay' && child
      ? replayChunk(chunk, child.input) : chunk
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (agent !== state.parent) return
    assert.equal(state.results.length, programs.length)
    assert.equal(state.children.size, 7)
    assert.deepEqual([...state.children.values()].map(child => child.requests), [1, 1, 1, 1, 1, 1, 1])
    assert.deepEqual(state.presentEvents, ['binding-program-1', 'binding-program-2', 'binding-program-8'])
    assert.deepEqual(state.receipts, state.presentEvents)
    assert.deepEqual(state.failedPresents, ['binding-program-6', 'binding-program-7'])
    assert.deepEqual(state.mutations, ['before-declare', 'before-dispatch', 'during-dispatch'])
    assert.equal(state.externalRequests, 0)
    assert.equal(state.compactSource, 3); assert.equal(state.compactText, 4); assert.equal(state.compactDelivery, 5)
    const cwd = agent.session.header.cwd
    assert.equal(await readFile(join(cwd, 'final.md'), 'utf8'), DRAFT)
    assert.equal(await readFile(join(cwd, 'source.mp4'), 'utf8'), SOURCE)
    assert.equal(await readFile(join(cwd, 'source.asr.json'), 'utf8'), ASR)
    await writeFile(join(cwd, '_source-binding-probe.json'), JSON.stringify({
      actualParentExecutor: 'run_code', actualReviewerExecutor: 'structured_output', reviewerRequests: [1, 1, 1, 1, 1, 1, 1],
      compactFacts: { source: state.compactSource, text: state.compactText, delivery: state.compactDelivery },
      recoveredAfterHmr: state.reloaded, receiptContainsOriginalSourceManifest: true, descriptions: [LABEL, LABEL, LABEL],
      successfulPresentPrograms: state.presentEvents, successfulReceiptPrograms: state.receipts,
      rejectedPresentPrograms: state.failedPresents, mutationPoints: state.mutations,
      semanticModelQualityVerified: false, results: state.results,
    }, null, 2) + '\n')
  })
  if (!process.env.DSH_SNAPSHOT || process.env.DSH_SNAPSHOT === 'record') {
    ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], new BindingAdapter(state)))
  }
}
