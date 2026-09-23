import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JubianLedger } from '../src/ledger.ts'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'jubian-ledger-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('JubianLedger', () => {
  it('claims a key once across distinct ledger instances sharing one resolved root', async () => {
    const ledgers = [new JubianLedger({ root }), new JubianLedger({ root: join(root, '.') })]
    const outcomes = await Promise.all(ledgers.map(ledger => ledger.begin({ idempotencyKey: 'shared',
      method: 'storyboard_model_settings', requestSha256: 'sha256:0' })))
    expect(outcomes.map(result => result.replayed).sort()).toEqual([false, true])
    expect(outcomes[0]?.record.record_id).toBe(outcomes[1]?.record.record_id)
  })

  it('gives distinct ledger instances unique record identities in the same millisecond', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-21T00:00:00.000Z'))
    try {
      const records = await Promise.all([
        new JubianLedger({ root }).begin({ idempotencyKey: 'first', method: 'storyboard_save', requestSha256: 'sha256:1' }),
        new JubianLedger({ root: join(root, 'other') }).begin({ idempotencyKey: 'second', method: 'storyboard_save', requestSha256: 'sha256:2' }),
      ])
      expect(new Set(records.map(result => result.record.record_id)).size).toBe(2)
    } finally { vi.useRealTimers() }
  })

  it('runs the authorization inside a serialized claim only for a new key', async () => {
    const ledger = new JubianLedger({ root })
    const input = { idempotencyKey: 'guarded', method: 'image_generate' as const, requestSha256: 'sha256:a' }
    await expect(ledger.beginChecked('guarded', async () => { throw new Error('not authorized') }))
      .rejects.toThrow('not authorized')
    expect(await ledger.records()).toEqual([])
    const authorize = vi.fn(async () => input)
    expect((await ledger.beginChecked('guarded', authorize)).replayed).toBe(false)
    expect((await ledger.beginChecked('guarded', authorize)).replayed).toBe(true)
    expect(authorize).toHaveBeenCalledTimes(1)
  })

  it('records the intent before the request leaves and settles it afterwards', async () => {
    const ledger = new JubianLedger({ root })
    const began = await ledger.begin({
      idempotencyKey: 'k-1', method: 'image_generate', requestSha256: `sha256:${'a'.repeat(64)}`,
      quotedAmount: '1.20', quoteStandardId: 42, quoteObservedAt: '2026-09-18T00:00:00.000Z',
    })
    expect(began.replayed).toBe(false)
    expect(began.record.at).toBeTruthy()
    expect(began.record.outcome).toBeNull()

    await ledger.settle('k-1', {
      httpStatus: 200, applicationCode: 200, responseSha256: `sha256:${'b'.repeat(64)}`, outcome: 'accepted',
    })
    const found = await ledger.find('k-1')
    expect(found?.outcome).toBe('accepted')
    expect(found?.http_status).toBe(200)
    expect(found?.response_sha256).toBe(`sha256:${'b'.repeat(64)}`)
  })

  it('replays an existing key instead of sending a second paid request', async () => {
    const ledger = new JubianLedger({ root })
    const input = { idempotencyKey: 'k-2', method: 'image_generate' as const,
      requestSha256: `sha256:${'c'.repeat(64)}` }
    await ledger.begin(input)
    const again = await ledger.begin(input)
    expect(again.replayed).toBe(true)
  })

  it('leaves a begin-only record as the unknown state a timeout produces', async () => {
    const ledger = new JubianLedger({ root })
    await ledger.begin({ idempotencyKey: 'k-3', method: 'storyboard_generate',
      requestSha256: `sha256:${'d'.repeat(64)}` })
    const found = await ledger.find('k-3')
    expect(found?.outcome).toBeNull()
    expect(found?.http_status).toBeNull()
  })

  it('appends one NDJSON line per event and never rewrites an earlier line', async () => {
    const ledger = new JubianLedger({ root })
    await ledger.begin({ idempotencyKey: 'k-4', method: 'image_generate',
      requestSha256: `sha256:${'e'.repeat(64)}` })
    await ledger.settle('k-4', { httpStatus: 500, applicationCode: null, responseSha256: null, outcome: 'unknown' })
    const files = await ledger.files()
    expect(files.length).toBe(1)
    const lines = (await readFile(files[0]!, 'utf8')).trim().split('\n')
    expect(lines.length).toBe(2)
    expect((JSON.parse(lines[0]!) as { phase: string }).phase).toBe('begin')
    expect((JSON.parse(lines[1]!) as { phase: string }).phase).toBe('settle')
  })
})
