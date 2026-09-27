import { describe, expect, it } from 'vitest'
import { JubianClient } from '../src/client.ts'
import { JubianError } from '../src/error.ts'

const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function client(fetchImpl: typeof fetch): JubianClient {
  return new JubianClient({ credential: async () => TOKEN, fetch: fetchImpl })
}

/** One payload as a reader would receive it, under each layout the transport accepts. */
const PAYLOAD = { id: 7, name: '镜21-33-r2' }

describe('JubianClient response layouts', () => {
  it('reads the documented object envelope and hands its data to the reader', async () => {
    const result = await client(async () => jsonResponse({ code: 200, msg: '操作成功', data: PAYLOAD }))
      .request({ method: 'GET', path: '/one' })
    expect(result.data).toEqual(PAYLOAD)
    expect(result.envelope_layout).toBe('object-data')
    expect(result.transport).toEqual({ http_status: 200, application_code: 200 })
  })

  it('reads the flat list envelope that carries no data field', async () => {
    const result = await client(async () => jsonResponse({ code: 200, total: 2, rows: [PAYLOAD], msg: '操作成功' }))
      .request({ method: 'GET', path: '/list' })
    expect(result.data).toEqual({ code: 200, total: 2, rows: [PAYLOAD] })
    expect(result.envelope_layout).toBe('object-flat')
  })

  it('unwraps one envelope that arrived inside a one-element array', async () => {
    const result = await client(async () => jsonResponse([{ code: 200, msg: '操作成功', data: PAYLOAD }]))
      .request({ method: 'GET', path: '/one' })
    expect(result.data).toEqual(PAYLOAD)
    expect(result.envelope_layout).toBe('array-envelope')
    expect(result.transport).toEqual({ http_status: 200, application_code: 200 })
  })

  it('treats a one-element array of a payload object as that payload', async () => {
    const result = await client(async () => jsonResponse([PAYLOAD])).request({ method: 'GET', path: '/one' })
    expect(result.data).toEqual(PAYLOAD)
    expect(result.envelope_layout).toBe('array-single')
    expect(result.transport).toEqual({ http_status: 200, application_code: null })
  })

  it('hands a multi-element array to the reader and records that no code was read', async () => {
    const result = await client(async () => jsonResponse([PAYLOAD, { id: 8 }])).request({ method: 'GET', path: '/one' })
    expect(result.data).toEqual([PAYLOAD, { id: 8 }])
    expect(result.envelope_layout).toBe('array-payload')
    expect(result.transport).toEqual({ http_status: 200, application_code: null })
  })

  it('unwraps a payload that is itself a success envelope', async () => {
    const result = await client(async () => jsonResponse({ code: 200, data: { code: 0, data: PAYLOAD } }))
      .request({ method: 'GET', path: '/one' })
    expect(result.data).toEqual(PAYLOAD)
    expect(result.envelope_layout).toBe('nested-envelope')
  })

  it('keeps a payload that merely carries an integer code of its own', async () => {
    const business = { code: 500, data: 'a business field pair, not an envelope' }
    const result = await client(async () => jsonResponse({ code: 200, data: business }))
      .request({ method: 'GET', path: '/one' })
    expect(result.data).toEqual(business)
    expect(result.envelope_layout).toBe('object-data')
  })
})

describe('JubianClient unreadable-response diagnostics', () => {
  it('names the top-level type of a body that is not an object envelope', async () => {
    const thrown = await client(async () => jsonResponse('a string payload'))
      .request({ method: 'GET', path: '/one' }).catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(JubianError)
    expect((thrown as JubianError).code).toBe('CONTRACT_CHANGED')
    expect((thrown as Error).message).toContain('top-level string of 16 characters')
  })

  it('lists the keys and lengths of an envelope that carries no integer code', async () => {
    const thrown = await client(async () => jsonResponse({ code: 'nope', total: 3, rows: [PAYLOAD] }))
      .request({ method: 'GET', path: '/one' }).catch((error: unknown) => error)
    expect((thrown as Error).message).toContain('envelope carries no integer code')
    expect((thrown as Error).message).toContain('top-level object with 3 keys [code, total, rows]')
  })

  it('describes a body that is not JSON without reproducing what it held', async () => {
    const thrown = await client(async () => new Response(`gateway said no: ${TOKEN}`, { status: 200 }))
      .request({ method: 'GET', path: '/one' }).catch((error: unknown) => error)
    expect((thrown as Error).message).toContain('body is not JSON')
    expect((thrown as Error).message).toContain('excerpt')
    expect((thrown as Error).message).not.toContain(TOKEN)
  })

  it('describes an undecodable body by length and hex prefix', async () => {
    const thrown = await client(async () => new Response(new Uint8Array([0xff, 0xfe, 0x00, 0x41]), { status: 200 }))
      .request({ method: 'GET', path: '/one' }).catch((error: unknown) => error)
    expect((thrown as Error).message).toContain('body is not strict UTF-8: 4 bytes, first 16 bytes hex ff fe 00 41')
  })

  it('keeps a credential-named field out of the description of a rejected payload', async () => {
    const thrown = await client(async () => jsonResponse({ code: 'nope', accessToken: TOKEN, videoUrl:
      `https://cdn.example.com/a/b.mp4?X-Amz-Signature=${TOKEN}` }))
      .request({ method: 'GET', path: '/one' }).catch((error: unknown) => error)
    const message = (thrown as Error).message
    expect(message).toContain('accessToken')
    expect(message).not.toContain(TOKEN)
    expect(message).toContain('"accessToken":"[redacted]"')
    expect(message).toContain('https://cdn.example.com/…')
  })

  it('names an unmapped envelope code with the structure it came with', async () => {
    const thrown = await client(async () => jsonResponse({ code: 900, msg: 'unknown', data: PAYLOAD }))
      .request({ method: 'GET', path: '/one' }).catch((error: unknown) => error)
    expect((thrown as Error).message).toContain('unmapped envelope code 900, top-level object with 3 keys [code, msg, data]')
  })

  it('names the byte cap it enforced instead of only the envelope', async () => {
    const subject = new JubianClient({ credential: async () => TOKEN, maxResponseBytes: 512,
      fetch: async () => jsonResponse({ code: 200, data: 'x'.repeat(4096) }) })
    await expect(subject.request({ method: 'GET', path: '/x' })).rejects
      .toThrow('Jubian response did not match the expected envelope: response body exceeded the 512-byte cap')
  })
})
