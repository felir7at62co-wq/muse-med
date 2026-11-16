/** Original intent discovery is bounded metadata IO and never resumes or validates media. */
import { randomUUID } from 'node:crypto'
import type { Dir } from 'node:fs'
import { mkdir, readFile, readdir, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import * as files from 'node:fs/promises'
import { basename, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { PeerId } from '@deepseek-ai/dsh-typert-protocol'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import { expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { JubianEpisodeDelivery, resolveEpisodeDelivery } from '../src/episode-delivery-service.ts'
import { JubianVideoRecovery } from '../src/video-recovery-service.ts'
import * as library from '../src/episode-delivery.ts'
import { createEpisodeDeliveryFixture } from './fixtures/episode-delivery.ts'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))

async function completed() {
  const f = await createEpisodeDeliveryFixture(), ready = await f.service.episodeReadiness(f.planInput)
  if (ready.digest === null) throw new Error(ready.issues.join('; '))
  const target = { ...f.planInput, digest: ready.digest }, initial = await f.service.admitEpisode(target)
  f.renderer.release()
  await expect.poll(async () => (await f.service.episodeStatus(target)).state).toBe('completed')
  const status = await f.service.episodeStatus(target)
  if (status.attempt === null || status.execution === undefined || status.output === undefined) throw new Error('Expected actual completed admission')
  expect(status.attempt).toBe(initial.attempt)
  const historyRoot = join(f.project, '.muse', 'episode-delivery'), attemptRoot = join(historyRoot, status.attempt)
  return { ...f, target, status, output: status.output, historyRoot, attemptRoot }
}

async function withLimits(f: Awaited<ReturnType<typeof createEpisodeDeliveryFixture>>, options: Partial<typeof f.episodeOptions>) {
  const scope = f.ctx.isolate('jubianEpisodeDelivery')
  await scope.plugin(JubianEpisodeDelivery, { ...f.episodeOptions, ...options }).await()
  return scope.jubianEpisodeDelivery
}

const object = (value: unknown): Record<string, unknown> => z.record(z.string(), z.unknown()).parse(value)

it('returns an empty history without creating a private directory or observing active work', async () => {
  const f = await createEpisodeDeliveryFixture(), before = (await readdir(f.project)).sort()
  expect(await f.service.episodeHistory(f.planInput)).toEqual({ ...f.planInput,
    entries: [], truncated: false, unreadableRecords: 0, scannedEntries: 0 })
  expect((await readdir(f.project)).sort()).toEqual(before)
  expect(f.service.hasActiveWork()).toBe(false)
  expect(f.renderer.captures).toBe(0); expect(f.renderer.calls).toBe(0)
})

it('discovers a strict original intent without status, media hashes, renderer capture, network or write IO', async () => {
  const f = await completed(), calls = f.renderer.calls, captures = f.renderer.captures
  const originalLedger = await f.ledger.records(), before = await readFile(join(f.attemptRoot, 'intent.json'))
  const media = vi.spyOn(library, 'hashEpisodeFile').mockRejectedValue(new Error('History must not hash media'))
  const status = vi.spyOn(f.service, 'episodeStatus').mockRejectedValue(new Error('History must not query current status'))
  const capture = vi.spyOn(f.provider, 'capture').mockRejectedValue(new Error('History must not capture a renderer'))
  const write = vi.spyOn(files, 'writeFile').mockRejectedValue(new Error('History must not write files'))
  try {
    expect(await f.service.episodeHistory(f.planInput)).toEqual({ ...f.planInput,
      entries: [{ attempt: f.status.attempt, digest: f.target.digest, recordedState: 'completed' }],
      truncated: false, unreadableRecords: 0, scannedEntries: 1 })
    expect(f.service.hasActiveWork()).toBe(false)
    expect(f.renderer.calls).toBe(calls); expect(f.renderer.captures).toBe(captures)
    expect(await f.ledger.records()).toEqual(originalLedger)
    expect(await readFile(join(f.attemptRoot, 'intent.json'))).toEqual(before)
    expect(f.fetch).not.toHaveBeenCalled()
  } finally { media.mockRestore(); status.mockRestore(); capture.mockRestore(); write.mockRestore() }
})

it('does not turn historical running or unknown labels into process-local active fences', async () => {
  const f = await completed(), path = join(f.attemptRoot, 'state.json'), source = object(JSON.parse(await readFile(path, 'utf8')))
  for (const state of ['running', 'unknown']) {
    await writeFile(path, JSON.stringify({ ...source, state }))
    const history = await f.service.episodeHistory(f.planInput)
    expect(history.entries[0]?.recordedState).toBe(state)
    expect(f.service.hasActiveWork()).toBe(false)
  }
})

it('finds an original after full Context restart and repairs its missing receipt offline with the source gone', async () => {
  const f = await completed(), output = join(f.project, f.output.path), before = await stat(output)
  await unlink(join(f.attemptRoot, 'receipt.json'))
  for (const name of await readdir(f.directory)) if (name.startsWith('original-')) await unlink(join(f.directory, name))
  await f.ctx.fiber.dispose()
  const cold = new Context(); onTestFinished(() => cold.fiber.dispose())
  await cold.plugin(SubprocessLocal).await()
  await cold.plugin(JubianVideoRecovery, f.options).await()
  await cold.plugin(JubianEpisodeDelivery, f.episodeOptions).await()
  const service = cold.jubianEpisodeDelivery
  const history = await service.episodeHistory(f.planInput)
  expect(history.entries).toEqual([{ attempt: f.status.attempt, digest: f.target.digest, recordedState: 'completed' }])
  expect(service.hasActiveWork()).toBe(false)
  const selected = history.entries[0]
  if (selected === undefined) throw new Error('Expected original selectable identity')
  const target = { ...f.planInput, digest: selected.digest }
  expect((await service.episodeStatus(target)).canResume).toBe(true)
  expect((await service.admitEpisode({ ...target, resume: true })).attempt).toBe(selected.attempt)
  await expect.poll(async () => (await service.episodeStatus(target)).state).toBe('completed')
  expect((await stat(output)).ino).toBe(before.ino)
  expect(await readFile(output, 'utf8')).toBe('full episode fixture bytes')
  expect(f.renderer.calls).toBe(1); expect(f.renderer.encodes).toBe(1)
  expect(service.hasActiveWork()).toBe(false); expect(f.fetch).not.toHaveBeenCalled()
})

it.each(['missing', 'malformed', 'foreign'] as const)('keeps the original selectable when its recorded state is %s', async (fault) => {
  const f = await completed(), path = join(f.attemptRoot, 'state.json')
  if (fault === 'missing') await unlink(path)
  else if (fault === 'malformed') await writeFile(path, '{bad')
  else {
    const source = object(JSON.parse(await readFile(path, 'utf8')))
    await writeFile(path, JSON.stringify({ ...source, attempt: randomUUID() }))
  }
  const history = await f.service.episodeHistory(f.planInput)
  expect(history.entries).toEqual([{ attempt: f.status.attempt, digest: f.target.digest, recordedState: null }])
  expect(history.unreadableRecords).toBe(fault === 'missing' ? 0 : 1)
  expect(f.service.hasActiveWork()).toBe(false)
})

it.each(['malformed', 'future-version', 'foreign-project', 'foreign-attempt', 'changed-plan-digest', 'renamed-directory'] as const)(
  'counts an invalid original %s without reconstructing its identity from output names', async (fault) => {
    const f = await completed(), path = join(f.attemptRoot, 'intent.json'), source = object(JSON.parse(await readFile(path, 'utf8')))
    if (fault === 'malformed') await writeFile(path, '{bad')
    else if (fault === 'future-version') await writeFile(path, JSON.stringify({ ...source, version: 2 }))
    else if (fault === 'foreign-project') await writeFile(path, JSON.stringify({ ...source, projectDir: '/unrelated' }))
    else if (fault === 'foreign-attempt') await writeFile(path, JSON.stringify({ ...source, identity: { ...object(source.identity), attempt: randomUUID() } }))
    else if (fault === 'changed-plan-digest') await writeFile(path, JSON.stringify({ ...source, planDigest: 'f'.repeat(64) }))
    else await rename(f.attemptRoot, join(f.historyRoot, randomUUID()))
    const history = await f.service.episodeHistory(f.planInput)
    expect(history.entries).toEqual([]); expect(history.unreadableRecords).toBe(1)
    expect(f.service.hasActiveWork()).toBe(false)
  },
)

it('omits other episodes and counts missing intent records within its bounded subset', async () => {
  const f = await completed()
  expect((await f.service.episodeHistory({ ...f.planInput, episode: 2 })).entries).toEqual([])
  expect((await f.service.episodeHistory({ ...f.planInput, episode: 2 })).unreadableRecords).toBe(0)
  await unlink(join(f.attemptRoot, 'intent.json'))
  const history = await f.service.episodeHistory(f.planInput)
  expect(history.entries).toEqual([]); expect(history.unreadableRecords).toBe(1)
})

it.each(['attempt-link', 'attempt-file', 'intent-link', 'intent-oversize', 'intent-directory'] as const)(
  'does not follow or accept an unsafe %s', async (fault) => {
    const f = await completed(), path = join(f.attemptRoot, 'intent.json')
    if (fault === 'attempt-link') {
      const external = join(f.root, 'retained-attempt')
      await rename(f.attemptRoot, external); await symlink(external, f.attemptRoot, 'dir')
    } else if (fault === 'attempt-file') {
      await rename(f.attemptRoot, join(f.root, 'retained-attempt')); await writeFile(f.attemptRoot, 'occupied')
    } else if (fault === 'intent-link') {
      const original = path + '.retained'; await rename(path, original); await symlink(original, path)
    } else if (fault === 'intent-oversize') await writeFile(path, 'x'.repeat(f.episodeOptions.recordBytes + 1))
    else { await unlink(path); await mkdir(path) }
    const history = await f.service.episodeHistory(f.planInput)
    expect(history.entries).toEqual([]); expect(history.unreadableRecords).toBe(1)
  },
)

it('refuses an aliased history root rather than traversing another directory', async () => {
  const f = await completed(), external = join(f.root, 'external-history')
  await rename(f.historyRoot, external); await symlink(external, f.historyRoot, 'dir')
  await expect(f.service.episodeHistory(f.planInput)).rejects.toThrow('canonical')
})

it('bounds visited names even when they are unrelated or not directories', async () => {
  const f = await createEpisodeDeliveryFixture(), root = join(f.project, '.muse', 'episode-delivery')
  await mkdir(root, { recursive: true })
  for (const name of ['unrelated', 'another', 'last']) await writeFile(join(root, name), 'unrelated')
  const service = await withLimits(f, { historyScanLimit: 2 })
  expect(await service.episodeHistory(f.planInput)).toEqual({ ...f.planInput, entries: [], truncated: true,
    unreadableRecords: 0, scannedEntries: 2 })
  const exact = await withLimits(f, { historyScanLimit: 3 })
  expect((await exact.episodeHistory(f.planInput)).truncated).toBe(false)
})

it('stops before reading further original records once its result cap is reached', async () => {
  const f = await completed()
  // A second valid original belongs to a changed plan while retaining its original approval.
  await writeFile(join(f.project, 'editing', 'subtitles.srt'), '1\n00:00:00,000 --> 00:00:01,000\nSecond plan\n')
  const ready = await f.service.episodeReadiness(f.planInput)
  if (ready.digest === null) throw new Error('Expected second readiness')
  await f.service.admitEpisode({ ...f.planInput, digest: ready.digest })
  const service = await withLimits(f, { historyResultLimit: 1 })
  const history = await service.episodeHistory(f.planInput)
  expect(history.entries).toHaveLength(1); expect(history.truncated).toBe(true)
  expect(history.scannedEntries).toBe(1)
})

it('bounds aggregate bytes independently of the per-record limit and reports exact exhaustion', async () => {
  const f = await completed(), intent = await readFile(join(f.attemptRoot, 'intent.json')), state = await readFile(join(f.attemptRoot, 'state.json'))
  for (const historyMetadataMaxBytes of [1, intent.length - 1, intent.length + state.length - 1]) {
    const limited = await withLimits(f, { historyMetadataMaxBytes })
    const result = await limited.episodeHistory(f.planInput)
    expect(result.entries).toEqual([]); expect(result.truncated).toBe(true); expect(result.unreadableRecords).toBe(0)
  }
  const exact = await withLimits(f, { historyMetadataMaxBytes: intent.length + state.length })
  expect((await exact.episodeHistory(f.planInput)).entries).toHaveLength(1)
  expect((await exact.episodeHistory(f.planInput)).truncated).toBe(false)
})

it('keeps one failed unstable read inside the aggregate byte reservation', async () => {
  const f = await completed(), path = join(f.attemptRoot, 'intent.json'), lstat = files.lstat
  const other = join(f.historyRoot, randomUUID()); await mkdir(other)
  const spy = vi.spyOn(files, 'lstat').mockImplementation(async (...args) => {
    if (args[0] === path) throw Object.assign(new Error('Intent inspection denied'), { code: 'EACCES' })
    return lstat(...args)
  })
  try {
    const result = await f.service.episodeHistory(f.planInput)
    expect(result.unreadableRecords).toBe(2); expect(result.truncated).toBe(false)
  } finally { spy.mockRestore() }
})

it('resolves history limits explicitly and refuses invalid deployments before mounting', () => {
  expect(resolveEpisodeDelivery({})).toMatchObject({ historyScanLimit: 1000, historyResultLimit: 50, historyMetadataMaxBytes: 4194304 })
  expect(resolveEpisodeDelivery({ episodeDeliveryHistoryScanLimit: 3, episodeDeliveryHistoryResultLimit: 2,
    episodeDeliveryHistoryMetadataMaxBytes: 1 })).toMatchObject({ historyScanLimit: 3, historyResultLimit: 2, historyMetadataMaxBytes: 1 })
  for (const field of ['episodeDeliveryHistoryScanLimit', 'episodeDeliveryHistoryResultLimit', 'episodeDeliveryHistoryMetadataMaxBytes']) {
    for (const value of [0, 1.5, Number.NaN, 67108865]) expect(() => resolveEpisodeDelivery({ [field]: value })).toThrow('bounded')
  }
})


it.each(['link', 'directory', 'read-denied', 'oversized'] as const)('retains original selection when saved state is %s', async (fault) => {
  const f = await completed(), path = join(f.attemptRoot, 'state.json'), lstat = files.lstat
  let restore = (): void => {}
  if (fault === 'link') { await rename(path, path + '.retained'); await symlink(path + '.retained', path) }
  else if (fault === 'directory') { await unlink(path); await mkdir(path) }
  else if (fault === 'oversized') await writeFile(path, 'x'.repeat(f.episodeOptions.recordBytes + 1))
  else {
    const spy = vi.spyOn(files, 'lstat').mockImplementation(async (...args) => {
      if (args[0] === path) throw Object.assign(new Error('Saved state read denied'), { code: 'EACCES' })
      return lstat(...args)
    })
    restore = () => { spy.mockRestore() }
  }
  try {
    const result = await f.service.episodeHistory(f.planInput)
    expect(result.entries).toEqual([{ attempt: f.status.attempt, digest: f.target.digest, recordedState: null }])
    expect(result.unreadableRecords).toBe(1)
  } finally { restore() }
})

it('closes its directory and refuses completion when its caller retires during metadata IO', async () => {
  const f = await completed(), read = library.readEpisodeBytes, open = files.opendir
  const release = Promise.withResolvers<undefined>(), controller = new AbortController()
  let entered = false
  let observedDirectory: Dir | undefined
  const directory = vi.spyOn(files, 'opendir').mockImplementation(async (...args) => {
    const handle = await open(...args)
    observedDirectory = handle
    return handle
  })
  const metadata = vi.spyOn(library, 'readEpisodeBytes').mockImplementation(async (...args) => {
    if (basename(args[0]) === 'intent.json') { entered = true; await release.promise }
    return read(...args)
  })
  const scoped = f.ctx.extend({ invocation: {
    request: { namespace: 'jubianEpisodeDelivery', method: 'episodeHistory', args: { input: f.planInput } },
    service: 'jubianEpisodeDelivery', signal: controller.signal,
    peer: { id: brandString<PeerId>('history-observer'), ctx: f.ctx, dispose: async () => {} }, async *uplink() {},
  } }).jubianEpisodeDelivery
  const operation = scoped.episodeHistory(f.planInput), rejected = expect(operation).rejects.toThrow('History observer retired')
  try {
    await vi.waitFor(() => { expect(entered).toBe(true) }, { timeout: 5000 })
    expect(f.service.hasActiveWork()).toBe(false)
    controller.abort(new Error('History observer retired')); release.resolve(undefined); await rejected
    if (observedDirectory === undefined) throw new Error('History did not open its actual directory')
    await expect(observedDirectory.read()).rejects.toMatchObject({ code: 'ERR_DIR_CLOSED' })
  } finally {
    controller.abort(); release.resolve(undefined); await Promise.allSettled([operation, rejected])
    metadata.mockRestore(); directory.mockRestore()
  }
})

it('joins metadata reads during parent disposal and never starts work from historical labels', async () => {
  const f = await completed(), read = library.readEpisodeBytes
  let entered = false
  const release = Promise.withResolvers<undefined>()
  const spy = vi.spyOn(library, 'readEpisodeBytes').mockImplementation(async (...args) => {
    if (basename(args[0]) === 'intent.json') { entered = true; await release.promise }
    return read(...args)
  })
  const operation = f.service.episodeHistory(f.planInput), rejected = expect(operation).rejects.toThrow('provider disposed')
  let disposed = false
  try {
    await vi.waitFor(() => { expect(entered).toBe(true) }, { timeout: 5000 })
    const disposal = f.ctx.fiber.dispose().then(() => { disposed = true })
    expect(disposed).toBe(false); release.resolve(undefined)
    await Promise.all([rejected, disposal])
    expect(disposed).toBe(true); expect(f.renderer.encodes).toBe(1)
  } finally { release.resolve(undefined); await Promise.allSettled([operation, rejected]); spy.mockRestore() }
})

it('limits aggregate bytes after an unstable record read instead of silently continuing to scan', async () => {
  const f = await completed(), path = join(f.attemptRoot, 'intent.json')
  const other = join(f.historyRoot, randomUUID()); await mkdir(other)
  await writeFile(join(other, 'intent.json'), await readFile(path))
  const service = await withLimits(f, { historyMetadataMaxBytes: f.episodeOptions.recordBytes })
  const spy = vi.spyOn(library, 'readEpisodeBytes').mockRejectedValue(new Error('Stable metadata version could not be confirmed'))
  try {
    const history = await service.episodeHistory(f.planInput)
    expect(history.entries).toEqual([]); expect(history.truncated).toBe(true)
    expect(history.unreadableRecords).toBe(1); expect(spy).toHaveBeenCalledOnce()
  } finally { spy.mockRestore() }
})


it('counts a missing intent when it disappears after the budget inspection', async () => {
  const f = await completed(), path = join(f.attemptRoot, 'intent.json'), lstat = files.lstat
  let reads = 0
  const spy = vi.spyOn(files, 'lstat').mockImplementation(async (...args) => {
    if (args[0] === path && ++reads === 2) await unlink(path)
    return lstat(...args)
  })
  try {
    const result = await f.service.episodeHistory(f.planInput)
    expect(result.entries).toEqual([]); expect(result.unreadableRecords).toBe(1)
  } finally { spy.mockRestore() }
})

it('ignores an attempt directory removed after its name was read', async () => {
  const f = await completed(), lstat = files.lstat
  const spy = vi.spyOn(files, 'lstat').mockImplementation(async (...args) => {
    if (args[0] === f.attemptRoot) await rename(f.attemptRoot, join(f.root, 'retired-attempt'))
    return lstat(...args)
  })
  try {
    const result = await f.service.episodeHistory(f.planInput)
    expect(result).toEqual({ ...f.planInput, entries: [], unreadableRecords: 0, scannedEntries: 1, truncated: false })
  } finally { spy.mockRestore() }
})
