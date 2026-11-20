/** Account-owned adapter requests reach the header waterfall with isolated relay attribution. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { mockServer, closeMockServers, textEvents } from '../../../llm/llm-pi-ai/tests/mock-server.ts'
import { assemble } from '../../../llm/llm-pi-ai/tests/assemble.ts'
import { MuseModels } from '../src/models.ts'
import { writeMuseSession } from '../src/session.ts'

const cleanup: (() => Promise<unknown>)[] = []
const catalog = { providers: [{ id: 'studio', name: 'Studio', models: [{ id: 'writer', name: 'Writer',
  contextWindow: 128000, maxTokens: 8192, input: ['text'], reasoningEfforts: false }] }] }
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  await closeMockServers()
  vi.restoreAllMocks()
})

it('preserves public contributions and isolates relay wire attribution and retry receipts', async () => {
  const events = textEvents.map(text => text === '[DONE]' ? text : JSON.stringify({ ...JSON.parse(text), id: 'chatcmpl-safe', model: 'actual-writer' }))
  const server = await mockServer([{ status: 502, body: '{"error":{"message":"private-upstream-body"}}' }, { events }, { events }, { events }])
  const root = await mkdtemp(join(tmpdir(), 'muse-trace-wire-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  const records: string[] = []
  vi.spyOn(ctx.logger, 'info').mockImplementation((message) => { records.push(String(message)) })
  const baseUrl = server.url
  const sessionFile = join(root, 'session.json')
  const fetched: string[] = []
  await writeMuseSession(sessionFile, { baseUrl, username: 'alice', cookie: '__Host-muse=private-login-cookie' })
  const models = new MuseModels(ctx, { baseUrl, sessionFile, requestTimeoutMs: 1000,
    fetcher: async (url) => {
      fetched.push(new URL(url instanceof Request ? url.url : url).pathname)
      return Response.json(catalog)
    } })
  cleanup.push(() => models.dispose())
  const seen: string[] = []
  ctx.on('llm-pi-ai/request-headers', (request, headers, next) => {
    seen.push(String(request.sessionId))
    headers.set('x-contributed', 'public-waterfall')
    headers.set('x-contributed-session', String(request.sessionId))
    headers.set('x-muse-client-request-id', 'spoofed-contribution')
    return next()
  })
  await models.refresh()
  const request = { provider: 'muse-cloud-studio', model: 'writer', sessionId: SessionId('retry-session'), messages: [] }
  expect((await assemble(ctx, request)).finish.kind).toBe('error')
  expect((await assemble(ctx, request)).finish.kind).toBe('stop')
  await Promise.all(['concurrent-a', 'concurrent-b'].map(id => assemble(ctx, { ...request, sessionId: SessionId(id) })))
  expect(seen.slice(0, 2)).toEqual(['retry-session', 'retry-session'])
  expect(seen.slice(2).toSorted()).toEqual(['concurrent-a', 'concurrent-b'])
  expect(server.headers.map(headers => headers['x-contributed'])).toEqual(Array(4).fill('public-waterfall'))
  const logSchema = z.object({ event: z.literal('model_client_request_metadata'), phase: z.enum(['start', 'finish']),
    client_request_id: z.string(), session_id: z.string(), response_id: z.string().nullable().optional(),
    response_model: z.string().nullable().optional(), stop: z.string().nullable().optional() })
  const parsed = records.filter(record => record.startsWith('{')).flatMap((record) => {
    const value = logSchema.safeParse(JSON.parse(record))
    return value.success ? [value.data] : []
  })
  const starts = parsed.filter(record => record.phase === 'start'), ends = parsed.filter(record => record.phase === 'finish')
  expect(starts).toHaveLength(4); expect(ends).toHaveLength(4)
  expect(new Set(starts.map(record => record.client_request_id)).size).toBe(4)
  expect(ends.map(record => record.client_request_id).toSorted()).toEqual(starts.map(record => record.client_request_id).toSorted())
  expect(ends[1]).toMatchObject({ session_id: 'retry-session', response_id: 'chatcmpl-safe', response_model: 'actual-writer', stop: 'stop' })
  const identities = new Map(starts.map(record => [record.client_request_id, record.session_id]))
  expect(fetched).toEqual(['/api/desktop-models/providers'])
  expect(server.paths).toEqual(Array(4).fill('/api/desktop-models/studio/chat/completions'))
  for (const headers of server.headers) {
    const id = headers['x-muse-client-request-id']
    expect(typeof id).toBe('string')
    expect(identities.get(String(id))).toBe(headers['x-contributed-session'])
  }
  expect(JSON.stringify(records)).not.toMatch(/private-login-cookie|private-upstream-body/u)
})

it('redacts a reflected real relay request credential without changing replay metadata', async () => {
  const canary = 'private-login-canary'
  const events = textEvents.map(text => text === '[DONE]' ? text
    : JSON.stringify({ ...JSON.parse(text), id: `chatcmpl-${canary}`, model: `model-${canary}` }))
  const server = await mockServer([{ status: 502, headers: { 'x-request-id': `request-${canary}` }, body: '{}' }, { events }])
  const root = await mkdtemp(join(tmpdir(), 'muse-trace-reflection-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  const records: string[] = []
  vi.spyOn(ctx.logger, 'info').mockImplementation((message) => { records.push(String(message)) })
  vi.spyOn(ctx.logger, 'warn').mockImplementation((message) => { records.push(String(message)) })
  const baseUrl = server.url
  const sessionFile = join(root, 'session.json')
  await writeMuseSession(sessionFile, { baseUrl, username: 'alice', cookie: `__Host-muse=${canary}` })
  const models = new MuseModels(ctx, { baseUrl, sessionFile, requestTimeoutMs: 1000,
    fetcher: async () => Response.json(catalog) })
  cleanup.push(() => models.dispose())
  await models.refresh()
  const request = { provider: 'muse-cloud-studio', model: 'writer', sessionId: SessionId('reflection-session'), messages: [] }
  expect((await assemble(ctx, request)).finish.kind).toBe('error')
  const result = await assemble(ctx, request)
  expect(result.finish.kind).toBe('stop')
  expect(server.headers.map(headers => headers.authorization)).toEqual([`Bearer ${canary}`, `Bearer ${canary}`])
  expect(JSON.stringify(result.message)).toContain(canary)
  expect(JSON.stringify(records)).not.toContain(canary)
  const ends = records.filter(record => record.startsWith('{')).map((record): unknown => JSON.parse(record))
  expect(ends.at(-1)).toMatchObject({ phase: 'finish', response_id: null, response_model: null })
})

it('excludes a credential reflected through installed SDK usage parsing without changing caller usage', async () => {
  const canary = 'private-login-usage-canary'
  const events = textEvents.map((text) => {
    if (text === '[DONE]') return text
    const frame = JSON.parse(text) as { usage?: object }
    return JSON.stringify(frame.usage === undefined ? frame : { ...frame,
      usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: canary } } })
  })
  const server = await mockServer([{ events }])
  const root = await mkdtemp(join(tmpdir(), 'muse-trace-usage-reflection-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  const records: string[] = []
  vi.spyOn(ctx.logger, 'info').mockImplementation((message) => { records.push(String(message)) })
  const baseUrl = server.url
  const sessionFile = join(root, 'session.json')
  await writeMuseSession(sessionFile, { baseUrl, username: 'alice', cookie: `__Host-muse=${canary}` })
  const models = new MuseModels(ctx, { baseUrl, sessionFile, requestTimeoutMs: 1000,
    fetcher: async () => Response.json(catalog) })
  cleanup.push(() => models.dispose())
  await models.refresh()
  const result = await assemble(ctx, { provider: 'muse-cloud-studio', model: 'writer',
    sessionId: SessionId('usage-reflection-session'), messages: [] })
  expect(result.finish.kind).toBe('stop')
  expect(server.requests).toHaveLength(1)
  expect(server.headers[0]?.authorization).toBe(`Bearer ${canary}`)
  expect(result.usage).toEqual({ inputTokens: Number.NaN, outputTokens: 1, totalTokens: `NaN${canary}0` })
  const ends = records.filter(record => record.startsWith('{')).map((record): unknown => JSON.parse(record))
  expect(ends.at(-1)).toMatchObject({ phase: 'finish', usage: { outputTokens: 1 } })
  expect(JSON.stringify(records)).not.toContain(canary)
})
