import { createHash } from 'node:crypto'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import * as PiAi from '../src/index.ts'
import { geminiAudioPayload, isDirectGeminiAudioEndpoint, readGeminiAudioResponse } from '../src/gemini-audio.ts'
import { memoryAuth } from './auth-double.ts'
import { closeMockServers, mockServer } from './mock-server.ts'

const provider = 'gemini-audio-fixture'
const model = 'gemini-review-fixture'
const officialOrigin = 'https://generativelanguage.googleapis.com'
const fixtureKey = 'gemini-fixture-test-key'
const profile = {
  apiKeyEnv: 'MUSE_TEST_GEMINI_AUDIO_KEY',
  api: 'google-generative-ai',
  baseURL: `${officialOrigin}/v1beta`,
  geminiAudioModel: model,
  models: [{ id: model }, { id: 'gemini-chat-fixture' }],
} satisfies PiAi.PiAiProviderProfile

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await closeMockServers()
})

function pcmWav(sample = 0, seconds = 0.1): Buffer {
  const wav = Buffer.alloc(44 + seconds * 16000)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(8000, 24)
  wav.writeUInt32LE(16000, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(wav.length - 44, 40)
  wav.writeInt16LE(sample, 84)
  return wav
}

function input(wav: readonly Uint8Array[] = [pcmWav()]) {
  return { provider, model, prompt: 'Return the JSON fixture.', wav }
}

function reply(text: string, includeMetadata = true) {
  return { events: [JSON.stringify({
    candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }],
    ...includeMetadata ? {
      responseId: 'gemini-fixture-response-7',
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
    } : {},
  })] }
}

async function transport() {
  vi.stubEnv(profile.apiKeyEnv, fixtureKey)
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(PiAi, { providers: { [provider]: {
    ...profile,
    headers: { 'x-goog-api-key': 'fixture-profile-override', 'x-audio-untrusted': 'fixture-only' },
  } } })
  return ctx.audioReviewTransport
}

function stubLoopbackFetch(url: string) {
  const platformFetch = globalThis.fetch
  const redirected = vi.fn<typeof globalThis.fetch>((target, init) => {
    const requested = new URL(typeof target === 'string' ? target : target instanceof URL ? target.href : target.url)
    if (requested.origin !== officialOrigin) throw new Error('Unexpected audio fixture destination')
    return platformFetch(`${url}${requested.pathname}${requested.search}`, init)
  })
  vi.stubGlobal('fetch', redirected)
  return redirected
}

it.each([true, false])('sends exact WAV bytes and retains only provider metadata when reported (%s)', async (metadata) => {
  const reported = { fixture: 'response', requestId: 'only-model-output', grantsApproval: true }
  const server = await mockServer([reply(JSON.stringify(reported), metadata)])
  const fetch = stubLoopbackFetch(server.url)
  const audio = await transport()
  expect(audio.configuredRoutes()).toEqual([{ provider, model }])
  const clips = [pcmWav(), pcmWav(17)]

  expect(await audio.request(input(clips))).toEqual({ provider, model,
    audioSha256: clips.map(clip => createHash('sha256').update(clip).digest('hex')),
    response: reported,
    ...metadata ? { requestId: 'gemini-fixture-response-7', usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } } : {},
    listeningVerified: false, grantsApproval: false })
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(server.paths).toEqual([`/v1beta/models/${model}:streamGenerateContent?alt=sse`])
  expect(server.headers[0]?.['x-goog-api-key']).toBe(fixtureKey)
  expect(server.headers[0]?.['x-audio-untrusted']).toBeUndefined()
  expect(server.requests[0]).toMatchObject({ contents: [{ role: 'user', parts: [{ text: input().prompt },
    ...clips.map(clip => ({ inlineData: { mimeType: 'audio/wav', data: clip.toString('base64') } }))] }],
  generationConfig: { responseMimeType: 'application/json' } })
  expect(server.requests[0]).not.toHaveProperty('tools')
})

