import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { freezeMessage, MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { afterEach, expect, it, vi } from 'vitest'
import { createGenerationWatchNotice, deliverGenerationWatchNotice, registerGenerationWatchDelivery } from '../src/generation-watch-delivery.ts'
import { GenerationWatchStore, type GenerationWatchRun } from '../src/generation-watch-store.ts'

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
  expect(report).toHaveBeenCalledExactlyOnceWith(f.run.id, expect.objectContaining({ message: 'Generation watch checkpoint must be a regular file' }))
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

it('tracks parked and filtered durable notices without changing unrelated messages', async () => {
  const f = await delivery()
  const ordinary = freezeMessage<UserMessage>({ ...f.message, id: MessageId(randomUUID()), source: { kind: 'user' } })
  f.session.append('jubian/generation-notice-parked', { id: f.notice.id })
  expect(f.projection?.stateOf(f.session).notices).toEqual({})
  f.session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [f.message, ordinary] })
  f.session.append('jubian/generation-notice-parked', { id: f.notice.id })
  f.session.append('jubian/generation-notice-parked', { id: f.notice.id })
  expect(f.projection?.stateOf(f.session).notices[f.notice.id]).toBe('guard-rejected')
  f.session.append('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] })
  f.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [f.message] })
  f.session.append('turn/start', { turn: 1 })
  f.session.append('agent/inbox/claim', { turn: 1, step: 1, nextStep: [ordinary.id], nextTurn: [f.message.id] })
  f.session.append('agent/inbox/claim-filtered', { turn: 1, step: 1, discarded: [f.message.id, ordinary.id] })
  f.session.append('agent/inbox/claim-settled', { turn: 1, step: 1 })
  expect(f.projection?.stateOf(f.session)).toMatchObject({ notices: { [f.notice.id]: 'needs-review' }, durableClaim: null })
})

it.each(['duplicate', 'step-length', 'turn-length', 'step-order', 'turn-order', 'filter-missing',
  'filter-turn', 'settle-missing', 'settle-turn', 'settle-step', 'settle-turn-message', 'splice-start',
  'splice-count', 'splice-end'] as const)('rejects inconsistent persisted inbox history: %s', async (fault) => {
  const f = await delivery()
  const queued = (target: 'next-step' | 'next-turn') => {
    f.session.append('agent/inbox/spliced', { target, start: 0, inserted: [f.message] })
  }
  const claim = (nextStep: MessageId[], nextTurn: MessageId[], turn = 1) => {
    f.session.append('agent/inbox/claim', { turn, step: 1, nextStep, nextTurn })
  }
  if (fault === 'duplicate') { claim([], []); claim([], []) }
  if (fault === 'step-length') claim([f.message.id], [])
  if (fault === 'turn-length') claim([], [f.message.id])
  if (fault === 'step-order') { queued('next-step'); claim([MessageId(randomUUID())], []) }
  if (fault === 'turn-order') { queued('next-turn'); claim([], [MessageId(randomUUID())]) }
  if (fault === 'filter-missing' || fault === 'filter-turn') {
    if (fault === 'filter-turn') claim([], [])
    f.session.append('agent/inbox/claim-filtered', { turn: 2, step: 1, discarded: [] })
  }
  if (fault.startsWith('settle-')) {
    if (fault === 'settle-turn') claim([], [])
    if (fault === 'settle-step') { queued('next-step'); claim([f.message.id], []) }
    if (fault === 'settle-turn-message') { queued('next-turn'); claim([], [f.message.id]) }
    f.session.append('agent/inbox/claim-settled', { turn: fault === 'settle-turn' ? 2 : 1, step: 1 })
  }
  if (fault.startsWith('splice-')) f.session.append('agent/inbox/spliced', {
    target: 'next-turn', start: fault === 'splice-start' ? -1 : 0,
    removedCount: fault === 'splice-count' ? -1 : fault === 'splice-end' ? 1 : 0, inserted: [],
  })
  expect(() => f.projection?.stateOf(f.session)).toThrow(/Generation watch|Invalid inbox/u)
})

it('retains a later turn claim and leaves an ordinary model failure available for review', async () => {
  const f = await delivery()
  f.session.append('turn/start', { turn: 2 })
  f.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [f.message] })
  f.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
  f.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  expect(f.projection?.stateOf(f.session).claimed).toEqual({ [f.message.id]: 2 })
  f.session.append('turn/end', { turn: 2, reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'provider unavailable' } } })
  expect(f.projection?.stateOf(f.session)).toMatchObject({ notices: { [f.message.id]: 'queued' }, claimed: {} })
})

it('rechecks ownership after a resumable queued binding is restored', async () => {
  const f = await delivery()
  f.agent.inbox.nextTurn.push(f.message)
  f.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [f.message] })
  const verify = vi.fn(async () => true).mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false)
  await expect(deliverGenerationWatchNotice(f.ctx, f.session.id, f.notice, undefined, undefined, undefined,
    verify, f.projection, async () => true)).resolves.toBe('needs-review')
  expect(verify).toHaveBeenCalledTimes(3)
  expect(f.agent.wakePending).not.toHaveBeenCalled()
  expect(f.followup).not.toHaveBeenCalled()
  expect(f.flush).not.toHaveBeenCalled()
})

it('refuses a controller result that names a different original Session', async () => {
  const f = await delivery()
  await expect(deliverGenerationWatchNotice(f.ctx, SessionId('different-owner'), f.notice, undefined, undefined, undefined,
    async () => true, f.projection)).resolves.toBe('needs-review')
  expect(f.followup).not.toHaveBeenCalled()
  expect(f.flush).not.toHaveBeenCalled()
})
