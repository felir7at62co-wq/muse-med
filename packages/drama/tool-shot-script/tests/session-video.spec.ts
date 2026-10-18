/** Session-owned video budgets and logged rechecks preserve authored and formal files. */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId, createMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type {} from '../src/session-video.ts'
import { afterEach, expect, it } from 'vitest'
import { assetRow, cleanup, manifestDocument, speakingShot, tempDir } from './harness.ts'
import { sessionVideoShot } from './fixtures/session-video.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const dispose of cleanups.splice(0).reverse()) await dispose() })

async function workspace() {
  const root = await tempDir()
  cleanups.push(() => cleanup(root))
  const script = join(root, 'authored.txt')
  const assets = join(root, 'assets.json')
  const original = speakingShot(1, '苏晚：等一下，我还没有说完。', ['出镜人物：苏晚', '核心场景：后厨', '时长：20秒'])
  await writeFile(script, original)
  await writeFile(assets, JSON.stringify(manifestDocument(assetRow('苏晚', '角色'), assetRow('后厨', '场景'))))
  const formal = ['prompts/01.txt', 'matches/01.matched.json', 'episode_packages/01/manifest.json']
  for (const name of formal) {
    const path = join(root, name)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, `Existing formal file: ${name}\n`)
  }
  const before = await Promise.all([script, assets, ...formal.map(name => join(root, name))].map(path => readFile(path)))
  const unchanged = async () => {
    expect(await Promise.all([script, assets, ...formal.map(name => join(root, name))].map(path => readFile(path)))).toEqual(before)
    expect((await readdir(root)).some(name => /\.(png|jpg|webp)$/u.test(name))).toBe(false)
  }
  return { root, script, assets, unchanged, args: { method: 'preview', script, assets, project: root, episode: 1 } }
}

