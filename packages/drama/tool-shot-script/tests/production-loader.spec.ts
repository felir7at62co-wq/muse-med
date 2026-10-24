/** Real Loader, session model and native free-write paths with an offline Jubian server. */
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as Publication from '@deepseek-ai/dsh-tool-jubian'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { registerProductionTool } from '../src/production.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { encodeVoiceSlot } from '@deepseek-ai/dsh-jubian-api'
import type { ProductionConfig } from '../src/production.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { sessionVideoShot } from './fixtures/session-video.ts'
import { speakingShot, tempDir, cleanup } from './harness.ts'

const disposers: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

async function fixture(options: ProductionConfig = {}, useDefault = true, register = true) {
  const root = await tempDir(); disposers.push(() => cleanup(root))
  const catalogue = JSON.parse(await readFile(new URL('../../../jubian/jubian-api/tests/fixtures/catalogue-20261016.json',
    import.meta.url), 'utf8')) as Record<string, unknown>
  const assets = [
    { id: 101, scriptId: 4908, assetType: 1, assetName: '苏晚（红婚服）', assetUrl: 'https://cdn.example.test/red.png', delFlag: '0' },
    { id: 102, scriptId: 4908, assetType: 1, assetName: '苏晚（白中衣）', assetUrl: 'https://cdn.example.test/white.png', delFlag: '0' },
    { id: 201, scriptId: 4908, assetType: 2, assetName: '后厨', assetUrl: 'https://cdn.example.test/kitchen.png', delFlag: '0' },
  ]
  const materials = assets.map(row => ({ id: row.id + 1000, scriptId: 4908, assetId: row.id,
    hsAssetId: `asset-${row.id}`, assetName: row.assetName, assetUrl: row.assetUrl, isUsed: 1, hsAssetStatus: 'Active' }))
  const cards = new Map<number, Record<string, unknown>>()
  const calls: { method: string; path: string; body: Record<string, unknown> | undefined }[] = []
  let unknownCreate = false, stringInventory = false
  let transform: ((path: string, data: unknown) => unknown) | undefined
  const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const address = new URL(input instanceof Request ? input.url : String(input))
    if (address.hostname !== 'production.invalid') throw new Error('Unexpected provider host')
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
    calls.push({ method, path: address.pathname, body })
    let data: unknown
    if (address.pathname === '/model/charge/getSelectList') data = catalogue['1']
    else if (address.pathname === '/aigc/script/4908') data = { id: 4908, scriptName: 'Production fixture' }
    else if (address.pathname === '/aigc/episode/list') data = { total: 1, rows: [{ id: 102505, scriptId: 4908, episodeCount: 1 }] }
    else if (address.pathname === '/aigc/asset/list') data = { total: assets.length, rows: assets }
    else if (address.pathname === '/aigc/material/list') data = { total: materials.length, rows: materials }
    else if (/^\/aigc\/asset\/\d+$/u.test(address.pathname)) data = assets.find(row => row.id === Number(address.pathname.split('/').at(-1)))
    else if (address.pathname === '/aigc/storyboard/list') data = { total: cards.size, rows: [...cards.values()] }
    else if (/^\/aigc\/storyboard\/\d+$/u.test(address.pathname)) data = cards.get(Number(address.pathname.split('/').at(-1)))
    else if (address.pathname.includes('/video/task')) data = { total: 0, rows: [] }
    else if (address.pathname === '/aigc/storyboard' && body && method === 'POST') {
      const id = 10000 + cards.size
      const model = JSON.parse(String(body.modelConfig)) as Record<string, unknown>
      cards.set(id, { ...body, id, storyboardMaterialList: [], modelConfig: JSON.stringify({ ...model, materialList: [] }) })
      if (unknownCreate) throw new Error('Connection lost after creation')
      data = { id }
    } else if (address.pathname === '/aigc/storyboard' && body && method === 'PUT') {
      if (body.isGenerate !== 0) throw new Error('A free production write tried to generate a video')
      cards.set(Number(body.id), structuredClone(body)); data = body.id
    } else throw new Error(`Unexpected ${method} ${address.pathname}`)
    if (stringInventory && data && typeof data === 'object' && 'rows' in data && Array.isArray(data.rows)) {
      data = { ...data, rows: data.rows.map((row: Record<string, unknown>) => ({ ...row,
        ...Object.fromEntries(['id', 'scriptId', 'assetId', 'episodeId', 'episodeCount', 'assetType', 'isUsed']
          .filter(key => row[key] !== undefined).map(key => [key, String(row[key])])) })) }
    }
    if (transform) data = await transform(address.pathname, data)
    return new Response(JSON.stringify({ code: 200, data }))
  })
  disposers.push(async () => { transport.mockRestore() })
  await writeFile(join(root, 'project_config.json'), JSON.stringify({ jubian_script_id: 4908 }))
  const source = [1, 2].map(number => speakingShot(number, '苏晚：我会好~好~享~用~的~', [
    '出镜人物：苏晚', '核心场景：后厨', '发声类型：dialogue', '时长：8秒',
  ])).join('\n\n')
  const script = join(root, 'shots.txt'); await writeFile(script, source)
  const f = await sessionVideoShot(root, { reviewMode: 'advisory', sessionVideoSelection: true,
    productionPackaging: register, production: { baseUrl: 'https://production.invalid', workspaceSecrets: false,
      ledgerRoot: join(root, 'ledger'), ...options } }, useDefault)
  disposers.push(f.dispose)
  await f.ctx.plugin(MemoryCredentials, { JUBIANAI_ADMIN_TOKEN: 'offline-test-token' })
  const agent = await f.create('session-production')
  let count = 0
  const call = async (args: Record<string, unknown>, agentless = false, currentAgent = agent) => {
    const result = await f.ctx.tools.execute({ ...(agentless ? {} : { agent: currentAgent }), name: 'muse_production', arguments: args,
      callId: ToolCallId(`production-${++count}`), signal: new AbortController().signal })
    if (result.isError) throw new Error(JSON.stringify(result.content))
    const block = result.content[0]
    if (block?.type !== 'text') throw new Error('Missing production report')
    return JSON.parse(block.text) as Record<string, unknown>
  }
  const preview = (args: Record<string, unknown> = {}) => call({ method: 'preview', project_dir: root, script, episode: 1, ratio: '16:9', gen_type: 3,
    requirements: [{ shot: 1, kind: 'character', name: '苏晚', state: '红婚服' },
      { shot: 2, kind: 'character', name: '苏晚', state: '白中衣' }], ...args })
  return { ...f, agent, root, script, source, assets, materials, cards, calls, call, preview,
    unknownCreate: () => { unknownCreate = true }, stringInventory: () => { stringInventory = true },
    respond: (fn: typeof transform) => { transform = fn } }
}

