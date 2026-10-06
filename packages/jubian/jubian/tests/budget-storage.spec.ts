/** Budget persistence fails closed while releasing only the writer's own lock. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { JubianLedger } from '../src/ledger.ts'
import { readProjectBudget, updateProjectBudget } from '../src/budget.ts'

const fault = vi.hoisted(() => ({ mode: '' }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...fs,
    lstat: async (...args: Parameters<typeof fs.lstat>) => {
      if (fault.mode === 'stat' && String(args[0]).endsWith('authorization.json')) {
        throw Object.assign(new Error('authorization metadata unavailable'), { code: 'EACCES' })
      }
      return await fs.lstat(...args)
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      await fs.rename(...args)
      if (fault.mode === 'readback') await fs.writeFile(args[1], JSON.stringify({ version: 1, projects: {} }))
    },
    unlink: async (...args: Parameters<typeof fs.unlink>) => {
      if (fault.mode === 'temporary-cleanup' && String(args[0]).endsWith('.tmp')) {
        throw Object.assign(new Error('temporary cleanup unavailable'), { code: 'EACCES' })
      }
      await fs.unlink(...args)
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args)
      if (fault.mode === 'lock-close' && String(args[0]).endsWith('.authorization.lock')) {
        const close = handle.close.bind(handle)
        vi.spyOn(handle, 'close').mockImplementationOnce(async () => {
          await close()
          throw new Error('lock close failed')
        })
      }
      return handle
    },
  }
})

const roots: string[] = []
afterEach(async () => {
  fault.mode = ''
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'jubian-budget-storage-'))
  roots.push(root)
  const ledger = new JubianLedger({ root, defaultLimitCents: () => 1000 })
  const before = await readProjectBudget(ledger, 2708)
  return { ledger, input: { script_id: 2708, limit_cents: 2000, expected_revision: before.revision,
    authorization: { kind: 'settings' as const, reference: 'settings-ui', text: 'User submitted 20 CNY' } } }
}

it('refuses unavailable file metadata before opening a writer lock', async () => {
  const { ledger, input } = await fixture()
  fault.mode = 'stat'
  await expect(updateProjectBudget(ledger, input)).rejects.toMatchObject({ code: 'EACCES' })
  await expect(readFile(join(ledger.root, '.authorization.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('reports a competing replacement during readback instead of claiming the approved ceiling was saved', async () => {
  const { ledger, input } = await fixture()
  fault.mode = 'readback'
  await expect(updateProjectBudget(ledger, input)).rejects.toThrow('readback did not match')
  expect(await readProjectBudget(ledger, 2708)).toMatchObject({ source: 'default', limit_cents: 1000 })
  await expect(readFile(join(ledger.root, '.authorization.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['temporary-cleanup', 'lock-close'])('reports %s failure and still removes its own writer lock', async (mode) => {
  const { ledger, input } = await fixture()
  fault.mode = mode
  await expect(updateProjectBudget(ledger, input)).rejects.toThrow(mode === 'lock-close' ? 'lock close' : 'temporary cleanup')
  fault.mode = ''
  expect(await readProjectBudget(ledger, 2708)).toMatchObject({ source: 'project', limit_cents: 2000 })
  await expect(readFile(join(ledger.root, '.authorization.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('preserves valid approval history when appending another approved amount', async () => {
  const { ledger, input } = await fixture(), path = join(ledger.root, 'authorization.json')
  const history = [{ limit: '10.00', kind: 'settings', reference: 'earlier', text: 'Earlier approval', at: '2026-10-05T00:00:00Z' }]
  await writeFile(path, JSON.stringify({ version: 1, projects: {
    '2708': { limit: '10.00', unit: 'CNY', authorization_history: history },
  } }))
  const before = await readProjectBudget(ledger, 2708)
  await updateProjectBudget(ledger, { ...input, expected_revision: before.revision })
  const saved = JSON.parse(await readFile(path, 'utf8')) as { projects: Record<string, { authorization_history: unknown[] }> }
  expect(saved.projects['2708']?.authorization_history[0]).toEqual(history[0])
  expect(saved.projects['2708']?.authorization_history).toHaveLength(2)
})
