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

async function delivery(options: { projection?: boolean; controller?: boolean; wake?: boolean } = {}) {
  const ctx = new Context()
  hosts.push(ctx)
  await ctx.plugin(Sessions)
  await ctx.plugin(SessionProjections)
  if (options.projection !== false) registerGenerationWatchDelivery(ctx)
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
  return { ctx, session, agent, resolveAgent, followup, flush, notice, message }
}

it('requires an owning Host controller and delivery projection before enqueuing work', async () => {
  const missingController = await delivery({ controller: false })
  await expect(deliverGenerationWatchNotice(missingController.ctx, missingController.session.id, missingController.notice))
    .rejects.toThrow('requires the Host session controller')
  const missingProjection = await delivery({ projection: false })
  await expect(deliverGenerationWatchNotice(missingProjection.ctx, missingProjection.session.id, missingProjection.notice))
    .rejects.toThrow('projection is not registered')
  expect(missingController.followup).not.toHaveBeenCalled()
  expect(missingProjection.followup).not.toHaveBeenCalled()
})

it('propagates owner resolution failure without creating a new Session or inbox message', async () => {
  const f = await delivery({ controller: false })
  const error = new Error('Original Session is unavailable')
  f.ctx.provide('sessionController', { resolveAgent: vi.fn(async () => ({ error })) } as never)
  await expect(deliverGenerationWatchNotice(f.ctx, f.session.id, f.notice)).rejects.toBe(error)
  expect(f.followup).not.toHaveBeenCalled()
  expect(f.flush).not.toHaveBeenCalled()
})

it('requires a resumable inbox for an already queued notice and does not enqueue it twice', async () => {
  const f = await delivery({ wake: false })
  f.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [f.message] })
  await expect(deliverGenerationWatchNotice(f.ctx, f.session.id, f.notice)).rejects.toThrow('resumable Agent inbox')
  expect(f.followup).not.toHaveBeenCalled()
})

it('leaves a notice pending when it is in the next-step inbox', async () => {
  const f = await delivery()
  f.agent.inbox.nextStep.push(f.message)
  f.session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [f.message] })
  await expect(deliverGenerationWatchNotice(f.ctx, f.session.id, f.notice)).resolves.toBe('pending')
  expect(f.followup).not.toHaveBeenCalled()
  expect(f.flush).toHaveBeenCalledOnce()
})

it('does not acknowledge a notice when durable inbox persistence fails', async () => {
  const f = await delivery()
  f.flush.mockResolvedValue(false)
  await expect(deliverGenerationWatchNotice(f.ctx, f.session.id, f.notice)).rejects.toThrow('persistence did not acknowledge')
  expect(f.followup).toHaveBeenCalledOnce()
})

it('returns review-required when the Host did not actually queue the requested continuation', async () => {
  const f = await delivery()
  f.followup.mockImplementation(() => {})
  await expect(deliverGenerationWatchNotice(f.ctx, f.session.id, f.notice)).resolves.toBe('needs-review')
  expect(f.flush).toHaveBeenCalledOnce()
})

it.each(['user', 'disposed'] as const)('distinguishes %s cancellation from successful continuation', async (kind) => {
  const f = await delivery()
  f.session.append('turn/start', { turn: 1 })
  f.session.append('user/message', f.message, { surfaceOp: 'append' })
  f.session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind } } })
  await expect(deliverGenerationWatchNotice(f.ctx, f.session.id, f.notice))
    .resolves.toBe(kind === 'disposed' ? 'interrupted' : 'needs-review')
  expect(f.followup).not.toHaveBeenCalled()
})
