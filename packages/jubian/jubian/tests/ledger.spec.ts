import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JubianLedger } from '../src/ledger.ts'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'jubian-ledger-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('JubianLedger', () => {
  it('refuses a prepared intent under another key without recording it', async () => {
    const ledger = new JubianLedger({ root })
    await expect(ledger.beginChecked('claimed', async () => ({ idempotencyKey: 'different',
      method: 'storyboard_save', requestSha256: 'sha256:1' }))).rejects.toThrow('prepared key differs')
    expect(await ledger.records()).toEqual([])
  })

  it('refuses empty or duplicate batch claims before preparation', async () => {
    const ledger = new JubianLedger({ root })
    const prepare = vi.fn(async () => [])
    for (const keys of [[], ['duplicate', 'duplicate']]) {
      await expect(ledger.beginManyChecked(keys, prepare)).rejects.toThrow('distinct and nonempty')
    }
    expect(prepare).not.toHaveBeenCalled()
  })

  it('requires prepared batch keys to preserve the complete claimed order', async () => {
    const ledger = new JubianLedger({ root })
    const input = (idempotencyKey: string) => ({ idempotencyKey, method: 'storyboard_save' as const,
      requestSha256: `sha256:${idempotencyKey}` })
    for (const inputs of [[input('a')], [input('b'), input('a')]]) {
      await expect(ledger.beginManyChecked(['a', 'b'], async () => inputs)).rejects.toThrow('prepared batch keys differ')
    }
    expect(await ledger.records()).toEqual([])
  })

  it('propagates an unreadable ledger directory instead of reporting no records', async () => {
    const file = join(root, 'not-a-directory')
    await writeFile(file, 'owned')
    await expect(new JubianLedger({ root: file }).files()).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('reads older intents with absent optional quote metadata and ignores settlement-only records', async () => {
    const line = { phase: 'begin', record_id: 'legacy-1', idempotency_key: 'old', method: 'storyboard_save',
      at: '2026-09-01T00:00:00.000Z', request_sha256: 'sha256:old' }
    await writeFile(join(root, '2026-09-01.ndjson'), [
      JSON.stringify({ phase: 'settle', idempotency_key: 'orphan', outcome: 'unknown' }),
      JSON.stringify(line), JSON.stringify({ phase: 'metadata', idempotency_key: 'old' }), '',
    ].join('\n'))
    const ledger = new JubianLedger({ root })
    expect(await ledger.find('orphan')).toBeUndefined()
    expect(await ledger.find('old')).toMatchObject({ script_id: null, quoted_amount: null, quote_unit: null,
      quote_standard_id: null, quote_observed_at: null, outcome: null })
    expect(await ledger.records()).toHaveLength(1)
  })
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

  it('reserves a complete batch after one guard and refuses a partial replay', async () => {
    const ledger = new JubianLedger({ root })
    const inputs = ['a', 'b'].map(idempotencyKey => ({ idempotencyKey,
      method: 'storyboard_native_submit' as const, scriptId: 2708, requestSha256: `sha256:${idempotencyKey}`,
      quotedAmount: '1.00', quoteUnit: 'CNY' }))
    await expect(ledger.beginManyChecked(inputs.map(input => input.idempotencyKey),
      async () => { throw new Error('budget denied') })).rejects.toThrow('budget denied')
    expect(await ledger.records()).toEqual([])
    const records = await ledger.beginManyChecked(inputs.map(input => input.idempotencyKey),
      async () => inputs)
    expect(records.map(record => record.idempotency_key)).toEqual(['a', 'b'])
    expect(await ledger.records()).toHaveLength(2)
    await expect(ledger.beginManyChecked(['b', 'c'], async () => inputs))
      .rejects.toThrow('already has a record')
    expect(await ledger.find('c')).toBeUndefined()
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
