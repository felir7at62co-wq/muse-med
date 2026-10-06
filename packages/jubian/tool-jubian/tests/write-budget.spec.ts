import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import { afterEach, expect, it, vi } from 'vitest'
import { acceptedWriteResponse, bodyHash, requireArguments, writeUnderLedger } from '../src/write.ts'

const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it('requires one storyboard-create body while accepting inline or file-backed requests', () => {
  expect(() => { requireArguments('jubian_storyboard', { method: 'create' }) }).toThrow('body or body_path')
  expect(() => { requireArguments('jubian_storyboard', { method: 'create', body: {} }) }).not.toThrow()
  expect(() => { requireArguments('jubian_storyboard', { method: 'create', body_path: 'storyboard.json' }) }).not.toThrow()
  expect(() => { requireArguments('jubian_catalog', {}) }).not.toThrow()
})

it.each([
  { http_status: null, application_code: 200, accepted: false },
  { http_status: 199, application_code: 200, accepted: false },
  { http_status: 300, application_code: 200, accepted: false },
  { http_status: 201, application_code: 0, accepted: true },
  { http_status: 201, application_code: null, accepted: false },
])('settles only documented transport and application success %j', ({ accepted, ...transport }) => {
  expect(acceptedWriteResponse(transport)).toBe(accepted)
})

it.each(['different-method', 'different-body', 'accepted-match'])
('checks a competing claim made during body preparation: %s', async (scenario) => {
  const root = await mkdtemp(join(tmpdir(), 'jubian-write-racing-'))
  temporary.push(root)
  const ledger = new JubianLedger({ root }), send = vi.fn(async () => ({
    transport: { http_status: 200, application_code: 200 }, response_sha256: null, data: null,
  }))
  const result = writeUnderLedger(ledger, 'racing', 'storyboard_save', async () => {
    await ledger.begin({ idempotencyKey: 'racing', method: scenario === 'different-method' ? 'asset_remove' : 'storyboard_save',
      requestSha256: bodyHash(scenario === 'different-body' ? { name: 'other' } : { name: 'same' }) })
    if (scenario === 'accepted-match') await ledger.settle('racing', {
      httpStatus: 200, applicationCode: 200, responseSha256: 'sha256:recorded', outcome: 'accepted',
    })
    return { name: 'same' }
  }, send)
  if (scenario === 'accepted-match') {
    expect(await result).toEqual({ replayed: true, outcome: 'accepted', response_sha256: 'sha256:recorded', data: null })
  } else await expect(result).rejects.toThrow('different write')
  expect(send).not.toHaveBeenCalled()
})

it('verifies a body-only replay and persists complete quote metadata for a fresh paid write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jubian-write-quote-metadata-'))
  temporary.push(root)
  const ledger = new JubianLedger({ root, defaultLimitCents: () => 1000 })
  const send = vi.fn(async () => ({ transport: { http_status: 200, application_code: 200 },
    response_sha256: 'sha256:response', data: { accepted: true } }))
  const authorizationPath = join(root, 'reviewed-authorization.json')
  await writeFile(authorizationPath, JSON.stringify({ version: 1, projects: { '2708': { limit: '10.00', unit: 'CNY' } } }))
  await ledger.begin({ idempotencyKey: 'body-only', method: 'storyboard_save', requestSha256: bodyHash({ name: 'ready' }) })
  expect(await writeUnderLedger(ledger, 'body-only', 'storyboard_save', () => ({ name: 'ready' }), send,
    undefined, { verifyReplayBody: true })).toMatchObject({ replayed: true, outcome: 'unknown' })
  await writeUnderLedger(ledger, 'priced', 'image_generate', () => ({ name: 'ready' }), send,
    () => ({ scriptId: 2708, amount: '1.00', unit: 'CNY', standardId: 123, observedAt: '2026-10-06T00:00:00Z' }),
    { authorizationPath })
  expect(await ledger.find('priced')).toMatchObject({ script_id: 2708, quoted_amount: '1.00',
    quote_unit: 'CNY', quote_standard_id: 123, quote_observed_at: '2026-10-06T00:00:00Z' })
  expect(send).toHaveBeenCalledOnce()
})

it('does not record or send a paid write when this user has no project grant', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jubian-ungranted-'))
  temporary.push(root)
  const ledger = new JubianLedger({ root: join(root, 'ledger') })
  const send = vi.fn(async () => ({ transport: { http_status: 200, application_code: 0 },
    response_sha256: null, data: {} }))
  await expect(writeUnderLedger(ledger, 'new-image', 'image_generate', () => ({}), send,
    () => ({ scriptId: 2708, amount: '1.00', unit: 'CNY' })))
    .rejects.toThrow('authorization.json')
  expect(send).not.toHaveBeenCalled()
  expect(await ledger.records()).toEqual([])
})

it('allows only one of two overlapping paid keys at the remaining limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jubian-concurrent-'))
  temporary.push(root)
  const ledgerRoot = join(root, 'ledger')
  await mkdir(ledgerRoot)
  await writeFile(join(ledgerRoot, 'authorization.json'), JSON.stringify({ version: 1, projects: {
    '2708': { limit: '1.00', unit: 'CNY', estimates: { storyboard_native_submit: '1.00' } },
  } }))
  const ledger = new JubianLedger({ root: ledgerRoot })
  const send = vi.fn(async () => ({ transport: { http_status: 200, application_code: 0 },
    response_sha256: null, data: {} }))
  let entered = 0
  let release!: () => void
  const bothReady = new Promise<void>((resolve) => { release = resolve })
  const submit = (key: string) => writeUnderLedger(ledger, key, 'storyboard_native_submit',
    async () => { if (++entered === 2) release(); await bothReady; return { isGenerate: 1 } },
    send, () => ({ scriptId: 2708 }))
  const results = await Promise.allSettled([submit('a'), submit('b')])
  expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
  expect(send).toHaveBeenCalledTimes(1)
  expect(await ledger.records()).toHaveLength(1)
})

it('reserves operator estimates across separate paid calls instead of losing their cost', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jubian-estimate-'))
  temporary.push(root)
  const ledgerRoot = join(root, 'ledger')
  await mkdir(ledgerRoot)
  await writeFile(join(ledgerRoot, 'authorization.json'), JSON.stringify({ version: 1, projects: {
    '2708': { limit: '2.00', unit: 'CNY', estimates: { storyboard_native_submit: '1.00' } },
  } }))
  const ledger = new JubianLedger({ root: ledgerRoot })
  const send = vi.fn(async () => ({ transport: { http_status: 200, application_code: 0 },
    response_sha256: null, data: {} }))
  const submit = (key: string) => writeUnderLedger(ledger, key, 'storyboard_native_submit',
    () => ({ isGenerate: 1 }), send, () => ({ scriptId: 2708 }))
  await submit('first')
  await submit('second')
  await expect(submit('third')).rejects.toThrow()
  expect(send).toHaveBeenCalledTimes(2)
  expect((await ledger.records()).map(row => [row.quoted_amount, row.quote_unit]))
    .toEqual([['1.00', 'CNY'], ['1.00', 'CNY']])
})
