import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { expect, it, onTestFinished, vi } from 'vitest'
import { MuseModels } from '../src/models.ts'
import * as modelAccess from '../src/model-access.ts'
import * as sessionStorage from '../src/session.ts'
import { readMuseSession, writeMuseSession } from '../src/session.ts'

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((accept) => { resolve = accept })
  return { promise, resolve }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'muse-models-lifecycle-'))
  const sessionFile = join(root, 'session.json'), accessFile = join(root, 'model-access.json'), baseUrl = 'https://muse.test'
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await writeMuseSession(sessionFile, { baseUrl, username: 'alice', cookie: '__Host-muse=alice-session' })
  const catalog = { providers: [{ id: 'studio', name: 'Studio', models: [{ id: 'writer', name: 'Writer',
    contextWindow: 128000, maxTokens: 8192, input: ['text'], reasoningEfforts: false }] }] }
  let direct = true
  const fetcher = vi.fn(async (url: Parameters<typeof fetch>[0]) => Response.json(!direct ? catalog
    : new URL(url instanceof Request ? url.url : url).pathname.endsWith('/providers') ? { ...catalog, transport: 'direct' }
      : { transport: 'direct', providers: catalog.providers.map(provider => ({ ...provider,
        access: { baseURL: 'https://supplier.test/v1', apiKey: 'lifecycle-fixture-key' } })) }))
  const models = new MuseModels(ctx, { baseUrl, sessionFile, requestTimeoutMs: 1000, fetcher })
  const cleanups: (() => Promise<void>)[] = []
  onTestFinished(async () => {
    const disposal = models.dispose()
    for (const cleanup of cleanups) await cleanup()
    await disposal
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
    vi.restoreAllMocks()
  })
  return { root, sessionFile, accessFile, baseUrl, ctx, models, fetcher, cleanups, relay: () => { direct = false } }
}

async function holdSessionLock(f: Awaited<ReturnType<typeof fixture>>) {
  const locked = gate(), release = gate()
  const done = withFileLock(f.sessionFile, async () => { locked.resolve(); await release.promise })
  f.cleanups.push(async () => { release.resolve(); await done })
  await locked.promise
  return { release: release.resolve, done }
}

