import { expect, it } from 'vitest'
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
