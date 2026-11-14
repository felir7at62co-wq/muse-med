import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as atomic from '@deepseek-ai/dsh-atomic-write'
import { describe, expect, it, vi } from 'vitest'
import { withLedgerQueue } from '../src/claim-queue.ts'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))

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
    const root = join(tmpdir(), `Ledger-${randomUUID()}`)
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const events: string[] = []
    let first: Promise<void> | undefined, second: Promise<void> | undefined
    const directory = vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined)
    const lock = vi.spyOn(atomic, 'withFileLock').mockImplementation((_filename, operation) => operation())
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      first = withLedgerQueue(root.toUpperCase(), async () => {
        events.push('first entered'); entered.resolve(undefined); await release.promise; events.push('first finished')
      })
      await Promise.race([entered.promise, first])
      second = withLedgerQueue(root.toLowerCase(), async () => { events.push('second entered') })
      await withLedgerQueue(`${root}-independent`, async () => {})
      expect(events).toEqual(['first entered'])
      release.resolve(undefined); await Promise.all([first, second])
      expect(events).toEqual(['first entered', 'first finished', 'second entered'])
    } finally {
      release.resolve(undefined); await Promise.allSettled([...(first ? [first] : []), ...(second ? [second] : [])])
      Object.defineProperty(process, 'platform', descriptor)
      lock.mockRestore(); directory.mockRestore()
    }
  })

  it('keeps differently cased POSIX ledger operations independent', async () => {
    const root = join(tmpdir(), `Ledger-${randomUUID()}`)
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const events: string[] = []
    let first: Promise<void> | undefined, second: Promise<void> | undefined
    const directory = vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined)
    const lock = vi.spyOn(atomic, 'withFileLock').mockImplementation((_filename, operation) => operation())
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'linux' })
    try {
      first = withLedgerQueue(root.toUpperCase(), async () => {
        events.push('first entered'); entered.resolve(undefined); await release.promise; events.push('first finished')
      })
      await Promise.race([entered.promise, first])
      second = withLedgerQueue(root.toLowerCase(), async () => { events.push('second entered') })
      await expect.poll(() => events).toContain('second entered')
      expect(events).not.toContain('first finished')
    } finally {
      release.resolve(undefined); await Promise.allSettled([...(first ? [first] : []), ...(second ? [second] : [])])
      Object.defineProperty(process, 'platform', descriptor)
      lock.mockRestore(); directory.mockRestore()
    }
  })
})
