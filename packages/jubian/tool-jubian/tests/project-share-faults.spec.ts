/** Project-sharing refusals for malformed provider data, altered local previews and damaged local stores. */
import type { Stats } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stableSha256 } from '@deepseek-ai/dsh-jubian-api'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { projectShareMethod, type ProjectShareArgs, type ProjectShareOptions } from '../src/project-share.ts'

type Row = Record<string, unknown>
type Page = (page: number, size: number) => unknown

const fault = vi.hoisted(() => ({ handle: 'none' as 'none' | 'grown' | 'notfile' | 'short' }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args)
      if (fault.handle === 'none' || args[1] !== 'r' || !String(args[0]).includes('share-previews')) return handle
      return new Proxy(handle, { get(target, property) {
        if (property === 'stat' && fault.handle === 'grown') return async () => Object.create(await target.stat(), { size: { value: 2 ** 30 } }) as Stats
        if (property === 'stat' && fault.handle === 'notfile') return async () => Object.create(await target.stat(), { isFile: { value: () => false } }) as Stats
        if (property === 'read' && fault.handle === 'short') {
          return async (...readArgs: Parameters<typeof target.read>) => {
            const read = await target.read(...readArgs)
            return { ...read, bytesRead: read.bytesRead - 1 }
          }
        }
        const member: unknown = Reflect.get(target, property, target)
        return typeof member === 'function' ? (...rest: unknown[]): unknown => Reflect.apply(member, target, rest) : member
      } })
    },
  }
})

const OPTIONS: ProjectShareOptions = { pageSize: 2, pageLimit: 10, maxDirectoryItems: 50, maxPreviewBytes: 65536, maxResultChars: 24000 }
let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'jubian-project-share-faults-')) })
afterEach(async () => {
  fault.handle = 'none'
  await rm(root, { recursive: true, force: true })
})

function record(userId: number, rowId = userId): Row {
  return { id: rowId, scriptId: 91, shareType: 2, shareTargetType: 1, shareUserId: userId, shareDeptId: null }
}
function page(rows: unknown[], pageNum: number, size: number): Row[] { return rows.slice((pageNum - 1) * size, pageNum * size) as Row[] }

/** Offline provider whose every response can be replaced by a test. */
function world() {
  const infoIds: number[] = []
  const guardPath = join(root, 'share-operation-guards', '7-91.json')
  const w = {
    guardPath,
    infoIds,
    info: (): unknown => ({ user: { userId: infoIds.shift() ?? 7, userName: '原账号' }, permissions: ['aigc:share:add'] }),
    scriptRows: [{ id: 91, scriptName: '剧本项目', canShare: 1 }] as Row[],
    scripts: undefined as Page | undefined,
    shareRows: [] as Row[],
    shares: undefined as Page | undefined,
    users: [{ userId: 11, nickName: '编导甲' }, { userId: 12, nickName: '编导乙' }, { userId: 13, nickName: '编导丙' }],
    departments: [{ id: 21, label: '制作组', children: [] }],
    onPost: undefined as (() => Promise<void>) | undefined,
    posts: 0,
  }
  const client = new JubianClient({ credential: async () => 'offline-token', fetch: async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const path = url.pathname.replace('/prod-api', ''), method = init?.method ?? 'GET'
    const pageNum = Number(url.searchParams.get('pageNum')), size = Number(url.searchParams.get('pageSize'))
    const answer = (data: unknown) => new Response(JSON.stringify({ code: 200, data }))
    if (path === '/getInfo') return answer(w.info())
    if (path === '/aigc/script/list') {
      return answer(w.scripts?.(pageNum, size) ?? { total: w.scriptRows.length, rows: page(w.scriptRows, pageNum, size) })
    }
    if (path === '/aigc/share/list') {
      return answer(w.shares?.(pageNum, size) ?? { total: w.shareRows.length, rows: page(w.shareRows, pageNum, size) })
    }
    if (path === '/system/user/getSelectUserList') return answer(w.users)
    if (path === '/system/user/shareList') return answer(w.departments)
    if (path === '/aigc/share/batchAddShare' && method === 'POST') {
      w.posts++
      const sent = JSON.parse(typeof init?.body === 'string' ? init.body : '{"userIdList":[]}') as { userIdList: number[] }
      w.shareRows = sent.userIdList.map(userId => record(userId))
      await w.onPost?.()
      return answer(null)
    }
    throw new Error(`Unexpected request ${method} ${path}`)
  } })
  const ledger = new JubianLedger({ root })
  const run = (args: ProjectShareArgs, options = OPTIONS) => projectShareMethod(client, ledger, args, options)
  return { w, run }
}

