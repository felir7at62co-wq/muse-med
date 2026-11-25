import { Context, Service } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { WorkbenchRequest, WorkbenchSession } from '@deepseek-ai/dsh-workbench-connection'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import * as plugin from '../src/index.ts'

const SCRIPT = {
  id: 7, title: '雨巷', owner: { id: 1, name: '小林' }, rights: 'original', origin_work_id: null, origin_title: null,
  kind: 'drama', style: 'realistic', episodes: 1, words: 6, status: 'waiting', latest_version: 2, picked: null, project: null,
  created_at: '2026-11-19T08:00:00', updated_at: '2026-11-20T08:00:00',
}

function route(path: string, init: WorkbenchRequest): unknown {
  if (path.startsWith('/script-library?')) return { items: [], total: 0, page: 1, limit: 100, counts: { waiting: 0, picked: 0, in_production: 0, all: 0 }, can_pick: false }
  if (path === '/script-library' && init.method === 'POST') return { created: true, version: 1, script: { ...SCRIPT, latest_version: 1 } }
  if (path === '/script-library/7?version=2') return { script: SCRIPT, can_pick: false, versions: [], content: { version: 2, episodes: [{ order: 1, title: '第1集', content: '林晚回家。' }] } }
  throw new Error('Unexpected Workshop request ' + path)
}

async function bench() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  const request = vi.fn(async (path: string, init: WorkbenchRequest = {}) => route(path, init))
  const session: WorkbenchSession = { identity: 'workshop-user', origin: 'https://muse.example/jubengongfang', request, fetch: vi.fn(), check: vi.fn() }
  const files: Record<string, string> = { '/workspace/drafts/0001.md': '林晚回家。' }
  class Connection extends Service {
    constructor(parent: Context) { super(parent, 'workshopConnection') }
    connection = vi.fn(async () => session)
  }
  class Files extends Service {
    constructor(parent: Context) { super(parent, 'fs') }
    resolve = vi.fn(async (path: string, options: { cwd: string }) => options.cwd + '/' + path)
    readText = vi.fn(async (target: string) => files[target] ?? '')
    writeText = vi.fn(async (target: string, text: string) => { files[target] = text })
  }
  const resolvePolicy = vi.fn(() => ({ workspaceRoot: '/workspace' }))
  class Policy extends Service {
    constructor(parent: Context) { super(parent, 'sandboxPolicy') }
    resolve = resolvePolicy
  }
  const fiber = ctx.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply })
  await fiber.await()
  const call = (name: string, args: unknown) => executeToolFixture(ctx, {
    name, arguments: args, callId: ToolCallId('workshop-call'), signal: new AbortController().signal,
    agent: { session: { id: 'session-1' } } as never,
  })
  const registered = () => ['script_finalize', 'script_library', 'workshop_script_editor'].filter(name => ctx.tools.get(name) !== undefined)
  return { ctx, call, registered, files, Connection, Files, Policy, resolvePolicy }
}

describe('tool-workshop', () => {
  it('registers the draft editor with the Workshop connection and the script tools once workspace files are available', async () => {
    const { ctx, registered, Connection, Files, Policy } = await bench()
    expect(registered()).toEqual([])
    const connection = ctx.plugin(Connection)
    await connection.await()
    expect(registered()).toEqual(['workshop_script_editor'])
    await ctx.plugin(Files)
    await ctx.plugin(Policy)
    expect(registered()).toEqual(['script_finalize', 'script_library', 'workshop_script_editor'])
    await connection.dispose()
    expect(registered()).toEqual([])
  })

  it('reads and writes script files in the conversation workspace', async () => {
    const { ctx, call, files, Connection, Files, Policy, resolvePolicy } = await bench()
    await ctx.plugin(Connection)
    await ctx.plugin(Files)
    await ctx.plugin(Policy)
    const finalized = await call('script_finalize', { title: '雨巷', files: ['drafts/0001.md'] })
    expect(finalized.value).toMatchObject({ id: 7, version: 1, created: true })
    resolvePolicy.mockClear()
    const read = await call('script_library', { action: 'read', id: 7, version: 2 })
    expect(read.isError).toBe(false)
    expect(resolvePolicy).toHaveBeenCalledExactlyOnceWith({ session: { id: 'session-1' } })
    expect(files['/workspace/剧本库/雨巷-v2/第001集.md']).toBe('# 第1集\n\n林晚回家。\n')
  })
})