it('lists only opted-in exact direct Gemini routes without resolving authentication or dispatching', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('Unexpected fixture I/O'))
  const resolveApiKey = vi.fn(() => Promise.reject(new Error('Unexpected credential resolution')))
  vi.stubGlobal('fetch', fetch)
  let profiles = PiAi.resolveProfiles(undefined)
  const adapter = new PiAi.PiAiAdapter({ profiles: () => profiles, resolveApiKey, auth: memoryAuth() })
  expect(adapter.configuredGeminiAudioRoutes()).toEqual([])
  const direct = { api: profile.api, baseURL: profile.baseURL, models: profile.models }
  const gateway = { ...profile, baseURL: 'https://relay.example.invalid/v1beta' }
  profiles = PiAi.resolveProfiles({
    [provider]: profile,
    secondary: { ...profile, baseURL: `${officialOrigin}/v1` },
    gateway,
    otherProtocol: { ...profile, api: 'openai-completions' },
    ambient: { ...direct, geminiAudioModel: model },
    noOptIn: { ...direct, apiKeyEnv: profile.apiKeyEnv },
    unlisted: { ...profile, geminiAudioModel: 'gemini-unlisted' },
    wrongModel: { ...profile, geminiAudioModel: 'other-model', models: [{ id: 'other-model' }] },
  })
  expect(adapter.configuredGeminiAudioRoutes()).toEqual([{ provider, model }, { provider: 'secondary', model }])

  profiles = PiAi.resolveProfiles({ [provider]: gateway })
  expect(adapter.configuredGeminiAudioRoutes()).toEqual([])
  await expect(adapter.requestGeminiAudio(input())).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  expect(resolveApiKey).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})

it('rejects invalid or oversized media and unlisted models before resolving a key', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('Unexpected fixture I/O'))
  const resolveApiKey = vi.fn(async () => fixtureKey)
  vi.stubGlobal('fetch', fetch)
  const adapter = new PiAi.PiAiAdapter({ profiles: () => PiAi.resolveProfiles({ [provider]: profile }), resolveApiKey, auth: memoryAuth() })
  await expect(adapter.requestGeminiAudio(input([pcmWav().subarray(0, 48)]))).rejects.toThrow('PCM WAV')
  await expect(adapter.requestGeminiAudio(input([pcmWav(0, 121)]))).rejects.toThrow('PCM WAV')
  await expect(adapter.requestGeminiAudio(input([pcmWav(0, 100), pcmWav(0, 81)]))).rejects.toThrow('PCM WAV')
  await expect(adapter.requestGeminiAudio(input([Buffer.alloc(8 * 1024 * 1024 + 1)]))).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  await expect(adapter.requestGeminiAudio({ ...input(), prompt: 'X'.repeat(32769) })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  await expect(adapter.requestGeminiAudio({ ...input(), model: 'gemini-chat-fixture' })).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  expect(resolveApiKey).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})

