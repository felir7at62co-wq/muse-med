/** Account-route repair failures preserve live selections across asynchronous lifecycle changes. */
import type { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MuseModels } from '../src/models.ts'
import * as sessionStorage from '../src/session.ts'
import { oldSessionFixture } from './model-routing-fixture.ts'

function gate() {
  return Promise.withResolvers<undefined>()
}

async function fixture(beforeOwner?: (ctx: Context) => void) {
  const root = await mkdtemp(join(tmpdir(), 'muse-model-repair-'))
  const f = await oldSessionFixture(false, root)
  const baseUrl = 'https://muse.test', sessionFile = join(root, 'session.json')
  await sessionStorage.writeMuseSession(sessionFile, { baseUrl, username: 'alice', cookie: '__Host-muse=alice-session' })
  await f.ctx.settings.replace('agent-default-model', { provider: 'muse-cloud-deepseek-official', model: 'deepseek-flash' })
  const catalog = { providers: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{
    id: 'deepseek-flash', name: 'DeepSeek Flash', contextWindow: 128000, maxTokens: 8192,
    input: ['text'], reasoningEfforts: { high: 'high' },
  }] }] }
  beforeOwner?.(f.ctx)
  const models = new MuseModels(f.ctx, { baseUrl, sessionFile, requestTimeoutMs: 1000,
    fetcher: async () => Response.json(catalog) })
  const release: (() => void)[] = []
  onTestFinished(async () => {
    for (const unblock of release) unblock()
    await models.dispose()
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  })
  return { ...f, root, models, catalog, release }
}

it('keeps an unselected Agent unchanged and accepts a creation event without an optional signal', async () => {
  const f = await fixture()
  const unselected = await f.driver.create(SessionId('no-model-choice'), {}, { cwd: f.root })
  await f.models.refresh()
  await agentEvents(f.ctx, unselected).serial('agent/created', { source: 'resume' })
  expect(unselected.model.current()).toBeUndefined()
  expect(unselected.session.snapshotEvents().filter(row => row.type === 'model/selection')).toEqual([])
})

it('does not repair a creation callback already queued when the account owner is disposed', async () => {
  const entered = gate(), release = gate()
  const f = await fixture(ctx => ctx.on('agent/created', async ({ agent }) => {
    if (agent.id !== 'queued-account-creation') return undefined
    entered.resolve(undefined)
    await release.promise
    return undefined
  }))
  f.release.push(() => { release.resolve(undefined) })
  await f.models.refresh()
  const creation = f.driver.create(SessionId('queued-account-creation'), {
    provider: 'deepseek-official', model: 'deepseek-flash',
  }, { cwd: f.root })
  await entered.promise
  await f.models.dispose()
  release.resolve(undefined)
  const agent = await creation
  expect(agent.model.current()).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' })
  expect(agent.session.snapshotEvents().filter(row => row.type === 'model/selection')).toEqual([])
})

it('surfaces model-discovery failure without committing a route and permits a later explicit refresh', async () => {
  const f = await fixture(), failure = new Error('Controlled provider discovery failure')
  const discovery = vi.spyOn(f.ctx.llm, 'listModels').mockRejectedValueOnce(failure)
  await expect(f.models.refresh()).rejects.toBe(failure)
  expect(f.agent.model.current()).toEqual(f.initialSelection)
  discovery.mockRestore()
  await f.models.refresh()
  expect(f.agent.model.current()).toEqual({ ...f.initialSelection, provider: 'muse-cloud-deepseek-official' })
})

it.each([new Error('Controlled model resolution failure'), new LlmError('Missing route credential', 'MISSING_CREDENTIAL')])(
  'propagates an active route-resolution failure without changing its selection: %s', async (failure) => {
    const f = await fixture()
    vi.spyOn(f.ctx.llm, 'resolveCallConfig').mockRejectedValueOnce(failure)
    await expect(f.models.refresh()).rejects.toBe(failure)
    expect(f.agent.model.current()).toEqual(f.initialSelection)
  },
)

