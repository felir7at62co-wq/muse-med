/** Deletion inspection preserves singleton histories and proves empty-history ownership through complete task reads. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { JubianClient, JubianError, JubianLedger } from '@deepseek-ai/dsh-jubian'
import type { JubianRequest, JubianResponse } from '@deepseek-ai/dsh-jubian'
import { storyboardMethod } from '../src/methods.ts'
import { deletionTasks, resolveDeletionTaskScanOptions } from '../src/storyboard-delete-tasks.ts'

type Row = Record<string, unknown>
let root: string
let client: JubianClient
let ledger: JubianLedger
let calls: string[]
let tasks: Row[]
let details: Map<number, Row>
let history: 'empty' | 'singleton' | 'unreadable' | 'unauthorized' | 'offline'
let pages: Map<number, unknown>
let afterList: (() => void) | undefined
let children: Map<number, Row[]>
let childPages: Map<string, unknown>
let afterChildList: ((taskId: number) => void) | undefined
let removed: boolean
const board = { id: 1, scriptId: 2708, modelConfig: null, storyboardMaterialList: [] }

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jubian-delete-history-'))
  await writeFile(join(root, 'project_config.json'), JSON.stringify({ jubian_script_id: 2708 }))
  calls = []; tasks = []; details = new Map(); history = 'empty'; pages = new Map(); afterList = undefined; removed = false
  children = new Map(); childPages = new Map(); afterChildList = undefined
  ledger = new JubianLedger({ root: join(root, 'ledger') })
  client = new JubianClient({ credential: async () => 'fixture-token', fetch: async (url, init) => {
    const parsed = new URL(url instanceof Request ? url.url : url.toString())
    const path = parsed.pathname.replace('/prod-api', '')
    const method = String(init?.method)
    calls.push(`${method} ${path}${parsed.search}`)
    const answer = (data: unknown) => new Response(JSON.stringify({ code: 200, data }))
    if (path === '/aigc/storyboard/byStoryboard/1') {
      if (history === 'offline') throw new Error('offline')
      if (history === 'unauthorized') return new Response('', { status: 403 })
      if (history === 'singleton') return new Response(JSON.stringify([{ id: 77, status: 'failed' }]))
      return new Response(history === 'unreadable' ? 'not JSON' : '')
    }
    if (path === '/admin/aigc/video/task/list') {
      const page = Number(parsed.searchParams.get('pageNum'))
      const size = Number(parsed.searchParams.get('pageSize'))
      const response = pages.get(page) ?? { total: tasks.length, rows: tasks.slice((page - 1) * size, page * size) }
      afterList?.()
      return answer(response)
    }
    if (path === '/admin/aigc/video/task/sub/list') {
      expect(method).toBe('POST')
      if (typeof init?.body !== 'string') throw Error('The read-only child query requires a JSON request body')
      const input = JSON.parse(init.body) as Row
      const taskId = Number(input.aigcVideoTaskId)
      const page = Number(parsed.searchParams.get('pageNum')), size = Number(parsed.searchParams.get('pageSize'))
      const list = children.get(taskId) ?? []
      const response = childPages.get(`${taskId}:${page}`) ?? { total: list.length, rows: list.slice((page - 1) * size, page * size) }
      afterChildList?.(taskId)
      return answer(response)
    }
    if (path.startsWith('/admin/aigc/video/task/')) return answer(details.get(Number(path.split('/').pop())) ?? null)
    if (path === '/aigc/storyboard/1' && method === 'GET') return answer(removed ? null : board)
    if (path === '/aigc/storyboard/1' && method === 'DELETE') { removed = true; return answer(null) }
    throw new Error(`Unexpected fixture call ${method} ${path}`)
  } })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const preview = (extra = {}, config = {}) => storyboardMethod(client, ledger, { method: 'delete_preview', script_id: 2708,
  project_dir: root, storyboard_ids: [1], authorization_basis: 'User requested exact fixture cleanup', delete_reason: 'obsolete fixture', ...extra },
{ deletionTaskScan: resolveDeletionTaskScanOptions(config) })
const apply = (plan: Row) => storyboardMethod(client, ledger, { method: 'delete_apply', script_id: 2708, project_dir: root,
  preview_path: String(plan.preview_path), checked_storyboard_ids: [1], idempotency_key: String(plan.fingerprint) })
const mutations = () => calls.filter(call => !call.startsWith('GET ') && !call.startsWith('POST /admin/aigc/video/task/sub/list?'))

/** Explicit independent child identities for one complete parent-task read. */
const child = (id: number, taskId: number, storyboardId: number): Row => ({ id, aigcVideoTaskId: taskId,
  scriptId: 2708, storyboardId, taskStatus: 'succeeded' })