function latestChoiceText(agent: Agent): string {
  const event = agent.session.snapshotEvents().findLast(event => event.type === 'agent/inbox/spliced'
    && event.data.inserted.some(message => message.source?.kind === 'jubian-video-selection'))
  if (event?.type !== 'agent/inbox/spliced') throw new Error('Missing logged model-choice context')
  return event.data.inserted.flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

async function fixture(root: string, useDefault = true, selectionReviewMaxChars = 2000) {
  const f = await sessionVideoShot(root, { reviewMode: 'advisory', sessionVideoSelection: true, selectionReviewMaxChars }, useDefault)
  cleanups.push(f.dispose)
  return f
}

it('uses the conversation ceiling, ignores manual overrides and rechecks 30→15→30 without repacking or generating', async () => {
  const w = await workspace()
  const f = await fixture(w.root)
  const agent = await f.create('session-budget-owner')
  const options = await f.service.catalogue()
  const long = options.find(option => option.maxDurationSeconds === 30)!
  const short = options.find(option => option.maxDurationSeconds === 15)!
  await f.service.select(agent, long.key, 0)
  const first = await f.run(agent, { ...w.args, max_submit_seconds: 4 })
  expect(first).toMatchObject({ ok: true, review_mode: 'advisory', failures: [],
    duration_budget: { source: 'session', max_submit_seconds: 30, selection: { model_id: long.modelId, revision: 1 } } })
  expect(first.warnings.map(issue => issue.code)).toContain('session_video_budget_ignored')
  expect(first.warnings.map(issue => issue.code)).not.toContain('shot_exceeds_package_budget')
  expect(first.packages[0]).toMatchObject({ content_seconds: 20, submit_seconds: 21 })
  const requestsBefore = f.adapter.requests.length
  await f.service.select(agent, short.key, 1)
  expect(f.adapter.requests).toHaveLength(requestsBefore)
  const shorterContext = latestChoiceText(agent)
  expect(shorterContext).toContain('15')
  expect(shorterContext).toContain('21')
  expect(shorterContext).toContain('1')
  await w.unchanged()
  const second = await f.run(agent, w.args)
  expect(second).toMatchObject({ ok: true, failures: [],
    duration_budget: { source: 'session', max_submit_seconds: 15, selection: { revision: 2 } } })
  expect(second.warnings.map(issue => issue.code)).toContain('shot_exceeds_package_budget')
  expect(second.shots[0]?.duration_seconds).toBe(20)
  expect(second.packages[0]).toMatchObject({ content_seconds: 20, submit_seconds: 21 })
  await f.service.select(agent, long.key, 2)
  const third = await f.run(agent, w.args)
  expect(third.duration_budget).toMatchObject({ source: 'session', max_submit_seconds: 30, selection: { revision: 3 } })
  expect(third.warnings.map(issue => issue.code)).not.toContain('shot_exceeds_package_budget')
  expect(third.packages[0]).toMatchObject({ content_seconds: 20, submit_seconds: 21 })
  expect(f.requests.every(request => request.method === 'GET')).toBe(true)
  await w.unchanged()
  expect((await readdir(w.root)).includes('shot_reviews')).toBe(false)
  const systems = f.adapter.requests.map(request => request.messages.filter(message => message.role === 'system'))
  expect(systems.every(system => JSON.stringify(system) === JSON.stringify(systems[0]))).toBe(true)
})

it.each(['missing', 'unknown'] as const)('keeps %s model limits unknown instead of borrowing Seedance or the manual budget', async (kind) => {
  const w = await workspace()
  const f = await fixture(w.root, false)
  const agent = await f.create(`session-budget-${kind}`)
  if (kind === 'unknown') {
    const unknown = (await f.service.catalogue()).find(option => option.maxDurationSeconds === null)!
    await f.service.select(agent, unknown.key, 0)
  }
  const report = await f.run(agent, { ...w.args, max_submit_seconds: 30 })
  expect(report).toMatchObject({ ok: true, review_mode: 'advisory', failures: [], packages: [],
    duration_budget: { source: 'session', max_submit_seconds: null } })
  expect(report.duration_budget.selection === null).toBe(kind === 'missing')
  expect(report.shots[0]).toMatchObject({ duration_seconds: 20, text: '等一下，我还没有说完。' })
  expect(report.warnings.length).toBeGreaterThan(0)
  expect(f.requests.every(request => request.method === 'GET')).toBe(true)
  await w.unchanged()
})

it('initializes the configured default automatically and reports it even for validate', async () => {
  const w = await workspace()
  const f = await fixture(w.root)
  const agent = await f.create('session-budget-default')
  const report = await f.run(agent, { ...w.args, method: 'validate' })
  expect(report.duration_budget).toMatchObject({ source: 'session', max_submit_seconds: 30,
    selection: { model_id: 'doubao-seedance-2-5-260628', platform_id: 'FANG_ZHOU', resolution: '480p', revision: 1 } })
  expect(report.packages).toEqual([])
  expect(f.requests.every(request => request.method === 'GET')).toBe(true)
})

it('isolates conversations and restores the last review through actual JSONL cold resume', async () => {
  const w = await workspace()
  const first = await fixture(w.root)
  const a = await first.create('session-budget-a')
  const b = await first.create('session-budget-b')
  const options = await first.service.catalogue()
  const long = options.find(option => option.maxDurationSeconds === 30)!
  const short = options.find(option => option.maxDurationSeconds === 15)!
  await first.service.select(a, long.key, 0)
  await first.service.select(b, long.key, 0)
  await first.run(a, w.args)
  await first.service.select(a, short.key, 1)
  expect(first.service.current(b)?.maxDurationSeconds).toBe(30)
  expect(latestChoiceText(b)).not.toContain('21')
  await first.dispose()
  const reopened = await fixture(w.root)
  const restored = await reopened.resume('session-budget-a')
  expect(reopened.service.current(restored)).toMatchObject({ maxDurationSeconds: 15, revision: 2 })
  const before = reopened.adapter.requests.length
  await reopened.service.select(restored, long.key, 2)
  await reopened.service.select(restored, short.key, 3)
  expect(reopened.adapter.requests).toHaveLength(before)
  expect(latestChoiceText(restored)).toContain('21')
  expect(latestChoiceText(restored)).toContain('15')
  const report = await reopened.run(restored, w.args)
  expect(report.duration_budget).toMatchObject({ max_submit_seconds: 15, selection: { revision: 4 } })
  expect(report.warnings.map(issue => issue.code)).toContain('shot_exceeds_package_budget')
  expect(reopened.requests.every(request => request.method === 'GET')).toBe(true)
  await w.unchanged()
})

it('adds a logged warning when the selection changes after execution but before its result is recorded', async () => {
  const w = await workspace()
  const f = await fixture(w.root)
  const agent = await f.create('session-budget-late-switch')
  await f.service.initialize(agent)
  const short = (await f.service.catalogue()).find(option => option.maxDurationSeconds === 15)!
  f.ctx.on('tools/execute', async (exec, next) => {
    const result = await next()
    if (exec.name === 'drama_shot') await f.service.select(agent, short.key, 1)
    return result
  }, { global: true })
  const report = await f.run(agent, w.args)
  expect(report.duration_budget).toMatchObject({ max_submit_seconds: 30, selection: { revision: 1 } })
  expect(f.service.current(agent)).toMatchObject({ maxDurationSeconds: 15, revision: 2 })
  expect(latestChoiceText(agent)).toContain('分包检查期间会话视频模型已切换')
  expect(latestChoiceText(agent)).toContain('原提交21秒')
  expect(latestChoiceText(agent)).toContain('15 秒')
  expect(f.adapter.requests).toHaveLength(2)
  await w.unchanged()
})

it('retains compact result metadata, folds PTC outcomes and invalidates an unreadable newer plan', async () => {
  const w = await workspace()
  const f = await fixture(w.root)
  const agent = await f.create('session-budget-projection-source')
  const report = await f.run(agent, w.args)
  const result = agent.session.snapshotEvents().find(event => event.type === 'tool/result')
  if (result?.type !== 'tool/result') throw new Error('Missing real tool result')
  expect(result.data.meta).toHaveProperty('drama_shot_review')
  const projected = f.ctx.sessions.create(SessionId('session-budget-projection'), { meta: { cwd: w.root } })
  const appendResult = (id: string, method: 'preview' | 'validate', meta?: typeof result.data.meta) => {
    const callId = ToolCallId(id)
    projected.append('tool/call', { turn: 1, step: 1, callId, name: 'drama_shot', arguments: JSON.stringify({ method }) })
    projected.append('tool/result', { turn: 1, step: 1,
      message: createMessage({ role: 'tool', toolCallId: callId, source: { kind: 'tool', callId },
        content: [{ type: 'text', text: '[Earlier report content pruned]' }], isError: false }),
      ...(meta === undefined ? {} : { meta }) }, { surfaceOp: 'append' })
  }
  appendResult('pruned-review', 'preview', result.data.meta)
  const state = () => {
    const value = f.ctx.sessionProjections.stateOf(projected, 'dramaShotReview')
    if (value === undefined) throw new Error('Missing registered review projection')
    return value
  }
  expect(state().latest).toMatchObject({ available: true, packages: [{ submit_seconds: 21 }] })
  appendResult('pruned-validation', 'validate')
  expect(state().latest?.available).toBe(true)
  appendResult('unreadable-new-review', 'preview')
  expect(state().latest).toMatchObject({ available: false, packages: [] })
  const rootCallId = ToolCallId('ptc-review-root')
  const dispatch = { rootCallId, parentCallId: rootCallId, subCallId: ToolCallId('ptc-review-child'), name: 'drama_shot', arguments: { method: 'preview' } }
  projected.append('tool/ptc-dispatch-start', dispatch)
  projected.append('tool/ptc-dispatch', { ...dispatch, isError: false, content: [{ type: 'text', text: JSON.stringify(report) }] })
  expect(state().latest).toMatchObject({ available: true, revision: 1, packages: [{ submit_seconds: 21 }] })
  const checkpoint = f.ctx.sessionProjections.checkpoint(projected)
  const tail = projected.snapshotEvents().slice(-1)
  const last = tail[0]
  if (last === undefined) throw new Error('Missing persisted projection tail')
  const restored = f.ctx.sessionProjections.restore(checkpoint, tail, SessionLogOffset(last.seq), projected.header, SessionLogOffset(0))
  expect(restored.checkpoint['dramaShotReview']?.val).toEqual(checkpoint['dramaShotReview']?.val)
  expect(f.requests.every(request => request.method === 'GET')).toBe(true)
})

it('bounds long switch advice while preserving the total number of affected packages', async () => {
  const w = await workspace()
  const shots = Array.from({ length: 40 }, (_, index) => speakingShot(index + 1, '苏晚：我还没有说完。',
    ['出镜人物：苏晚', '核心场景：后厨', '时长：20秒'])).join('\n')
  await writeFile(w.script, shots)
  const f = await fixture(w.root, true, 400)
  const agent = await f.create('session-budget-bounded-review')
  const report = await f.run(agent, w.args)
  expect(report.packages).toHaveLength(40)
  const short = (await f.service.catalogue()).find(option => option.maxDurationSeconds === 15)!
  await f.service.select(agent, short.key, 1)
  const context = latestChoiceText(agent)
  const advice = context.slice(context.indexOf('本次复核'))
  expect(advice.length).toBeLessThanOrEqual(400)
  expect(advice).toContain('复核 40 包，其中 40 包')
  expect(advice).toContain('详细列表已省略')
  expect(await readFile(w.script, 'utf8')).toBe(shots)
  expect(f.adapter.requests).toHaveLength(2)
})
