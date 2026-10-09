/** Safe diagnostics preserve routing facts without retaining supplier-controlled strings. */
import { expect, it } from 'vitest'
import { LlmError, ProviderRequestId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { safeMuseModelStream } from '../src/model-errors.ts'

async function collect(source: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of source) chunks.push(chunk)
  return chunks
}

it('preserves successful stream chunks and replay metadata', async () => {
  const chunks: StreamChunk[] = [{ type: 'text-delta', index: 0, text: 'Result' }, { type: 'finish', reason: { kind: 'stop' } }]
  async function* source() { yield* chunks }
  expect(await collect(safeMuseModelStream(source))).toEqual(chunks)
})

it.each(['max-tokens', 'tool-calls'] as const)('preserves %s recovery and continuation metadata', async (kind) => {
  const chunks: StreamChunk[] = [{ type: 'text-delta', index: 0, text: 'Partial result' },
    { type: 'usage', usage: { inputTokens: 30, outputTokens: 100, totalTokens: 130 } },
    { type: 'finish', reason: { kind }, replayState: { response: { model: 'fixture-model', stopReason: kind } } }]
  async function* source() { yield* chunks }
  expect(await collect(safeMuseModelStream(source))).toEqual(chunks)
})

it.each(['CONTEXT_WINDOW_EXCEEDED', 'EMPTY_RESPONSE', 'TRANSPORT', 'SERVER', 'TIMEOUT', 'QUOTA', 'INVALID_REQUEST'])(
  'preserves the %s category used by compaction and retry without retaining diagnostics', async (code) => {
    async function* source(): AsyncGenerator<StreamChunk> {
      yield { type: 'finish', reason: { kind: 'error', failure: {
        code, message: 'Secret max_tokens diagnostic', status: 400, providerRetryAfterMs: 2500,
      } } }
    }
    const chunks = await collect(safeMuseModelStream(source))
    expect(chunks).toMatchObject([{ reason: { kind: 'error', failure: { code, status: 400, providerRetryAfterMs: 2500 } } }])
    expect(JSON.stringify(chunks)).not.toContain('Secret')
  },
)

it.each(['error', 'aborted'] as const)('removes supplier diagnostic text and request identifiers from %s finishes', async (kind) => {
  async function* source(): AsyncGenerator<StreamChunk> {
    yield { type: 'finish', reason: { kind, failure: { code: 'RATE_LIMIT', message: 'Secret supplier value',
      status: 429, providerRetryAfterMs: 1200, requestId: ProviderRequestId('Secret supplier value') } } }
  }
  expect(await collect(safeMuseModelStream(source))).toEqual([{ type: 'finish', reason: { kind, failure: {
    code: 'RATE_LIMIT', message: 'Upstream rate limit exceeded. Please retry later.', status: 429, providerRetryAfterMs: 1200,
  } } }])
})

it('preserves the image offload count only for the image offload failure', async () => {
  async function* source(): AsyncGenerator<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'IMAGE_OFFLOAD_REQUIRED', message: 'Secret', offloadImages: 2 } } }
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'Secret', offloadImages: 2 } } }
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'Secret', message: 'Secret' } } }
  }
  const chunks = await collect(safeMuseModelStream(source))
  expect(chunks[0]).toMatchObject({ reason: { failure: { offloadImages: 2 } } })
  expect(chunks[1]).not.toHaveProperty('reason.failure.offloadImages')
  expect(chunks[2]).toMatchObject({ reason: { failure: { code: 'UNKNOWN' } } })
  expect(JSON.stringify(chunks)).not.toContain('Secret')
})

it('replaces thrown typed errors without keeping their cause', async () => {
  const upstream = new LlmError('Secret', 'TIMEOUT', { status: 504, providerRetryAfterMs: 2000, cause: new Error('Secret') })
  const pending = collect(safeMuseModelStream(() => { throw upstream }))
  await expect(pending).rejects.toMatchObject({ code: 'TIMEOUT', failure: {
    message: 'Upstream model request timed out. Please retry later.', status: 504, providerRetryAfterMs: 2000,
  } })
  await expect(pending).rejects.not.toHaveProperty('cause')
})

it('replaces untyped iteration failures without coercing supplier values', async () => {
  async function* source(): AsyncGenerator<StreamChunk> {
    yield { type: 'text-delta', index: 0, text: 'Partial answer' }
    throw new Error('Secret')
  }
  await expect(collect(safeMuseModelStream(source))).rejects.toMatchObject({ code: 'UNKNOWN' })
})
