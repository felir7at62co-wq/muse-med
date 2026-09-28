import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'
import { createMuseAccountMcpServer } from '../src/mcp-server.ts'
import type { MuseKbResult } from '../src/kb.ts'

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(closers.splice(0).map(close => close()))
})

it('rejects a relative account directory before mounting either account component', async () => {
  const ctx = new Context()
  await expect(apply(ctx, { baseUrl: 'https://muse.example', accountHome: 'relative/account', requestTimeoutMs: 15_000 }))
    .rejects.toThrow(/accountHome must be absolute/)
  await ctx.fiber.dispose()
})

it('publishes account status and read-only KB tools, never credential operations', async () => {
  const calls: Array<{ operation: string; id: string; start?: number }> = []
  const content: MuseKbResult = { content: [{ type: 'text', text: 'source=s1 range=[6000,12000) hasMore=true' }] }
  const server = createMuseAccountMcpServer(
    { status: async () => ({ state: 'signed-out' }) } as never,
    {
      search: async () => content,
      read: async (id: string, start?: number) => {
        calls.push({ operation: 'read', id, ...(start === undefined ? {} : { start }) })
        return content
      },
      readOpening: async () => content,
    },
  )
  const client = new Client({ name: 'muse-account-test', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  closers.push(() => client.close(), () => server.close())

  const listed = await client.listTools()
  expect(listed.tools.map(tool => tool.name).toSorted()).toEqual([
    'muse_account_status', 'muse_kb_read', 'muse_kb_read_opening', 'muse_kb_search',
  ])
  expect(await client.callTool({ name: 'muse_kb_read', arguments: { id: 'source:s1', start: 6000 } }))
    .toMatchObject(content)
  expect(calls).toEqual([{ operation: 'read', id: 'source:s1', start: 6000 }])
})