it('awaits a blocked save on disposal without publishing credentials or models afterwards', async () => {
  const f = await fixture(), lock = await holdSessionLock(f), started = gate()
  const save = modelAccess.saveModelAccess
  vi.spyOn(modelAccess, 'saveModelAccess').mockImplementation(async (...args) => { started.resolve(); return await save(...args) })
  const refreshing = f.models.refresh()
  await started.promise
  let settled = false
  const disposal = f.models.dispose().then(() => { settled = true })
  expect(f.ctx.llm.listProviders()).toEqual([])
  expect(settled).toBe(false)
  lock.release(); await lock.done
  await Promise.all([refreshing, disposal])
  expect(settled).toBe(true)
  await expect(readFile(f.accessFile)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(f.ctx.llm.listProviders()).toEqual([])
  await f.models.refresh()
  expect(f.fetcher).toHaveBeenCalledTimes(2)
})

it('does not republish or delete retained credentials when disposal interrupts relay cleanup', async () => {
  const f = await fixture()
  await f.models.refresh()
  f.relay()
  const lock = await holdSessionLock(f), started = gate()
  const clear = modelAccess.clearModelAccess
  vi.spyOn(modelAccess, 'clearModelAccess').mockImplementation(async (...args) => { started.resolve(); await clear(...args) })
  const refreshing = f.models.refresh()
  await started.promise
  const disposal = f.models.dispose()
  expect(f.ctx.llm.listProviders()).toEqual([])
  lock.release(); await lock.done
  await Promise.all([refreshing, disposal])
  expect(await readFile(f.accessFile, 'utf8')).toContain('lifecycle-fixture-key')
  expect(f.ctx.llm.listProviders()).toEqual([])
})

it('does not publish a saved catalog after another login replaces it before registration', async () => {
  const f = await fixture(), save = modelAccess.saveModelAccess
  vi.spyOn(modelAccess, 'saveModelAccess').mockImplementation(async (...args) => {
    const accepted = await save(...args)
    await writeMuseSession(f.sessionFile, { baseUrl: f.baseUrl, username: 'bob', cookie: '__Host-muse=bob-session' })
    const current = await readMuseSession(f.sessionFile, f.baseUrl)
    if (!current) throw new Error('Missing replacement login')
    await save(f.sessionFile, f.baseUrl, current.revision, [{ id: 'bob', access: { baseURL: 'https://supplier.test/v1', apiKey: 'bob-fixture-key' } }])
    return accepted
  })
  await f.models.refresh()
  expect(f.ctx.llm.listProviders()).toEqual([])
  expect(await readFile(f.accessFile, 'utf8')).toContain('bob-fixture-key')
})

it('does not issue an old login request after waiting for private-file cleanup', async () => {
  const f = await fixture()
  const current = await readMuseSession(f.sessionFile, f.baseUrl)
  if (!current) throw new Error('Missing fixture login')
  await modelAccess.saveModelAccess(f.sessionFile, f.baseUrl, current.revision,
    [{ id: 'studio', access: { baseURL: 'https://supplier.test/v1', apiKey: 'alice-fixture-key' } }])
  const entered = gate(), release = gate(), ready = gate()
  const lock = withFileLock(f.sessionFile, async () => {
    ready.resolve(); await release.promise
    await writeFileAtomic(f.sessionFile, JSON.stringify({ baseUrl: f.baseUrl, username: 'bob', cookie: '__Host-muse=bob-session', revision: 'replacement-login' }), { mode: 0o600 })
  })
  f.cleanups.push(async () => { release.resolve(); await lock })
  await ready.promise
  const clear = modelAccess.clearModelAccess
  vi.spyOn(modelAccess, 'clearModelAccess').mockImplementation(async (...args) => { entered.resolve(); await clear(...args) })
  const refreshing = f.models.refresh()
  await entered.promise
  release.resolve(); await lock; await refreshing
  expect(f.fetcher).not.toHaveBeenCalled()
  expect(f.ctx.llm.listProviders()).toEqual([])
  expect(await readFile(f.accessFile, 'utf8')).toContain('alice-fixture-key')
})

it.each([1, 2])('does not fetch when disposal interrupts account read %s before authorization', async (read) => {
  const f = await fixture(), entered = gate(), release = gate()
  f.cleanups.push(async () => { release.resolve() })
  const actualRead = sessionStorage.readMuseSession
  let reads = 0
  vi.spyOn(sessionStorage, 'readMuseSession').mockImplementation(async (...args) => {
    const session = await actualRead(...args)
    reads += 1
    if (reads === read) { entered.resolve(); await release.promise }
    return session
  })
  const refreshing = f.models.refresh()
  await entered.promise
  const disposal = f.models.dispose()
  release.resolve()
  await Promise.all([refreshing, disposal])
  expect(f.fetcher).not.toHaveBeenCalled()
  expect(f.ctx.llm.listProviders()).toEqual([])
  await expect(readFile(f.accessFile)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('does not fetch after disposal interrupts initial private-file cleanup', async () => {
  const f = await fixture(), current = await readMuseSession(f.sessionFile, f.baseUrl)
  if (!current) throw new Error('Missing fixture login')
  await modelAccess.saveModelAccess(f.sessionFile, f.baseUrl, current.revision,
    [{ id: 'studio', access: { baseURL: 'https://supplier.test/v1', apiKey: 'retained-fixture-key' } }])
  const lock = await holdSessionLock(f), started = gate(), clear = modelAccess.clearModelAccess
  vi.spyOn(modelAccess, 'clearModelAccess').mockImplementation(async (...args) => { started.resolve(); await clear(...args) })
  const refreshing = f.models.refresh()
  await started.promise
  const disposal = f.models.dispose()
  lock.release(); await lock.done
  await Promise.all([refreshing, disposal])
  expect(f.fetcher).not.toHaveBeenCalled()
  expect(f.ctx.llm.listProviders()).toEqual([])
  expect(await readFile(f.accessFile, 'utf8')).toContain('retained-fixture-key')
})
