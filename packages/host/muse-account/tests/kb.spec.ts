import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { callMuseKbTool, createMuseKbReader, MuseKbError } from '../src/kb.ts'
import { writeMuseSession } from '../src/session.ts'

const { mockConnect, mockCallTool, mockClose } = vi.hoisted(() => ({
  mockConnect: vi.fn<(_transport: unknown, _options?: { signal?: AbortSignal }) => Promise<void>>(),
  mockCallTool: vi.fn<(_params: unknown, _options?: { signal?: AbortSignal }) => Promise<{
    content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
    isError?: boolean
  }>>(),
  mockClose: vi.fn<() => Promise<void>>(),
}))

vi.mock('@modelcontextprotocol/client', () => ({
  Client: class {
    connect = mockConnect
    callTool = mockCallTool
    close = mockClose
  },
  StreamableHTTPClientTransport: vi.fn(),
}))

const homes: string[] = []

afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

it('exchanges the current cookie for a short-lived token without saving or returning the token', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-muse-kb-'))
  homes.push(home)
  const sessionFile = join(home, 'session.json')
  await writeMuseSession(sessionFile, { baseUrl: 'https://muse.example', cookie: '__Host-muse=secret-cookie', username: 'writer' })
  const requests: Array<{ url: string; options: RequestInit }> = []
  const fetcher = async (input: string | URL | Request, options?: RequestInit): Promise<Response> => {
    requests.push({ url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, options: options ?? {} })
    return Response.json({ url: 'https://muse.example/api/kb/mcp', token: 'secret-bearer', expiresAt: Date.now() + 60_000 })
  }
  const calls: Array<{ url: string; token: string; name: string; args: Record<string, unknown> }> = []
  const reader = createMuseKbReader({
    baseUrl: 'https://muse.example',
    requestTimeoutMs: 15_000,
    sessionFile,
    fetcher,
    callTool: async (url, token, name, args) => {
      calls.push({ url, token, name, args })
      return { content: [{ type: 'text', text: '开篇正文' }] }
    },
  })

  const result = await reader.readOpening('script-1')

  expect(requests).toHaveLength(1)
  expect(requests[0]?.url).toBe('https://muse.example/api/kb/access')
  expect(requests[0]?.options).toMatchObject({ method: 'POST', headers: { cookie: '__Host-muse=secret-cookie', origin: 'https://muse.example' } })
  expect(calls).toEqual([{ url: 'https://muse.example/api/kb/mcp', token: 'secret-bearer', name: 'read_opening', args: { id: 'script-1' } }])
  expect(result).toEqual({ content: [{ type: 'text', text: '开篇正文' }] })
  expect(JSON.stringify(result)).not.toContain('secret-bearer')
  expect(await readFile(sessionFile, 'utf8')).not.toContain('secret-bearer')
})

it('refuses knowledge-base tools without a signed-in account', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-muse-kb-'))
  homes.push(home)
  const reader = createMuseKbReader({
    baseUrl: 'https://muse.example',
    requestTimeoutMs: 15_000,
    sessionFile: join(home, 'missing.json'),
    fetcher: async () => { throw new Error('unexpected request') },
    callTool: async () => { throw new Error('unexpected tool call') },
  })

  await expect(reader.search('宫斗')).rejects.toMatchObject({ code: 'sign-in-required' })
  await expect(reader.ingestScript([{ title: '第一集', text: '正文', source: 'project/episode-01', reviewed: true }]))
    .rejects.toMatchObject({ code: 'sign-in-required' })
})

