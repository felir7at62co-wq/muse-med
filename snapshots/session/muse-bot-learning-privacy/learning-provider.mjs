/** Deterministic model replies for the isolated learning review recording. */
import { importSnapshotPackage } from '../muse-fixture-import.mjs'

const { LlmAdapter } = await importSnapshotPackage(
  '@deepseek-ai/dsh-llm', new URL('../../../packages/host/muse-account/package.json', import.meta.url),
)

/** Loader name for the keyless review provider. */
export const name = 'snapshot-learning-provider'
/** The shipped model registry receives the fixture adapter. */
export const inject = ['llm']

/**
 * Register a provider that captures real one-shot requests without external I/O.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Snapshot profile context.
 */
export function apply(ctx) {
  const calls = []
  let proposed = false
  class ReviewAdapter extends LlmAdapter {
    async *stream(options) {
      options.signal?.throwIfAborted()
      calls.push({ model: options.model, text: options.messages[0].content[0].text })
      const answer = options.model === 'diary' && !proposed
        ? { action: 'create', name: 'private-diary-rule', description: 'Use when organizing the private diary marker ALPHA.', content: 'Keep diary markers organized.' }
        : { action: 'none' }
      proposed = true
      const text = JSON.stringify(answer)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.provide('snapshotLearningRequests', { calls })
  ctx.effect(() => ctx.llm.registerAdapter(['snapshot-learning'], new ReviewAdapter()))
}
