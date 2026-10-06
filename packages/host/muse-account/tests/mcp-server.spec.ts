import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { apply, Config } from '../src/index.ts'
import type { MuseAccountStatus } from '../src/types.ts'
import { createMuseAccountMcpServer, parseMuseAccountLaunch } from '../src/mcp-server.ts'
import { createMuseKbReader, MuseKbError, type MuseKbFailure, type MuseKbResult } from '../src/kb.ts'
import { writeMuseSession } from '../src/session.ts'

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(closers.splice(0).map(close => close()))
})

it('rejects a relative account directory before mounting either account component', async () => {
  const ctx = new Context()
  await expect(apply(ctx, Config({ baseUrl: 'https://muse.example', accountHome: 'relative/account',
    requestTimeoutMs: 15_000, asrRequestTimeoutMs: 300_000, modelRefreshMs: 60_000,
    excludedModelPrefixes: [], feedbackExcerptChars: 1000 })))
    .rejects.toThrow(/accountHome must be absolute/)
  await ctx.fiber.dispose()
})

it('publishes account status, KB reads, and private script ingestion without credential operations', async () => {
  const calls: Array<{ operation: string; id: string; start?: number }> = []
  const ingested: Array<{ title: string; source: string }> = []
  const content: MuseKbResult = { content: [{ type: 'text', text: 'source=s1 range=[6000,12000) hasMore=true' }] }
  let status: MuseAccountStatus = { state: 'signed-out' }
  let failed = false
  const server = createMuseAccountMcpServer(
    { status: async () => { if (failed) throw new Error('PRIVATE_GATEWAY_DETAIL'); return status } },
    {
      search: async () => content,
      read: async (id: string, start?: number) => {
        calls.push({ operation: 'read', id, ...(start === undefined ? {} : { start }) })
        return content
      },
      readOpening: async () => content,
      ingestScript: async (items) => {
        ingested.push(...items.map(item => ({ title: item.title, source: item.source })))
        return { content: [{ type: 'text', text: '第 1 项：已写入；id: private/SRC-2026-09-28-001' }] }
      },
      wikiCaptureSource: async () => content,
      wikiDirectory: async () => content,
      wikiSearch: async () => content,
      wikiRead: async () => content,
      wikiWritePage: async () => content,
      wikiHistory: async () => content,
      wikiLinks: async () => content,
      wikiStatus: async () => content,
      wikiMigrationPreview: async () => content,
      wikiRecordProject: async () => content,
      wikiProjectPortfolio: async () => content,
    },
  )
  const client = new Client({ name: 'muse-account-test', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  closers.push(() => client.close(), () => server.close())

  const listed = await client.listTools()
  expect(listed.tools.map(tool => tool.name).toSorted()).toEqual([
    'muse_account_status', 'muse_kb_ingest_script', 'muse_kb_read', 'muse_kb_read_opening', 'muse_kb_search',
    'muse_kb_wiki_capture_source', 'muse_kb_wiki_directory', 'muse_kb_wiki_history', 'muse_kb_wiki_links',
    'muse_kb_wiki_migration_preview', 'muse_kb_wiki_project_portfolio', 'muse_kb_wiki_read', 'muse_kb_wiki_record_project',
    'muse_kb_wiki_search', 'muse_kb_wiki_status', 'muse_kb_wiki_write_page',
  ])
  expect(await client.callTool({ name: 'muse_account_status', arguments: {} }))
    .toMatchObject({ content: [{ type: 'text', text: 'No MUSE account is signed in.' }] })
  status = { state: 'signed-in', username: 'writer', verified: false }
  expect(JSON.stringify(await client.callTool({ name: 'muse_account_status', arguments: { verify: false } })))
    .toContain('saved locally, not yet verified')
  status = { ...status, verified: true }
  expect(JSON.stringify(await client.callTool({ name: 'muse_account_status', arguments: { verify: true } })))
    .toContain('gateway verified')
  failed = true
  expect(await client.callTool({ name: 'muse_account_status', arguments: {} }))
    .toMatchObject({ isError: true, content: [{ type: 'text', text: 'MUSE account status is unavailable.' }] })
  expect(await client.callTool({ name: 'muse_kb_search', arguments: { query: 'opening' } })).toMatchObject(content)
  expect(await client.callTool({ name: 'muse_kb_read_opening', arguments: { id: 'source:s1' } })).toMatchObject(content)
  expect(await client.callTool({ name: 'muse_kb_read', arguments: { id: 'source:s1', start: 6000 } }))
    .toMatchObject(content)
  expect(calls).toEqual([{ operation: 'read', id: 'source:s1', start: 6000 }])
  const ingestedResult = await client.callTool({ name: 'muse_kb_ingest_script', arguments: { items: [
    { title: '第一集', text: '# 第一集\n场景一', source: 'project/episode-01', reviewed: true },
  ] } })
  expect(JSON.stringify(ingestedResult)).toContain('private/SRC-')
  expect(ingested).toEqual([{ title: '第一集', source: 'project/episode-01' }])
})

it('routes Wiki tools and participation records through the current account session and refuses calls after sign-out', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-muse-wiki-mcp-'))
  const sessionFile = join(home, 'session.json')
  closers.push(() => rm(home, { recursive: true, force: true }))
  await writeMuseSession(sessionFile, { baseUrl: 'https://muse.example', cookie: '__Host-muse=first-cookie', username: 'writer' })
  const exchanges: string[] = []
  const calls: Array<{ name: string; args: Record<string, unknown>; token: string }> = []
  const kb = createMuseKbReader({
    baseUrl: 'https://muse.example', sessionFile, requestTimeoutMs: 15_000,
    fetcher: async (_input, options) => {
      exchanges.push(new Headers(options?.headers).get('cookie') ?? '')
      return Response.json({ url: 'https://muse.example/api/kb/mcp', token: 'wiki-bearer-' + String(exchanges.length),
        expiresAt: Date.now() + 60_000 })
    },
    callTool: async (_url, token, name, args) => {
      calls.push({ name, args, token })
      return { content: [{ type: 'text', text: JSON.stringify({ operation: name, args }) }] }
    },
  })
  const server = createMuseAccountMcpServer({ status: async () => ({ state: 'signed-out' }) }, kb)
  const client = new Client({ name: 'muse-wiki-test', version: '1' })
  closers.push(() => client.close(), () => server.close())
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)

  const scope = { scope: 'project', project_id: 'script-42' }
  const operations = [
    { name: 'wiki_capture_source', args: { ...scope, title: '原件', text: '# 原文', source: 'project/episode-01' } },
    { name: 'wiki_directory', args: { ...scope, folder: 'concepts', start: 2, limit: 3 } },
    { name: 'wiki_search', args: { ...scope, query: '全文'.repeat(120), limit: 8 } },
    { name: 'wiki_read', args: { ...scope, id: 'project/script-42/wiki/concepts/hook', start: 6000, revision: 2 } },
    { name: 'wiki_write_page', args: { ...scope, page_id: 'concepts/hook', title: '开篇', text: '# 综合知识', expected_revision: 2,
      citations: [{ id: 'project/script-42/SRC-2026-09-28-001', start: 0, end: 6 }] } },
    { name: 'wiki_history', args: { ...scope, id: 'project/script-42/wiki/concepts/hook', start: 1, limit: 4 } },
    { name: 'wiki_links', args: { ...scope, id: 'project/script-42/wiki/concepts/hook' } },
    { name: 'wiki_status', args: scope },
    { name: 'wiki_migration_preview', args: { scope: 'shared' } },
    { name: 'wiki_record_project', args: { project_key: 'jubian-42', project_title: '山河闻凤鸣', contribution_id: 'episode-01',
      stage: '分镜', status: 'in_progress', content: '分镜已检查，视频任务仍待完成。', artifacts: ['deliverables/EP01.md', 'jubian:499887'] } },
    { name: 'wiki_project_portfolio', args: { account_id: '0123456789abcdef', project_key: 'jubian-42', start: 2, limit: 3 } },
  ]
  for (const [index, operation] of operations.entries()) {
    if (index === 1) await writeMuseSession(sessionFile, {
      baseUrl: 'https://muse.example', cookie: '__Host-muse=refreshed-cookie', username: 'writer',
    })
    const result = await client.callTool({ name: 'muse_kb_' + operation.name, arguments: operation.args })
    expect(result).toMatchObject({ content: [{ type: 'text', text: JSON.stringify({ operation: operation.name, args: operation.args }) }] })
    expect(JSON.stringify(result)).not.toMatch(/wiki-bearer-|first-cookie|refreshed-cookie/u)
  }
  expect(calls).toEqual(operations.map((operation, index) => ({ ...operation, token: 'wiki-bearer-' + String(index + 1) })))
  expect(exchanges).toEqual(['__Host-muse=first-cookie', ...Array<string>(operations.length - 1).fill('__Host-muse=refreshed-cookie')])
  expect(await readFile(sessionFile, 'utf8')).not.toContain('wiki-bearer-')

  const invalid = await client.callTool({ name: 'muse_kb_wiki_read', arguments: { ...scope, id: 'page', start: 6001 } })
  expect(invalid.isError).toBe(true)
  for (const name of ['muse_kb_wiki_record_project', 'muse_kb_wiki_project_portfolio']) {
    const operation = operations.find(operation => 'muse_kb_' + operation.name === name)!
    expect((await client.callTool({ name, arguments: { ...operation.args, scope: 'shared' } })).isError).toBe(true)
  }
  expect((await client.callTool({ name: 'muse_kb_wiki_project_portfolio', arguments: { account_id: '../other-account' } })).isError).toBe(true)
  expect(calls).toHaveLength(operations.length)
  await rm(sessionFile)
  for (const operation of operations) {
    const result = await client.callTool({ name: 'muse_kb_' + operation.name, arguments: operation.args })
    expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'MUSE knowledge base: sign-in-required' }] })
  }
  expect(calls).toHaveLength(operations.length)
  expect(exchanges).toHaveLength(operations.length)
})