it('exchanges the current account session before saving reviewed script sections', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-muse-kb-ingest-'))
  homes.push(home)
  const sessionFile = join(home, 'session.json')
  await writeMuseSession(sessionFile, { baseUrl: 'https://muse.example', cookie: '__Host-muse=cookie', username: 'writer' })
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const reader = createMuseKbReader({
    baseUrl: 'https://muse.example', requestTimeoutMs: 15_000, sessionFile,
    fetcher: async () => Response.json({ url: 'https://muse.example/api/kb/mcp', token: 'temporary-bearer', expiresAt: Date.now() + 60_000 }),
    callTool: async (_url, _token, name, args) => {
      calls.push({ name, args })
      return { content: [{ type: 'text', text: '第 1 项：已写入；id: private/SRC-2026-09-28-001' }] }
    },
  })
  const items = [{ title: '第一集', text: '# 第一集\n场景一', source: 'project/episode-01', reviewed: true as const }]
  const result = await reader.ingestScript(items)
  expect(calls).toEqual([{ name: 'ingest_script', args: { items } }])
  expect(result.content[0]?.text).toContain('private/SRC-')
  expect(JSON.stringify(result)).not.toContain('temporary-bearer')
  await expect(reader.ingestScript([{ ...items[0]!, text: '汉'.repeat(700_000) }])).rejects.toMatchObject({ code: 'kb-rejected' })
  expect(calls).toHaveLength(1)
})

it('reads a granted source or wiki page at the requested character offset', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-muse-kb-'))
  homes.push(home)
  const sessionFile = join(home, 'session.json')
  await writeMuseSession(sessionFile, { baseUrl: 'https://muse.example', cookie: '__Host-muse=cookie', username: 'writer' })
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const reader = createMuseKbReader({
    baseUrl: 'https://muse.example',
    requestTimeoutMs: 15_000,
    sessionFile,
    fetcher: async () => Response.json({ url: 'https://muse.example/api/kb/mcp', token: 'short-lived', expiresAt: Date.now() + 60_000 }),
    callTool: async (_url, _token, name, args) => {
      calls.push({ name, args })
      return { content: [{ type: 'text', text: 'source=s1 range=[6000,12000) hasMore=true' }] }
    },
  })

  const result = await reader.read('source:s1', 6000)

  expect(calls).toEqual([{ name: 'read', args: { id: 'source:s1', start: 6000 } }])
  expect(result.content[0]?.text).toContain('hasMore=true')
  await expect(reader.read('wiki/' + 'x'.repeat(395))).resolves.toEqual(result)
  await expect(reader.read('source:s1', -1)).rejects.toMatchObject({ code: 'kb-rejected' })
  await expect(reader.read('source:s1', 6001)).rejects.toMatchObject({ code: 'kb-rejected' })
  await expect(reader.read('source:s1', 4194001)).rejects.toMatchObject({ code: 'kb-rejected' })
})

it('rejects access URLs and tool results that could reveal the bearer', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-muse-kb-'))
  homes.push(home)
  const sessionFile = join(home, 'session.json')
  await writeMuseSession(sessionFile, { baseUrl: 'https://muse.example', cookie: '__Host-muse=cookie', username: 'writer' })
  const reader = createMuseKbReader({
    baseUrl: 'https://muse.example',
    requestTimeoutMs: 15_000,
    sessionFile,
    fetcher: async () => Response.json({ url: 'http://untrusted.example/api/kb/mcp', token: 'secret-bearer', expiresAt: Date.now() + 60_000 }),
    callTool: async () => ({ content: [{ type: 'text', text: 'secret-bearer' }] }),
  })
  await expect(reader.readOpening('script-1')).rejects.toBeInstanceOf(MuseKbError)
})

it('passes one configured deadline signal to MCP connection and tool requests', async () => {
  const deadline = new AbortController()
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
  mockConnect.mockResolvedValue(undefined)
  mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'opening' }] })
  mockClose.mockResolvedValue(undefined)

  try {
    await expect(callMuseKbTool('https://muse.example/api/kb/mcp', 'bearer', 'read_opening', { id: 'script-1' }, 12_345))
      .resolves.toEqual({ content: [{ type: 'text', text: 'opening' }] })

    expect(timeout).toHaveBeenCalledExactlyOnceWith(12_345)
    expect(mockConnect).toHaveBeenCalledOnce()
    expect(mockCallTool).toHaveBeenCalledOnce()
    expect(mockConnect.mock.calls[0]?.[1]?.signal).toBe(deadline.signal)
    expect(mockCallTool.mock.calls[0]?.[1]?.signal).toBe(deadline.signal)
    expect(mockClose).toHaveBeenCalledOnce()
  } finally {
    timeout.mockRestore()
  }
})

