import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { expect, it, vi } from 'vitest'
import { createGenerationWatchNotice, deliverGenerationWatchNotice, registerGenerationWatchDelivery } from '../src/generation-watch-delivery.ts'
import { GenerationWatchStore, type GenerationWatchRun } from '../src/generation-watch-store.ts'

const groupOrigin = { roomId: 'group', workerBotId: 'video', requesterBotId: 'coordinator',
  requesterSessionId: 'coordinator-in-group', exchangeId: 'original-assignment' }

it('resumes the original deadline and a pending terminal outbox across Host instances', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-generation-watch-'))
  try {
    const first = new GenerationWatchStore(root)
    const run: GenerationWatchRun = { id: 'a'.repeat(64), sessionId: SessionId('original-owner'), groupOrigin, createdAt: 10, deadlineAt: 100,
      packs: [{ previewPath: join(root, 'video.preview.json'), key: 'b'.repeat(64) }] }
    await expect(first.listActive()).resolves.toEqual([])
    await expect(first.create(run)).resolves.toEqual(run)
    const claimed: GenerationWatchRun = { ...run, packs: [{ ...run.packs[0]!, taskId: 42 }] }
    await first.put(claimed)
    const restored = new GenerationWatchStore(root)
    await expect(restored.create({ ...run, createdAt: 50, deadlineAt: 150 })).resolves.toEqual(claimed)
    const otherOrigin = { ...groupOrigin, requesterBotId: 'another-coordinator' }
    await expect(restored.create({ ...run, groupOrigin: otherOrigin })).resolves.toEqual(claimed)
    await expect(restored.put({ ...claimed, groupOrigin: otherOrigin })).rejects.toThrow('group assignment changed')
    await expect(restored.listActive()).resolves.toEqual([claimed])
    const damagedId = 'c'.repeat(64)
    const damaged = join(root, `${damagedId}.json`)
    await writeFile(damaged, '{"truncated":', 'utf8')
    const onUnreadable = vi.fn()
    await expect(restored.listActive(onUnreadable)).resolves.toEqual([claimed])
    expect(onUnreadable).toHaveBeenCalledExactlyOnceWith(damagedId, expect.any(SyntaxError))
    await rm(damaged)
    await expect(restored.load('../outside')).rejects.toThrow()
    await expect(restored.create({ ...run, sessionId: SessionId('another-owner') })).rejects.toThrow('inputs changed')

    const terminal: GenerationWatchRun = { ...claimed,
      packs: [{ ...claimed.packs[0]!, outcome: { status: 'failed', detail: 'Provider failed task 42' } }],
      notice: createGenerationWatchNotice('Task 42 failed') }
    await restored.put(terminal)
    const beforeAck = new GenerationWatchStore(root)
    await expect(beforeAck.listActive()).resolves.toEqual([terminal])
    await beforeAck.put({ ...terminal, notice: { ...terminal.notice!, deliveredAt: 75 } })
    const afterAck = new GenerationWatchStore(root)
    await expect(afterAck.listActive()).resolves.toEqual([])
    await expect(afterAck.put(terminal)).rejects.toThrow('delivery receipt changed')
  } finally { await rm(root, { recursive: true, force: true }) }
})

async function deliveryHost(seed?: readonly SessionEvent[]) {
  const ctx = new Context()
  await ctx.plugin(Sessions)
  await ctx.plugin(SessionProjections)
  const projection = await registerGenerationWatchDelivery(ctx)
  const session = ctx.sessions.create(SessionId('production-owner'), seed === undefined ? undefined : { seed: [...seed] })
  const inbox: { nextTurn: UserMessage[]; nextStep: UserMessage[] } = { nextTurn: [], nextStep: [] }
  const followup = vi.fn((message: UserMessage) => {
    inbox.nextTurn.push(message)
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] })
  })
  const wakePending = vi.fn(() => false)
  const resolveAgent = vi.fn(async () => ({ agent: { session, followup, inbox, wakePending } }))
  ctx.provide('sessionController', { resolveAgent } as never)
  return { ctx, session, resolveAgent, followup, projection }
}

it('reconciles a flushed notice after the inbox claims it and the Host restarts', async () => {
  const first = await deliveryHost()
  const notice = createGenerationWatchNotice('Verified task 42; continue using its current output')
  const events = await (async () => {
    try {
      // The Session write can succeed while its caller observes a failure before the outbox receipt.
      const flush = vi.fn(async () => { throw new Error('Lost durability acknowledgement') })
      first.ctx.on('session/flush', flush)
      await expect(deliverGenerationWatchNotice(first.ctx, first.session.id, notice, undefined, groupOrigin))
        .rejects.toThrow('Archived Bot group notices require manual ownership review')
      expect(first.followup).not.toHaveBeenCalled()
      await expect(deliverGenerationWatchNotice(first.ctx, first.session.id, notice,
        undefined, undefined, undefined, async () => true, first.projection))
        .rejects.toThrow('Lost durability acknowledgement')
      expect(first.followup).toHaveBeenCalledOnce()
      expect(first.followup.mock.calls[0]![0]).toMatchObject({ id: notice.id,
        source: { kind: 'jubian-generation-watch' } })
      first.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
      return first.session.snapshotEvents()
    } finally { await first.ctx.fiber.dispose() }
  })()
  const restored = await deliveryHost(events)
  try {
    const flush = vi.fn(async () => {})
    restored.ctx.on('session/flush', flush)
    await deliverGenerationWatchNotice(restored.ctx, restored.session.id, notice,
      undefined, undefined, undefined, async () => true, restored.projection)
    expect(restored.resolveAgent).toHaveBeenCalledWith(restored.session.id)
    expect(restored.followup).not.toHaveBeenCalled()
    expect(flush).toHaveBeenCalledOnce()
  } finally { await restored.ctx.fiber.dispose() }
})
