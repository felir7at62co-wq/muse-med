import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it, vi } from 'vitest'
import { GenerationWatchRuntime } from '../src/generation-watch.ts'
import { createGenerationWatchNotice } from '../src/generation-watch-delivery.ts'
import { GenerationWatchStore, type GenerationWatchRun } from '../src/generation-watch-store.ts'
import { reconcileRecordedVideo } from '../src/native.ts'
import { observeWatchTask } from '../src/watch.ts'

vi.mock('../src/native.ts', () => ({ reconcileRecordedVideo: vi.fn() }))
vi.mock('../src/watch.ts', () => ({ observeWatchTask: vi.fn() }))

const runtimes: GenerationWatchRuntime[] = []
const roots: string[] = []
const releases: (() => void)[] = []
const owner = SessionId('recovery-test-owner')
const key = 'a'.repeat(64)
const secondKey = 'b'.repeat(64)
const id = createHash('sha256').update(JSON.stringify([owner, [key]])).digest('hex')

afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await Promise.all(runtimes.splice(0).map(async runtime => runtime.close()))
  vi.restoreAllMocks()
  vi.mocked(reconcileRecordedVideo).mockReset()
  vi.mocked(observeWatchTask).mockReset()
  await Promise.all(roots.splice(0).map(async root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'muse-generation-recovery-'))
  roots.push(root)
  const store = new GenerationWatchStore(join(root, 'watches'))
  const ledger = new JubianLedger({ root: join(root, 'ledger') })
  const fetch = vi.fn(async () => { throw new Error('This recovery must not submit or read another provider task') })
  const client = new JubianClient({ credential: async () => 'fixture', fetch })
  const deliver = vi.fn<ConstructorParameters<typeof GenerationWatchRuntime>[0]['deliver']>(async () => 'settled')
  const warn = vi.fn()
  const options = { store, ledger, client, deliver, warn, watchPollIntervalMs: 10, watchTimeoutMs: 5000,
    withoutInitiator: async (action: () => Promise<void>) => action() }
  const runtime = (overrides: Partial<ConstructorParameters<typeof GenerationWatchRuntime>[0]> = {}) => {
    const current = new GenerationWatchRuntime({ ...options, ...overrides })
    runtimes.push(current)
    return current
  }
  const packs = [{ key, previewPath: join(root, 'original.preview.json') }]
  const run: GenerationWatchRun = { id, sessionId: owner, createdAt: 0, deadlineAt: Date.now() + 5000, packs }
  return { root, store, ledger, fetch, deliver, warn, runtime, packs, run }
}

it('rejects concurrent overlapping dispatches without replacing the original checkpoint', async () => {
  const f = await fixture()
  const runtime = f.runtime()
  const original = await runtime.enroll(owner, f.packs)
  await expect(runtime.enroll(owner, [...f.packs, { key: secondKey, previewPath: join(f.root, 'other.preview.json') }]))
    .rejects.toThrow('matching generation dispatch is already in progress')
  expect(await f.store.load(original.id)).toMatchObject({ packs: f.packs })
  expect(await f.store.listActive()).toHaveLength(1)
  expect(f.fetch).not.toHaveBeenCalled()
})

it('preserves rejected preflight receipts while allocating a corrected unpaid dispatch', async () => {
  const f = await fixture()
  const first = f.runtime()
  await first.enroll(owner, f.packs)
  await expect(first.executeDispatch(id, async () => { throw new Error('Preflight rejected') }))
    .rejects.toThrow('Preflight rejected')
  await vi.waitFor(async () => { expect((await f.store.load(id))?.notice?.deliveredAt).toBeDefined() })
  await first.close()
  const original = await f.store.load(id)
  expect(original?.packs[0]?.outcome?.status).toBe('unverified')
  const retry = await f.runtime().enroll(owner, f.packs)
  expect(retry.initial).toBe(true)
  expect(retry.id).not.toBe(id)
  expect(await f.store.load(id)).toEqual(original)
  expect(await f.store.load(retry.id)).toMatchObject({ packs: f.packs })
  expect(await f.ledger.records()).toEqual([])
  expect(f.fetch).not.toHaveBeenCalled()
})

