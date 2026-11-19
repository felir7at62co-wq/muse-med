import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import type { JubianLedgerBegin } from '@deepseek-ai/dsh-jubian'
import { expect, it, onTestFinished, vi } from 'vitest'
import { bodyHash, writeUnderLedger } from '../src/write.ts'

async function fixture(limitCents = 400_000) {
  const root = await mkdtemp(join(tmpdir(), 'jubian-budget-receipt-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  const ledger = new JubianLedger({ root, defaultLimitCents: () => limitCents })
  const send = vi.fn(async () => ({ transport: { http_status: 200, application_code: 200 },
    response_sha256: null, data: { code: 200 } }))
  return { ledger, send }
}

async function record(ledger: JubianLedger, input: JubianLedgerBegin,
  outcome?: 'accepted' | 'unknown'): Promise<void> {
  await ledger.begin(input)
  if (outcome !== undefined) await ledger.settle(input.idempotencyKey, {
    httpStatus: 200, applicationCode: outcome === 'accepted' ? 200 : 500,
    responseSha256: null, outcome,
  })
}

it.each(['accepted', 'unknown'] as const)
('separates this submission reservation from earlier project estimates after an %s response', async (outcome) => {
  const { ledger, send } = await fixture()
  await record(ledger, { idempotencyKey: 'earlier', method: 'storyboard_native_submit',
    scriptId: 6611, requestSha256: 'earlier', quotedAmount: '97.69', quoteUnit: 'CNY' }, 'accepted')
  await record(ledger, { idempotencyKey: 'pending', method: 'storyboard_native_submit',
    scriptId: 6611, requestSha256: 'pending', quotedAmount: '6.00', quoteUnit: 'CNY' })
  send.mockResolvedValue({ transport: { http_status: 200, application_code: outcome === 'accepted' ? 200 : 500 },
    response_sha256: null, data: { code: outcome === 'accepted' ? 200 : 500 } })
  const result = await writeUnderLedger(ledger, 'current', 'storyboard_native_submit',
    () => ({ isGenerate: 1 }), send, () => ({ scriptId: 6611, amount: '13.36', unit: 'CNY' }))
  expect(result).toMatchObject({ replayed: false, outcome, budget: {
    status: 'authorized', reason: '',
    this_submission: { reservation: { status: 'recorded', amount: '13.36', unit: 'CNY', basis: 'quote_or_estimate' },
      provider_billing: 'not_observed' },
    project_accounting: { scope: 'project_before_submission', basis: 'local_reservations', unit: 'CNY',
      accepted_reservations_cents: 9769, pending_reservations_cents: 600 },
  } })
  expect(result.budget).not.toHaveProperty('settledCents')
  expect(result.budget).not.toHaveProperty('reservedCents')
  expect(await ledger.find('current')).toMatchObject({ quoted_amount: '13.36', quote_unit: 'CNY', outcome })
  expect(send).toHaveBeenCalledOnce()
})

it.each(['accepted', 'unknown', undefined] as const)
('replays the original reservation without recalculating it from current project totals: %s', async (outcome) => {
  const { ledger, send } = await fixture(0)
  await record(ledger, { idempotencyKey: 'original', method: 'storyboard_native_submit',
    scriptId: 6611, requestSha256: 'original', quotedAmount: '13.36', quoteUnit: 'CNY' }, outcome)
  await record(ledger, { idempotencyKey: 'later', method: 'storyboard_native_submit',
    scriptId: 6611, requestSha256: 'later', quotedAmount: '97.69', quoteUnit: 'CNY' }, 'accepted')
  const before = await ledger.records()
  const body = vi.fn(() => ({ isGenerate: 1 }))
  const quote = vi.fn(() => ({ scriptId: 6611, amount: '999.99', unit: 'CNY' }))
  const result = await writeUnderLedger(ledger, 'original', 'storyboard_native_submit', body, send, quote)
  expect(result).toMatchObject({ replayed: true, outcome: outcome ?? 'unknown', budget: {
    status: 'not_rechecked', reason: '', project_accounting: null,
    this_submission: { reservation: { status: 'recorded', amount: '13.36', unit: 'CNY', basis: 'quote_or_estimate' },
      provider_billing: 'not_observed' },
  } })
  expect(body).not.toHaveBeenCalled()
  expect(quote).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
  expect(await ledger.records()).toEqual(before)
})

it('replays a competing claim using that recorded reservation without sending again', async () => {
  const { ledger, send } = await fixture(0)
  const payload = { isGenerate: 1 }
  const result = await writeUnderLedger(ledger, 'competing', 'storyboard_native_submit', async () => {
    await record(ledger, { idempotencyKey: 'competing', method: 'storyboard_native_submit',
      scriptId: 6611, requestSha256: bodyHash(payload), quotedAmount: '2.25', quoteUnit: 'CNY' }, 'accepted')
    return payload
  }, send, () => ({ scriptId: 6611, amount: '999.99', unit: 'CNY' }))
  expect(result).toMatchObject({ replayed: true, budget: {
    status: 'not_rechecked', project_accounting: null,
    this_submission: { reservation: { status: 'recorded', amount: '2.25', unit: 'CNY' }, provider_billing: 'not_observed' },
  } })
  expect(send).not.toHaveBeenCalled()
  expect(await ledger.records()).toHaveLength(1)
})

it.each([{}, { quotedAmount: '13.36' }, { quoteUnit: 'CNY' }])
('keeps an incomplete historical reservation unavailable when replaying %j', async (quote) => {
  const { ledger, send } = await fixture()
  await record(ledger, { idempotencyKey: 'legacy', method: 'storyboard_native_submit',
    scriptId: 6611, requestSha256: 'legacy', ...quote }, 'accepted')
  const result = await writeUnderLedger(ledger, 'legacy', 'storyboard_native_submit', () => ({}), send)
  expect(result.budget).toEqual({ status: 'not_rechecked', reason: '', project_accounting: null,
    this_submission: { reservation: { status: 'unavailable' }, provider_billing: 'not_observed' } })
  expect(send).not.toHaveBeenCalled()
})

it('reports no reservation requirement for a nonpaid write and its replay without implying a zero bill', async () => {
  const { ledger, send } = await fixture(0)
  const result = await writeUnderLedger(ledger, 'save', 'storyboard_save', () => ({ name: 'ready' }), send)
  expect(result.budget).toEqual({ status: 'authorized', reason: '', project_accounting: null,
    this_submission: { reservation: { status: 'not_required' }, provider_billing: 'not_observed' } })
  const replay = await writeUnderLedger(ledger, 'save', 'storyboard_save', () => ({ name: 'ready' }), send)
  expect(replay.budget).toEqual({ ...result.budget, status: 'not_rechecked' })
  expect(send).toHaveBeenCalledOnce()
})

it('retains a verified zero reservation without reporting a provider bill or an unobserved project total', async () => {
  const { ledger, send } = await fixture(0)
  const result = await writeUnderLedger(ledger, 'free', 'erase_subtitle', () => ({ taskId: 42 }), send,
    () => ({ scriptId: 6611, amount: '0.00', unit: 'CNY', verifiedFreeSubtitleErase: true }))
  expect(result.budget).toEqual({ status: 'authorized', reason: '', project_accounting: null,
    this_submission: { reservation: { status: 'recorded', amount: '0.00', unit: 'CNY', basis: 'quote_or_estimate' },
      provider_billing: 'not_observed' } })
  expect(await ledger.find('free')).toMatchObject({ quoted_amount: '0.00', quote_unit: 'CNY' })
  expect(send).toHaveBeenCalledOnce()
})

it.each([{ limitCents: 100, quote: { amount: '13.36', unit: 'CNY' } },
  { limitCents: 400_000, quote: undefined }])
('preserves budget refusal before writing or sending with %j', async ({ limitCents, quote }) => {
  const { ledger, send } = await fixture(limitCents)
  await expect(writeUnderLedger(ledger, 'refused', 'storyboard_native_submit', () => ({ isGenerate: 1 }), send,
    () => ({ scriptId: 6611, ...quote })))
    .rejects.toMatchObject({ name: 'JubianError', code: 'BUDGET_EXCEEDED' })
  expect(send).not.toHaveBeenCalled()
  expect(await ledger.records()).toEqual([])
})
