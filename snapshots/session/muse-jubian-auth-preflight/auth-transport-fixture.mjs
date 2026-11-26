/** Install the synthetic provider before the Jubian client captures fetch. */
import assert from 'node:assert/strict'

export const name = 'auth-transport-fixture'
export const requests = []

/** @param ctx - Shipped Headless profile services. */
export function apply(ctx) {
  ctx.effect(() => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      const method = String(init?.method)
      assert.equal(url.origin, 'https://jubian-auth-preflight.invalid')
      assert.equal(method, 'GET')
      assert.equal(url.pathname + url.search, '/prod-api/aigc/script/list?pageNum=1&pageSize=1')
      const authorization = new Headers(init?.headers).get('authorization')
      assert.equal(authorization, requests.length === 0 ? 'Bearer offline-auth-old' : 'Bearer offline-auth-renewed')
      requests.push(method)
      return requests.length === 1
        ? Response.json({ code: 401, msg: 'private provider message' })
        : Response.json({ code: 200, rows: [{ id: 7, scriptName: 'private project title' }], total: 1 })
    }
    return () => { globalThis.fetch = originalFetch }
  })
}
