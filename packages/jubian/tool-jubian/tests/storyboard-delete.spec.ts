/** Exact-target inspection, stale protection and replay of storyboard deletion. */
import { mkdtemp, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { storyboardMethod } from '../src/methods.ts'

let root: string
let client: JubianClient
let ledger: JubianLedger
let boards: Record<string, unknown>[]
let linked: Record<string, unknown>[]
let linkedEnvelope: Record<string, unknown> | undefined
let deletes: string[]
let interrupted: boolean
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jubian-delete-'))
  await writeFile(join(root, 'project_config.json'), JSON.stringify({ jubian_script_id: 2708 }))
  ledger = new JubianLedger({ root: join(root, 'ledger') })
  boards = [1, 2].map(id => ({ id, scriptId: 2708, episodeId: null, episodeCount: 2,
    storyboardName: `旧测试${id}`, isGenerate: 1,
    modelConfig: JSON.stringify({ prompt: '测试内容', duration: 8.7 }), storyboardMaterialList: [] }))
  linked = []; linkedEnvelope = undefined; deletes = []; interrupted = false
  client = new JubianClient({ credential: async () => 'mock-token', fetch: async (url, init) => {
    const path = new URL(url instanceof Request ? url.url : url.toString()).pathname.replace('/prod-api', '')
    const answer = (data: unknown) => new Response(JSON.stringify({ code: 200, data }))
    if (path.startsWith('/aigc/storyboard/byStoryboard/')) return answer(linkedEnvelope ?? linked)
    if (init?.method === 'GET') return answer(boards.find(board => board.id === Number(path.split('/').pop())) ?? null)
    if (init?.method === 'DELETE') {
      deletes.push(path)
      boards = boards.filter(board => board.id !== Number(path.split('/').pop()))
      if (interrupted) throw new Error('response lost after server deletion')
      return answer(null)
    }
    throw new Error(`Unexpected request ${String(init?.method)} ${path}`)
  } })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const preview = (extra = {}) => storyboardMethod(client, ledger, {
  method: 'delete_preview', script_id: 2708, project_dir: root, storyboard_ids: [1, 2],
  delete_reason: '删除这两张旧测试卡', authorization_basis: '用户要求清理这两张旧测试卡', ...extra,
})
const apply = (plan: Record<string, unknown>, extra = {}) => storyboardMethod(client, ledger, {
  method: 'delete_apply', script_id: 2708, project_dir: root, preview_path: String(plan.preview_path),
  idempotency_key: String(plan.fingerprint), checked_storyboard_ids: [1, 2], ...extra,
})

it('inspects malformed old cards then removes only the reviewed identities', async () => {
  const plan = await preview()
  expect(plan).toMatchObject({ operation: 'storyboard_delete', targets: [
    { storyboard_id: 1, episode_id: null, duration: 8.7, prompt: '测试内容' },
    { storyboard_id: 2, episode_id: null },
  ] })
  expect(deletes).toEqual([])
  expect(await apply(plan)).toMatchObject({ status: 'deleted', paid_requests: 0,
    items: [{ storyboard_id: 1, status: 'deleted' }, { storyboard_id: 2, status: 'deleted' }] })
  expect(deletes).toEqual(['/aigc/storyboard/1', '/aigc/storyboard/2'])
  expect(await apply(plan)).toMatchObject({ replayed: true })
  expect(deletes).toHaveLength(2)
})
it('requires the inspection result to name every target before deletion', async () => {
  const plan = await preview()
  await expect(apply(plan, { checked_storyboard_ids: [1] })).rejects.toThrow(/检查|inspect/)
  expect(deletes).toEqual([])
})
it('preflights the whole batch and sends nothing when any target changed', async () => {
  const plan = await preview()
  boards[1] = { ...boards[1], modelConfig: JSON.stringify({ prompt: '正式镜头', duration: 12 }) }
  await expect(apply(plan)).rejects.toThrow(/Stale|变更/)
  expect(deletes).toEqual([])
})
it('refuses a different project, duplicate targets and missing authorization', async () => {
  await expect(preview({ storyboard_ids: [1, 1] })).rejects.toThrow()
  boards[1] = { ...boards[1], scriptId: 999 }
  await expect(preview()).rejects.toThrow()
  await expect(preview({ authorization_basis: '' })).rejects.toThrow()
  expect(deletes).toEqual([])
})
it('reports linked outputs and requires explicit authorization for their removal', async () => {
  linked = [{ id: 77, status: 'completed', videoUrl: 'https://media.example/77.mp4' }]
  const plan = await preview()
  expect(plan).toMatchObject({ requires_generated_authorization: true })
  await expect(apply(plan)).rejects.toThrow(/生成|generated/)
  const authorized = await preview({ include_generated_media: true })
  expect(await apply(authorized)).toMatchObject({ status: 'deleted' })
})
it('refuses active generation even when completed media removal is authorized', async () => {
  linked = [{ id: 77, status: 'running' }]
  const plan = await preview({ include_generated_media: true })
  await expect(apply(plan)).rejects.toThrow(/运行|active/)
  expect(deletes).toEqual([])
})
it('reconciles a lost delete response and never resends the original plan', async () => {
  const plan = await preview()
  interrupted = true
  expect(await apply(plan)).toMatchObject({ status: 'partial', items: [
    { storyboard_id: 1, status: 'deleted', response_status: 'unknown' },
    { storyboard_id: 2, status: 'not_attempted' },
  ] })
  interrupted = false
  expect(await apply(plan)).toMatchObject({ replayed: true, items: [
    { storyboard_id: 1, status: 'deleted' }, { storyboard_id: 2, status: 'not_attempted' },
  ] })
  expect(deletes).toHaveLength(1)
})

it('refuses a partial linked-task page before authorizing any deletion', async () => {
  linkedEnvelope = { rows: [{ id: 77, status: 'completed' }], total: 2 }
  await expect(preview({ include_generated_media: true })).rejects.toThrow(/complete|incomplete/i)
  expect(deletes).toEqual([])
})

it('accepts a linked-task envelope only when its count establishes a complete list', async () => {
  linkedEnvelope = { list: [{ id: 77, status: 'completed' }], total: 1 }
  expect(await preview({ include_generated_media: true })).toMatchObject({ targets: [
    { storyboard_id: 1, tasks: [{ id: 77 }], active_generation: false },
    { storyboard_id: 2, tasks: [{ id: 77 }], active_generation: false },
  ] })
  linkedEnvelope = { list: [{ id: 77, status: 'completed' }] }
  await expect(preview({ include_generated_media: true })).rejects.toThrow(/complete|incomplete/i)
})

it('rejects an outside preview path before parsing its contents', async () => {
  const plan = await preview()
  const outside = join(root, 'outside-preview.json')
  await writeFile(outside, 'private-data-is-not-a-deletion-preview')
  await expect(apply(plan, { preview_path: outside })).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(deletes).toEqual([])
})

it('refuses a preview source reached through a directory junction', async () => {
  const plan = await preview()
  const directory = join(root, 'video_tasks')
  const archive = join(root, 'preview-archive')
  await rename(directory, archive)
  await symlink(archive, directory, 'junction')
  try {
    await expect(apply(plan)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
    expect(deletes).toEqual([])
  } finally { await unlink(directory) }
})

it.each([
  { method: 'storyboard_save' as const, scriptId: 2708 },
  { method: 'storyboard_remove' as const, scriptId: 999 },
  { method: 'storyboard_remove' as const, scriptId: 2708 },
])('rejects a foreign target claim during deletion replay: %j', async (claim) => {
  const plan = await preview()
  const key = String(plan.fingerprint)
  await ledger.begin({ idempotencyKey: key, method: 'storyboard_remove', scriptId: 2708, requestSha256: `sha256:${key}` })
  await ledger.begin({ idempotencyKey: `${key}:1`, ...claim, requestSha256: 'sha256:foreign' })
  await expect(apply(plan)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(deletes).toEqual([])
})

it('reports readback separately from the lost response during replay', async () => {
  const plan = await preview()
  interrupted = true
  await apply(plan)
  interrupted = false
  expect(await apply(plan)).toMatchObject({ replayed: true, items: [
    { storyboard_id: 1, status: 'deleted', response_status: 'unknown', verified_readback: true },
    { storyboard_id: 2, status: 'not_attempted', verified_readback: false },
  ] })
  expect(deletes).toHaveLength(1)
})
