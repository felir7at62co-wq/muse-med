import { describe, expect, it } from 'vitest'
import { callStation, readJson, type Fetch, type StationSettings } from '../src/station.ts'

const SETTINGS: StationSettings = { baseUrl: 'http://127.0.0.1:19617/api/service/hits', requestTimeoutMs: 5_000, maxResponseBytes: 64 }

function recorder(respond: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, init })
    return respond()
  }
  return { fetch, calls }
}

function signal(): AbortSignal {
  return new AbortController().signal
}

describe('callStation', () => {
  it('sends JSON with the station token header and returns the parsed body', async () => {
    const station = recorder(() => new Response('{"job":null,"lease":null}'))
    await expect(callStation(station.fetch, SETTINGS, 'secret-token', { method: 'POST', path: '/claim', json: { workerId: 'w' } }, signal()))
      .resolves.toEqual({ job: null, lease: null })
    const [call] = station.calls
    expect(call?.url).toBe('http://127.0.0.1:19617/api/service/hits/claim')
    expect(call?.init).toMatchObject({ method: 'POST', redirect: 'error', body: '{"workerId":"w"}',
      headers: { 'X-Muse-Data-Service-Token': 'secret-token', Accept: 'application/json', 'Content-Type': 'application/json' } })
  })

  it('passes multipart bodies through and sends no body for GET', async () => {
    const station = recorder(() => new Response(''))
    const form = new FormData()
    form.set('lease', 'l')
    await expect(callStation(station.fetch, SETTINGS, 't', { method: 'POST', path: '/jobs/1/script', form }, signal())).resolves.toBeNull()
    await callStation(station.fetch, SETTINGS, 't', { method: 'GET', path: '/jobs/1' }, signal())
    expect(station.calls[0]?.init.body).toBe(form)
    expect(station.calls[0]?.init.headers).not.toHaveProperty('Content-Type')
    expect(station.calls[1]?.init.body).toBeUndefined()
  })

  it.each([
    [401, 'HIT_QUEUE_UNAUTHORIZED'],
    [404, 'HIT_QUEUE_NOT_FOUND'],
    [409, 'HIT_QUEUE_CONFLICT'],
    [422, 'HIT_QUEUE_REJECTED'],
    [503, 'HIT_QUEUE_FAILED'],
  ])('maps HTTP %i to %s with the station message', async (status, code) => {
    const station = recorder(() => new Response(JSON.stringify({ error: '租约失效' }), { status }))
    await expect(callStation(station.fetch, SETTINGS, 't', { method: 'GET', path: '/jobs/1' }, signal()))
      .rejects.toMatchObject({ code, message: `数据站返回 ${status}：租约失效` })
  })

  it('keeps the status when an error body has no station message', async () => {
    for (const body of ['<html>bad gateway</html>', '"text"', '{"error":1}']) {
      const station = recorder(() => new Response(body, { status: 502 }))
      await expect(callStation(station.fetch, SETTINGS, 't', { method: 'GET', path: '/x' }, signal())).rejects.toThrow('数据站返回 502：无说明')
    }
  })

  it('reports an unreachable station and keeps caller cancellation', async () => {
    const failing = recorder(() => Promise.reject(new TypeError('fetch failed')))
    await expect(callStation(failing.fetch, SETTINGS, 't', { method: 'GET', path: '/x' }, signal())).rejects.toMatchObject({ code: 'HIT_QUEUE_UNAVAILABLE' })
    const controller = new AbortController()
    controller.abort(new Error('stopped'))
    await expect(callStation(failing.fetch, SETTINGS, 't', { method: 'GET', path: '/x' }, controller.signal)).rejects.toThrow('stopped')
  })
})

describe('readJson', () => {
  it('bounds declared and actual sizes and rejects non-JSON bodies', async () => {
    await expect(readJson(new Response('{}', { headers: { 'content-length': '100' } }), 64)).rejects.toMatchObject({ code: 'HIT_QUEUE_RESPONSE_TOO_LARGE' })
    await expect(readJson(new Response('x'.repeat(65)), 64)).rejects.toMatchObject({ code: 'HIT_QUEUE_RESPONSE_TOO_LARGE' })
    await expect(readJson(new Response('not json'), 64)).rejects.toMatchObject({ code: 'HIT_QUEUE_FAILED', message: '响应不是 JSON' })
    await expect(readJson(new Response('  '), 64)).resolves.toBeNull()
  })
})