it('does not infer an unpaid dispatch from a legacy outcome or an empty ledger', async () => {
  const f = await fixture()
  await f.store.create({ ...f.run, packs: [{ ...f.packs[0]!,
    outcome: { status: 'unverified', detail: 'Preflight rejected before any provider dispatch' } }],
  notice: { ...createGenerationWatchNotice('Rejected preflight'), deliveredAt: 1 } })
  await expect(f.runtime().enroll(owner, f.packs)).rejects.toThrow('unsettled checkpoint')
  expect(f.fetch).not.toHaveBeenCalled()
})

it('never treats a fenced dispatch without a receipt as an unpaid preflight', async () => {
  const f = await fixture(), first = f.runtime()
  await first.enroll(owner, f.packs)
  await expect(first.executeDispatch(id, async (beforeSend) => {
    await beforeSend(key)
    throw new Error('Interrupted after transport fence')
  })).rejects.toThrow('Interrupted after transport fence')
  await first.close()
  const run = await f.store.load(id)
  if (run === undefined) throw new Error('Missing fenced run')
  await f.store.put({ ...run, packs: [{ ...f.packs[0]!, outcome: { status: 'unverified', detail: 'Unknown dispatch' } }],
    notice: { ...createGenerationWatchNotice('Unknown dispatch'), deliveredAt: 1 } })
  await expect(f.runtime().enroll(owner, f.packs)).rejects.toThrow('unsettled checkpoint')
  expect(await f.store.hasNoSend(id)).toBe(false)
  expect(f.fetch).not.toHaveBeenCalled()
})

it('assigns a corrected unsent invocation to only one concurrent caller', async () => {
  const f = await fixture(), first = f.runtime()
  await first.enroll(owner, f.packs)
  await expect(first.executeDispatch(id, async () => { throw new Error('Preflight rejected') })).rejects.toThrow()
  await vi.waitFor(async () => { expect((await f.store.load(id))?.notice?.deliveredAt).toBeDefined() })
  await first.close()
  const outcomes = await Promise.allSettled([f.runtime().enroll(owner, f.packs), f.runtime().enroll(owner, f.packs)])
  expect(outcomes.filter(result => result.status === 'fulfilled' && result.value.initial)).toHaveLength(1)
  expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1)
  expect(await f.store.listAll()).toHaveLength(2)
  expect(f.fetch).not.toHaveBeenCalled()
})

it('refuses an unsettled outbox but reuses its original watch when every paid claim is present', async () => {
  const f = await fixture()
  await f.store.create({ ...f.run, packs: [{ ...f.packs[0]!, outcome: { status: 'unverified', detail: 'Unknown' } }],
    notice: createGenerationWatchNotice('Reconcile the original request') })
  await expect(f.runtime().enroll(owner, f.packs)).rejects.toThrow('unsettled checkpoint')
  await f.ledger.begin({ idempotencyKey: key, method: 'storyboard_native_submit', scriptId: 5933,
    requestSha256: 'c'.repeat(64) })
  await expect(f.runtime().enroll(owner, f.packs)).resolves.toEqual({ id, initial: false })
  expect(await f.store.listActive()).toHaveLength(1)
  expect(f.fetch).not.toHaveBeenCalled()
})

it('does not enroll a smaller overlapping batch until its original claims reconcile', async () => {
  const f = await fixture()
  const full = [...f.packs, { key: secondKey, previewPath: join(f.root, 'second.preview.json') }]
  const original = await f.runtime().enroll(owner, full)
  await expect(f.runtime().enroll(owner, f.packs)).rejects.toThrow('different generation watch owns part')
  await f.ledger.begin({ idempotencyKey: key, method: 'storyboard_native_submit', scriptId: 5933,
    requestSha256: 'c'.repeat(64) })
  await expect(f.runtime().enroll(owner, f.packs)).resolves.toEqual({ id: original.id, initial: false })
  expect(await f.store.listActive()).toHaveLength(1)
  expect(f.fetch).not.toHaveBeenCalled()
})

