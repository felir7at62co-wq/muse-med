/** Real episode journals reject corrupt or foreign files without replaying or replacing admitted work. */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import * as files from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { readApprovedEpisodePlan } from '../src/approved-episode-plan.ts'
import * as library from '../src/episode-delivery.ts'
import { createEpisodeDeliveryFixture } from './fixtures/episode-delivery.ts'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))

const object = (value: unknown): Record<string, unknown> => z.record(z.string(), z.unknown()).parse(value)

async function selected() {
  const f = await createEpisodeDeliveryFixture()
  onTestFinished(() => { expect(f.fetch).not.toHaveBeenCalled() })
  const readiness = await f.service.episodeReadiness(f.planInput)
  expect(readiness.ready, readiness.issues.join('; ')).toBe(true)
  if (readiness.digest === null) throw new Error('The actual fixture did not produce readiness')
  const input = { ...f.planInput, digest: readiness.digest }
  const keys = (await f.ledger.records()).map(record => record.idempotency_key).sort()
  return { ...f, input, keys }
}

async function completed() {
  const f = await selected(), admitted = await f.service.admitEpisode(f.input)
  await f.renderer.entered; f.renderer.release()
  await expect.poll(async () => (await f.service.episodeStatus(f.input)).state).toBe('completed')
  const status = await f.service.episodeStatus(f.input)
  if (status.attempt === null || status.execution === undefined || status.output === undefined) {
    throw new Error('Completed fixture omitted its original attempt, execution or publication facts')
  }
  expect(status.attempt).toBe(admitted.attempt)
  const root = join(f.project, '.muse', 'episode-delivery', status.attempt)
  const outputPath = join(f.project, status.output.path), outputBytes = await readFile(outputPath), outputStat = await stat(outputPath)
  const intent = await readFile(join(root, 'intent.json'))
  const footprint = (await readdir(root)).sort(), calls = f.renderer.calls, encodes = f.renderer.encodes
  const outputUnchanged = async (): Promise<void> => {
    expect((await f.ledger.records()).map(record => record.idempotency_key).sort()).toEqual(f.keys)
    expect(f.renderer.calls).toBe(calls); expect(f.renderer.encodes).toBe(encodes)
    expect(await readFile(outputPath)).toEqual(outputBytes)
    expect((await stat(outputPath)).ino).toBe(outputStat.ino)
  }
  const preserved = async (): Promise<void> => {
    await outputUnchanged()
    expect((await readdir(root)).sort()).toEqual(footprint)
  }
  return { ...f, status, execution: status.execution, root, outputPath, outputBytes, outputInode: outputStat.ino,
    intent, preserved, outputUnchanged }
}

