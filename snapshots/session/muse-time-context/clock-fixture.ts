/** A fixture-owned clock and deterministic adapter verify model-visible time from the Muse preset. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

/** Loader name for the isolated recorded clock. */
export const name = 'snapshot-muse-clock'
/** Registry receiving the deterministic recording adapter. */
export const inject = ['llm']

const FIXTURE_TIME = Date.parse('2026-10-03T00:00:00.000Z')

class ClockAdapter extends LlmAdapter {
  async *stream(): AsyncIterable<StreamChunk> {
    const text = 'CLOCK_READY'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Fix the snapshot process clock, check model requests, and register a keyless recording adapter.
 * @param ctx - This isolated snapshot process's plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const readTime = Date.now
    Date.now = () => FIXTURE_TIME
    return () => { Date.now = readTime }
  }, 'snapshot-muse-clock')
  ctx.on('llm/stream', (options, next) => {
    if (options.provider === 'snapshot-muse-clock'
      && !JSON.stringify(options.messages).includes('Time sampled while preparing turn 1, step 1:')) {
      throw new Error('The Muse preset did not deliver its clock to the model')
    }
    return next()
  })
  if (process.env.DSH_SNAPSHOT === 'record') {
    ctx.effect(() => ctx.llm.registerAdapter(['snapshot-muse-clock'], new ClockAdapter()))
  }
}