it.each([
  { label: 'legacy single receipt', report: { status: 'submitted', task_id: 42 }, task: 42 },
  { label: 'already-submitted receipt', report: { status: 'already_submitted', task_id: '42' }, task: 42 },
  { label: 'untrusted task text', report: { status: 'submitted', task_id: 'not-a-task' }, task: undefined },
  { label: 'zero task', report: { status: 'submitted', task_id: 0 }, task: undefined },
  { label: 'unverified task hint', report: { status: 'reconcile_required', task_id: 42 }, task: undefined },
  { label: 'another pack receipt', report: { idempotency_key: secondKey, status: 'submitted', task_id: 42 }, task: undefined },
  { label: 'absent tool result', report: undefined, task: undefined },
  { label: 'mixed result rows', report: { results: [null, [], { idempotency_key: key, status: 'submitted', task_id: 42 }] }, task: 42 },
])('retains the original intent for $label', async ({ report, task }) => {
  const f = await fixture()
  const runtime = f.runtime()
  const enrolled = await runtime.enroll(owner, f.packs)
  await runtime.finishDispatch(enrolled.id, report)
  await runtime.close()
  expect((await f.store.load(id))?.packs[0]?.taskId).toBe(task)
  expect(f.fetch).not.toHaveBeenCalled()
  expect(f.warn).not.toHaveBeenCalled()
})

it('reports a lost dispatch checkpoint without pretending that the receipt was saved', async () => {
  const f = await fixture()
  const runtime = f.runtime()
  await runtime.finishDispatch(id, { status: 'submitted', task_id: 42 })
  await runtime.close()
  expect(f.warn).toHaveBeenCalledWith(expect.stringContaining('original intent remains available'),
    expect.objectContaining({ message: 'Original generation intent is missing' }))
  expect(await f.store.load(id)).toBeUndefined()
  expect(f.fetch).not.toHaveBeenCalled()
})

it('continues independent watches after reporting a corrupt checkpoint', async () => {
  const f = await fixture()
  await f.store.create({ ...f.run, packs: [{ ...f.packs[0]!, outcome: { status: 'failed', detail: 'Provider failed' } }],
    notice: createGenerationWatchNotice('Failure requires local review') })
  await f.store.create({ ...f.run, id: secondKey,
    packs: [{ key: secondKey, previewPath: join(f.root, 'other.preview.json') }] })
  await writeFile(join(f.root, 'watches', `${secondKey}.json`), '{broken')
  const runtime = f.runtime()
  runtime.start()
  await vi.waitFor(async () => { expect((await f.store.load(id))?.notice?.deliveredAt).toBeDefined() })
  await runtime.close()
  expect(f.warn).toHaveBeenCalledWith(`Generation watch ${secondKey} cannot be read`, expect.any(SyntaxError))
  expect(f.deliver).toHaveBeenCalledOnce()
  expect(f.fetch).not.toHaveBeenCalled()
})

it('keeps a notice pending when an unreadable checkpoint has no complete ownership entry', async () => {
  const f = await fixture()
  await f.store.create({ ...f.run, packs: [{ ...f.packs[0]!, outcome: { status: 'failed', detail: 'Failed' } }],
    notice: createGenerationWatchNotice('Retain original') })
  await writeFile(join(f.root, 'watches', `${secondKey}.json`), '{broken')
  const runtime = f.runtime()
  runtime.start()
  await vi.waitFor(() => { expect(f.warn).toHaveBeenCalledWith(`Generation watch ${id} remains pending`, expect.any(Error)) })
  await runtime.close()
  expect((await f.store.load(id))?.notice?.deliveredAt).toBeUndefined()
  expect(f.deliver).not.toHaveBeenCalled()
})

