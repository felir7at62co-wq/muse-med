import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
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
  const sessionFile = join(root, 'session.json'), baseUrl = 'https://muse.test'
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await writeMuseSession(sessionFile, { baseUrl, username: 'alice', cookie: '__Host-muse=alice-session' })
  const catalog = { providers: [{ id: 'studio', name: 'Studio', models: [{ id: 'writer', name: 'Writer',
    contextWindow: 128000, maxTokens: 8192, input: ['text'], reasoningEfforts: false }] }] }
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(catalog))
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
  return { root, sessionFile, baseUrl, ctx, models, fetcher, cleanups }
}

function blockRetiredFileRemoval(f: Awaited<ReturnType<typeof fixture>>) {
  const started = gate(), release = gate(), remove = modelAccess.removeModelAccessFile
  f.cleanups.push(async () => { release.resolve() })
  vi.spyOn(modelAccess, 'removeModelAccessFile').mockImplementation(async (...args) => {
    started.resolve(); await release.promise; await remove(...args)
  })
  return { started: started.promise, release: release.resolve }
}

it('awaits a blocked retired-file removal on disposal without fetching or publishing models', async () => {
  const f = await fixture(), removal = blockRetiredFileRemoval(f)
  const refreshing = f.models.refresh()
  await removal.started
  let settled = false
  const disposal = f.models.dispose().then(() => { settled = true })
  expect(f.ctx.llm.listProviders()).toEqual([])
  expect(settled).toBe(false)
  removal.release()
  await Promise.all([refreshing, disposal])
  expect(settled).toBe(true)
  expect(f.fetcher).not.toHaveBeenCalled()
  expect(f.ctx.llm.listProviders()).toEqual([])
  await f.models.refresh()
  expect(f.fetcher).not.toHaveBeenCalled()
})

it('requests the catalog for the login that replaced the account during retired-file removal', async () => {
  const f = await fixture(), removal = blockRetiredFileRemoval(f)
  const refreshing = f.models.refresh()
  await removal.started
  await writeMuseSession(f.sessionFile, { baseUrl: f.baseUrl, username: 'bob', cookie: '__Host-muse=bob-session' })
  removal.release(); await refreshing
  expect(f.fetcher.mock.calls.map(([, init]) => new Headers(init?.headers).get('cookie'))).toEqual(['__Host-muse=bob-session'])
  expect(f.ctx.llm.listProviders().map(provider => provider.id)).toEqual(['muse-cloud-studio'])
})

it('ignores an old provider-catalog rejection after a new login replaces the account', async () => {
  const f = await fixture()
  await f.models.refresh()
  const entered = gate(), release = gate()
  f.fetcher.mockImplementationOnce(async () => {
    entered.resolve()
    await release.promise
    return new Response('', { status: 401 })
  })
  const refreshing = f.models.refresh()
  f.cleanups.push(async () => { release.resolve(); await Promise.allSettled([refreshing]) })
  await entered.promise
  await writeMuseSession(f.sessionFile, { baseUrl: f.baseUrl, username: 'bob', cookie: '__Host-muse=bob-session' })
  const bob = await readMuseSession(f.sessionFile, f.baseUrl)
  if (!bob) throw new Error('Missing replacement login')
  release.resolve()
  await expect(refreshing).resolves.toBeUndefined()
  expect(await readMuseSession(f.sessionFile, f.baseUrl)).toMatchObject({ username: 'bob', revision: bob.revision })
  expect(f.ctx.llm.listProviders().map(provider => provider.id)).toEqual(['muse-cloud-studio'])
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
})
