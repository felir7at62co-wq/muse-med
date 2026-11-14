/** Real creation PTC bindings retain review receipts before dependent dispatches and after HMR. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parsePtcFixtureResult } from '../ptc-result.mjs'
import { importSnapshotModule, importSnapshotPackage } from '../../../../../snapshots/session/muse-fixture-import.mjs'

const owner = new URL('../../../package.json', import.meta.url)
const { LlmAdapter, ToolCallId } = await importSnapshotPackage('@deepseek-ai/dsh-llm', owner)
const revisions = await importSnapshotModule(new URL('../../../src/manuscript-revisions.ts', import.meta.url), new URL('../../../lib/manuscript-revisions.js', import.meta.url))
const toolPresent = await importSnapshotModule(new URL('../../../../../packages/deliverables/tool-present/src/index.ts', import.meta.url), new URL('../../../../../packages/deliverables/tool-present/lib/index.js', import.meta.url))
const accepted = await readFile(new URL('../manuscript-continuity/accepted.md', import.meta.url), 'utf8')
const PROVIDER = 'manuscript-ptc-delivery-fixture'
const MODEL = 'selected-creative-model'
const TASK = '用创作模式完成四集短剧，核对最终稿后交付文件。'
const firstProgram = `await tools.write({file_path:"ptc-final.md",content:${JSON.stringify(accepted)}});
const review = JSON.parse(await tools.manuscript_revision({action:"continuity",task:"核对最终四集正文的实际衔接，不编辑文件。",documents:[{role:"current",path:"current.md"},{role:"candidate",path:"ptc-final.md"}]}));
const delivery = JSON.parse(await tools.manuscript_revision({action:"delivery",delivery_mode:"reviewed",candidate_paths:["ptc-final.md"]}));
await tools.present({files:[{path:"ptc-final.md",description:delivery.files[0].label}]});
return {review_status:review.status,delivery_mode:delivery.mode,label:delivery.files[0].label};`
const replayProgram = `const delivery = JSON.parse(await tools.manuscript_revision({action:"delivery",delivery_mode:"reviewed",candidate_paths:["ptc-final.md"]}));
await tools.present({files:[{path:"ptc-final.md",description:delivery.files[0].label}]});
return {delivery_mode:delivery.mode,label:delivery.files[0].label,reloaded:true};`

export const name = 'manuscript-ptc-delivery-fixture'
export const inject = ['llm', 'tools', 'fs', 'subagents', 'agentPresets']

function* call(name, args, id) {
  const argumentsText = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: ToolCallId(id), name, argumentsDelta: argumentsText }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: argumentsText } }
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

class PtcAdapter extends LlmAdapter {
  constructor(state) { super(); this.state = state }
  async *stream(options) {
    if (options.sessionId !== this.state.parent.id) {
      yield* call('structured_output', { status: 'consistent', findings: [], unknowns: [] }, 'ptc-continuity-report')
    } else if (this.state.results.length < 2) {
      yield* call('run_code', { code: this.state.results.length === 0 ? firstProgram : replayProgram,
        description: this.state.results.length === 0 ? 'Review and deliver inside one real creation program' : 'Deliver from the rebuilt durable projection' }, `ptc-delivery-program-${this.state.results.length + 1}`)
    } else {
      const text = '同一创作程序已按真实审校范围交付；重挂后的投影从真实日志恢复，不重复调用审校模型。'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

/** @param {import('@deepseek-ai/cordis').Context} ctx - Shipped headless composition. */
export async function apply(ctx) {
  const disposePreset = await ctx.agentPresets.register({ id: 'delivery-creation-ptc', name: 'Real creation PTC delivery',
    description: 'Actual creation policy and executor; the reviewer keeps its independent native executor.',
    plugins: [{ name: new URL('./creation-preset.mjs', import.meta.url).href }] })
  ctx.effect(() => disposePreset)
  await ctx.plugin(toolPresent, { maxFiles: 8 })
  let revisionFiber = await ctx.plugin(revisions, { continuityMaxOutputTokens: 4096 })
  const release = Promise.withResolvers()
  const state = { parent: undefined, children: [], results: [], held: false, released: false, deliveryStartedWhileHeld: false,
    continuityCall: undefined, deliveryCall: undefined, reloaded: false, firstSucceeded: false, presented: 0,
    nativeCalls: [], dispatchStarts: [], dispatchSettles: [], order: [], notices: 0 }
  ctx.effect(() => {
    const original = globalThis.fetch
    globalThis.fetch = async () => { throw Error('Manuscript PTC delivery fixture refuses network access') }
    return () => { release.resolve(); globalThis.fetch = original }
  })
  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.header.parentSession !== undefined) { state.children.push({ agent, requests: 0 }); return }
    assert.equal(state.parent, undefined)
    state.parent = agent
    await ctx.agentPresets.select(agent, 'delivery-creation-ptc')
    await writeFile(join(agent.session.header.cwd, 'current.md'), accepted)
  })
  ctx.on('session/event', (session, event) => {
    if (session !== state.parent?.session) return
    if (event.type === 'tool/call') state.nativeCalls.push(event.data.name)
    if (event.type === 'tool/ptc-dispatch-start') {
      state.dispatchStarts.push({ id: event.data.subCallId, name: event.data.name, action: event.data.arguments.action })
      if (event.data.name === 'manuscript_revision' && event.data.arguments.action === 'continuity') state.continuityCall = event.data.subCallId
      if (event.data.name === 'manuscript_revision' && event.data.arguments.action === 'delivery' && state.deliveryCall === undefined) state.deliveryCall = event.data.subCallId
    }
    if (event.type === 'tool/ptc-dispatch') {
      state.dispatchSettles.push({ name: event.data.name, action: event.data.arguments.action, isError: event.data.isError })
      if (event.data.subCallId === state.continuityCall) state.order.push('continuity-logged')
    }
    if (event.type === 'tool/result' && event.data.message.toolCallId === 'ptc-delivery-program-1' && !event.data.message.isError) state.firstSucceeded = true
    if (event.type === 'deliverables/presented') state.presented++
    if (event.type === 'user/message' && event.data.source.kind === 'muse-manuscript'
      && event.data.source.summary === '剧本文件尚无有效交付回执') state.notices++
  })
  ctx.on('tools/ptc-dispatch-log', async (dispatch, next) => {
    if (dispatch.agent === state.parent && dispatch.subCallId === state.continuityCall) {
      assert.equal(dispatch.isError, false)
      state.held = true
      state.order.push('continuity-binding-settled-log-held')
      await release.promise
    }
    return next()
  })
  ctx.on('tools/pre-execute', async (execution, next) => {
    const decision = await next()
    if (execution.agent === state.parent && execution.callId === state.deliveryCall && !state.released) {
      assert.equal(state.held, true)
      state.deliveryStartedWhileHeld = true
      state.order.push('delivery-entered-before-continuity-log')
      setImmediate(() => {
        state.released = true
        state.order.push('release-continuity-log')
        release.resolve()
      })
    }
    return decision
  })
  ctx.on('tools/post-execute', async (execution, result, next) => {
    const decision = await next()
    if (execution.agent === state.parent && execution.callId === 'ptc-delivery-program-1'
      && !result.isError && decision.kind === 'accept' && !state.reloaded) {
      await revisionFiber.dispose()
      revisionFiber = await ctx.plugin(revisions, { continuityMaxOutputTokens: 4096 })
      assert.ok(ctx.tools.get('manuscript_revision', state.parent), JSON.stringify({
        revisionState: revisionFiber.state, fixtureState: ctx.fiber.state,
        visible: ctx.tools.definitions(state.parent).map(tool => tool.name),
      }))
      state.reloaded = true
    }
    return decision
  })
  ctx.on('llm/stream', async function* (options, next) {
    if (options.provider !== PROVIDER || options.purpose !== undefined) { yield* next(); return }
    assert.equal(options.model, MODEL)
    if (options.sessionId === state.parent.id) {
      assert.deepEqual((options.tools ?? []).map(tool => tool.name), ['run_code'])
      const last = options.messages.findLast(message => message.role === 'tool')
      if (last && last.toolCallId !== state.results.at(-1)?.call) {
        const text = last.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
        assert.equal(last.isError, false, text)
        const value = parsePtcFixtureResult(text)
        assert.equal(value.delivery_mode, 'reviewed')
        assert.equal(value.label, '已复核本文件全部提取正文（仅当前版本）')
        if (state.results.length === 0) assert.equal(value.review_status, 'consistent')
        else { assert.equal(value.reloaded, true); assert.equal(state.reloaded, true) }
        state.results.push({ call: last.toolCallId, reviewed: true, afterProjectionReload: state.results.length > 0 })
      }
    } else {
      const child = state.children.find(child => child.agent.id === options.sessionId)
      assert.ok(child)
      child.requests++
      assert.deepEqual((options.tools ?? []).map(tool => tool.name), ['structured_output'])
      assert.equal(options.maxTokens, 4096)
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (agent !== state.parent) return
    assert.equal(state.results.length, 2)
    assert.equal(state.children.length, 1)
    assert.deepEqual(state.children.map(child => child.requests), [1])
    assert.equal(state.presented, 2)
    assert.equal(state.notices, 0)
    assert.equal(state.deliveryStartedWhileHeld, true)
    assert.deepEqual(state.nativeCalls, ['run_code', 'run_code'])
    assert.deepEqual(state.order, ['continuity-binding-settled-log-held', 'delivery-entered-before-continuity-log', 'release-continuity-log', 'continuity-logged'])
    assert.deepEqual(state.dispatchSettles.map(item => item.isError), [false, false, false, false, false, false])
    assert.equal(await readFile(join(agent.session.header.cwd, 'ptc-final.md'), 'utf8'), accepted)
    await writeFile(join(agent.session.header.cwd, '_ptc-delivery-probe.json'), JSON.stringify({
      actualCreationExecutor: 'run_code', reviewerExecutor: 'structured_output', reviewerRequests: [1],
      heldContinuityLog: true, dependentDeliveryEnteredBeforeLog: true, explicitLogRelease: true,
      replayedProjectionAfterHmr: state.reloaded, successfulPresentEvents: state.presented, nativeCalls: state.nativeCalls,
      dispatches: state.dispatchSettles, order: state.order, results: state.results,
    }, null, 2) + '\n')
  })
  if (!process.env.DSH_SNAPSHOT || process.env.DSH_SNAPSHOT === 'record') ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], new PtcAdapter(state)))
}