it.each([
  ['Revision conflict: expected 1, current 2; read the page and merge before retrying.', 'wiki-revision-conflict'],
  ['Wiki is busy; reload the page before retrying. An abandoned lock requires administrator inspection.', 'wiki-write-busy'],
  ['Citation must reference a readable original and valid character range.', 'wiki-invalid-citation'],
  ['Wiki link is missing: concepts/missing; use a directory-qualified existing page ID.', 'wiki-unresolved-link'],
  ['Shared Wiki writes require an administrator account.', 'access-denied'],
  ['unknown error with private upstream detail', 'kb-rejected'],
  ['Revision conflict: expected 1, current 2; read the page and merge before retrying. bearer', 'kb-rejected'],
])('maps bounded Wiki failure %s to a fixed recovery category', async (text, code) => {
  mockConnect.mockResolvedValue(undefined)
  mockCallTool.mockResolvedValue({ isError: true, content: [{ type: 'text', text }] })
  mockClose.mockResolvedValue(undefined)
  await expect(callMuseKbTool('https://muse.example/api/kb/mcp', 'bearer', 'wiki_write_page', {}, 15_000))
    .rejects.toMatchObject({ code })
})

async function signedReader(fetcher: typeof fetch, text = 'safe text', error = false) {
  const home = await mkdtemp(join(tmpdir(), 'muse-kb-response-')); homes.push(home)
  const sessionFile = join(home, 'session.json')
  await writeMuseSession(sessionFile, { baseUrl: 'https://muse.example', cookie: '__Host-muse=fixture', username: 'writer' })
  const call = vi.fn(async () => ({ content: [{ type: 'text' as const, text }], ...(error ? { isError: true } : {}) }))
  return { reader: createMuseKbReader({ baseUrl: 'https://muse.example', sessionFile, requestTimeoutMs: 1000, fetcher, callTool: call }), call }
}
const access = () => ({ url: 'https://muse.example/api/kb/mcp', token: 'fixture-bearer', expiresAt: Date.now() + 60000 })

it.each([401, 403, 503, 500])('maps access exchange status %s without exposing the response body', async (status) => {
  const { reader, call } = await signedReader(async () => new Response('PRIVATE_GATEWAY_DETAIL', { status }))
  await expect(reader.read('source:one')).rejects.toMatchObject({ code: status === 401 ? 'sign-in-required'
    : status === 403 ? 'access-denied' : status === 503 ? 'kb-unavailable' : 'kb-rejected' })
  expect(call).not.toHaveBeenCalled()
})

it.each(['network', 'json'] as const)('bounds access exchange %s failures', async (failure) => {
  const { reader, call } = await signedReader(async () => {
    if (failure === 'network') throw new Error('PRIVATE_GATEWAY_DETAIL')
    return new Response('PRIVATE_INVALID_JSON')
  })
  await expect(reader.search('opening')).rejects.toMatchObject({ code: failure === 'network' ? 'kb-unavailable' : 'kb-rejected' })
  expect(call).not.toHaveBeenCalled()
})

it.each([null, [], 'bad', { url: 7 }, { token: 7 }, { token: '' }, { token: 'x'.repeat(4097) },
  { expiresAt: 'tomorrow' }, { expiresAt: 1.5 }, { expiresAt: 0 }, { url: 'invalid' },
  { url: 'https://user:password@muse.example/api/kb/mcp' }, { url: 'https://muse.example/foreign' },
  { url: 'https://muse.example/api/kb/mcp?token=private' }, { url: 'https://muse.example/api/kb/mcp#fragment' }])(
  'rejects malformed, expired or credential-bearing access metadata (%j)', async (invalid) => {
    const { reader, call } = await signedReader(async () => Response.json(typeof invalid === 'object' && invalid !== null && !Array.isArray(invalid)
      ? { ...access(), ...invalid } : invalid))
    await expect(reader.search('opening')).rejects.toMatchObject({ code: 'kb-rejected' })
    expect(call).not.toHaveBeenCalled()
  },
)

