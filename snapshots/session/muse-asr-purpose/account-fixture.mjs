/** Account identity for resuming a seeded receipt without a cloud request. */
import { Service } from '@deepseek-ai/cordis'

export const name = 'snapshot-asr-purpose-account'

class ReceiptAccount extends Service {
  constructor(ctx) { super(ctx, 'museAccount') }
  async status() { return { state: 'signed-in', username: 'fixture', verified: false } }
  async submitAudio() { throw new Error('The receipt-resume snapshot must not submit audio') }
  async audioStatus() { throw new Error('The receipt-resume snapshot must not query a provider') }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - Snapshot Loader context.
 */
export async function apply(ctx) { await ctx.plugin(ReceiptAccount) }
