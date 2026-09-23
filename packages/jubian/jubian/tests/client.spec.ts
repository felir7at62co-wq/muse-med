import { describe, expect, it, vi } from 'vitest'
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

  it.each([
    [401, 'AUTHENTICATION_REQUIRED', 'Jubian login is unavailable or expired'],
    [403, 'AUTHENTICATION_REQUIRED', 'Jubian login is unavailable or expired'],
    [429, 'RATE_LIMITED', 'Jubian rate limit reached'],
    [502, 'NETWORK_ERROR', 'Jubian request failed'],
  ])('reports HTTP %i without response text or another attempt', async (status, code, message) => {
    let calls = 0
    const response = new Response(`provider secret ${TOKEN}`, { status, statusText: `secret ${TOKEN}` })
    const thrown = await client(async () => { calls++; return response })
      .request({ method: 'PUT', path: `/secret?token=${TOKEN}`, body: { isGenerate: 1 } })
      .catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(JubianError)
    expect(thrown).toMatchObject({ code, message: `${message}: HTTP ${status}` })
    expect((thrown as Error).cause).toBeUndefined()
    expect(response.bodyUsed).toBe(true)
    expect(calls).toBe(1)
  })

  it.each([
    ['ENOTFOUND', 'DNS lookup failed (ENOTFOUND)'],
    ['EAI_AGAIN', 'DNS lookup failed (EAI_AGAIN)'],
    ['ECONNREFUSED', 'connection refused (ECONNREFUSED)'],
    ['ECONNRESET', 'connection reset (ECONNRESET)'],
    ['ETIMEDOUT', 'request timed out (ETIMEDOUT)'],
    ['UND_ERR_CONNECT_TIMEOUT', 'connection timed out (UND_ERR_CONNECT_TIMEOUT)'],
    ['UND_ERR_HEADERS_TIMEOUT', 'response headers timed out (UND_ERR_HEADERS_TIMEOUT)'],
    ['UND_ERR_BODY_TIMEOUT', 'response body timed out (UND_ERR_BODY_TIMEOUT)'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'TLS certificate rejected (ERR_TLS_CERT_ALTNAME_INVALID)'],
    ['CERT_HAS_EXPIRED', 'TLS certificate rejected (CERT_HAS_EXPIRED)'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'TLS certificate rejected (DEPTH_ZERO_SELF_SIGNED_CERT)'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'TLS certificate rejected (UNABLE_TO_VERIFY_LEAF_SIGNATURE)'],
    ['ABORT_ERR', 'request aborted'],
  ])('reports only allowlisted %s for direct and wrapped failures', async (code, detail) => {
    const cause = Object.assign(new Error(`https://secret.invalid/${TOKEN}`), { code, hostname: TOKEN })
    for (const failure of [cause, new TypeError(`fetch ${TOKEN}`, { cause })]) {
      let calls = 0
      const thrown = await client(async () => { calls++; throw failure })
        .request({ method: 'PUT', path: '/x', body: { isGenerate: 1 } }).catch((error: unknown) => error)
      expect(thrown).toBeInstanceOf(JubianError)
      expect(thrown).toMatchObject({ code: 'NETWORK_ERROR', message: `Jubian request failed: ${detail}` })
      expect((thrown as Error).cause).toBeUndefined()
      expect(calls).toBe(1)
    }
  })

  it.each([
    ['TimeoutError', 'request timed out'],
    ['AbortError', 'request aborted'],
  ])('recognizes %s without copying its message', async (name, detail) => {
    const thrown = await client(async () => { throw new DOMException(TOKEN, name) })
      .request({ method: 'GET', path: '/x' }).catch((error: unknown) => error)
    expect(thrown).toMatchObject({ code: 'NETWORK_ERROR', message: `Jubian request failed: ${detail}` })
  })

  it('reports caller cancellation without exposing its arbitrary reason', async () => {
    const signal = AbortSignal.abort({ secret: TOKEN })
    const thrown = await client(async (_url, init) => { init!.signal!.throwIfAborted(); throw new Error('unreachable') })
      .request({ method: 'GET', path: '/x', signal }).catch((error: unknown) => error)
    expect(thrown).toMatchObject({ code: 'NETWORK_ERROR', message: 'Jubian request failed: request aborted' })
    expect((thrown as Error).cause).toBeUndefined()
  })

  it.each(['fetch', 'body'])('reports the client deadline during %s without copying its reason', async (phase) => {
    const deadline = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    try {
      let calls = 0
      const subject = client(async (_url, init) => {
        calls++
        deadline.abort(TOKEN)
        if (phase === 'fetch') init!.signal!.throwIfAborted()
        return new Response(new ReadableStream({ start(controller) { controller.error(TOKEN) } }))
      })
      await expect(subject.request({ method: 'GET', path: '/x' })).rejects.toMatchObject({
        code: 'NETWORK_ERROR', message: 'Jubian request failed: request timed out',
      })
      expect(calls).toBe(1)
    } finally { timeout.mockRestore() }
  })

  it('retains caller cancellation when the deadline also expires before rejection', async () => {
    const caller = new AbortController()
    const deadline = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    try {
      const subject = client(async (_url, init) => {
        caller.abort(TOKEN)
        deadline.abort(new Error(TOKEN))
        init!.signal!.throwIfAborted()
        throw new Error('unreachable')
      })
      await expect(subject.request({ method: 'GET', path: '/x', signal: caller.signal })).rejects.toMatchObject({
        code: 'NETWORK_ERROR', message: 'Jubian request failed: request aborted',
      })
    } finally { timeout.mockRestore() }
  })

  it('classifies response-body transport failures without another request', async () => {
    let calls = 0
    const subject = client(async () => {
      calls++
      return new Response(new ReadableStream({ start(controller) {
        controller.error(new TypeError(TOKEN, { cause: { code: 'ECONNRESET', message: TOKEN } }))
      } }))
    })
    await expect(subject.request({ method: 'GET', path: '/x' })).rejects.toMatchObject({
      code: 'NETWORK_ERROR', message: 'Jubian request failed: connection reset (ECONNRESET)',
    })
    expect(calls).toBe(1)
  })

  it.each([
    undefined, null, 'secret',
    { name: TOKEN, code: TOKEN, message: TOKEN, cause: { code: TOKEN, message: TOKEN } },
    { code: 'ENOTFOUND secret', cause: { code: { toString: (): string => TOKEN } } },
    { code: 'toString', cause: { code: '__proto__' } },
    { cause: { cause: { code: 'ENOTFOUND', message: TOKEN } } },
  ])('keeps unknown failures opaque, including nested secrets (%j)', async (failure) => {
    const thrown = await client(async () => { throw failure })
      .request({ method: 'GET', path: '/x' }).catch((error: unknown) => error)
    expect(thrown).toMatchObject({ name: 'JubianError', code: 'NETWORK_ERROR', message: 'Jubian request failed' })
    expect((thrown as Error).cause).toBeUndefined()
    expect(JSON.stringify(thrown)).not.toContain(TOKEN)
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