it.each(['bearer', 'oversized', 'error'] as const)('rejects unsafe remote content before model presentation (%s)', async (kind) => {
  const { reader } = await signedReader(async () => Response.json(access()), kind === 'bearer' ? 'fixture-bearer'
    : kind === 'oversized' ? 'x'.repeat(131073) : 'private remote failure', kind === 'error')
  await expect(reader.search('opening')).rejects.toMatchObject({ code: 'kb-rejected' })
})

it('checks source identifiers, pagination, search bounds and ingest batch size before access exchange', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(access()))
  const { reader } = await signedReader(fetcher)
  for (const query of ['', ' ', 'x'.repeat(201)]) await expect(reader.search(query)).rejects.toMatchObject({ code: 'kb-rejected' })
  for (const limit of [0, 21, 1.5]) await expect(reader.search('opening', limit)).rejects.toMatchObject({ code: 'kb-rejected' })
  for (const id of ['', 'x'.repeat(513)]) await expect(reader.read(id)).rejects.toMatchObject({ code: 'kb-rejected' })
  await expect(reader.read('source:one', 1.5)).rejects.toMatchObject({ code: 'kb-rejected' })
  for (const id of ['', 'x'.repeat(257)]) await expect(reader.readOpening(id)).rejects.toMatchObject({ code: 'kb-rejected' })
  await expect(reader.readOpening('source:one', 24000)).rejects.toMatchObject({ code: 'kb-rejected' })
  await expect(reader.ingestScript([])).rejects.toMatchObject({ code: 'kb-rejected' })
  await expect(reader.ingestScript(Array.from({ length: 13 }, () => ({ title: 'Episode', text: 'Reviewed', source: 'project/episode', reviewed: true as const }))))
    .rejects.toMatchObject({ code: 'kb-rejected' })
  expect(fetcher).not.toHaveBeenCalled()
  await reader.search('opening', 2)
  await reader.readOpening('source:one', 6000)
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it.each(['Account login is required for private and project Wiki.', 'Account Wiki is not configured.'])('maps bounded Wiki deployment errors (%s)', async (text) => {
  mockConnect.mockResolvedValue(undefined); mockClose.mockResolvedValue(undefined)
  mockCallTool.mockResolvedValue({ isError: true, content: [{ type: 'text', text }] })
  await expect(callMuseKbTool('https://muse.example/api/kb/mcp', 'bearer', 'wiki_status', {}, 1000))
    .rejects.toMatchObject({ code: text.includes('login') ? 'sign-in-required' : 'kb-unavailable' })
})

it.each(['legacy', 'multiple', 'image', 'oversized'] as const)('rejects unsupported remote result content (%s)', async (kind) => {
  mockConnect.mockResolvedValue(undefined); mockClose.mockResolvedValue(undefined)
  mockCallTool.mockResolvedValue(kind === 'image' ? { content: [{ type: 'image', data: 'AQ==', mimeType: 'image/png' }] }
    : { isError: true, content: kind === 'multiple' ? [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }]
      : [{ type: 'text', text: kind === 'oversized' ? 'x'.repeat(2049) : 'PRIVATE_UNTRUSTED_DETAIL' }] })
  await expect(callMuseKbTool('https://muse.example/api/kb/mcp', 'bearer', kind === 'legacy' ? 'read' : 'wiki_read', {}, 1000))
    .rejects.toMatchObject({ code: 'kb-rejected' })
})

it('closes the owned MCP client after a connection failure even when close itself fails', async () => {
  mockConnect.mockRejectedValueOnce(new Error('PRIVATE_CONNECT_DETAIL'))
  mockClose.mockRejectedValueOnce(new Error('PRIVATE_CLOSE_DETAIL'))
  await expect(callMuseKbTool('https://muse.example/api/kb/mcp', 'bearer', 'read', {}, 1000))
    .rejects.toMatchObject({ code: 'kb-unavailable', message: 'MUSE knowledge base: kb-unavailable' })
})
