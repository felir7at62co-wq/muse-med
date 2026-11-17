/** Generation dispatch retains its original owner through checkpoint races and Host shutdown. */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, onTestFinished, vi } from 'vitest'
import { GenerationWatchRuntime } from '../src/generation-watch.ts'
import { GenerationWatchOwnershipConflict, GenerationWatchStore, type GenerationWatchRun } from '../src/generation-watch-store.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'muse-watch-runtime-boundaries-'))
  const store = new GenerationWatchStore(join(root, 'watches'))
  const ledger = new JubianLedger({ root: join(root, 'ledger') })
  const sessionId = SessionId('original-owner')
  const packs = [{ key: 'b'.repeat(64), previewPath: join(root, 'preview.json') }]
  const id = createHash('sha256').update(JSON.stringify([sessionId, packs.map(pack => pack.key)])).digest('hex')
  const original: GenerationWatchRun = { id, sessionId, packs, createdAt: 0, deadlineAt: 60_000 }
  const fetch = vi.fn(async () => { throw new Error('No provider request is permitted') })
  const deliver = vi.fn<ConstructorParameters<typeof GenerationWatchRuntime>[0]['deliver']>(async () => 'settled')
  const warn = vi.fn()
  const runtime = new GenerationWatchRuntime({ store, ledger, deliver, warn,
    client: new JubianClient({ credential: async () => 'fixture', fetch }), watchPollIntervalMs: 60_000,
    watchTimeoutMs: 60_000, withoutInitiator: async operation => operation() })
  onTestFinished(async () => { await runtime.close(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })
  const record = async () => {
    await ledger.begin({ idempotencyKey: packs[0]!.key, scriptId: 2708, method: 'storyboard_native_submit', requestSha256: 'c'.repeat(64) })
  }
  return { root, store, ledger, sessionId, packs, id, original, runtime, fetch, deliver, warn, record }
}

it('refuses enrollment when its retained checkpoint requires manual review', async () => {
  const f = await fixture()
  await f.store.create({ ...f.original, reviewRequired: true })
  await expect(f.runtime.enroll(f.sessionId, f.packs)).rejects.toThrow('requires manual review')
  expect(f.fetch).not.toHaveBeenCalled()
})

it('refuses a partially overlapping batch owned by another Session', async () => {
  const f = await fixture()
  await f.store.create({ ...f.original, id: 'd'.repeat(64), sessionId: SessionId('other-owner') })
  await expect(f.runtime.enroll(f.sessionId, f.packs)).rejects.toBeInstanceOf(GenerationWatchOwnershipConflict)
  expect(f.fetch).not.toHaveBeenCalled()
})

it('returns the original receipt when another Host creates the same batch during enrollment', async () => {
  const f = await fixture()
  await f.record()
  const list = f.store.listActive.bind(f.store)
  vi.spyOn(f.store, 'listActive').mockImplementationOnce(async (...args) => {
    await new GenerationWatchStore(join(f.root, 'watches')).create(f.original)
    return await list(...args)
  })
  await expect(f.runtime.enroll(f.sessionId, f.packs)).resolves.toEqual({ id: f.id, initial: false })
  expect(f.fetch).not.toHaveBeenCalled()
})

it('does not grant a dispatch fence to an invocation that did not enroll', async () => {
  const f = await fixture()
  await f.store.create(f.original)
  const operation = vi.fn(async () => ({}))
  await expect(f.runtime.executeDispatch(f.id, operation)).rejects.toThrow('not owned by this invocation')
  expect(operation).not.toHaveBeenCalled()
})

it('rejects a paid fence for a key outside its original batch', async () => {
  const f = await fixture()
  await f.runtime.enroll(f.sessionId, f.packs)
  await expect(f.runtime.executeDispatch(f.id, async (beforeSend) => {
    await beforeSend('e'.repeat(64))
    return {}
  })).rejects.toBeInstanceOf(GenerationWatchOwnershipConflict)
  expect(await f.store.hasNoSend(f.id)).toBe(true)
  expect(await f.ledger.records()).toEqual([])
  expect(f.fetch).not.toHaveBeenCalled()
})

it('retains a no-send marker when the checkpoint disappears before its preflight receipt', async () => {
  const f = await fixture()
  await f.runtime.enroll(f.sessionId, f.packs)
  const record = f.store.recordNoSend.bind(f.store)
  vi.spyOn(f.store, 'recordNoSend').mockImplementationOnce(async (id) => {
    await record(id)
    await rm(join(f.root, 'watches', `${id}.json`))
  })
  await expect(f.runtime.executeDispatch(f.id, async () => ({}))).rejects.toBeInstanceOf(GenerationWatchOwnershipConflict)
  expect(f.warn).toHaveBeenCalledWith(expect.stringContaining('Saving generation readback failed'), expect.any(Error))
  expect(await f.ledger.records()).toEqual([])
})

it('keeps an already advancing original key when its checkpoint disappears during a recovery lease', async () => {
  const f = await fixture()
  await f.store.create(f.original)
  await f.record()
  let entered = false
  const release = Promise.withResolvers<undefined>()
  const recover = f.store.withRecoveryLease.bind(f.store)
  const held = vi.spyOn(f.store, 'withRecoveryLease').mockImplementationOnce(async (id, signal, timeout, action) => {
    return await recover(id, signal, timeout, async () => {
      entered = true
      await release.promise
      return await action()
    })
  })
  f.runtime.start()
  try {
    await vi.waitFor(() => { expect(entered).toBe(true) })
    await rm(join(f.root, 'watches', `${f.id}.json`))
    await expect(f.runtime.enroll(f.sessionId, f.packs)).resolves.toEqual({ id: f.id, initial: false })
  } finally { release.resolve(undefined); await f.runtime.close(); held.mockRestore() }
  expect(f.deliver).not.toHaveBeenCalled()
  expect(f.fetch).not.toHaveBeenCalled()
})

it('retains an ownership conflict discovered after the observation fence for manual review', async () => {
  const f = await fixture()
  await f.store.create(f.original)
  const conflicting = join(f.root, 'watches', `${'d'.repeat(64)}.json`)
  const observe = f.store.mayObserve.bind(f.store)
  vi.spyOn(f.store, 'mayObserve').mockImplementationOnce(async (id) => {
    const allowed = await observe(id)
    await writeFile(conflicting, JSON.stringify({ ...f.original, id: 'd'.repeat(64), sessionId: 'competing-owner' }))
    return allowed
  })
  const claim = f.store.claimOwnership.bind(f.store)
  vi.spyOn(f.store, 'claimOwnership').mockImplementationOnce(async (...args) => {
    try { await claim(...args) }
    catch (error) { await rm(conflicting); throw error }
  })
  f.runtime.start()
  await vi.waitFor(async () => { expect((await f.store.load(f.id))?.reviewRequired).toBe(true) })
  await f.runtime.close()
  expect(f.warn).toHaveBeenCalledWith(expect.stringContaining('ambiguous ownership'), expect.any(GenerationWatchOwnershipConflict))
  expect(f.deliver).not.toHaveBeenCalled()
  expect(f.fetch).not.toHaveBeenCalled()
  expect(JSON.parse(await readFile(join(f.root, 'watches', `${f.id}.json`), 'utf8'))).toMatchObject({ sessionId: f.sessionId })
})
