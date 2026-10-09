/** Verify built-in discovery against the panel's real wire codec without exposing connection secrets. */
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { test } from 'node:test'
import { chmod, mkdtemp, readdir, writeFile, rm } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { McpManagerGateway } from './lib/mcp/gateway.js'
import { mcpListResultSchema } from './lib/mcp/wire.js'
import { apply } from './lib/index.js'

test('mounts the bundled panel without installing a global CLI or writing into a read-only application', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'muse-mcp-readonly-app-'))
  const ctx = new Context()
  const manifests = []
  const providers = []
  const messages = []
  const previousAppData = process.env.APPDATA
  const prefix = t.mock.method(childProcess, 'execFileSync', () => dir)
  syncBuiltinESMExports()
  try {
    if (process.platform !== 'win32') await chmod(dir, 0o500)
    else process.env.APPDATA = dir
    ctx.provide('logger', { info: message => messages.push(message) })
    ctx.provide('typert', { register: manifest => {
      manifests.push(manifest)
      return () => { manifests.splice(manifests.indexOf(manifest), 1) }
    } })
    ctx.provide('skills', { registerProvider: factory => { providers.push(factory) } })
    apply(ctx)
    assert.equal(prefix.mock.callCount(), 0, 'Host activation must not query or install a global npm command')
    assert.deepEqual(await readdir(dir), [], 'the application payload must remain unchanged')
    assert.deepEqual(messages, [], 'read-only failures must not be swallowed as successful activation')
    assert.ok(ctx.get('skillsViewer'), 'the Skills gateway remains registered')
    assert.ok(ctx.get('mcpManager'), 'the MCP gateway remains registered')
    assert.equal(manifests.length, 1)
    assert.equal(providers.length, 1)
  } finally {
    prefix.mock.restore()
    syncBuiltinESMExports()
    if (process.platform === 'win32') {
      if (previousAppData === undefined) delete process.env.APPDATA
      else process.env.APPDATA = previousAppData
    }
    await ctx.fiber.dispose()
    if (process.platform !== 'win32') await chmod(dir, 0o700)
    await rm(dir, { recursive: true, force: true })
  }
})

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
