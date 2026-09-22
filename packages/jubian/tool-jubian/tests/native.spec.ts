import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { prepareVideoMethod, selectAssetsMethod, submitVideoMethod } from '../src/native.ts'

const URL_LEAD = 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/lead.jpg'
const URL_GUEST = 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/guest.jpg'
const PROMPT = '雨夜街头 @[陆沉舟](lead) 与 @[苏晚](guest)'

const MODEL_CONFIG = { platformId: 'YU_DIAN', modelId: 'doubao-seedance-2-0-260128', standardId: 11, genType: 3,
  modelGenerationTypeId: 7, videoStandardId: 91, duration: 8, ratio: '9:16', resolution: '720p', genNum: 1,
  materialList: [], backupModelList: [], prompt: PROMPT }

const MATERIALS = [
  { assetId: 'asset-lead', materialAssetId: 81285, fileName: '陆沉舟｜西装', materialKey: 'lead',
    materialType: 'image', materialUrl: URL_LEAD, sortOrder: 1 },
  { assetId: 'asset-guest', materialAssetId: 83670, fileName: '苏晚｜风衣', materialKey: 'guest',
    materialType: 'image', materialUrl: URL_GUEST, sortOrder: 2 },
]

const STORYBOARD = { id: 916953, scriptId: 2708, isGenerate: 1, storyboardName: '第1集-分镜1',
  modelConfig: JSON.stringify(MODEL_CONFIG), storyboardMaterialList: MATERIALS }

const ASSETS: Record<string, Record<string, unknown>> = {
  81285: { id: 81285, scriptId: 2708, assetUrl: URL_LEAD, name: '陆沉舟｜西装' },
  83670: { id: 83670, scriptId: 2708, assetUrl: URL_GUEST, name: '苏晚｜风衣' },
}

const SUBJECT_ROWS = [
  { id: 1, assetId: 81285, scriptId: 2708, hsAssetId: 'asset-lead', assetUrl: URL_LEAD,
    assetName: '陆沉舟｜西装', hsAssetStatus: 'Active', isUsed: 1 },
  { id: 2, assetId: 83670, scriptId: 2708, hsAssetId: 'asset-guest', assetUrl: URL_GUEST,
    assetName: '苏晚｜风衣', hsAssetStatus: 'Active', isUsed: 1 },
]

const CATALOGUE = [{ id: 11, standardId: 11, modelId: 'doubao-seedance-2-0-260128', platformId: 'YU_DIAN',
  duration: 8, genNum: 1, genTypes: [{ id: 7, type: 3 }],
  videoStandards: [{ id: 91, ratio: '9:16', resolution: '720p', genNum: 1 }] }]

/** The child a real storyboard PUT produces: the payload's own materials, translated by the server. */
function childOf(payload: Record<string, unknown>, overrides: Record<string, unknown> = {}):
Record<string, unknown> {
  return { id: 972949, aigcVideoTaskId: 335343, storyboardId: 916953, taskStatus: 'submit',
    imageMaterials: payload.storyboardMaterialList, modelConfig: payload.modelConfig, ...overrides }
}

/** The child the provider would hold for the last saved storyboard, as a replay finds it. */
function savedChild(provider: { storyboard: Record<string, unknown> }): Record<string, unknown> {
  return childOf({ storyboardMaterialList: provider.storyboard.storyboardMaterialList,
    modelConfig: provider.storyboard.modelConfig })
}

interface FakeProvider {
  calls: { method: string; path: string; body?: Record<string, unknown> }[]
  storyboard: Record<string, unknown>
  tasks: Record<string, unknown>[]
  subtasks: Record<string, Record<string, unknown>[]>
  /** What the single PUT does besides answering: create a task, fail, or nothing. */
  onPut?: (payload: Record<string, unknown>) => void
}

