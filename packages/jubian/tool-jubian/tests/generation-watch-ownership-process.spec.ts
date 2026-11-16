import { fork, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { GenerationWatchStore, type GenerationWatchRun } from '../src/generation-watch-store.ts'

const entry = fileURLToPath(new URL('./fixtures/generation-watch-owner-process.ts', import.meta.url))
const tsconfig = fileURLToPath(new URL('../../../../tsconfig.base.json', import.meta.url))

function run(root: string, id: string, sessionId: string, keys: string[]): GenerationWatchRun {
  return { id: id.repeat(64), sessionId: SessionId(sessionId), createdAt: 0, deadlineAt: 1,
    packs: keys.map(key => ({ key: key.repeat(64), previewPath: join(root, `${key}.json`) })) }
}

type ProcessEvent = { kind: string; message?: string }
function processFixture(root: string, mode: string, payload: string) {
  const child = fork(entry, [root, mode, payload], { execArgv: ['--import', import.meta.resolve('tsx/esm')],
    env: { ...process.env, TSX_TSCONFIG_PATH: tsconfig }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  const ready = Promise.withResolvers<undefined>(), result = Promise.withResolvers<ProcessEvent>()
  const exited = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>()
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  child.on('message', (value: unknown) => {
    if (value === null || typeof value !== 'object' || !('kind' in value) || typeof value.kind !== 'string') return
    if (value.kind === 'ready') ready.resolve(undefined)
    else result.resolve({ kind: value.kind, ...('message' in value && typeof value.message === 'string' ? { message: value.message } : {}) })
  })
  child.once('error', (error) => { ready.reject(error); result.reject(error) })
  child.once('exit', (code, signal) => {
    const error = new Error(`Owner fixture exited before reporting: ${code ?? signal}; ${stderr}`)
    ready.reject(error)
    result.reject(error)
    exited.resolve({ code, signal })
  })
  const stop = async (process: ChildProcess) => {
    if (process.exitCode === null && process.signalCode === null) process.kill()
    await exited.promise
  }
  return { child, ready: ready.promise, result: result.promise, exited: exited.promise, stop }
}

it('atomically assigns overlapping keys to only one of two Host processes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-watch-owner-process-'))
  const left = run(root, 'a', 'first-session', ['b', 'c'])
  const right = run(root, 'd', 'second-session', ['c', 'e'])
  const a = processFixture(root, 'claim', JSON.stringify(left)), b = processFixture(root, 'claim', JSON.stringify(right))
  try {
    await Promise.all([a.ready, b.ready])
    a.child.send('start')
    b.child.send('start')
    const outcomes = await Promise.all([a.result, b.result])
    expect(outcomes.filter(outcome => outcome.kind === 'claimed')).toHaveLength(1)
    expect(outcomes.filter(outcome => outcome.kind === 'rejected')).toHaveLength(1)
    expect(await Promise.all([a.exited, b.exited])).toEqual([{ code: 0, signal: null }, { code: 0, signal: null }])
    const saved = JSON.parse(await readFile(join(root, 'ownership.v1.json'), 'utf8')) as {
      keys: Record<string, { runId: string; sessionId: string }>
    }
    const winner = outcomes[0]?.kind === 'claimed' ? left : right
    expect(Object.keys(saved.keys).sort()).toEqual(winner.packs.map(pack => pack.key).sort())
    expect(Object.values(saved.keys).every(owner => owner.runId === winner.id && owner.sessionId === winner.sessionId)).toBe(true)
  } finally {
    await Promise.all([a.stop(a.child), b.stop(b.child)])
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

it('does not grant two Host processes the initial dispatch of the same original key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-watch-dispatch-process-'))
  const original = run(root, 'a', 'original-session', ['b'])
  const a = processFixture(root, 'enroll', JSON.stringify(original)), b = processFixture(root, 'enroll', JSON.stringify(original))
  try {
    await Promise.all([a.ready, b.ready])
    a.child.send('start')
    b.child.send('start')
    const outcomes = await Promise.all([a.result, b.result])
    expect(outcomes.filter(outcome => outcome.kind === 'initial')).toHaveLength(1)
    expect(outcomes.filter(outcome => outcome.kind === 'rejected')).toHaveLength(1)
    expect(await Promise.all([a.exited, b.exited])).toEqual([{ code: 0, signal: null }, { code: 0, signal: null }])
  } finally {
    await Promise.all([a.stop(a.child), b.stop(b.child)])
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

it('does not allow two Sessions to claim the same key in separate Host processes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-watch-session-process-'))
  const a = processFixture(root, 'enroll', JSON.stringify(run(root, 'a', 'first-session', ['b'])))
  const b = processFixture(root, 'enroll', JSON.stringify(run(root, 'c', 'second-session', ['b'])))
  try {
    await Promise.all([a.ready, b.ready])
    a.child.send('start')
    b.child.send('start')
    const outcomes = await Promise.all([a.result, b.result])
    expect(outcomes.filter(outcome => outcome.kind === 'initial')).toHaveLength(1)
    expect(outcomes.filter(outcome => outcome.kind === 'rejected')).toHaveLength(1)
    expect(await Promise.all([a.exited, b.exited])).toEqual([{ code: 0, signal: null }, { code: 0, signal: null }])
    expect(await new GenerationWatchStore(root).listAll()).toHaveLength(1)
  } finally {
    await Promise.all([a.stop(a.child), b.stop(b.child)])
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

it('does not grant initial dispatch to different batches with an overlapping key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-watch-batch-process-'))
  const a = processFixture(root, 'enroll', JSON.stringify(run(root, 'a', 'original-session', ['b', 'c'])))
  const b = processFixture(root, 'enroll', JSON.stringify(run(root, 'd', 'original-session', ['b'])))
  try {
    await Promise.all([a.ready, b.ready])
    a.child.send('start')
    b.child.send('start')
    const outcomes = await Promise.all([a.result, b.result])
    expect(outcomes.filter(outcome => outcome.kind === 'initial')).toHaveLength(1)
    expect(outcomes.filter(outcome => outcome.kind === 'rejected')).toHaveLength(1)
    expect(await Promise.all([a.exited, b.exited])).toEqual([{ code: 0, signal: null }, { code: 0, signal: null }])
    expect(await new GenerationWatchStore(root).listAll()).toHaveLength(1)
  } finally {
    await Promise.all([a.stop(a.child), b.stop(b.child)])
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

it.skipIf(process.platform === 'win32')('retains an orphaned claim after the writer dies before creating the checkpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-watch-crash-process-'))
  const original = run(root, 'a', 'original-session', ['b'])
  const fixture = processFixture(root, 'interrupt-create', JSON.stringify(original))
  try {
    await fixture.ready
    fixture.child.send('start')
    expect((await fixture.result).kind).toBe('before-checkpoint')
    fixture.child.kill('SIGKILL')
    expect(await fixture.exited).toEqual({ code: null, signal: 'SIGKILL' })
    const store = new GenerationWatchStore(root)
    await expect(store.claimAndCreate(original)).rejects.toThrow('ownership is ambiguous')
    expect(await store.load(original.id)).toBeUndefined()
    const saved = JSON.parse(await readFile(join(root, 'ownership.v1.json'), 'utf8')) as {
      keys: Record<string, { runId: string; sessionId: string }>
    }
    expect(saved.keys[original.packs[0]!.key]).toMatchObject({ runId: original.id, sessionId: original.sessionId })
  } finally {
    await fixture.stop(fixture.child)
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

it.skipIf(process.platform === 'win32')('takes over an exited process lease without changing the original owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-watch-owner-lease-'))
  const original = run(root, 'a', 'original-session', ['b']), store = new GenerationWatchStore(root)
  const fixture = processFixture(root, 'lease', original.id)
  try {
    await store.claimOwnership(original)
    await fixture.ready
    fixture.child.send('start')
    expect((await fixture.result).kind).toBe('locked')
    fixture.child.kill('SIGKILL')
    expect(await fixture.exited).toEqual({ code: null, signal: 'SIGKILL' })
    let entered = false
    await new GenerationWatchStore(root).withRecoveryLease(original.id, new AbortController().signal, 5000,
      async () => { entered = true })
    expect(entered).toBe(true)
    await expect(store.claimOwnership(run(root, 'c', 'other-session', ['b']))).rejects.toThrow('ownership is ambiguous')
  } finally {
    await fixture.stop(fixture.child)
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)


it('shares the original key between single and batch paid entrypoints in different processes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-paid-key-process-'))
  const original = run(root, 'a', 'original-session', ['b'])
  const a = processFixture(root, 'ledger-single', JSON.stringify(original))
  const b = processFixture(root, 'ledger-batch', JSON.stringify(original))
  try {
    await Promise.all([a.ready, b.ready])
    a.child.send('start'); b.child.send('start')
    const outcomes = await Promise.all([a.result, b.result])
    expect(outcomes.filter(value => value.kind === 'sent')).toHaveLength(1)
    expect(outcomes.filter(value => value.kind === 'replayed' || value.kind === 'rejected')).toHaveLength(1)
    await Promise.all([a.exited, b.exited])
    expect((await readFile(join(root, 'sent.ndjson'), 'utf8')).trim().split('\n')).toEqual([original.packs[0]?.key])
  } finally {
    await Promise.all([a.stop(a.child), b.stop(b.child)])
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

it.skipIf(process.platform === 'win32')('never repeats a key reserved by a killed sending process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-paid-key-kill-'))
  const original = run(root, 'a', 'original-session', ['b'])
  const first = processFixture(root, 'ledger-reserved', JSON.stringify(original))
  let retry: ReturnType<typeof processFixture> | undefined
  try {
    await first.ready
    first.child.send('start')
    expect((await first.result).kind).toBe('reserved')
    first.child.kill('SIGKILL')
    await first.exited
    retry = processFixture(root, 'ledger-single', JSON.stringify(original))
    await retry.ready
    retry.child.send('start')
    expect((await retry.result).kind).toBe('replayed')
    await retry.exited
    await expect(readFile(join(root, 'sent.ndjson'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await first.stop(first.child)
    if (retry !== undefined) await retry.stop(retry.child)
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
