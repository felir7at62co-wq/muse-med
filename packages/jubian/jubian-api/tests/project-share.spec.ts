/** Project-share wire identities, complete visible pages, and exact selected recipient requests. */
import { JubianClient } from '@deepseek-ai/dsh-jubian'
import { describe, expect, it } from 'vitest'
import { buildProjectShareBatchRequest, buildProjectShareDepartmentsRequest, buildProjectShareListRequest,
  buildProjectSharePageRequest, buildProjectShareUsersRequest, readProjectShareDepartments, readProjectShareList,
  readProjectSharePage, readProjectShareUsers, type ProjectShareBatchInput } from '../src/project-share.ts'

const userShare = { id: 91, scriptId: '2708', shareType: 2, shareTargetType: 1, shareUserId: '13', shareDeptId: null,
  createBy: '原分享者', extra: { preserved: true } }
const departmentShare = { id: 92, scriptId: 2708, shareType: 1, shareTargetType: 2, shareUserId: null, shareDeptId: 31 }

describe('project-sharing reads', () => {
  it('keeps dialog and management request scopes distinct', () => {
    expect(buildProjectShareListRequest(2708)).toEqual({ method: 'GET',
      path: '/aigc/share/list?scriptId=2708&mineOnly=true' })
    expect(buildProjectSharePageRequest(2708, 2, 50)).toEqual({ method: 'GET',
      path: '/aigc/share/list?pageNum=2&pageSize=50&scriptId=2708' })
    expect(buildProjectShareUsersRequest()).toEqual({ method: 'GET', path: '/system/user/getSelectUserList?dataType=3' })
    expect(buildProjectShareDepartmentsRequest()).toEqual({ method: 'GET', path: '/system/user/shareList' })
    expect(() => buildProjectShareListRequest(0)).toThrow()
    expect(() => buildProjectSharePageRequest(2708, 0, 50)).toThrow()
    expect(() => buildProjectSharePageRequest(2708, 1, 0)).toThrow()
  })

  it('reads every visible user and department share without filtering categories or creators', () => {
    const rows = readProjectShareList({ rows: [userShare, departmentShare], total: '2' })
    expect(rows).toMatchObject([
      { share_type: 2, share_target_type: 1, user_id: 13, department_id: null, script_id: 2708 },
      { share_type: 1, share_target_type: 2, user_id: null, department_id: 31, script_id: 2708 },
    ])
    expect(rows[0]!.snapshot).toEqual(userShare)
    expect(rows[0]!.snapshot).not.toBe(userShare)
    expect(rows[0]!.snapshot.extra).not.toBe(userShare.extra)
  })

  it('retains an absent script field as unknown while preserving record identity fields', () => {
    const row = { shareType: '2', shareTargetType: '1', shareUserId: 13, shareDeptId: 0 }
    expect(readProjectShareList({ rows: [row] })).toMatchObject([{ script_id: null, user_id: 13 }])
    expect(readProjectShareList({ rows: [] })).toEqual([])
  })

  it('allows a management page to retain its larger required provider-visible total', () => {
    expect(readProjectSharePage({ rows: [userShare], total: '41' })).toMatchObject({ total: 41,
      rows: [{ user_id: 13 }] })
    expect(readProjectSharePage({ rows: [], total: 0 })).toEqual({ rows: [], total: 0 })
  })

  it.each([null, [], {}, { rows: null }, { rows: [userShare, null] },
    { rows: [userShare], total: 2 }, { rows: [userShare], total: 0 }, { rows: [], total: null },
    { rows: [], total: -1 }, { rows: [], total: 'unknown' }])
  ('rejects an unreadable or explicitly incomplete dialog list %j', (data) => {
    expect(() => readProjectShareList(data)).toThrow(expect.objectContaining({ code: 'CONTRACT_CHANGED' }))
  })

  it.each([{ rows: [] }, { rows: [userShare], total: 0 }, { rows: [], total: -1 },
    { rows: [], total: 0.5 }, { rows: [], total: Number.MAX_SAFE_INTEGER + 1 }])
  ('refuses a management page with no usable total %j', (data) => {
    expect(() => readProjectSharePage(data)).toThrow(expect.objectContaining({ code: 'CONTRACT_CHANGED' }))
  })

  it.each([{ shareUserId: null }, { shareUserId: 0 }, { shareUserId: Number.MAX_SAFE_INTEGER + 1 },
    { shareUserId: '0013' }, { shareDeptId: 31 }, { shareType: 3 }, { shareTargetType: null }, { scriptId: -1 }])
  ('rejects an invalid row instead of retaining only the valid preceding record %j', (change) => {
    expect(() => readProjectShareList({ rows: [userShare, { ...userShare, ...change }] }))
      .toThrow(expect.objectContaining({ code: 'CONTRACT_CHANGED' }))
  })

  it('uses the real transport normalizer for top-level rows and nested directory data', async () => {
    const client = new JubianClient({ credential: async () => 'offline-fixture',
      baseUrl: 'https://project-share.invalid', fetch: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input.toString())
        expect(url.origin).toBe('https://project-share.invalid')
        return new Response(JSON.stringify(url.pathname === '/aigc/share/list'
          ? { code: 200, rows: [userShare], total: 1 }
          : { code: 200, data: [{ userId: 13, nickName: '林工' }] }))
      } })
    expect(readProjectShareList((await client.request(buildProjectShareListRequest(2708))).data))
      .toMatchObject([{ user_id: 13 }])
    expect(readProjectShareUsers((await client.request(buildProjectShareUsersRequest())).data))
      .toMatchObject([{ user_id: 13, name: '林工' }])
  })
})

