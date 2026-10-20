/** Real Loader, session model and native free-write paths with an offline Jubian server. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { encodeVoiceSlot } from '@deepseek-ai/dsh-jubian-api'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { sessionVideoShot } from './fixtures/session-video.ts'
import { speakingShot, tempDir, cleanup } from './harness.ts'

const disposers: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  vi.restoreAllMocks()
})

async function fixture() {
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
    return new Response(JSON.stringify({ code: 200, data }))
  })
  disposers.push(async () => { transport.mockRestore() })
  await writeFile(join(root, 'project_config.json'), JSON.stringify({ jubian_script_id: 4908 }))
  const source = [1, 2].map(number => speakingShot(number, '苏晚：我会好~好~享~用~的~', [
    '出镜人物：苏晚', '核心场景：后厨', '发声类型：dialogue', '时长：8秒',
  ])).join('\n\n')
  const script = join(root, 'shots.txt'); await writeFile(script, source)
  const f = await sessionVideoShot(root, { reviewMode: 'advisory', sessionVideoSelection: true,
    productionPackaging: true, production: { baseUrl: 'https://production.invalid', workspaceSecrets: false,
      ledgerRoot: join(root, 'ledger') } })
  disposers.push(f.dispose)
  await f.ctx.plugin(MemoryCredentials, { JUBIANAI_ADMIN_TOKEN: 'offline-test-token' })
  const agent = await f.create('session-production')
  let count = 0
  const call = async (args: Record<string, unknown>) => {
    const result = await f.ctx.tools.execute({ agent, name: 'muse_production', arguments: args,
      callId: ToolCallId(`production-${++count}`), signal: new AbortController().signal })
    if (result.isError) throw new Error(JSON.stringify(result.content))
    const block = result.content[0]
    if (block?.type !== 'text') throw new Error('Missing production report')
    return JSON.parse(block.text) as Record<string, unknown>
  }
  const preview = () => call({ method: 'preview', project_dir: root, script, episode: 1, ratio: '16:9', gen_type: 3,
    requirements: [{ shot: 1, kind: 'character', name: '苏晚', state: '红婚服' },
      { shot: 2, kind: 'character', name: '苏晚', state: '白中衣' }] })
  return { ...f, agent, root, script, source, assets, materials, cards, calls, call, preview,
    unknownCreate: () => { unknownCreate = true }, stringInventory: () => { stringInventory = true } }
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

it('retains a disputed costume choice as a warning and paginates complete candidate evidence', async () => {
  const f = await fixture(), first = await f.preview()
  const updated = await f.call({ method: 'update', plan_path: first.plan_path,
    choices: [{ shot: 2, kind: 'character', name: '苏晚', asset_id: 101 }], section: 'warnings', limit: 1 })
  expect(updated).toMatchObject({ mode: 'advisory', next_offset: 1 })
  const detail = await f.call({ method: 'read', plan_path: updated.plan_path, section: 'matches', limit: 100 })
  expect(detail).toMatchObject({ next_offset: null })
  expect(detail.rows).toContainEqual(expect.objectContaining({ shot: 2, kind: 'character', selected_asset_id: 101, selection_basis: 'explicit' }))
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
