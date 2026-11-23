/** Safe diagnostics preserve routing facts without retaining supplier-controlled strings. */
import { expect, it } from 'vitest'
import { LlmError, ProviderRequestId, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { safeMuseModelStream } from '../src/model-errors.ts'
import type { UnknownMuseModelFailure } from '../src/model-errors.ts'

const ignore = (): void => {}

async function collect(source: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of source) chunks.push(chunk)
  return chunks
}

it('preserves successful stream chunks and replay metadata', async () => {
  const chunks: StreamChunk[] = [{ type: 'text-delta', index: 0, text: 'Result' }, { type: 'finish', reason: { kind: 'stop' } }]
  async function* source() { yield* chunks }
  expect(await collect(safeMuseModelStream(source, ignore))).toEqual(chunks)
})

it.each(['max-tokens', 'tool-calls'] as const)('preserves %s recovery and continuation metadata', async (kind) => {
  const chunks: StreamChunk[] = [{ type: 'text-delta', index: 0, text: 'Partial result' },
    { type: 'usage', usage: { inputTokens: 30, outputTokens: 100, totalTokens: 130 } },
    { type: 'finish', reason: { kind }, replayState: { response: { model: 'fixture-model', stopReason: kind } } }]
  async function* source() { yield* chunks }
  expect(await collect(safeMuseModelStream(source, ignore))).toEqual(chunks)
})

it.each(['CONTEXT_WINDOW_EXCEEDED', 'EMPTY_RESPONSE', 'TRANSPORT', 'SERVER', 'TIMEOUT', 'QUOTA', 'INVALID_REQUEST',
  'INVALID_TOOL_ARGUMENTS', 'MALFORMED_RESPONSE'])(
  'preserves the %s category used by compaction and retry without retaining diagnostics', async (code) => {
    async function* source(): AsyncGenerator<StreamChunk> {
      yield { type: 'finish', reason: { kind: 'error', failure: {
        code, message: 'Secret max_tokens diagnostic', status: 400, providerRetryAfterMs: 2500,
      } } }
    }
    const chunks = await collect(safeMuseModelStream(source, ignore))
    expect(chunks).toMatchObject([{ reason: { kind: 'error', failure: { code, status: 400, providerRetryAfterMs: 2500 } } }])
    expect(JSON.stringify(chunks)).not.toContain('Secret')
  },
)

it.each(['error', 'aborted'] as const)('removes supplier diagnostic text and request identifiers from %s finishes', async (kind) => {
  async function* source(): AsyncGenerator<StreamChunk> {
    yield { type: 'finish', reason: { kind, failure: { code: 'RATE_LIMIT', message: 'Secret supplier value',
      status: 429, providerRetryAfterMs: 1200, requestId: ProviderRequestId('Secret supplier value') } } }
  }
  expect(await collect(safeMuseModelStream(source, ignore))).toEqual([{ type: 'finish', reason: { kind, failure: {
    code: 'RATE_LIMIT', message: 'Upstream rate limit exceeded. Please retry later.', status: 429, providerRetryAfterMs: 1200,
  } } }])
})

it('preserves the image offload count only for the image offload failure', async () => {
  async function* source(): AsyncGenerator<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'IMAGE_OFFLOAD_REQUIRED', message: 'Secret', offloadImages: 2 } } }
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'Secret', offloadImages: 2 } } }
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'Secret', message: 'Secret' } } }
  }
  const chunks = await collect(safeMuseModelStream(source, ignore))
  expect(chunks[0]).toMatchObject({ reason: { failure: { offloadImages: 2 } } })
  expect(chunks[1]).not.toHaveProperty('reason.failure.offloadImages')
  expect(chunks[2]).toMatchObject({ reason: { failure: { code: 'UNKNOWN' } } })
  expect(JSON.stringify(chunks)).not.toContain('Secret')
})

it('replaces thrown typed errors without keeping their cause', async () => {
  const upstream = new LlmError('Secret', 'TIMEOUT', { status: 504, providerRetryAfterMs: 2000, cause: new Error('Secret') })
  const pending = collect(safeMuseModelStream(() => { throw upstream }, ignore))
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
  await expect(collect(safeMuseModelStream(source, ignore))).rejects.toMatchObject({ code: 'UNKNOWN' })
})

