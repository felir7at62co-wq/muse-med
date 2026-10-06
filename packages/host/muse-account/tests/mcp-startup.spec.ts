import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { McpServer } from '@modelcontextprotocol/server'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { afterEach, expect, it, vi } from 'vitest'

const startup = vi.hoisted(() => ({ serve: vi.fn<(_factory: () => McpServer, _options: { onerror: () => void }) => void>() }))
vi.mock('@modelcontextprotocol/server/stdio', () => ({ serveStdio: startup.serve }))
afterEach(() => { startup.serve.mockClear(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules() })

it('does not attach stdio when imported as a library without an argv entry', async () => {
  const argv = process.argv
  try {
    process.argv = [argv[0]!]
    await import('../src/mcp-server.ts')
    expect(startup.serve).not.toHaveBeenCalled()
  } finally { process.argv = argv }
})

it('starts the configured private account MCP and emits only a bounded stdio error', async () => {
  const home = await mkdtemp(join(tmpdir(), 'muse-mcp-entry-'))
  const argv = process.argv
  let server: McpServer | undefined
  const client = new Client({ name: 'muse-main-test', version: '1' })
  try {
    process.argv = [argv[0]!, fileURLToPath(new URL('../src/mcp-server.ts', import.meta.url))]
    vi.stubEnv('MUSE_ACCOUNT_CONFIG', JSON.stringify({ baseUrl: 'https://muse.example', accountHome: home, requestTimeoutMs: 1000 }))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await import('../src/mcp-server.ts')
    expect(startup.serve).toHaveBeenCalledOnce()
    const arguments_ = startup.serve.mock.calls[0]
    if (!arguments_) throw new Error('Private MCP stdio was not attached')
    server = arguments_[0]()
    arguments_[1].onerror()
    expect(log).toHaveBeenCalledExactlyOnceWith('[muse-account] MCP request failed')
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    expect(await client.callTool({ name: 'muse_account_status', arguments: {} }))
      .toMatchObject({ content: [{ type: 'text', text: 'No MUSE account is signed in.' }] })
    expect(await client.callTool({ name: 'muse_kb_search', arguments: { query: 'opening' } }))
      .toMatchObject({ isError: true, content: [{ type: 'text', text: 'MUSE knowledge base: sign-in-required' }] })
  } finally {
    process.argv = argv
    await client.close(); await server?.close()
    await rm(home, { recursive: true, force: true })
  }
})
