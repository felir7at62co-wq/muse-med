import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { JubianLedger } from '../src/ledger.ts'
import { checkBudget, readProjectBudget, updateProjectBudget } from '../src/budget.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))) })

async function bench() {
  const root = await mkdtemp(join(tmpdir(), 'jubian-budget-update-'))
  roots.push(root)
  return new JubianLedger({ root, defaultLimitCents: () => 400000 })
}

it('updates one authorized project immediately without changing defaults, spend, reservations or estimates', async () => {
  const ledger = await bench()
  await writeFile(join(ledger.root, 'authorization.json'), JSON.stringify({ version: 1, projects: {
    '2708': { limit: '4000.00', unit: 'CNY', estimates: { storyboard_native_submit: '8.00' } },
    '2709': { limit: '100.00', unit: 'CNY', note: 'other project' },
  } }))
  const accepted = await ledger.begin({ idempotencyKey: 'paid', method: 'image_generate', scriptId: 2708,
    requestSha256: 'sha256:accepted', quotedAmount: '100.00', quoteUnit: 'CNY' })
  await ledger.settle('paid', { httpStatus: 200, applicationCode: 200,
    responseSha256: 'sha256:response', outcome: 'accepted' })
  await ledger.begin({ idempotencyKey: 'pending', method: 'storyboard_native_submit', scriptId: 2708,
    requestSha256: 'sha256:pending', quotedAmount: '8.00', quoteUnit: 'CNY' })
  const before = await readProjectBudget(ledger, 2708)
  expect(before).toMatchObject({ limit_cents: 400000, settled_cents: 10000, reserved_cents: 800 })
  const updated = await updateProjectBudget(ledger, { script_id: 2708, limit_cents: 500000,
    expected_revision: before.revision, authorization: { kind: 'user-message', reference: 'session/message', text: '项目预算调整为5000元' } })
  expect(updated).toMatchObject({ limit_cents: 500000, settled_cents: 10000, reserved_cents: 800 })
  expect(await readProjectBudget(ledger, 2708)).toEqual(updated)
  expect(await checkBudget({ ledger, method: 'storyboard_native_submit', scriptId: 2708 })).toMatchObject({ status: 'authorized', limitCents: 500000 })
  expect(await readProjectBudget(ledger, 2710)).toMatchObject({ limit_cents: 400000, source: 'default' })
  const document: unknown = JSON.parse(await readFile(join(ledger.root, 'authorization.json'), 'utf8'))
  expect(document).toMatchObject({ projects: {
    '2708': { estimates: { storyboard_native_submit: '8.00' } },
    '2709': { limit: '100.00', unit: 'CNY', note: 'other project' },
  } })
  expect(await ledger.find('paid')).toMatchObject({ record_id: accepted.record.record_id, outcome: 'accepted' })
})

it('rejects stale concurrent updates and limits below accounted spend', async () => {
  const ledger = await bench()
  const before = await readProjectBudget(ledger, 2708)
  const input = { script_id: 2708, expected_revision: before.revision,
    authorization: { kind: 'settings' as const, reference: 'settings-ui', text: 'User submitted budget' } }
  const updates = await Promise.allSettled([updateProjectBudget(ledger, { ...input, limit_cents: 500000 }),
    updateProjectBudget(ledger, { ...input, limit_cents: 600000 })])
  expect(updates.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(updates.filter(result => result.status === 'rejected')).toHaveLength(1)
  await ledger.begin({ idempotencyKey: 'reserved', method: 'image_generate', scriptId: 2708,
    requestSha256: 'sha256:reserved', quotedAmount: '20.00', quoteUnit: 'CNY' })
  const current = await readProjectBudget(ledger, 2708)
  await expect(updateProjectBudget(ledger, { ...input, expected_revision: current.revision, limit_cents: 1000 }))
    .rejects.toThrow('settled and reserved')
  expect(await readProjectBudget(ledger, 2708)).toEqual(current)
})

it('fails closed on invalid authorization, unsupported units and malformed files', async () => {
  const ledger = await bench()
  const current = await readProjectBudget(ledger, 2708)
  await expect(updateProjectBudget(ledger, { script_id: 2708, expected_revision: current.revision, limit_cents: -1,
    authorization: { kind: 'settings', reference: 'settings-ui', text: 'Budget' } })).rejects.toThrow()
  await expect(updateProjectBudget(ledger, { script_id: 2708, expected_revision: current.revision, limit_cents: 500000,
    authorization: { kind: 'user-message', reference: '', text: '' } })).rejects.toThrow('authorization')
  await writeFile(join(ledger.root, 'authorization.json'), '{bad')
  await expect(readProjectBudget(ledger, 2708)).rejects.toThrow('JSON')
})

it.each([{ version: 1, projects: [] }, { version: 1, projects: { '2708': [] } },
  { version: 1, projects: { '2708': null } }, { version: 1, projects: { '2708': { limit: '4000', unit: 'CNY', estimates: [] } } }])
('refuses invalid stored authorization before replacing any bytes: %j', async (document) => {
  const ledger = await bench()
  const path = join(ledger.root, 'authorization.json'), original = JSON.stringify(document)
  await writeFile(path, original)
  await expect(readProjectBudget(ledger, 2708)).rejects.toThrow()
  await expect(updateProjectBudget(ledger, { script_id: 2708, limit_cents: 500000, expected_revision: 'stale',
    authorization: { kind: 'settings', reference: 'ui', text: 'User submitted budget' } })).rejects.toThrow()
  expect(await readFile(path, 'utf8')).toBe(original)
})

it('serializes a budget reduction behind an in-flight reservation from another instance of the same ledger', async () => {
  const ledger = await bench(), other = new JubianLedger({ root: ledger.root, defaultLimitCents: () => 400000 })
  const before = await readProjectBudget(ledger, 2708)
  let release: () => void = () => {}, started: () => void = () => {}
  const hold = new Promise<void>((resolve) => { release = resolve })
  const admitted = new Promise<void>((resolve) => { started = resolve })
  const claim = other.beginChecked('parallel-claim', async () => {
    started(); await hold
    return { idempotencyKey: 'parallel-claim', method: 'image_generate', scriptId: 2708,
      requestSha256: 'sha256:parallel', quotedAmount: '20.00', quoteUnit: 'CNY' }
  })
  await admitted
  const edit = updateProjectBudget(ledger, { script_id: 2708, limit_cents: 1000, expected_revision: before.revision,
    authorization: { kind: 'settings', reference: 'ui', text: 'User submitted 10 CNY' } })
  const outcome = Promise.allSettled([claim, edit])
  release()
  const results = await outcome
  expect(results[0]?.status).toBe('fulfilled')
  expect(results[1]?.status).toBe('rejected')
  if (results[1]?.status === 'rejected') expect(results[1].reason).toHaveProperty('message', 'Budget cannot be lower than settled and reserved spend')
  expect(await readProjectBudget(ledger, 2708)).toMatchObject({ limit_cents: 400000, reserved_cents: 2000 })
})

it('does not remove another budget writer lock or overwrite an unresolved unknown reservation', async () => {
  const ledger = await bench(), before = await readProjectBudget(ledger, 2708)
  const lock = join(ledger.root, '.authorization.lock')
  await writeFile(lock, 'another writer')
  await expect(updateProjectBudget(ledger, { script_id: 2708, limit_cents: 500000, expected_revision: before.revision,
    authorization: { kind: 'settings', reference: 'ui', text: 'Budget' } })).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await readFile(lock, 'utf8')).toBe('another writer')
})