function args(json: string): ProjectShareArgs { return JSON.parse(json) as ProjectShareArgs }
const SELECT = { method: 'share_preview', script_id: 91, share_type: 2, share_target_type: 1, user_ids: [12] } satisfies ProjectShareArgs
const SHARES = { method: 'shares', script_id: 91 } satisfies ProjectShareArgs
function confirm(preview: Row, key = 'share-original'): ProjectShareArgs {
  return { method: 'share_apply', preview_id: String(preview.preview_id), preview_fingerprint: String(preview.preview_fingerprint),
    confirm: true, idempotency_key: key }
}
function previewPath(preview: Row): string { return join(root, 'share-previews', `${String(preview.preview_id)}.json`) }

/** Rewrites a saved preview and re-seals its fingerprint, as a local editor with full file access could. */
async function tamper(preview: Row, change: (saved: Row) => void): Promise<ProjectShareArgs> {
  const saved = JSON.parse(await readFile(previewPath(preview), 'utf8')) as Row
  change(saved)
  delete saved.fingerprint
  const fingerprint = stableSha256(saved)
  await writeFile(previewPath(preview), JSON.stringify({ ...saved, fingerprint }))
  return { ...confirm(preview), preview_fingerprint: fingerprint }
}

describe('provider account identity', () => {
  it.each([
    ['a blank user name', { user: { userId: 7, userName: '  ' }, permissions: [] }],
    ['permissions that are not a list', { user: { userId: 7, userName: '原账号' }, permissions: 'all' }],
    ['a permission that is not text', { user: { userId: 7, userName: '原账号' }, permissions: [1] }],
  ])('refuses an account read with %s', async (_label, info) => {
    const f = world()
    f.w.info = () => info
    await expect(f.run(SHARES)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED',
      detail: 'Current provider account identity or permissions are unreadable' })
  })

  it.each([null, { user: 'not an object', permissions: [] }])('refuses account data that is not an object: %j', async (info) => {
    const f = world()
    f.w.info = () => info
    await expect(f.run(SHARES)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED', detail: 'Expected a provider or preview object' })
  })

  it('accepts a decimal-string account ID and refuses a zero ID', async () => {
    const f = world()
    f.w.info = () => ({ user: { userId: '7', userName: '原账号' }, permissions: [] })
    expect(await f.run({ method: 'share_targets', share_type: 2 })).toMatchObject({ actor_id: 7 })
    f.w.info = () => ({ user: { userId: 0, userName: '原账号' }, permissions: [] })
    await expect(f.run({ method: 'share_targets', share_type: 2 })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT', detail: 'A positive exact ID is required' })
  })
})

describe('project inventory', () => {
  it.each([
    ['rows that are not a list', { total: 1, rows: 'x' }],
    ['a total that is text', { total: '1', rows: [] }],
    ['a negative total', { total: -1, rows: [] }],
    ['a fractional total', { total: 1.5, rows: [] }],
  ])('refuses an inventory page with %s', async (_label, body) => {
    const f = world()
    f.w.scripts = () => body
    await expect(f.run(SHARES)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED',
      detail: 'Project inventory is incomplete or changed while being read' })
  })

  it('refuses an inventory whose total changes between pages', async () => {
    const f = world()
    f.w.scripts = pageNum => ({ total: pageNum === 1 ? 2 : 3, rows: [{ id: 80 + pageNum }] })
    await expect(f.run(SHARES, { ...OPTIONS, pageSize: 1 })).rejects.toMatchObject({ code: 'CONTRACT_CHANGED',
      detail: 'Project inventory is incomplete or changed while being read' })
  })

  it.each([
    ['repeats a project', [{ id: 91, canShare: 1 }, { id: 91, canShare: 1 }]],
    ['gives one project two different identities', [{ id: 91, scriptId: 92, canShare: 1 }]],
  ])('refuses an inventory that %s', async (_label, rows) => {
    const f = world()
    f.w.scriptRows = rows
    await expect(f.run(SHARES)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED',
      detail: 'Project inventory has duplicate or conflicting identities' })
  })

  it.each([
    ['more distinct rows than its total', () => ({ total: 1, rows: [{ id: 90 }, { id: 91 }] })],
    ['an empty page before reaching its total', () => ({ total: 1, rows: [] })],
  ])('refuses an inventory with %s', async (_label, scripts) => {
    const f = world()
    f.w.scripts = scripts
    await expect(f.run(SHARES)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED',
      detail: 'Project inventory total does not match its rows' })
  })

  it('refuses a project that is absent from a complete inventory', async () => {
    const f = world()
    f.w.scriptRows = [{ id: 90, canShare: 1 }]
    await expect(f.run(SHARES)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT',
      detail: 'The exact project is not present in the current account inventory' })
  })

  it('finds the project on a later page and accepts a row identified only by scriptId', async () => {
    const f = world()
    f.w.scriptRows = [{ id: 90, canShare: 1 }, { scriptId: 91, canShare: 1 }]
    expect(await f.run(SHARES, { ...OPTIONS, pageSize: 1 })).toMatchObject({ script_id: 91, complete: true, rows: [] })
  })

  it('refuses an inventory that needs more pages than the configured scan limit', async () => {
    const f = world()
    f.w.scriptRows = [{ id: 90, canShare: 1 }, { id: 91, canShare: 1 }]
    await expect(f.run(SHARES, { ...OPTIONS, pageSize: 1, pageLimit: 1 })).rejects.toMatchObject({
      code: 'CONTRACT_CHANGED', detail: 'Project inventory exceeds configured scan limits' })
  })
})