/** A client whose transport serves one in-memory project and records every call. */
function clientFor(provider: FakeProvider): JubianClient {
  return new JubianClient({ credential: async () => 'token',
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const path = (url as URL).toString().replace('https://web.jubianai.net/prod-api', '')
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
      const method = String(init?.method)
      provider.calls.push({ method, path, ...(body === undefined ? {} : { body }) })
      const answer = (data: unknown): Response => new Response(JSON.stringify({ code: 200, data }), { status: 200 })
      if (path.startsWith('/aigc/storyboard/') && method === 'GET') return answer(provider.storyboard)
      if (path === '/aigc/storyboard' && method === 'PUT') {
        const payload = body ?? {}
        // The provider stores 1 on every storyboard it holds, whatever the PUT body carried.
        provider.storyboard = { ...provider.storyboard, ...payload, isGenerate: 1 }
        provider.onPut?.(payload)
        return answer(null)
      }
      if (path.startsWith('/aigc/asset/') && method === 'GET') {
        return answer(ASSETS[path.split('/').pop() ?? ''] ?? null)
      }
      if (path.startsWith('/aigc/material/list')) {
        return answer({ total: SUBJECT_ROWS.length, rows: SUBJECT_ROWS })
      }
      if (path.startsWith('/model/charge/getSelectList')) return answer(CATALOGUE)
      if (path.startsWith('/admin/aigc/video/task/list')) {
        const query = new URL(`https://example.test${path}`).searchParams
        const page = Number(query.get('pageNum') ?? 1)
        const size = Number(query.get('pageSize') ?? 100)
        return answer({ total: provider.tasks.length, rows: provider.tasks.slice((page - 1) * size, page * size) })
      }
      if (path.startsWith('/admin/aigc/video/task/sub/list')) {
        return answer({ total: 1, rows: provider.subtasks[String(body?.aigcVideoTaskId)] ?? [] })
      }
      if (path.startsWith('/admin/aigc/video/task/') && method === 'GET') {
        const id = path.split('/').pop()
        return answer(provider.tasks.find(task => String(task.id) === id) ?? null)
      }
      return new Response(JSON.stringify({ code: 404, msg: 'unknown' }), { status: 404 })
    } })
}

let root: string
let ledger: JubianLedger
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jubian-native-'))
  ledger = new JubianLedger({ root: join(root, 'ledger') })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Create one project directory the flows accept as a bound project. */
async function project(scriptId = 2708, name = 'project'): Promise<string> {
  const directory = join(root, name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'project_config.json'), JSON.stringify({ jubian_script_id: scriptId }), 'utf8')
  return directory
}

const putCalls = (provider: FakeProvider): typeof provider.calls =>
  provider.calls.filter(call => call.method === 'PUT')

describe('prepare_video', () => {
  it('writes one atomic preview under video_tasks and sends no PUT', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const directory = await project()
    const result = await prepareVideoMethod(clientFor(provider), { storyboard_id: 916953,
      project_dir: directory })
    expect(putCalls(provider)).toHaveLength(0)
    expect(result.preview_path).toBe(join(directory, 'video_tasks',
      `storyboard-916953-${String(result.idempotencyKey).slice(0, 12)}.storyboard-native.prepared.json`))
    expect(result.content_duration_ms).toBe(7000)
    const written = JSON.parse(await readFile(String(result.preview_path), 'utf8')) as Record<string, unknown>
    expect(written.operation).toBe('prepare_storyboard_native_video')
    expect((written.payload as Record<string, unknown>).isGenerate).toBe(1)
    expect(provider.calls.every(call => call.method === 'GET')).toBe(true)
  })

  it('refuses a project bound to another scriptId and writes nothing', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const directory = await project(1, 'foreign')
    await expect(prepareVideoMethod(clientFor(provider), { storyboard_id: 916953,
      project_dir: directory })).rejects.toThrow()
    await expect(readFile(join(directory, 'video_tasks', 'x'), 'utf8')).rejects.toThrow()
  })

  it('refuses a project directory without project_config.json', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const directory = join(root, 'bare')
    await mkdir(directory, { recursive: true })
    await expect(prepareVideoMethod(clientFor(provider), { storyboard_id: 916953,
      project_dir: directory })).rejects.toThrow()
  })

  it('refuses a caller-supplied duration that disagrees with the live snapshot', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const directory = await project()
    await expect(prepareVideoMethod(clientFor(provider), { storyboard_id: 916953, project_dir: directory,
      content_duration_ms: 12000 })).rejects.toThrow()
  })
})