it('restores a bare singleton history without changing singular transport reads', async () => {
  history = 'singleton'
  const plan = await preview()
  expect(plan).toMatchObject({ status: 'inspection_required', requires_generated_authorization: true,
    targets: [{ tasks: [{ id: 77, status: 'failed' }], active_generation: false, has_generated_media: true }] })
  expect(calls.filter(call => call.includes('/admin/'))).toEqual([])
  await expect(apply(plan)).rejects.toThrow('删除授权')
  expect(mutations()).toEqual([])
})

it.each(['empty', 'unreadable'] as const)('verifies two complete empty task snapshots for %s history before previewing', async (mode) => {
  history = mode
  const plan = await preview()
  expect(plan).toMatchObject({ targets: [{ tasks: [], active_generation: false, has_generated_media: false }] })
  expect(calls.filter(call => call.includes('/task/list?'))).toHaveLength(2)
  const persisted: unknown = JSON.parse(await readFile(String(plan.preview_path), 'utf8'))
  expect(persisted).toMatchObject({ fingerprint: plan.fingerprint })
  expect(mutations()).toEqual([])
})

it('excludes only explicitly nonvideo or differently owned tasks and verifies all remaining candidates', async () => {
  tasks = [
    { id: 20, scriptId: 2708, taskType: 2 }, { id: 21, scriptId: 2708, taskType: 1, storyboardId: 2 },
    { id: 22, scriptId: 2708, taskType: 1 }, { id: 23, scriptId: 2708 },
  ]
  details.set(22, { id: 22, scriptId: 2708, subTaskList: [{ storyboardId: 3 }], taskStatus: 'succeeded' })
  children.set(22, [child(220, 22, 3)])
  details.set(23, { id: 23, scriptId: 2708, storyboardId: 1, taskStatus: 'failed' })
  const plan = await preview()
  expect(plan).toMatchObject({ requires_generated_authorization: true, targets: [{ tasks: [{ id: 23 }], active_generation: false }] })
  expect(calls.some(call => /\/task\/(20|21)$/.test(call))).toBe(false)
  await expect(apply(plan)).rejects.toThrow('删除授权')
  expect(mutations()).toEqual([])
})

it('excludes a parent only after two complete child snapshots identify another card', async () => {
  tasks = [{ id: 20, scriptId: 2708, taskType: 1, episodeCount: 1 }]
  details.set(20, { id: 20, scriptId: 2708, episodeCount: 1, taskStatus: 'succeeded' })
  children.set(20, [child(200, 20, 2)])
  expect(await preview()).toMatchObject({ targets: [{ tasks: [], has_generated_media: false }] })
  expect(calls.filter(call => call.includes('/task/sub/list?'))).toHaveLength(2)
  expect(calls.filter(call => call.includes('/task/list?'))).toHaveLength(2)
  expect(mutations()).toEqual([])
})

it('accepts consistent explicit parent and embedded child ownership without an independent lookup', async () => {
  const full = [child(200, 20, 1)]
  tasks = [{ id: 20, scriptId: 2708, taskType: 1, storyboardId: 1, subTaskList: full }]
  details.set(20, { id: 20, scriptId: 2708, storyboardId: 1, subTaskList: full, taskStatus: 'succeeded' })
  expect(await deletionTasks(client, 2708, 1, resolveDeletionTaskScanOptions())).toMatchObject([
    { id: 20, storyboardId: 1, subTaskList: full },
  ])
  expect(calls.some(call => call.includes('/task/sub/list?'))).toBe(false)
  expect(mutations()).toEqual([])
})