it('previews appearances under Loader and publishes a batch once with actual image readback and no generation', async () => {
  const f = await fixture(), report = await f.preview()
  expect(report).toMatchObject({ mode: 'advisory', paid_requests: 0, summary: { packages: 1, unresolved: 2 } })
  expect(f.calls.every(call => call.method === 'GET')).toBe(true)
  const path = String(report.plan_path)
  const stored = JSON.parse(await readFile(path, 'utf8')) as { packages: { images: { asset_id: number }[] }[] }
  expect(stored.packages[0]?.images.map(row => row.asset_id)).toEqual([101, 201, 102])
  const applied = await f.call({ method: 'apply', plan_path: path })
  expect(applied, JSON.stringify(applied)).toMatchObject({ paid_requests: 0, saved: 1 })
  expect(f.cards.size).toBe(1)
  const writes = f.calls.filter(call => ['POST', 'PUT'].includes(call.method) && call.path === '/aigc/storyboard')
  expect(writes.length).toBeGreaterThan(0)
  expect(writes.every(call => call.body?.isGenerate === 0)).toBe(true)
  expect(await f.call({ method: 'apply', plan_path: path })).toMatchObject({ saved: 1 })
  expect(f.calls.filter(call => ['POST', 'PUT'].includes(call.method) && call.path === '/aigc/storyboard')).toHaveLength(writes.length)
  expect(await readFile(f.script, 'utf8')).toBe(f.source)
  const registry = f.ctx.tools
  await f.ctx.fiber.dispose()
  expect(registry.get('muse_production')).toBeUndefined()
})

it('reviews the actual native prepared prompt when cards are authored without compiler validation', async () => {
  const f = await fixture()
  await writeFile(f.script, f.source.replaceAll('发声类型：dialogue', '发声类型：dialogue\n动作复杂度：复杂'))
  const plan = await f.preview()
  await f.call({ method: 'apply', plan_path: plan.plan_path })
  const card = f.cards.get(10000)
  if (card === undefined) throw new Error('Missing authored card')
  const config = JSON.parse(String(card.modelConfig)) as Record<string, unknown>
  card.modelConfig = JSON.stringify({ ...config, prompt: String(config.prompt)
    + '\n动作预算：30秒\n发声预算：3秒\n反应预算：1秒\n表演顺序：先动作后台词' })
  await f.ctx.plugin(Publication, { baseUrl: 'https://production.invalid', workspaceSecrets: false,
    ledgerRoot: join(f.root, 'ledger') })
  const result = await f.ctx.tools.execute({ name: 'jubian_storyboard', agent: f.agent,
    arguments: { method: 'prepare_video', storyboard_id: 10000, project_dir: f.root },
    callId: ToolCallId('native-first-pass-review'), signal: new AbortController().signal })
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  const block = result.content[0]
  if (block?.type !== 'text') throw new Error('Missing native preparation result')
  const actual = JSON.parse(block.text) as {
    preview_path: string
    idempotencyKey: string
    first_pass_review: { status: string; findings: { code: string }[] }
  }
  expect(actual.first_pass_review).toMatchObject({ status: 'needs_review' })
  expect(actual.first_pass_review.findings).toContainEqual(expect.objectContaining({ code: 'action_stages_missing' }))
  expect(actual.first_pass_review.findings).toContainEqual(expect.objectContaining({ code: 'prepared_budget_exceeds_duration' }))
  const stored = JSON.parse(await readFile(actual.preview_path, 'utf8')) as Record<string, unknown>
  expect(stored.idempotencyKey).toBe(actual.idempotencyKey)
  expect(stored).not.toHaveProperty('first_pass_review')
  expect(f.calls.filter(call => call.method === 'PUT' && call.body?.isGenerate === 1)).toEqual([])
})

