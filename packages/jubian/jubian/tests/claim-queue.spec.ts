import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import * as AtomicWrite from '@deepseek-ai/dsh-atomic-write'
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
      await Promise.race([entered.promise, first])
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
    // This case tests the in-process queue key. The native lock and path rules
    // belong to the actual filesystem, whose platform is not changed by this stub.
    const lock = vi.spyOn(AtomicWrite, 'withFileLock').mockImplementation(async (_path, run) => await run())
    onTestFinished(() => { lock.mockRestore() })
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const events: string[] = []
    let first: Promise<void> | undefined, second: Promise<void> | undefined
    try {
      Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' })
      first = withLedgerQueue(join(root, 'LEDGER'), async () => {
        events.push('first entered'); entered.resolve(undefined); await release.promise; events.push('first finished')
      })
      await Promise.race([entered.promise, first])
      second = withLedgerQueue(join(root, 'ledger'), async () => { events.push('second entered') })
      // An independent queue drains runnable operations while the first remains blocked.
      await withLedgerQueue(join(root, 'sentinel'), async () => {})
      expect(events).toEqual(['first entered'])
      release.resolve(undefined); await Promise.all([first, second])
      expect(events).toEqual(['first entered', 'first finished', 'second entered'])
    } finally {
      release.resolve(undefined); await Promise.allSettled([...(first ? [first] : []), ...(second ? [second] : [])])
      Object.defineProperty(process, 'platform', descriptor)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps differently cased POSIX ledger operations independent', async () => {
    const root = await mkdtemp(join(tmpdir(), `Ledger-${randomUUID()}`))
    const lock = vi.spyOn(AtomicWrite, 'withFileLock').mockImplementation(async (_path, run) => await run())
    onTestFinished(() => { lock.mockRestore() })
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const events: string[] = []
    let first: Promise<void> | undefined, second: Promise<void> | undefined
    try {
      Object.defineProperty(process, 'platform', { ...descriptor, value: 'linux' })
      first = withLedgerQueue(join(root, 'LEDGER'), async () => {
        events.push('first entered'); entered.resolve(undefined); await release.promise; events.push('first finished')
      })
      await Promise.race([entered.promise, first])
      second = withLedgerQueue(join(root, 'ledger'), async () => { events.push('second entered') })
      await expect.poll(() => events).toContain('second entered')
      expect(events).not.toContain('first finished')
    } finally {
      release.resolve(undefined); await Promise.allSettled([...(first ? [first] : []), ...(second ? [second] : [])])
      Object.defineProperty(process, 'platform', descriptor)
      await rm(root, { recursive: true, force: true })
    }
  })
})
