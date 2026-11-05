/** Keyless real Loader activation preserves account services without a built-in MCP subprocess; package case requires a build. */
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as source from '../src/index.ts'
import { oldSessionFixture } from './model-routing-fixture.ts'

const artifact = fileURLToPath(new URL('../lib/index.js', import.meta.url))
const userTool = 'mcp__user-selected__reference'

it.each(['source', 'package'] as const)('activates the %s account through Loader with no built-in MCP tools and preserves a user contribution', async (plane) => {
  const home = await mkdtemp(join(tmpdir(), 'muse-account-startup-'))
  onTestFinished(() => rm(home, { recursive: true, force: true }))
  const fixture = await oldSessionFixture(false, home)
  const entry = plane === 'source' ? source : createRequire(import.meta.url)(artifact) as typeof source
  const tools = fixture.ctx.tools
  fixture.ctx.effect(() => tools.register(defineTool({
    name: userTool, description: 'User-selected fixture reference.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, result) => [{ type: 'text', text: result }] },
    execute: async () => 'user reference retained',
  })))
  fixture.ctx.loader.builtins['account-under-test'] = entry
  const id = await fixture.ctx.loader.create({ name: 'cordis:account-under-test',
    config: { baseUrl: 'https://muse.example', accountHome: home } })
  await fixture.ctx.loader.await()
  await fixture.ctx.loader.resolve(id).fiber?.await()
  try {
    const account: unknown = fixture.ctx.get('museAccount')
    if (!(account instanceof entry.MuseAccountService)) throw new Error('Account service was not mounted')
    expect(await account.status({ verify: false })).toEqual({ state: 'signed-out' })
    expect(tools.schemas().filter(tool => tool.name.startsWith('mcp__muse-account__'))).toEqual([])
    expect(fixture.ctx.llm.listProviders().some(provider => provider.id === 'deepseek-official')).toBe(true)
    const result = await executeModelToolFixture(fixture.ctx, { signal: new AbortController().signal,
      callId: ToolCallId('user-reference-after-account-startup'), name: userTool, arguments: {} })
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: 'user reference retained' }])
  } finally {
    await fixture.ctx.fiber.dispose()
  }
  expect(tools.get(userTool)).toBeUndefined()
})