it('reports estimated performance overruns and speech errors before the first paid generation', async () => {
  const f = await fixture(), plan = await f.preview()
  await f.call({ method: 'apply', plan_path: plan.plan_path })
  const card = f.cards.get(10000)
  if (card === undefined) throw new Error('Missing authored card')
  const config = JSON.parse(String(card.modelConfig)) as Record<string, unknown>
  card.modelConfig = JSON.stringify({ ...config, duration: 4,
    prompt: String(config.prompt).replace(/台词：[^\n]*/u, '台词：苏晚：' + '这是保留原剧本的长台词。'.repeat(20))
      + '\n台词：另一个发声行。' })
  await f.ctx.plugin(Publication, { baseUrl: 'https://production.invalid', workspaceSecrets: false,
    ledgerRoot: join(f.root, 'ledger') })
  const result = await f.ctx.tools.execute({ name: 'jubian_storyboard', agent: f.agent,
    arguments: { method: 'prepare_video', storyboard_id: 10000, project_dir: f.root },
    callId: ToolCallId('native-first-pass-estimates'), signal: new AbortController().signal })
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  expect(result.value).toMatchObject({ first_pass_review: { status: 'needs_review', media_acceptance: false } })
  const text = JSON.stringify(result.value)
  expect(text).toContain('prepared_budget_exceeds_duration')
  expect(text).toContain('multiple_speech_lines')
  expect(f.calls.filter(call => call.method === 'PUT' && call.body?.isGenerate === 1)).toEqual([])
})

it('returns a bounded text-check result without claiming media approval when preparation has no findings', async () => {
  const f = await fixture(), plan = await f.preview()
  await f.call({ method: 'apply', plan_path: plan.plan_path })
  const card = f.cards.get(10000)
  if (card === undefined) throw new Error('Missing authored card')
  const config = JSON.parse(String(card.modelConfig)) as Record<string, unknown>
  card.modelConfig = JSON.stringify({ ...config,
    prompt: String(config.prompt).replace('【镜头1】', '【镜头1】\n场景时段：清晨') })
  await f.ctx.plugin(Publication, { baseUrl: 'https://production.invalid', workspaceSecrets: false,
    ledgerRoot: join(f.root, 'ledger') })
  const result = await f.ctx.tools.execute({ name: 'jubian_storyboard', agent: f.agent,
    arguments: { method: 'prepare_video', storyboard_id: 10000, project_dir: f.root },
    callId: ToolCallId('native-first-pass-text-only'), signal: new AbortController().signal })
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  expect(result.value).toMatchObject({ first_pass_review: { status: 'text_checks_passed', media_acceptance: false,
    scope: 'actual_prepared_prompt', findings: [] } })
})

it('flags missing scene time in a later native package without renumbering its original shots', async () => {
  const f = await fixture(), plan = await f.preview()
  await f.call({ method: 'apply', plan_path: plan.plan_path })
  const card = f.cards.get(10000)
  if (card === undefined) throw new Error('Missing authored card')
  const config = JSON.parse(String(card.modelConfig)) as Record<string, unknown>
  card.modelConfig = JSON.stringify({ ...config, prompt: String(config.prompt)
    .replace(/【镜头(\d+)】/gu, (_whole, number: string) => `【镜头${Number(number) + 14}】`) })
  await f.ctx.plugin(Publication, { baseUrl: 'https://production.invalid', workspaceSecrets: false,
    ledgerRoot: join(f.root, 'ledger') })
  const result = await f.ctx.tools.execute({ name: 'jubian_storyboard', agent: f.agent,
    arguments: { method: 'prepare_video', storyboard_id: 10000, project_dir: f.root },
    callId: ToolCallId('native-first-pass-scene-time'), signal: new AbortController().signal })
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  const actual = result.value as { first_pass_review: { status: string; findings: { code: string }[] } }
  expect(actual.first_pass_review.status).toBe('needs_review')
  expect(actual.first_pass_review.findings).toContainEqual(expect.objectContaining({ code: 'scene_time_missing' }))
  expect(JSON.stringify(result.value)).not.toContain('shot_numbering')
  expect(f.calls.filter(call => call.method === 'PUT' && call.body?.isGenerate === 1)).toEqual([])
})

