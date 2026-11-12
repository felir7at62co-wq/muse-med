import { mkdtemp, rm } from 'node:fs/promises'
import * as files from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import * as atomicWrite from '@deepseek-ai/dsh-atomic-write'
import { withLedgerQueue } from '../src/claim-queue.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, mkdir: vi.fn(actual.mkdir) }
})
vi.mock('@deepseek-ai/dsh-atomic-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-atomic-write')>()
  return { ...actual, withFileLock: vi.fn(actual.withFileLock) }
})

/** Test queue keys without the host filesystem's own case and locking rules. */
function isolateQueueKeys(): () => void {
  const mkdir = vi.mocked(files.mkdir)
  const lock = vi.mocked(atomicWrite.withFileLock)
  const originalMkdir = mkdir.getMockImplementation()!
  const originalLock = lock.getMockImplementation()!
  mkdir.mockResolvedValue(undefined)
  lock.mockImplementation(async <T>(
    _filename: string, operation: () => Promise<T>,
  ): Promise<T> => await operation())
  return () => {
    lock.mockImplementation(originalLock).mockClear()
    mkdir.mockImplementation(originalMkdir).mockClear()
  }
}

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
    const restoreFilesystem = isolateQueueKeys()
    try {
      Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' })
      first = withLedgerQueue(join(root, 'LEDGER'), async () => {
        events.push('first entered'); entered.resolve(undefined); await release.promise; events.push('first finished')
      })
      await Promise.race([entered.promise, first])
      second = withLedgerQueue(join(root, 'ledger'), async () => { events.push('second entered') })
      // The independent queue drains earlier runnable operations without releasing the first.
      await withLedgerQueue(join(root, 'sentinel'), async () => {})
      expect(events).toEqual(['first entered'])
      release.resolve(undefined); await Promise.all([first, second])
      expect(events).toEqual(['first entered', 'first finished', 'second entered'])
    } finally {
      release.resolve(undefined); await Promise.allSettled([...(first ? [first] : []), ...(second ? [second] : [])])
      Object.defineProperty(process, 'platform', descriptor)
      restoreFilesystem()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps differently cased POSIX ledger operations independent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jubian-queue-'))
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const events: string[] = []
    let first: Promise<void> | undefined, second: Promise<void> | undefined
    const restoreFilesystem = isolateQueueKeys()
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
      restoreFilesystem()
      await rm(root, { recursive: true, force: true })
    }
  })
})
