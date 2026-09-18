import { describe, expect, it } from 'vitest'
import { JubianClient } from '../src/client.ts'
import { JubianError } from '../src/error.ts'

const TOKEN = 'eyJhbGci.payload.sig'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function client(fetchImpl: typeof fetch, credential = async () => TOKEN) {
  return new JubianClient({ credential, fetch: fetchImpl })
}

describe('JubianClient.request', () => {
  it('sends one fixed-origin request with the repaired bearer token', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const subject = client(async (url, init) => {
      calls.push({ url: (url as URL).toString(), init: init ?? {} })
      return jsonResponse({ code: 200, data: [{ id: 1 }] })
    }, async () => `  ${TOKEN};  `)
    const result = await subject.request({ method: 'GET', path: '/model/charge/getSelectList?taskType=2' })
    expect(calls.length).toBe(1)
    expect(calls[0]!.url).toBe('https://web.jubianai.net/prod-api/model/charge/getSelectList?taskType=2')
    expect(calls[0]!.init.method).toBe('GET')
    expect(calls[0]!.init.redirect).toBe('error')
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
    expect(result.data).toEqual([{ id: 1 }])
    expect(result.transport).toEqual({ http_status: 200, application_code: 200 })
    expect(result.response_sha256).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  it('accepts both success codes and rejects everything else in the envelope', async () => {
    await expect(client(async () => jsonResponse({ code: 0, data: 'ok' })).request({ method: 'GET', path: '/x' }))
      .resolves.toMatchObject({ data: 'ok' })
    await expect(client(async () => jsonResponse({ code: 403, msg: 'no' })).request({ method: 'GET', path: '/x' }))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    await expect(client(async () => jsonResponse({ code: 500, msg: 'boom' })).request({ method: 'GET', path: '/x' }))
      .rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  })

  it('hands a flat envelope to the reader instead of the undefined data field it lacks', async () => {
    // The provider's list endpoints answer `{ code, total, rows }` with no
    // `data`, so returning `envelope.data` there would be `undefined` and every
    // reader would reject it.
    const flat = { code: 200, total: 2, rows: [{ id: 1 }], msg: '操作成功' }
    const result = await client(async () => jsonResponse(flat)).request({ method: 'GET', path: '/list' })
    expect(result.data).toEqual({ code: 200, total: 2, rows: [{ id: 1 }] })
  })

  it('keeps a nested payload untouched and never rewrites it into the flat shape', async () => {
    const nested = { code: 200, msg: '操作成功', data: { id: 2708, scriptName: 'x' } }
    const result = await client(async () => jsonResponse(nested)).request({ method: 'GET', path: '/one' })
    expect(result.data).toEqual({ id: 2708, scriptName: 'x' })
  })

  it('maps transport failures without leaking the provider body', async () => {
    await expect(client(async () => jsonResponse({ msg: 'expired' }, 401)).request({ method: 'GET', path: '/x' }))
      .rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' })
    await expect(client(async () => jsonResponse({ msg: 'slow down' }, 429)).request({ method: 'GET', path: '/x' }))
      .rejects.toMatchObject({ code: 'RATE_LIMITED' })
    await expect(client(async () => jsonResponse({ msg: 'oops' }, 500)).request({ method: 'GET', path: '/x' }))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    const thrown = await client(async () => { throw new Error('socket hang up') })
      .request({ method: 'GET', path: '/x' }).catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(JubianError)
    expect((thrown as JubianError).message).not.toContain('socket hang up')
  })

  it('fails locally on an unusable token without issuing a request', async () => {
    let called = false
    const subject = client(async () => { called = true; return jsonResponse({ code: 200, data: null }) },
      async () => 'has interior space')
    await expect(subject.request({ method: 'GET', path: '/x' }))
      .rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' })
    expect(called).toBe(false)
  })

  it('rejects a non-JSON or non-object body as a contract change', async () => {
    await expect(client(async () => new Response('not json', { status: 200 })).request({ method: 'GET', path: '/x' }))
      .rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
    await expect(client(async () => jsonResponse([1, 2, 3])).request({ method: 'GET', path: '/x' }))
      .rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  })

  it('bounds the response body by byte length', async () => {
    const huge = { code: 200, data: 'x'.repeat(4096) }
    const subject = new JubianClient({ credential: async () => TOKEN, fetch: async () => jsonResponse(huge),
      maxResponseBytes: 512 })
    await expect(subject.request({ method: 'GET', path: '/x' })).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  })

  it('sends a JSON body only when one is given', async () => {
    const seen: RequestInit[] = []
    const subject = client(async (_url, init) => { seen.push(init ?? {}); return jsonResponse({ code: 200, data: 1 }) })
    await subject.request({ method: 'PUT', path: '/aigc/storyboard', body: { isGenerate: 0 } })
    expect(seen[0]!.method).toBe('PUT')
    expect(seen[0]!.body).toBe('{"isGenerate":0}')
    expect((seen[0]!.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })
})