it('reviews ordered physical steps in actual native preparation even without a complexity label', async () => {
  const f = await fixture(), plan = await f.preview()
  await f.call({ method: 'apply', plan_path: plan.plan_path })
  const card = f.cards.get(10000)
  if (card === undefined) throw new Error('Missing authored card')
  const config = JSON.parse(String(card.modelConfig)) as Record<string, unknown>
  card.modelConfig = JSON.stringify({ ...config, prompt: String(config.prompt).replace('【镜头1】',
    '【镜头1】\n场景时段：夜\n动作状态：【先比水位，再从下方灶膛抽柴，最后放到一边】；\n手部状态：【右手指锅、左手比水位】，【无】；') })
  await f.ctx.plugin(Publication, { baseUrl: 'https://production.invalid', workspaceSecrets: false,
    ledgerRoot: join(f.root, 'ledger') })
  const result = await f.ctx.tools.execute({ name: 'jubian_storyboard', agent: f.agent,
    arguments: { method: 'prepare_video', storyboard_id: 10000, project_dir: f.root },
    callId: ToolCallId('native-first-pass-ordered-action'), signal: new AbortController().signal })
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  const actual = result.value as { first_pass_review: { status: string; findings: { code: string }[] } }
  expect(actual.first_pass_review.status).toBe('needs_review')
  expect(actual.first_pass_review.findings).toContainEqual(expect.objectContaining({ code: 'action_stages_missing' }))
  expect(actual.first_pass_review.findings).toContainEqual(expect.objectContaining({ code: 'performance_budget_missing' }))
  expect(f.calls.filter(call => call.method === 'PUT' && call.body?.isGenerate === 1)).toEqual([])
})

it('retains a disputed costume choice as a warning and paginates complete candidate evidence', async () => {
  const f = await fixture(), first = await f.preview()
  const updated = await f.call({ method: 'update', plan_path: first.plan_path,
    choices: [{ shot: 2, kind: 'character', name: '苏晚', asset_id: 101 }], section: 'warnings', limit: 1 })
  expect(updated).toMatchObject({ mode: 'advisory', next_offset: 1 })
  const detail = await f.call({ method: 'read', plan_path: updated.plan_path, section: 'matches', limit: 100 })
  expect(detail).toMatchObject({ next_offset: null })
  expect(detail.rows).toContainEqual(expect.objectContaining({ shot: 2, kind: 'character', selected_asset_id: 101, selection_basis: 'explicit' }))
  const refreshed = await f.call({ method: 'update', plan_path: updated.plan_path, section: 'matches', limit: 100 })
  expect(refreshed.rows).toContainEqual(expect.objectContaining({ shot: 2, kind: 'character', selected_asset_id: 101 }))
  expect(f.calls.every(call => call.method === 'GET')).toBe(true)
  expect(await f.call({ method: 'apply', plan_path: updated.plan_path })).toMatchObject({ saved: 1 })
})

it('preserves user source edits and live card changes instead of restoring an old preview', async () => {
  const f = await fixture(), report = await f.preview()
  await writeFile(f.script, f.source + '\n用户新改稿\n')
  expect(await f.call({ method: 'apply', plan_path: report.plan_path })).toMatchObject({ status: 'source_changed' })
  expect(f.cards.size).toBe(0)
  await writeFile(f.script, f.source)
  expect(await f.call({ method: 'apply', plan_path: report.plan_path })).toMatchObject({ saved: 1 })
  const card = f.cards.values().next().value!
  card.storyboardName = '用户手工改名'
  const before = f.calls.length
  const result = await f.call({ method: 'apply', plan_path: report.plan_path })
  expect(result.results).toContainEqual(expect.objectContaining({ status: 'current_card_changed' }))
  expect(f.calls.slice(before).every(call => call.method === 'GET')).toBe(true)
  expect(card.storyboardName).toBe('用户手工改名')
})

it('does not repeat an uncertain create and leaves the original key available for reconciliation', async () => {
  const f = await fixture(), report = await f.preview(); f.unknownCreate()
  const first = await f.call({ method: 'apply', plan_path: report.plan_path })
  expect(first).toMatchObject({ saved: 0 })
  expect(f.cards.size).toBe(1)
  expect(await f.call({ method: 'apply', plan_path: report.plan_path })).toMatchObject({ saved: 1 })
  expect(f.calls.filter(call => call.method === 'POST' && call.path === '/aigc/storyboard')).toHaveLength(1)
})

