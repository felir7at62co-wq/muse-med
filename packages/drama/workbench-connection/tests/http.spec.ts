import { expect, it } from 'vitest'
import { boundedBytes, requestJson, workbenchOrigin, WorkbenchHttpError } from '../src/http.ts'
import { workbench } from './fixture.ts'

const label = { name: '剧本工坊', code: 'WORKSHOP' }

it('accepts HTTPS or loopback origins with an optional gateway mount and nothing else', () => {
  expect(workbenchOrigin('https://scripts.example/', 'jubengongfang', label)).toBe('https://scripts.example')
  expect(workbenchOrigin('https://muse.example/jubengongfang/', 'jubengongfang', label)).toBe('https://muse.example/jubengongfang')
  expect(workbenchOrigin('http://[::1]:18796', 'jubengongfang', label)).toBe('http://[::1]:18796')
  for (const value of ['http://scripts.example', 'https://user@scripts.example', 'https://muse.example/jingliu', 'https://scripts.example/?a=1']) {
    expect(() => workbenchOrigin(value, 'jubengongfang', label)).toThrow(expect.objectContaining({
      code: 'WORKSHOP_ORIGIN_INVALID', message: '剧本工坊地址必须是 HTTPS 站点或本机回环地址。',
    }))
  }
})

it('sends JSON below the API root and keeps the service error code, its text detail or a named fallback', async () => {
  const { origin, requests } = await workbench((req) => {
    switch (req.url) {
      case '/v1/ok': return [200, { ok: true }]
      case '/v1/coded': return [409, { detail: { code: 'needs_confirm', message: '确认替换？' } }]
      case '/v1/text': return [400, { detail: '同时转写部数必须是 1 到 4' }]
      case '/v1/plain': return [502, 'gateway down']
      case '/v1/list': return [400, ['detail']]
      default: return [500, {}]
    }
  })
  const base = origin + '/v1'
  expect(await requestJson(label, base, '/ok', 1000, { method: 'POST', body: { count: 0 }, headers: { authorization: 'Bearer t' } })).toEqual({ ok: true })
  expect(requests[0]).toMatchObject({ method: 'POST', body: '{"count":0}', authorization: 'Bearer t' })
  await expect(requestJson(label, base, '/coded', 1000)).rejects.toMatchObject({ status: 409, code: 'needs_confirm', message: '确认替换？' })
  await expect(requestJson(label, base, '/text', 1000)).rejects.toMatchObject({ status: 400, code: 'WORKSHOP_HTTP_ERROR', message: '同时转写部数必须是 1 到 4' })
  await expect(requestJson(label, base, '/other', 1000)).rejects.toMatchObject({ status: 500, code: 'WORKSHOP_HTTP_ERROR', message: '剧本工坊请求失败。' })
  await expect(requestJson(label, base, '/list', 1000)).rejects.toMatchObject({ status: 400, code: 'WORKSHOP_HTTP_ERROR', message: '剧本工坊请求失败。' })
  await expect(requestJson(label, base, '/plain', 1000)).rejects.toMatchObject({ status: 502, code: 'WORKSHOP_INVALID_RESPONSE', message: '剧本工坊未返回 JSON（HTTP 502）。' })
  await expect(requestJson(label, base, '/ok', 1000, { signal: AbortSignal.abort() })).rejects.toThrow()
  expect(requests).toHaveLength(6)
  const rejected = await requestJson(label, base, '/coded', 1000).catch((error: unknown) => error)
  expect(rejected).toBeInstanceOf(WorkbenchHttpError)
})

it.each(['ok', '//other.example/v1/ok', '/../admin', '/%2e%2e/admin', '/a\\b', '/ok#part'])('refuses the route %s outside the API root before sending', async (path) => {
  const { origin, requests } = await workbench(() => [200, {}])
  await expect(requestJson(label, origin + '/v1', path, 1000)).rejects.toMatchObject({ code: 'WORKSHOP_PATH_INVALID', message: '剧本工坊请求路径无效。' })
  expect(requests).toHaveLength(0)
})

it('reads a body up to its limit and refuses a larger one', async () => {
  expect((await boundedBytes(new Response('12345'), 5, label)).toString()).toBe('12345')
  expect((await boundedBytes(new Response(null), 5, label)).byteLength).toBe(0)
  await expect(boundedBytes(new Response('123456'), 5, label)).rejects.toMatchObject({
    code: 'WORKSHOP_RESPONSE_LIMIT', message: '剧本工坊响应太大，请缩小查询范围。',
  })
})
