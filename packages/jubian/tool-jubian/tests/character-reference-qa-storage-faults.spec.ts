/** Filesystem and SQLite fault paths retain the original authorization failure. */
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openCharacterReferenceQaAuthorizationStore } from '../src/character-reference-qa-authorization.ts'

const fault = vi.hoisted(() => ({ realpathAt: '', target: '', open: false }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs,
    realpath: async (path: string) => path === fault.realpathAt ? fault.target : await fs.realpath(path),
    open: async (...args: Parameters<typeof fs.open>) => {
      if (fault.open) throw Object.assign(new Error('device refuses database creation'), { code: 'EIO' })
      return await fs.open(...args)
    },
  }
})
const dirs: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  fault.realpathAt = ''; fault.target = ''; fault.open = false
  for (const root of dirs.splice(0)) await rm(root, { recursive: true, force: true })
})
async function location() {
  const dataRoot = await mkdtemp(join(tmpdir(), 'reference-storage-fault-'))
  dirs.push(dataRoot)
  return { dataRoot, databasePath: join(dataRoot, 'nested', 'authorization.sqlite') }
}

describe('character-reference storage faults', () => {
  it('refuses a directory or file moved outside the trusted root during canonical-path resolution', async () => {
    for (const entry of ['nested', 'nested/authorization.sqlite']) {
      const paths = await location()
      fault.realpathAt = join(paths.dataRoot, entry)
      fault.target = join(paths.dataRoot, '..', 'outside-authorization')
      await expect(openCharacterReferenceQaAuthorizationStore(paths)).rejects.toThrow('outside its trusted data root')
      fault.realpathAt = ''
    }
  })

  it('preserves an operating-system open error instead of treating it as an existing database', async () => {
    const paths = await location()
    fault.open = true
    await expect(openCharacterReferenceQaAuthorizationStore(paths))
      .rejects.toMatchObject({ code: 'invalid-config', cause: { code: 'EIO' } })
  })

  it.each([false, true])('rolls back fresh schema creation and preserves its failure when rollback fails: %s', async (rollbackFails) => {
    const paths = await location()
    const exec = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, 'exec')?.value as (this: DatabaseSync, sql: string) => void
    const calls: string[] = []
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
      calls.push(sql)
      if (sql.includes('CREATE TABLE IF NOT EXISTS character_reference_qa_authorizations')) throw new Error('schema write failed')
      if (rollbackFails && sql === 'ROLLBACK') throw new Error('rollback also failed')
      exec.call(this, sql)
    })
    await expect(openCharacterReferenceQaAuthorizationStore(paths)).rejects.toMatchObject({ cause: { message: 'schema write failed' } })
    expect(calls).toContain('ROLLBACK')
  })

  it.each([false, true])('rolls back a v1 migration without replacing the original error: %s', async (rollbackFails) => {
    const paths = await location()
    const initial = await openCharacterReferenceQaAuthorizationStore(paths)
    initial?.close()
    const legacy = new DatabaseSync(paths.databasePath)
    legacy.exec('DROP TABLE character_reference_qa_generation_recovery_events; PRAGMA user_version = 1')
    legacy.close()
    await chmod(paths.databasePath, 0o600)
    const exec = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, 'exec')?.value as (this: DatabaseSync, sql: string) => void
    const calls: string[] = []
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
      calls.push(sql)
      if (sql.includes('CREATE TABLE IF NOT EXISTS character_reference_qa_generation_recovery_events')) throw new Error('migration write failed')
      if (rollbackFails && sql === 'ROLLBACK') throw new Error('rollback also failed')
      exec.call(this, sql)
    })
    await expect(openCharacterReferenceQaAuthorizationStore(paths)).rejects.toMatchObject({ cause: { message: 'migration write failed' } })
    expect(calls).toContain('ROLLBACK')
  })
})
