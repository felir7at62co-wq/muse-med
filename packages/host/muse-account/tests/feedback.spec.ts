import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MessageId, Message } from '@deepseek-ai/dsh-llm'
import { MuseFeedbackClient, feedbackSecrets } from '../src/feedback.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import * as DeepSeekApiKey from '../../../llm/llm-deepseek-api-key/src/index.ts'
import { writeMuseSession, readMuseSession, clearMuseSessionIfUnchanged } from '../src/session.ts'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const sessionId = 'session-one' as SessionId
const messageId = 'answer-one' as MessageId
const request = { sessionId, target: { kind: 'message', messageId, rating: 'negative' }, category: 'instruction-following', text: 'Wrong animal', includeDiagnostics: false } as const
function bodyOf(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') throw new Error('Feedback must have a JSON string body')
  return init.body
}
const messages: Message[] = [
  { id: 'user-one' as MessageId, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Write my bird story private-api-value' }] },
  { id: messageId, role: 'assistant', content: [{ type: 'text', text: 'The cat speaks.' }, { type: 'reasoning', text: 'Never upload reasoning' }], source: { kind: 'model', provider: 'test', model: 'test' } },
  { id: 'user-two' as MessageId, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Unrelated future request' }] },
]
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'muse-feedback-')); dirs.push(dir)
  const baseUrl = 'https://muse.test', sessionFile = join(dir, 'session.json')
  await writeMuseSession(sessionFile, { baseUrl, cookie: '__Host-muse=private-cookie-value', username: 'alice' })
  const seen: RequestInit[] = []
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    if (!init) throw new Error('No feedback request')
    seen.push(init)
    const body: unknown = JSON.parse(bodyOf(init))
    return new Response(JSON.stringify({ ...(body as object), id: 'a'.repeat(32), username: 'alice', revision: 1 }), { status: 201 })
  })
  const options = { baseUrl, sessionFile, requestTimeoutMs: 1000, excerptChars: 200, readMessages: () => messages, secrets: async () => ['private-api-value'], fetcher }
  return { options, seen, client: new MuseFeedbackClient(options) }
}

it('accepts only a matching durable receipt and preserves seven-category and message identity without automatic excerpts', async () => {
  const { client, seen } = await fixture()
  expect(await client.submit(request)).toEqual({ id: 'a'.repeat(32), revision: 1 })
  const sent = bodyOf(seen[0])
  expect(sent).toContain('instruction-following'); expect(sent).toContain(messageId); expect(sent).toContain('Wrong animal')
  expect(sent).not.toContain('The cat'); expect(sent).not.toContain('private-cookie-value')
  expect(JSON.parse(sent)).toMatchInlineSnapshot(`
    {
      "body": "Source: Muse Desktop
    Target: message
    Session: session-one

    Message: answer-one
    Rating: negative

    Category: instruction-following
    Feedback:
    Wrong animal",
      "category": "bug",
      "title": "Muse Desktop · Message feedback",
    }
  `)
  expect(new Headers(seen[0]!.headers).get('origin')).toBe('https://muse.test')
  expect(new Headers(seen[0]!.headers).get('cookie')).toBe('__Host-muse=private-cookie-value')
  expect(seen[0]!.redirect).toBe('manual')
})

it('includes only the associated visible request and answer with known credentials removed when selected', async () => {
  const { client, seen } = await fixture()
  await client.submit({ ...request, includeDiagnostics: true })
  const sent = bodyOf(seen[0])
  expect(sent).toContain('Write my bird story [redacted]'); expect(sent).toContain('The cat speaks.')
  expect(sent).not.toContain('Never upload reasoning'); expect(sent).not.toContain('Unrelated future'); expect(sent).not.toContain('private-api-value')
})

it('prevents sending with a new account when credentials change during preparation', async () => {
  const { options, seen } = await fixture()
  const client = new MuseFeedbackClient({ ...options, secrets: async () => {
    await writeMuseSession(options.sessionFile, { baseUrl: options.baseUrl, cookie: '__Host-muse=other', username: 'bob' })
    return []
  } })
  await expect(client.submit(request)).rejects.toMatchObject({ code: 'account-changed' })
  expect(seen).toHaveLength(0)
})

it('records task target without pretending that the unselected transcript was attached', async () => {
  const { client, seen } = await fixture()
  await client.submit({ ...request, target: { kind: 'session' }, category: 'resource-cost' })
  const sent = bodyOf(seen[0])
  expect(sent).toContain('Target: session'); expect(sent).toContain('resource-cost')
  expect(sent).not.toContain('The cat speaks.'); expect(sent).not.toContain('Message:')
})

