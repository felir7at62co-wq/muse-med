/** Local full-file hashing is independent of provider download budgets. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import * as files from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { recoveryProject } from '../src/video-recovery-project.ts'
import { readApprovedVideoSourceMetadata, verifyApprovedVideoSource, publishApprovedVideo } from '../src/video-recovery.ts'
import { readApprovedEpisodePlan, assertApprovedEpisodePlan } from '../src/approved-episode-plan.ts'
import { createVideoRecoveryFixture } from './fixtures/video-recovery-service.ts'
import { createEpisodeDeliveryFixture } from './fixtures/episode-delivery.ts'
import { hashEpisodeFile, assertEpisodeFileVersion, readEpisodeBytes } from '../src/episode-delivery.ts'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'episode-local-file-')))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'local.bin')
  await writeFile(path, 'exact local bytes')
  return { root, path, signal: new AbortController().signal }
}

it('streams a local file larger than the provider 512 MiB download limit', async () => {
  const f = await fixture(), size = 512 * 1024 * 1024 + 1
  await truncate(f.path, 0); await truncate(f.path, size)
  const actual = await hashEpisodeFile(f.path, f.signal), expected = createHash('sha256'), chunk = Buffer.alloc(1024 * 1024)
  for (let index = 0; index < 512; index++) expected.update(chunk)
  expected.update(Buffer.from([0]))
  expect(actual.bytes).toBe(size); expect(actual.sha256).toBe(expected.digest('hex'))
  await assertEpisodeFileVersion(actual, f.signal)
})

it('returns exact raw bounded metadata and honours cancellation before IO', async () => {
  const f = await fixture(), value = Buffer.from('exact local bytes')
  expect(await readEpisodeBytes(f.path, value.length, f.signal)).toEqual(value)
  await expect(readEpisodeBytes(f.path, value.length - 1, f.signal)).rejects.toThrow('bounded regular')
  const controller = new AbortController(); controller.abort(new Error('cancelled local read'))
  await expect(readEpisodeBytes(f.path, 100, controller.signal)).rejects.toThrow('cancelled local read')
  await expect(hashEpisodeFile(f.path, controller.signal)).rejects.toThrow('cancelled local read')
})

it('rejects directories and symlinks and detects a replaced current file version', async () => {
  const f = await fixture(), directory = join(f.root, 'directory'), alias = join(f.root, 'alias')
  await mkdir(directory); await symlink(f.path, alias)
  await expect(hashEpisodeFile(directory, f.signal)).rejects.toThrow('regular')
  await expect(hashEpisodeFile(alias, f.signal)).rejects.toThrow('regular')
  const version = await hashEpisodeFile(f.path, f.signal)
  await writeFile(f.path, 'changed')
  await expect(assertEpisodeFileVersion(version, f.signal)).rejects.toThrow('changed')
})

it('rejects a file changed between lstat and open', async () => {
  const f = await fixture(), open = files.open
  const spy = vi.spyOn(files, 'open').mockImplementation(async (...args) => {
    if (args[0] === f.path) {
      await files.rename(f.path, join(f.root, 'retained-original')); await writeFile(f.path, 'replacement')
    }
    return open(...args)
  })
  try { await expect(hashEpisodeFile(f.path, f.signal)).rejects.toThrow('changed while opening') }
  finally { spy.mockRestore() }
})

it('closes its actual descriptor after a read cancellation', async () => {
  const f = await fixture(), open = files.open, controller = new AbortController()
  let opened: Awaited<ReturnType<typeof open>> | undefined
  const spy = vi.spyOn(files, 'open').mockImplementation(async (...args) => {
    const file = await open(...args)
    if (args[0] === f.path) { opened = file; controller.abort(new Error('cancel during hash')) }
    return file
  })
  try {
    await expect(hashEpisodeFile(f.path, controller.signal)).rejects.toThrow('cancel during hash')
    await expect(opened?.stat()).rejects.toThrow('closed')
  } finally { spy.mockRestore() }
})


it('rejects a file changed after streaming before its final current-path check', async () => {
  const f = await fixture(), lstat = files.lstat
  let calls = 0
  const spy = vi.spyOn(files, 'lstat').mockImplementation(async (...args) => {
    if (args[0] === f.path && ++calls === 2) await writeFile(f.path, 'changed during local hashing')
    return lstat(...args)
  })
  try { await expect(hashEpisodeFile(f.path, f.signal)).rejects.toThrow('changed during hashing') }
  finally { spy.mockRestore() }
})


it('rechecks a present policy and preserves a non-ENOENT failure for an absent policy path', async () => {
  const f = await createEpisodeDeliveryFixture(), signal = new AbortController().signal
  const absent = await readApprovedEpisodePlan(f.project, 1, 1000000, signal), lstat = files.lstat
  const spy = vi.spyOn(files, 'lstat').mockImplementation(async (...args) => {
    if (args[0] === absent.bansPath) throw Object.assign(new Error('policy metadata unavailable'), { code: 'EACCES' })
    return lstat(...args)
  })
  try { await expect(assertApprovedEpisodePlan(absent, signal)).rejects.toThrow('policy metadata unavailable') }
  finally { spy.mockRestore() }
  await writeFile(absent.bansPath, '{}')
  const present = await readApprovedEpisodePlan(f.project, 1, 1000000, signal)
  await assertApprovedEpisodePlan(present, signal)
})


it('refuses a bounded project configuration removed after its regular-file inspection', async () => {
  const f = await createEpisodeDeliveryFixture(), path = join(f.project, 'project_config.json'), lstat = files.lstat
  let reads = 0
  const spy = vi.spyOn(files, 'lstat').mockImplementation(async (...args) => {
    if (args[0] === path && ++reads === 2) await files.unlink(path)
    return lstat(...args)
  })
  try { await expect(recoveryProject(f.project, new AbortController().signal, 1000000)).rejects.toThrow('configuration is unavailable') }
  finally { spy.mockRestore() }
})

it('refuses missing or rejected approval metadata without interpreting it as an available source', async () => {
  const f = await createEpisodeDeliveryFixture(), signal = new AbortController().signal
  // The decision file remains parseable and still binds its original report digest.
  const names = await files.readdir(f.directory)
  const actualDecision = names.find(name => name.endsWith('.decision.json'))
  if (actualDecision === undefined) throw new Error('The actual approval did not create its decision record')
  const decisionPath = join(f.directory, actualDecision), original = JSON.parse(await files.readFile(decisionPath, 'utf8')) as object
  await writeFile(decisionPath, JSON.stringify({ ...original, action: 'reject' }))
  await expect(readApprovedVideoSourceMetadata(f.project, f.key, 1000000, signal)).rejects.toThrow('approved video')
  await writeFile(decisionPath, JSON.stringify(original))
  const report = join(f.directory, createHash('sha256').update(f.key).digest('hex') + '.json'), lstat = files.lstat
  let reads = 0
  const spy = vi.spyOn(files, 'lstat').mockImplementation(async (...args) => {
    if (args[0] === report && ++reads === 2) await files.unlink(report)
    return lstat(...args)
  })
  try { await expect(readApprovedVideoSourceMetadata(f.project, f.key, 1000000, signal)).rejects.toThrow() }
  finally { spy.mockRestore() }
})

it('rejects a managed-source parent replaced by an alias after entry inspection', async () => {
  const f = await createEpisodeDeliveryFixture(), signal = new AbortController().signal
  const metadata = await readApprovedVideoSourceMetadata(f.project, f.key, 1000000, signal), realpath = files.realpath
  const source = join(f.project, metadata.path), retained = f.directory + '-retained'
  const spy = vi.spyOn(files, 'realpath').mockImplementation(async (...args) => {
    if (args[0] === source) {
      await files.rename(f.directory, retained); await files.symlink(retained, f.directory, 'dir')
    }
    return realpath(...args)
  })
  try { await expect(verifyApprovedVideoSource(f.project, metadata, signal)).rejects.toThrow('path changed') }
  finally { spy.mockRestore() }
})

it('replays a direct-copy helper from an intact exact output after its original source is absent', async () => {
  const f = await createEpisodeDeliveryFixture(), signal = new AbortController().signal
  const delivered = await f.recovery.deliverApprovedMp4(f.input)
  const sha = createHash('sha256').update(f.sourceBytes).digest('hex')
  const metadata = await readApprovedVideoSourceMetadata(f.project, f.key, 1000000, signal)
  await files.unlink(join(f.project, metadata.path))
  const repeated = await publishApprovedVideo(f.project, 42, f.input.digest, join(f.project, 'missing.mp4'), sha, signal)
  expect(repeated).toEqual(delivered.directDelivery)
  expect(f.fetch).not.toHaveBeenCalled()
})


it('requires a selected project before a source batch can capture original metadata', async () => {
  const f = await createVideoRecoveryFixture()
  await expect(f.service.withApprovedSources({ items: [f.input], metadataMaxBytes: 1000000 }, new AbortController().signal,
    async () => {})).rejects.toThrow('Select a Jubian project')
})

it('captures a legacy accepted original intent without inventing missing before-task IDs', async () => {
  const f = await createEpisodeDeliveryFixture()
  for (const name of await files.readdir(f.ledger.root)) {
    if (!name.endsWith('.ndjson')) continue
    const path = join(f.ledger.root, name), source = await files.readFile(path, 'utf8')
    const records = source.trim().split('\n').map(line => JSON.parse(line) as Record<string, string | number | object>)
    for (const record of records) delete record.before_task_ids
    await writeFile(path, records.map(record => JSON.stringify(record)).join('\n') + '\n')
  }
  await f.ledger.settle(f.key, { httpStatus: 200, applicationCode: 200, responseSha256: 'legacy-accepted', outcome: 'accepted' })
  await f.recovery.withApprovedSources({ items: [f.input], metadataMaxBytes: 1000000 }, new AbortController().signal,
    async (lease) => { expect(lease.sources[0]?.idempotencyKey).toBe(f.key) })
  expect(f.fetch).not.toHaveBeenCalled()
})
