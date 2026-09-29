/** Verify built-in discovery against the panel's real wire codec without exposing connection secrets. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { McpManagerGateway } from './lib/mcp/gateway.js'
import { mcpListResultSchema } from './lib/mcp/wire.js'

test('lists mounted knowledge-base tools separately from editable profile connections', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'muse-mcp-panel-'))
  const ctx = new Context()
  try {
    await writeFile(join(dir, 'cordis.patch.yml'), '[]\n')
    ctx.baseUrl = pathToFileURL(dir).href + '/'
    ctx.provide('tools', { schemas: () => [
      { name: 'mcp__muse-account__muse_account_status' },
      { name: 'mcp__muse-account__muse_kb_search' },
      { name: 'shell' },
    ] })
    const gateway = new McpManagerGateway(ctx)
    const result = mcpListResultSchema.parse(await gateway.list())
    assert.deepEqual(result.servers, [])
    assert.equal(result.externalServers.length, 1)
    const row = result.externalServers[0]
    assert.equal(row.serverName, 'muse-account')
    assert.equal(row.managed, false)
    assert.equal(row.fiberPhase, 'active')
    assert.equal(row.toolCount, 2)
    assert.equal(row.command, undefined)
    assert.deepEqual(row.envKeys, [])
  } finally {
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