it('rejects an explicit parent whose embedded child identifies another card', async () => {
  tasks = [{ id: 20, scriptId: 2708, taskType: 1, storyboardId: 1, subTaskList: [child(200, 20, 2)] }]
  await expect(preview()).rejects.toThrow('Conflicting task storyboard identities')
  expect(calls.some(call => call.includes('/task/20'))).toBe(false)
  expect(mutations()).toEqual([])
})

it('accepts the independent list alias and matches an embedded child without an embedded owner', async () => {
  tasks = [{ id: 20, scriptId: 2708, taskType: 1, subTaskList: [{ id: 200 }] }]
  details.set(20, { id: 20, scriptId: 2708, subTaskList: [{ id: 200 }] })
  childPages.set('20:1', { total: 1, list: [{ ...child(200, 20, 2), subTaskId: 200 }] })
  expect(await preview()).toMatchObject({ targets: [{ tasks: [], has_generated_media: false }] })
  expect(calls.filter(call => call.includes('/task/sub/list?'))).toHaveLength(2)
  expect(mutations()).toEqual([])
})

it('excludes another card only after its task detail explicitly identifies that owner', async () => {
  tasks = [{ id: 20, scriptId: 2708, taskType: 1 }]
  details.set(20, { id: 20, scriptId: 2708, storyboardId: 2 })
  expect(await preview()).toMatchObject({ targets: [{ tasks: [], has_generated_media: false }] })
  expect(calls.some(call => call.includes('/task/20'))).toBe(true)
  expect(calls.some(call => call.includes('/task/sub/list?'))).toBe(false)
  expect(mutations()).toEqual([])
})

it('keeps a complete batch with multiple card owners and does not trust its embedded partial list', async () => {
  tasks = [{ id: 20, scriptId: 2708, taskType: 1, subTaskList: [{ storyboardId: 2 }] }]
  details.set(20, { id: 20, scriptId: 2708, subTaskList: [{ storyboardId: 2 }], taskStatus: 'succeeded' })
  const full = [child(200, 20, 2), { ...child(201, 20, 1), taskType: 'new-provider-kind', taskStatus: 'running' }]
  children.set(20, full)
  expect(await deletionTasks(client, 2708, 1, resolveDeletionTaskScanOptions())).toEqual([
    { ...tasks[0], ...details.get(20), subTaskList: full },
  ])
  expect(calls.filter(call => call.includes('/task/sub/list?'))).toHaveLength(2)
  expect(mutations()).toEqual([])
})

it('reads every independent child page twice with the configured scan limits', async () => {
  tasks = [{ id: 20, scriptId: 2708, taskType: 1 }]
  details.set(20, { id: 20, scriptId: 2708, taskStatus: 'failed' })
  const full = Array.from({ length: 5 }, (_, index) => child(index + 200, 20, index === 4 ? 1 : 2))
  children.set(20, full)
  expect(await deletionTasks(client, 2708, 1, resolveDeletionTaskScanOptions({ storyboardDeleteTaskPageSize: 2 })))
    .toMatchObject([{ subTaskList: full }])
  const reads = calls.filter(call => call.includes('/task/sub/list?'))
  expect(reads).toHaveLength(6)
  expect(reads.every(call => call.includes('pageSize=2&orderByColumn=createTime&orderBy=desc'))).toBe(true)
  expect(mutations()).toEqual([])
})

it('refuses changed children even when their parent task snapshot remains unchanged', async () => {
  tasks = [{ id: 20, scriptId: 2708, taskType: 1 }]
  details.set(20, { id: 20, scriptId: 2708, taskStatus: 'failed' })
  children.set(20, [child(200, 20, 2)])
  afterChildList = () => { children.set(20, [child(200, 20, 1)]) }
  await expect(preview()).rejects.toThrow('children changed during deletion inspection')
  expect(mutations()).toEqual([])
})