type Journal = 'intent' | 'state' | 'receipt' | 'job' | 'execution' | 'drain'
interface Fault {
  name: string
  file: Journal
  outcome?: 'unknown'
  change: (record: Record<string, unknown>) => object | string
}
const foreign = (): string => randomUUID()
const faults: Fault[] = [
  { name: 'malformed intent JSON', file: 'intent', change: () => '{"version":' },
  { name: 'unsupported intent version', file: 'intent', change: record => ({ ...record, version: 2 }) },
  { name: 'foreign intent project', file: 'intent', change: record => ({ ...record, projectDir: '/different-project' }) },
  { name: 'foreign intent episode', file: 'intent', change: record => ({ ...record, episode: 2 }) },
  { name: 'changed logical intent digest', file: 'intent', change: record => ({ ...record, digest: 'f'.repeat(64) }) },
  { name: 'changed intent plan facts', file: 'intent', change: record => ({ ...record, planDigest: 'f'.repeat(64) }) },
  { name: 'foreign intent attempt', file: 'intent', change: record => ({ ...record, identity: { ...object(record.identity), attempt: foreign() } }) },
  { name: 'malformed state JSON', file: 'state', change: () => '{"version":' },
  { name: 'unsupported state version', file: 'state', change: record => ({ ...record, version: 2 }) },
  { name: 'foreign state attempt', file: 'state', change: record => ({ ...record, attempt: foreign() }) },
  { name: 'changed state digest', file: 'state', change: record => ({ ...record, digest: 'f'.repeat(64) }) },
  { name: 'malformed receipt JSON', file: 'receipt', change: () => '{"version":' },
  { name: 'unsupported receipt version', file: 'receipt', change: record => ({ ...record, version: 2 }) },
  { name: 'foreign receipt attempt', file: 'receipt', change: record => ({ ...record, identity: { ...object(record.identity), attempt: foreign() } }) },
  { name: 'foreign receipt execution', file: 'receipt', change: record => ({ ...record, execution: foreign() }) },
  { name: 'receipt output escapes the project', file: 'receipt', change: record => ({ ...record, output: { ...object(record.output), path: '../outside.mp4' } }) },
  { name: 'receipt output hash disagrees with state', file: 'receipt', change: record => ({ ...record, output: { ...object(record.output), sha256: 'f'.repeat(64) } }) },
  { name: 'receipt output length disagrees with state', file: 'receipt', change: record => ({ ...record, output: { ...object(record.output), bytes: 1 } }) },
  { name: 'foreign job project', file: 'job', change: record => ({ ...record, projectDir: '/different-project' }) },
  { name: 'foreign job identity', file: 'job', change: record => ({ ...record, identity: { ...object(record.identity), attempt: foreign() } }) },
  { name: 'foreign execution attempt', file: 'execution', change: record => ({ ...record, identity: { ...object(record.identity), attempt: foreign() } }) },
  { name: 'execution PID disagrees with armed job', file: 'execution', outcome: 'unknown', change: record => ({ ...record, guardianPid: process.pid + 1 }) },
  { name: 'drain identity disagrees with running execution', file: 'drain', change: record => ({ ...record, identity: { ...object(record.identity), execution: foreign() } }) },
  { name: 'drain PID disagrees with running execution', file: 'drain', change: record => ({ ...record, guardianPid: process.pid + 1 }) },
]

it.each(faults)('refuses replay for $name while retaining original durable files and output', async ({ file, change, outcome }) => {
  const f = await completed(), name = file === 'drain' ? 'drained-' + f.execution : file
  const path = join(f.root, name + '.json'), original = object(JSON.parse(await readFile(path, 'utf8')))
  const changed = change(original), bytes = typeof changed === 'string' ? changed : JSON.stringify(changed)
  await writeFile(path, bytes)
  if (outcome === 'unknown') {
    expect(await f.service.episodeStatus(f.input)).toMatchObject({ attempt: f.status.attempt, state: 'unknown', canResume: false })
    expect(await f.service.admitEpisode({ ...f.input, resume: true })).toMatchObject({ attempt: f.status.attempt, state: 'unknown', canResume: false })
    expect(f.service.hasActiveWork()).toBe(true)
  } else {
    await expect(f.service.episodeStatus(f.input)).rejects.toThrow()
    await expect(f.service.admitEpisode({ ...f.input, resume: true })).rejects.toThrow()
  }
  expect(await readFile(path, 'utf8')).toBe(bytes)
  if (file !== 'intent') expect(await readFile(join(f.root, 'intent.json'))).toEqual(f.intent)
  await f.preserved()
})

it.each(['intent', 'state', 'receipt'] as const)('rejects a symlinked %s journal without touching its external target', async (name) => {
  const f = await completed(), path = join(f.root, name + '.json'), backup = path + '.retained'
  const bytes = await readFile(path), external = join(f.root, '..', 'external-' + name + '.json')
  await rename(path, backup); await writeFile(external, bytes); await symlink(external, path)
  const retained = (await readdir(f.root)).sort()
  await expect(f.service.episodeStatus(f.input)).rejects.toThrow('bounded regular file')
  await expect(f.service.admitEpisode({ ...f.input, resume: true })).rejects.toThrow('bounded regular file')
  expect(await readFile(external)).toEqual(bytes)
  expect(await readFile(backup)).toEqual(bytes)
  expect((await readdir(f.root)).sort()).toEqual(retained)
  expect(f.renderer.calls).toBe(1); expect(f.renderer.encodes).toBe(1)
  expect((await f.ledger.records()).map(record => record.idempotency_key).sort()).toEqual(f.keys)
  await f.outputUnchanged()
})

