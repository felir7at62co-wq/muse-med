/** Keyless source and published-entry activation against the built MCP child; requires pnpm run build. */
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as source from '../src/index.ts'
import { oldSessionFixture } from './model-routing-fixture.ts'

const artifact = fileURLToPath(new URL('../lib/index.js', import.meta.url))
const toolName = 'mcp__muse-account__muse_account_status'

it.each(['source', 'package'] as const)('discovers and executes the built account MCP child from the %s plugin without a login', async (plane) => {
  const home = await mkdtemp(join(tmpdir(), 'muse-mcp-discovery-'))
  onTestFinished(() => rm(home, { recursive: true, force: true }))
  const fixture = await oldSessionFixture(false, home)
  const entry = plane === 'source' ? source : createRequire(import.meta.url)(artifact) as typeof source
  const tools = fixture.ctx.tools
  try {
    await entry.apply(fixture.ctx, entry.Config({ baseUrl: 'https://muse.example', accountHome: home }))
    const account: unknown = fixture.ctx.get('museAccount')
    if (!(account instanceof entry.MuseAccountService)) throw new Error('Account service was not mounted')
    expect(await account.status({ verify: false })).toEqual({ state: 'signed-out' })
    expect(tools.schemas().filter(tool => tool.name.startsWith('mcp__muse-account__'))).toHaveLength(16)
    const result = await tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('muse-mcp-discovery'), name: toolName, arguments: { verify: false },
    })
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: 'No MUSE account is signed in.' }])
  } finally {
    await fixture.ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
  expect(tools.get(toolName)).toBeUndefined()
})