it('does not replace creation cancellation with a late route-resolution error', async () => {
  const f = await fixture()
  await f.models.refresh()
  const entered = gate(), release = gate(), caller = new AbortController()
  f.release.push(() => { release.resolve(undefined) })
  vi.spyOn(f.ctx.llm, 'resolveCallConfig').mockImplementationOnce(async () => {
    entered.resolve(undefined)
    await release.promise
    throw new Error('Late provider resolution failure')
  })
  const id = SessionId('cancelled-account-creation')
  const creation = f.ctx.agents.create({ sessionId: id, signal: caller.signal, meta: { cwd: f.root },
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash' } })
  const rejected = expect(creation).rejects.toMatchObject({ name: 'AbortError' })
  await entered.promise
  caller.abort()
  release.resolve(undefined)
  await rejected
  expect(f.ctx.agents.get(id)).toBeUndefined()
})

it('ignores a late route-resolution failure after its account owner is disposed', async () => {
  const f = await fixture(), entered = gate(), release = gate()
  f.release.push(() => { release.resolve(undefined) })
  vi.spyOn(f.ctx.llm, 'resolveCallConfig').mockImplementationOnce(async () => {
    entered.resolve(undefined)
    await release.promise
    throw new Error('Late provider resolution failure')
  })
  const refresh = f.models.refresh()
  await entered.promise
  const disposal = f.models.dispose()
  release.resolve(undefined)
  await Promise.all([refresh, disposal])
  expect(f.agent.model.current()).toEqual(f.initialSelection)
})

it('does not use an old profile after credential inspection overlaps a new catalog generation', async () => {
  const f = await fixture()
  await f.models.refresh()
  f.agent.model.select(f.initialSelection)
  const entered = gate(), release = gate(), describe = f.ctx.credentials.describe.bind(f.ctx.credentials)
  f.release.push(() => { release.resolve(undefined) })
  vi.spyOn(f.ctx.credentials, 'describe').mockImplementationOnce(async (...args) => {
    const result = await describe(...args)
    entered.resolve(undefined)
    await release.promise
    return result
  })
  const repair = agentEvents(f.ctx, f.agent).serial('agent/created', { source: 'resume' })
  await entered.promise
  f.catalog.providers[0]!.name = 'Updated account catalog'
  await f.models.refresh()
  const selected = f.agent.model.current()
  release.resolve(undefined)
  await repair
  expect(selected).toEqual({ ...f.initialSelection, provider: 'muse-cloud-deepseek-official' })
  expect(f.agent.model.current()).toEqual(selected)
})

it.each(['dispose', 'catalog', 'agent'] as const)(
  'does not commit a repair after %s changes during its final account read', async (change) => {
    const f = await fixture()
    await f.models.refresh()
    const handle = await f.ctx.agents.create({ sessionId: SessionId(`final-read-${change}`), meta: { cwd: f.root },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash' } })
    onTestFinished(async () => { await handle.dispose() })
    handle.agent.model.select(f.initialSelection)
    const select = vi.spyOn(handle.agent.model, 'select'), entered = gate(), release = gate()
    f.release.push(() => { release.resolve(undefined) })
    const resolve = f.ctx.llm.resolveCallConfig.bind(f.ctx.llm), read = sessionStorage.readMuseSession
    let holdNextRead = false
    vi.spyOn(f.ctx.llm, 'resolveCallConfig').mockImplementationOnce(async (...args) => {
      const result = await resolve(...args)
      holdNextRead = true
      return result
    })
    vi.spyOn(sessionStorage, 'readMuseSession').mockImplementation(async (...args) => {
      const result = await read(...args)
      if (holdNextRead) {
        holdNextRead = false
        entered.resolve(undefined)
        await release.promise
      }
      return result
    })
    const repair = agentEvents(f.ctx, handle.agent).serial('agent/created', { source: 'resume' })
    await entered.promise
    let disposal: Promise<void> | undefined
    if (change === 'dispose') disposal = f.models.dispose()
    else if (change === 'agent') await handle.dispose()
    else {
      f.catalog.providers[0]!.name = 'New account catalog generation'
      await f.models.refresh()
    }
    const committed = select.mock.calls.length
    release.resolve(undefined)
    await repair
    await disposal
    expect(select).toHaveBeenCalledTimes(committed)
    if (change === 'catalog') expect(handle.agent.model.current())
      .toEqual({ ...f.initialSelection, provider: 'muse-cloud-deepseek-official' })
    else expect(select).not.toHaveBeenCalled()
    if (change === 'agent') expect(f.ctx.agents.get(handle.agent.id)).toBeUndefined()
  },
)
