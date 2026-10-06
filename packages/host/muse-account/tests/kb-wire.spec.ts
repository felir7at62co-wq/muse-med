import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { callMuseKbTool } from '../src/kb.ts'
import { expect, it } from 'vitest'

it('admits only SDK-validated text content through the real MCP HTTP transport', async () => {
  let result: object = { content: [{ type: 'text', text: 'Authorized original' }] }
  const authorizations: Array<string | undefined> = []
  const server = createServer((request, response) => {
    if (request.method !== 'POST') { response.writeHead(405); response.end(); return }
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (typeof value !== 'object' || value === null || !('method' in value)) { response.writeHead(400); response.end(); return }
      if (!('id' in value)) { response.writeHead(202); response.end(); return }
      authorizations.push(request.headers.authorization)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: value.id,
        result: value.method === 'initialize'
          ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
          : result }))
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/kb/mcp`
  try {
    await expect(callMuseKbTool(url, 'fixture-bearer', 'read', { id: 'source:one' }, 10000))
      .resolves.toEqual(result)
    result = { content: {} }
    await expect(callMuseKbTool(url, 'fixture-bearer', 'read', {}, 10000)).rejects.toMatchObject({ code: 'kb-unavailable' })
    result = { content: [{ type: 'image', data: 'AQ==', mimeType: 'image/png' }] }
    await expect(callMuseKbTool(url, 'fixture-bearer', 'read', {}, 10000)).rejects.toMatchObject({ code: 'kb-rejected' })
    result = { content: [], isError: true }
    await expect(callMuseKbTool(url, 'fixture-bearer', 'wiki_read', {}, 10000)).rejects.toMatchObject({ code: 'kb-rejected' })
    expect(authorizations.length).toBeGreaterThan(0)
    expect(authorizations.every(value => value === 'Bearer fixture-bearer')).toBe(true)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve() })
    })
  }
})