it('reuses the adopted shared voice for both appearances and binds real audio without regenerating it', async () => {
  const f = await fixture()
  f.assets.push({ id: 401, scriptId: 4908, assetType: 4, assetName: `苏晚 ${encodeVoiceSlot(4908, 'su-wan', 'adult')}`,
    assetUrl: 'https://cdn.example.test/voice.wav', delFlag: '0' })
  await writeFile(join(f.root, 'project_config.json'), JSON.stringify({ jubian_script_id: 4908,
    project_bible: { characters: [{ character_id: 'su-wan', name: '苏晚', voice_profiles: [{ voice_period_id: 'adult',
      reference_audio_asset_id: 401, reference_audio: 'https://cdn.example.test/voice.wav',
      reference_audio_sha256: 'a'.repeat(64), reference_audio_duration_seconds: 2 }] }] } }))
  const report = await f.preview()
  const matches = await f.call({ method: 'read', plan_path: report.plan_path, section: 'matches', limit: 100 })
  expect((matches.rows as { kind: string; selected_asset_id: number | null }[]).filter(row => row.kind === 'voice')
    .map(row => row.selected_asset_id)).toEqual([401, 401])
  const applied = await f.call({ method: 'apply', plan_path: report.plan_path })
  expect(applied, JSON.stringify(applied)).toMatchObject({ saved: 1, paid_requests: 0 })
  const raw = f.cards.values().next().value!
  expect(raw.storyboardMaterialList).toContainEqual(expect.objectContaining({ materialType: 'audio',
    materialKey: 'voice_401', materialUrl: 'https://cdn.example.test/voice.wav', audioDuration: 2 }))
  expect(f.calls.some(call => call.method === 'POST' && /asset|video/u.test(call.path))).toBe(false)
})

it('rechecks under a newly selected model and keeps source and per-shot choices', async () => {
  const f = await fixture(), report = await f.preview(), agent = f.agent
  const short = (await f.service.catalogue()).find(option => option.maxDurationSeconds === 15)!
  await f.service.select(agent, short.key, f.service.current(agent)!.revision)
  expect(await f.call({ method: 'apply', plan_path: report.plan_path })).toMatchObject({ status: 'model_selection_changed' })
  const updated = await f.call({ method: 'update', plan_path: report.plan_path })
  expect(updated).toMatchObject({ model: { maxDurationSeconds: 15 }, summary: { packages: 2 } })
  expect(f.cards.size).toBe(0)
  expect(await readFile(f.script, 'utf8')).toBe(f.source)
})

it('restores a production review from a metadata-free PTC result and logs refresh advice after a model switch', async () => {
  const f = await fixture(), report = await f.preview()
  const rootCallId = ToolCallId('production-review-root')
  f.agent.session.append('tool/ptc-dispatch', { rootCallId, parentCallId: rootCallId,
    subCallId: ToolCallId('production-review-child'), name: 'muse_production', arguments: { method: 'preview' },
    isError: false, content: [{ type: 'text', text: JSON.stringify(report) }] })
  expect(f.ctx.sessionProjections.stateOf(f.agent.session, 'dramaShotReview')?.latest).toEqual(report.production_review)
  const short = (await f.service.catalogue()).find(option => option.maxDurationSeconds === 15)!
  await f.service.select(f.agent, short.key, f.service.current(f.agent)!.revision)
  const event = f.agent.session.snapshotEvents().findLast(event => event.type === 'agent/inbox/spliced'
    && event.data.inserted.some(message => message.source?.kind === 'jubian-video-selection'))
  if (event?.type !== 'agent/inbox/spliced') throw new Error('Missing logged model-switch advice')
  const text = event.data.inserted.flatMap(message => message.content)
    .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  expect(text).toContain('超过当前 15 秒上限')
  expect(text).toContain('muse_production update刷新当前模型分包和素材候选')
  expect(f.calls.every(call => call.method === 'GET')).toBe(true)
  expect(f.cards.size).toBe(0)
  expect(await readFile(f.script, 'utf8')).toBe(f.source)
})

