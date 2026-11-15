/** Publication IO failures retain the original attempt, occupied files and measured candidate. */
import { readFile, readdir, rename, stat, utimes, writeFile } from 'node:fs/promises'
import * as files from 'node:fs/promises'
import { basename, join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import * as library from '../src/episode-delivery.ts'
import { createEpisodeDeliveryFixture } from './fixtures/episode-delivery.ts'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
vi.mock('../src/episode-delivery.ts', async original => ({ ...await original<typeof import('../src/episode-delivery.ts')>() }))
afterEach(() => { vi.restoreAllMocks() })

const object = (value: unknown): Record<string, unknown> => z.record(z.string(), z.unknown()).parse(value)
const ioError = (code: string) => Object.assign(new Error('Owned publication fixture: ' + code), { code })

async function running() {
  const f = await createEpisodeDeliveryFixture(), ready = await f.service.episodeReadiness(f.planInput)
  if (!ready.ready || ready.digest === null) throw new Error(ready.issues.join('; '))
  const input = { ...f.planInput, digest: ready.digest }, admitted = await f.service.admitEpisode(input)
  if (admitted.attempt === null) throw new Error('Actual admission omitted its original attempt')
  await f.renderer.entered
  const root = join(f.project, '.muse', 'episode-delivery', admitted.attempt)
  const output = join(f.project, 'exports', `Muse-episode-01-${input.digest}.mp4`)
  const keys = (await f.ledger.records()).map(record => record.idempotency_key).sort()
  onTestFinished(async () => {
    expect(f.fetch).not.toHaveBeenCalled()
    expect(f.renderer.encodes).toBe(1)
    expect((await f.ledger.records()).map(record => record.idempotency_key).sort()).toEqual(keys)
  })
  const finish = async (state: 'completed' | 'unknown') => {
    f.renderer.release()
    await expect.poll(async () => (await f.service.episodeStatus(input)).state).toBe(state)
    expect((await f.service.episodeStatus(input)).attempt).toBe(admitted.attempt)
    const execution = z.object({ identity: z.object({ execution: z.uuid() }) })
      .parse(JSON.parse(await readFile(join(root, 'execution.json'), 'utf8'))).identity.execution
    expect(await readFile(join(root, execution, 'stage', 'candidate.mp4'), 'utf8')).toBe('full episode fixture bytes')
  }
  const noOutput = async () => { expect(await readdir(join(f.project, 'exports'))).toEqual([]) }
  return { ...f, input, root, output, finish, noOutput }
}

it('retains a drained candidate when exclusive staging fails with a non-occupied IO error', async () => {
  const f = await running(), copy = files.copyFile
  vi.spyOn(files, 'copyFile').mockImplementation(async (source, target, flags) => {
    if (basename(String(target)).startsWith('publish-')) throw ioError('EACCES')
    return copy(source, target, flags)
  })
  await f.finish('unknown'); await f.noOutput()
  expect((await f.service.episodeStatus(f.input)).problem).toContain('EACCES')
  expect((await readdir(f.root)).some(name => name.startsWith('drained-'))).toBe(true)
})

it('refuses bytes changed during staging and preserves the changed prepared file', async () => {
  const f = await running(), copy = files.copyFile
  let prepared = ''
  vi.spyOn(files, 'copyFile').mockImplementation(async (source, target, flags) => {
    await copy(source, target, flags)
    if (basename(String(target)).startsWith('publish-')) { prepared = String(target); await writeFile(target, 'changed staged bytes') }
  })
  await f.finish('unknown'); await f.noOutput()
  expect((await f.service.episodeStatus(f.input)).problem).toContain('Prepared episode publication changed')
  expect(await readFile(prepared, 'utf8')).toBe('changed staged bytes')
})

it('accepts an occupied prepared file only after measuring the exact matching bytes', async () => {
  const f = await running(), copy = files.copyFile
  let prepared = '', originalInode = 0
  vi.spyOn(files, 'copyFile').mockImplementation(async (source, target, flags) => {
    await copy(source, target, flags)
    if (basename(String(target)).startsWith('publish-')) {
      prepared = String(target); originalInode = (await stat(target)).ino; throw ioError('EEXIST')
    }
  })
  await f.finish('completed')
  expect(await readFile(f.output, 'utf8')).toBe('full episode fixture bytes')
  expect((await stat(prepared)).ino).toBe(originalInode)
  expect((await stat(f.output)).ino).toBe(originalInode)
})

it('propagates an unreadable export inspection rather than treating it as an absent destination', async () => {
  const f = await running(), hash = library.hashEpisodeFile
  vi.spyOn(library, 'hashEpisodeFile').mockImplementation(async (path, signal) => {
    if (path === f.output) throw ioError('EACCES')
    return hash(path, signal)
  })
  await f.finish('unknown'); await f.noOutput()
  expect((await f.service.episodeStatus(f.input)).problem).toContain('EACCES')
})

it.each(['metadata', 'receipt'] as const)('preserves a conflicting pre-existing %s record before output publication', async (kind) => {
  const f = await running(), hash = library.hashEpisodeFile
  let occupied = '', bytes = ''
  vi.spyOn(library, 'hashEpisodeFile').mockImplementation(async (path, signal) => {
    const version = await hash(path, signal)
    if (basename(path).startsWith('publish-')) {
      const execution = basename(path).slice('publish-'.length, -'.mp4'.length)
      const intent = object(JSON.parse(await readFile(join(f.root, 'intent.json'), 'utf8')))
      const receipt = { version: 1, kind: 'approved-episode-delivery', identity: intent.identity, execution,
        output: { path: 'exports/' + basename(f.output), sha256: version.sha256, bytes: version.bytes },
        width: 720, height: 1280, durationUs: 1000000, video: true, audio: true }
      occupied = join(f.root, kind === 'receipt' ? 'receipt.json' : `publication-${execution}.json`)
      bytes = JSON.stringify(receipt); await writeFile(occupied, bytes, { flag: 'wx' })
    }
    return version
  })
  await f.finish('unknown'); await f.noOutput()
  expect(await readFile(occupied, 'utf8')).toBe(bytes)
  expect((await f.service.episodeStatus(f.input)).problem).toContain(kind === 'receipt' ? 'receipt conflicts' : 'metadata conflicts')
})

it.each(['matching', 'different', 'io-after-link'] as const)('handles a receipt publication race with %s durable evidence', async (kind) => {
  const f = await running(), link = files.link
  let occupiedBytes: Buffer | undefined, occupiedInode: number | undefined
  vi.spyOn(files, 'link').mockImplementation(async (source, target) => {
    if (String(target) !== join(f.root, 'receipt.json')) return link(source, target)
    if (kind === 'different') {
      const receipt = object(JSON.parse(await readFile(source, 'utf8')))
      await writeFile(target, JSON.stringify({ ...receipt, width: 720 }), { flag: 'wx' })
    } else await link(source, target)
    occupiedBytes = await readFile(target); occupiedInode = (await stat(target)).ino
    throw ioError(kind === 'io-after-link' ? 'EIO' : 'EEXIST')
  })
  await f.finish(kind === 'matching' ? 'completed' : 'unknown')
  expect(await readFile(join(f.root, 'receipt.json'))).toEqual(occupiedBytes)
  expect((await stat(join(f.root, 'receipt.json'))).ino).toBe(occupiedInode)
  expect(await readFile(f.output, 'utf8')).toBe('full episode fixture bytes')
  if (kind !== 'matching') expect((await f.service.episodeStatus(f.input)).problem).toContain(kind === 'io-after-link' ? 'EIO' : 'EEXIST')
})

it('preserves a destination occupied after inspection and before the exclusive publication link', async () => {
  const f = await running(), link = files.link
  vi.spyOn(files, 'link').mockImplementation(async (source, target) => {
    if (String(target) === f.output) await writeFile(target, 'another publisher owns this path', { flag: 'wx' })
    return link(source, target)
  })
  await f.finish('unknown')
  expect(await readFile(f.output, 'utf8')).toBe('another publisher owns this path')
  await expect(readFile(join(f.root, 'receipt.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['mtime', 'replacement'] as const)('refuses a %s change after the output link without removing either file', async (kind) => {
  const f = await running(), link = files.link
  let retained = ''
  vi.spyOn(files, 'link').mockImplementation(async (source, target) => {
    await link(source, target)
    if (String(target) !== f.output) return
    if (kind === 'mtime') {
      const info = await stat(target)
      await utimes(target, info.atime, new Date(info.mtimeMs + 2000))
    } else {
      retained = f.output + '.retained'; await rename(target, retained)
      await writeFile(target, 'replacement owner bytes', { flag: 'wx' })
    }
  })
  await f.finish('unknown')
  expect((await f.service.episodeStatus(f.input)).problem).toContain('differs from its verified prepared file')
  expect(await readFile(f.output, 'utf8')).toBe(kind === 'mtime' ? 'full episode fixture bytes' : 'replacement owner bytes')
  if (kind === 'replacement') expect(await readFile(retained, 'utf8')).toBe('full episode fixture bytes')
  await expect(readFile(join(f.root, 'receipt.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})
