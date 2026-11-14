/** Durable ownership indexes reject conflicting identities before dispatch or recovery. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, onTestFinished, vi } from 'vitest'
import { GenerationWatchOwnershipConflict, GenerationWatchStore, type GenerationWatchRun } from '../src/generation-watch-store.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'generation-index-boundaries-'))
  onTestFinished(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })
  const store = new GenerationWatchStore(root)
  const run: GenerationWatchRun = { id: 'a'.repeat(64), sessionId: SessionId('original'), createdAt: 0, deadlineAt: 10,
    packs: [{ key: 'b'.repeat(64), previewPath: join(root, 'preview.json') }] }
  const pack = run.packs[0]!
  const entry = { sessionId: run.sessionId, packs: [{ key: pack.key, previewPath: pack.previewPath }],
    startedKeys: [] as string[], noSend: false, dispatchFinished: false, successor: undefined as string | undefined }
  const owner = { runId: run.id, sessionId: run.sessionId, previewPath: pack.previewPath }
  const index = { version: 2, runs: { [run.id]: entry }, keys: { [pack.key]: owner } }
  return { root, store, run, pack, entry, owner, index,
    saveIndex: async () => { await writeFile(join(root, 'ownership.v2.json'), JSON.stringify(index)) } }
}

it.each(['v2', 'v1'] as const)('refuses unreadable %s ownership evidence', async (version) => {
  const f = await fixture()
  await writeFile(join(f.root, `ownership.${version}.json`), '{broken')
  await expect(f.store.claimOwnership(f.run)).rejects.toBeInstanceOf(SyntaxError)
})

it('reports a checkpoint removed after directory enumeration and rejects a directory checkpoint', async () => {
  const f = await fixture()
  await f.store.create(f.run)
  const read = vi.spyOn(f.store, 'load').mockResolvedValueOnce(undefined)
  await expect(f.store.listAll()).rejects.toThrow('disappeared')
  read.mockRestore()
  await mkdir(join(f.root, `${'c'.repeat(64)}.json`))
  await expect(f.store.listAll()).rejects.toThrow('regular file')
})

it('refuses a changed historical run and orphaned legacy ownership', async () => {
  const f = await fixture()
  await f.store.create(f.run)
  await writeFile(join(f.root, `${f.run.id}.json`), JSON.stringify({ ...f.run, sessionId: 'other' }))
  await expect(f.store.claimOwnership(f.run)).rejects.toBeInstanceOf(GenerationWatchOwnershipConflict)
  await rm(join(f.root, `${f.run.id}.json`))
  await rm(join(f.root, 'ownership.v2.json'))
  await expect(f.store.claimOwnership(f.run)).rejects.toBeInstanceOf(GenerationWatchOwnershipConflict)
})

it.each([false, true])('migrates readable historical checkpoints with a matching legacy index (%s)', async (legacy) => {
  const f = await fixture()
  await writeFile(join(f.root, `${f.run.id}.json`), JSON.stringify(f.run))
  if (legacy) await writeFile(join(f.root, 'ownership.v1.json'), JSON.stringify({ version: 1, keys: f.index.keys }))
  await f.store.claimOwnership(f.run)
  expect(await f.store.mayObserve(f.run.id)).toBe(true)
  expect(await f.store.load(f.run.id)).toEqual(f.run)
})

it('requires an unchanged no-send predecessor before transferring original keys', async () => {
  const f = await fixture(), next = { ...f.run, id: 'c'.repeat(64) }
  await expect(f.store.retryUnsent('d'.repeat(64), next)).rejects.toBeInstanceOf(GenerationWatchOwnershipConflict)
  await f.store.claimAndCreate(f.run)
  await expect(f.store.retryUnsent(f.run.id, next)).rejects.toBeInstanceOf(GenerationWatchOwnershipConflict)
  await f.store.recordNoSend(f.run.id)
  await expect(f.store.retryUnsent(f.run.id, { ...next, sessionId: SessionId('other') })).rejects.toBeInstanceOf(GenerationWatchOwnershipConflict)
  await f.store.retryUnsent(f.run.id, next)
  await expect(f.store.retryUnsent(f.run.id, { ...next, id: 'd'.repeat(64) })).rejects.toBeInstanceOf(GenerationWatchOwnershipConflict)
})

it.each(['run', 'session', 'preview'] as const)('refuses conflicting legacy %s ownership during migration', async (field) => {
  const f = await fixture()
  if (field === 'run') f.owner.runId = 'c'.repeat(64)
  if (field === 'session') f.owner.sessionId = SessionId('other')
  if (field === 'preview') f.owner.previewPath = join(f.root, 'other.json')
  await writeFile(join(f.root, 'ownership.v1.json'), JSON.stringify({ version: 1, keys: f.index.keys }))
  await writeFile(join(f.root, `${f.run.id}.json`), JSON.stringify(f.run))
  await expect(f.store.claimOwnership(f.run)).rejects.toBeInstanceOf(GenerationWatchOwnershipConflict)
})

it.each(['duplicate-pack', 'duplicate-start', 'unknown-start', 'started-no-send', 'missing-owner', 'owner-session', 'owner-preview',
  'orphan-owner', 'unlisted-owner', 'extra-owner-session'] as const)('rejects inconsistent durable index: %s', async (kind) => {
  const f = await fixture()
  if (kind === 'duplicate-pack') f.entry.packs.push(f.pack)
  if (kind === 'duplicate-start') f.entry.startedKeys.push(f.pack.key, f.pack.key)
  if (kind === 'unknown-start') f.entry.startedKeys.push('c'.repeat(64))
  if (kind === 'started-no-send') { f.entry.startedKeys.push(f.pack.key); f.entry.noSend = true }
  if (kind === 'missing-owner') Reflect.deleteProperty(f.index.keys, f.pack.key)
  if (kind === 'owner-session') f.owner.sessionId = SessionId('other')
  if (kind === 'owner-preview') f.owner.previewPath = join(f.root, 'other.json')
  if (kind === 'orphan-owner') f.index.keys['c'.repeat(64)] = { ...f.owner, runId: 'd'.repeat(64) }
  if (kind === 'unlisted-owner') f.index.keys['c'.repeat(64)] = { ...f.owner }
  if (kind === 'extra-owner-session') f.index.keys['c'.repeat(64)] = { ...f.owner, sessionId: SessionId('other') }
  await f.saveIndex()
  await expect(f.store.claimOwnership(f.run)).rejects.toBeInstanceOf(GenerationWatchOwnershipConflict)
})

it.each(['not-no-send', 'cycle', 'missing', 'session', 'count', 'preview'] as const)(
  'refuses an invalid durable successor chain: %s', async (kind) => {
    const f = await fixture(), id = 'c'.repeat(64)
    f.entry.noSend = kind !== 'not-no-send'
    f.entry.successor = id
    const successor = { ...f.entry, packs: [...f.entry.packs], successor: undefined as string | undefined }
    f.index.runs[id] = successor
    f.owner.runId = id
    if (kind === 'cycle') successor.successor = f.run.id
    if (kind === 'missing') Reflect.deleteProperty(f.index.runs, id)
    if (kind === 'session') successor.sessionId = SessionId('other')
    if (kind === 'count') successor.packs.push({ key: 'd'.repeat(64), previewPath: join(f.root, 'extra.json') })
    if (kind === 'preview') successor.packs = [{ ...f.pack, previewPath: join(f.root, 'other.json') }]
    await f.saveIndex()
    await expect(f.store.claimOwnership(f.run)).rejects.toBeInstanceOf(GenerationWatchOwnershipConflict)
  })

it('fences invalid and repeated dispatches and preserves original inputs on replay', async () => {
  const f = await fixture()
  await f.store.claimAndCreate(f.run)
  await expect(f.store.claimOwnership({ ...f.run, sessionId: SessionId('other') })).rejects.toThrow('inputs changed')
  await expect(f.store.markDispatchStarted('c'.repeat(64), f.pack.key)).rejects.toBeInstanceOf(GenerationWatchOwnershipConflict)
  await expect(f.store.markDispatchStarted(f.run.id, 'd'.repeat(64))).rejects.toBeInstanceOf(GenerationWatchOwnershipConflict)
  await f.store.markDispatchStarted(f.run.id, f.pack.key)
  await f.store.markDispatchStarted(f.run.id, f.pack.key)
  await expect(f.store.recordNoSend(f.run.id)).rejects.toBeInstanceOf(GenerationWatchOwnershipConflict)
  const disk = JSON.parse(await readFile(join(f.root, 'ownership.v2.json'), 'utf8')) as typeof f.index
  expect(disk.runs[f.run.id]!.startedKeys).toEqual([f.pack.key])
})

it('rejects paid dispatch and updates of a retired no-send invocation', async () => {
  const f = await fixture()
  await f.store.claimAndCreate(f.run)
  await f.store.recordNoSend(f.run.id)
  await expect(f.store.markDispatchStarted(f.run.id, f.pack.key)).rejects.toBeInstanceOf(GenerationWatchOwnershipConflict)
  const successor = { ...f.run, id: 'c'.repeat(64) }
  await f.store.retryUnsent(f.run.id, successor)
  await expect(f.store.recordNoSend(f.run.id)).rejects.toBeInstanceOf(GenerationWatchOwnershipConflict)
  await expect(f.store.put({ ...f.run, sessionId: SessionId('other') })).rejects.toBeInstanceOf(GenerationWatchOwnershipConflict)
})

it('refuses relative ownership paths and propagates durable read failures', async () => {
  const f = await fixture()
  await expect(f.store.resolveVerifiedOwner(f.pack.key, 'relative', f.root, async () => true)).rejects.toThrow('absolute')
  await writeFile(join(f.root, 'ownership.v2.json'), '{broken')
  await expect(f.store.resolveVerifiedOwner(f.pack.key, f.pack.previewPath, f.root, async () => true)).rejects.toBeInstanceOf(SyntaxError)
})

it('refuses a checkpoint lost after successful creation and dispatch sealing', async () => {
  const f = await fixture(), finish = f.store.finishInitialDispatch.bind(f.store)
  vi.spyOn(f.store, 'finishInitialDispatch').mockImplementation(async (id) => {
    await finish(id)
    await rm(join(f.root, `${id}.json`))
  })
  await expect(f.store.create(f.run)).rejects.toBeInstanceOf(GenerationWatchOwnershipConflict)
})

it('restores a missing checkpoint only through its existing immutable index entry', async () => {
  const f = await fixture()
  await f.store.create(f.run)
  await rm(join(f.root, `${f.run.id}.json`))
  await f.store.put(f.run)
  expect(await f.store.load(f.run.id)).toEqual(f.run)
})
