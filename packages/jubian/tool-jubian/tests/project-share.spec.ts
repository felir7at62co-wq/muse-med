import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stableSha256 } from '@deepseek-ai/dsh-jubian-api'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { projectShareMethod, type ProjectShareArgs, type ProjectShareOptions } from '../src/project-share.ts'

type Row = Record<string, unknown>
const OPTIONS: ProjectShareOptions = { pageSize: 2, pageLimit: 10, maxDirectoryItems: 50,
  maxPreviewBytes: 65536, maxResultChars: 24000 }
let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'jubian-project-share-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
function record(userId: number, rowId = userId): Row {
  return { id: rowId, scriptId: 91, shareType: 2, shareTargetType: 1, shareUserId: userId, shareDeptId: null }
}
function fixture(ledgerRoot = root) {
  const responseData: unknown = null
  const state = { token: 'account-one', permissions: ['aigc:share:add'], canShare: 1,
    projectName: '剧本项目', rows: [] as Row[], users: [{ userId: 11, nickName: '编导甲' },
      { userId: 12, nickName: '编导乙' }, { userId: 13, nickName: '编导乙' }],
    departments: [{ id: 21, label: '制作组', children: [{ id: 22, label: '配音组' }] }] as Row[],
    responseData,
    mode: 'normal' as 'normal' | 'lost' | 'unchanged', tokenChangeOnProject: false, incomplete: false, readbackUnavailable: false }
  const calls: { method: string; path: string; token: string | null; body: unknown }[] = []
  const client = new JubianClient({ credential: async () => state.token, fetch: async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const path = url.pathname.replace('/prod-api', ''), method = init?.method ?? 'GET'
    const token = new Headers(init?.headers).get('Authorization')
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    calls.push({ method, path, token, body })
    const answer = (data: unknown) => new Response(JSON.stringify({ code: 200, data }))
    if (path === '/getInfo') return answer({ user: { userId: token === 'Bearer account-one' ? 7 : 8,
      userName: token === 'Bearer account-one' ? '原账号' : '另一账号' }, permissions: state.permissions })
    if (path === '/aigc/script/list') {
      if (state.tokenChangeOnProject) state.token = 'account-two'
      return answer({ total: 1, rows: [{ id: 91, scriptName: state.projectName, canShare: state.canShare,
        unrelatedSetting: { retain: 'exact' } }] })
    }
    if (path === '/aigc/share/list') {
      if (state.readbackUnavailable && calls.some(call => call.method === 'POST')) throw new Error('Offline readback unavailable')
      const page = Number(url.searchParams.get('pageNum')), size = Number(url.searchParams.get('pageSize'))
      return answer({ total: state.rows.length + (state.incomplete ? 1 : 0), rows: state.rows.slice((page - 1) * size, page * size) })
    }
    if (path === '/system/user/getSelectUserList') return answer(state.users)
    if (path === '/system/user/shareList') return answer(state.departments)
    if (path === '/aigc/share/batchAddShare' && method === 'POST') {
      const sent = body as { shareType: 1 | 2; shareTargetType: 1 | 2; userIdList: number[] | null; shareDeptId: number | null }
      if (state.mode !== 'unchanged') {
        state.rows = sent.shareType === 2 ? sent.userIdList!.map(userId => record(userId))
          : [{ id: 31, scriptId: 91, shareType: 1, shareTargetType: sent.shareTargetType,
            shareUserId: null, shareDeptId: sent.shareDeptId }]
      }
      if (state.mode === 'lost') throw new Error('response lost after sharing dispatch')
      return answer(state.responseData)
    }
    throw new Error(`Unexpected request ${method} ${path}`)
  } })
  const ledger = new JubianLedger({ root: ledgerRoot })
  const run = (args: ProjectShareArgs, options = OPTIONS) => projectShareMethod(client, ledger, args, options)
  return { state, client, ledger, calls, run }
}
const SELECT = { method: 'share_preview', script_id: 91, share_type: 2, share_target_type: 1, user_ids: [12] } satisfies ProjectShareArgs
function confirm(preview: Row, key = 'share-original'): ProjectShareArgs {
  return { method: 'share_apply', preview_id: String(preview.preview_id), preview_fingerprint: String(preview.preview_fingerprint),
    confirm: true, idempotency_key: key }
}

