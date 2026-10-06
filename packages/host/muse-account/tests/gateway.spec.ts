import { expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createMuseAccountGateway, museGatewayOrigin } from '../src/gateway.ts'

it('refuses a remote HTTP gateway before any password can be sent', () => {
  expect(() => museGatewayOrigin('http://muse.example')).toThrow(/HTTPS or loopback HTTP/)
  expect(museGatewayOrigin('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000')
})

it('classifies both conflict and legacy bad-request username collisions', async () => {
  for (const [status, body] of [
    [409, 'conflict'],
    [400, '\u7528\u6237\u540d\u5df2\u88ab\u4f7f\u7528'],
  ] as const) {
    const gateway = createMuseAccountGateway('https://muse.example', 15_000, async () => new Response(body, { status }))
    await expect(gateway.register('writer', 'secret')).rejects.toMatchObject({ code: 'username-taken' })
  }
})

it('selects the account cookie when the gateway sends other cookies first', async () => {
  const headers = new Headers()
  headers.append('set-cookie', 'theme=dark; Path=/')
  headers.append('set-cookie', '__Host-muse=account-cookie; Secure; Path=/; HttpOnly')
  const gateway = createMuseAccountGateway('https://muse.example', 15_000, async () => new Response(null, { status: 303, headers }))

  await expect(gateway.signIn('writer', 'secret')).resolves.toBe('__Host-muse=account-cookie')
})

it.each(['invalid', 'ftp://localhost', 'https://user:password@muse.example', 'https://muse.example/path',
  'https://muse.example/?query=1', 'https://muse.example/#fragment'])(
  'rejects a non-origin account gateway before dispatching credentials (%s)', (origin) => {
    expect(() => museGatewayOrigin(origin)).toThrow()
  },
)

it('accepts HTTP only for the documented loopback hostname and IPv6 origins', () => {
  expect(museGatewayOrigin('http://localhost:3000')).toBe('http://localhost:3000')
  expect(museGatewayOrigin('http://[::1]:3000')).toBe('http://[::1]:3000')
})

it.each([[401, 'invalid-credentials'], [429, 'rate-limited'], [500, 'gateway-rejected']] as const)(
  'classifies login response %s without exposing the body', async (status, code) => {
    const gateway = createMuseAccountGateway('https://muse.example', 1000, async () => new Response('PRIVATE_BODY', { status }))
    await expect(gateway.signIn('writer', 'password')).rejects.toMatchObject({ code })
  },
)

it.each([[429, 'rate-limited'], [403, 'registration-disabled']] as const)(
  'classifies registration response %s without retrying login', async (status, code) => {
    const gateway = createMuseAccountGateway('https://muse.example', 1000, async () => new Response('PRIVATE_BODY', { status }))
    await expect(gateway.register('writer', 'password')).rejects.toMatchObject({ code })
  },
)

it.each([undefined, '__Host-muse=', '__Host-muse=bad value'])(
  'refuses redirect success without a usable account cookie (%s)', async (cookie) => {
    const gateway = createMuseAccountGateway('https://muse.example', 1000, async () => new Response(null,
      { status: 303, headers: cookie === undefined ? {} : { 'set-cookie': cookie } }))
    await expect(gateway.register('writer', 'password')).rejects.toMatchObject({ code: 'gateway-rejected' })
  },
)

it.each(['unrelated registration failure', 'unreadable'])(
  'rejects a bad-request response that does not establish a username collision (%s)', async (body) => {
    const response = body === 'unreadable' ? new Response(new ReadableStream({ start(controller) { controller.error(new Error('private body')) } }), { status: 400 })
      : new Response(body, { status: 400 })
    const gateway = createMuseAccountGateway('https://muse.example', 1000, async () => response)
    await expect(gateway.register('writer', 'password')).rejects.toMatchObject({ code: 'gateway-rejected' })
  },
)

it.each([303, 401, 403])('refuses unauthenticated or rejected identity responses (%s)', async (status) => {
  const gateway = createMuseAccountGateway('https://muse.example', 1000, async () => new Response('private', { status }))
  await expect(gateway.identity('__Host-muse=private')).rejects.toMatchObject({
    code: status === 403 ? 'gateway-rejected' : 'invalid-credentials',
  })
})

it.each(['not-json', 'null', '[]', '7', '{}', '{"username":false}', '{"username":""}'])(
  'refuses malformed gateway identity data (%s)', async (body) => {
    const gateway = createMuseAccountGateway('https://muse.example', 1000, async () => new Response(body))
    await expect(gateway.identity('__Host-muse=private')).rejects.toMatchObject({ code: 'gateway-rejected' })
  },
)

it('returns only the approved account identity fields and treats network failures as unavailable', async () => {
  const gateway = createMuseAccountGateway('https://muse.example', 1000, async () => Response.json({
    username: 'writer', environment: 'production', workspaceLabel: 'Studio', token: 'PRIVATE_VALUE',
  }))
  expect(await gateway.identity('__Host-muse=private')).toEqual({ username: 'writer', environment: 'production', workspaceLabel: 'Studio' })
  const minimal = createMuseAccountGateway('https://muse.example', 1000, async () => Response.json({ username: 'writer' }))
  expect(await minimal.identity('__Host-muse=private')).toEqual({ username: 'writer' })
  const failing = createMuseAccountGateway('https://muse.example', 1000, async () => { throw new Error('PRIVATE_TRANSPORT') })
  await expect(failing.identity('__Host-muse=private')).rejects.toMatchObject({ code: 'gateway-unavailable', message: 'MUSE account gateway: gateway-unavailable' })
})

it.each([200, 303, 500])('accepts successful logout responses and rejects server failures (%s)', async (status) => {
  const gateway = createMuseAccountGateway('https://muse.example', 1000, async () => new Response(null, { status }))
  if (status === 500) await expect(gateway.signOut('__Host-muse=private')).rejects.toMatchObject({ code: 'gateway-rejected' })
  else await expect(gateway.signOut('__Host-muse=private')).resolves.toBeUndefined()
})

it('dispatches account credentials only in POST bodies through the default Node transport', async () => {
  const requests: Array<{ path: string | undefined; body: string; cookie: string | undefined; origin: string | undefined }> = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      requests.push({ path: request.url, body: Buffer.concat(chunks).toString('utf8'), cookie: request.headers.cookie, origin: request.headers.origin })
      response.writeHead(303, { 'set-cookie': '__Host-muse=fixture; Secure; Path=/; HttpOnly' }); response.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const gateway = createMuseAccountGateway(origin, 1000)
    expect(await gateway.signIn('writer', 'private-password')).toBe('__Host-muse=fixture')
    expect(await gateway.register('writer', 'private-password')).toBe('__Host-muse=fixture')
    await gateway.signOut('__Host-muse=fixture')
    expect(requests).toEqual([
      { path: '/login', body: 'username=writer&password=private-password', cookie: undefined, origin },
      { path: '/register', body: 'username=writer&password=private-password', cookie: undefined, origin },
      { path: '/logout', body: '', cookie: '__Host-muse=fixture', origin },
    ])
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve() })
    })
  }
})
