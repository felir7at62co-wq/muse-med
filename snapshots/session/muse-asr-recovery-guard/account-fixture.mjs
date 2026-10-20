/** Query-only account responses for original Flash and standard task recovery. */
import assert from 'node:assert/strict'
import { queryAsr } from '../../../services/muse-accounts/asr-provider.mjs'
import { importSnapshotPackage } from '../muse-fixture-import.mjs'
const { Service } = await importSnapshotPackage('@deepseek-ai/cordis',
  new URL('../../../apps/desktop-host/package.json', import.meta.url))
export const name = 'snapshot-asr-recovery-account'
export const inject = ['llm']
class ReceiptAccount extends Service {
  constructor(ctx) { super(ctx, 'museAccount') }
  async status() { return { state: 'signed-in', username: 'fixture', verified: false } }
  async submitAudio() { throw new Error('Recovery must never submit another paid request') }
  async audioStatus(id) {
    const flash = id.endsWith('1')
    if (!flash) {
      const result = await queryAsr({ appId: 'synthetic', accessToken: 'synthetic', timeoutMs: 1000 }, id,
        async () => new Response('{}', { headers: { 'X-Api-Status-Code': '45000006' } }))
      assert.equal(result.status, 'failed')
      return { id, status: result.status, service_version: 'standard-v2', error_code: 'provider_rejected',
        provider_diagnostic: { reason: 'response', operation: 'query', http_status: 200, provider_code: result.providerCode },
        recovery: { capability: 'none', next_action: 'inspect_receipt', automatic_resubmit: false } }
    }
    return { id, status: 'uncertain', service_version: 'flash',
      error_code: 'provider_unavailable', provider_diagnostic: { reason: 'timeout', operation: 'flash' },
      recovery: { capability: 'no_query', next_action: 'inspect_receipt', automatic_resubmit: false } }
  }
}
/** @param {import('@deepseek-ai/cordis').Context} ctx - Snapshot Loader context. */
export async function apply(ctx) {
  await ctx.plugin(ReceiptAccount)
  ctx.on('llm/stream', async function* (options, next) {
    for (const message of options.messages) {
      if (message.role !== 'tool' || !message.toolCallId?.startsWith('call_audio_transcribe')) continue
      const block = message.content.find(item => item.type === 'text')
      assert.ok(block, 'Recovery request retains the original tool response')
      const job = JSON.parse(block.text)
      const flash = job.service_version === 'flash'
      assert.equal(job.status, flash ? 'uncertain' : 'failed')
      assert.equal(job.error_code, flash ? 'provider_unavailable' : 'provider_rejected')
      assert.equal(job.recovery.capability, flash ? 'no_query' : 'none')
      assert.equal(job.recovery.next_action, 'inspect_receipt')
      assert.equal(job.recovery.automatic_resubmit, false)
      assert.equal(job.resume_status, undefined, 'Server-confirmed lost Flash response has no automatic polling suggestion')
      assert.equal(job.output_txt, undefined, 'Unresolved jobs are not complete transcripts')
    }
    yield* next()
  })
}
