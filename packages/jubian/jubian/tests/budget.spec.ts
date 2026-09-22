/** The spend cap: what it counts, what it refuses, and what it never guesses. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JubianLedger, checkBudget, readAuthorization } from '../src/index.ts'
import type { JubianLedgerMethod } from '../src/index.ts'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true }) }))
})

/** One ledger and its authorization file, both inside a directory this spec owns. */
async function fixture(authorization?: Record<string, unknown>): Promise<{
  ledger: JubianLedger
  authorizationPath: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'jubian-budget-'))
  temporary.push(root)
  const ledgerRoot = join(root, 'ledger')
  const authorizationPath = join(ledgerRoot, 'authorization.json')
  if (authorization !== undefined) {
    await mkdir(ledgerRoot, { recursive: true })
    await writeFile(authorizationPath, JSON.stringify(authorization), 'utf8')
  }
  return { ledger: new JubianLedger({ root: ledgerRoot }), authorizationPath }
}

/** Write one settled or in-flight paid record into the ledger. */
async function record(ledger: JubianLedger, input: {
  key: string
  scriptId?: number | undefined
  amount?: string | undefined
  unit?: string | undefined
  method?: JubianLedgerMethod
  settle?: 'accepted' | 'unknown' | 'none'
}): Promise<void> {
  await ledger.begin({ idempotencyKey: input.key, method: input.method ?? 'image_generate',
    requestSha256: `sha256:${input.key}`,
    ...(input.scriptId === undefined ? {} : { scriptId: input.scriptId }),
    ...(input.amount === undefined ? {} : { quotedAmount: input.amount }),
    ...(input.unit === undefined ? {} : { quoteUnit: input.unit }) })
  if (input.settle === undefined || input.settle === 'none') return
  await ledger.settle(input.key, { httpStatus: 200, applicationCode: 0, responseSha256: 'sha256:r',
    outcome: input.settle })
}

const AUTHORIZED = { version: 1, projects: { '2708': { limit: '10.00', unit: 'CNY', note: '用户授权' } } }

describe('readAuthorization', () => {
  it('reads a version 1 authorization', async () => {
    const { authorizationPath } = await fixture(AUTHORIZED)
    const read = await readAuthorization(authorizationPath)
    expect(read?.projects['2708']?.limit).toBe('10.00')
  })

  it('treats a missing file as no authorization at all', async () => {
    const { authorizationPath } = await fixture()
    expect(await readAuthorization(authorizationPath)).toBeUndefined()
  })

  it('refuses a malformed file rather than reading it as no cap', async () => {
    const { authorizationPath, ledger } = await fixture()
    await mkdir(join(authorizationPath, '..'), { recursive: true })
    await writeFile(authorizationPath, '{ not json', 'utf8')
    await expect(readAuthorization(authorizationPath)).rejects.toThrow('不是合法 JSON')
    await expect(checkBudget({ ledger, method: 'image_generate', scriptId: 2708,
      quote: { amount: '1', unit: 'CNY' }, authorizationPath })).rejects.toThrow('不是合法 JSON')
  })

  it('refuses entries whose limit or unit is unusable', async () => {
    const { authorizationPath } = await fixture({ version: 1, projects: { '2708': { limit: '', unit: 'CNY' } } })
    await expect(readAuthorization(authorizationPath)).rejects.toThrow('limit 与 unit')
  })
})

