/** An original transcription receipt with an unresponsive status request. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { importSnapshotPackage } from '../muse-fixture-import.mjs'

const { Service } = await importSnapshotPackage('@deepseek-ai/cordis',
  new URL('../../../apps/desktop-host/package.json', import.meta.url))

export const name = 'snapshot-asr-wait-account'
export const inject = ['llm']
const id = '71000000-0000-4000-8000-000000000001'

/** @param {import('@deepseek-ai/cordis').Context} ctx - Snapshot Loader context. */
export async function apply(ctx) {
  let reads = 0, cancelled = false, visibleInModelRequest = false
  class ReceiptAccount extends Service {
    constructor(context) { super(context, 'museAccount') }
    async status() { return { state: 'signed-in', username: 'fixture', verified: false } }
    async submitAudio() { throw new Error('Inspect must not upload audio') }
    async audioStatus(jobId, signal) {
      assert.equal(jobId, id)
      reads += 1
      try { await delay(2000, undefined, { signal }) }
      finally { cancelled = signal?.aborted === true }
      throw new Error('The query must stop when the requested wait expires')
    }
  }
  await ctx.plugin(ReceiptAccount)
  ctx.on('llm/stream', async function* (options, next) {
    for (const message of options.messages) {
      if (message.role !== 'tool' || message.toolCallId !== 'call_audio_transcribe') continue
      assert.equal(message.isError, false)
      assert.match(message.content[0].text, /原收据查询/u)
      const result = JSON.parse(message.content[1].text)
      assert.equal(result.status, 'uncertain')
      assert.equal(result.error_code, 'query-timeout')
      assert.equal(result.job_id, id)
      assert.equal(result.resume_status.method, 'inspect')
      assert.equal(result.resume_status.receipt, result.receipt)
      assert.equal(result.output_json, undefined)
      visibleInModelRequest = true
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    assert.equal(reads, 1)
    assert.equal(cancelled, true)
    assert.equal(visibleInModelRequest, true)
    const receipt = JSON.parse(await readFile(join(agent.session.header.cwd, 'transcript/jobs/fixture-v1.json'), 'utf8'))
    assert.equal(receipt.id, id)
    assert.equal(receipt.status, 'processing')
    assert.equal(receipt.error_code, undefined)
  })
}
