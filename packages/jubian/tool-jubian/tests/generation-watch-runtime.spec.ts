import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JubianClient, JubianError, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { GenerationWatchRuntime } from '../src/generation-watch.ts'
import { GenerationWatchStore } from '../src/generation-watch-store.ts'
import { reconcileRecordedVideo } from '../src/native.ts'

vi.mock('../src/native.ts', () => ({ reconcileRecordedVideo: vi.fn() }))

it.each([
  { label: 'unexpected read failure', error: new Error('Provider decoding failed'), warns: true },
  { label: 'transient network failure', error: new JubianError('NETWORK_ERROR'), warns: false },
  { label: 'reported contract failure', error: new JubianError('CONTRACT_CHANGED'), warns: false },
])('expires an unverified read without duplicate reporting after restart: $label', async ({ error, warns }) => {
  const root = await mkdtemp(join(tmpdir(), 'muse-generation-read-failure-'))
  const store = new GenerationWatchStore(join(root, 'watches'))
  const id = 'a'.repeat(64)
  const reconcile = vi.mocked(reconcileRecordedVideo).mockRejectedValue(error)
  const fetch = vi.fn(async () => { throw new Error('No provider submission is allowed') })
  const client = new JubianClient({ credential: async () => 'fixture', fetch })
  const ledger = new JubianLedger({ root: join(root, 'ledger') })
  const deliver = vi.fn<ConstructorParameters<typeof GenerationWatchRuntime>[0]['deliver']>(async () => 'settled')
  const warn = vi.fn()
  const runtimes: GenerationWatchRuntime[] = []
  const start = () => {
    const runtime = new GenerationWatchRuntime({ store, client, ledger, deliver, warn,
      watchPollIntervalMs: 20, watchTimeoutMs: 5000, withoutInitiator: async operation => operation() })
    runtimes.push(runtime)
    runtime.start()
    return runtime
  }
  try {
    await store.create({ id, sessionId: SessionId('failed-read-owner'), createdAt: 0, deadlineAt: 0,
      packs: [{ key: 'b'.repeat(64), previewPath: join(root, 'preview.json') }] })
    const first = start()
    await vi.waitFor(async () => { expect((await store.load(id))?.notice?.deliveredAt).toBeDefined() })
    await first.close()
    expect((await store.load(id))?.packs[0]?.outcome?.status).toBe('unverified')
    expect(deliver).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledTimes(warns ? 1 : 0)
    if (warns) expect(warn).toHaveBeenCalledWith(`Generation watch ${id} could not verify a provider read`, error)
    const scans = vi.spyOn(store, 'listActive')
    const second = start()
    await vi.waitFor(() => { expect(scans).toHaveBeenCalled() })
    await second.close()
    expect(reconcile).toHaveBeenCalledOnce()
    expect(deliver).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledTimes(warns ? 1 : 0)
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    await Promise.all(runtimes.map(async (runtime) => { await runtime.close() }))
    reconcile.mockReset()
    await rm(root, { recursive: true, force: true })
  }
})

it('exposes pending group ownership only to the original exchange and never on a delivered replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-generation-watch-group-owner-'))
  const owner = SessionId('worker')
  const groupOrigin = { roomId: 'room', workerBotId: 'worker-bot', requesterBotId: 'chief',
    requesterSessionId: 'chief-in-room', exchangeId: randomUUID() }
  const key = 'a'.repeat(64)
  const packs = [{ key, previewPath: join(root, 'preview.json') }]
  const ledger = new JubianLedger({ root: join(root, 'ledger') })
  const store = new GenerationWatchStore(join(root, 'watches'))
  const client = new JubianClient({ credential: async () => 'fixture',
    fetch: async () => { throw new Error('Unexpected provider read') } })
  const runtimes: GenerationWatchRuntime[] = []
  const runtime = () => {
    const current = new GenerationWatchRuntime({ store, client, ledger, watchPollIntervalMs: 20,
      watchTimeoutMs: 5000, deliver: async () => 'settled', warn: vi.fn(), withoutInitiator: async action => action() })
    runtimes.push(current)
    return current
  }
  try {
    const first = await runtime().enroll(owner, packs, groupOrigin)
    expect(first).toEqual({ id: first.id, initial: true, groupExchangeId: groupOrigin.exchangeId })
    const foreign = await runtime().enroll(owner, packs, { ...groupOrigin, exchangeId: randomUUID() })
    expect(foreign).toEqual({ id: first.id, initial: true })
    const same = await runtime().enroll(owner, packs, groupOrigin)
    expect(same.groupExchangeId).toBe(groupOrigin.exchangeId)

    const stored = await store.load(first.id)
    if (stored === undefined) throw new Error('Missing original group watch')
    await ledger.begin({ idempotencyKey: key, method: 'storyboard_native_submit',
      scriptId: 2708, requestSha256: 'b'.repeat(64) })
    await store.put({ ...stored, packs: stored.packs.map(pack => ({ ...pack,
      outcome: { status: 'unverified', detail: 'offline fixture' } })),
    notice: { id: randomUUID(), text: 'Observed', deliveredAt: Date.now() } })
    await expect(runtime().enroll(owner, packs, groupOrigin)).resolves.toEqual({ id: first.id, initial: false })
  } finally {
    await Promise.all(runtimes.map(async (item) => { await item.close() }))
    await rm(root, { recursive: true, force: true })
  }
})

