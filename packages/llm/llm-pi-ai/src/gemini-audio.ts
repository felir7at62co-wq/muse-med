/** Bounded inline WAV transfer for trusted Host callers on a direct Gemini route. */
import { createHash } from 'node:crypto'
import { audioReviewWavDuration, BlockAssembler, LlmError, ProviderRequestId } from '@deepseek-ai/dsh-llm'
import type { AudioReviewProviderResponse, AudioReviewRequest, StreamChunk } from '@deepseek-ai/dsh-llm'

const MAX_AUDIO_BYTES = 8 * 1024 * 1024
const MAX_RESULT_BYTES = 64 * 1024

/** Admit only the official Google Generative Language API origin and version. */
export function isDirectGeminiAudioEndpoint(value: string | undefined): boolean {
  if (value === undefined) return false
  const url = URL.parse(value)
  return url !== null && url.protocol === 'https:' && url.hostname === 'generativelanguage.googleapis.com'
    && url.port === '' && url.username === '' && url.password === '' && url.search === '' && url.hash === ''
    && (url.pathname === '/v1' || url.pathname === '/v1beta')
}

function invalidWav(): never {
  throw new LlmError('Gemini audio transport requires a complete bounded 16-bit PCM WAV.', 'INVALID_REQUEST')
}

/** Copy and validate the exact media bytes before any credential lookup or I/O. */
export function prepareGeminiAudio(input: AudioReviewRequest) {
  if (!input.prompt.trim() || Buffer.byteLength(input.prompt) > 32 * 1024 || !input.wav.length || input.wav.length > 4
    || input.wav.reduce((size, clip) => size + clip.byteLength, 0) > MAX_AUDIO_BYTES) {
    throw new LlmError('Gemini audio transport input exceeds its bounded prompt or audio limits.', 'INVALID_REQUEST')
  }
  const clips = input.wav.map(clip => Buffer.from(clip))
  const seconds = clips.map(audioReviewWavDuration)
  if (seconds.some(duration => duration === undefined || duration > 120)
    || seconds.reduce<number>((sum, duration) => sum + (duration ?? 0), 0) > 180) invalidWav()
  return {
    parts: clips.map(clip => ({ inlineData: { data: clip.toString('base64'), mimeType: 'audio/wav' } })),
    audioSha256: clips.map(clip => createHash('sha256').update(clip).digest('hex')),
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Add audio only to the dedicated direct SDK request, preserving cancellation and request controls. */
export function geminiAudioPayload(payload: unknown, parts: ReturnType<typeof prepareGeminiAudio>['parts']): unknown {
  const body = record(payload)
  const contents = body?.contents
  const message = Array.isArray(contents) && contents.length === 1 ? record(contents[0]) : undefined
  const prompt = Array.isArray(message?.parts) && message.parts.length === 1 ? record(message.parts[0]) : undefined
  const config = record(body?.config)
  if (message?.role !== 'user' || typeof prompt?.text !== 'string' || config === undefined) {
    throw new LlmError('Could not prepare the isolated Gemini audio payload.', 'INVALID_REQUEST')
  }
  return { ...body, contents: [{ role: 'user', parts: [{ text: prompt.text }, ...parts] }],
    config: { ...config, responseMimeType: 'application/json' } }
}

type ResponseFacts = Pick<AudioReviewProviderResponse, 'requestId' | 'usage'>
type ParsedResponse = ResponseFacts & { response: Readonly<Record<string, unknown>> }

/** Return only a bounded JSON object from a clean, terminal provider response. */
export async function readGeminiAudioResponse(stream: AsyncIterable<StreamChunk>,
  onResponse?: (facts: ResponseFacts) => Promise<void>): Promise<ParsedResponse> {
  const assembler = new BlockAssembler()
  let bytes = 0
  let finished: Extract<StreamChunk, { type: 'finish' }> | undefined
  const invalid = () => new LlmError('Gemini audio transport did not return a complete JSON object.', 'INVALID_RESPONSE')
  for await (const chunk of stream) {
    if (finished) throw invalid()
    if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') bytes += Buffer.byteLength(chunk.text)
    if (bytes > MAX_RESULT_BYTES || chunk.type === 'tool-call-delta') throw invalid()
    if (chunk.type === 'finish') finished = chunk
    assembler.push(chunk)
  }
  if (finished === undefined) throw invalid()
  const replay = record(finished.replayState?.response)
  const id = replay?.responseId
  const requestId = replay?.kind === 'pi-ai' && replay.api === 'google-generative-ai'
    && typeof id === 'string' && /^[\x21-\x7e]{1,256}$/u.test(id) ? ProviderRequestId(id) : undefined
  const usage = assembler.usage
  const counters = [usage?.inputTokens, usage?.outputTokens, usage?.totalTokens,
    usage?.cacheReadTokens, usage?.cacheWriteTokens, usage?.reasoningTokens]
  // The SDK supplies zero counters when the provider sends no usage metadata.
  const usable = counters.every(count => count === undefined || Number.isSafeInteger(count) && count >= 0)
    && counters.some(count => count !== undefined && count > 0)
  const facts: ResponseFacts = { ...(requestId === undefined ? {} : { requestId }),
    ...(usable && usage !== undefined ? { usage } : {}) }
  if (requestId !== undefined || facts.usage !== undefined) await onResponse?.(facts)
  if (finished.reason.kind === 'error') {
    throw LlmError.fromFailure({ ...finished.reason.failure, message: 'The direct Gemini audio review request failed.' })
  }
  if (finished.reason.kind !== 'stop') throw invalid()
  const blocks = assembler.blocks()
  const last = blocks.at(-1)
  if (last?.type !== 'text' || Buffer.byteLength(last.text) > MAX_RESULT_BYTES
    || blocks.slice(0, -1).some(block => block.type !== 'reasoning')) throw invalid()
  let parsed: unknown
  try { parsed = JSON.parse(last.text) } catch { throw invalid() }
  const result = record(parsed)
  if (result === undefined) throw invalid()
  return { response: result, ...facts }
}