it('updates an existing card with a visible asset comparison and keeps later user edits', async () => {
  const f = await fixture(), first = await f.preview()
  expect(await f.call({ method: 'apply', plan_path: first.plan_path })).toMatchObject({ saved: 1 })
  const fresh = await f.preview()
  const packages = fresh.package_index as { storyboard_id: number; current_assets: unknown[] }[]
  expect(packages[0]?.storyboard_id).toBe(10000)
  expect(packages[0]?.current_assets).toContainEqual(expect.objectContaining({ asset_id: 102 }))
  const changed = await f.call({ method: 'update', plan_path: fresh.plan_path,
    choices: [{ shot: 2, kind: 'character', name: '苏晚', asset_id: 101 }] })
  expect(await f.call({ method: 'apply', plan_path: changed.plan_path })).toMatchObject({ saved: 1 })
  expect(f.cards.size).toBe(1)
  const card = f.cards.get(10000)!
  const current = JSON.parse(String(card.modelConfig)) as Record<string, unknown>
  card.modelConfig = JSON.stringify({ ...current, prompt: '用户刚刚修改的台词' })
  const before = f.calls.length
  expect((await f.call({ method: 'apply', plan_path: changed.plan_path })).results)
    .toContainEqual(expect.objectContaining({ status: 'current_card_changed' }))
  expect(f.calls.slice(before).every(call => call.method === 'GET')).toBe(true)
})

it('recognizes numeric-string inventory and active flags without losing usable references', async () => {
  const f = await fixture(); f.stringInventory()
  const report = await f.preview()
  const detail = await f.call({ method: 'read', plan_path: report.plan_path, section: 'matches', limit: 100 })
  expect(detail.rows).toContainEqual(expect.objectContaining({ kind: 'character', shot: 2, selected_asset_id: 102 }))
  expect(await f.call({ method: 'apply', plan_path: report.plan_path })).toMatchObject({ saved: 1 })
  const fresh = await f.preview()
  expect(fresh.package_index).toContainEqual(expect.objectContaining({ storyboard_id: 10000 }))
})

it('keeps same-name cards separate until Muse chooses an exact existing target', async () => {
  const f = await fixture(), initial = await f.preview()
  expect(await f.call({ method: 'apply', plan_path: initial.plan_path })).toMatchObject({ saved: 1 })
  const original = f.cards.get(10000)
  if (!original) throw new Error('Missing published fixture card')
  f.cards.set(10001, { ...structuredClone(original), id: 10001 })
  const report = await f.preview(), before = f.calls.length
  expect((await f.call({ method: 'apply', plan_path: report.plan_path })).results)
    .toContainEqual(expect.objectContaining({ status: 'target_ambiguous' }))
  expect(f.calls.slice(before).every(call => call.method === 'GET')).toBe(true)
  const chosen = await f.call({ method: 'update', plan_path: report.plan_path,
    targets: [{ index: 1, storyboard_id: 10000 }] })
  expect(await f.call({ method: 'apply', plan_path: chosen.plan_path })).toMatchObject({ saved: 1 })
  expect(f.cards.size).toBe(2)
  expect(f.cards.get(10001)).toEqual({ ...original, id: 10001 })
})

it.each([{ offset: -1 }, { limit: 0 }, { limit: 101 }])('rejects an invalid pagination request %j', async (args) => {
  const f = await fixture()
  await expect(f.call({ method: 'preview', ...args })).rejects.toThrow('分页')
})

it('requires the original saved plan and a session only for model-dependent operations', async () => {
  const f = await fixture()
  await expect(f.call({ method: 'read' })).rejects.toThrow('plan_path')
  await expect(f.call({ method: 'preview' })).rejects.toThrow('preview需要')
  await expect(f.call({ method: 'preview', project_dir: f.root, script: f.script, episode: 1, gen_type: 3 })).rejects.toThrow('ratio')
  await expect(f.call({ method: 'preview', project_dir: f.root, script: f.script, episode: 1, ratio: '16:9' })).rejects.toThrow('ratio')
  await expect(f.call({ method: 'preview' }, true)).rejects.toThrow('当前会话')
  const report = await f.preview()
  expect(await f.call({ method: 'read', plan_path: report.plan_path, section: 'assets' }, true)).toMatchObject({ total: 3 })
  await expect(f.call({ method: 'apply', plan_path: report.plan_path }, true)).rejects.toThrow('当前会话')
  const tool = f.ctx.tools.get('muse_production')!
  expect(tool.presentCall?.({ method: 'apply' })).toMatchObject({ kind: 'edit' })
  expect(tool.presentCall?.({ method: 'read' })).toMatchObject({ kind: 'read' })
  expect(tool.isConcurrencySafe?.({ method: 'read' })).toBe(true)
  expect(tool.isConcurrencySafe?.({ method: 'apply' })).toBe(false)
})

it.each([{ maxSourceBytes: 4 }, { maxShots: 1 }])('enforces bounded complete source acquisition %j', async (config) => {
  const f = await fixture(config)
  await expect(f.preview()).rejects.toThrow('超过')
  expect(f.cards.size).toBe(0)
})