describe('checkBudget', () => {
  it('lets a paid call run while no authorization exists, and says so', async () => {
    const { ledger, authorizationPath } = await fixture()
    const decision = await checkBudget({ ledger, method: 'image_generate', scriptId: 2708,
      quote: { amount: '1.00', unit: 'CNY' }, authorizationPath })
    expect(decision.status).toBe('unauthorized')
    expect(decision.reason).toContain('authorization.json')
  })

  it('never asks for an authorization on a call that cannot spend', async () => {
    const { ledger, authorizationPath } = await fixture()
    const decision = await checkBudget({ ledger, method: 'storyboard_save', scriptId: 2708, authorizationPath })
    expect(decision).toMatchObject({ status: 'authorized', reason: '' })
  })

  it('refuses a project the authorization does not cover', async () => {
    const { ledger, authorizationPath } = await fixture(AUTHORIZED)
    const decision = await checkBudget({ ledger, method: 'image_generate', scriptId: 9999,
      quote: { amount: '1.00', unit: 'CNY' }, authorizationPath })
    expect(decision.status).toBe('refused')
    expect(decision.reason).toContain('没有授权记录')
  })

  it('refuses a paid call with no project to attribute it to', async () => {
    const { ledger, authorizationPath } = await fixture(AUTHORIZED)
    const decision = await checkBudget({ ledger, method: 'image_generate',
      quote: { amount: '1.00', unit: 'CNY' }, authorizationPath })
    expect(decision.status).toBe('refused')
    expect(decision.reason).toContain('没有带项目 ID')
  })

  it('accepts a call that fits the remaining limit', async () => {
    const { ledger, authorizationPath } = await fixture(AUTHORIZED)
    await record(ledger, { key: 'a', scriptId: 2708, amount: '2.00', unit: 'CNY', settle: 'accepted' })
    const decision = await checkBudget({ ledger, method: 'image_generate', scriptId: 2708,
      quote: { amount: '3.00', unit: 'CNY' }, authorizationPath })
    expect(decision).toMatchObject({ status: 'authorized', settledCents: 200, reservedCents: 0,
      limitCents: 1_000 })
  })

  it('counts a call that was sent and never settled as reserved', async () => {
    const { ledger, authorizationPath } = await fixture(AUTHORIZED)
    await record(ledger, { key: 'a', scriptId: 2708, amount: '8.00', unit: 'CNY', settle: 'none' })
    const decision = await checkBudget({ ledger, method: 'image_generate', scriptId: 2708,
      quote: { amount: '3.00', unit: 'CNY' }, authorizationPath })
    expect(decision.status).toBe('refused')
    expect(decision.reason).toContain('在途')
    expect(decision.reservedCents).toBe(800)
  })

  it('refuses when the settled spend plus this quote passes the limit', async () => {
    const { ledger, authorizationPath } = await fixture(AUTHORIZED)
    await record(ledger, { key: 'a', scriptId: 2708, amount: '9.50', unit: 'CNY', settle: 'accepted' })
    const decision = await checkBudget({ ledger, method: 'image_generate', scriptId: 2708,
      quote: { amount: '1.00', unit: 'CNY' }, authorizationPath })
    expect(decision.status).toBe('refused')
    expect(decision.reason).toContain('授权上限')
  })

  it('refuses a paid call carrying no quote instead of counting it as zero', async () => {
    const { ledger, authorizationPath } = await fixture(AUTHORIZED)
    const decision = await checkBudget({ ledger, method: 'erase_subtitle', scriptId: 2708, authorizationPath })
    expect(decision.status).toBe('refused')
    expect(decision.reason).toContain('没有报价')
  })

  it('refuses while an earlier paid call has no quote at all', async () => {
    const { ledger, authorizationPath } = await fixture(AUTHORIZED)
    await record(ledger, { key: 'a', scriptId: 2708, settle: 'accepted' })
    const decision = await checkBudget({ ledger, method: 'image_generate', scriptId: 2708,
      quote: { amount: '1.00', unit: 'CNY' }, authorizationPath })
    expect(decision.status).toBe('refused')
    expect(decision.reason).toContain('没有报价')
    // The reason names the ledger records it could not price.
    expect(decision.reason).toContain('jub_')
  })

  it('refuses while a paid record carries no project, which no limit can cover', async () => {
    const { ledger, authorizationPath } = await fixture(AUTHORIZED)
    await record(ledger, { key: 'a', amount: '1.00', unit: 'CNY', settle: 'accepted' })
    const decision = await checkBudget({ ledger, method: 'image_generate', scriptId: 2708,
      quote: { amount: '1.00', unit: 'CNY' }, authorizationPath })
    expect(decision.status).toBe('refused')
    expect(decision.reason).toContain('没有项目归属')
  })

  it('refuses a quote whose unit is not the authorized one', async () => {
    const { ledger, authorizationPath } = await fixture(AUTHORIZED)
    await record(ledger, { key: 'a', scriptId: 2708, amount: '1.00', unit: 'USD', settle: 'accepted' })
    const decision = await checkBudget({ ledger, method: 'image_generate', scriptId: 2708,
      quote: { amount: '1.00', unit: 'USD' }, authorizationPath })
    expect(decision.status).toBe('refused')
    expect(decision.reason).toContain('单位')
  })

  it('ignores another project’s spend when judging this one', async () => {
    const { ledger, authorizationPath } = await fixture(AUTHORIZED)
    await record(ledger, { key: 'a', scriptId: 9999, amount: '9.00', unit: 'CNY', settle: 'accepted' })
    const decision = await checkBudget({ ledger, method: 'image_generate', scriptId: 2708,
      quote: { amount: '1.00', unit: 'CNY' }, authorizationPath })
    expect(decision.status).toBe('authorized')
    expect(decision.settledCents).toBe(0)
  })
})

