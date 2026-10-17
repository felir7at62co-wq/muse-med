/** Local memory isolation, bounded failures and original async receipt handling. */
import { afterEach, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Config, LocalHindsight } from '../src/hindsight.ts'
import * as Hindsight from '../src/hindsight.ts'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'

const roots: string[] = []
const token = 'local-only-fixture-token-never-in-model-output'
const operation = '7c3d380c-0067-4817-8b83-b15c4b9d4441'
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(handler: (path: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  const root = await mkdtemp(join(tmpdir(), 'muse-hindsight-')); roots.push(root)
  const file = join(root, 'connection.json')
  await writeFile(file, JSON.stringify({ baseUrl: 'http://127.0.0.1:9078', token, namespace: 'fixture-muse' }), { mode: 0o600 })
  const calls: Array<{ path: string; init: RequestInit | undefined }> = []
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(url instanceof Request ? url.url : url.toString()).pathname
    calls.push({ path, init })
    return await handler(path, init)
  })
  const client = new LocalHindsight(Config({ connectionFile: file }), fetcher)
  return { root, file, calls, fetcher, client, signal: new AbortController().signal }
}
const json = (value: object, status = 200): Response => new Response(JSON.stringify(value), { status })
function body(value: BodyInit | null | undefined): object {
  if (typeof value !== 'string') throw Error('Expected JSON request text')
  return JSON.parse(value) as object
}

it('keeps user memory on loopback and never exposes the local API token', async () => {
  const f = await fixture(() => json({}))
  const output = await f.client.request({ action: 'status', scope: 'user' }, undefined, f.signal)
  expect(JSON.parse(output)).toEqual({ state: 'available', scope: 'user', initialized: true, storage: 'local-computer' })
  expect(output).not.toContain(token)
  expect(f.calls.map(call => call.path)).toEqual(['/health', '/v1/default/banks/fixture-muse-user/stats'])
  expect(f.calls.every(call => new Headers(call.init?.headers).get('authorization') === 'Bearer ' + token)).toBe(true)
  expect(f.calls.every(call => call.init?.redirect === 'error')).toBe(true)
})

it('isolates workspaces and resolves an alias to the same project bank', async () => {
  const f = await fixture(() => json({ results: [] }))
  const first = join(f.root, 'first'), second = join(f.root, 'second'), alias = join(f.root, 'alias')
  await mkdir(first); await mkdir(second); await symlink(first, alias, 'junction')
  for (const cwd of [first, second, alias]) await f.client.request({ action: 'recall', scope: 'project', query: '项目风格' }, cwd, f.signal)
  expect(f.calls[0]!.path).toBe(f.calls[2]!.path)
  expect(f.calls[0]!.path).not.toBe(f.calls[1]!.path)
  expect(f.calls[0]!.path).not.toContain(first)
  await expect(f.client.request({ action: 'status', scope: 'project' }, undefined, f.signal)).rejects.toThrow('project-required')
})

it.each(['https://memory.example', 'http://memory.example', 'http://127.0.0.1:9078/other', 'http://user:secret@127.0.0.1:9078'])('refuses a connection file pointing at %s', async (baseUrl) => {
  const f = await fixture(() => json({}))
  await writeFile(f.file, JSON.stringify({ baseUrl, token, namespace: 'fixture-muse' }))
  await expect(f.client.request({ action: 'status', scope: 'user' }, undefined, f.signal)).rejects.toThrow('invalid-config')
  expect(f.fetcher).not.toHaveBeenCalled()
})

it('distinguishes absent setup from invalid or publicly readable setup', async () => {
  const f = await fixture(() => json({}))
  if (process.platform !== 'win32') {
    await chmod(f.file, 0o644)
    await expect(f.client.request({ action: 'status', scope: 'user' }, undefined, f.signal)).rejects.toThrow('invalid-config')
  }
  await rm(f.file)
  await expect(f.client.request({ action: 'status', scope: 'user' }, undefined, f.signal)).rejects.toThrow('not-configured')
})

it('returns only bounded sourced facts and treats a missing bank as empty', async () => {
  let missing = false
  const f = await fixture(() => missing ? json({}, 404) : json({ results: [
    { id: 'm1', text: '年代短剧要上镜好看，妆造可以影视化。', metadata: { key: '审美', source: '用户确认', updated_at: '2026-10-17', internal: token } },
  ] }))
  const output = await f.client.request({ action: 'recall', scope: 'user', query: '角色妆造' }, undefined, f.signal)
  expect(output).toContain('用户确认'); expect(output).not.toContain(token)
  expect(body(f.calls[0]!.init?.body)).toMatchObject({ types: ['world', 'experience'], budget: 'low', max_tokens: 1200 })
  missing = true
  expect(JSON.parse(await f.client.request({ action: 'recall', scope: 'user', query: '审美' }, undefined, f.signal))).toMatchObject({ memories: [] })
})

it('does not report an invalid or unavailable retrieval as no matching memories', async () => {
  let status = 200
  const f = await fixture(() => json({ private_error: token }, status))
  await expect(f.client.request({ action: 'recall', scope: 'user', query: '审美' }, undefined, f.signal)).rejects.toThrow('invalid-response')
  status = 500
  await expect(f.client.request({ action: 'recall', scope: 'user', query: '审美' }, undefined, f.signal)).rejects.toThrow('unavailable')
})

