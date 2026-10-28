// Muse adaptation: exercise the shipped Bot client through the Desktop's authenticated carrier.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { forwardWebRequest } from '../../../../apps/desktop/src/web-document.ts'
import { call } from '../src/client/api.js'

async function withCarrier(run) {
  const nativeFetch = globalThis.fetch
  const received = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    received.push({ path: request.url, cookie: request.headers.cookie, body: JSON.parse(body) })
    if (request.headers.cookie !== 'muse-test=owned') { response.writeHead(401).end(); return }
    const value = JSON.parse(body)
    response.setHeader('content-type', 'application/json')
    if (value.endpoint === 'refused') {
      response.end(JSON.stringify({ ok: false, error: { code: 'bot/refused', message: 'Synthetic refusal' } }))
    } else {
      response.setHeader('set-cookie', 'must-not-reach-renderer=1')
      response.end(JSON.stringify({ ok: true, value: { bots: [{ name: 'Muse Bot' }], payload: value.payload } }))
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  globalThis.fetch = (input, init) => typeof input === 'string' && input === 'api/bot'
    ? forwardWebRequest(new Request(new URL(input, 'dsh-app://app/'), {
      ...init, headers: { ...init?.headers, origin: 'dsh-app://app', cookie: 'renderer-cannot-supply-auth=1' },
    }), origin, 'muse-test=owned')
    : nativeFetch(input, init)
  try { await run(received) }
  finally {
    globalThis.fetch = nativeFetch
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}

test('Bot client uses the existing Desktop carrier without another login or listener', async () => {
  await withCarrier(async received => {
    const result = await call('state', { revision: 0 })
    assert.equal(result.bots[0].name, 'Muse Bot')
    assert.deepEqual(received, [{ path: '/api/bot', cookie: 'muse-test=owned',
      body: { endpoint: 'state', payload: { revision: 0 } } }])
  })
})

test('Bot client retains structured Host refusal through the Desktop carrier', async () => {
  await withCarrier(async () => {
    await assert.rejects(call('refused', {}), error => error.code === 'bot/refused' && error.message === 'Synthetic refusal')
  })
})

test('an aborted Bot request never reaches the Host', async () => {
  await withCarrier(async received => {
    const cancel = new AbortController()
    cancel.abort()
    await assert.rejects(call('state', {}, cancel.signal), error => error.name === 'AbortError')
    assert.equal(received.length, 0)
  })
})