it('rejects an aliased attempt directory while preserving the actual original directory', async () => {
  const f = await completed(), backup = f.root + '.retained'
  await rename(f.root, backup); await symlink(backup, f.root, 'dir')
  const retained = (await readdir(backup)).sort()
  await expect(f.service.episodeStatus(f.input)).rejects.toThrow('not canonical')
  await expect(f.service.admitEpisode({ ...f.input, resume: true })).rejects.toThrow('not canonical')
  expect((await readdir(backup)).sort()).toEqual(retained)
  expect(await readFile(join(backup, 'intent.json'))).toEqual(f.intent)
  expect(f.renderer.calls).toBe(1); expect(f.renderer.encodes).toBe(1)
  await f.outputUnchanged()
})

async function undispatchedCancellation() {
  const f = await selected(), plan = object(JSON.parse(await readFile(join(f.project, 'editing', '01-episode-delivery.json'), 'utf8')))
  await writeFile(join(f.project, 'editing', '02-episode-delivery.json'), JSON.stringify({ ...plan, episode: 2 }))
  const ready = await f.service.episodeReadiness({ projectDir: f.project, episode: 2 })
  if (ready.digest === null) throw new Error(ready.issues.join('; '))
  const input = { projectDir: f.project, episode: 2, digest: ready.digest }
  await f.service.admitEpisode(f.input); await f.renderer.armed
  const admitted = await f.service.admitEpisode(input)
  if (admitted.attempt === null) throw new Error('Second episode was not admitted')
  await f.recovery.configure({ enabled: false, projectDir: f.project })
  f.renderer.release()
  await expect.poll(async () => (await f.service.episodeStatus(input)).state).toBe('cancelled')
  const root = join(f.project, '.muse', 'episode-delivery', admitted.attempt), names = await readdir(root)
  const name = names.find(value => value.startsWith('cancel-') && value.endsWith('.json'))
  if (name === undefined) throw new Error('Actual queued cancellation did not persist its journal')
  const path = join(root, name), record = object(JSON.parse(await readFile(path, 'utf8')))
  expect(record.dispatched).toBe(false)
  expect(names).not.toContain('execution.json')
  const intent = await readFile(join(root, 'intent.json'))
  return { ...f, input, root, path, record, intent, attempt: admitted.attempt }
}