it('rechecks earlier task children after all later tasks have been inspected', async () => {
  tasks = [{ id: 20, scriptId: 2708, taskType: 1 }, { id: 21, scriptId: 2708, taskType: 1 }]
  details.set(20, { id: 20, scriptId: 2708, taskStatus: 'succeeded' })
  details.set(21, { id: 21, scriptId: 2708, taskStatus: 'succeeded' })
  children.set(20, [child(200, 20, 2)])
  children.set(21, [child(210, 21, 2)])
  afterChildList = (taskId) => { if (taskId === 21) children.set(20, [child(200, 20, 1)]) }
  await expect(preview()).rejects.toThrow('Task children changed during deletion inspection')
  expect(calls.filter(call => call.includes('/task/sub/list?'))).toHaveLength(3)
  expect(mutations()).toEqual([])
})

it('refuses a project-task change after independent child verification', async () => {
  tasks = [{ id: 20, scriptId: 2708, taskType: 1 }]
  details.set(20, { id: 20, scriptId: 2708, taskStatus: 'failed' })
  children.set(20, [child(200, 20, 2)])
  afterChildList = () => { tasks = [{ id: 20, scriptId: 2708, taskType: 1 }, { id: 21, scriptId: 2708, taskType: 2 }] }
  await expect(preview()).rejects.toThrow('Project tasks changed during deletion inspection')
  expect(mutations()).toEqual([])
})

it.each([
  { label: 'embedded owner omitted', embedded: { storyboardId: 1 }, full: [child(200, 20, 2)] },
  { label: 'embedded child omitted', embedded: { id: 201, storyboardId: 1 }, full: [child(200, 20, 1)] },
  { label: 'embedded child reassigned', embedded: { id: 201, storyboardId: 1 }, full: [child(201, 20, 2), child(202, 20, 1)] },
  { label: 'embedded project changed', embedded: { scriptId: 99, storyboardId: 1 }, full: [child(200, 20, 1)] },
  { label: 'embedded parent changed', embedded: { aigcVideoTaskId: 21, storyboardId: 1 }, full: [child(200, 20, 1)] },
])('refuses $label in the independent snapshot', async ({ embedded, full }) => {
  tasks = [{ id: 20, scriptId: 2708, taskType: 1, subTaskList: [embedded] }]
  details.set(20, { id: 20, scriptId: 2708 })
  children.set(20, full)
  await expect(preview()).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(mutations()).toEqual([])
})

it.each([
  { label: 'wrong parent', overrides: { aigcVideoTaskId: 21 } },
  { label: 'missing parent', overrides: { aigcVideoTaskId: undefined } },
  { label: 'wrong project', overrides: { scriptId: 99 } },
  { label: 'missing project', overrides: { scriptId: undefined } },
  { label: 'missing child identity', overrides: { id: undefined } },
  { label: 'conflicting child identity aliases', overrides: { subTaskId: 201 } },
  { label: 'unsafe child identity', overrides: { id: '9007199254740992' } },
  { label: 'missing owner', overrides: { storyboardId: undefined } },
  { label: 'null owner', overrides: { storyboardId: null } },
  { label: 'invalid owner', overrides: { storyboardId: 0 } },
])('refuses an independent child with $label', async ({ overrides }) => {
  tasks = [{ id: 20, scriptId: 2708, taskType: 1 }]
  details.set(20, { id: 20, scriptId: 2708 })
  children.set(20, [{ ...child(200, 20, 1), ...overrides }])
  await expect(preview()).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(mutations()).toEqual([])
})

it.each([
  { total: 1, rows: [] }, { total: 0, rows: [child(200, 20, 1)] }, { rows: [] },
  { total: '0', rows: [] }, { total: -1, rows: [] }, { total: 0, rows: 'unreadable' },
  { total: 2, rows: [child(200, 20, 1), child(200, 20, 1)] },
].map(page => ({ page })))('refuses an incomplete independent child page $page', async ({ page }) => {
  tasks = [{ id: 20, scriptId: 2708, taskType: 1 }]
  details.set(20, { id: 20, scriptId: 2708 })
  childPages.set('20:1', page)
  await expect(preview()).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(mutations()).toEqual([])
})