it('requires a known selected model and a unique actual remote episode', async () => {
  const noSelection = await fixture({}, false)
  await expect(noSelection.preview()).rejects.toThrow('视频模型')
  const f = await fixture({ timeoutMs: 10_000 })
  f.respond((path, data) => path === '/aigc/episode/list' ? { total: 0, rows: [] } : data)
  await expect(f.preview()).rejects.toThrow('episode_id')
})

it('preserves a tampered plan or invalid receipt instead of silently rebuilding or replaying it', async () => {
  const f = await fixture(), report = await f.preview(), path = String(report.plan_path)
  const original = await readFile(path, 'utf8')
  const modified = JSON.parse(original) as Record<string, unknown>
  modified.source = '外部替换'
  await writeFile(path, JSON.stringify(modified))
  await expect(f.call({ method: 'read', plan_path: path })).rejects.toThrow('外部修改')
  await writeFile(path, original)
  const other = join(f.root, 'copied.json'); await copyFile(path, other)
  await expect(f.call({ method: 'read', plan_path: other })).rejects.toThrow('路径')
  await writeFile(path.replace(/\.json$/u, '.receipts.json'), 'broken')
  await expect(f.call({ method: 'apply', plan_path: path })).rejects.toThrow()
  expect(f.cards.size).toBe(0)
})

it('reads local registration changes but refuses malformed metadata and rebound projects', async () => {
  const f = await fixture()
  await writeFile(join(f.root, 'assets_manifest.json'), '{')
  await expect(f.preview()).rejects.toThrow()
  await writeFile(join(f.root, 'assets_manifest.json'), JSON.stringify({ items: [{ jubian_asset_id: 101,
    url: f.assets[0]!.assetUrl, aliases: ['阿晚'] }] }))
  const first = await f.preview()
  await writeFile(f.script, f.source + '\n用户已修改\n')
  const updated = await f.call({ method: 'update', plan_path: first.plan_path, section: 'warnings' })
  expect(updated.rows).toContainEqual(expect.objectContaining({ code: 'source_changed' }))
  await writeFile(join(f.root, 'project_config.json'), JSON.stringify({ jubian_script_id: 999 }))
  await expect(f.call({ method: 'apply', plan_path: updated.plan_path })).rejects.toThrow('绑定已变化')
})

it('refreshes per-shot requirements and detects a model change occurring during acquisition', async () => {
  const f = await fixture(), first = await f.preview()
  const short = (await f.service.catalogue()).find(option => option.maxDurationSeconds === 15)!
  let switched = false
  f.respond(async (path, data) => {
    if (!switched && path === '/aigc/script/4908') {
      switched = true
      await f.service.select(f.agent, short.key, f.service.current(f.agent)!.revision)
    }
    return data
  })
  const changed = await f.call({ method: 'update', plan_path: first.plan_path,
    requirements: [{ shot: 1, kind: 'character', name: '苏晚', state: '白中衣' }], section: 'warnings' })
  expect(changed.rows).toContainEqual(expect.objectContaining({ code: 'model_changed_during_preview' }))
  expect(changed.model).toMatchObject({ maxDurationSeconds: 30 })
})

it('enforces package limits after reflow and refuses foreign or duplicate existing targets', async () => {
  const limited = await fixture({ maxPackages: 1 })
  const short = (await limited.service.catalogue()).find(option => option.maxDurationSeconds === 15)!
  await limited.service.initialize(limited.agent)
  await limited.service.select(limited.agent, short.key, limited.service.current(limited.agent)!.revision)
  await expect(limited.preview()).rejects.toThrow('视频包上限')
  const f = await fixture(), first = await f.preview()
  expect(await f.call({ method: 'apply', plan_path: first.plan_path })).toMatchObject({ saved: 1 })
  await expect(f.preview({ targets: [{ index: 1, storyboard_id: 99 }] })).rejects.toThrow('库存')
  const card = f.cards.get(10000)!
  card.episodeId = 999
  await expect(f.preview({ targets: [{ index: 1, storyboard_id: 10000 }] })).rejects.toThrow('另一集')
  card.episodeId = 102505
  await f.service.select(f.agent, short.key, f.service.current(f.agent)!.revision)
  await expect(f.preview({ targets: [{ index: 1, storyboard_id: 10000 }, { index: 2, storyboard_id: 10000 }] })).rejects.toThrow('同一原卡')
  const omitted = await f.preview({ targets: [{ index: 1, storyboard_id: null }] })
  expect(omitted.package_index).toContainEqual(expect.objectContaining({ index: 1, storyboard_id: null }))
})

