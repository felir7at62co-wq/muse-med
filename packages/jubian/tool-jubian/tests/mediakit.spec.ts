/** Original-key recovery and fail-closed reads for the MediaKit pilot. */
import { createHash } from 'node:crypto'
import { mkdtemp, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import type { MuseMediaPostprocessInput, MuseMediaPostprocessJobKey } from '@deepseek-ai/dsh-muse-account'
import { expect, it, onTestFinished, vi } from 'vitest'
import { readMediaPostprocess, routeMediaPostprocess, withMediaPostprocessLock, type MediaPostprocessClient } from '../src/mediakit.ts'
import { bodyHash } from '../src/write.ts'

const key = 'reviewed-media-key'
const jobKey = brandString<MuseMediaPostprocessJobKey>('b'.repeat(64))
const input = { operation: 'upscale', scriptId: 7, taskId: 14, videoUrl: 'https://source.example/episode.mp4', resolution: '1080p' } as const
const ready = { state: 'ready', jobKey, amount: '1.00', unit: 'CNY' } as const
const digest = createHash('sha256').update(key).digest('hex')

async function ledgerFixture() {
  const root = await mkdtemp(join(tmpdir(), 'jubian-mediakit-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  return new JubianLedger({ root, defaultLimitCents: () => 5_000 })
}

function gatewayFixture() {
  return {
    previewMediaPostprocess: vi.fn<MediaPostprocessClient['previewMediaPostprocess']>().mockResolvedValue(ready),
    submitMediaPostprocess: vi.fn<MediaPostprocessClient['submitMediaPostprocess']>().mockResolvedValue({ state: 'unknown' }),
    statusMediaPostprocess: vi.fn<MediaPostprocessClient['statusMediaPostprocess']>()
      .mockResolvedValue({ state: 'unknown', code: 'query_unconfirmed' }),
    claimMediaPostprocessFallback: vi.fn<MediaPostprocessClient['claimMediaPostprocessFallback']>().mockResolvedValue(false),
  }
}

function route(ledger: JubianLedger, gateway: MediaPostprocessClient, source: MuseMediaPostprocessInput = input, signal?: AbortSignal) {
  return withMediaPostprocessLock(ledger, key, () => routeMediaPostprocess(
    ledger, key, source.operation, source.taskId, gateway, async () => source, signal,
  ), signal)
}

it('keeps an ineligible quote on the legacy route without creating a paid reservation', async () => {
  const ledger = await ledgerFixture(), gateway = gatewayFixture()
  gateway.previewMediaPostprocess.mockResolvedValueOnce({ state: 'ineligible' })
  await expect(route(ledger, gateway)).resolves.toEqual({ route: 'jubian' })
  expect(gateway.submitMediaPostprocess).not.toHaveBeenCalled()
  expect(await ledger.records()).toEqual([])
})

it('fails closed on an unavailable quote and preserves caller cancellation', async () => {
  const ledger = await ledgerFixture(), gateway = gatewayFixture(), caller = new AbortController()
  gateway.previewMediaPostprocess.mockRejectedValueOnce(new Error('synthetic gateway error'))
    .mockImplementationOnce(async () => { caller.abort(); throw new Error('synthetic transport cancellation') })
  await expect(route(ledger, gateway)).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
  await expect(route(ledger, gateway, input, caller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(gateway.submitMediaPostprocess).not.toHaveBeenCalled()
  expect(await ledger.records()).toEqual([])
})

it('reports the original job if another ledger writer records it during preview', async () => {
  const ledger = await ledgerFixture(), gateway = gatewayFixture()
  gateway.previewMediaPostprocess.mockImplementationOnce(async () => {
    await ledger.begin({ idempotencyKey: 'muse-mediakit-' + digest, method: 'video_upscale',
      requestSha256: bodyHash({ ...input, jobKey }), scriptId: input.scriptId, quotedAmount: '1.00', quoteUnit: 'CNY' })
    return ready
  })
  await expect(route(ledger, gateway)).resolves.toMatchObject({ route: 'mediakit',
    result: { processing_job_key: jobKey, status: 'unknown', reason: 'query_unconfirmed', replayed: true } })
  expect(gateway.submitMediaPostprocess).not.toHaveBeenCalled()
  expect(gateway.statusMediaPostprocess).toHaveBeenCalledExactlyOnceWith(jobKey, undefined)
})

it('refuses to recover a different task or a missing local binding', async () => {
  const ledger = await ledgerFixture(), gateway = gatewayFixture()
  await route(ledger, gateway)
  await expect(route(ledger, gateway, { ...input, operation: 'erase_subtitle' })).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  await expect(route(ledger, gateway, { ...input, taskId: 15 })).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  await unlink(join(ledger.root, 'media-postprocess', digest + '.json'))
  await expect(route(ledger, gateway)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(gateway.submitMediaPostprocess).toHaveBeenCalledTimes(1)
  expect(gateway.statusMediaPostprocess).not.toHaveBeenCalled()
  expect(gateway.claimMediaPostprocessFallback).not.toHaveBeenCalled()
})

it('reconciles a later rejection through its persisted job key, preserving the original caller signal', async () => {
  const ledger = await ledgerFixture(), gateway = gatewayFixture(), { signal } = new AbortController()
  await route(ledger, gateway)
  gateway.statusMediaPostprocess.mockResolvedValueOnce({ state: 'rejected', code: 'MEDIAKIT_RATE_LIMITED' })
  const answer = await route(ledger, gateway, input, signal)
  expect(answer).toMatchObject({ route: 'backup', ledgerKey: 'muse-mediakit-backup-' + jobKey })
  expect(gateway.statusMediaPostprocess).toHaveBeenCalledExactlyOnceWith(jobKey, signal)
  expect(gateway.claimMediaPostprocessFallback).not.toHaveBeenCalled()
  if (answer.route !== 'backup') throw Error('Expected a backup after verified rejection')
  await expect(answer.beforeReserve()).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  expect(gateway.claimMediaPostprocessFallback).toHaveBeenCalledExactlyOnceWith(jobKey, signal)
})

it('requires a current gateway and valid key to query or download, and projects only safe status fields', async () => {
  const gateway = gatewayFixture()
  await expect(readMediaPostprocess(undefined, jobKey)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  await expect(readMediaPostprocess(gateway, '../other-job')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  expect(gateway.statusMediaPostprocess).not.toHaveBeenCalled()
  await expect(readMediaPostprocess(gateway, jobKey)).resolves.toEqual({ provider: 'volcengine-mediakit',
    processing_job_key: jobKey, status: 'unknown', reason: 'query_unconfirmed' })
})