describe('sharing directory and visible records', () => {
  it('keeps duplicate names as distinct real choices and labels destination codes separately from editing permissions', async () => {
    const f = fixture()
    expect(await f.run({ method: 'share_targets', share_type: 2, query: '编导乙' })).toMatchObject({
      users: [{ id: 12, name: '编导乙' }, { id: 13, name: '编导乙' }], editing_permissions: 'not_expressed_by_these_codes' })
    expect(f.calls.every(call => call.method === 'GET')).toBe(true)
  })

  it('reads complete paginated provider-visible records without claiming global access coverage', async () => {
    const f = fixture()
    f.state.rows = [record(11), record(12), record(13)]
    expect(await f.run({ method: 'shares', script_id: 91 })).toMatchObject({ complete: true, scope: 'provider_visible',
      global_access_verified: false, rows: [{ user_id: 11 }, { user_id: 12 }, { user_id: 13 }] })
    expect(f.calls.filter(call => call.path === '/aigc/share/list')).toHaveLength(2)
  })

  it('refuses incomplete share inventories instead of assuming missing recipients are absent', async () => {
    const f = fixture()
    f.state.rows = [record(11)]
    f.state.incomplete = true
    await expect(f.run(SELECT)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
    expect(f.calls.some(call => call.method === 'POST')).toBe(false)
  })

  it('keeps disabled ancestors and their descendants unavailable and counts disabled nodes toward the directory bound', async () => {
    const f = fixture()
    f.state.departments = [{ id: 21, label: '不可用', isDisabled: true, children: [{ id: 22, label: '子部门' }] }]
    expect(await f.run({ method: 'share_targets', share_type: 1 })).toMatchObject({ departments: [] })
    await expect(f.run({ method: 'share_targets', share_type: 1 }, { ...OPTIONS, maxDirectoryItems: 1 }))
      .rejects.toThrow('Department directory exceeds')
    await expect(f.run({ method: 'share_preview', script_id: 91, share_type: 1, share_target_type: 1, department_id: 22 }))
      .rejects.toThrow('absent from the current sharing directory')
    expect(f.calls.some(call => call.method === 'POST')).toBe(false)
  })

})

describe('additive sharing preview and apply', () => {
  it('preserves old recipients, confirms a frozen preview and independently reads back one accepted submission', async () => {
    const f = fixture()
    f.state.rows = [record(11)]
    const preview = await f.run(SELECT)
    expect(preview).toMatchObject({ additions: [{ id: 12 }], preserved_and_expected: [{ id: 11 }, { id: 12 }],
      scope: 'provider_visible', confirmation_required: true })
    expect(f.calls.some(call => call.method === 'POST')).toBe(false)
    const saved = await readFile(join(root, 'share-previews', `${String(preview.preview_id)}.json`), 'utf8')
    expect(saved).not.toContain('account-one')
    expect(await f.run(confirm(preview))).toMatchObject({ outcome: 'accepted', status: 'accepted_verified',
      readback: { status: 'verified', observed_ids: [11, 12], global_access_verified: false } })
    const posts = f.calls.filter(call => call.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0]?.body).toMatchObject({ scriptId: 91, shareType: 2, shareTargetType: 1, userIdList: [11, 12],
      shareDeptId: null, unrelatedSetting: { retain: 'exact' } })
    expect(await f.ledger.find('share-original')).toMatchObject({ method: 'project_share', script_id: 91, outcome: 'accepted' })
    expect(await f.run(confirm(preview))).toMatchObject({ replayed: true, outcome: 'accepted' })
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1)
  })

  it('does not POST a preview containing only recipients already shared', async () => {
    const f = fixture()
    f.state.rows = [record(12)]
    const preview = await f.run(SELECT)
    expect(preview).toMatchObject({ no_changes: true })
    expect(await f.run(confirm(preview))).toMatchObject({ status: 'already_shared', submitted: false })
    expect(f.calls.some(call => call.method === 'POST')).toBe(false)
  })

  it('shares a real department only when no different department would be removed', async () => {
    const f = fixture()
    const preview = await f.run({ method: 'share_preview', script_id: 91, share_type: 1, share_target_type: 1, department_id: 21 })
    expect(await f.run(confirm(preview))).toMatchObject({ status: 'accepted_verified' })
    expect(f.calls.find(call => call.method === 'POST')?.body).toMatchObject({ shareDeptId: 21, userIdList: null })
    await expect(f.run({ method: 'share_preview', script_id: 91, share_type: 1, share_target_type: 1, department_id: 22 }))
      .rejects.toThrow('cannot preserve several departments')
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1)
  })

  it.each([
    { id: 1, scriptId: 91, shareType: 1, shareTargetType: 1, shareDeptId: 21, shareUserId: null },
    { id: 1, scriptId: 91, shareType: 2, shareTargetType: 2, shareUserId: 11, shareDeptId: null },
  ])('refuses other existing share types or targets: %j', async (existing) => {
    const f = fixture()
    f.state.rows = [existing]
    await expect(f.run(SELECT)).rejects.toThrow('preservation is unverified')
    expect(f.calls.some(call => call.method === 'POST')).toBe(false)
  })

  it('requires actual permission, a shareable project, known directory IDs and explicit confirmation', async () => {
    const f = fixture()
    f.state.permissions = []
    await expect(f.run(SELECT)).rejects.toThrow('permission')
    f.state.permissions = ['aigc:share:add']
    f.state.canShare = 0
    await expect(f.run(SELECT)).rejects.toThrow('permission')
    f.state.canShare = 1
    await expect(f.run({ ...SELECT, user_ids: [999] })).rejects.toThrow('absent from the current sharing directory')
    const preview = await f.run(SELECT)
    await expect(f.run({ ...confirm(preview), confirm: false })).rejects.toThrow('explicit confirmation')
    expect(f.calls.some(call => call.method === 'POST')).toBe(false)
  })

  it('rejects another account, modified preview and changed project or share state before submission', async () => {
    const f = fixture(), preview = await f.run(SELECT)
    f.state.token = 'account-two'
    await expect(f.run(confirm(preview))).rejects.toThrow('different account')
    f.state.token = 'account-one'
    f.state.projectName = '改名项目'
    await expect(f.run(confirm(preview))).rejects.toThrow('state changed')
    f.state.projectName = '剧本项目'
    f.state.rows = [record(11)]
    await expect(f.run(confirm(preview))).rejects.toThrow('state changed')
    f.state.rows = []
    await writeFile(join(root, 'share-previews', `${String(preview.preview_id)}.json`), '{}')
    await expect(f.run(confirm(preview))).rejects.toThrow('fingerprint')
    expect(f.calls.some(call => call.method === 'POST')).toBe(false)
  })

  it('keeps submission and readback on one account even when the global credential changes during the operation', async () => {
    const f = fixture(), preview = await f.run(SELECT)
    f.state.tokenChangeOnProject = true
    const start = f.calls.length
    expect(await f.run(confirm(preview))).toMatchObject({ status: 'accepted_verified', actor_id: 7 })
    expect(f.calls.slice(start).every(call => call.token === 'Bearer account-one')).toBe(true)
    expect(f.state.token).toBe('account-two')
  })

  it('does not resubmit an unknown result under the original key or another key', async () => {
    const f = fixture(), preview = await f.run(SELECT)
    f.state.mode = 'lost'
    await expect(f.run(confirm(preview))).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    expect(await f.run(confirm(preview))).toMatchObject({ replayed: true, outcome: 'unknown', status: 'unknown' })
    const next = await f.run({ ...SELECT, user_ids: [13] })
    await expect(f.run(confirm(next, 'replacement-key'))).rejects.toThrow('unresolved')
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1)
  })

  it('serializes different previews and keys so the second cannot remove the first submission', async () => {
    const f = fixture(), first = await f.run(SELECT), second = await f.run({ ...SELECT, user_ids: [13] })
    const results = await Promise.allSettled([f.run(confirm(first, 'first-key')), f.run(confirm(second, 'second-key'))])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1)
  })

  it('reports accepted-but-unverified separately when the provider did not expose the expected state', async () => {
    const f = fixture(), preview = await f.run(SELECT)
    f.state.mode = 'unchanged'
    expect(await f.run(confirm(preview))).toMatchObject({ outcome: 'accepted', status: 'accepted_unverified', readback: { status: 'unverified' } })
    const next = await f.run({ ...SELECT, user_ids: [13] })
    await expect(f.run(confirm(next, 'new-key'))).rejects.toThrow('unresolved')
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1)
  })

  it('enforces directory, preview-byte and complete-result limits before sending a sharing request', async () => {
    const f = fixture()
    await expect(f.run({ method: 'share_targets', share_type: 2 }, { ...OPTIONS, maxDirectoryItems: 1 })).rejects.toThrow('directory')
    await expect(f.run(SELECT, { ...OPTIONS, maxPreviewBytes: 10 })).rejects.toThrow('preview exceeds')
    await expect(f.run({ method: 'share_targets', share_type: 2 }, { ...OPTIONS, maxResultChars: 10 })).rejects.toThrow('output limit')
    expect(f.calls.some(call => call.method === 'POST')).toBe(false)
  })

  it('refuses a rehashed local preview that would remove an existing recipient', async () => {
    const f = fixture()
    f.state.rows = [record(11)]
    const preview = await f.run(SELECT), path = join(root, 'share-previews', `${String(preview.preview_id)}.json`)
    const saved = JSON.parse(await readFile(path, 'utf8')) as Row
    saved.expected_ids = [12]
    saved.expected_targets = [{ id: 12, name: '编导乙' }]
    saved.request_body = { ...saved.request_body as Row, userIdList: [12] }
    delete saved.fingerprint
    const alteredFingerprint = stableSha256(saved)
    await writeFile(path, JSON.stringify({ ...saved, fingerprint: alteredFingerprint }))
    await expect(f.run({ ...confirm(preview), preview_fingerprint: alteredFingerprint })).rejects.toThrow('preserve the existing recipients')
    expect(f.calls.some(call => call.method === 'POST')).toBe(false)
  })


  it('retains the accepted original-key receipt when a provider response exceeds the complete-result limit', async () => {
    const f = fixture(), preview = await f.run(SELECT)
    f.state.responseData = { longResponse: 'provider-details'.repeat(1000) }
    const result = await f.run(confirm(preview), { ...OPTIONS, maxResultChars: 2048 })
    expect(result).toMatchObject({ outcome: 'accepted', status: 'accepted_verified', original_idempotency_key: 'share-original',
      result_details_omitted: true, readback: { status: 'verified' }, global_access_verified: false })
    expect(result.receipt_path).toEqual(expect.any(String))
    expect(JSON.stringify(result, null, 2).length).toBeLessThanOrEqual(2048)
    expect(result.data).toBeUndefined()
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1)
    expect(await f.run(confirm(preview), { ...OPTIONS, maxResultChars: 2048 }))
      .toMatchObject({ replayed: true, outcome: 'accepted', result_details_omitted: true })
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1)
  })

  it('bounds the formatted directory output that actually reaches the model', async () => {
    const f = fixture()
    f.state.users = Array.from({ length: 40 }, (_, index) => ({ userId: index + 1, nickName: '编导' }))
    const query = { method: 'share_targets', share_type: 2 } satisfies ProjectShareArgs
    const complete = await f.run(query)
    expect(JSON.stringify(complete).length).toBeLessThan(2048)
    expect(JSON.stringify(complete, null, 2).length).toBeGreaterThan(2048)
    await expect(f.run(query, { ...OPTIONS, maxResultChars: 2048 })).rejects.toThrow('output limit')
    expect(f.calls.some(call => call.method === 'POST')).toBe(false)
  })

  it('preserves an exactly fitting original key after accepted submission with unavailable readback', async () => {
    const prepare = async (name: string) => {
      const f = fixture(join(root, name))
      f.state.responseData = { longResponse: 'provider-details'.repeat(1000) }
      f.state.readbackUnavailable = true
      return { f, preview: await f.run(SELECT) }
    }
    const calibration = await prepare('bound-one')
    const shortKey = 'calibration'
    const original = await calibration.f.run(confirm(calibration.preview, shortKey), { ...OPTIONS, maxResultChars: 2048 })
    expect(original).toMatchObject({ outcome: 'accepted', status: 'accepted_unverified',
      result_details_omitted: true, readback: { status: 'unavailable' } })
    const originalLength = JSON.stringify(original, null, 2).length
    const boundaryKey = 'k'.repeat(shortKey.length + 2048 - originalLength)

    const exact = await prepare('bound-two')
    const accepted = await exact.f.run(confirm(exact.preview, boundaryKey), { ...OPTIONS, maxResultChars: 2048 })
    expect(JSON.stringify(accepted, null, 2).length).toBe(2048)
    expect(accepted.original_idempotency_key).toBe(boundaryKey)
    expect(accepted.receipt_path).toEqual(expect.any(String))
    expect(exact.f.calls.filter(call => call.method === 'POST')).toHaveLength(1)
    expect(await exact.f.ledger.find(boundaryKey)).toMatchObject({ outcome: 'accepted' })

    const over = await prepare('bound-bad')
    await expect(over.f.run(confirm(over.preview, boundaryKey + 'x'), { ...OPTIONS, maxResultChars: 2048 }))
      .rejects.toThrow('output limit')
    expect(over.f.calls.some(call => call.method === 'POST')).toBe(false)
    expect(await over.f.ledger.records()).toEqual([])
  })

})