it('rejects duplicate children across pages and total drift', async () => {
  tasks = [{ id: 20, scriptId: 2708, taskType: 1 }]
  details.set(20, { id: 20, scriptId: 2708 })
  childPages.set('20:1', { total: 2, rows: [child(200, 20, 1)] })
  childPages.set('20:2', { total: 2, rows: [child(200, 20, 1)] })
  await expect(preview({}, { storyboardDeleteTaskPageSize: 1 })).rejects.toThrow('Unverified task child')
  childPages.set('20:2', { total: 3, rows: [child(201, 20, 1)] })
  await expect(preview({}, { storyboardDeleteTaskPageSize: 1 })).rejects.toThrow('Incomplete task child snapshot')
  expect(mutations()).toEqual([])
})

it('refuses unfinished child pagination at the configured bound', async () => {
  tasks = [{ id: 20, scriptId: 2708, taskType: 1 }]
  details.set(20, { id: 20, scriptId: 2708 })
  children.set(20, [child(200, 20, 1), child(201, 20, 1)])
  await expect(preview({}, { storyboardDeleteTaskPageSize: 1, storyboardDeleteTaskPageLimit: 1 }))
    .rejects.toThrow('Task child scan limit reached')
  expect(mutations()).toEqual([])
})

it('keeps unknown task kinds in the ownership check', async () => {
  tasks = [{ id: 20, scriptId: 2708, taskType: 'new-provider-kind' }]
  details.set(20, { id: 20, scriptId: 2708, storyboardId: 1, taskStatus: 'running' })
  const plan = await preview({ include_generated_media: true })
  expect(plan).toMatchObject({ targets: [{ active_generation: true, tasks: [{ id: 20 }] }] })
  await expect(apply(plan)).rejects.toThrow('active generation')
  expect(mutations()).toEqual([])
})

it('reads every page and rejects no candidate solely because its episode differs', async () => {
  tasks = Array.from({ length: 101 }, (_, index) => ({ id: index + 10, scriptId: 2708, taskType: 2 }))
  tasks[100] = { id: 110, scriptId: 2708, taskType: 1, episodeId: 999 }
  details.set(110, { id: 110, scriptId: 2708, storyboardId: 1, taskStatus: 'failed' })
  expect(await preview()).toMatchObject({ targets: [{ tasks: [{ id: 110 }] }] })
  expect(calls.filter(call => call.includes('/task/list?'))).toHaveLength(4)
  expect(mutations()).toEqual([])
})

it('accepts complete list pages and uses a task list identity when its detail omits that field', async () => {
  pages.set(1, { total: 1, list: [{ id: 20, scriptId: 2708, taskType: 1, storyboardId: 1 }] })
  details.set(20, { id: 20, scriptId: 2708, taskStatus: 'failed' })
  expect(await preview()).toMatchObject({ targets: [{ tasks: [{ id: 20 }], active_generation: false }] })
  expect(mutations()).toEqual([])
})

it('accepts explicit parent ownership with an unidentified child and rejects a changed detail identity', async () => {
  tasks = [{ id: 20, scriptId: 2708, taskType: 1, storyboardId: 1 }]
  details.set(20, { id: 20, scriptId: 2708, storyboardId: 1, subTaskList: [{ storyboardId: null }], taskStatus: 'failed' })
  expect(await preview()).toMatchObject({ targets: [{ tasks: [{ id: 20 }] }] })
  details.set(20, { id: 20, scriptId: 2708, storyboardId: 2 })
  await expect(preview()).rejects.toThrow('storyboard changed')
  expect(mutations()).toEqual([])
})

it.each([
  { label: 'missing ownership', detail: { id: 20, scriptId: 2708, subTaskList: [] } },
  { label: 'wrong task', detail: { id: 21, scriptId: 2708, storyboardId: 1 } },
  { label: 'wrong project', detail: { id: 20, scriptId: 99, storyboardId: 1 } },
  { label: 'missing project', detail: { id: 20, storyboardId: 1 } },
  { label: 'mixed children', detail: { id: 20, scriptId: 2708, subTaskList: [{ storyboardId: 1 }, { storyboardId: 2 }] } },
  { label: 'unidentified child', detail: { id: 20, scriptId: 2708, subTaskList: [{ storyboardId: 1 }, {}] } },
  { label: 'null parent and child', detail: { id: 20, scriptId: 2708, storyboardId: null, subTaskList: [{ storyboardId: null }] } },
  { label: 'unreadable children', detail: { id: 20, scriptId: 2708, subTaskList: 'unknown' } },
])('refuses $label without a deletion plan or remote mutation', async ({ detail }) => {
  tasks = [{ id: 20, scriptId: 2708, taskType: 1 }]
  details.set(20, detail)
  await expect(preview()).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(mutations()).toEqual([])
})

