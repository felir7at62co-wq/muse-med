import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { freezeMessage, MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createGenerationWatchNotice, deliverGenerationWatchNotice,
  registerGenerationWatchDelivery } from '../src/generation-watch-delivery.ts'
import { GenerationWatchOwnershipConflict, GenerationWatchStore, type GenerationWatchRun } from '../src/generation-watch-store.ts'

const roots: string[] = []
const hosts: Context[] = []
afterEach(async () => {
  for (const host of hosts.splice(0).reverse()) await host.fiber.dispose()
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(async root => rm(root, { recursive: true, force: true })))
})

async function checkpoint() {
  const root = await mkdtemp(join(tmpdir(), 'muse-generation-durability-'))
  roots.push(root)
  const store = new GenerationWatchStore(join(root, 'watches'))
  const run: GenerationWatchRun = { id: 'a'.repeat(64), sessionId: SessionId('original-owner'),
    createdAt: 0, deadlineAt: 100, packs: [{ key: 'b'.repeat(64), previewPath: join(root, 'original.json') }] }
  return { root, store, run, path: join(root, 'watches', `${run.id}.json`) }
}

it.each(['ownership.v2.json', 'ownership.v1.json'])('propagates a corrupt %s without replacing it or creating a watch', async (name) => {
  const f = await checkpoint(), directory = join(f.root, 'watches'), path = join(directory, name)
  await mkdir(directory, { recursive: true })
  const original = Buffer.from('{"truncated":')
  await writeFile(path, original)
  await expect(f.store.claimAndCreate(f.run)).rejects.toBeInstanceOf(SyntaxError)
  expect(await readFile(path)).toEqual(original)
  expect(await f.store.load(f.run.id)).toBeUndefined()
  const absent = join(directory, name === 'ownership.v2.json' ? 'ownership.v1.json' : 'ownership.v2.json')
  await expect(readFile(absent)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects an extra persisted key that is absent from its recorded run without rewriting either file', async () => {
  const f = await checkpoint()
  await f.store.claimAndCreate(f.run)
  expect(await f.store.mayObserve(f.run.id)).toBe(false)
  const indexPath = join(f.root, 'watches', 'ownership.v2.json')
  const originalIndex = await readFile(indexPath, 'utf8'), originalRun = await readFile(f.path)
  const index = z.looseObject({ keys: z.record(z.string(), z.unknown()) }).parse(JSON.parse(originalIndex))
  index.keys['c'.repeat(64)] = { runId: f.run.id, sessionId: f.run.sessionId, previewPath: f.run.packs[0]!.previewPath }
  const invalidIndex = JSON.stringify(index)
  await writeFile(indexPath, invalidIndex)
  await expect(f.store.mayObserve(f.run.id)).rejects.toBeInstanceOf(GenerationWatchOwnershipConflict)
  expect(await readFile(indexPath, 'utf8')).toBe(invalidIndex)
  expect(await readFile(f.path)).toEqual(originalRun)
  await writeFile(indexPath, originalIndex)
  expect(await f.store.mayObserve(f.run.id)).toBe(false)
  expect(await f.store.load(f.run.id)).toEqual(f.run)
})

it.each(['indexed-session', 'legacy-owner-run', 'legacy-owner-session', 'legacy-owner-preview', 'orphan-owner',
  'duplicate-pack', 'duplicate-started-key', 'unknown-started-key', 'no-send-after-start', 'non-no-send-successor',
  'successor-cycle', 'missing-successor', 'successor-session', 'successor-pack-count', 'successor-pack-identity'] as const)(
  'rejects a persisted %s relationship and resumes reading after the original index is restored', async (relationship) => {
    const f = await checkpoint()
    await f.store.claimAndCreate(f.run)
    const indexPath = join(f.root, 'watches', 'ownership.v2.json')
    const legacyPath = join(f.root, 'watches', 'ownership.v1.json')
    const originalIndex = await readFile(indexPath, 'utf8'), originalRun = await readFile(f.path)
    const originalLegacy = await readFile(legacyPath)
    const index = z.looseObject({
      keys: z.record(z.string(), z.looseObject({ runId: z.string(), sessionId: z.string(), previewPath: z.string() })),
      runs: z.record(z.string(), z.looseObject({ sessionId: z.string(),
        packs: z.array(z.looseObject({ key: z.string(), previewPath: z.string() })),
        startedKeys: z.array(z.string()), noSend: z.boolean(), successor: z.string().optional() })),
    }).parse(JSON.parse(originalIndex))
    const entry = index.runs[f.run.id]!, pack = f.run.packs[0]!, otherId = 'c'.repeat(64)
    if (relationship.startsWith('legacy-owner-')) {
      index.runs = Object.fromEntries(Object.entries(index.runs).filter(([id]) => id !== f.run.id))
    }
    switch (relationship) {
      case 'indexed-session': entry.sessionId = 'another-session'; break
      case 'legacy-owner-run': index.keys[pack.key]!.runId = otherId; break
      case 'legacy-owner-session': index.keys[pack.key]!.sessionId = 'another-session'; break
      case 'legacy-owner-preview': index.keys[pack.key]!.previewPath = join(f.root, 'other.json'); break
      case 'orphan-owner': index.keys[otherId] = { runId: otherId, sessionId: f.run.sessionId, previewPath: pack.previewPath }; break
      case 'duplicate-pack': index.runs[otherId] = { ...entry, packs: [...entry.packs, ...entry.packs] }; break
      case 'duplicate-started-key': entry.startedKeys = [pack.key, pack.key]; break
      case 'unknown-started-key': entry.startedKeys = [otherId]; break
      case 'no-send-after-start': entry.startedKeys = [pack.key]; entry.noSend = true; break
      case 'non-no-send-successor': entry.successor = otherId; break
      case 'successor-cycle': entry.noSend = true; entry.successor = f.run.id; break
      case 'missing-successor': entry.noSend = true; entry.successor = otherId; break
      case 'successor-session':
        entry.noSend = true; entry.successor = otherId
        index.runs[otherId] = { ...entry, sessionId: 'another-session', successor: undefined }; break
      case 'successor-pack-count':
        entry.noSend = true; entry.successor = otherId
        index.runs[otherId] = { ...entry, packs: [...entry.packs, ...entry.packs], successor: undefined }; break
      case 'successor-pack-identity':
        entry.noSend = true; entry.successor = otherId
        index.runs[otherId] = { ...entry, packs: [{ key: 'd'.repeat(64), previewPath: join(f.root, 'other.json') }],
          successor: undefined }; break
    }
    const invalidIndex = JSON.stringify(index)
    await writeFile(indexPath, invalidIndex)
    await expect(f.store.mayObserve(f.run.id)).rejects.toBeInstanceOf(GenerationWatchOwnershipConflict)
    expect(await readFile(indexPath, 'utf8')).toBe(invalidIndex)
    expect(await readFile(f.path)).toEqual(originalRun)
    expect(await readFile(legacyPath)).toEqual(originalLegacy)
    await writeFile(indexPath, originalIndex)
    expect(await f.store.mayObserve(f.run.id)).toBe(false)
    expect(await f.store.load(f.run.id)).toEqual(f.run)
  })

it('commits the same checkpoint after a public ownership claim without inventing a notice or changing its deadline', async () => {
  const f = await checkpoint()
  await f.store.claimOwnership(f.run)
  expect(await f.store.load(f.run.id)).toBeUndefined()
  await f.store.put(f.run)
  expect(await f.store.load(f.run.id)).toEqual(f.run)
  const restarted = new GenerationWatchStore(join(f.root, 'watches'))
  expect(await restarted.load(f.run.id)).toEqual(f.run)
  expect(await restarted.listActive()).toEqual([f.run])
})

it('keeps repeated same-key dispatch fences idempotent and refuses a later no-send claim', async () => {
  const f = await checkpoint(), key = f.run.packs[0]?.key
  if (key === undefined) throw new Error('Missing fixture preview key')
  await f.store.claimAndCreate(f.run)
  await f.store.markDispatchStarted(f.run.id, key)
  await f.store.markDispatchStarted(f.run.id, key)
  await expect(f.store.recordNoSend(f.run.id)).rejects.toThrow('ownership is ambiguous')
  expect(await f.store.hasNoSend(f.run.id)).toBe(false)
  expect(await f.store.load(f.run.id)).toEqual(f.run)
})

it('refuses a dispatch fence after a proven no-send receipt without rewriting the original checkpoint', async () => {
  const f = await checkpoint(), key = f.run.packs[0]?.key
  if (key === undefined) throw new Error('Missing fixture preview key')
  await f.store.claimAndCreate(f.run)
  await f.store.recordNoSend(f.run.id)
  const before = await readFile(f.path)
  await expect(f.store.markDispatchStarted(f.run.id, key)).rejects.toThrow('ownership is ambiguous')
  expect(await f.store.hasNoSend(f.run.id)).toBe(true)
  expect(await readFile(f.path)).toEqual(before)
})

it('rejects dispatch-state mutations for a missing run while retaining the registered original', async () => {
  const f = await checkpoint(), missing = 'c'.repeat(64)
  await f.store.create(f.run)
  const before = await readFile(f.path)
  await expect(f.store.markDispatchStarted(missing, 'b'.repeat(64))).rejects.toThrow('ownership is ambiguous')
  await expect(f.store.recordNoSend(missing)).rejects.toThrow('ownership is ambiguous')
  await expect(f.store.finishInitialDispatch(missing)).rejects.toThrow('ownership is ambiguous')
  expect(await f.store.load(missing)).toBeUndefined()
  expect(await f.store.load(f.run.id)).toEqual(f.run)
  expect(await readFile(f.path)).toEqual(before)
})

it('refuses changed preview metadata for an already registered run without replacing its original checkpoint', async () => {
  const f = await checkpoint()
  await f.store.claimAndCreate(f.run)
  const before = await readFile(f.path)
  const changed: GenerationWatchRun = { ...f.run,
    packs: f.run.packs.map(pack => ({ ...pack, previewPath: join(f.root, 'another.preview.json') })) }
  await expect(f.store.claimAndCreate(changed)).rejects.toThrow('Generation watch run inputs changed')
  expect(await f.store.load(f.run.id)).toEqual(f.run)
  expect(await readFile(f.path)).toEqual(before)
})

it('refuses a valid checkpoint stored under another run identity', async () => {
  const f = await checkpoint()
  await f.store.create(f.run)
  await writeFile(f.path, JSON.stringify({ ...f.run, id: 'c'.repeat(64) }))
  await expect(f.store.load(f.run.id)).rejects.toThrow('different run identifier')
  await expect(f.store.listActive()).rejects.toThrow('different run identifier')
})

it('reports non-file checkpoints and does not hide an unreadable storage root', async () => {
  const f = await checkpoint()
  await mkdir(f.path, { recursive: true })
  const report = vi.fn()
  await expect(f.store.listActive(report)).resolves.toEqual([])
  expect(report).toHaveBeenCalledExactlyOnceWith(f.run.id,
    expect.objectContaining({ message: 'Generation watch checkpoint must be a regular file' }))
  await expect(f.store.listActive()).rejects.toThrow('regular file')
  const fileRoot = join(f.root, 'root-is-file')
  await writeFile(fileRoot, 'not a directory')
  await expect(new GenerationWatchStore(fileRoot).listActive()).rejects.toThrow()
})

it('preserves published inputs, deadline, notice and recovery identities across rejected updates', async () => {
  const f = await checkpoint()
  const notice = createGenerationWatchNotice('Original task result')
  const recoveryNotice = createGenerationWatchNotice('One allowed recovery')
  const saved = { ...f.run, packs: [{ ...f.run.packs[0]!, outcome: { status: 'failed' as const, detail: 'Provider failed' } }],
    notice, recoveryNotice }
  await f.store.create(saved)
  await f.store.put(saved)
  const original = await readFile(f.path)
  for (const change of [
    { deadlineAt: 101 },
    { notice: { ...notice, id: randomUUID() } },
    { notice: { ...notice, text: 'Replaced result' } },
    { recoveryNotice: undefined },
    { recoveryNotice: { ...recoveryNotice, text: 'Replaced recovery' } },
  ]) {
    await expect(f.store.put({ ...saved, ...change })).rejects.toThrow(/changed/u)
    expect(await readFile(f.path)).toEqual(original)
  }
  expect(await f.store.load(f.run.id)).toEqual(saved)
})

it('refuses to publish a checkpoint that was never registered in the ownership index', async () => {
  const f = await checkpoint()
  await expect(f.store.put(f.run)).rejects.toThrow('ownership is ambiguous')
  await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
})

async function delivery(options: { projection?: boolean; controller?: boolean; wake?: boolean } = {}) {
  const ctx = new Context()
  hosts.push(ctx)
  await ctx.plugin(Sessions)
  await ctx.plugin(SessionProjections)
  const projection = options.projection !== false ? await registerGenerationWatchDelivery(ctx) : undefined
  const session = ctx.sessions.create(SessionId('notice-owner'))
  const inbox: { nextTurn: UserMessage[]; nextStep: UserMessage[] } = { nextTurn: [], nextStep: [] }
  const followup = vi.fn((message: UserMessage) => {
    inbox.nextTurn.push(message)
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] })
  })
  const agent = { session, inbox, followup, ...(options.wake === false ? {} : { wakePending: vi.fn(() => false) }), status: 'idle' }
  const resolveAgent = vi.fn(async () => ({ agent }))
  if (options.controller !== false) ctx.provide('sessionController', { resolveAgent } as never)
  const flush = vi.spyOn(ctx.sessions, 'flush').mockResolvedValue(true)
  const notice = createGenerationWatchNotice('Continue the existing verified result')
  const message = freezeMessage<UserMessage>({ id: MessageId(notice.id), role: 'user',
    content: [{ type: 'text', text: notice.text }],
    source: { kind: 'jubian-generation-watch', form: 'notice', summary: 'Verified result' } })
  return { ctx, session, agent, resolveAgent, followup, flush, notice, message, projection }
}

