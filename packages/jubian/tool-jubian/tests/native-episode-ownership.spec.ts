/** Historical episode conflicts require the task's actual storyboard ownership before blocking a new submission. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { prepareVideoMethod, submitVideoBatchMethod, submitVideoMethod } from '../src/native.ts'

const image = 'https://media.example/lead.png'
const model = { platformId: 'YU_DIAN', modelId: 'doubao-seedance-2-0-260128', standardId: 11, genType: 3,
  modelGenerationTypeId: 7, videoStandardId: 91, duration: 8, ratio: '9:16', resolution: '720p', genNum: 1,
  materialList: [], backupModelList: [], prompt: '@[Lead](lead) stands still.' }
const storyboard = { id: 916953, scriptId: 2708, episodeId: 401, episodeCount: 1, isGenerate: 1,
  storyboardName: 'Episode one', modelConfig: JSON.stringify(model), storyboardMaterialList: [{
    assetId: 'asset-lead', materialAssetId: 81285, fileName: 'Lead', materialKey: 'lead',
    materialType: 'image', materialUrl: image, sortOrder: 1,
  }] }
const oldTask = { id: 100000, scriptId: 2708, taskType: 1, episodeId: 400, episodeCount: 1 }
type Row = Record<string, unknown>
type SubmitMode = 'single' | 'batch'

async function fixture(episode: { episodeCount?: number | null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'jubian-native-episode-ownership-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  const project = join(root, 'project'), ledgerRoot = join(root, 'ledger')
  await mkdir(project)
  await mkdir(ledgerRoot)
  await writeFile(join(project, 'project_config.json'), JSON.stringify({ jubian_script_id: 2708 }))
  await writeFile(join(ledgerRoot, 'authorization.json'), JSON.stringify({ version: 1, projects: {
    '2708': { limit: '1000', unit: 'CNY', estimates: { storyboard_native_submit: '1' } },
  } }))
  const ledger = new JubianLedger({ root: ledgerRoot })
  const board = { ...storyboard, ...episode }
  const calls: { method: string; path: string; body?: Row }[] = []
  const state: { tasks: Row[]; details: Record<string, Row | null>; children: Record<string, Row[]> } = {
    tasks: [], details: {}, children: {},
  }
  const client = new JubianClient({ credential: async () => 'mock-token', fetch: async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString()), path = url.pathname.replace('/prod-api', '')
    const method = String(init?.method)
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Row : undefined
    calls.push({ method, path, ...(body === undefined ? {} : { body }) })
    const answer = (data: unknown) => Response.json({ code: 200, data })
    if (path === '/aigc/storyboard' && method === 'PUT') {
      state.tasks.push({ id: 500000, scriptId: 2708, storyboardId: 916953, taskType: 1, episodeId: 401, episodeCount: 1 })
      state.children['500000'] = [{ id: 500001, aigcVideoTaskId: 500000, storyboardId: 916953,
        taskStatus: 'submit', imageMaterials: body?.storyboardMaterialList, modelConfig: body?.modelConfig }]
      return answer(null)
    }
    if (path === '/aigc/storyboard/916953') return answer(board)
    if (path === '/aigc/asset/81285') return answer({ id: 81285, scriptId: 2708, assetUrl: image, name: 'Lead' })
    if (path === '/aigc/material/list') return answer({ total: 1, rows: [{ id: 1, assetId: 81285, scriptId: 2708,
      hsAssetId: 'asset-lead', assetUrl: image, assetName: 'Lead', hsAssetStatus: 'Active', isUsed: 1 }] })
    if (path === '/model/charge/getSelectList') return answer([{ id: 11, standardId: 11, modelId: model.modelId,
      platformId: 'YU_DIAN', duration: 8, genNum: 1, genTypes: [{ id: 7, type: 3 }],
      videoStandards: [{ id: 91, ratio: '9:16', resolution: '720p', genNum: 1 }] }])
    if (path === '/admin/aigc/video/task/list') {
      const page = Number(url.searchParams.get('pageNum')), size = Number(url.searchParams.get('pageSize'))
      return answer({ total: state.tasks.length, rows: state.tasks.slice((page - 1) * size, page * size) })
    }
    if (path === '/admin/aigc/video/task/sub/list') {
      const rows = state.children[String(body?.aigcVideoTaskId)] ?? []
      return answer({ total: rows.length, rows })
    }
    if (path.startsWith('/admin/aigc/video/task/')) {
      const id = path.split('/').at(-1)!
      return answer(Object.hasOwn(state.details, id) ? state.details[id] : state.tasks.find(task => String(task.id) === id))
    }
    throw new Error(`Unexpected fixture request: ${method} ${path}`)
  } })
  const preview = await prepareVideoMethod(client, ledger, { storyboard_id: 916953, project_dir: project })
  const args = { preview_path: String(preview.preview_path), idempotency_key: String(preview.idempotencyKey) }
  const frozen = await readFile(args.preview_path, 'utf8')
  calls.length = 0
  return { state, calls, ledger, args, frozen,
    submit: (mode: SubmitMode) => mode === 'single' ? submitVideoMethod(client, ledger, args)
      : submitVideoBatchMethod(client, ledger, { items: [args] }),
    writes: () => calls.filter(call => call.method === 'PUT'),
  }
}

it.each(['single', 'batch'] as const)('submits and replays the original %s key after another card retains the previous episode ID', async (mode) => {
  const f = await fixture()
  f.state.tasks = [oldTask]
  f.state.details['100000'] = { ...oldTask, storyboardId: 999999 }
  f.state.children['100000'] = [{ id: 100001, aigcVideoTaskId: 100000, storyboardId: 999999 }]
  const result = await f.submit(mode)
  expect(result).toMatchObject(mode === 'single' ? { status: 'submitted', task_id: '500000' }
    : { submitted: 1, results: [{ status: 'submitted', task_id: '500000' }] })
  expect(await f.submit(mode)).toMatchObject(mode === 'single' ? { status: 'submitted', replayed: true }
    : { submitted: 1, results: [{ status: 'submitted', replayed: true }] })
  expect(f.calls.some(call => call.path === '/admin/aigc/video/task/100000')).toBe(true)
  expect(f.writes()).toHaveLength(1)
  expect(await f.ledger.records()).toHaveLength(1)
  expect(await readFile(f.args.preview_path, 'utf8')).toBe(f.frozen)
})

it('excludes a historical task whose complete child list names only other cards', async () => {
  const f = await fixture()
  f.state.tasks = [oldTask]
  f.state.children['100000'] = [{ id: 100001, aigcVideoTaskId: 100000, storyboardId: 999999 }]
  expect(await f.submit('single')).toMatchObject({ status: 'submitted' })
  expect(f.writes()).toHaveLength(1)
})

it.each([
  { scope: { episodeId: 400, episodeCount: 1 }, source: 'list' },
  { scope: { episodeId: 401, episodeCount: 2 }, source: 'list' },
  { scope: { episodeId: 400, episodeCount: 2 }, source: 'owned-list' },
  { scope: { episodeId: 400, episodeCount: 1 }, source: 'detail' },
])('identifies the same-card conflict from $source with both episode axes: $scope', async ({ scope, source }) => {
  const f = await fixture()
  f.state.tasks = [source === 'detail' ? { id: 100000, scriptId: 2708, taskType: 1 }
    : { ...oldTask, ...scope, ...(source === 'owned-list' ? { storyboardId: 916953 } : {}) }]
  f.state.details['100000'] = { ...oldTask, ...scope, storyboardId: 916953 }
  f.state.children['100000'] = [{ id: 100001, aigcVideoTaskId: 100000, storyboardId: 916953 }]
  const result = f.submit('single')
  await expect(result).rejects.toMatchObject({ code: 'VIDEO_TASK_EVIDENCE_INVALID' })
  await expect(result).rejects.toThrow('task_id=100000; storyboard_id=916953;')
  await expect(result).rejects.toThrow(`task_episode_id=${scope.episodeId}; task_episode_count=${scope.episodeCount};`)
  await expect(result).rejects.toThrow('preview_episode_id=401; preview_episode_count=1;')
  await expect(result).rejects.toThrow('read_only=true')
  expect(f.writes()).toEqual([])
  expect(await f.ledger.records()).toEqual([])
})

it.each([{ children: [] }, { children: [{ id: 100001, aigcVideoTaskId: 100000 }] }, {
  children: [{ id: 100001, aigcVideoTaskId: 100000, storyboardId: '' }],
}, { children: [
  { id: 100001, aigcVideoTaskId: 100000, storyboardId: 999999 }, { id: 100002, aigcVideoTaskId: 100000 },
] }])('keeps the conflicting task blocked when ownership remains unreadable: %j', async ({ children }) => {
  const f = await fixture()
  f.state.tasks = [oldTask]
  f.state.children['100000'] = children
  const result = f.submit('single')
  await expect(result).rejects.toMatchObject({ code: 'VIDEO_TASK_EVIDENCE_INVALID' })
  await expect(result).rejects.toThrow('task_id=100000; storyboard_id=916953;')
  await expect(result).rejects.toThrow('ownership=unverified;')
  expect(f.writes()).toEqual([])
  expect(await f.ledger.records()).toEqual([])
})

it.each(['parent', 'child'] as const)('does not treat an invalid %s storyboard ID as another card', async (source) => {
  const f = await fixture()
  f.state.tasks = [oldTask]
  if (source === 'parent') f.state.details['100000'] = { ...oldTask, storyboardId: 'unknown' }
  else f.state.children['100000'] = [{ id: 100001, aigcVideoTaskId: 100000, storyboardId: 'unknown' }]
  await expect(f.submit('single')).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(f.writes()).toEqual([])
  expect(await f.ledger.records()).toEqual([])
})

it('does not infer another card from an unreadable task detail', async () => {
  const f = await fixture()
  f.state.tasks = [oldTask]
  f.state.details['100000'] = null
  await expect(f.submit('single')).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(f.calls.some(call => call.path === '/admin/aigc/video/task/100000')).toBe(true)
  expect(f.writes()).toEqual([])
  expect(await f.ledger.records()).toEqual([])
})

it('retains missing episode numbers in a conflicting same-card detail diagnostic', async () => {
  const f = await fixture({ episodeCount: null })
  f.state.tasks = [{ id: 100000, scriptId: 2708, taskType: 1, episodeId: 401 }]
  f.state.details['100000'] = { id: 100000, scriptId: 2708, taskType: 1, episodeId: 400, storyboardId: 916953 }
  f.state.children['100000'] = [{ id: 100001, aigcVideoTaskId: 100000, storyboardId: 916953 }]
  const result = f.submit('single')
  await expect(result).rejects.toMatchObject({ code: 'VIDEO_TASK_EVIDENCE_INVALID' })
  await expect(result).rejects.toThrow('task_episode_id=400; task_episode_count=null;')
  await expect(result).rejects.toThrow('preview_episode_id=401; preview_episode_count=null;')
  expect(f.writes()).toEqual([])
  expect(await f.ledger.records()).toEqual([])
})

it('counts deferred episode conflicts toward the 100-task hydration limit before reading details', async () => {
  const f = await fixture()
  f.state.tasks = Array.from({ length: 101 }, (_, index) => ({ ...oldTask, id: 100000 + index }))
  const result = f.submit('single')
  await expect(result).rejects.toMatchObject({ code: 'VIDEO_TASK_EVIDENCE_INVALID' })
  await expect(result).rejects.toThrow('VIDEO_TASK_SCAN_LIMIT: storyboard 916953 has 101 candidate tasks')
  expect(f.calls.some(call => /\/task\/\d+$/.test(call.path))).toBe(false)
  expect(f.writes()).toEqual([])
  expect(await f.ledger.records()).toEqual([])
})
