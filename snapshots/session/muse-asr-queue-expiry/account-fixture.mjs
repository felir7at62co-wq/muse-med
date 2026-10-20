/** Real gateway expiry and transcription receipt handling without a supplier request. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rmdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createAsrService } from '../../../services/muse-accounts/asr-service.mjs'
import { importSnapshotPackage } from '../muse-fixture-import.mjs'

const { Service } = await importSnapshotPackage('@deepseek-ai/cordis',
  new URL('../../../apps/desktop-host/package.json', import.meta.url))

export const name = 'snapshot-asr-queue-expiry-account'
export const inject = ['llm']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Shipped Headless Loader context. */
export async function apply(ctx) {
  const cwd = await realpath(process.cwd())
  const source = join(cwd, 'source', 'fixture.mp4')
  const sourceBytes = await readFile(source)
  const root = await mkdtemp(join(process.env.DSH_HOME, 'queue-expiry-'))
  const id = '71000000-0000-4000-8000-000000000001'
  const account = 'synthetic-editor'
  const audio = Buffer.from('Synthetic extracted speech track.\n')
  const sha256 = createHash('sha256').update(audio).digest('hex')
  let clock = 1783654655599
  let accountSubmissions = 0
  let providerSubmissions = 0
  let providerQueries = 0
  let statusReads = 0
  const service = createAsrService({
    root, autoStart: false, now: () => clock,
    resources: [{ poolId: 'standard', appId: 'synthetic-app', quotaGroup: 'standard',
      serviceVersion: 'standard-v2', maxConcurrentJobs: 1,
      provider: {
        async submit() { providerSubmissions++; throw Error('Expired queued work must never reach the supplier') },
        async query() { providerQueries++; throw Error('Unsubmitted work has no supplier task to query') },
      } }],
    quotaGroups: [{ id: 'standard', maxConcurrentJobs: 1 }], defaultPoolId: 'standard',
    storage: {
      key: taskId => 'synthetic/' + taskId + '.wav',
      async assertPrivateBeforeUpload() { throw Error('Queued work must not upload supplier audio') },
      async upload() { throw Error('Queued work must not upload supplier audio') },
      async signedReadUrl() { throw Error('Queued work has no signed supplier URL') },
      async assertPrivateAndReadable() { throw Error('Queued work has no supplier audio') },
      async remove() {},
    },
    probe: async file => {
      assert.deepEqual(await readFile(file), audio)
      return { duration: 1, format: 'wav' }
    },
    maxAudioBytes: 1024, maxDurationSeconds: 10, maxDailySeconds: 100,
    maxDailyJobs: 10, maxActiveJobs: 1, maxConcurrentJobs: 1, retentionSeconds: 86400,
  })
  ctx.effect(() => async () => { await service.close() }, 'close synthetic ASR ledger')
  await service.ready()
  const accepted = await service.submit(account, id, sha256, 'zh', Readable.from(audio), 'screenplay')
  assert.equal(accepted.status, 'processing')
  assert.equal(accepted.queued, true)
  assert.equal(service.diagnostics().occupancy.waiting, 1)

  const jobs = join(cwd, 'transcript', 'jobs')
  await mkdir(jobs, { recursive: true, mode: 0o700 })
  const stagedAudio = join(jobs, '.' + id + '.wav')
  const receiptFile = join(jobs, 'fixture-v1.json')
  await writeFile(stagedAudio, audio, { flag: 'wx', mode: 0o600 })
  await writeFile(receiptFile, JSON.stringify({
    id, source, accountUsername: 'fixture', stem: 'fixture', version: 1,
    language: 'zh', purpose: 'screenplay', sha256, mp3: stagedAudio,
    status: accepted.status, service_version: accepted.service_version,
    queued: accepted.queued, recovery: accepted.recovery,
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  clock += 86401 * 1000

  let expired
  class ReceiptAccount extends Service {
    constructor(context) { super(context, 'museAccount') }
    async status() { return { state: 'signed-in', username: 'fixture', verified: false } }
    async submitAudio() { accountSubmissions++; throw Error('Receipt inspection must not submit another transcription') }
    async audioStatus(requestId) {
      statusReads++
      assert.equal(requestId, id)
      expired = await service.get(account, requestId)
      assert.equal(expired.status, 'failed')
      assert.equal(expired.retentionExpired, true)
      assert.equal(expired.queued, undefined)
      assert.deepEqual(expired.recovery, { capability: 'none', next_action: 'inspect_receipt', automatic_resubmit: false })
      return expired
    }
  }
  await ctx.plugin(ReceiptAccount)

  ctx.on('llm/stream', async function* (options, next) {
    for (const message of options.messages) {
      if (message.role !== 'tool' || message.toolCallId !== 'call_audio_transcribe_expired') continue
      const block = message.content.find(item => item.type === 'text')
      assert.ok(block, 'The real tool response must reach the next model request')
      const result = JSON.parse(block.text)
      assert.equal(result.status, 'failed')
      assert.equal(result.job_id, id)
      assert.deepEqual(result.recovery, { capability: 'none', next_action: 'inspect_receipt', automatic_resubmit: false })
      assert.equal(result.queued, undefined)
      assert.equal(result.resume_status, undefined)
      assert.equal(result.output_txt, undefined)
      assert.equal(result.output_json, undefined)
      assert.equal(result.output_srt, undefined)
    }
    yield* next()
  })

  let finalized = false
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (finalized) return
    finalized = true
    assert.ok(expired)
    assert.equal(statusReads, 1)
    assert.equal(accountSubmissions, 0)
    assert.equal(providerSubmissions, 0)
    assert.equal(providerQueries, 0)
    assert.equal(service.diagnostics().occupancy.waiting, 0)
    const calls = agent.session.snapshotEvents().filter(event => event.type === 'tool/call')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].data.name, 'audio_transcribe')
    assert.equal(JSON.parse(calls[0].data.arguments).method, 'status')
    assert.deepEqual(await readFile(source), sourceBytes)
    await assert.rejects(stat(stagedAudio), { code: 'ENOENT' })
    await assert.rejects(stat(join(cwd, 'transcript', 'raw')), { code: 'ENOENT' })
    const receiptBytes = await readFile(receiptFile)
    const receipt = JSON.parse(receiptBytes.toString('utf8'))
    assert.equal(receipt.id, id)
    assert.equal(receipt.status, 'failed')
    assert.equal(receipt.queued, undefined)
    assert.deepEqual(receipt.recovery, expired.recovery)
    const ledgerFiles = await readdir(join(root, 'jobs'))
    assert.equal(ledgerFiles.length, 1)
    const durable = JSON.parse(await readFile(join(root, 'jobs', ledgerFiles[0]), 'utf8'))
    assert.equal(durable.id, id)
    assert.equal(durable.status, 'failed')
    assert.equal(durable.retentionExpired, true)
    assert.equal(durable.submittedAtMs, undefined)
    assert.deepEqual(await readdir(join(root, 'audio')), [])

    // Keep the genuine absolute-path receipt under the harness-owned private home,
    // after checking it, so the independent workspace oracle needs no path rewriting.
    const retainedReceipt = join(root, 'original-client-receipt.json')
    await rename(receiptFile, retainedReceipt)
    assert.deepEqual(await readFile(retainedReceipt), receiptBytes)
    await rmdir(jobs)
    await rmdir(join(cwd, 'transcript'))
    await writeFile(join(cwd, 'expiry-probe.json'), JSON.stringify({
      gatewayStatus: expired.status, retentionExpired: expired.retentionExpired,
      queued: expired.queued === true, recovery: expired.recovery,
      originalJobIdRetained: receipt.id === id, accountSubmissions, providerSubmissions, providerQueries,
      localStagedAudioRemoved: true, sourcePreserved: true, receiptPreserved: true, transcriptPublished: false,
    }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  })
}
