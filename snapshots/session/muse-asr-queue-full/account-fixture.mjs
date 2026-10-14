/** Account-bound queue refusal without a cloud request or a new submission. */
import { importSnapshotPackage } from '../muse-fixture-import.mjs'

const owner = new URL('../../../apps/desktop-host/package.json', import.meta.url)
const { Service } = await importSnapshotPackage('@deepseek-ai/cordis', owner)
const { MuseAsrError } = await importSnapshotPackage('@deepseek-ai/dsh-muse-account', owner)

export const name = 'snapshot-asr-queue-full-account'

class ReceiptAccount extends Service {
  constructor(ctx) { super(ctx, 'museAccount') }
  async status() { return { state: 'signed-in', username: 'fixture', verified: false } }
  async submitAudio() { throw new Error('The queue-full snapshot must not submit audio') }
  async audioStatus() { throw new MuseAsrError('queue_full', 2) }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - Snapshot Loader context.
 */
export async function apply(ctx) { await ctx.plugin(ReceiptAccount) }
