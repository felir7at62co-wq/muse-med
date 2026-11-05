/** Opt-in company MCP acceptance through the SDK shipped with dsh-mcp-client; no platform content calls. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

const sdkRequire = createRequire(new URL('../../../packages/mcp/mcp-client/package.json', import.meta.url))
const { Client, StreamableHTTPClientTransport } = sdkRequire('@modelcontextprotocol/client')
const { ProxyAgent } = createRequire(new URL('../../../package.json', import.meta.url))('undici')
const sessionFile = process.env.MUSE_MEDIA_SESSION_FILE
const expectedTools = [
  'download_media', 'get_content_history', 'get_task_result', 'get_user',
  'get_video', 'list_comments', 'list_user_posts', 'parse_url',
]

test('company MCP negotiates with the shipped SDK and protects unknown jobs', {
  skip: sessionFile ? false : 'Set MUSE_MEDIA_SESSION_FILE to an authorized Muse session file.',
  timeout: 90_000,
}, async () => {
  const session = JSON.parse(await readFile(sessionFile, 'utf8'))
  const origin = new URL(session.baseUrl).origin
  assert.equal(origin, process.env.MUSE_MEDIA_TEST_ORIGIN ?? 'https://muse.aigc-pipeline.cn')
  assert.equal(typeof session.cookie, 'string')
  assert.ok(session.cookie.length > 0)
  const endpoint = new URL('/api/media/mcp/', origin)
  const dispatcher = process.env.MUSE_MEDIA_HTTP_PROXY ? new ProxyAgent(process.env.MUSE_MEDIA_HTTP_PROXY) : undefined
  const stop = new AbortController()
  const network = (input, init = {}) => fetch(input, {
    ...init,
    ...(dispatcher ? { dispatcher } : {}),
    signal: AbortSignal.any([stop.signal, AbortSignal.timeout(30_000), ...(init.signal ? [init.signal] : [])]),
  })
  const client = new Client({ name: 'muse-media-acceptance', version: '1.0.0' }, { capabilities: {} })
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { cookie: session.cookie, origin } }, fetch: network,
  })
  try {
    const anonymous = await network(endpoint, {
      method: 'POST', headers: { origin, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    await anonymous.body?.cancel()
    assert.equal(anonymous.status, 401)
    try {
      await client.connect(transport)
      const listed = await client.listTools()
      assert.deepEqual(listed.tools.map(tool => tool.name).sort(), expectedTools)
      const download = listed.tools.find(tool => tool.name === 'download_media')
      assert.ok(download.inputSchema.required.includes('request_id'))
      const query = listed.tools.find(tool => tool.name === 'get_task_result')
      assert.ok(query.inputSchema.properties.job_id)
      assert.equal(query.inputSchema.properties.task_id, undefined)
      const missing = await client.callTool({ name: 'get_task_result', arguments: { job_id: randomUUID() } })
      assert.equal(missing.isError, true)
      assert.equal(missing.structuredContent.state, 'failed')
    } catch (_error) {
      throw Error('Authenticated MCP negotiation or tool metadata verification failed; inspect the gateway without printing session credentials.')
    }
    for (const suffix of ['', '/files/video.mp4']) {
      const response = await network(new URL(`/api/media/jobs/${randomUUID()}${suffix}`, origin), {
        headers: { cookie: session.cookie, origin }, redirect: 'error',
      })
      await response.body?.cancel()
      assert.equal(response.status, 404)
    }
    const changedOrigin = await network(endpoint, {
      method: 'POST', headers: {
        cookie: session.cookie, origin: 'https://unrelated.invalid',
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    })
    await changedOrigin.body?.cancel()
    assert.equal(changedOrigin.status, 403)
  } finally {
    stop.abort()
    await client.close()
    if (dispatcher) await dispatcher.close()
  }
})
