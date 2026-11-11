import { describe, expect, it, vi } from 'vitest'
import { JubianClient } from '../src/client.ts'

describe('operation credential snapshots', () => {
  it('fixes one normalized credential in a private closure while preserving the configured transport and origin', async () => {
    let token = ' first-account '
    const credential = vi.fn(async () => token), headers: unknown[] = [], urls: string[] = []
    const client = new JubianClient({ credential, baseUrl: 'http://127.0.0.1:31801/prod-api', fetch: async (input, init) => {
      urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      headers.push(init?.headers)
      return new Response(JSON.stringify({ code: 200, data: null }))
    } })
    const snapshot = await client.snapshotCredential()
    token = 'second-account'
    await snapshot.request({ method: 'GET', path: '/getInfo' })
    await snapshot.request({ method: 'GET', path: '/aigc/script/list' })
    await client.request({ method: 'GET', path: '/getInfo' })
    expect(credential).toHaveBeenCalledTimes(2)
    expect(headers.slice(0, 2)).toEqual(expect.arrayContaining([
      expect.objectContaining({ Authorization: 'Bearer first-account' }),
      expect.objectContaining({ Authorization: 'Bearer first-account' }),
    ]))
    expect(headers[2]).toMatchObject({ Authorization: 'Bearer second-account' })
    expect(urls.every(url => url.startsWith('http://127.0.0.1:31801/prod-api/'))).toBe(true)
    expect(JSON.stringify(snapshot)).not.toMatch(/first-account|second-account/)
  })

  it('retains the original response byte limit', async () => {
    const client = new JubianClient({ credential: async () => 'private-token', maxResponseBytes: 8,
      fetch: async () => new Response(JSON.stringify({ code: 200, data: 'oversized' })) })
    await expect((await client.snapshotCredential()).request({ method: 'GET', path: '/getInfo' }))
      .rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  })

  it('rejects unusable credentials before publishing a snapshot or making a network request', async () => {
    const fetcher = vi.fn<typeof fetch>()
    await expect(new JubianClient({ credential: async () => '', fetch: fetcher }).snapshotCredential())
      .rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' })
    expect(fetcher).not.toHaveBeenCalled()
  })
})