it('returns fixed Wiki revision recovery guidance separately from access refusal', async () => {
  let failure: MuseKbFailure = 'wiki-revision-conflict'
  let unexpected = false
  const kb = createMuseKbReader({ baseUrl: 'https://muse.example',
    sessionFile: join(tmpdir(), 'unused-wiki-error-session.json'), requestTimeoutMs: 15_000 })
  const server = createMuseAccountMcpServer({ status: async () => ({ state: 'signed-out' }) }, {
    ...kb,
    wikiWritePage: async () => { if (unexpected) throw new Error('PRIVATE_UPSTREAM_DETAIL'); throw new MuseKbError(failure) },
  })
  const client = new Client({ name: 'muse-wiki-errors', version: '1' })
  closers.push(() => client.close(), () => server.close())
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  const request = { name: 'muse_kb_wiki_write_page', arguments: {
    page_id: 'concepts/hook', title: '开篇', text: '# 知识', expected_revision: 1,
    citations: [{ id: 'private/SRC-2026-09-28-001', start: 0, end: 1 }],
  } }
  expect(await client.callTool(request)).toMatchObject({ isError: true, content: [{ type: 'text',
    text: 'MUSE knowledge base: wiki-revision-conflict. Read the current page, merge the changes, then retry with its current expected_revision.',
  }] })
  failure = 'access-denied'
  expect(await client.callTool(request)).toMatchObject({ isError: true,
    content: [{ type: 'text', text: 'MUSE knowledge base: access-denied' }] })
  unexpected = true
  expect(await client.callTool(request)).toMatchObject({ isError: true,
    content: [{ type: 'text', text: 'MUSE knowledge base: kb-unavailable' }] })
})