it('requires an owning Host controller and delivery projection before enqueuing work', async () => {
  const missingController = await delivery({ controller: false })
  await expect(deliverGenerationWatchNotice(missingController.ctx, missingController.session.id, missingController.notice,
    undefined, undefined, undefined, async () => true, missingController.projection))
    .rejects.toThrow('requires the Host session controller')
  const missingProjection = await delivery({ projection: false })
  await expect(deliverGenerationWatchNotice(missingProjection.ctx, missingProjection.session.id, missingProjection.notice,
    undefined, undefined, undefined, async () => true, missingProjection.projection))
    .rejects.toThrow('projection is not registered')
  expect(missingController.followup).not.toHaveBeenCalled()
  expect(missingProjection.followup).not.toHaveBeenCalled()
})

it('propagates owner resolution failure without creating a new Session or inbox message', async () => {
  const f = await delivery({ controller: false })
  const error = new Error('Original Session is unavailable')
  f.ctx.provide('sessionController', { resolveAgent: vi.fn(async () => ({ error })) } as never)
  await expect(deliverGenerationWatchNotice(f.ctx, f.session.id, f.notice, undefined, undefined, undefined, async () => true, f.projection))
    .rejects.toBe(error)
  expect(f.followup).not.toHaveBeenCalled()
  expect(f.flush).not.toHaveBeenCalled()
})