it('contains a polling failure and can process a later local checkpoint', async () => {
  const f = await fixture()
  await f.store.create({ ...f.run, packs: [{ ...f.packs[0]!, outcome: { status: 'failed', detail: 'Failed' } }],
    notice: createGenerationWatchNotice('Review original task') })
  const error = new Error('Local polling scope failed')
  let first = true
  const runtime = f.runtime({ withoutInitiator: async (action) => {
    if (first) { first = false; throw error }
    await action()
  } })
  runtime.start()
  await vi.waitFor(async () => { expect((await f.store.load(id))?.notice?.deliveredAt).toBeDefined() })
  await runtime.close()
  runtime.start()
  expect(f.warn).toHaveBeenCalledExactlyOnceWith('Reading pending generation watches failed', error)
  expect(f.deliver).toHaveBeenCalledOnce()
})

it('waits for an in-flight scan to stop and leaves later runs untouched after shutdown', async () => {
  const f = await fixture()
  let entered!: () => void
  let release!: () => void
  const scanning = new Promise<void>((resolve) => { entered = resolve })
  const held = new Promise<void>((resolve) => { release = resolve })
  releases.push(release)
  vi.spyOn(f.store, 'listActive').mockImplementationOnce(async () => {
    entered()
    await held
    return [f.run]
  })
  const runtime = f.runtime()
  runtime.start()
  await scanning
  const closing = runtime.close()
  release()
  await closing
  expect(f.deliver).not.toHaveBeenCalled()
  expect(reconcileRecordedVideo).not.toHaveBeenCalled()
  expect(f.fetch).not.toHaveBeenCalled()
})

it('does not poll an actively dispatching request or a checkpoint whose next poll is in the future', async () => {
  const f = await fixture()
  const runtime = f.runtime()
  await runtime.enroll(owner, f.packs)
  await f.store.create({ ...f.run, id: secondKey, packs: [{ key: secondKey, previewPath: join(f.root, 'later.json') }],
    nextPollAt: Date.now() + 60000 })
  const scans = vi.spyOn(f.store, 'listActive')
  runtime.start()
  await vi.waitFor(() => { expect(scans).toHaveBeenCalled() })
  await runtime.close()
  expect(reconcileRecordedVideo).not.toHaveBeenCalled()
  expect(f.deliver).not.toHaveBeenCalled()
})

it('retains the same notice after a transient delivery failure instead of creating a new turn identity', async () => {
  const f = await fixture()
  const notice = createGenerationWatchNotice('Existing verified result')
  await f.store.create({ ...f.run, packs: [{ ...f.packs[0]!, outcome: { status: 'failed', detail: 'Failed' } }], notice })
  const error = new Error('Session temporarily unavailable')
  f.deliver.mockRejectedValueOnce(error).mockResolvedValue('settled')
  const runtime = f.runtime()
  runtime.start()
  await vi.waitFor(async () => { expect((await f.store.load(id))?.notice?.deliveredAt).toBeDefined() })
  await runtime.close()
  expect(f.warn).toHaveBeenCalledWith(`Generation watch ${id} remains pending`, error)
  expect(f.deliver.mock.calls.map(call => call[1].id)).toEqual([notice.id, notice.id])
})

it('exhausts one interrupted recovery without scheduling a third continuation', async () => {
  const f = await fixture()
  const notice = createGenerationWatchNotice('Original verified result')
  await f.store.create({ ...f.run, packs: [{ ...f.packs[0]!, outcome: { status: 'failed', detail: 'Failed' } }], notice })
  f.deliver.mockResolvedValue('interrupted')
  const runtime = f.runtime()
  runtime.start()
  await vi.waitFor(async () => { expect((await f.store.load(id))?.notice?.deliveredAt).toBeDefined() })
  await runtime.close()
  const saved = await f.store.load(id)
  expect(saved).toMatchObject({ recoveryExhausted: true, reviewRequired: true })
  expect(saved?.recoveryNotice?.id).not.toBe(notice.id)
  expect(f.deliver).toHaveBeenCalledTimes(2)
  expect(f.warn).toHaveBeenCalledWith(expect.stringContaining('episode delivery requires review'), undefined)
  expect(await f.store.listActive()).toEqual([])
})