describe('ledger.unresolved', () => {
  it('lists what a restart must reconcile, and nothing that already settled', async () => {
    const { ledger } = await fixture()
    await record(ledger, { key: 'sent-never-read', scriptId: 2708, amount: '1.00', unit: 'CNY' })
    await record(ledger, { key: 'provider-said-no', scriptId: 2708, amount: '1.00', unit: 'CNY',
      settle: 'unknown' })
    await record(ledger, { key: 'settled', scriptId: 2708, amount: '1.00', unit: 'CNY', settle: 'accepted' })
    const open = await ledger.unresolved()
    expect(open.map(item => item.idempotency_key)).toEqual(['sent-never-read', 'provider-said-no'])
    expect(open[0]?.outcome).toBeNull()
    expect(open[1]?.outcome).toBe('unknown')
  })

  it('filters by project', async () => {
    const { ledger } = await fixture()
    await record(ledger, { key: 'mine', scriptId: 2708 })
    await record(ledger, { key: 'other', scriptId: 9999 })
    expect((await ledger.unresolved(2708)).map(item => item.idempotency_key)).toEqual(['mine'])
  })

  it('reports nothing on an untouched ledger', async () => {
    const { ledger } = await fixture()
    expect(await ledger.unresolved()).toEqual([])
  })
})

describe('operator estimates', () => {
  const WITH_ESTIMATE = { version: 1, projects: { '2708': { limit: '20.00', unit: 'CNY',
    estimates: { storyboard_native_submit: '15.00' } } } }

  it('charges a call that cannot quote itself against the operator’s estimate', async () => {
    const { ledger, authorizationPath } = await fixture(WITH_ESTIMATE)
    const decision = await checkBudget({ ledger, method: 'storyboard_native_submit', scriptId: 2708,
      authorizationPath })
    expect(decision).toMatchObject({ status: 'authorized', estimated: true })
  })

  it('refuses the next one once the estimates have consumed the limit', async () => {
    const { ledger, authorizationPath } = await fixture(WITH_ESTIMATE)
    await record(ledger, { key: 'a', scriptId: 2708, amount: '15.00', unit: 'CNY',
      method: 'storyboard_native_submit', settle: 'accepted' })
    const decision = await checkBudget({ ledger, method: 'storyboard_native_submit', scriptId: 2708,
      authorizationPath })
    expect(decision.status).toBe('refused')
    expect(decision.reason).toContain('按授权文件里的估算')
  })

  it('prefers a real quote over the estimate and is not marked estimated', async () => {
    const { ledger, authorizationPath } = await fixture(WITH_ESTIMATE)
    const decision = await checkBudget({ ledger, method: 'storyboard_native_submit', scriptId: 2708,
      quote: { amount: '3.00', unit: 'CNY' }, authorizationPath })
    expect(decision).toMatchObject({ status: 'authorized' })
    expect(decision.estimated).toBeUndefined()
  })

  it('refuses an estimate that is not a decimal amount', async () => {
    const { authorizationPath } = await fixture({ version: 1, projects: { '2708': { limit: '20.00',
      unit: 'CNY', estimates: { storyboard_native_submit: 'lots' } } } })
    await expect(readAuthorization(authorizationPath)).rejects.toThrow('estimates.storyboard_native_submit')
  })

  it('still refuses a method the estimates do not cover', async () => {
    const { ledger, authorizationPath } = await fixture(WITH_ESTIMATE)
    const decision = await checkBudget({ ledger, method: 'image_generate', scriptId: 2708, authorizationPath })
    expect(decision.status).toBe('refused')
    expect(decision.reason).toContain('没有报价')
  })
})