it('requires a resumable inbox for an already queued notice and does not enqueue it twice', async () => {
  const f = await delivery({ wake: false })
  f.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [f.message] })
  await expect(deliverGenerationWatchNotice(f.ctx, f.session.id, f.notice, undefined, undefined, undefined, async () => true, f.projection)).rejects.toThrow('resumable Agent inbox')
  expect(f.followup).not.toHaveBeenCalled()
})

it('leaves a notice pending when it is in the next-step inbox', async () => {
  const f = await delivery()
  f.agent.inbox.nextStep.push(f.message)
  f.session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [f.message] })
  await expect(deliverGenerationWatchNotice(f.ctx, f.session.id, f.notice, undefined, undefined, undefined, async () => true, f.projection)).resolves.toBe('pending')
  expect(f.followup).not.toHaveBeenCalled()
  expect(f.flush).toHaveBeenCalledOnce()
})

it('does not acknowledge a notice when durable inbox persistence fails', async () => {
  const f = await delivery()
  f.flush.mockResolvedValue(false)
  await expect(deliverGenerationWatchNotice(f.ctx, f.session.id, f.notice, undefined, undefined, undefined, async () => true, f.projection)).rejects.toThrow('persistence did not acknowledge')
  expect(f.followup).toHaveBeenCalledOnce()
})