describe('sharing recipient directories', () => {
  it('keeps same-named users separate by exact IDs and preserves original fields', () => {
    const rows = [{ userId: '13', nickName: '林工', extra: 'a' }, { userId: 14, nickName: '林工' }]
    expect(readProjectShareUsers(rows)).toEqual([
      { user_id: 13, name: '林工', snapshot: rows[0] }, { user_id: 14, name: '林工', snapshot: rows[1] },
    ])
    expect(readProjectShareUsers([])).toEqual([])
  })

  it.each([null, { rows: [] }, [{ userId: 13 }], [{ userId: 0, nickName: '林工' }],
    [{ userId: 13, nickName: ' ' }], [{ userId: 13, nickName: '甲' }, { userId: '13', nickName: '乙' }]])
  ('refuses malformed or ambiguous user identities %j', (data) => {
    expect(() => readProjectShareUsers(data)).toThrow(expect.objectContaining({ code: 'CONTRACT_CHANGED' }))
  })

  it('reads complete TreeSelect nodes and preserves explicit disabled selections', () => {
    const tree = [{ id: '21', label: '制作部', children: [{ id: 31, label: '一组', isDisabled: true, children: [] }] }]
    expect(readProjectShareDepartments(tree)).toMatchObject([{ department_id: 21, name: '制作部', disabled: false,
      children: [{ department_id: 31, name: '一组', disabled: true, children: [] }] }])
    expect(readProjectShareDepartments([])).toEqual([])
  })

  it.each([null, { rows: [] }, [{ id: 21, label: '制作部', children: null }], [{ id: 21, label: '制作部', children: {} }],
    [{ id: 21, label: '制作部', isDisabled: 'true' }], [{ id: 21, label: '' }],
    [{ id: 21, label: '制作部', children: [{ id: '21', label: '重复节点' }] }]])
  ('refuses lazy or malformed department subtrees %j', (data) => {
    expect(() => readProjectShareDepartments(data)).toThrow(expect.objectContaining({ code: 'CONTRACT_CHANGED' }))
  })
})

describe('explicit project-share submission', () => {
  const project = { id: '2708', scriptName: '家庭剧', episodeCount: 4, canShare: 1, productionType: 0,
    shareType: 1, shareTargetType: 2, shareDeptId: 999, userIdList: [999], extra: { retained: true } }
  const selected: ProjectShareBatchInput = { scriptId: 2708, project, shareType: 2, shareTargetType: 1, userIds: [13, 14] }

  it('overrides stale share fields with the selected full user set while preserving the project row', () => {
    const request = buildProjectShareBatchRequest(selected)
    expect(request).toEqual({ method: 'POST', path: '/aigc/share/batchAddShare', body: { ...project,
      scriptId: 2708, shareType: 2, shareTargetType: 1, shareDeptId: null, userIdList: [13, 14] } })
    expect(request.body?.extra).not.toBe(project.extra)
    expect(project.shareDeptId).toBe(999)
    expect(project.userIdList).toEqual([999])
  })

  it('uses the frontend null clear value for user selection when sharing to a department', () => {
    expect(buildProjectShareBatchRequest({ ...selected, shareType: 1, departmentId: 31, userIds: [] }).body)
      .toMatchObject({ shareType: 1, shareTargetType: 1, shareDeptId: 31, userIdList: null })
  })

  it.each([{ scriptId: 0 }, { userIds: [] }, { userIds: [13, 13] }, { userIds: [0] }, { userIds: [13.5] },
    { departmentId: 31 }, { project: {} }, { project: { id: 2709 } }, { project: { id: 2708, scriptId: 2709 } }])
  ('refuses incomplete recipients or inconsistent project identity %j', (change) => {
    expect(() => buildProjectShareBatchRequest({ ...selected, ...change })).toThrow()
  })

  it('refuses an unknown sharing category and a department request retaining user recipients', () => {
    // @ts-expect-error The JSON request boundary must refuse an unrecognized category too.
    expect(() => buildProjectShareBatchRequest({ ...selected, shareTargetType: 3 })).toThrow()
    expect(() => buildProjectShareBatchRequest({ ...selected, shareType: 1, departmentId: 31 })).toThrow()
    expect(() => buildProjectShareBatchRequest({ ...selected, shareType: 1, userIds: [] })).toThrow()
  })
})
