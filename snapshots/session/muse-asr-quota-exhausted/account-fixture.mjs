/** Original-task quota exhaustion through the real cached gateway receipt and transcription tool. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rmdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createAsrService } from '../../../services/muse-accounts/asr-service.mjs'
import { importSnapshotPackage } from '../muse-fixture-import.mjs'

const { Service } = await importSnapshotPackage('@deepseek-ai/cordis',
  new URL('../../../apps/desktop-host/package.json', import.meta.url))

export const name = 'snapshot-asr-quota-exhausted-account'
export const inject = ['llm']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Shipped Headless Loader context. */
export async function apply(ctx) {
  const cwd = await realpath(process.cwd()), source = join(cwd, 'source', 'fixture.mp4')
  const sourceBytes = await readFile(source), root = await mkdtemp(join(process.env.DSH_HOME, 'quota-exhausted-'))
  const id = '71000000-0000-4000-8000-000000000001', taskId = '72000000-0000-4000-8000-000000000001'
  const account = 'synthetic-editor', clock = 1783654655599, sha256 = 'a'.repeat(64)
  const ledger = join(root, 'jobs'), ledgerFile = join(ledger, createHash('sha256').update(account + '\0' + id).digest('hex') + '.json')
  const original = { id, taskId, account, hash: sha256, language: 'zh', purpose: 'screenplay', duration: 84,
    poolId: 'original', appId: 'synthetic-original-app', quotaGroup: 'shared', serviceVersion: 'standard-v2', resourceId: 'volc.seedasr.auc',
    providerKind: 'standard', storageKind: 'tos', audioFormat: 'wav', day: '2026-07-10',
    status: 'uncertain', objectStagedAt: clock - 10000, reservedAtMs: clock - 10000, submittedAtMs: clock - 9000,
    failureCode: 'provider_rejected', providerFailure: { code: 'provider_rejected', operation: 'query', reason: 'http', httpStatus: 429, providerCode: '45000292', quotaType: 'audio_duration_lifetime' },
    queryRetry: { count: 4, nextAttemptAtMs: clock + 300000 } }
  await mkdir(ledger, { recursive: true, mode: 0o700 })
  await writeFile(ledgerFile, JSON.stringify(original) + '\n', { flag: 'wx', mode: 0o600 })
  const ledgerBytes = await readFile(ledgerFile)
  let accountSubmissions = 0, providerSubmissions = 0, providerQueries = 0, statusReads = 0
  const service = createAsrService({ root, autoStart: false, now: () => clock,
    resources: [{ poolId: 'original', appId: 'synthetic-original-app', quotaGroup: 'shared', serviceVersion: 'standard-v2', maxConcurrentJobs: 1,
      provider: { async submit() { providerSubmissions++; throw Error('Receipt inspection cannot submit paid work') },
        async query() { providerQueries++; throw Error('Cached receipt inspection cannot query the supplier') } } }],
    quotaGroups: [{ id: 'shared', maxConcurrentJobs: 1 }], defaultPoolId: 'original',
    storage: { key: value => value, async remove() { throw Error('Unresolved source audio must remain available') } },
    maxAudioBytes: 1024, maxDurationSeconds: 600, maxDailySeconds: 1000, maxDailyJobs: 10,
    maxActiveJobs: 1, maxConcurrentJobs: 1, retentionSeconds: 86400 })
  ctx.effect(() => async () => { await service.close() }, 'close synthetic quota ledger')
  await service.ready()
  const jobs = join(cwd, 'transcript', 'jobs'), receiptFile = join(jobs, 'fixture-v1.json')
  await mkdir(jobs, { recursive: true, mode: 0o700 })
  await writeFile(receiptFile, JSON.stringify({ id, source, accountUsername: 'fixture', stem: 'fixture', version: 1,
    language: 'zh', purpose: 'screenplay', sha256, mp3: join(jobs, '.' + id + '.wav'),
    status: 'processing', service_version: 'standard-v2' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  let cached, visible
  class ReceiptAccount extends Service {
    constructor(context) { super(context, 'museAccount') }
    async status() { return { state: 'signed-in', username: 'fixture', verified: false } }
    async submitAudio() { accountSubmissions++; throw Error('Inspect must not submit another transcription') }
    async audioStatus(requestId) { statusReads++; assert.equal(requestId, id); cached = await service.get(account, requestId); return cached }
  }
  await ctx.plugin(ReceiptAccount)
  ctx.on('llm/stream', async function* (options, next) {
    for (const message of options.messages) {
      if (message.role !== 'tool' || message.toolCallId !== 'call_audio_transcribe_quota') continue
      const block = message.content.find(item => item.type === 'text')
      assert.ok(block, 'The actual transcription result must reach the next model request')
      visible = JSON.parse(block.text)
      assert.equal(visible.status, 'uncertain'); assert.equal(visible.job_id, id)
      assert.deepEqual(visible.provider_diagnostic, { reason: 'http', operation: 'query', http_status: 429, provider_code: '45000292', quota_type: 'audio_duration_lifetime' })
      assert.deepEqual(visible.recovery, { capability: 'query_original_task', next_action: 'inspect_receipt', automatic_resubmit: false, retry_after: 300 })
      assert.equal(visible.retry_after_seconds, 300); assert.equal(visible.resume_status.method, 'inspect')
      assert.match(visible.polling_note, /原供应商应用.*额度已用完.*管理员.*原应用/)
      assert.equal(visible.output_txt, undefined); assert.equal(visible.output_json, undefined); assert.equal(visible.output_srt, undefined)
    }
    yield* next()
  })
  let finalized = false
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (finalized) return
    finalized = true
    assert.ok(cached); assert.ok(visible); assert.equal(statusReads, 1)
    assert.equal(accountSubmissions, 0); assert.equal(providerSubmissions, 0); assert.equal(providerQueries, 0)
    const calls = agent.session.snapshotEvents().filter(event => event.type === 'tool/call')
    assert.equal(calls.length, 1); assert.equal(calls[0].data.name, 'audio_transcribe')
    assert.equal(JSON.parse(calls[0].data.arguments).method, 'inspect')
    assert.deepEqual(await readFile(source), sourceBytes)
    await assert.rejects(stat(join(cwd, 'transcript', 'raw')), { code: 'ENOENT' })
    const receiptBytes = await readFile(receiptFile), receipt = JSON.parse(receiptBytes.toString('utf8'))
    assert.equal(receipt.id, id); assert.equal(receipt.status, 'uncertain'); assert.deepEqual(receipt.recovery, cached.recovery)
    assert.deepEqual(await readFile(ledgerFile), ledgerBytes)
    const durable = JSON.parse((await readFile(ledgerFile)).toString('utf8'))
    assert.equal(durable.taskId, taskId)
    assert.equal((await readdir(ledger)).length, 1)
    // Retain the genuine receipt privately after verifying its identity and metadata.
    const retainedReceipt = join(root, 'original-client-receipt.json')
    await rename(receiptFile, retainedReceipt)
    assert.deepEqual(await readFile(retainedReceipt), receiptBytes)
    await rmdir(jobs); await rmdir(join(cwd, 'transcript'))
    await writeFile(join(cwd, 'quota-probe.json'), JSON.stringify({ status: cached.status,
      provider_diagnostic: cached.provider_diagnostic, recovery: cached.recovery, retry_after_seconds: visible.retry_after_seconds,
      originalJobIdRetained: receipt.id === id, originalSupplierTaskIdRetained: durable.taskId === taskId,
      accountSubmissions, providerSubmissions, providerQueries, statusReads,
      sourcePreserved: true, receiptPreserved: true, transcriptPublished: false }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  })
}