it('preserves verified packs while timing out an unresolved sibling', async () => {
  const f = await fixture()
  vi.mocked(reconcileRecordedVideo).mockResolvedValue(undefined)
  await f.store.create({ ...f.run, deadlineAt: 0, packs: [
    { ...f.packs[0]!, taskId: 42, outcome: { status: 'succeeded', detail: 'Verified', outputs: [
      { subtask_id: 52, video_url: 'https://cdn.invalid/original.mp4', first_result_id: null, parent_result_id: null, resolution: null },
    ] } },
    { key: secondKey, previewPath: join(f.root, 'unresolved.json') },
  ] })
  const runtime = f.runtime()
  runtime.start()
  await vi.waitFor(async () => { expect((await f.store.load(id))?.notice?.deliveredAt).toBeDefined() })
  await runtime.close()
  expect((await f.store.load(id))?.packs.map(pack => pack.outcome?.status)).toEqual(['succeeded', 'unverified'])
  expect(observeWatchTask).not.toHaveBeenCalled()
  expect(f.fetch).not.toHaveBeenCalled()
})

it('reconciles an already claimed task and records the original provider failure', async () => {
  const f = await fixture()
  vi.mocked(reconcileRecordedVideo).mockResolvedValue({ status: 'submitted', task_id: '42',
    replayed: true, outcome: 'accepted', response_sha256: null, result_urls: [], next: 'Observe original',
    idempotency_key: key, preview_path: f.packs[0]!.previewPath })
  vi.mocked(observeWatchTask).mockResolvedValue({ status: 'failed', detail: 'Original provider task failed' })
  await f.store.create(f.run)
  const runtime = f.runtime()
  runtime.start()
  await vi.waitFor(async () => { expect((await f.store.load(id))?.notice?.deliveredAt).toBeDefined() })
  await runtime.close()
  expect((await f.store.load(id))?.packs[0]).toMatchObject({ taskId: 42,
    outcome: { status: 'failed', detail: 'Original provider task failed' } })
  expect(f.fetch).not.toHaveBeenCalled()
})

it('reports an unexpected task-observation error and keeps its original task identity pending', async () => {
  const f = await fixture()
  const error = new Error('Unexpected task decoder failure')
  vi.mocked(observeWatchTask).mockRejectedValue(error)
  await f.store.create({ ...f.run, packs: [{ ...f.packs[0]!, taskId: 42 }] })
  const runtime = f.runtime()
  runtime.start()
  await vi.waitFor(() => { expect(f.warn).toHaveBeenCalled() })
  await runtime.close()
  expect(f.warn).toHaveBeenCalledWith(`Generation watch ${id} could not verify a provider read`, error)
  expect((await f.store.load(id))?.packs[0]).toMatchObject({ taskId: 42 })
  expect((await f.store.load(id))?.notice).toBeUndefined()
  expect(f.deliver).not.toHaveBeenCalled()
})

it('stops after the current provider read is aborted without querying another pack', async () => {
  const f = await fixture()
  let entered!: () => void
  let release!: () => void
  const reading = new Promise<void>((resolve) => { entered = resolve })
  const held = new Promise<void>((resolve) => { release = resolve })
  releases.push(release)
  vi.mocked(observeWatchTask).mockImplementationOnce(async (_client, _args, signal) => {
    entered()
    await held
    signal.throwIfAborted()
    return undefined
  })
  await f.store.create({ ...f.run, packs: [{ ...f.packs[0]!, taskId: 42 },
    { key: secondKey, previewPath: join(f.root, 'other.preview.json'), taskId: 43 }] })
  const runtime = f.runtime()
  runtime.start()
  await reading
  const closing = runtime.close()
  release()
  await closing
  expect(observeWatchTask).toHaveBeenCalledOnce()
  expect(vi.mocked(observeWatchTask).mock.calls[0]?.[1].task_id).toBe(42)
  expect(f.warn).not.toHaveBeenCalled()
  expect(f.deliver).not.toHaveBeenCalled()
  expect((await f.store.load(id))?.packs.map(pack => pack.taskId)).toEqual([42, 43])
})