describe('visible share inventory', () => {
  it('refuses a share inventory whose total changes between pages', async () => {
    const f = world()
    f.w.shares = pageNum => ({ total: pageNum === 1 ? 2 : 3, rows: [record(10 + pageNum)] })
    await expect(f.run(SHARES, { ...OPTIONS, pageSize: 1 })).rejects.toMatchObject({ code: 'CONTRACT_CHANGED',
      detail: 'Visible share inventory changed during paging' })
  })

  it('refuses a share record that belongs to another project', async () => {
    const f = world()
    f.w.shareRows = [{ ...record(11), scriptId: 92 }]
    await expect(f.run(SHARES)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED',
      detail: 'Sharing response belongs to a different project' })
  })

  it('accepts a record without a row ID and refuses the same record repeated on another page', async () => {
    const f = world()
    const anonymous = { scriptId: 91, shareType: 2, shareTargetType: 1, shareUserId: 11, shareDeptId: null }
    f.w.shareRows = [anonymous]
    expect(await f.run(SHARES)).toMatchObject({ rows: [{ user_id: 11 }] })
    for (const repeated of [anonymous, record(11, 5)]) {
      f.w.shares = () => ({ total: 2, rows: [repeated] })
      await expect(f.run(SHARES, { ...OPTIONS, pageSize: 1 })).rejects.toMatchObject({ code: 'CONTRACT_CHANGED',
        detail: 'Visible share inventory repeats a record across pages' })
    }
  })

  it('refuses pages that return more distinct records than the stated total', async () => {
    const f = world()
    f.w.shares = pageNum => ({ total: 3, rows: pageNum === 1 ? [record(11), record(12)] : [record(13), record(14)] })
    await expect(f.run(SHARES)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED',
      detail: 'Visible share inventory is incomplete' })
  })

  it('refuses a share inventory that needs more pages than the configured scan limit', async () => {
    const f = world()
    f.w.shares = () => ({ total: 2, rows: [record(11)] })
    await expect(f.run(SHARES, { ...OPTIONS, pageSize: 1, pageLimit: 1 })).rejects.toMatchObject({
      code: 'CONTRACT_CHANGED', detail: 'Visible share inventory exceeds configured scan limits' })
  })

  it('refuses existing recipients recorded twice under different row IDs', async () => {
    const f = world()
    f.w.shareRows = [record(12, 1), record(12, 2)]
    await expect(f.run({ ...SELECT, user_ids: [13] })).rejects.toMatchObject({ code: 'CONTRACT_CHANGED',
      detail: 'Existing share recipients have ambiguous duplicate records' })
  })
})