describe('submit_video', () => {
  /** One prepared project, ready to be submitted against. */
  interface Prepared {
    directory: string
    previewPath: string
    idempotencyKey: string
  }

  /** Prepare a project and then submit against it, recording what the provider saw. */
  async function prepared(provider: FakeProvider): Promise<Prepared> {
    const directory = await project()
    const preview = await prepareVideoMethod(clientFor(provider), { storyboard_id: 916953,
      project_dir: directory })
    provider.calls.length = 0
    return { directory, previewPath: String(preview.preview_path),
      idempotencyKey: String(preview.idempotencyKey) }
  }

  it('reports what it read for every candidate when the preflight conflicts', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const { previewPath, idempotencyKey } = await prepared(provider)
    // Two shapes of historical task whose only child lost its model evidence. The second
    // is the production one: the task row itself states no storyboard id, so the classifier
    // reads it as null and cannot exclude the task from this submission's candidates.
    provider.tasks = [
      { id: 400003, scriptId: 2708, storyboardId: 916953, taskType: 1, taskStatus: 'submit' },
      { id: 400004, scriptId: 2708, taskType: 1, taskStatus: 'submit' },
    ]
    const childWithoutModel = (taskId: number, childId: number) => ({ id: childId, aigcVideoTaskId: taskId,
      storyboardId: 916953, taskStatus: 'submit', imageMaterials: MATERIALS })
    provider.subtasks['400003'] = [childWithoutModel(400003, 1)]
    provider.subtasks['400004'] = [childWithoutModel(400004, 2)]
    const result = await submitVideoMethod(clientFor(provider), ledger, { preview_path: previewPath,
      idempotency_key: idempotencyKey })
    expect(putCalls(provider)).toHaveLength(0)
    expect(result).toMatchObject({ status: 'reconcile_conflict' })
    const candidates = result.candidates as Record<string, unknown>[]
    expect(candidates.find(candidate => candidate.task_id === '400003'))
      .toMatchObject({ storyboard_id_read: '916953', children: 1 })
    expect(candidates.find(candidate => candidate.task_id === '400004'))
      .toMatchObject({ storyboard_id_read: null, children: 1 })
  })

  it('names only the tasks the project did not have before the PUT', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const { previewPath, idempotencyKey } = await prepared(provider)
    // Another storyboard's task already exists under this project. It appears in both
    // snapshots, so it was not created by this request and must not be named as new.
    const unrelated = { id: 400009, scriptId: 2708, storyboardId: 999999, taskType: 1, taskStatus: 'submit' }
    provider.tasks = [unrelated]
    provider.onPut = (payload) => {
      provider.tasks = [unrelated,
        { id: 335500, scriptId: 2708, storyboardId: 916953, taskType: 1, taskStatus: 'submit' }]
      provider.subtasks['335500'] = [childOf(payload, { aigcVideoTaskId: 335500,
        imageMaterials: MATERIALS.map(material => ({ ...material, materialName: 'other' })) })]
    }
    const result = await submitVideoMethod(clientFor(provider), ledger, { preview_path: previewPath,
      idempotency_key: idempotencyKey })
    expect(putCalls(provider)).toHaveLength(1)
    expect(result.new_task_ids).toEqual(['335500'])
    expect(result.before_task_ids).toEqual([])
  })

  it('reports an accepted PUT it could not claim as reconcile_required, naming the task it created', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const { previewPath, idempotencyKey } = await prepared(provider)
    provider.onPut = (payload) => {
      provider.tasks = [{ id: 335500, scriptId: 2708, storyboardId: 916953, taskType: 1, taskStatus: 'submit' }]
      // The task exists and may already be billed, but its settled child repeats a
      // different identity: the claim conflicts even though the PUT was accepted.
      provider.subtasks['335500'] = [childOf(payload, { aigcVideoTaskId: 335500,
        imageMaterials: MATERIALS.map(material => ({ ...material, materialName: 'other' })) })]
    }
    const result = await submitVideoMethod(clientFor(provider), ledger, { preview_path: previewPath,
      idempotency_key: idempotencyKey })
    expect(putCalls(provider)).toHaveLength(1)
    expect(result).toMatchObject({ replayed: false, outcome: 'accepted', put_sent: true, put_outcome: 'accepted',
      status: 'reconcile_required', task_id: null, claim_status: 'reconcile_conflict', new_task_ids: ['335500'] })
    expect(String(result.next)).toContain('已被提供方受理')
  })

  it('submits exactly one PUT and claims the task it created', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const { previewPath, idempotencyKey } = await prepared(provider)
    provider.onPut = (payload) => {
      provider.tasks = [{ id: 335343, scriptId: 2708, storyboardId: 916953, taskType: 1, taskStatus: 'submit' }]
      provider.subtasks['335343'] = [childOf(payload)]
    }
    const result = await submitVideoMethod(clientFor(provider), ledger, { preview_path: previewPath,
      idempotency_key: idempotencyKey })
    expect(putCalls(provider)).toHaveLength(1)
    expect(putCalls(provider)[0]?.body?.isGenerate).toBe(1)
    expect(result).toMatchObject({ replayed: false, outcome: 'accepted', status: 'submitted', task_id: '335343' })
    expect((await ledger.find(idempotencyKey))?.method).toBe('storyboard_native_submit')
  })

  it('never sends a second PUT for a key it already recorded, and reconciles instead', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const { previewPath, idempotencyKey } = await prepared(provider)
    provider.onPut = (payload) => {
      provider.tasks = [{ id: 335343, scriptId: 2708, storyboardId: 916953, taskType: 1, taskStatus: 'submit' }]
      provider.subtasks['335343'] = [childOf(payload)]
    }
    await submitVideoMethod(clientFor(provider), ledger, { preview_path: previewPath,
      idempotency_key: idempotencyKey })
    const second: FakeProvider = { ...provider, calls: [],
      tasks: [{ id: 335343, scriptId: 2708, storyboardId: 916953, taskType: 1 }],
      subtasks: { 335343: [savedChild(provider)] } }
    const replayed = await submitVideoMethod(clientFor(second), ledger, { preview_path: previewPath,
      idempotency_key: idempotencyKey })
    expect(putCalls(second)).toHaveLength(0)
    expect(replayed).toMatchObject({ replayed: true, status: 'submitted', task_id: '335343' })
    expect(String(replayed.next)).toContain('不会再发送任何 PUT')
  })

  it('treats a failed PUT as ambiguous, records unknown and still never resends', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const { previewPath, idempotencyKey } = await prepared(provider)
    provider.onPut = () => { throw new Error('connection reset') }
    const result = await submitVideoMethod(clientFor(provider), ledger, { preview_path: previewPath,
      idempotency_key: idempotencyKey })
    expect(result).toMatchObject({ replayed: false, outcome: 'unknown', put_ambiguous: true })
    expect((await ledger.find(idempotencyKey))?.outcome).toBe('unknown')
    // The replay reads the storyboard the failed PUT already stored, and has no
    // PUT hook at all: an optional member is absent, never an explicit `undefined`.
    const second: FakeProvider = { calls: [], storyboard: provider.storyboard,
      tasks: [{ id: 335343, scriptId: 2708, storyboardId: 916953, taskType: 1 }],
      subtasks: { 335343: [savedChild(provider)] } }
    const replayed = await submitVideoMethod(clientFor(second), ledger, { preview_path: previewPath,
      idempotency_key: idempotencyKey })
    expect(putCalls(second)).toHaveLength(0)
    expect(replayed).toMatchObject({ replayed: true, status: 'submitted', task_id: '335343' })
  })

  it('reports a lost child identity as terminal instead of retrying', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const { previewPath, idempotencyKey } = await prepared(provider)
    provider.onPut = (payload) => {
      provider.tasks = [{ id: 335470, scriptId: 2708, storyboardId: 916953, taskType: 1, taskStatus: 'failed' }]
      // Task 335470's failure mode: the child kept the URLs but lost the identity.
      provider.subtasks['335470'] = [childOf(payload, { imageMaterials: MATERIALS.map(material =>
        ({ materialUrl: material.materialUrl, materialType: 'image', sortOrder: material.sortOrder })) })]
    }
    const result = await submitVideoMethod(clientFor(provider), ledger, { preview_path: previewPath,
      idempotency_key: idempotencyKey })
    expect(putCalls(provider)).toHaveLength(1)
    expect(result.status).toBe('subject_identity_lost')
    expect(String(result.next)).toContain('终态')
  })

  it('reconciles a recorded key even after the storyboard has moved on', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const { previewPath, idempotencyKey } = await prepared(provider)
    provider.onPut = (payload) => {
      provider.tasks = [{ id: 335343, scriptId: 2708, storyboardId: 916953, taskType: 1, taskStatus: 'submit' }]
      provider.subtasks['335343'] = [childOf(payload)]
    }
    await submitVideoMethod(clientFor(provider), ledger, { preview_path: previewPath,
      idempotency_key: idempotencyKey })
    // The operator edits the storyboard after the submission: reconciliation must
    // still answer, because it sends nothing.
    provider.storyboard = { ...provider.storyboard,
      modelConfig: JSON.stringify({ ...MODEL_CONFIG, prompt: '被改过的提示词' }) }
    const callsBefore = provider.calls.length
    const replayed = await submitVideoMethod(clientFor(provider), ledger, { preview_path: previewPath,
      idempotency_key: idempotencyKey })
    expect(putCalls(provider).length).toBe(1)
    expect(provider.calls.length).toBeGreaterThan(callsBefore)
    expect(replayed).toMatchObject({ replayed: true, status: 'submitted', task_id: '335343' })
  })

  it('refuses a stale preview whose live submission semantics changed', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const { previewPath, idempotencyKey } = await prepared(provider)
    provider.storyboard = { ...provider.storyboard,
      modelConfig: JSON.stringify({ ...MODEL_CONFIG, prompt: `${PROMPT} 另外一位` }) }
    await expect(submitVideoMethod(clientFor(provider), ledger, { preview_path: previewPath,
      idempotency_key: idempotencyKey })).rejects.toThrow()
    expect(putCalls(provider)).toHaveLength(0)
    expect(await ledger.find(idempotencyKey)).toBeUndefined()
  })

  it('refuses a key that is not the preview fingerprint and sends nothing', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const { previewPath } = await prepared(provider)
    await expect(submitVideoMethod(clientFor(provider), ledger, { preview_path: previewPath,
      idempotency_key: 'f'.repeat(64) })).rejects.toThrow()
    expect(provider.calls).toHaveLength(0)
  })

  it('refuses a submission with no idempotency key at all', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const { previewPath } = await prepared(provider)
    await expect(submitVideoMethod(clientFor(provider), ledger, { preview_path: previewPath })).rejects.toThrow()
    expect(provider.calls).toHaveLength(0)
  })

  it('refuses to PUT when the pre-submit snapshot drifts between the two reads', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const { previewPath, idempotencyKey } = await prepared(provider)
    let listCalls = 0
    const inner = clientFor(provider)
    const drifting = new JubianClient({ credential: async () => 'token',
      fetch: async (url: string | URL | Request, init?: RequestInit) => {
        const path = (url as URL).toString().replace('https://web.jubianai.net/prod-api', '')
        if (path.startsWith('/admin/aigc/video/task/list')) {
          listCalls += 1
          if (listCalls === 2) {
            provider.calls.push({ method: 'GET', path })
            return new Response(JSON.stringify({ code: 200, data: { total: 1,
              rows: [{ id: 999999, scriptId: 2708, storyboardId: 916953 }] } }), { status: 200 })
          }
        }
        const response = await inner.request({ method: (init?.method ?? 'GET') as 'GET', path,
          ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}) })
        return new Response(JSON.stringify({ code: 200, data: response.data }), { status: 200 })
      } })
    const result = await submitVideoMethod(drifting, ledger, { preview_path: previewPath,
      idempotency_key: idempotencyKey })
    expect(result).toMatchObject({ status: 'reconcile_required', outcome: 'unknown' })
    expect(putCalls(provider)).toHaveLength(0)
  })

  it('finds the only prepared preview when the caller names the project instead of the file', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const { directory, idempotencyKey } = await prepared(provider)
    provider.onPut = (payload) => {
      provider.tasks = [{ id: 335343, scriptId: 2708, storyboardId: 916953, taskType: 1 }]
      provider.subtasks['335343'] = [childOf(payload)]
    }
    const result = await submitVideoMethod(clientFor(provider), ledger, { project_dir: directory,
      storyboard_id: 916953, idempotency_key: idempotencyKey })
    expect(result.status).toBe('submitted')
  })

  /**
   * Project 2708's real preflight shape: 50 video tasks that state no `storyboardId`,
   * each owning one child result that names another storyboard.
   */
  function otherStoryboards(count = 50): Pick<FakeProvider, 'tasks' | 'subtasks'> {
    const tasks = Array.from({ length: count }, (_, index) => ({ id: 324493 + index, scriptId: 2708,
      taskType: 1, taskStatus: 'succeeded' }))
    const subtasks = Object.fromEntries(tasks.map((task, index) => [String(task.id),
      [{ id: 900000 + index, aigcVideoTaskId: task.id, storyboardId: 1033895 + index,
        taskStatus: 'succeeded' }]]))
    return { tasks, subtasks }
  }

  /** The submitted child one task holds when it is this storyboard's own task. */
  async function ownChild(previewPath: string): Promise<Record<string, unknown>> {
    const preview = JSON.parse(await readFile(previewPath, 'utf8')) as { payload: Record<string, unknown> }
    return childOf(preview.payload)
  }

  it('excludes explicitly different episodes before the hydration cap on submit and replay', async () => {
    const provider: FakeProvider = { calls: [], storyboard: { ...STORYBOARD, episodeId: 46744 },
      ...otherStoryboards(101) }
    provider.tasks = provider.tasks.map(task => ({ ...task, episodeId: '46734' }))
    const { previewPath, idempotencyKey } = await prepared(provider)
    provider.onPut = (payload) => {
      provider.tasks.push({ id: 335343, scriptId: 2708, episodeId: 46744, taskType: 1 })
      provider.subtasks['335343'] = [childOf(payload)]
    }
    const args = { preview_path: previewPath, idempotency_key: idempotencyKey }
    expect(await submitVideoMethod(clientFor(provider), ledger, args)).toMatchObject({ status: 'submitted' })
    expect(await submitVideoMethod(clientFor(provider), ledger, args)).toMatchObject({ replayed: true, status: 'submitted' })
    expect(putCalls(provider)).toHaveLength(1)
    expect(provider.calls.filter(call => call.path.startsWith('/admin/aigc/video/task/sub/list'))
      .every(call => String(call.body?.aigcVideoTaskId) === '335343')).toBe(true)
  })

  it.each([undefined, null, '', 'unknown', false, {}, 46744, '46744'])
  ('retains the hydration cap for an unresolved or matching episode %j', async (episodeId) => {
    const provider: FakeProvider = { calls: [], storyboard: { ...STORYBOARD, episodeId: 46744 },
      ...otherStoryboards(101) }
    provider.tasks = provider.tasks.map(task => ({ ...task, episodeId }))
    const { previewPath, idempotencyKey } = await prepared(provider)
    await expect(submitVideoMethod(clientFor(provider), ledger, { preview_path: previewPath,
      idempotency_key: idempotencyKey })).rejects.toThrow()
    expect(putCalls(provider)).toHaveLength(0)
    expect(await ledger.find(idempotencyKey)).toBeUndefined()
  })

  it('never calls another storyboard\'s tasks unsafe candidates', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, ...otherStoryboards() }
    const { previewPath, idempotencyKey } = await prepared(provider)
    const result = await submitVideoMethod(clientFor(provider), ledger, { preview_path: previewPath,
      idempotency_key: idempotencyKey })
    // Every related row is still judged from its own detail and child results...
    const inspected = new Set(provider.calls.filter(call => call.path.startsWith('/admin/aigc/video/task/sub/list'))
      .map(call => String(call.body?.aigcVideoTaskId)))
    expect(inspected.size).toBe(50)
    // ...and none of them proves this storyboard, so the preflight is not a conflict.
    expect(result).toMatchObject({ replayed: false, outcome: 'accepted', status: 'reconcile_required' })
    expect(putCalls(provider)).toHaveLength(1)
  })

  it('reconciles to the one task whose child result names this storyboard', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, ...otherStoryboards() }
    const { previewPath, idempotencyKey } = await prepared(provider)
    provider.subtasks['324493'] = [await ownChild(previewPath)]
    const result = await submitVideoMethod(clientFor(provider), ledger, { preview_path: previewPath,
      idempotency_key: idempotencyKey })
    expect(putCalls(provider)).toHaveLength(0)
    expect(result).toMatchObject({ status: 'already_submitted', task_id: '324493' })
  })

  it('still calls two tasks of this storyboard a conflict', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, ...otherStoryboards() }
    const { previewPath, idempotencyKey } = await prepared(provider)
    const child = await ownChild(previewPath)
    provider.subtasks['324493'] = [child]
    provider.subtasks['324494'] = [child]
    const result = await submitVideoMethod(clientFor(provider), ledger, { preview_path: previewPath,
      idempotency_key: idempotencyKey })
    expect(putCalls(provider)).toHaveLength(0)
    expect(result).toMatchObject({ status: 'reconcile_conflict', task_id: null })
  })
})