it('omits unsourced upstream facts without inventing their origin or allowing them to consume the result limit', async () => {
  const f = await fixture(() => json({ results: [
    ...Array.from({ length: 8 }, (_, index) => ({ id: `unsourced-${index}`, text: 'An upstream inference without a source.' })),
    { id: 'blank-source', text: 'Whitespace is not a source.', metadata: { source: '  ' } },
    { id: 'confirmed', text: '好看、情绪和故事优先。', metadata: { source: '当前用户明确确认', key: '短剧审美' } },
  ] }))
  const output: unknown = JSON.parse(await f.client.request({ action: 'recall', scope: 'user', query: '短剧审美' }, undefined, f.signal))
  expect(output).toMatchObject({ omitted_unsourced: 9, memories: [{ id: 'confirmed', source: '当前用户明确确认', key: '短剧审美' }] })
  expect(output).toHaveProperty('memories', [expect.objectContaining({ id: 'confirmed' })])
})

it('retains one sourced preference asynchronously under a stable key and returns its original receipt', async () => {
  const f = await fixture((path, init) => {
    if (path.includes('/operations/')) return json({}, 404)
    if (path.endsWith('/operations')) return json({ operations: [] })
    if (init?.method === 'PUT') return json({})
    return json({ success: true, operation_id: operation })
  })
  const output = await f.client.request({ action: 'retain', scope: 'user', key: '审美', content: '用户要求角色好看、情绪到位。', source: '当前会话用户确认', operation_id: operation }, undefined, f.signal)
  expect(JSON.parse(output)).toMatchObject({ state: 'pending', operation_id: operation, key: '审美' })
  const submitted = f.calls.find(call => call.path.endsWith('/memories'))!
  expect(body(submitted.init?.body)).toMatchObject({ async: true, operation_id: operation, items: [{ context: 'Muse 用户确认的通用创作偏好', metadata: { source: '当前会话用户确认' } }] })
  expect(f.calls.filter(call => call.init?.method === 'POST')).toHaveLength(1)
})

it('keeps the original receipt when a submitted write loses its acknowledgement', async () => {
  const f = await fixture((path, init) => {
    if (path.includes('/operations/')) return json({}, 404)
    if (path.endsWith('/operations')) return json({ operations: [] })
    if (init?.method === 'PUT') return json({})
    throw Error('PRIVATE_NETWORK_DETAIL ' + token)
  })
  const output = await f.client.request({ action: 'retain', scope: 'user', key: '审美', content: '好看', source: '用户确认', operation_id: operation }, undefined, f.signal)
  expect(JSON.parse(output)).toMatchObject({ state: 'uncertain', operation_id: operation })
  expect(output).not.toContain(token)
  expect(f.calls.filter(call => call.init?.method === 'POST')).toHaveLength(1)
})

it('refuses deletion while an extraction is pending, and can query that original operation', async () => {
  const f = await fixture(path => json(path.includes('/operations/') ? { status: 'processing', secret: token } : { operations: [{ id: operation }] }))
  await expect(f.client.request({ action: 'forget', scope: 'user', key: '审美' }, undefined, f.signal)).rejects.toThrow('busy')
  expect(f.calls.some(call => call.init?.method === 'DELETE')).toBe(false)
  expect(JSON.parse(await f.client.request({ action: 'operation', scope: 'user', operation_id: operation }, undefined, f.signal))).toEqual({ state: 'processing', operation_id: operation })
})

it('reconciles an original retain before considering any new write', async () => {
  const f = await fixture(() => json({ status: 'pending' }))
  const output = await f.client.request({ action: 'retain', scope: 'user', key: '审美', content: '好看', source: '用户确认', operation_id: operation }, undefined, f.signal)
  expect(JSON.parse(output)).toMatchObject({ state: 'pending', operation_id: operation, reused: true })
  expect(f.calls).toHaveLength(1)
  expect(f.calls[0]!.init?.method).toBe('GET')
})

it('requires a receipt ID in the logged retain arguments before making a request', async () => {
  const f = await fixture(() => json({}))
  await expect(f.client.request({ action: 'retain', scope: 'user', key: '审美', content: '好看', source: '用户确认' }, undefined, f.signal)).rejects.toThrow('invalid-arguments')
  expect(f.calls).toHaveLength(0)
})

it('logs sourced memory as a tool result through a real Agent loop without extra model calls', async () => {
  const f = await fixture(() => json({ results: [{ id: 'memory-1', text: '角色妆造要上镜好看，情绪和故事优先。', metadata: { key: '短剧审美', source: '用户在会话中确认', updated_at: '2026-10-17' } }] }))
  const ctx = new Context()
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(f.fetcher)
  try {
    await ctx.plugin(SystemPrompt); await ctx.plugin(Tools); await ctx.plugin(Llm)
    await ctx.plugin(SessionStore); await ctx.plugin(SessionProjections)
    await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(Hindsight, Config({ connectionFile: f.file }))
    const adapter = new MockAdapter([
      toolCallResponse('memory-query', 'hindsight_memory', { action: 'recall', scope: 'user', query: '用户短剧审美偏好' }),
      textResponse('从本机历史记忆看，你要求角色上镜好看，情绪和故事优先。'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('hindsight-local-owner'), { provider: 'mock', model: 'mock' }, { cwd: f.root })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '我之前对短剧审美有什么要求？' }] }))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(1)
    expect(results[0]!.data.message.isError).toBeFalsy()
    expect(results[0]!.data.message.content).toMatchSnapshot('local creative preference with source')
    expect(f.calls).toHaveLength(1)
  } finally { fetch.mockRestore(); await ctx.fiber.dispose() }
})
