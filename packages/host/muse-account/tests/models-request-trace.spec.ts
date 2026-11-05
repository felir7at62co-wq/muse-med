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

it.each(['relay', 'direct'] as const)('preserves public contributions and isolates %s wire attribution and retry receipts', async (transport) => {
  const events = textEvents.map(text => text === '[DONE]' ? text : JSON.stringify({ ...JSON.parse(text), id: 'chatcmpl-safe', model: 'actual-writer' }))
  const server = await mockServer([{ status: 502, body: '{"error":{"message":"private-upstream-body"}}' }, { events }, { events }, { events }])
  const root = await mkdtemp(join(tmpdir(), 'muse-trace-wire-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  const records: string[] = []
  vi.spyOn(ctx.logger, 'info').mockImplementation((message) => { records.push(String(message)) })
  const baseUrl = transport === 'relay' ? server.url : 'https://company.test'
  const sessionFile = join(root, 'session.json')
  await writeMuseSession(sessionFile, { baseUrl, username: 'alice', cookie: '__Host-muse=private-login-cookie' })
  const models = new MuseModels(ctx, { baseUrl, sessionFile, requestTimeoutMs: 1000,
    fetcher: async (url) => {
      const path = new URL(url instanceof Request ? url.url : url).pathname
      return Response.json(transport === 'relay' || path.endsWith('/providers') ? { ...catalog, transport }
        : { transport: 'direct', providers: [{ ...catalog.providers[0], access: { baseURL: `${server.url}/v1`, apiKey: 'private-supplier-key' } }] })
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
  for (const headers of server.headers) {
    const id = headers['x-muse-client-request-id']
    if (transport === 'relay') {
      expect(typeof id).toBe('string')
      expect(identities.get(String(id))).toBe(headers['x-contributed-session'])
    } else expect(id).toBeUndefined()
  }
  expect(JSON.stringify(records)).not.toMatch(/private-login-cookie|private-supplier-key|private-upstream-body/u)
})

it.each(['relay', 'direct', 'leased'] as const)('redacts a reflected real %s request credential without changing replay metadata', async (transport) => {
  const token = 'private-login-canary', key = 'private-supplier-canary', leasedKey = 'private-leased-canary'
  const canary = transport === 'relay' ? token : transport === 'direct' ? key : leasedKey
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
  const baseUrl = transport === 'relay' ? server.url : 'https://company.test'
  const sessionFile = join(root, 'session.json')
  await writeMuseSession(sessionFile, { baseUrl, username: 'alice', cookie: `__Host-muse=${token}` })
  const provider = transport === 'leased' ? { ...catalog.providers[0], id: 'zhipu-official', transport: 'leased' } : catalog.providers[0]
  const models = new MuseModels(ctx, { baseUrl, sessionFile, requestTimeoutMs: 1000,
    fetcher: async (url, init) => {
      const path = new URL(url instanceof Request ? url.url : url).pathname
      if (path.endsWith('/providers')) return Response.json({ ...catalog, transport: transport === 'relay' ? 'relay' : 'direct' })
      if (path.endsWith('/access')) return Response.json({ transport: 'direct', providers: [transport === 'direct'
        ? { ...provider, access: { baseURL: `${server.url}/v1`, apiKey: key } } : provider] })
      if (init?.method === 'POST') return Response.json({ id: 'c0b928a2-9bea-416b-80f0-cbd051fba1c9', apiKey: leasedKey,
        baseURL: `${server.url}/v1`, deadline: Date.now() + 60000, requestMs: 60000, checkMs: 1000 })
      return Response.json({ released: true })
    } })
  cleanup.push(() => models.dispose())
  await models.refresh()
  const request = { provider: transport === 'leased' ? 'muse-cloud-zhipu-official' : 'muse-cloud-studio',
    model: 'writer', sessionId: SessionId('reflection-session'), messages: [] }
  expect((await assemble(ctx, request)).finish.kind).toBe('error')
  const result = await assemble(ctx, request)
  expect(result.finish.kind).toBe('stop')
  expect(server.headers.map(headers => headers.authorization)).toEqual([`Bearer ${canary}`, `Bearer ${canary}`])
  expect(JSON.stringify(result.message)).toContain(canary)
  expect(JSON.stringify(records)).not.toMatch(/private-login-canary|private-supplier-canary|private-leased-canary/u)
  const ends = records.filter(record => record.startsWith('{')).map((record): unknown => JSON.parse(record))
  expect(ends.at(-1)).toMatchObject({ phase: 'finish', response_id: null, response_model: null })
})
