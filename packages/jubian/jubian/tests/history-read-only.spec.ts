import { afterEach, describe, expect, it, vi } from 'vitest'
import { JUBIAN_DEFAULT_BASE_URL, JubianClient } from '../src/client.ts'
import type { JubianRequest } from '../src/client.ts'
import { DEBUG_DUMP_ENV, JubianDebugDump } from '../src/debug-dump.ts'

const mode = 'MUSE_JUBIAN_HISTORY_READ_ONLY'
const subTasks = '/admin/aigc/video/task/sub/list'
const pages = 'pageNum=1&pageSize=100'
const sorted = 'orderByColumn=createTime&orderBy=desc'
const blocked = {
  code: 'PERMISSION_DENIED', detail: '历史素材只读验证仅允许明确核对过的查询，当前请求没有发送',
  responseEvidence: undefined,
}

function fakeClient(baseUrl?: string) {
  const credential = vi.fn(async () => 'fixture-token')
  const transport = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ code: 200, data: { rows: [] } })))
  const client = new JubianClient({ credential, fetch: transport, ...(baseUrl === undefined ? {} : { baseUrl }) })
  return { client, credential, transport }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('Jubian historical replay', () => {
  it('keeps the reviewed project, identity, catalogue, material and task reads used by native recovery', async () => {
    vi.stubEnv(mode, '1')
    const { client, credential, transport } = fakeClient()
    const paths = [
      '/getInfo', '/aigc/script/list?pageNum=1&pageSize=1',
      '/aigc/script/6613', '/aigc/episode/21', '/aigc/storyboard/123', '/aigc/storyboard/byStoryboard/123',
      '/aigc/asset/123', '/admin/aigc/video/task/456',
      '/aigc/episode/list?scriptId=6613&' + pages,
      '/aigc/storyboard/list?scriptId=6613&' + pages,
      '/aigc/asset/list?scriptId=6613&' + pages,
      '/aigc/asset/list?scriptId=6613&assetType=4&isParent=1&' + pages,
      '/aigc/material/list?scriptId=6613&' + pages,
      '/aigc/material/list?scriptId=6613&isUsed=1&pageNumber=1&' + pages,
      '/admin/aigc/video/task/list?scriptId=6613&' + pages + '&' + sorted,
      '/admin/aigc/video/task/list?scriptId=6613&taskType=1&' + pages,
      '/model/charge/getSelectList?taskType=1',
      '/aigc/material/selectNoPage?assetId=123&scriptId=6613',
      '/aigc/material/getGeneratedImageByAssetId?assetId=123',
    ]
    for (const path of paths) {
      await expect(client.request({ method: 'GET', path })).resolves.toMatchObject({ data: { rows: [] } })
    }
    expect(credential).toHaveBeenCalledTimes(paths.length)
    expect(transport.mock.calls.map(([url, init]) => [url, init?.method, init?.body, init?.redirect]))
      .toEqual(paths.map(path => [JUBIAN_DEFAULT_BASE_URL + path, 'GET', undefined, 'error']))
  })

  it.each(['', '?' + pages, '?' + sorted, '?' + pages + '&' + sorted])('allows only the existing read-only POST form %s',
    async (query) => {
      vi.stubEnv(mode, '1')
      const { client, transport } = fakeClient()
      const body = { aigcVideoTaskId: query === '' ? '456' : 456 }
      await expect(client.request({ method: 'POST', path: subTasks + query, body })).resolves.toMatchObject({
        data: { rows: [] },
      })
      expect(transport).toHaveBeenCalledWith(JUBIAN_DEFAULT_BASE_URL + subTasks + query, expect.objectContaining({
        method: 'POST', body: JSON.stringify(body),
      }))
    })

  const forbidden: JubianRequest[] = [
    { method: 'GET', path: '/aigc/material/confirm/123' },
    { method: 'POST', path: '/aigc/storyboard', body: { id: 123 } },
    { method: 'POST', path: '/aigc/storyboard/subtitleEraser', body: { id: 123 } },
    { method: 'PUT', path: '/aigc/storyboard', body: { id: 123 } },
    { method: 'DELETE', path: '/aigc/storyboard/123' },
    { method: 'GET', path: 'https://web.jubianai.net/prod-api/getInfo' },
    { method: 'GET', path: '//getInfo' },
    { method: 'GET', path: '/getInfo?' },
    { method: 'GET', path: '/getInfo\n' },
    { method: 'GET', path: '/getInfo', body: {} },
    { method: 'GET', path: '/getInfo?intent=privatefixture' },
    { method: 'GET', path: '/aigc/storyboard/%2e%2e/123' },
    { method: 'GET', path: '/aigc/episode/list?scriptId=6613?scriptId=123&' + pages },
    { method: 'GET', path: '/aigc/episode/list?scriptId=6613&&' + pages },
    { method: 'GET', path: '/aigc/episode/list?scriptId=6613&scriptId=456&' + pages },
    { method: 'GET', path: '/aigc/episode/list?scriptId=6613&pageNum=1&pageSize=1001' },
    { method: 'GET', path: '/aigc/episode/list?pageNum=1&pageSize=100' },
    { method: 'GET', path: '/aigc/material/list?scriptId=6613&isUsed=0&' + pages },
    { method: 'GET', path: '/aigc/material/list?scriptId=6613&pageNumber=2&' + pages },
    { method: 'GET', path: '/aigc/asset/list?scriptId=6613&isParent=0&' + pages },
    { method: 'GET', path: '/aigc/asset/list?scriptId=6613&assetType=1&' + pages },
    { method: 'GET', path: '/aigc/asset/123?scope=1' },
    { method: 'GET', path: '/aigc/asset/9007199254740992' },
    { method: 'GET', path: '/admin/aigc/video/task/list?scriptId=6613&orderByColumn=status&orderBy=asc&' + pages },
    { method: 'GET', path: '/admin/aigc/video/task/list?scriptId=6613&taskType=0&' + pages },
    { method: 'GET', path: '/model/charge/getSelectList?taskType=2' },
    { method: 'POST', path: subTasks },
    { method: 'POST', path: subTasks, body: { aigcVideoTaskId: 456, force: true } },
    { method: 'POST', path: subTasks, body: { taskId: 456 } },
    { method: 'POST', path: subTasks, body: { aigcVideoTaskId: '456&privatefixture=1' } },
    { method: 'POST', path: subTasks, body: { aigcVideoTaskId: -456 } },
    { method: 'POST', path: subTasks, body: null as unknown as Record<string, unknown> },
    { method: 'POST', path: subTasks, body: [] as unknown as Record<string, unknown> },
    { method: 'POST', path: subTasks + '?pageNum=1', body: { aigcVideoTaskId: 456 } },
    { method: 'POST', path: subTasks + '?orderByColumn=createTime', body: { aigcVideoTaskId: 456 } },
  ]

  it.each(forbidden)('rejects $method $path before credential access or transport', async (request) => {
    vi.stubEnv(mode, '1')
    const { client, credential, transport } = fakeClient()
    await expect(client.request(request)).rejects.toMatchObject(blocked)
    expect(credential).not.toHaveBeenCalled()
    expect(transport).not.toHaveBeenCalled()
  })

  it.each(['https://mirror.invalid/prod-api', JUBIAN_DEFAULT_BASE_URL + '?target='])(
    'rejects an altered provider origin %s even for reviewed routes or credential snapshots',
    async (baseUrl) => {
      vi.stubEnv(mode, '1')
      const { client, credential, transport } = fakeClient(baseUrl)
      await expect(client.request({ method: 'GET', path: '/getInfo' })).rejects.toMatchObject(blocked)
      await expect(client.snapshotCredential()).rejects.toMatchObject(blocked)
      expect(credential).not.toHaveBeenCalled()
      expect(transport).not.toHaveBeenCalled()
    },
  )

  it('retains the audit fence in an operation snapshot', async () => {
    const { client, transport } = fakeClient()
    vi.stubEnv(mode, '1')
    const snapshot = await client.snapshotCredential()
    vi.stubEnv(mode, undefined)
    await expect(snapshot.request({ method: 'GET', path: '/aigc/script/6613' })).resolves.toBeDefined()
    await expect(snapshot.request({ method: 'DELETE', path: '/aigc/storyboard/123' })).rejects.toMatchObject(blocked)
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('keeps the validated route and body across credential lookup without capturing a debug body', async () => {
    vi.stubEnv(mode, '1')
    vi.stubEnv(DEBUG_DUMP_ENV, 'unused-fixture-directory')
    const dump = vi.spyOn(JubianDebugDump, 'fromEnvironment')
    const { client, transport } = fakeClient()
    const body = { aigcVideoTaskId: 456 }
    const request: JubianRequest = { method: 'POST', path: subTasks, body, signal: new AbortController().signal }
    const result = client.request(request)
    request.path = '/aigc/storyboard'
    body.aigcVideoTaskId = 999
    await expect(result).resolves.toBeDefined()
    expect(transport).toHaveBeenCalledWith(JUBIAN_DEFAULT_BASE_URL + subTasks, expect.objectContaining({
      body: JSON.stringify({ aigcVideoTaskId: 456 }),
    }))
    expect(dump).not.toHaveBeenCalled()
  })

  it.each([undefined, '0'])('preserves normal configured-origin writes with opt-in set to %s', async (disabled) => {
    vi.stubEnv(mode, disabled)
    const baseUrl = 'https://ordinary.invalid/prod-api'
    const { client, credential, transport } = fakeClient(baseUrl)
    await expect(client.request({ method: 'PUT', path: '/aigc/storyboard', body: { id: 123 } })).resolves.toBeDefined()
    expect(credential).toHaveBeenCalledOnce()
    expect(transport).toHaveBeenCalledWith(baseUrl + '/aigc/storyboard', expect.objectContaining({ method: 'PUT' }))
  })
})