it.each([
  { total: 1, rows: [] }, { total: 0, rows: [{ id: 20, scriptId: 2708 }] }, { rows: [] },
  { total: '0', rows: [] }, { total: -1, rows: [] }, { total: 0, rows: 'unknown' },
  { total: 1, rows: [{ scriptId: 2708 }] }, { total: 1, rows: [{ id: 20, scriptId: 99 }] },
  { total: 2, rows: [{ id: 20, scriptId: 2708 }, { id: 20, scriptId: 2708 }] },
].map(page => ({ page })))('refuses an incomplete or invalid authoritative task page $page', async ({ page }) => {
  pages.set(1, page)
  await expect(preview()).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(mutations()).toEqual([])
})

it('refuses a drifting task snapshot instead of treating an empty history as empty ownership', async () => {
  afterList = () => { tasks = [{ id: 30, scriptId: 2708, taskType: 2 }] }
  await expect(preview()).rejects.toThrow('changed during deletion inspection')
  expect(mutations()).toEqual([])
})

it('refuses an unfinished scan at the page bound', async () => {
  tasks = Array.from({ length: 5 }, (_, index) => ({ id: index + 1, scriptId: 2708, taskType: 2 }))
  await expect(preview({}, { storyboardDeleteTaskPageSize: 2, storyboardDeleteTaskPageLimit: 2 })).rejects.toThrow('scan limit')
  expect(calls.filter(call => call.includes('/task/list?'))).toHaveLength(2)
  expect(mutations()).toEqual([])
})

it.each([0, -1, 1.5, 101, NaN])('rejects invalid deployment scan limits before any read: %j', (value) => {
  expect(() => resolveDeletionTaskScanOptions({ storyboardDeleteTaskPageSize: value })).toThrow('within 1..100')
  expect(() => resolveDeletionTaskScanOptions({ storyboardDeleteTaskPageLimit: value })).toThrow('within 1..100')
  expect(calls).toEqual([])
})

it.each(['unauthorized', 'offline'] as const)('does not replace %s history failures with a project scan', async (mode) => {
  history = mode
  await expect(preview()).rejects.toMatchObject({ code: mode === 'unauthorized' ? 'AUTHENTICATION_REQUIRED' : 'NETWORK_ERROR' })
  expect(calls.filter(call => call.includes('/admin/'))).toEqual([])
  expect(mutations()).toEqual([])
})

it('rechecks fallback tasks before applying once and preserves replay behavior', async () => {
  const plan = await preview()
  expect(await apply(plan)).toMatchObject({ status: 'deleted', items: [{ verified_readback: true }] })
  expect(await apply(plan)).toMatchObject({ status: 'replayed' })
  expect(mutations()).toEqual(['DELETE /aigc/storyboard/1'])
})

/** A client replacement whose failed task service must not be mistaken for an empty inventory. */
class FailingTaskService extends JubianClient {
  constructor(private readonly failure: Error) { super({ credential: async () => 'unused-fixture' }) }
  override request(request: JubianRequest): Promise<JubianResponse> {
    return Promise.reject(request.path.includes('/byStoryboard/') ? new JubianError('CONTRACT_CHANGED') : this.failure)
  }
}

it.each([new Error('replacement service failed'), new JubianError('AUTHENTICATION_REQUIRED')])
('preserves task service failure without authorizing deletion: %j', async (error) => {
  const read = deletionTasks(new FailingTaskService(error), 2708, 1, resolveDeletionTaskScanOptions())
  if (error instanceof JubianError) await expect(read).rejects.toThrow('Jubian login is unavailable')
  else await expect(read).rejects.toBe(error)
  expect(mutations()).toEqual([])
})
