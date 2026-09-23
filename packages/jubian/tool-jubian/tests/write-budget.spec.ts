import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import { afterEach, expect, it, vi } from 'vitest'
import { writeUnderLedger } from '../src/write.ts'

const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

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
