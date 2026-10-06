import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { withLedgerQueue } from '../src/claim-queue.ts'

describe('ledger operation queue', () => {
  it('keeps a following operation behind a rejected reservation and releases the queue afterward', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jubian-queue-'))
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const failure = new Error('reservation denied'), events: string[] = []
    const first = withLedgerQueue(root, async () => {
      events.push('first entered'); entered.resolve(undefined)
      await release.promise
      events.push('first rejected'); throw failure
    }).catch((error: unknown) => error)
    let second: Promise<string> | undefined
    try {
      await entered.promise
      second = withLedgerQueue(root, async () => { events.push('second entered'); return 'saved' })
      release.resolve(undefined)
      expect(await first).toBe(failure)
      expect(await second).toBe('saved')
      expect(events).toEqual(['first entered', 'first rejected', 'second entered'])
      expect(await withLedgerQueue(root, async () => 'next')).toBe('next')
    } finally {
      release.resolve(undefined); await Promise.allSettled([first, ...(second ? [second] : [])])
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses one Windows queue for ledger paths with different casing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jubian-queue-'))
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const events: string[] = []
    let first: Promise<void> | undefined, second: Promise<void> | undefined
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      first = withLedgerQueue(root.toUpperCase(), async () => {
        events.push('first entered'); entered.resolve(undefined); await release.promise; events.push('first finished')
      })
      await entered.promise
      second = withLedgerQueue(root.toLowerCase(), async () => { events.push('second entered') })
      release.resolve(undefined); await Promise.all([first, second])
      expect(events).toEqual(['first entered', 'first finished', 'second entered'])
    } finally {
      release.resolve(undefined); await Promise.allSettled([...(first ? [first] : []), ...(second ? [second] : [])])
      Object.defineProperty(process, 'platform', descriptor)
      await rm(root, { recursive: true, force: true })
    }
  })
})