it('returns review-required when the Host did not actually queue the requested continuation', async () => {
  const f = await delivery()
  f.followup.mockImplementation(() => {})
  await expect(deliverGenerationWatchNotice(f.ctx, f.session.id, f.notice, undefined, undefined, undefined, async () => true, f.projection)).resolves.toBe('needs-review')
  expect(f.flush).toHaveBeenCalledOnce()
})

it.each(['user', 'disposed'] as const)('distinguishes %s cancellation from successful continuation', async (kind) => {
  const f = await delivery()
  f.session.append('turn/start', { turn: 1 })
  f.session.append('user/message', f.message, { surfaceOp: 'append' })
  f.session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind } } })
  await expect(deliverGenerationWatchNotice(f.ctx, f.session.id, f.notice, undefined, undefined, undefined, async () => true, f.projection))
    .resolves.toBe(kind === 'disposed' ? 'interrupted' : 'needs-review')
  expect(f.followup).not.toHaveBeenCalled()
})

it('does not wake a restored durable notice until the original binding is verified again', async () => {
  const f = await delivery()
  f.agent.inbox.nextTurn.push(f.message)
  f.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [f.message] })
  f.session.append('turn/start', { turn: 1 })
  f.session.append('agent/inbox/claim', { turn: 1, step: 1, nextStep: [], nextTurn: [f.message.id] })
  f.session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'model changed' } } })
  const unchanged = vi.fn(async () => false)
  await expect(deliverGenerationWatchNotice(f.ctx, f.session.id, f.notice, undefined, undefined, undefined,
    async () => true, f.projection, unchanged)).resolves.toBe('pending')
  expect(unchanged).toHaveBeenCalledOnce()
  expect(f.agent.wakePending).not.toHaveBeenCalled()
  expect(f.followup).not.toHaveBeenCalled()
  const restored = vi.fn(async () => true)
  await expect(deliverGenerationWatchNotice(f.ctx, f.session.id, f.notice, undefined, undefined, undefined,
    async () => true, f.projection, restored)).resolves.toBe('pending')
  expect(restored).toHaveBeenCalledOnce()
  expect(f.agent.wakePending).toHaveBeenCalledExactlyOnceWith(f.message.id)
  expect(f.followup).not.toHaveBeenCalled()
})