describe('select_assets', () => {
  const selections = [{ material_key: 'lead', asset_id: 81285 }, { material_key: 'guest', asset_id: 83670 }]
  const emptyStoryboard = { ...STORYBOARD, storyboardMaterialList: [] }

  it('saves with isGenerate=0, reads the order back and proves no task appeared', async () => {
    const provider: FakeProvider = { calls: [], storyboard: emptyStoryboard, tasks: [], subtasks: {} }
    const result = await selectAssetsMethod(clientFor(provider), ledger, { storyboard_id: 916953,
      selections, idempotency_key: 'select-1' })
    expect(putCalls(provider)).toHaveLength(1)
    expect(putCalls(provider)[0]?.body?.isGenerate).toBe(0)
    expect(result).toMatchObject({ status: 'applied', applied: true, paid_requests: 0 })
    expect((await ledger.find('select-1'))?.method).toBe('storyboard_select_assets')
  })

  it('shouts when a selection-only save created a task', async () => {
    const provider: FakeProvider = { calls: [], storyboard: emptyStoryboard, tasks: [], subtasks: {} }
    provider.onPut = () => {
      provider.tasks = [{ id: 1, scriptId: 2708, storyboardId: 916953, taskType: 1 }]
    }
    const result = await selectAssetsMethod(clientFor(provider), ledger, { storyboard_id: 916953,
      selections, idempotency_key: 'select-2' })
    expect(result.status).toBe('billing_safety_violation')
    expect(String(result.next)).toContain('立即停机')
  })

  it('does not PUT at all when the storyboard already holds the selection', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    const result = await selectAssetsMethod(clientFor(provider), ledger, { storyboard_id: 916953,
      selections, idempotency_key: 'select-3' })
    expect(putCalls(provider)).toHaveLength(0)
    expect(result).toMatchObject({ status: 'already_applied', applied: false })
    expect(await ledger.find('select-3')).toBeUndefined()
  })

  it('refuses a selection with no key before it reads anything', async () => {
    const provider: FakeProvider = { calls: [], storyboard: STORYBOARD, tasks: [], subtasks: {} }
    await expect(selectAssetsMethod(clientFor(provider), ledger, { storyboard_id: 916953,
      selections })).rejects.toThrow()
    expect(provider.calls).toHaveLength(0)
  })

  it('refuses a storyboard whose saved order no longer matches the plan', async () => {
    const provider: FakeProvider = { calls: [], storyboard: emptyStoryboard, tasks: [], subtasks: {} }
    provider.onPut = (payload) => {
      // Simulate a provider that silently reorders: the read-back must catch it.
      const materials = payload.storyboardMaterialList as Record<string, unknown>[]
      provider.storyboard = { ...provider.storyboard, storyboardMaterialList: [...materials].reverse() }
    }
    await expect(selectAssetsMethod(clientFor(provider), ledger, { storyboard_id: 916953,
      selections, idempotency_key: 'select-4' })).rejects.toThrow()
    expect((await ledger.find('select-4'))?.outcome).toBe('accepted')
  })
})
