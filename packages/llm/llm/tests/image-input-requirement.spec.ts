/**
 * Required-image-input guard: a call that sets `requireImageInput` must fail
 * with `IMAGE_INPUT_REQUIRED` unless its route declares the capability, the
 * exact model accepts images, and the request actually carries one. The guard
 * is inert for every call that leaves the field unset.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'

const SCRIPT: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'hi' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } },
  { type: 'finish', reason: { kind: 'stop' } },
]

const REFUSAL: StreamChunk = {
  type: 'finish',
  reason: {
    kind: 'error',
    failure: {
      code: 'IMAGE_INPUT_REQUIRED',
      message: 'Required image input cannot be guaranteed by this route',
    },
  },
}

function image(): Extract<ContentBlock, { type: 'image' }> {
  return {
    type: 'image',
    attachment: {
      attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
      mediaType: 'image/png',
      bytes: 3,
      width: 1,
      height: 1,
    },
  }
}

/** Adapter whose exact-model metadata is fixed at construction; declares no capability. */
class RouteAdapter extends LlmAdapter {
  constructor(private readonly modalities: readonly ('text' | 'image')[] | undefined) { super() }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...this.modalities === undefined ? {} : { inputModalities: [...this.modalities] },
    })
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* SCRIPT
  }
}

/** The same route metadata with the capability declared. */
class DeclaringAdapter extends RouteAdapter {
  override readonly supportsRequiredImageInput = true
}

/** Dispatch one request and return its terminal chunk. */
async function finish(
  adapter: LlmAdapter,
  model: string,
  visual: boolean,
  required: boolean,
): Promise<StreamChunk | undefined> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['route'], adapter)
  const chunks: StreamChunk[] = []
  for await (const chunk of ctx.llm.stream({
    provider: 'route',
    model,
    ...required ? { requireImageInput: true } : {},
    messages: [createUserMessage({
      content: visual ? [image()] : [{ type: 'text', text: 'plain' }],
      source: { kind: 'plugin', plugin: 'test' },
    })],
  })) chunks.push(chunk)
  return chunks.at(-1)
}

describe('requireImageInput', () => {
  it('rejects a route whose adapter does not declare the capability', async () => {
    await expect(finish(new RouteAdapter(['text', 'image']), 'vision', true, true)).resolves.toEqual(REFUSAL)
  })

  it('rejects a text-only model projection', async () => {
    await expect(finish(new DeclaringAdapter(['text']), 'text-only', true, true)).resolves.toEqual(REFUSAL)
  })

  it('rejects a model that declares no input modalities', async () => {
    await expect(finish(new DeclaringAdapter(undefined), 'unlisted', true, true)).resolves.toEqual(REFUSAL)
  })

  it('rejects a request that carries no image at all', async () => {
    await expect(finish(new DeclaringAdapter(['text', 'image']), 'vision', false, true)).resolves.toEqual(REFUSAL)
  })

  it('dispatches a declaring adapter over an image-capable model', async () => {
    await expect(finish(new DeclaringAdapter(['text', 'image']), 'vision', true, true))
      .resolves.toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('leaves a call without the field ungated, even on an undeclared route', async () => {
    await expect(finish(new RouteAdapter(['text', 'image']), 'vision', true, false))
      .resolves.toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })
})