describe('sharing directory requests', () => {
  it('lists departments and users together when no share type is given and trims the recipient query', async () => {
    const f = world()
    expect(await f.run({ method: 'share_targets', query: ' 编导乙 ' })).toMatchObject({
      departments: [], users: [{ id: 12, name: '编导乙' }] })
    expect(await f.run({ method: 'share_targets' })).toMatchObject({
      departments: [{ id: 21, name: '制作组' }], users: [{ id: 11 }, { id: 12 }, { id: 13 }] })
  })

  it('refuses a blank recipient query', async () => {
    const f = world()
    await expect(f.run({ method: 'share_targets', share_type: 2, query: '   ' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT', detail: 'query must contain a recipient name' })
  })
})

describe('preview selection', () => {
  it.each([
    ['no share type', { method: 'share_preview', script_id: 91, share_target_type: 1, user_ids: [12] }],
    ['an unknown share type', { method: 'share_preview', script_id: 91, share_type: 3, share_target_type: 1, user_ids: [12] }],
    ['no share target type', { method: 'share_preview', script_id: 91, share_type: 2, user_ids: [12] }],
    ['an unknown share target type', { method: 'share_preview', script_id: 91, share_type: 2, share_target_type: 3, user_ids: [12] }],
  ])('requires explicit destination codes and refuses %s', async (_label, selection) => {
    const f = world()
    await expect(f.run(args(JSON.stringify(selection)))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT',
      detail: 'Preview requires explicit share_type and share_target_type; neither is an editing-permission level' })
  })

  const { user_ids: _userIds, ...withoutUsers } = SELECT
  it.each<[string, ProjectShareArgs]>([
    ['a department ID', { ...SELECT, department_id: 21 }],
    ['no user IDs', withoutUsers],
    ['an empty user list', { ...SELECT, user_ids: [] }],
  ])('refuses user sharing with %s', async (_label, selection) => {
    const f = world()
    await expect(f.run(selection)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT',
      detail: 'User sharing requires user_ids without department_id' })
  })

  it('refuses department sharing that also names users', async () => {
    const f = world()
    await expect(f.run({ method: 'share_preview', script_id: 91, share_type: 1, share_target_type: 1, department_id: 21, user_ids: [12] }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT', detail: 'Department sharing requires only department_id' })
  })

  it('requires the project ID', async () => {
    const f = world()
    const { script_id: _scriptId, ...withoutProject } = SELECT
    await expect(f.run(withoutProject)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', detail: 'A positive exact ID is required' })
  })
})

describe('confirmed preview files', () => {
  it.each([
    ['no preview ID', undefined],
    ['a preview ID that is not tool-issued', '../../outside'],
  ])('refuses confirmation with %s before reading any file', async (_label, previewId) => {
    const f = world()
    await expect(f.run({ method: 'share_apply', confirm: true, idempotency_key: 'share-original',
      ...(previewId === undefined ? {} : { preview_id: previewId }) }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT', detail: 'preview_id is not a tool-issued identifier' })
    expect(f.w.posts).toBe(0)
  })

  it('refuses a preview file larger than the configured limit', async () => {
    const f = world(), preview = await f.run(SELECT)
    await expect(f.run(confirm(preview), { ...OPTIONS, maxPreviewBytes: 100 })).rejects.toMatchObject({
      code: 'CONTRACT_CHANGED', detail: 'Sharing preview is not a bounded regular file' })
    expect(f.w.posts).toBe(0)
  })

  it('refuses a preview path that is a directory', async () => {
    const f = world(), preview = await f.run(SELECT)
    await rm(previewPath(preview))
    await mkdir(previewPath(preview))
    await expect(f.run(confirm(preview))).rejects.toMatchObject({
      code: 'CONTRACT_CHANGED', detail: 'Sharing preview is not a bounded regular file' })
  })

  it.each([
    ['grows past the limit', 'grown', 'Sharing preview exceeds its configured limit'],
    ['stops being a regular file', 'notfile', 'Sharing preview exceeds its configured limit'],
    ['returns fewer bytes than its size', 'short', 'Sharing preview changed while being read'],
  ] as const)('refuses a preview that %s after it was first inspected', async (_label, mode, detail) => {
    const f = world(), preview = await f.run(SELECT)
    fault.handle = mode
    await expect(f.run(confirm(preview))).rejects.toMatchObject({ code: 'CONTRACT_CHANGED', detail })
    expect(f.w.posts).toBe(0)
  })

  it.each([
    ['an unknown share type', (saved: Row) => { saved.share_type = 3 }],
    ['an unknown share target type', (saved: Row) => { saved.share_target_type = 3 }],
  ])('refuses a re-sealed preview with %s', async (_label, change) => {
    const f = world(), preview = await f.run(SELECT)
    await expect(f.run(await tamper(preview, change))).rejects.toMatchObject({
      code: 'CONTRACT_CHANGED', detail: 'Sharing preview has unknown destination codes' })
    expect(f.w.posts).toBe(0)
  })

  it('refuses a re-sealed preview whose recipient name is blank', async () => {
    const f = world(), preview = await f.run(SELECT)
    const sealed = await tamper(preview, (saved) => { (saved.expected_targets as Row[])[0]!.name = ' ' })
    await expect(f.run(sealed)).rejects.toMatchObject({
      code: 'CONTRACT_CHANGED', detail: 'Sharing preview recipient name is unreadable' })
  })

  it('refuses a re-sealed preview whose recipients differ from its checked request', async () => {
    const f = world(), preview = await f.run(SELECT)
    const sealed = await tamper(preview, (saved) => { saved.expected_targets = [{ id: 13, name: '编导丙' }] })
    await expect(f.run(sealed)).rejects.toMatchObject({
      code: 'CONTRACT_CHANGED', detail: 'Sharing preview recipient identities do not match its checked request' })
    expect(f.w.posts).toBe(0)
  })

  it('refuses a re-sealed preview whose request body differs from the current provider fields', async () => {
    const f = world(), preview = await f.run(SELECT)
    const sealed = await tamper(preview, (saved) => { saved.request_body = { ...(saved.request_body as Row), scriptName: '篡改' } })
    await expect(f.run(sealed)).rejects.toMatchObject({
      code: 'CONTRACT_CHANGED', detail: 'Sharing preview request no longer matches current provider fields' })
    expect(f.w.posts).toBe(0)
  })

  it('refuses to submit when a recipient was renamed in the directory after the preview', async () => {
    const f = world(), preview = await f.run(SELECT)
    f.w.users = [{ userId: 11, nickName: '编导甲' }, { userId: 12, nickName: '改名后' }, { userId: 13, nickName: '编导丙' }]
    await expect(f.run(confirm(preview))).rejects.toMatchObject({
      code: 'CONTRACT_CHANGED', detail: 'Recipient identity changed after preview' })
    expect(f.w.posts).toBe(0)
  })

  it('refuses to submit when the provider account changes between the pinned read and the checked request', async () => {
    const f = world(), preview = await f.run(SELECT)
    f.w.infoIds.push(7, 8)
    await expect(f.run(confirm(preview))).rejects.toMatchObject({
      code: 'CONTRACT_CHANGED', detail: 'Provider account changed before sharing' })
    expect(f.w.posts).toBe(0)
  })
})

describe('operation guard store', () => {
  it('lets a later key share after the earlier key was verified and records the later key as the guard', async () => {
    const f = world()
    expect(await f.run(confirm(await f.run(SELECT), 'first-key'))).toMatchObject({ status: 'accepted_verified' })
    const second = await f.run({ ...SELECT, user_ids: [13] })
    expect(await f.run(confirm(second, 'second-key'))).toMatchObject({ status: 'accepted_verified',
      readback: { observed_ids: [12, 13] } })
    expect(JSON.parse(await readFile(f.w.guardPath, 'utf8'))).toMatchObject({ key: 'second-key', verified: true })
  })

  it('leaves another key guard untouched when a verified original key is replayed', async () => {
    const f = world(), preview = await f.run(SELECT)
    expect(await f.run(confirm(preview, 'first-key'))).toMatchObject({ status: 'accepted_verified' })
    const foreign = `${JSON.stringify({ version: 1, key: 'foreign-key', preview_id: 'other', verified: true })}\n`
    await writeFile(f.w.guardPath, foreign)
    expect(await f.run(confirm(preview, 'first-key'))).toMatchObject({ replayed: true, status: 'accepted_verified' })
    expect(await readFile(f.w.guardPath, 'utf8')).toBe(foreign)
    expect(f.w.posts).toBe(1)
  })

  it('refuses a guard file with unknown fields before submitting', async () => {
    const f = world(), preview = await f.run(SELECT)
    await mkdir(join(root, 'share-operation-guards'), { recursive: true })
    await writeFile(f.w.guardPath, '{"version":2}')
    await expect(f.run(confirm(preview))).rejects.toMatchObject({
      code: 'CONTRACT_CHANGED', detail: 'Sharing operation guard is unreadable' })
    expect(f.w.posts).toBe(0)
  })

  it('surfaces an operating-system error from reading the guard instead of treating it as absent', async () => {
    const f = world(), preview = await f.run(SELECT)
    await mkdir(f.w.guardPath, { recursive: true })
    await expect(f.run(confirm(preview))).rejects.toMatchObject({ code: 'EISDIR' })
    expect(f.w.posts).toBe(0)
  })

  it('reports readback as unavailable with a generic reason when the guard is damaged during submission', async () => {
    const f = world(), preview = await f.run(SELECT)
    f.w.onPost = async () => { await writeFile(f.w.guardPath, '{broken') }
    expect(await f.run(confirm(preview))).toMatchObject({ outcome: 'accepted', status: 'accepted_unverified',
      readback: { status: 'unavailable', reason: 'Sharing readback failed', global_access_verified: false } })
    expect(f.w.posts).toBe(1)
  })
})