it('marks a durable notice unknown when the turn is interrupted after user/message', async () => {
  const f = await delivery()
  f.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [f.message] })
  f.session.append('turn/start', { turn: 1 })
  f.session.append('agent/inbox/claim', { turn: 1, step: 1, nextStep: [], nextTurn: [f.message.id] })
  f.session.append('step/start', { turn: 1, step: 1 })
  f.session.append('user/message', f.message, { surfaceOp: 'append' })
  f.session.append('agent/inbox/claim-settled', { turn: 1, step: 1 })
  f.session.append('step/end', { turn: 1, step: 1 })
  f.session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } })
  await expect(deliverGenerationWatchNotice(f.ctx, f.session.id, f.notice, undefined, undefined, undefined,
    async () => true, f.projection, async () => true)).resolves.toBe('unknown')
  expect(f.followup).not.toHaveBeenCalled()
  expect(f.agent.wakePending).not.toHaveBeenCalled()
})

it('checks the binding before waking a queued notice after a lost guard record', async () => {
  const f = await delivery()
  f.agent.inbox.nextTurn.push(f.message)
  f.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [f.message] })
  const check = vi.fn(async () => false)
  await expect(deliverGenerationWatchNotice(f.ctx, f.session.id, f.notice, undefined, undefined, undefined,
    async () => true, f.projection, check)).resolves.toBe('pending')
  expect(check).toHaveBeenCalledOnce()
  expect(f.agent.wakePending).not.toHaveBeenCalled()
  expect(f.followup).not.toHaveBeenCalled()
})