it('rejects already-aborted requests and never falls back from a missing configured key', async () => {
  vi.stubEnv('GEMINI_API_KEY', 'unrelated-ambient-fixture-key')
  const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('Unexpected fixture I/O'))
  const resolveApiKey = vi.fn(async () => undefined)
  vi.stubGlobal('fetch', fetch)
  const adapter = new PiAi.PiAiAdapter({ profiles: () => PiAi.resolveProfiles({ [provider]: profile }), resolveApiKey, auth: memoryAuth() })
  const controller = new AbortController()
  controller.abort()
  await expect(adapter.requestGeminiAudio({ ...input(), signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' })
  expect(resolveApiKey).not.toHaveBeenCalled()
  await expect(adapter.requestGeminiAudio(input())).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  expect(resolveApiKey).toHaveBeenCalledTimes(1)
  expect(fetch).not.toHaveBeenCalled()
})

it('aborts one in-progress request without returning findings or retrying it', async () => {
  const server = await mockServer([{ ...reply('{"partial":'), holdOpen: true }])
  const fetch = stubLoopbackFetch(server.url)
  const audio = await transport()
  const controller = new AbortController()
  const result = audio.request({ ...input(), signal: controller.signal })
  const aborted = expect(result).rejects.toMatchObject({ code: 'ABORTED' })
  await server.requestReceived
  controller.abort()
  await aborted
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('reaches its deadline during credential resolution and never dispatches a late request', async () => {
  vi.useFakeTimers()
  const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('Unexpected fixture I/O'))
  vi.stubGlobal('fetch', fetch)
  const pending = Promise.withResolvers<string>()
  const resolveApiKey = vi.fn(() => pending.promise)
  const adapter = new PiAi.PiAiAdapter({ profiles: () => PiAi.resolveProfiles({ [provider]: profile }), resolveApiKey, auth: memoryAuth() })
  const bound = expect(adapter.requestGeminiAudio(input())).rejects.toMatchObject({ code: 'TIMEOUT' })
  await vi.advanceTimersByTimeAsync(90_000)
  await bound
  pending.resolve(fixtureKey)
  await vi.advanceTimersByTimeAsync(1)
  expect(resolveApiKey).toHaveBeenCalledTimes(1)
  expect(fetch).not.toHaveBeenCalled()
})

it('rejects non-JSON output and does not replay an unsuccessful provider request', async () => {
  const server = await mockServer([
    reply('{"not-finished":'),
    { status: 429, body: '{"error":{"code":429,"message":"fixture quota exhausted","status":"RESOURCE_EXHAUSTED"}}' },
  ])
  const fetch = stubLoopbackFetch(server.url)
  const audio = await transport()
  const onProviderResponse = vi.fn(async () => {})
  const wav = pcmWav()
  const request = { ...input([wav]), onProviderResponse }
  await expect(audio.request(request)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  expect(onProviderResponse).toHaveBeenCalledExactlyOnceWith({ provider, model,
    audioSha256: [createHash('sha256').update(wav).digest('hex')],
    requestId: 'gemini-fixture-response-7', usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } })
  await expect(audio.request(request)).rejects.toThrow()
  expect(onProviderResponse).toHaveBeenCalledTimes(1)
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(server.paths).toHaveLength(2)
})

it.each([
  undefined,
  'not a URL',
  'http://generativelanguage.googleapis.com/v1beta',
  'https://generativelanguage.googleapis.com.attacker.invalid/v1beta',
  `${officialOrigin}:8443/v1beta`,
  'https://user@generativelanguage.googleapis.com/v1beta',
  `${officialOrigin}/v1beta?target=elsewhere`,
  `${officialOrigin}/v1beta#extra`,
  `${officialOrigin}/alternate`,
  'http://127.0.0.1:12000/v1beta',
])('refuses a non-direct Gemini audio endpoint (%s)', (endpoint) => {
  expect(isDirectGeminiAudioEndpoint(endpoint)).toBe(false)
})

it.each([
  null,
  { contents: [], config: {} },
  { contents: [{ role: 'user', parts: [] }], config: {} },
  { contents: [{ role: 'model', parts: [{ text: 'fixture' }] }], config: {} },
  { contents: [{ role: 'user', parts: [{ text: 'fixture' }] }] },
])('rejects a mismatched SDK request before adding WAV bytes (%j)', (payload) => {
  expect(() => geminiAudioPayload(payload, [])).toThrow('isolated Gemini audio payload')
})

async function* responseStream(chunks: readonly StreamChunk[]): AsyncGenerator<StreamChunk> {
  yield* chunks
}

const finish: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }
const textBlock = (text: string, index = 0): StreamChunk => ({ type: 'block-end', index, block: { type: 'text', text } })

it.each<readonly [string, readonly StreamChunk[]]>([
  ['stream ended without a terminal message', [textBlock('{}')]],
  ['stream returned data after the terminal message', [finish, textBlock('{}')]],
  ['stream exceeded the reply budget', [{ type: 'reasoning-delta', index: 0, text: 'x'.repeat(65537) }, finish]],
  ['stream tried a tool call', [{ type: 'tool-call-delta', index: 0, id: ToolCallId('fixture'), argumentsDelta: '{}' }, finish]],
  ['stream exhausted its output tokens', [textBlock('{}'), { type: 'finish', reason: { kind: 'max-tokens' } }]],
  ['stream ended without an answer block', [finish]],
  ['stream only exceeded the budget in its final block', [textBlock('x'.repeat(65537)), finish]],
  ['stream produced two answers', [textBlock('{}'), textBlock('{}', 1), finish]],
  ['stream returned a JSON array', [textBlock('[]'), finish]],
])('rejects the audio reply when %s', async (_label, chunks) => {
  await expect(readGeminiAudioResponse(responseStream(chunks))).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
})
