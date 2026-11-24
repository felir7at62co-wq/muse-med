/** The registered surface: tool names, argument guards and one end-to-end tool call. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply, inject, name } from '../src/index.js'

/** Minimal Cordis stand-in that records what the plugin registers. */
function fakeContext(cwd, mode = 'workspace-write') {
  const tools = new Map()
  return {
    tools,
    ctx: {
      effect: run => {
        const dispose = run()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      tools: { register: tool => {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      } },
      agents: { requireInitiator: () => ({ session: { header: { cwd } } }) },
      get: key => key === 'sandboxPolicy' ? { resolve: () => ({ workspaceRoot: cwd, mode }) } : undefined,
    },
  }
}

/** Start a throwaway HTTP server and return its base URL plus a stop function. */
async function startStub(t, handler) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const origin = `https://127.0.0.1:${port}`
  const fetch = globalThis.fetch
  t.mock.method(globalThis, 'fetch', (input, options) => {
    const url = new URL(input)
    assert.equal(url.origin, origin)
    url.protocol = 'http:'
    return fetch(url, options)
  })
  return { baseUrl: `${origin}/api/v1`, stop: () => new Promise(resolve => server.close(resolve)) }
}

test('plugin identity and registration names are stable', () => {
  const { ctx, tools } = fakeContext('C:/work')
  apply(ctx, { baseUrl: 'https://example.invalid/api/v1', tokenEnv: 'TEST_DRAMA_TOKEN' })
  assert.equal(name, 'muse-drama-web')
  assert.deepEqual(inject, ['tools', 'agents'])
  assert.deepEqual([...tools.keys()].sort(), [
    'drama_web_download',
    'drama_web_files',
    'drama_web_library',
    'drama_web_link',
    'drama_web_login',
    'drama_web_pan_share',
    'drama_web_profile',
    'drama_web_subtitle_erase',
    'drama_web_title',
  ])
  for (const tool of tools.values()) {
    assert.equal(typeof tool.execute, 'function')
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.parameters.additionalProperties, false)
    assert.ok(tool.description.length > 30)
  }
})

test('library tool projects items and total without inflating them', async (t) => {
  const stub = await startStub(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ items: [{ id: 1584, title: '豪门小保洁' }], total: 37 }))
  })
  const { ctx, tools } = fakeContext('C:/work')
  process.env.TEST_DRAMA_TOKEN = 'tok'
  try {
    apply(ctx, { baseUrl: stub.baseUrl, tokenEnv: 'TEST_DRAMA_TOKEN' })
    const result = await tools.get('drama_web_library').execute({ keyword: '豪门' }, { signal: undefined })
    assert.equal(result.ok, true)
    assert.equal(result.total, 37)
    assert.equal(result.count, 1)
    assert.equal(result.items[0].id, 1584)
  }
  finally {
    await stub.stop()
  }
})

test('download tool writes under the initiating session workspace', async (t) => {
  const payload = 'bytes'
  const stub = await startStub(t, (req, res) => {
    if (req.url.startsWith('/api/v1/files/9/url')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ url: `https://127.0.0.1:${req.socket.localPort}/blob/9?signature=mock` }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.end(payload)
  })
  const dir = await mkdtemp(join(tmpdir(), 'drama-web-tool-'))
  const { ctx, tools } = fakeContext(dir)
  process.env.TEST_DRAMA_TOKEN = 'tok'
  try {
    apply(ctx, { baseUrl: stub.baseUrl, tokenEnv: 'TEST_DRAMA_TOKEN' })
    const result = await tools.get('drama_web_download').execute({ fileId: 9, outputPath: 'downloads/09.mp4' }, { signal: undefined })
    assert.equal(result.ok, true)
    assert.equal(result.bytes, payload.length)
    assert.equal(result.path, join(dir, 'downloads', '09.mp4'))
    assert.equal(Object.hasOwn(result, 'url'), false)
  }
  finally {
    await rm(dir, { recursive: true, force: true })
    await stub.stop()
  }
})

test('download requires a workspace destination and write permissions', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => {
    assert.fail('a rejected download must not contact drama-web')
  })
  const { ctx, tools } = fakeContext('C:/work', 'read-only')
  apply(ctx, { baseUrl: 'https://example.invalid/api/v1' })
  const execute = tools.get('drama_web_download').execute
  const missing = await execute({ fileId: 9 }, {})
  const readOnly = await execute({ fileId: 9, outputPath: 'download.mp4' }, {})
  assert.equal(missing.ok, false)
  assert.equal(readOnly.ok, false)
  assert.equal(fetch.mock.callCount(), 0)
})

test('remote writes require host configuration', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => {
    assert.fail('disabled actions must not contact drama-web')
  })
  const { ctx, tools } = fakeContext('C:/work')
  apply(ctx, { baseUrl: 'https://example.invalid/api/v1' })
  for (const tool of ['drama_web_pan_share', 'drama_web_title', 'drama_web_subtitle_erase']) {
    const result = await tools.get(tool).execute({ dramaId: 1584, action: 'create', file_ids: [1] }, {})
    assert.equal(result.ok, false)
  }
  assert.equal(fetch.mock.callCount(), 0)
})

test('subtitle erase refuses an incomplete region before any request', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => {
    assert.fail('an incomplete region must not contact drama-web')
  })
  const { ctx, tools } = fakeContext('C:/work')
  apply(ctx, { baseUrl: 'https://example.invalid/api/v1', allowRemoteWrites: true })
  const result = await tools.get('drama_web_subtitle_erase').execute({ dramaId: 1584, action: 'create', source_file_id: 1 }, {})
  assert.equal(result.ok, false)
  assert.match(result.reason, /missing/)
  assert.equal(fetch.mock.callCount(), 0)
})

test('every declared schema uses single-type fields', () => {
  const { ctx, tools } = fakeContext('C:/work')
  apply(ctx, { baseUrl: 'https://example.invalid/api/v1', tokenEnv: 'TEST_DRAMA_TOKEN' })
  const walk = (node, trail) => {
    if (!node || typeof node !== 'object') return
    if ('type' in node) {
      assert.equal(typeof node.type, 'string', `${trail}.type must be a single type string, got ${JSON.stringify(node.type)}`)
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties') {
        for (const [name, child] of Object.entries(value ?? {})) walk(child, `${trail}.properties.${name}`)
      }
      else if (key === 'items') walk(value, `${trail}.items`)
      else if (key === 'additionalProperties' && value && typeof value === 'object') walk(value, `${trail}.additionalProperties`)
    }
  }
  for (const tool of tools.values()) {
    walk(tool.parameters, `${tool.name}.parameters`)
    walk(tool.output?.schema, `${tool.name}.output.schema`)
  }
})

test('link tool needs no network and points at the drama page', async () => {
  const { ctx, tools } = fakeContext('C:/work')
  apply(ctx)
  const result = await tools.get('drama_web_link').execute({ dramaId: 1584 }, {})
  assert.equal(result.url, 'http://drama-web.jubianai.net/#/dramas/1584')
})