it('stops the remaining batch when a selection save unexpectedly creates a task', async () => {
  const f = await fixture()
  await f.service.initialize(f.agent)
  const short = (await f.service.catalogue()).find(option => option.maxDurationSeconds === 15)!
  await f.service.select(f.agent, short.key, f.service.current(f.agent)!.revision)
  const first = await f.preview()
  let reads = 0
  f.respond((path, data) => {
    if (path.includes('/video/task')) {
      reads++
      return reads > 1 ? { total: 1, rows: [{ id: 44, scriptId: 4908, storyboardId: 10000, taskStatus: 'submit' }] } : data
    }
    return data
  })
  const result = await f.call({ method: 'apply', plan_path: first.plan_path })
  expect(result).toMatchObject({ processed: 1, unattempted: 1, saved: 0 })
  expect(result.results).toContainEqual(expect.objectContaining({ status: 'billing_safety_violation' }))
  expect(f.cards.size).toBe(1)
})

it('fails registration without its required services and resolves deployment defaults without network access', async () => {
  const ctx = new Context()
  try { await expect(registerProductionTool(ctx, {}, 2)).rejects.toThrow('凭证') } finally { await ctx.fiber.dispose() }
  const f = await fixture({}, true, false)
  vi.stubEnv('DSH_HOME', undefined)
  await registerProductionTool(f.ctx, {}, 2)
  expect(f.ctx.tools.get('muse_production')).toBeDefined()
  expect(f.calls).toHaveLength(0)
})

it.each([false, true])('loads the production tool with omitted settings through programmatic=%s composition without contacting Jubian', async (programmatic) => {
  const root = await tempDir(); disposers.push(() => cleanup(root))
  vi.stubEnv('DSH_HOME', root)
  const f = await sessionVideoShot(root, { reviewMode: 'advisory', sessionVideoSelection: true, productionPackaging: true }, true, programmatic)
  disposers.push(f.dispose)
  await f.ctx.plugin(MemoryCredentials, {})
  const agent = await f.create('production-default-config')
  expect(f.ctx.tools.get('muse_production', agent)).toBeDefined()
  expect(f.requests).toEqual([])
})

it('uses a configured home and fails a missing credential before any provider request', async () => {
  const f = await fixture({}, true, false)
  vi.stubEnv('DSH_HOME', f.root)
  await registerProductionTool(f.ctx, { baseUrl: 'https://production.invalid', workspaceSecrets: false }, 2)
  await f.ctx.credentials.unset(credentialRef('JUBIANAI_ADMIN_TOKEN'))
  await expect(f.preview()).rejects.toThrow()
  expect(f.calls).toHaveLength(0)
})

it('supports an absolute project from a session without cwd or a named remote project', async () => {
  const f = await fixture()
  f.respond((path, data) => path === '/aigc/script/4908' ? { id: 4908 } : data)
  const agent = (await f.ctx.agents.create({ sessionId: SessionId('without-cwd'), agentOptions: { provider: 'mock', model: 'mock' }, meta: {} })).agent
  const report = await f.call({ method: 'preview', project_dir: f.root, script: f.script, episode: 1,
    ratio: '16:9', gen_type: 3 }, false, agent)
  expect(report).toMatchObject({ script_id: 4908 })
})

it('keeps readable legacy current-material fields in the preview even when their metadata is incomplete', async () => {
  const f = await fixture(), first = await f.preview()
  expect(await f.call({ method: 'apply', plan_path: first.plan_path })).toMatchObject({ saved: 1 })
  const card = f.cards.get(10000)!
  card.storyboardMaterialList = [
    { materialKey: 'legacy_a', materialType: 'audio', assetName: '旧名字' },
    { materialKey: 'legacy_b', materialType: 'audio' },
  ]
  const report = await f.preview()
  expect(report.package_index).toContainEqual(expect.objectContaining({ current_assets: [
    expect.objectContaining({ name: '旧名字', asset_id: null, url: null }),
    expect.objectContaining({ name: '', asset_id: null, url: null }),
  ] }))
})

it('retains a non-Error publication failure for reconciliation and continues other independent packages', async () => {
  vi.spyOn(Publication, 'publishProductionCard').mockRejectedValueOnce('uncertain provider failure')
  const f = await fixture(), first = await f.preview()
  const result = await f.call({ method: 'apply', plan_path: first.plan_path })
  expect(result.results).toContainEqual(expect.objectContaining({ status: 'reconcile_required', error: 'Publication failed' }))
  expect(f.cards.size).toBe(0)
})

it('keeps an incomplete creation receipt unsaved and retains the original reconciliation response', async () => {
  vi.spyOn(Publication, 'publishProductionCard').mockResolvedValueOnce({ status: 'reconcile_required', original_key: 'original-create' })
  const f = await fixture(), report = await f.preview()
  expect(await f.call({ method: 'apply', plan_path: report.plan_path })).toMatchObject({ saved: 0,
    results: [expect.objectContaining({ status: 'reconcile_required', original_key: 'original-create' })] })
  expect(f.cards.size).toBe(0)
})