it('does not rewrite an unchanged pending checkpoint when the wall clock moves backward', async () => {
  const f = await fixture()
  const original = { ...f.run, deadlineAt: 2000, nextPollAt: 1000 }
  await f.store.create(original)
  vi.mocked(reconcileRecordedVideo).mockResolvedValue(undefined)
  const writes = vi.spyOn(f.store, 'put')
  vi.spyOn(Date, 'now').mockReturnValue(990).mockReturnValueOnce(1000).mockReturnValueOnce(1000)
  let finished!: () => void
  const polled = new Promise<void>((resolve) => { finished = resolve })
  const runtime = f.runtime({ withoutInitiator: async (action) => { await action(); finished() } })
  runtime.start()
  await polled
  await runtime.close()
  expect(reconcileRecordedVideo).toHaveBeenCalledOnce()
  expect(writes).not.toHaveBeenCalled()
  expect(await f.store.load(id)).toEqual(original)
  expect(f.deliver).not.toHaveBeenCalled()
})

it('keeps an unknown continuation for review without scheduling another message', async () => {
  const f = await fixture()
  const notice = createGenerationWatchNotice('Original result')
  await f.store.create({ ...f.run, packs: [{ ...f.packs[0]!, outcome: { status: 'failed', detail: 'Task failed' } }], notice })
  f.deliver.mockResolvedValue('unknown')
  const runtime = f.runtime()
  runtime.start()
  await vi.waitFor(async () => { expect((await f.store.load(id))?.reviewRequired).toBe(true) })
  await runtime.close()
  const saved = await f.store.load(id)
  expect(saved?.notice).toEqual(notice)
  expect(saved?.recoveryNotice).toBeUndefined()
  expect(saved?.notice?.deliveredAt).toBeUndefined()
  expect(f.deliver).toHaveBeenCalledOnce()
  expect(f.fetch).not.toHaveBeenCalled()
})

it('rejects an ownership index whose active key mapping was removed', async () => {
  const f = await fixture()
  await f.store.create(f.run)
  const path = join(f.root, 'watches', 'ownership.v2.json')
  const index = JSON.parse(await readFile(path, 'utf8')) as { keys: Record<string, object> }
  index.keys = {}
  await writeFile(path, JSON.stringify(index))
  await expect(f.runtime().enroll(owner, f.packs)).rejects.toThrow('ownership is ambiguous')
  expect(f.fetch).not.toHaveBeenCalled()
})

it.each(['before-fence', 'after-fence'] as const)('does not deliver a terminal notice during an active dispatch %s', async (phase) => {
  const f = await fixture()
  const origin = f.runtime({ watchTimeoutMs: 20 }), observer = f.runtime({ watchTimeoutMs: 20 })
  const enrollment = await origin.enroll(owner, f.packs)
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const competing = Promise.withResolvers<undefined>()
  releases.push(() => { release.resolve(undefined) })
  const originalLease = f.store.withRecoveryLease.bind(f.store)
  let acquisitions = 0
  vi.spyOn(f.store, 'withRecoveryLease').mockImplementation(async (...args) => {
    acquisitions += 1
    if (acquisitions > 1) competing.resolve(undefined)
    return await originalLease(...args)
  })
  const pending = origin.executeDispatch(enrollment.id, async (beforeSend) => {
    if (phase === 'after-fence') await beforeSend(key)
    entered.resolve(undefined)
    await release.promise
    if (phase === 'before-fence') await beforeSend(key)
    return { status: 'unverified' }
  })
  await entered.promise
  observer.start()
  await competing.promise
  expect(f.deliver).not.toHaveBeenCalled()
  release.resolve(undefined)
  await pending
  await observer.close()
  expect(await f.store.hasNoSend(enrollment.id)).toBe(false)
  expect(f.fetch).not.toHaveBeenCalled()
})

