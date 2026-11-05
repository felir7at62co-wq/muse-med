/** Cross-process encoder admission and durable range-proof regressions. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { runWithEncoderGate } from '../src/episode-guardian-fence.ts'
import type { GuardianJournal, ExecutionDrain, ExecutionIdentity } from '../src/episode-guardian-fence.ts'
import { createGuardianJournal, guardianParsers } from '../src/episode-guardian-journal.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) =>{  await rm(root, { recursive: true, force: true }) })) })
const identity = (last: number): ExecutionIdentity => guardianParsers.parseRequest({ version: 1, kind: 'run', identity: {
  attempt: '00000000-0000-4000-8000-000000000001', execution: `00000000-0000-4000-8000-${String(last).padStart(12, '0')}`,
  rendererGeneration: '00000000-0000-4000-8000-000000000002', planSha256: 'a'.repeat(64),
  projectSha256: 'b'.repeat(64), configurationSha256: 'c'.repeat(64), descriptorSha256: 'd'.repeat(64),
} }).identity
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-guardian-fence-')); roots.push(root)
  let admissions = 0, armed = 0, rendered = 0, joined = 0
  const journal = createGuardianJournal({ attemptRoot: root, recordBytes: 4096,
    assertAdmission: async () => { admissions++ }, armExecution: async () => { armed++ } })
  const invoke = (value: ExecutionIdentity, options: {
    journal?: GuardianJournal
    retry?: 'initial' | 'host-disconnect-recovery' | 'explicit-retry'
    signal?: AbortSignal
    completes?: boolean
    unknown?: boolean
  } = {}) => runWithEncoderGate({ journal: options.journal ?? journal, identity: value,
    signal: options.signal ?? new AbortController().signal, lockWaitMs: 1000, retry: options.retry ?? 'explicit-retry',
    media: { stopAndJoin: async () => { joined++; return options.unknown
      ? { kind: 'unknown', diagnostic: 'range observation rejected' } : { kind: 'empty', commands: 1 } } },
    render: async () => { rendered++; if (!options.completes) throw new Error('controlled failure')
      return { outputSha256: value.planSha256, outputBytes: 1 } },
  })
  return { root, journal, invoke, counts: () => [admissions, armed, rendered, joined] }
}

it('rejects any historical execution UUID before admission or render after three failed executions', async () => {
  const f = await fixture()
  for (const n of [3, 4, 5]) expect(await f.invoke(identity(n))).toMatchObject({ kind: 'drained', proof: { result: 'failed' } })
  const before = await readFile(join(f.root, 'execution.json'))
  for (const n of [3, 4]) {
    let failure: unknown
    try { await f.invoke(identity(n), { completes: true }) } catch (error) { failure = error }
    expect(f.counts(), 'historical UUID must refuse before admission, arm, render and join').toEqual([3, 3, 3, 3])
    expect(failure).toBeInstanceOf(Error)
    expect(failure).toHaveProperty('message', 'episode guardian: execution UUID already has a drain record')
  }
  await expect(f.invoke(identity(5))).rejects.toThrow('cannot be reused')
  expect(f.counts()).toEqual([3, 3, 3, 3])
  expect(await readFile(join(f.root, 'execution.json'))).toEqual(before)
  expect(await f.invoke(identity(6), { completes: true })).toMatchObject({ kind: 'drained', proof: { result: 'completed' } })
  expect(await f.invoke(identity(3))).toMatchObject({ kind: 'reconcile', proof: { identity: { execution: identity(6).execution } } })
  expect(f.counts()).toEqual([4, 4, 4, 4])
})

it('refuses an occupied UUID without a running record and rejects malformed occupied proof', async () => {
  const f = await fixture(), value = identity(3)
  await f.journal.publishDrain({ version: 1, kind: 'drained', identity: value, guardianPid: process.pid, commands: 0, result: 'failed' })
  await expect(f.invoke(value)).rejects.toThrow('already has a drain record')
  await writeFile(join(f.root, `drained-${value.execution}.json`), '{broken')
  await expect(f.invoke(value)).rejects.toThrow()
  expect(f.counts()).toEqual([0, 0, 0, 0])
})

it('keeps an unproven previous execution unknown even when lock ownership is available', async () => {
  const f = await fixture()
  await f.journal.writeRunning({ version: 1, kind: 'running', identity: identity(3), guardianPid: process.pid })
  expect(await f.invoke(identity(4))).toMatchObject({ kind: 'unknown', previous: { identity: identity(3) } })
  expect(f.counts()).toEqual([0, 1, 0, 0])
})

it('requires matching attempt, exact proof identity and guardian PID', async () => {
  const f = await fixture(), first = identity(3)
  await f.invoke(first)
  await expect(f.invoke({ ...identity(4), projectSha256: identity(4).planSha256 })).rejects.toThrow('attempt journal identity changed')
  const proof = await f.journal.readDrain(first.execution)
  if (proof === undefined) throw new Error('missing controlled proof')
  const wrong: ExecutionDrain = { ...proof, guardianPid: process.pid + 1 }
  await expect(f.invoke(identity(4), { journal: { ...f.journal, readDrain: async () => wrong } })).rejects.toThrow('does not match')
  expect(f.counts()).toEqual([1, 1, 1, 1])
})

it('permits disconnect recovery only after cancelled proof and requires explicit retry after failure', async () => {
  const f = await fixture(), first = identity(3)
  await f.invoke(first)
  expect(await f.invoke(identity(4), { retry: 'initial' })).toMatchObject({ kind: 'retry-required' })
  expect(await f.invoke(identity(4), { retry: 'host-disconnect-recovery' })).toMatchObject({ kind: 'retry-required' })
  const cancelled: ExecutionDrain = { version: 1, kind: 'drained', identity: first, guardianPid: process.pid, commands: 1, result: 'cancelled' }
  const journal = { ...f.journal, readDrain: async (id: typeof first.execution) => id === first.execution ? cancelled : undefined }
  expect(await f.invoke(identity(4), { journal, retry: 'host-disconnect-recovery', completes: true })).toMatchObject({ kind: 'drained' })
})

it('does not publish proof when the managed media range is unknown', async () => {
  const f = await fixture(), value = identity(3)
  expect(await f.invoke(value, { unknown: true, completes: true })).toMatchObject({ kind: 'unknown' })
  expect(await f.journal.readDrain(value.execution)).toBeUndefined()
  expect(await f.invoke(identity(4))).toMatchObject({ kind: 'unknown' })
  expect(f.counts()).toEqual([1, 1, 1, 1])
})

it('cancels before first render when EOF arrives while running is being armed', async () => {
  const f = await fixture(), controller = new AbortController()
  const journal = { ...f.journal, writeRunning: async (record: Parameters<GuardianJournal['writeRunning']>[0]) => {
    await f.journal.writeRunning(record); controller.abort()
  } }
  expect(await f.invoke(identity(3), { journal, signal: controller.signal })).toMatchObject({ kind: 'drained', proof: { result: 'cancelled' } })
  expect(f.counts()).toEqual([1, 1, 0, 1])
})

it('holds the real encoder gate through media joining and proof publication', async () => {
  const f = await fixture(), reached = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const first = runWithEncoderGate({ journal: f.journal, identity: identity(3), signal: new AbortController().signal,
    lockWaitMs: 1000, retry: 'initial', render: async () => { throw new Error('controlled') },
    media: { stopAndJoin: async () => { reached.resolve(undefined); await release.promise; return { kind: 'empty', commands: 0 } } } })
  const successorAbort = new AbortController()
  let successor: Promise<unknown> = Promise.resolve()
  try {
    await reached.promise
    successor = f.invoke(identity(4), { signal: successorAbort.signal })
    successorAbort.abort()
    await expect(successor).rejects.toThrow()
    expect(await f.journal.readDrain(identity(3).execution)).toBeUndefined()
    expect(f.counts()).toEqual([1, 1, 0, 0])
  } finally {
    successorAbort.abort(); release.resolve(undefined)
    await Promise.allSettled([successor, first])
  }
  expect(await first).toMatchObject({ kind: 'drained' })
})