it('keeps malformed tool arguments retryable and unreported instead of collapsing them to UNKNOWN', async () => {
  const reports: UnknownMuseModelFailure[] = []
  const upstream = new LlmError('Tool call "inspect": Unexpected non-whitespace character after JSON\n\nReceived arguments:\n{"note":"Secret"}}', 'INVALID_TOOL_ARGUMENTS')
  const pending = collect(safeMuseModelStream(() => { throw upstream }, (failure) => { reports.push(failure) }))
  await expect(pending).rejects.toMatchObject({ code: 'INVALID_TOOL_ARGUMENTS', failure: {
    message: 'Upstream model returned invalid tool arguments. No tool from this reply ran; please retry.',
  } })
  expect(reports).toEqual([])
  const policy = resolveRetryPolicy(undefined, 'fixture')
  if (policy.mode !== 'normal') throw new Error('Expected bounded provider retry policy')
  expect(policy.retryableCodes).toContain('INVALID_TOOL_ARGUMENTS')
})

it.each([
  [new SyntaxError('Unexpected token \'s\', ..."review_id" string="tr"... is not valid JSON'),
    { source: 'thrown', errorClass: 'SyntaxError', message: 'Unexpected token …' }],
  [Object.assign(new TypeError(`header rejected for ${'k'.repeat(40)}\nReceived arguments: {"note":"Secret"}`), { code: 'ERR_INVALID_CHAR' }),
    { source: 'thrown', errorClass: 'TypeError', code: 'ERR_INVALID_CHAR', message: 'header rejected for …' }],
  [new LlmError('Request headers failed for Secret', 'REQUEST_HEADERS'),
    { source: 'thrown', errorClass: 'LlmError', code: 'REQUEST_HEADERS', message: 'Request headers failed for Secret' }],
  [new Error(`${'word '.repeat(60)}end`),
    { source: 'thrown', errorClass: 'Error', message: `${'word '.repeat(60)}end`.slice(0, 159) + '…' }],
  [Object.assign(new Error('Plain failure'), { name: 'not an identifier' }),
    { source: 'thrown', errorClass: 'Error', message: 'Plain failure' }],
  ['Secret thrown text', { source: 'thrown', errorClass: 'string' }],
] as const)('reports the class, code and a quote-free message prefix of a thrown %s that becomes UNKNOWN', async (thrown, expected) => {
  const reports: UnknownMuseModelFailure[] = []
  async function* source(): AsyncGenerator<StreamChunk> {
    yield { type: 'text-delta', index: 0, text: 'Partial answer with Secret' }
    throw thrown
  }
  await expect(collect(safeMuseModelStream(source, (failure) => { reports.push(failure) }))).rejects.toMatchObject({
    code: 'UNKNOWN', failure: { message: 'Muse model request failed. Please retry or contact the Muse administrator.' },
  })
  expect(reports).toEqual([expected])
  expect(JSON.stringify(reports)).not.toContain('review_id')
  expect(JSON.stringify(reports)).not.toContain('kkkkkkkkkkkkkkkkkkkkkkkk')
  expect(JSON.stringify(reports)).not.toContain('Received')
})

it('reports an unlisted in-band code without its supplier message', async () => {
  const reports: UnknownMuseModelFailure[] = []
  async function* source(): AsyncGenerator<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'FILES_API', message: 'Secret supplier text' } } }
    yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'Secret code', message: 'Secret supplier text' } } }
  }
  const chunks = await collect(safeMuseModelStream(source, (failure) => { reports.push(failure) }))
  expect(chunks).toMatchObject([{ reason: { failure: { code: 'UNKNOWN' } } }, { reason: { failure: { code: 'UNKNOWN' } } }])
  expect(reports).toEqual([{ source: 'finish', code: 'FILES_API' }, { source: 'finish' }])
})

it('delivers the fixed UNKNOWN failure when describing or reporting it fails', async () => {
  const hostile = new Error('Secret')
  Object.defineProperty(hostile, 'code', { get() { throw new Error('hostile getter') } })
  await expect(collect(safeMuseModelStream(() => { throw hostile }, ignore))).rejects.toMatchObject({ code: 'UNKNOWN' })
  await expect(collect(safeMuseModelStream(() => { throw new Error('Secret') }, () => { throw new Error('sink failed') })))
    .rejects.toMatchObject({ code: 'UNKNOWN' })
})

it('reports a content refusal without exposing supplier text or enabling retries', async () => {
  async function* source(): AsyncGenerator<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'error', failure: {
      code: 'CONTENT_FILTER', message: 'synthetic-secret',
    } } }
  }
  const chunks = await collect(safeMuseModelStream(source, ignore))
  expect(chunks).toMatchInlineSnapshot(`
    [
      {
        "reason": {
          "failure": {
            "code": "CONTENT_FILTER",
            "message": "Upstream content safety refused this request. Repeating the same request will not resolve the refusal.",
          },
          "kind": "error",
        },
        "type": "finish",
      },
    ]
  `)
  const policy = resolveRetryPolicy(undefined, 'fixture')
  if (policy.mode !== 'normal') throw new Error('Expected bounded provider retry policy')
  expect(policy.retryableCodes).not.toContain('CONTENT_FILTER')
})