it('leaves an enrolled invocation pending before its dispatch wrapper starts', async () => {
  const f = await fixture(), origin = f.runtime({ watchTimeoutMs: 1 }), observer = f.runtime()
  const enrollment = await origin.enroll(owner, f.packs)
  const mayObserve = vi.spyOn(f.store, 'mayObserve')
  observer.start()
  await vi.waitFor(() => { expect(mayObserve).toHaveBeenCalledWith(enrollment.id) })
  await observer.close()
  expect(f.deliver).not.toHaveBeenCalled()
  expect((await f.store.load(enrollment.id))?.notice).toBeUndefined()
})

it('releases local dispatch ownership when its recovery lease cannot be acquired', async () => {
  const f = await fixture(), runtime = f.runtime()
  await runtime.enroll(owner, f.packs)
  const error = new Error('lease unavailable')
  vi.spyOn(f.store, 'withRecoveryLease').mockRejectedValueOnce(error)
  vi.spyOn(f.store, 'listActive').mockResolvedValue([])
  const dispatch = vi.fn(async () => ({ status: 'unverified' }))
  await expect(runtime.executeDispatch(id, dispatch)).rejects.toBe(error)
  expect(dispatch).not.toHaveBeenCalled()
  await expect(runtime.enroll(owner, f.packs)).rejects.toThrow('unsettled checkpoint')
  expect(await f.store.hasNoSend(id)).toBe(false)
})

it('releases local dispatch ownership when saving the completion fence fails', async () => {
  const f = await fixture(), runtime = f.runtime()
  await runtime.enroll(owner, f.packs)
  vi.spyOn(f.store, 'listActive').mockResolvedValue([])
  vi.spyOn(f.store, 'finishInitialDispatch').mockRejectedValueOnce(new Error('completion write failed'))
  await expect(runtime.executeDispatch(id, async () => ({ status: 'unverified' }))).rejects.toThrow('completion write failed')
  const original = await f.store.load(id)
  await expect(runtime.enroll(owner, f.packs)).resolves.toMatchObject({ initial: true })
  expect(await f.store.load(id)).toEqual(original)
  expect(f.fetch).not.toHaveBeenCalled()
})

it('corrects a proven unpaid invocation even when its failed tool body cannot deliver a notice', async () => {
  const f = await fixture(), first = f.runtime({ deliver: async () => 'needs-review' })
  await first.enroll(owner, f.packs)
  await expect(first.executeDispatch(id, async () => { throw new Error('Preflight failed before a tool receipt') }))
    .rejects.toThrow('Preflight failed')
  await first.close()
  const original = await f.store.load(id)
  expect(original?.notice?.deliveredAt).toBeUndefined()
  const second = f.runtime()
  const retry = await second.enroll(owner, f.packs)
  expect(retry).toMatchObject({ initial: true })
  expect(retry.id).not.toBe(id)
  expect(await f.store.load(id)).toEqual(original)
  expect(await f.store.isRetired(id)).toBe(true)
  expect(await f.store.mayObserve(id)).toBe(false)
  expect(f.fetch).not.toHaveBeenCalled()
})

it('retains the preflight failure when its no-send checkpoint also fails', async () => {
  const f = await fixture(), runtime = f.runtime()
  await runtime.enroll(owner, f.packs)
  vi.spyOn(f.store, 'listActive').mockResolvedValue([])
  const preflight = new Error('original preflight failure'), checkpoint = new Error('no-send write failed')
  vi.spyOn(f.store, 'recordNoSend').mockRejectedValueOnce(checkpoint)
  let failure: unknown
  try { await runtime.executeDispatch(id, async () => { throw preflight }) }
  catch (error) { failure = error }
  expect(failure).toBeInstanceOf(AggregateError)
  expect((failure as AggregateError).errors).toEqual([preflight, checkpoint])
  await expect(runtime.enroll(owner, f.packs)).rejects.toThrow('unsettled checkpoint')
  expect(await f.store.hasNoSend(id)).toBe(false)
})
