import { afterEach, describe, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MuseMarketLocal } from '../src/local.ts'
import { createMarketPackage } from '../src/package.ts'
import { directory, limits, manifest, resources } from './fixtures.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })
async function fixture() {
  const value = await directory(); cleanups.push(value.cleanup)
  const root = join(value.root, 'market'), local = new MuseMarketLocal({ root, limits })
  await local.ready()
  const first = await local.install(createMarketPackage(manifest, resources, limits))
  const second = await local.install(createMarketPackage({ ...manifest, version: '2.0.0' }, resources, limits))
  return { ...value, root, local, first, second, ledger: join(root, 'installations.json') }
}

describe('explicit activation storage', () => {
  it('preserves the exact v1 backup, migrates empty defaults and keeps M1 records disabled', async () => {
    const value = await fixture(), before = await readFile(value.ledger)
    await value.local.initializeActivation()
    expect(await readFile(join(value.root, 'installations.v1.backup.json'))).toEqual(before)
    expect(JSON.parse(await readFile(value.ledger, 'utf8'))).toMatchObject({ version: 2, activationRevision: 0, defaults: {} })
    expect(await value.local.defaults()).toEqual({ revision: 0, defaults: [] })
    expect(await value.local.list()).toEqual([value.first, value.second])
    const committed = await readFile(value.ledger)
    await value.local.initializeActivation()
    expect(await readFile(value.ledger)).toEqual(committed)
    expect(await value.local.verify(value.first.release)).toBeInstanceOf(Buffer)
  })

  it('compares the expected default, switches exact versions atomically and makes retries idempotent', async () => {
    const value = await fixture(); await value.local.initializeActivation()
    const first = await value.local.setDefault({ skillName: 'fixture-skill', expected: null, target: value.first.release.id })
    expect(first).toEqual({ revision: 1, defaults: [{ skillName: 'fixture-skill', releaseId: value.first.release.id }] })
    const second = await value.local.setDefault({ skillName: 'fixture-skill', expected: value.first.release.id, target: value.second.release.id })
    expect(second.revision).toBe(2)
    expect(await value.local.setDefault({ skillName: 'fixture-skill', expected: value.first.release.id, target: value.second.release.id })).toEqual(second)
    await expect(value.local.setDefault({ skillName: 'fixture-skill', expected: null, target: value.first.release.id })).rejects.toThrow('default-conflict')
    await expect(value.local.remove(value.second.release.id)).rejects.toThrow('disable-first')
    expect(await value.local.list()).toEqual([value.first, value.second])
    expect(await value.local.setDefault({ skillName: 'fixture-skill', expected: value.second.release.id, target: null }))
      .toEqual({ revision: 3, defaults: [] })
  })

  it('captures stable candidate metadata and exact archive identity before a Session commit', async () => {
    const value = await fixture(); await value.local.initializeActivation()
    await value.local.setDefault({ skillName: 'fixture-skill', expected: null, target: value.first.release.id })
    let committed = false
    const selected = await value.local.captureDefaults((entries) => {
      expect(entries[0]?.release).toEqual(value.first.release)
      expect(entries[0]?.skill).toEqual({ name: 'fixture-skill', description: 'Review a scene.',
        whenToUse: 'For local scene review.', invocation: { modelInvocable: false, userInvocable: true } })
      committed = true
    })
    expect(committed).toBe(true)
    await value.local.setDefault({ skillName: 'fixture-skill', expected: value.first.release.id, target: value.second.release.id })
    expect(selected[0]?.release.id).toBe(value.first.release.id)
  })

  it('refuses an oversized successor before backup or ledger writes', async () => {
    const value = await directory(); cleanups.push(value.cleanup)
    const root = join(value.root, 'market'), local = new MuseMarketLocal({ root, limits })
    await local.ready()
    await local.install(createMarketPackage({ ...manifest, description: '中文'.repeat(500) }, resources, limits))
    const ledger = join(root, 'installations.json'), before = await readFile(ledger)
    expect(before.byteLength).toBeGreaterThanOrEqual(1024)
    const bounded = new MuseMarketLocal({ root, limits: { ...limits, recordBytes: before.byteLength } })
    await expect(bounded.initializeActivation()).rejects.toThrow('record-too-large')
    expect(await readFile(ledger)).toEqual(before)
    await expect(readFile(join(root, 'installations.v1.backup.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not overwrite a conflicting backup or interpret a future version as empty', async () => {
    const value = await fixture(), before = await readFile(value.ledger)
    await writeFile(join(value.root, 'installations.v1.backup.json'), 'different original')
    await expect(value.local.initializeActivation()).rejects.toThrow('migration-backup-conflict')
    expect(await readFile(value.ledger)).toEqual(before)
    await writeFile(value.ledger, JSON.stringify({ version: 3, installations: [] }))
    await expect(value.local.initializeActivation()).rejects.toThrow('invalid-ledger')
    expect(JSON.parse(await readFile(value.ledger, 'utf8'))).toMatchObject({ version: 3 })
  })

  it('does not commit an altered target or a target belonging to another invocation name', async () => {
    const value = await fixture(); await value.local.initializeActivation()
    const before = await readFile(value.ledger)
    await expect(value.local.setDefault({ skillName: 'other-skill', expected: null, target: value.first.release.id }))
      .rejects.toThrow('not-installed')
    await writeFile(join(value.root, 'packages', value.first.release.id, 'skills/fixture-skill/assets/sample.bin'), 'changed')
    await expect(value.local.setDefault({ skillName: 'fixture-skill', expected: null, target: value.first.release.id }))
      .rejects.toThrow('modified-installation')
    expect(await readFile(value.ledger)).toEqual(before)
  })
})
