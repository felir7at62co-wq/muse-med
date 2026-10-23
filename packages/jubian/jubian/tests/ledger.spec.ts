import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JubianLedger } from '../src/ledger.ts'
import type { JubianLedgerBegin } from '../src/ledger.ts'

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

  it('rejects a forged not_sent settlement without changing the intent', async () => {
    const ledger = new JubianLedger({ root })
    await ledger.begin({ idempotencyKey: 'forged-not-sent', method: 'image_generate',
      requestSha256: `sha256:${'f'.repeat(64)}` })
    await expect(ledger.settle('forged-not-sent', {
      httpStatus: null,
      applicationCode: null,
      responseSha256: null,
      outcome: 'not_sent',
    } as never)).rejects.toThrow('settlement outcome')
    expect((await ledger.find('forged-not-sent'))?.outcome).toBeNull()
  })

  it('does not recover an open intent or an unknown request with response evidence', async () => {
    const ledger = new JubianLedger({ root })
    const open = await ledger.begin({ idempotencyKey: 'open', method: 'image_generate',
      requestSha256: `sha256:${'1'.repeat(64)}` })
    const responded = await ledger.begin({ idempotencyKey: 'responded', method: 'image_generate',
      requestSha256: `sha256:${'2'.repeat(64)}` })
    await ledger.settle('responded', { httpStatus: 503, applicationCode: null,
      responseSha256: null, outcome: 'unknown' })
    const otherMethod = await ledger.begin({ idempotencyKey: 'other-method', method: 'storyboard_generate',
      requestSha256: `sha256:${'3'.repeat(64)}` })
    await ledger.settle('other-method', { httpStatus: null, applicationCode: null,
      responseSha256: null, outcome: 'unknown' })
    for (const [record, key] of [[open.record, 'open'], [responded.record, 'responded'],
      [otherMethod.record, 'other-method']] as const) {
      await expect(ledger.preDispatchAbort({ recordId: record.record_id, idempotencyKey: key,
        method: record.method, requestSha256: record.request_sha256, actor: 'desktop-host',
        guardEvidenceSha256: `sha256:${'a'.repeat(64)}`,
        reconciliationEvidenceSha256: `sha256:${'b'.repeat(64)}` }))
        .rejects.toThrow('only an unknown image request with no response evidence')
    }
    const unknown = await ledger.begin({ idempotencyKey: 'unknown', method: 'image_generate',
      requestSha256: `sha256:${'4'.repeat(64)}` })
    await ledger.settle('unknown', { httpStatus: null, applicationCode: null,
      responseSha256: null, outcome: 'unknown' })
    await expect(ledger.resumeChecked('unknown', { recordId: unknown.record.record_id, actor: 'desktop-host',
      guardEvidenceSha256: `sha256:${'a'.repeat(64)}`,
      reconciliationEvidenceSha256: `sha256:${'b'.repeat(64)}` }, async () => ({
      idempotencyKey: 'unknown', method: 'image_generate', requestSha256: unknown.record.request_sha256,
    }))).rejects.toThrow('no trusted pre-dispatch abort')
    expect((await ledger.find('open'))?.outcome).toBeNull()
    expect((await ledger.find('responded'))?.outcome).toBe('unknown')
    expect((await ledger.find('unknown'))?.outcome).toBe('unknown')
  })

  it('reopens one trusted pre-dispatch abort under the same key exactly once', async () => {
    const ledger = new JubianLedger({ root })
    const input = { idempotencyKey: 'recoverable', method: 'image_generate' as const,
      requestSha256: `sha256:${'3'.repeat(64)}`, scriptId: 2708, quotedAmount: '1.20', quoteUnit: 'CNY',
      quoteStandardId: 42, quoteObservedAt: '2026-10-20T00:00:00.000Z' }
    const began = await ledger.begin(input)
    await ledger.settle(input.idempotencyKey, { httpStatus: null, applicationCode: null,
      responseSha256: null, outcome: 'unknown' })
    const abort = { recordId: began.record.record_id, idempotencyKey: input.idempotencyKey,
      method: input.method, requestSha256: input.requestSha256, actor: 'desktop-host',
      guardEvidenceSha256: `sha256:${'c'.repeat(64)}`,
      reconciliationEvidenceSha256: `sha256:${'d'.repeat(64)}` }
    expect(await ledger.preDispatchAbort(abort)).toMatchObject({ outcome: 'not_sent',
      idempotency_key: input.idempotencyKey })
    expect(await ledger.preDispatchAbort(abort)).toMatchObject({ outcome: 'not_sent',
      idempotency_key: input.idempotencyKey })
    expect(await ledger.unresolved()).toEqual([])

    const evidence = { recordId: abort.recordId, actor: abort.actor,
      guardEvidenceSha256: abort.guardEvidenceSha256,
      reconciliationEvidenceSha256: abort.reconciliationEvidenceSha256 }
    const prepare = vi.fn(async () => ({ ...input, quoteObservedAt: '2026-10-20T01:00:00.000Z' }))
    expect(await ledger.resumeChecked(input.idempotencyKey, evidence, prepare)).toMatchObject({
      record_id: began.record.record_id, idempotency_key: input.idempotencyKey, outcome: null,
      quote_observed_at: '2026-10-20T01:00:00.000Z',
    })
    await expect(ledger.resumeChecked(input.idempotencyKey, evidence, prepare))
      .rejects.toThrow('already resumed')
    await ledger.settle(input.idempotencyKey, { httpStatus: null, applicationCode: null,
      responseSha256: null, outcome: 'unknown' })
    await expect(ledger.preDispatchAbort(abort)).rejects.toThrow('already resumed')
    await expect(ledger.resumeChecked(input.idempotencyKey, evidence, prepare))
      .rejects.toThrow('already resumed')
    expect(prepare).toHaveBeenCalledTimes(1)

    const lines = (await readFile((await ledger.files())[0]!, 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>)
    expect(lines.map(line => line.phase)).toEqual(['begin', 'settle', 'pre_dispatch_abort', 'resume', 'settle'])
    expect(lines[2]).toMatchObject({ record_id: began.record.record_id,
      idempotency_key: input.idempotencyKey, method: input.method, request_sha256: input.requestSha256,
      actor: abort.actor, guard_evidence_sha256: abort.guardEvidenceSha256,
      reconciliation_evidence_sha256: abort.reconciliationEvidenceSha256 })
  })

  it('rejects mismatched recovery evidence and prepared intent identity without appending', async () => {
    const ledger = new JubianLedger({ root })
    const input: JubianLedgerBegin = { idempotencyKey: 'bound', method: 'image_generate',
      requestSha256: `sha256:${'4'.repeat(64)}`, scriptId: 2708, quotedAmount: '2.00', quoteUnit: 'CNY',
      quoteStandardId: 7, quoteObservedAt: '2026-10-20T00:00:00.000Z' }
    const began = await ledger.begin(input)
    await ledger.settle(input.idempotencyKey, { httpStatus: null, applicationCode: null,
      responseSha256: null, outcome: 'unknown' })
    const abort = { recordId: began.record.record_id, idempotencyKey: input.idempotencyKey,
      method: input.method, requestSha256: input.requestSha256, actor: 'desktop-host',
      guardEvidenceSha256: `sha256:${'e'.repeat(64)}`,
      reconciliationEvidenceSha256: `sha256:${'f'.repeat(64)}` }
    await expect(ledger.preDispatchAbort({ ...abort, recordId: 'another-record' }))
      .rejects.toThrow('identity differs')
    await ledger.preDispatchAbort(abort)

    const evidence = { recordId: abort.recordId, actor: abort.actor,
      guardEvidenceSha256: abort.guardEvidenceSha256,
      reconciliationEvidenceSha256: abort.reconciliationEvidenceSha256 }
    const prepare = vi.fn(async () => input)
    for (const changed of [
      { recordId: 'another-record' },
      { actor: 'another-host' },
      { guardEvidenceSha256: `sha256:${'0'.repeat(64)}` },
      { reconciliationEvidenceSha256: `sha256:${'9'.repeat(64)}` },
    ]) {
      await expect(ledger.resumeChecked(input.idempotencyKey, { ...evidence, ...changed }, prepare))
        .rejects.toThrow('evidence differs')
    }
    expect(prepare).not.toHaveBeenCalled()

    const mismatches: JubianLedgerBegin[] = [
      { ...input, idempotencyKey: 'another-key' },
      { ...input, method: 'storyboard_save' },
      { ...input, requestSha256: `sha256:${'5'.repeat(64)}` },
      { ...input, scriptId: 2709 },
      { ...input, quotedAmount: '2.01' },
      { ...input, quoteUnit: 'USD' },
      { ...input, quoteStandardId: 8 },
    ]
    for (const prepared of mismatches) {
      await expect(ledger.resumeChecked(input.idempotencyKey, evidence, async () => prepared))
        .rejects.toThrow('identity differs')
    }
    expect((await ledger.find(input.idempotencyKey))?.outcome).toBe('not_sent')
    const lines = (await readFile((await ledger.files())[0]!, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(3)
  })

  it('refuses incomplete recovery proof, missing intents and changed abort identities without appending', async () => {
    const ledger = new JubianLedger({ root })
    const input: JubianLedgerBegin = { idempotencyKey: 'proof', method: 'image_generate', requestSha256: 'sha256:body' }
    const started = await ledger.begin(input)
    await ledger.settle(input.idempotencyKey, { httpStatus: null, applicationCode: null,
      responseSha256: null, outcome: 'unknown' })
    const proof = { recordId: started.record.record_id, idempotencyKey: input.idempotencyKey,
      method: input.method, requestSha256: input.requestSha256, actor: 'host',
      guardEvidenceSha256: 'a'.repeat(64), reconciliationEvidenceSha256: 'b'.repeat(64) }
    for (const patch of [{ recordId: ' ' }, { actor: ' ' }, { guardEvidenceSha256: '' },
      { reconciliationEvidenceSha256: '' }]) {
      await expect(ledger.preDispatchAbort({ ...proof, ...patch })).rejects.toThrow('must be nonempty')
    }
    for (const patch of [{ guardEvidenceSha256: 'not-a-digest' }, { reconciliationEvidenceSha256: 'NOT-SHA256' }]) {
      await expect(ledger.preDispatchAbort({ ...proof, ...patch })).rejects.toThrow('must be SHA-256')
    }
    for (const patch of [{ idempotencyKey: '' }, { requestSha256: ' ' }]) {
      await expect(ledger.preDispatchAbort({ ...proof, ...patch })).rejects.toThrow('key and request hash')
    }
    await expect(ledger.preDispatchAbort({ ...proof, idempotencyKey: 'absent' })).rejects.toThrow('no matching intent')
    await expect(ledger.resumeChecked('absent', proof, async () => input)).rejects.toThrow('no matching intent')
    for (const patch of [{ recordId: 'another-record' }, { method: 'storyboard_save' as const }, { requestSha256: 'another-body' }]) {
      await expect(ledger.preDispatchAbort({ ...proof, ...patch })).rejects.toThrow('identity differs')
    }
    expect((await readFile((await ledger.files())[0]!, 'utf8')).trim().split('\n')).toHaveLength(2)
    await ledger.preDispatchAbort(proof)
    await expect(ledger.preDispatchAbort({ ...proof, actor: 'another-host' })).rejects.toThrow('already recorded with different evidence')
    expect((await ledger.find(input.idempotencyKey))?.outcome).toBe('not_sent')
  })

  it('ignores malformed durable abort evidence and reads legacy resume metadata without a new quote timestamp', async () => {
    const ledger = new JubianLedger({ root })
    const input: JubianLedgerBegin = { idempotencyKey: 'legacy-recovery', method: 'image_generate',
      requestSha256: 'sha256:body', quoteObservedAt: '2026-10-20T00:00:00.000Z' }
    const started = await ledger.begin(input)
    await ledger.settle(input.idempotencyKey, { httpStatus: null, applicationCode: null,
      responseSha256: null, outcome: 'unknown' })
    const file = (await ledger.files())[0]!
    const abort = { phase: 'pre_dispatch_abort', record_id: started.record.record_id,
      idempotency_key: input.idempotencyKey, method: input.method, request_sha256: input.requestSha256,
      actor: 'host', guard_evidence_sha256: 'a'.repeat(64), reconciliation_evidence_sha256: 'b'.repeat(64) }
    await appendFile(file, JSON.stringify({ ...abort, actor: null }) + '\n')
    expect((await ledger.find(input.idempotencyKey))?.outcome).toBe('unknown')
    await appendFile(file, JSON.stringify(abort) + '\n')
    expect((await ledger.find(input.idempotencyKey))?.outcome).toBe('not_sent')
    await appendFile(file, JSON.stringify({ ...abort, phase: 'resume', script_id: null,
      quoted_amount: null, quote_unit: null, quote_standard_id: null }) + '\n')
    expect(await ledger.find(input.idempotencyKey)).toMatchObject({ outcome: null,
      quote_observed_at: input.quoteObservedAt })
  })

  it('resumes an unquoted intent without changing its identity and filters unresolved project records', async () => {
    const ledger = new JubianLedger({ root })
    const input: JubianLedgerBegin = { idempotencyKey: 'unquoted', method: 'image_generate', requestSha256: 'sha256:body' }
    const started = await ledger.begin(input)
    await ledger.settle(input.idempotencyKey, { httpStatus: null, applicationCode: null,
      responseSha256: null, outcome: 'unknown' })
    const proof = { recordId: started.record.record_id, idempotencyKey: input.idempotencyKey,
      method: input.method, requestSha256: input.requestSha256, actor: 'host',
      guardEvidenceSha256: 'a'.repeat(64), reconciliationEvidenceSha256: 'b'.repeat(64) }
    const aborted = await ledger.preDispatchAbort(proof)
    expect(await ledger.find(input.idempotencyKey)).toEqual(aborted)
    expect(await ledger.resumeChecked(input.idempotencyKey, proof, async () => input)).toEqual(started.record)
    expect(await ledger.find(input.idempotencyKey)).toEqual(started.record)
    await ledger.begin({ ...input, idempotencyKey: 'project-open', scriptId: 7 })
    await ledger.begin({ ...input, idempotencyKey: 'project-accepted', scriptId: 7 })
    await ledger.settle('project-accepted', { httpStatus: 200, applicationCode: 200,
      responseSha256: 'sha256:receipt', outcome: 'accepted' })
    await ledger.begin({ ...input, idempotencyKey: 'other-project', scriptId: 8 })
    await ledger.settle('other-project', { httpStatus: null, applicationCode: null,
      responseSha256: null, outcome: 'unknown' })
    expect((await ledger.unresolved(7)).map(record => record.idempotency_key)).toEqual(['project-open'])
    expect((await ledger.unresolved()).map(record => record.idempotency_key)).toEqual(['unquoted', 'project-open', 'other-project'])
  })

})
