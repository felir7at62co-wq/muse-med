/** Authentication checks use the current credential and one free, read-only request. */
import { expect, it, vi } from 'vitest'
import { JubianClient } from '@deepseek-ai/dsh-jubian'
import { catalogMethod } from '../src/methods.ts'

it('uses a renewed credential on the same client and discards private project data', async () => {
  let token = 'expired-fixture'
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    expect(init?.method).toBe('GET')
    expect(init?.body).toBeUndefined()
    if (new Headers(init?.headers).get('authorization') === 'Bearer expired-fixture') {
      return new Response(JSON.stringify({ code: 401, msg: 'private provider text' }))
    }
    return new Response(JSON.stringify({ code: 200, rows: [{ id: 7, scriptName: 'private title' }], total: 1 }))
  })
  const client = new JubianClient({ credential: async () => token, fetch: transport })
  await expect(catalogMethod(client, { method: 'auth' })).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' })
  token = 'renewed-fixture'
  const outcome = await catalogMethod(client, { method: 'auth' })
  expect(outcome).toMatchObject({ authentication: {
    status: 'read_access_confirmed', generation_submitted: false, http_status: 200, application_code: 200,
  } })
  expect(JSON.stringify(outcome)).not.toMatch(/private title|expired-fixture|renewed-fixture|private provider/)
  expect(transport).toHaveBeenCalledTimes(2)
  expect(transport.mock.calls.every(([url]) => (url instanceof Request ? url.url : url.toString())
    .endsWith('/aigc/script/list?pageNum=1&pageSize=1'))).toBe(true)
})

it.each([
  [401, 'AUTHENTICATION_REQUIRED'], [403, 'PERMISSION_DENIED'], [429, 'RATE_LIMITED'], [502, 'NETWORK_ERROR'],
])('reports HTTP %i without claiming every failure is an expired login', async (status, code) => {
  const transport = vi.fn<typeof fetch>(async () => new Response('private remote text', { status }))
  const client = new JubianClient({ credential: async () => 'fixture', fetch: transport })
  await expect(catalogMethod(client, { method: 'auth' })).rejects.toMatchObject({ code, detail: `HTTP ${status}` })
  expect(transport).toHaveBeenCalledTimes(1)
})

it.each([
  ['', 'credential_not_configured'], ['invalid whitespace', 'credential_invalid_format'],
])('distinguishes local credential failures without contacting the provider', async (value, reason) => {
  const transport = vi.fn<typeof fetch>()
  const client = new JubianClient({ credential: async () => value, fetch: transport })
  const detail: unknown = expect.stringContaining(reason)
  await expect(catalogMethod(client, { method: 'auth' })).rejects.toMatchObject({
    code: 'AUTHENTICATION_REQUIRED', detail,
  })
  expect(transport).not.toHaveBeenCalled()
})

it('keeps a credential-store failure private and distinct from a remote rejection', async () => {
  const transport = vi.fn<typeof fetch>()
  const client = new JubianClient({ credential: async () => { throw Error('private credential value') }, fetch: transport })
  const error: unknown = await catalogMethod(client, { method: 'auth' }).catch((failure: unknown) => failure)
  const detail: unknown = expect.stringContaining('credential_resolution_failed')
  expect(error).toMatchObject({ code: 'AUTHENTICATION_REQUIRED', detail })
  expect(String(error)).not.toContain('private credential value')
  expect(transport).not.toHaveBeenCalled()
})

it.each([{ code: 200, data: {} }, { code: 200, rows: 'not-a-list', total: 0 }])(
  'rejects an unreadable success response rather than certifying login', async (response) => {
    const transport = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(response)))
    const client = new JubianClient({ credential: async () => 'fixture', fetch: transport })
    await expect(catalogMethod(client, { method: 'auth' })).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
    expect(transport).toHaveBeenCalledTimes(1)
  },
)

it('propagates an unexpected local failure without inventing an authentication result', async () => {
  const client = new JubianClient({ credential: async () => 'fixture' })
  const failure = new Error('Connection check stopped locally')
  vi.spyOn(client, 'request').mockRejectedValueOnce(failure)
  await expect(catalogMethod(client, { method: 'auth' })).rejects.toBe(failure)
})

it('keeps a late old-token rejection from changing the renewed credential or its successful check', async () => {
  let token = 'expired-fixture'
  let answerOld: ((response: Response) => void) | undefined
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    if (new Headers(init?.headers).get('authorization') === 'Bearer expired-fixture') {
      return new Promise<Response>((resolve) => { answerOld = resolve })
    }
    return new Response(JSON.stringify({ code: 200, rows: [], total: 0 }))
  })
  const client = new JubianClient({ credential: async () => token, fetch: transport })
  const old = catalogMethod(client, { method: 'auth' }).catch((error: unknown) => error)
  await vi.waitFor(() => { expect(answerOld).toBeDefined() })
  token = 'renewed-fixture'
  await expect(catalogMethod(client, { method: 'auth' })).resolves.toMatchObject({ authentication: { status: 'read_access_confirmed' } })
  answerOld!(new Response(JSON.stringify({ code: 401 })))
  expect(await old).toMatchObject({ code: 'AUTHENTICATION_REQUIRED' })
  expect(token).toBe('renewed-fixture')
  await expect(catalogMethod(client, { method: 'auth' })).resolves.toMatchObject({ authentication: { status: 'read_access_confirmed' } })
  expect(transport).toHaveBeenCalledTimes(3)
})