it('reports an account switch during a confirmed POST without sending again under the new account', async () => {
  const { options } = await fixture()
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const body: unknown = JSON.parse(bodyOf(init))
    await writeMuseSession(options.sessionFile, { baseUrl: options.baseUrl, cookie: '__Host-muse=other', username: 'bob' })
    return new Response(JSON.stringify({ ...(body as object), id: 'a'.repeat(32), username: 'alice', revision: 1 }), { status: 201 })
  })
  await expect(new MuseFeedbackClient({ ...options, fetcher }).submit(request)).rejects.toMatchObject({ code: 'account-changed' })
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it.each([303, 401, 429, 500, 200])('does not acknowledge a non-create response (%s)', async (status) => {
  const { options } = await fixture()
  const client = new MuseFeedbackClient({ ...options, fetcher: async () => new Response('{}', { status }) })
  await expect(client.submit(request)).rejects.toBeInstanceOf(Error)
})

it('refuses mismatched receipts and never repeats an uncertain write', async () => {
  const { options } = await fixture()
  const invalid = new MuseFeedbackClient({ ...options, fetcher: async () => new Response(JSON.stringify({ id: 'a'.repeat(32), username: 'bob', revision: 1 }), { status: 201 }) })
  await expect(invalid.submit(request)).rejects.toMatchObject({ code: 'unconfirmed' })
  const fetcher: typeof fetch = vi.fn(async () => { throw new Error('private upstream detail') })
  await expect(new MuseFeedbackClient({ ...options, fetcher }).submit(request)).rejects.toMatchObject({ code: 'unconfirmed', message: 'MUSE feedback: unconfirmed' })
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('retains a sign-in failure before any write and rejects HTML disguised as a created record', async () => {
  const { options, seen } = await fixture()
  const stored = await readMuseSession(options.sessionFile, options.baseUrl)
  if (!stored) throw new Error('No stored test session')
  await clearMuseSessionIfUnchanged(options.sessionFile, stored)
  await expect(new MuseFeedbackClient(options).submit(request)).rejects.toMatchObject({ code: 'sign-in-required' })
  expect(seen).toHaveLength(0)
  await writeMuseSession(options.sessionFile, { baseUrl: options.baseUrl, username: 'alice', cookie: '__Host-muse=private-cookie-value' })
  await expect(new MuseFeedbackClient({ ...options, fetcher: async () => new Response('<html>login</html>', { status: 201 }) }).submit(request))
    .rejects.toMatchObject({ code: 'unconfirmed' })
})

it('does not upload a missing target, oversized note or unavailable diagnostics', async () => {
  const { options, seen } = await fixture()
  await expect(new MuseFeedbackClient({ ...options, readMessages: () => [] }).submit(request)).rejects.toMatchObject({ code: 'invalid-input' })
  await expect(new MuseFeedbackClient(options).submit({ ...request, text: 'x'.repeat(5001) })).rejects.toMatchObject({ code: 'invalid-input' })
  await expect(new MuseFeedbackClient({ ...options, secrets: async () => { throw new Error('private') } }).submit({ ...request, includeDiagnostics: true })).rejects.toMatchObject({ code: 'unavailable' })
  expect(seen).toHaveLength(0)
})

it('redacts both credential records and configured references rather than returning them in diagnostic fields', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemoryCredentials)
    await ctx.credentials.modifyRecord(credentialKey('provider', 'test'), async () => ({ kind: 'api-key', key: 'record-secret-value' }))
    expect(await feedbackSecrets(ctx)).toContain('record-secret-value')
  } finally { await ctx.fiber.dispose() }
  const configured = await configurationFixture({ hmr: false, rows: [
    { id: 'config-editor', name: 'cordis:editor' }, { id: 'settings', name: 'cordis:settings' },
    { id: 'credentials', name: 'cordis:credentials', config: { MY_CUSTOM_REF: 'custom-reference-value' } },
    { id: 'llm', name: 'cordis:llm' }, { id: 'deepseek', name: 'cordis:deepseek', config: { apiKeyEnv: 'MY_CUSTOM_REF' } },
  ], builtins: { llm: LlmRuntime, credentials: MemoryCredentials, deepseek: DeepSeekApiKey } })
  expect(await feedbackSecrets(configured.ctx)).toContain('custom-reference-value')
})

it('sends the authenticated JSON body through an actual HTTP listener and receives its saved receipt', async () => {
  const setup = await fixture(), received: string[] = []
  const routes: Array<{ url: string | undefined; method: string | undefined; cookie: string | undefined }> = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.on('end', () => {
      received.push(Buffer.concat(chunks).toString('utf8'))
      routes.push({ url: req.url, method: req.method, cookie: req.headers.cookie })
      const value: unknown = JSON.parse(received[0]!)
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ...(value as object), id: 'a'.repeat(32), username: 'alice', revision: 1 }))
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    await writeMuseSession(setup.options.sessionFile, { baseUrl, username: 'alice', cookie: '__Host-muse=private-cookie-value' })
    const { fetcher: _fetcher, ...options } = setup.options
    expect(await new MuseFeedbackClient({ ...options, baseUrl }).submit(request)).toEqual({ id: 'a'.repeat(32), revision: 1 })
    expect(received).toHaveLength(1)
    expect(routes).toEqual([{ url: '/api/muse.feedback', method: 'POST', cookie: '__Host-muse=private-cookie-value' }])
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
  }
})
