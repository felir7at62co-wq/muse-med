import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { GenerationWatchRuntime } from '../src/generation-watch.ts'
import { createGenerationWatchNotice, deliverGenerationWatchNotice } from '../src/generation-watch-delivery.ts'
import { GenerationWatchOwnershipConflict, GenerationWatchStore, type GenerationWatchVerifiedOwner, type GenerationWatchRun } from '../src/generation-watch-store.ts'

vi.mock('../src/native.ts', () => ({ reconcileRecordedVideo: vi.fn() }))
vi.mock('../src/watch.ts', () => ({ observeWatchTask: vi.fn() }))

function run(root: string, id: string, session: string, keys: string[]): GenerationWatchRun {
  return { id: id.repeat(64), sessionId: SessionId(session), createdAt: 0, deadlineAt: 1,
    packs: keys.map(key => ({ key: key.repeat(64), previewPath: join(root, `${key}.json`) })) }
}

it('retains one original Session and checkpoint for a key across store instances and different batches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-watch-owner-'))
  try {
    const first = new GenerationWatchStore(root), second = new GenerationWatchStore(root)
    const original = run(root, 'a', 'original-session', ['b', 'c'])
    await first.claimOwnership(original)
    await first.create(original)
    await second.claimOwnership(original)
    await expect(second.claimOwnership(run(root, 'd', 'original-session', ['b']))).rejects.toBeInstanceOf(GenerationWatchOwnershipConflict)
    await expect(second.claimOwnership(run(root, 'e', 'other-session', ['b']))).rejects.toBeInstanceOf(GenerationWatchOwnershipConflict)
    expect(await second.load(original.id)).toEqual(original)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('refuses ambiguous historical or unreadable checkpoints rather than selecting a Session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-watch-history-'))
  try {
    const store = new GenerationWatchStore(root)
    const first = run(root, 'a', 'first-session', ['b'])
    await store.create(first)
    const conflicting = run(root, 'c', 'second-session', ['b'])
    await writeFile(join(root, `${conflicting.id}.json`), JSON.stringify(conflicting))
    await expect(store.claimOwnership(first)).rejects.toBeInstanceOf(GenerationWatchOwnershipConflict)
    await writeFile(join(root, `${'d'.repeat(64)}.json`), '{broken')
    await expect(store.claimOwnership(run(root, 'e', 'third-session', ['f']))).rejects.toThrow()
    expect(await store.load(first.id)).toEqual(first)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('serializes competing owners and leaves the losing batch without partial claims', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-watch-claims-'))
  try {
    const first = new GenerationWatchStore(root), second = new GenerationWatchStore(root)
    const left = run(root, 'a', 'first-session', ['b', 'c'])
    const right = run(root, 'd', 'second-session', ['c', 'e'])
    const outcomes = await Promise.allSettled([first.claimOwnership(left), second.claimOwnership(right)])
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1)
    const saved = JSON.parse(await readFile(join(root, 'ownership.v1.json'), 'utf8')) as {
      keys: Record<string, { runId: string; sessionId: string }>
    }
    const winner = outcomes[0]?.status === 'fulfilled' ? left : right
    expect(Object.keys(saved.keys).sort()).toEqual(winner.packs.map(pack => pack.key).sort())
    expect(Object.values(saved.keys).every(owner => owner.runId === winner.id && owner.sessionId === winner.sessionId)).toBe(true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('does not recreate a missing checkpoint from an existing key claim', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-watch-orphan-'))
  try {
    const store = new GenerationWatchStore(root), original = run(root, 'a', 'original-session', ['b'])
    await store.claimOwnership(original)
    await expect(store.claimAndCreate(original)).rejects.toBeInstanceOf(GenerationWatchOwnershipConflict)
    expect(await store.load(original.id)).toBeUndefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('drains an admitted enrollment before shutdown resolves', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-watch-shutdown-'))
  const store = new GenerationWatchStore(root)
  const originalClaim = store.claimAndCreate.bind(store)
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  vi.spyOn(store, 'claimAndCreate').mockImplementation(async (...args) => {
    entered.resolve(undefined)
    await release.promise
    return await originalClaim(...args)
  })
  const fetch = vi.fn(async () => { throw new Error('Shutdown must not call the provider') })
  const runtime = new GenerationWatchRuntime({ store,
    client: new JubianClient({ credential: async () => 'fixture', fetch }),
    ledger: new JubianLedger({ root: join(root, 'ledger') }),
    deliver: async () => { throw new Error('Shutdown must not deliver a notice') },
    warn: () => {}, watchTimeoutMs: 5000, watchPollIntervalMs: 20,
    withoutInitiator: async (operation) =>{  await operation() } })
  const pending = runtime.enroll(SessionId('original-session'), [{ key: 'a'.repeat(64), previewPath: join(root, 'preview.json') }])
    .catch((error: unknown) => error)
  try {
    await entered.promise
    let closed = false
    const closing = runtime.close().then(() => { closed = true })
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(closed).toBe(false)
    release.resolve(undefined)
    await Promise.all([closing, pending])
    expect(await store.listAll()).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    release.resolve(undefined)
    await Promise.allSettled([pending, runtime.close()])
    await rm(root, { recursive: true, force: true })
  }
})

it('drains a receipt already committing and rejects new work after shutdown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-watch-receipt-shutdown-'))
  const store = new GenerationWatchStore(root), original = run(root, 'a', 'original-session', ['b'])
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const originalPut = store.put.bind(store)
  vi.spyOn(store, 'put').mockImplementation(async (value) => {
    entered.resolve(undefined)
    await release.promise
    await originalPut(value)
  })
  const fetch = vi.fn(async () => { throw new Error('Shutdown must not call the provider') })
  const runtime = new GenerationWatchRuntime({ store,
    client: new JubianClient({ credential: async () => 'fixture', fetch }),
    ledger: new JubianLedger({ root: join(root, 'ledger') }),
    deliver: async () => { throw new Error('Shutdown must not deliver a notice') },
    warn: () => {}, watchTimeoutMs: 5000, watchPollIntervalMs: 20,
    withoutInitiator: async (operation) =>{  await operation() } })
  await store.create(original)
  const pending = runtime.finishDispatch(original.id, { status: 'submitted', task_id: 42 })
  try {
    await entered.promise
    let closed = false
    const closing = runtime.close().then(() => { closed = true })
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(closed).toBe(false)
    release.resolve(undefined)
    await Promise.all([closing, pending])
    expect((await store.load(original.id))?.packs[0]?.taskId).toBe(42)
    await expect(runtime.enroll(SessionId('original-session'), original.packs)).rejects.toBeDefined()
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    release.resolve(undefined)
    await Promise.allSettled([pending, runtime.close()])
    await rm(root, { recursive: true, force: true })
  }
})

it('retains an unconfirmed notice without marking it delivered', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-watch-unconfirmed-notice-'))
  const store = new GenerationWatchStore(root), original = run(root, 'a', 'original-session', ['b'])
  const fetch = vi.fn(async () => { throw new Error('Recovery must not call the provider') })
  const deliver = vi.fn(async () => 'needs-review' as const)
  const runtime = new GenerationWatchRuntime({ store,
    client: new JubianClient({ credential: async () => 'fixture', fetch }),
    ledger: new JubianLedger({ root: join(root, 'ledger') }), deliver,
    warn: () => {}, watchTimeoutMs: 5000, watchPollIntervalMs: 20,
    withoutInitiator: async (operation) =>{  await operation() } })
  try {
    await store.create({ ...original, packs: original.packs.map(pack => ({ ...pack,
      outcome: { status: 'failed', detail: 'offline fixture' } })) })
    runtime.start()
    await vi.waitFor(async () => { expect((await store.load(original.id))?.reviewRequired).toBe(true) })
    await runtime.close()
    const retained = await store.load(original.id)
    expect(retained?.notice?.id).toBeDefined()
    expect(retained?.notice?.deliveredAt).toBeUndefined()
    expect(retained?.sessionId).toBe(original.sessionId)
    expect(deliver).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    await runtime.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('retains an archived group without forwarding its notice or inventing another Session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-watch-archived-group-'))
  const store = new GenerationWatchStore(root), original = run(root, 'a', 'original-worker-session', ['b'])
  const groupOrigin = { roomId: 'room', workerBotId: 'worker', requesterBotId: 'requester',
    requesterSessionId: 'requester-session', exchangeId: 'original-exchange' }
  const fetch = vi.fn(async () => { throw new Error('Archived recovery must not call the provider') })
  const deliver = vi.fn(async () => 'settled' as const)
  const runtime = new GenerationWatchRuntime({ store,
    client: new JubianClient({ credential: async () => 'fixture', fetch }),
    ledger: new JubianLedger({ root: join(root, 'ledger') }), deliver,
    warn: () => {}, watchTimeoutMs: 5000, watchPollIntervalMs: 20,
    withoutInitiator: async (operation) =>{  await operation() } })
  try {
    await store.create({ ...original, groupOrigin })
    runtime.start()
    await vi.waitFor(async () => { expect((await store.load(original.id))?.reviewRequired).toBe(true) })
    await runtime.close()
    expect(await store.load(original.id)).toMatchObject({ sessionId: original.sessionId, groupOrigin, reviewRequired: true })
    expect(deliver).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(await store.listActive()).toEqual([])
  } finally {
    await runtime.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('requires trusted project and Session attestation before returning a unique submitter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-watch-resolve-'))
  try {
    const store = new GenerationWatchStore(root), original = run(root, 'a', 'session', ['b'])
    const pack = original.packs[0]!
    const attest = vi.fn(async (owner: GenerationWatchVerifiedOwner, projectDir: string) =>
      owner.sessionId === original.sessionId && projectDir === root)
    expect(await store.resolveVerifiedOwner(pack.key, pack.previewPath, root, attest)).toBeUndefined()
    await store.claimOwnership(original)
    expect(await store.resolveVerifiedOwner(pack.key, pack.previewPath, root, attest)).toBeUndefined()
    await store.create(original)
    expect(await store.resolveVerifiedOwner(pack.key, join(root, 'wrong.json'), root, attest)).toBeUndefined()
    expect(await store.resolveVerifiedOwner(pack.key, pack.previewPath, join(root, 'other'), attest)).toBeUndefined()
    expect(await store.resolveVerifiedOwner(pack.key, pack.previewPath, root, attest)).toEqual({
      runId: original.id, sessionId: original.sessionId, key: pack.key, previewPath: pack.previewPath,
    })
    const conflicting = run(root, 'c', 'another-session', ['b'])
    await writeFile(join(root, `${conflicting.id}.json`), JSON.stringify(conflicting))
    expect(await store.resolveVerifiedOwner(pack.key, pack.previewPath, root, attest)).toBeUndefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('does not hold the ownership lock while attesting and rejects state changed during attestation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-watch-attestation-race-'))
  try {
    const store = new GenerationWatchStore(root), original = run(root, 'a', 'session', ['b'])
    const pack = original.packs[0]!
    await store.claimOwnership(original)
    await store.create(original)
    const result = await store.resolveVerifiedOwner(pack.key, pack.previewPath, root, async () => {
      await store.claimOwnership(original)
      await store.put({ ...original, reviewRequired: true })
      return true
    })
    expect(result).toBeUndefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('refuses archived group origins without invoking the attestor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-watch-group-resolve-'))
  try {
    const store = new GenerationWatchStore(root), original = run(root, 'a', 'session', ['b'])
    const groupOrigin = { roomId: 'room', workerBotId: 'worker', requesterBotId: 'requester',
      requesterSessionId: 'requester-session', exchangeId: 'exchange' }
    const group = { ...original, groupOrigin }, pack = original.packs[0]!
    await store.claimOwnership(group)
    await store.create(group)
    const attest = vi.fn(async () => true)
    expect(await store.resolveVerifiedOwner(pack.key, pack.previewPath, root, attest)).toBeUndefined()
    expect(attest).not.toHaveBeenCalled()
  } finally { await rm(root, { recursive: true, force: true }) }
})


it('never resolves or resumes a Session without affirmative Host ownership evidence', async () => {
  const ctx = new Context()
  const get = vi.spyOn(ctx, 'get')
  const notice = createGenerationWatchNotice('fixture')
  try {
    expect(await deliverGenerationWatchNotice(ctx, SessionId('legacy'), notice)).toBe('pending')
    expect(await deliverGenerationWatchNotice(ctx, SessionId('legacy'), notice, undefined, undefined, undefined, async () => false)).toBe('needs-review')
    expect(get).not.toHaveBeenCalled()
    await expect(deliverGenerationWatchNotice(ctx, SessionId('verified'), notice, undefined, undefined, undefined,
      async () => true)).rejects.toThrow('requires the Host session controller')
  } finally { await ctx.fiber.dispose() }
})