it.each([false, true])('restores a partially verified batch without another PUT (duplicate task: %s)', async (duplicate) => {
  const root = await mkdtemp(join(tmpdir(), 'muse-generation-watch-runtime-'))
  const owner = SessionId('episode-42-owner')
  const groupOrigin = duplicate ? undefined : { roomId: 'short-drama', workerBotId: 'video', requesterBotId: 'chief',
    requesterSessionId: 'chief-in-short-drama', exchangeId: 'dispatch-42' }
  const keys = ['b'.repeat(64), 'c'.repeat(64)] as const
  const secondId = duplicate ? 42 : 43
  let providerReady = false
  const calls: { method: string; path: string; body: unknown }[] = []
  const client = new JubianClient({ credential: async () => 'fixture', fetch: async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const method = init?.method ?? 'GET'
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ method, path: url.pathname, body })
    let data: unknown
    if (method === 'GET' && /\/aigc\/video\/task\/\d+$/u.test(url.pathname)) {
      const id = Number(url.pathname.split('/').at(-1))
      data = { id, taskType: 1, taskStatus: providerReady ? 'succeeded' : 'running' }
    } else if (method === 'POST' && url.pathname.endsWith('/aigc/video/task/sub/list')) {
      const id = (body as { aigcVideoTaskId: number }).aigcVideoTaskId
      const video = `https://cdn.example/${id}.mp4`
      data = { total: 1, rows: [{ id: id + 100, aigcVideoTaskId: id, taskStatus: 'succeeded',
        resultList: [{ firstResultId: id + 200, taskType: 1, resultStatus: 'succeeded', lastTaskType: 1,
          lastResultStatus: 'succeeded', tosVideoUrl: video, lastTosVideoUrl: video }] }] }
    } else {
      throw new Error(`Unexpected provider route ${method} ${url.pathname}`)
    }
    return new Response(JSON.stringify({ code: 200, data }))
  } })
  const ledger = new JubianLedger({ root: join(root, 'ledger') })
  const reconcile = vi.mocked(reconcileRecordedVideo).mockImplementation(async (_client, _ledger, item, signal) => {
    signal?.throwIfAborted()
    expect(item.idempotency_key).toBe(keys[1])
    return providerReady ? { replayed: true, outcome: 'accepted', response_sha256: null, preview_path: item.preview_path,
      idempotency_key: item.idempotency_key, status: 'submitted', task_id: String(secondId), result_urls: [], next: 'observed' } : undefined
  })
  const deliver = vi.fn<ConstructorParameters<typeof GenerationWatchRuntime>[0]['deliver']>(async () => 'settled')
  const warn = vi.fn()
  const createRuntime = (store: GenerationWatchStore): GenerationWatchRuntime => new GenerationWatchRuntime({ store, client, ledger,
    watchPollIntervalMs: 20, watchTimeoutMs: 5000, deliver, warn, withoutInitiator: async operation => operation() })
  const store = new GenerationWatchStore(join(root, 'watches'))
  const first = createRuntime(store)
  let restored: GenerationWatchRuntime | undefined
  try {
    first.start()
    const { id, initial } = await first.enroll(owner,
      keys.map((key, index) => ({ key, previewPath: join(root, `pack-${index}.json`) })), groupOrigin)
    expect(initial).toBe(true)
    await first.finishDispatch(id, { results: [{ idempotency_key: keys[0], status: 'submitted', task_id: '42' },
      { idempotency_key: keys[1], status: 'reconcile_required', early_task_id: '999' }] })
    await vi.waitFor(async () => { expect((await store.load(id))?.nextPollAt).toBeDefined() }, { timeout: 2000, interval: 10 })
    await first.close()
    const before = await store.load(id)
    expect(before?.packs.map(pack => pack.taskId)).toEqual([42, undefined])
    expect(before?.notice).toBeUndefined()
    expect(deliver).not.toHaveBeenCalled()
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every(call => call.method === 'GET' && call.path.endsWith('/aigc/video/task/42'))).toBe(true)

    providerReady = true
    const restoredStore = new GenerationWatchStore(join(root, 'watches'))
    restored = createRuntime(restoredStore)
    restored.start()
    await vi.waitFor(async () => {
      expect((await restoredStore.load(id))?.notice?.deliveredAt).toBeDefined()
    }, { timeout: 2000, interval: 10 })
    const after = await restoredStore.load(id)
    expect(after?.deadlineAt).toBe(before?.deadlineAt)
    expect(after?.packs.map(pack => [pack.taskId, pack.outcome?.status, pack.outcome?.outputs?.[0]?.subtask_id])).toEqual(duplicate
      ? [[42, 'unverified', undefined], [42, 'unverified', undefined]]
      : [[42, 'succeeded', 142], [43, 'succeeded', 143]])
    expect(await restoredStore.listActive()).toEqual([])
    expect(deliver).toHaveBeenCalledExactlyOnceWith(owner, expect.objectContaining({ id: after?.notice?.id }),
      expect.any(AbortSignal), groupOrigin, groupOrigin === undefined ? undefined : after?.notice?.id)
    expect(calls.filter(call => call.method === 'POST').map(call => call.body)).toEqual(duplicate
      ? [] : [{ aigcVideoTaskId: 42 }, { aigcVideoTaskId: 43 }])
    expect(calls.some(call => call.method === 'PUT' || call.path.endsWith('/999'))).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  } finally {
    await first.close()
    await restored?.close()
    reconcile.mockReset()
    await rm(root, { recursive: true, force: true })
  }
})