it('reads a valid large Wiki link graph produced by the cloud MCP service', async () => {
  // The JavaScript cloud MCP handler owns this fixture's vault and grant logic.
  const cloud = await import(new URL('../../../../services/muse-accounts/kb-mcp.mjs', import.meta.url).href) as {
    createKbMcp(options: Record<string, unknown>): (request: {
      method: string
      headers: Record<string, string>
      body: string
    }) => Promise<{ status: number; body: string }>
  }
  const home = await mkdtemp(join(tmpdir(), 'muse-wiki-link-graph-'))
  closers.push(() => rm(home, { recursive: true, force: true }))
  const vaultRoot = join(home, 'shared'), personalRoot = join(home, 'personal')
  await mkdir(vaultRoot)
  await mkdir(personalRoot)
  const owner = { id: '0123456789abcdef', username: 'writer', revision: 1, disabled: false }
  const handle = cloud.createKbMcp({ vaultRoot, personalRoot,
    accounts: { get: (id: string) => id === owner.id ? owner : undefined },
    secret: 'test-only-secret-longer-than-thirty-two-characters',
    authorize: (token: string) => token === 'graph-bearer' ? { account: owner, mode: 'account' } : null,
  })
  const remote = async (name: string, args: Record<string, unknown>): Promise<MuseKbResult> => {
    const response = await handle({ method: 'POST', headers: { authorization: 'Bearer graph-bearer' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
    expect(response.status).toBe(200)
    const payload = JSON.parse(response.body) as { result: MuseKbResult }
    expect(payload.result.isError).not.toBe(true)
    return payload.result
  }
  const captured = await remote('wiki_capture_source', { title: '原件', text: '资料'.repeat(400), source: 'project/notes' })
  const source = JSON.parse(captured.content[0]!.text) as { source: { id: string } }
  // UTF-8 directory names and the temporary root share macOS's full-path limit.
  const pageIds = Array.from({ length: 50 }, (_value, index) => 'concepts/'
    + ['甲'.repeat(70), '乙'.repeat(70), '丙'.repeat(70), '页'.repeat(69) + String(index)].join('/'))
  for (const pageId of pageIds) {
    const file = join(personalRoot, owner.id, 'wiki', pageId + '.md')
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, '# 关联知识\n\n[[concepts/hub]]\n')
  }
  await remote('wiki_write_page', { page_id: 'concepts/hub', title: '知识索引',
    text: '# 知识索引\n\n' + pageIds.map(id => '[[' + id + ']]').join('\n'), expected_revision: 0,
    citations: Array.from({ length: 64 }, () => ({ id: source.source.id, start: 0, end: 240 })),
  })
  const sessionFile = join(home, 'session.json')
  await writeMuseSession(sessionFile, { baseUrl: 'https://muse.example', cookie: '__Host-muse=graph-cookie', username: 'writer' })
  const kb = createMuseKbReader({ baseUrl: 'https://muse.example', sessionFile, requestTimeoutMs: 15_000,
    fetcher: async () => Response.json({ url: 'https://muse.example/api/kb/mcp', token: 'graph-bearer', expiresAt: Date.now() + 60_000 }),
    callTool: async (_url, _token, name, args) => await remote(name, args),
  })
  const result = await kb.wikiLinks({ id: 'private/wiki/concepts/hub' })
  expect(Buffer.byteLength(result.content[0]!.text, 'utf8')).toBeGreaterThan(131_072)
  const links = JSON.parse(result.content[0]!.text) as { outgoing: string[]; backlinks: unknown[]; citations: unknown[] }
  expect(links.outgoing).toHaveLength(50)
  expect(links.backlinks).toHaveLength(50)
  expect(links.citations).toHaveLength(64)
})

it.each([undefined, 'invalid JSON', 'null', '[]', '7', JSON.stringify({ baseUrl: 7 }),
  JSON.stringify({ baseUrl: 'https://muse.example', accountHome: 7, requestTimeoutMs: 1000 }),
  JSON.stringify({ baseUrl: 'https://muse.example', accountHome: 'relative', requestTimeoutMs: 1000 }),
  ...[undefined, '1000', 1.5, 999, 120001].map(requestTimeoutMs => JSON.stringify({ baseUrl: 'https://muse.example', accountHome: join(tmpdir(), 'parse-only-account'), requestTimeoutMs }))])(
  'rejects malformed credential-free MCP launch configuration (%s)', (raw) => {
    expect(() => parseMuseAccountLaunch(raw)).toThrow('muse-account MCP:')
  },
)

it('canonicalizes a valid MCP launch origin and retains only permitted startup fields', () => {
  const accountHome = join(tmpdir(), 'parse-only-account')
  expect(parseMuseAccountLaunch(JSON.stringify({ baseUrl: 'https://muse.example/', accountHome, requestTimeoutMs: 1000,
    password: 'ignored-private-value' }))).toEqual({ baseUrl: 'https://muse.example', accountHome, requestTimeoutMs: 1000 })
})