it.each(['foreign attempt', 'foreign execution', 'malformed JSON'] as const)('rejects an undispatched cancellation with %s', async (fault) => {
  const f = await undispatchedCancellation(), names = (await readdir(f.root)).sort()
  const changed = fault === 'malformed JSON' ? '{"version":' : JSON.stringify({ ...f.record,
    ...(fault === 'foreign attempt' ? { attempt: foreign() } : { execution: foreign() }) })
  await writeFile(f.path, changed)
  await expect(f.service.episodeStatus(f.input)).rejects.toThrow()
  await expect(f.service.admitEpisode({ ...f.input, resume: true })).rejects.toThrow()
  expect(await readFile(f.path, 'utf8')).toBe(changed)
  expect(await readFile(join(f.root, 'intent.json'))).toEqual(f.intent)
  expect((await readdir(f.root)).sort()).toEqual(names)
  expect(f.renderer.calls).toBe(1); expect(f.renderer.encodes).toBe(1)
  expect((await f.ledger.records()).map(record => record.idempotency_key).sort()).toEqual(f.keys)
  await expect(readdir(join(f.project, 'exports'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('keeps an allegedly dispatched cancellation fenced when no armed execution proof exists', async () => {
  const f = await undispatchedCancellation(), names = (await readdir(f.root)).sort()
  const changed = JSON.stringify({ ...f.record, dispatched: true })
  await writeFile(f.path, changed)
  expect(await f.service.episodeStatus(f.input)).toMatchObject({ attempt: f.attempt, canResume: false })
  expect(await f.service.admitEpisode({ ...f.input, resume: true })).toMatchObject({ attempt: f.attempt, canResume: false })
  expect(await readFile(f.path, 'utf8')).toBe(changed)
  expect(await readFile(join(f.root, 'intent.json'))).toEqual(f.intent)
  expect((await readdir(f.root)).sort()).toEqual(names)
  expect(f.renderer.calls).toBe(1); expect(f.renderer.encodes).toBe(1)
  expect((await f.ledger.records()).map(record => record.idempotency_key).sort()).toEqual(f.keys)
  await expect(readdir(join(f.project, 'exports'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('refuses a directory used as a receipt without replacing or deleting it', async () => {
  const f = await completed(), path = join(f.root, 'receipt.json'), backup = path + '.retained'
  await rename(path, backup); await mkdir(path)
  await expect(f.service.episodeStatus(f.input)).rejects.toThrow('bounded regular file')
  await expect(f.service.admitEpisode({ ...f.input, resume: true })).rejects.toThrow('bounded regular file')
  expect(await readdir(path)).toEqual([])
  expect(await readFile(join(f.root, 'intent.json'))).toEqual(f.intent)
  expect(f.renderer.calls).toBe(1); expect(f.renderer.encodes).toBe(1)
  await f.outputUnchanged()
})

it('rejects a receipt exceeding the configured record budget and retains it unchanged', async () => {
  const f = await completed(), path = join(f.root, 'receipt.json'), bytes = Buffer.alloc(f.episodeOptions.recordBytes + 1, ' ')
  await writeFile(path, bytes)
  await expect(f.service.episodeStatus(f.input)).rejects.toThrow('bounded regular file')
  await expect(f.service.admitEpisode({ ...f.input, resume: true })).rejects.toThrow('bounded regular file')
  expect(await readFile(path)).toEqual(bytes)
  expect(await readFile(join(f.root, 'intent.json'))).toEqual(f.intent)
  await f.preserved()
})

it('rejects metadata removed after canonical file inspection before its bounded read', async () => {
  const f = await selected(), path = join(f.project, 'editing', '01-episode-delivery.json'), actualLstat = files.lstat
  let removed = false
  const spy = vi.spyOn(files, 'lstat').mockImplementation(async (...args) => {
    const result = await actualLstat(...args)
    if (args[0] === path && !removed) { removed = true; await unlink(path) }
    return result
  })
  try {
    await expect(readApprovedEpisodePlan(f.project, 1, f.episodeOptions.metadataMaxBytes, new AbortController().signal))
      .rejects.toThrow('Episode input is missing')
    expect(removed).toBe(true)
    expect(f.renderer.calls).toBe(0); expect(f.renderer.encodes).toBe(0)
    expect((await f.ledger.records()).map(record => record.idempotency_key).sort()).toEqual(f.keys)
    await expect(readdir(join(f.project, '.muse', 'episode-delivery'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { spy.mockRestore() }
})

it('rejects authored bytes changed after parsing and before their full-file hash', async () => {
  const f = await selected(), path = join(f.project, 'editing', 'subtitles.srt'), actualHash = library.hashEpisodeFile
  let changed = false
  const bytes = '1\n00:00:00,000 --> 00:00:01,000\nChanged after parsing\n'
  const spy = vi.spyOn(library, 'hashEpisodeFile').mockImplementation(async (input, signal) => {
    if (input === path && !changed) { changed = true; await writeFile(path, bytes) }
    return actualHash(input, signal)
  })
  try {
    await expect(readApprovedEpisodePlan(f.project, 1, f.episodeOptions.metadataMaxBytes, new AbortController().signal))
      .rejects.toThrow('metadata changed after parsing')
    expect(changed).toBe(true)
    expect(await readFile(path, 'utf8')).toBe(bytes)
    expect(f.renderer.calls).toBe(0); expect(f.renderer.encodes).toBe(0)
    expect((await f.ledger.records()).map(record => record.idempotency_key).sort()).toEqual(f.keys)
    await expect(readdir(join(f.project, '.muse', 'episode-delivery'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { spy.mockRestore() }
})

it.each(['removed', 'foreign identity'] as const)('observes a receipt %s between completed status and resume inspection', async (fault) => {
  const f = await completed(), path = join(f.root, 'receipt.json'), read = library.readEpisodeRecord
  const receipt = object(JSON.parse(await readFile(path, 'utf8')))
  let changed = false
  const bytes = JSON.stringify({ ...receipt, identity: { ...object(receipt.identity), attempt: randomUUID() } })
  const spy = vi.spyOn(library, 'readEpisodeRecord').mockImplementation(async (selected, budget) => {
    const value = await read(selected, budget)
    if (selected === path && !changed) {
      changed = true
      if (fault === 'removed') await unlink(path)
      else await writeFile(path, bytes)
    }
    return value
  })
  try {
    if (fault === 'removed') {
      expect(await f.service.episodeStatus(f.input)).toMatchObject({ attempt: f.status.attempt,
        state: 'completed', canResume: true, output: f.status.output })
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    } else {
      await expect(f.service.episodeStatus(f.input)).rejects.toThrow('receipt identity changed')
      expect(await readFile(path, 'utf8')).toBe(bytes)
    }
    expect(changed).toBe(true)
    expect(await readFile(join(f.root, 'intent.json'))).toEqual(f.intent)
    await f.outputUnchanged()
  } finally { spy.mockRestore() }
})

it('retains the native missing-versus-loop contract for a completed-output directory link', async () => {
  const f = await completed(), exports = join(f.project, 'exports'), retained = exports + '.retained'
  const { lstat: lstatNative } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  let moved = false, linked = false, pending: Promise<void> | undefined
  const cleanup = (): Promise<void> => pending ??= (async () => {
    const errors: unknown[] = []
    try { if (linked) await unlink(exports) } catch (error) { errors.push(error) }
    try { if (moved) await rename(retained, exports) } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, 'Completed-output link cleanup failed')
  })()
  onTestFinished(cleanup)
  let primary: { error: unknown } | undefined
  try {
    await rename(exports, retained); moved = true
    await symlink('exports', exports); linked = true
    const expected = process.platform === 'win32' ? 'ENOENT' : 'ELOOP'
    await expect(lstatNative(f.outputPath)).rejects.toMatchObject({ code: expected })
    if (process.platform === 'win32') {
      expect(await f.service.episodeStatus(f.input)).toMatchObject({ state: 'completed', attempt: f.status.attempt, canResume: true })
    } else await expect(f.service.episodeStatus(f.input)).rejects.toMatchObject({ code: 'ELOOP' })
    expect(await readFile(join(retained, f.outputPath.slice(exports.length + 1)))).toEqual(f.outputBytes)
    expect(f.renderer.calls).toBe(1); expect(f.renderer.encodes).toBe(1)
  } catch (error) { primary = { error }; throw error }
  finally {
    try { await cleanup() } catch (error) {
      if (primary) throw new AggregateError([primary.error, error], 'Completed-output observation and cleanup failed')
      throw error
    }
  }
  await f.preserved()
})

it('propagates an exact completed-output inspection denial and recovers after restoration', async () => {
  const f = await completed(), ledger = await f.ledger.records()
  const denied = Object.assign(new Error('Completed output inspection denied'), { code: 'EACCES' })
  const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  let injected = false
  const spy = vi.spyOn(files, 'lstat').mockImplementation(async (...args) => {
    if (args[0] === f.outputPath && !injected) { injected = true; throw denied }
    return native.lstat(...args)
  })
  onTestFinished(() => { spy.mockRestore() })
  try {
    await expect(f.service.episodeStatus(f.input)).rejects.toBe(denied)
    expect(injected).toBe(true)
  } finally { spy.mockRestore() }
  expect(await f.service.episodeStatus(f.input)).toMatchObject({ state: 'completed', attempt: f.status.attempt, canResume: false })
  expect(await f.ledger.records()).toEqual(ledger)
  expect(await readFile(join(f.root, 'intent.json'))).toEqual(f.intent)
  await f.preserved()
})

it('propagates an injected completed-output IO failure on every platform', async () => {
  const f = await completed(), lstat = files.lstat
  const failure = Object.assign(new Error('Output inspection failed'), { code: 'EIO' })
  const spy = vi.spyOn(files, 'lstat').mockImplementation(async (...args) => {
    if (args[0] === f.outputPath) throw failure
    return lstat(...args)
  })
  try {
    await expect(f.service.episodeStatus(f.input)).rejects.toBe(failure)
    expect(f.renderer.calls).toBe(1); expect(f.renderer.encodes).toBe(1)
  } finally { spy.mockRestore() }
  await f.preserved()
})

async function repairable() {
  const f = await completed(), receiptPath = join(f.root, 'receipt.json')
  const publicationPath = join(f.root, 'publication-' + f.execution + '.json')
  const receiptBytes = await readFile(receiptPath), publicationBytes = await readFile(publicationPath)
  await unlink(receiptPath)
  const resume = async () => {
    expect((await f.service.episodeStatus(f.input)).canResume).toBe(true)
    expect(await f.service.admitEpisode({ ...f.input, resume: true })).toMatchObject({ attempt: f.status.attempt, state: 'queued' })
  }
  const failed = async (problem: string) => {
    await expect.poll(async () => (await f.service.episodeStatus(f.input)).problem).toContain(problem)
    expect(await f.service.episodeStatus(f.input)).toMatchObject({ attempt: f.status.attempt, state: 'unknown' })
    expect(await readFile(join(f.root, 'intent.json'))).toEqual(f.intent)
    expect(f.renderer.calls).toBe(1); expect(f.renderer.encodes).toBe(1)
    expect((await f.ledger.records()).map(record => record.idempotency_key).sort()).toEqual(f.keys)
  }
  return { ...f, receiptPath, publicationPath, receiptBytes, publicationBytes, resume, failed }
}

it.each(['missing original source', 'changed editing inputs'] as const)('refuses original resume with %s after publication metadata is lost', async (fault) => {
  const f = await repairable()
  await unlink(f.publicationPath)
  if (fault === 'missing original source') {
    const name = (await readdir(f.directory)).find(value => value.startsWith('original-') && value.endsWith('.mp4'))
    if (name === undefined) throw new Error('Actual approved source is absent before the negative control')
    await unlink(join(f.directory, name))
  } else await writeFile(join(f.project, 'editing', 'subtitles.srt'), '1\n00:00:00,000 --> 00:00:01,000\nNew authored line\n')
  await f.resume(); await f.failed('Original episode inputs or renderer facts no longer match')
  await expect(readFile(f.receiptPath)).rejects.toMatchObject({ code: 'ENOENT' })
  await f.outputUnchanged()
})

const recoveryFacts: { name: string; change: (record: Record<string, unknown>) => object }[] = [
  { name: 'foreign attempt', change: record => ({ ...record, identity: { ...object(record.identity), attempt: randomUUID() } }) },
  { name: 'foreign execution', change: record => ({ ...record, execution: randomUUID() }) },
  { name: 'foreign output path', change: record => ({ ...record, output: { ...object(record.output), path: '../other.mp4' } }) },
  { name: 'foreign output hash', change: record => ({ ...record, output: { ...object(record.output), sha256: 'e'.repeat(64) } }) },
  { name: 'foreign output length', change: record => ({ ...record, output: { ...object(record.output), bytes: 1 } }) },
]
it.each(recoveryFacts)('refuses prepared repair metadata with $name before any execution', async ({ change }) => {
  const f = await repairable(), changed = JSON.stringify(change(object(JSON.parse(f.publicationBytes.toString('utf8')))))
  await writeFile(f.publicationPath, changed)
  await f.resume(); await f.failed('Prepared episode publication does not match its drain proof')
  expect(await readFile(f.publicationPath, 'utf8')).toBe(changed)
  await expect(readFile(f.receiptPath)).rejects.toMatchObject({ code: 'ENOENT' })
  await f.outputUnchanged()
})

it.each(['regular file', 'symlink'] as const)('refuses offline repair into an exports %s without touching the retained output', async (kind) => {
  const f = await repairable(), exports = join(f.project, 'exports'), retained = exports + '.retained'
  await rename(exports, retained)
  if (kind === 'regular file') await writeFile(exports, 'occupied directory path')
  else await symlink(retained, exports, 'dir')
  try {
    await f.resume(); await f.failed('destination directory is not canonical')
    expect(await readFile(join(retained, f.outputPath.slice(exports.length + 1)))).toEqual(f.outputBytes)
    await expect(readFile(f.receiptPath)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await unlink(exports); await rename(retained, exports) }
  await f.outputUnchanged()
})

it('propagates a non-absent directory inspection failure during offline repair', async () => {
  const f = await repairable(), actual = files.lstat, exports = join(f.project, 'exports')
  const spy = vi.spyOn(files, 'lstat').mockImplementation(async (...args) => {
    if (args[0] === exports) throw Object.assign(new Error('Owned exports inspection failure'), { code: 'EACCES' })
    return actual(...args)
  })
  try {
    await f.resume(); await f.failed('Owned exports inspection failure')
    await f.outputUnchanged()
    await expect(readFile(f.receiptPath)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { spy.mockRestore() }
})

it('refuses a non-regular published target during repair without deleting either retained file', async () => {
  const f = await repairable(), retained = f.outputPath + '.retained'
  await rename(f.outputPath, retained); await mkdir(f.outputPath)
  try {
    await f.resume(); await f.failed('Episode input must be a regular file')
    expect(await readFile(retained)).toEqual(f.outputBytes)
    expect(await readdir(f.outputPath)).toEqual([])
  } finally { await rm(f.outputPath, { recursive: true }); await rename(retained, f.outputPath) }
  await f.outputUnchanged()
})

it('refuses different bytes at the published output during repair and preserves the occupied inode', async () => {
  const f = await repairable(), bytes = Buffer.alloc(f.outputBytes.length, 'x')
  await writeFile(f.outputPath, bytes)
  await f.resume(); await f.failed('Episode destination is occupied by different bytes')
  expect(await readFile(f.outputPath)).toEqual(bytes)
  expect((await stat(f.outputPath)).ino).toBe(f.outputInode)
  await expect(readFile(f.receiptPath)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['matching', 'different'] as const)('retains a concurrent %s receipt arriving after output measurement', async (kind) => {
  const f = await repairable(), actual = library.hashEpisodeFile
  const record = object(JSON.parse(f.receiptBytes.toString('utf8')))
  const bytes = kind === 'matching' ? f.receiptBytes : Buffer.from(JSON.stringify({ ...record, width: 720 }))
  let published = false
  const spy = vi.spyOn(library, 'hashEpisodeFile').mockImplementation(async (path, signal) => {
    const value = await actual(path, signal)
    if (path === f.outputPath && !published) { published = true; await writeFile(f.receiptPath, bytes, { flag: 'wx' }) }
    return value
  })
  try {
    await f.resume()
    if (kind === 'matching') {
      await expect.poll(async () => (await f.service.episodeStatus(f.input)).state).toBe('completed')
      expect((await f.service.episodeStatus(f.input)).attempt).toBe(f.status.attempt)
    } else await f.failed('Episode receipt changed before repair')
    expect(published).toBe(true)
    expect(await readFile(f.receiptPath)).toEqual(bytes)
    await f.outputUnchanged()
  } finally { spy.mockRestore() }
})

it.each(['missing publication metadata', 'missing exports directory'] as const)('reconciles the original completed execution after %s without encoding again', async (fault) => {
  const f = await repairable(), exports = join(f.project, 'exports'), retained = exports + '.retained'
  if (fault === 'missing publication metadata') await unlink(f.publicationPath)
  else await rename(exports, retained)
  await f.resume()
  await expect.poll(async () => (await f.service.episodeStatus(f.input)).state).toBe('completed')
  expect(await f.service.episodeStatus(f.input)).toMatchObject({ attempt: f.status.attempt, execution: f.execution })
  expect(f.renderer.calls).toBe(2); expect(f.renderer.encodes).toBe(1)
  expect(await readFile(f.outputPath)).toEqual(f.outputBytes)
  expect((await stat(f.outputPath)).ino).toBe(f.outputInode)
  expect(await readFile(join(f.root, 'intent.json'))).toEqual(f.intent)
  expect((await f.ledger.records()).map(record => record.idempotency_key).sort()).toEqual(f.keys)
  if (fault === 'missing exports directory') expect(await readFile(join(retained, f.outputPath.slice(exports.length + 1)))).toEqual(f.outputBytes)
})
