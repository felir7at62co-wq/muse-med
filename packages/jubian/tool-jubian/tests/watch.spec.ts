/** Read-only operation completion and cancellation through the real provider parser. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JubianClient } from '@deepseek-ai/dsh-jubian'
import type { JubianRequest, JubianResponse } from '@deepseek-ai/dsh-jubian'
import { watchJob, resolveWatchConfig, watchArgs } from '../src/watch.ts'
import type { WatchArgs } from '../src/watch.ts'

const args = { task_id: 42, stage: 'upscale' as const }
const config = { watchPollIntervalMs: 10, watchTimeoutMs: 100 }
const task = (status = 'succeeded', taskType = 20) => ({ id: 42, taskType, taskStatus: status })
const child = (id = 51, status = 'succeeded', stage = 20) => ({
  id, aigcVideoTaskId: 42, taskStatus: status,
  resultList: [{ firstResultId: id + 100, taskType: stage, resultStatus: status,
    lastTaskType: stage, lastResultStatus: status, hdCount: 1,
    tosVideoUrl: 'https://cdn.example/source.mp4', lastTosVideoUrl: `https://cdn.example/${id}.mp4` }],
})
function provider(read: (path: string) => unknown) {
  const calls: { path: string; method: string }[] = []
  const client = new JubianClient({ credential: async () => 'test-token', fetch: async (url, init) => {
    const path = (typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).replace('https://web.jubianai.net/prod-api', '')
    calls.push({ path, method: init!.method! })
    return new Response(JSON.stringify({ code: 200, data: read(path) }))
  } })
  return { client, calls }
}
const hooks: ReturnType<typeof watchJob>[] = []
afterEach(async () => {
  for (const hook of hooks.splice(0)) { hook.cancel(); await hook.done }
  vi.useRealTimers()
})
function start(client: JubianClient, input = args) {
  const hook = watchJob(client, input, config)
  hooks.push(hook)
  return hook
}

describe('jubian watcher', () => {
  it('accepts a parsed watch identity and refuses a nonobject child page', async () => {
    expect(watchArgs(args)).toBe(args)
    vi.useFakeTimers()
    const { client } = provider(path => path.includes('/sub/list') ? null : task())
    const hook = start(client)
    await vi.advanceTimersByTimeAsync(100)
    expect((await hook.done).status).toBe('failed')
  })
  it.each([{ task_id: 0, stage: 'generate' }, { task_id: 1.5, stage: 'generate' },
    { task_id: 1, stage: 'other' }, { task_id: 1, stage: null }])
  ('rejects invalid model-authored watch JSON %j', (input) => {
    const decoded = JSON.parse(JSON.stringify(input)) as WatchArgs
    expect(() => watchArgs(decoded)).toThrow('jubian_watch')
  })

  it('does not accept a child-list alias that lacks the inspected raw rows', async () => {
    vi.useFakeTimers()
    const { client } = provider(path => path.includes('/sub/list') ? { total: 1, list: [child()] } : task())
    const hook = start(client)
    await vi.advanceTimersByTimeAsync(100)
    expect((await hook.done).status).toBe('failed')
  })
  it('reports a credential failure without continuing polling', async () => {
    const client = new JubianClient({ credential: async () => { throw new Error('private reason') } })
    await expect(start(client).done).resolves.toEqual({ status: 'failed', detail: 'AUTHENTICATION_REQUIRED' })
  })

  it('contains an unexpected client failure and releases its deadline', async () => {
    vi.useFakeTimers()
    class FailingClient extends JubianClient {
      override async request(_request: JubianRequest): Promise<JubianResponse> { throw new Error('private reason') }
    }
    await expect(start(new FailingClient({ credential: async () => 'token' })).done)
      .resolves.toEqual({ status: 'failed', detail: 'watch read failed' })
    expect(vi.getTimerCount()).toBe(0)
  })
  it('resolves bounded defaults and rejects invalid settings', () => {
    expect(resolveWatchConfig({})).toEqual({ watchPollIntervalMs: 15000, watchTimeoutMs: 1800000 })
    for (const value of [0, -1, 1.5, Infinity, 60001]) {
      expect(() => resolveWatchConfig({ watchPollIntervalMs: value })).toThrow('watchPollIntervalMs')
    }
    expect(() => resolveWatchConfig({ watchTimeoutMs: 86400001 })).toThrow('watchTimeoutMs')
  })

  it('waits for the operation and every matching-stage child, then returns review guidance', async () => {
    vi.useFakeTimers()
    let ready = false
    const { client, calls } = provider(path => path.includes('/sub/list')
      ? { total: 2, rows: [child(), child(52, ready ? 'succeeded' : 'processing')] }
      : task(ready ? 'succeeded' : 'processing'))
    const hook = start(client)
    let settled = false
    void hook.done.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(10)
    expect(settled).toBe(false)
    ready = true
    await vi.advanceTimersByTimeAsync(10)
    const result = await hook.done
    expect(result.status).toBe('completed')
    const parsed: unknown = JSON.parse(result.result!)
    const reviewGuidance: unknown = expect.stringContaining('Review')
    expect(parsed).toMatchObject({ task_id: 42, stage: 'upscale', status: 'succeeded',
      outputs: [{ subtask_id: 51 }, { subtask_id: 52 }], next: reviewGuidance })
    expect(calls.every(call => call.method === 'GET' || (call.method === 'POST' && call.path.includes('/sub/list')))).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    ['old source task success', () => task('succeeded', 1), () => child()],
    ['missing task identity', () => ({ taskType: 20, taskStatus: 'succeeded' }), () => child()],
    ['missing task stage', () => ({ id: 42, taskStatus: 'succeeded' }), () => child()],
    ['missing child ownership', () => task(), () => ({ ...child(), aigcVideoTaskId: undefined })],
    ['foreign child ownership', () => task(), () => ({ ...child(), aigcVideoTaskId: 40 })],
    ['old hd flag and URL', () => task(), () => child(51, 'succeeded', 1)],
    ['old stage success with pending current output', () => task(), () => child(51, 'processing')],
    ['missing child identity', () => task(), () => ({ ...child(), id: undefined })],
  ])('does not accept %s', async (_label, parent, row) => {
    vi.useFakeTimers()
    const { client } = provider(path => path.includes('/sub/list') ? { total: 1, rows: [row()] } : parent())
    const hook = start(client)
    await vi.advanceTimersByTimeAsync(100)
    expect(await hook.done).toMatchObject({ status: 'failed', detail: 'timeout: operation completion unverified' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reads the complete paginated child list before success', async () => {
    const { client, calls } = provider(path => path.includes('/sub/list')
      ? { total: 2, rows: [child(path.includes('pageNum=2') ? 52 : 51)] } : task())
    const result = await start(client).done
    expect(result.status).toBe('completed')
    expect(calls.filter(call => call.method === 'POST').map(call => call.path)).toEqual([
      '/admin/aigc/video/task/sub/list?pageNum=1&pageSize=1000',
      '/admin/aigc/video/task/sub/list?pageNum=2&pageSize=1000',
    ])
  })

  it.each([
    ['changed total', (page: number) => ({ total: page === 1 ? 2 : 3, rows: [child(page === 1 ? 51 : 52)] })],
    ['repeated child', () => ({ total: 2, rows: [child()] })],
    ['empty incomplete page', () => ({ total: 2, rows: [] })],
    ['too many rows', () => ({ total: 1, rows: [child(), child(52)] })],
    ['missing child status', () => ({ total: 1, rows: [{ ...child(), taskStatus: null }] })],
    ['missing parent status', () => ({ total: 1, rows: [child()] })],
    ['missing current URL', () => ({ total: 1, rows: [{ ...child(), resultList: [] }] })],
    ['nontext current status', () => ({ total: 1, rows: [{ ...child(), resultList: [{
      ...child().resultList[0], lastResultStatus: 2 }] }] })],
    ['failed prior version', () => ({ total: 1, rows: [{ ...child(), resultList: [{
      taskType: 20, resultStatus: 'processing', tosVideoUrl: 'https://cdn.example/source.mp4' }] }] })],
    ['missing prior status', () => ({ total: 1, rows: [{ ...child(), resultList: [{
      taskType: 20, tosVideoUrl: 'https://cdn.example/source.mp4' }] }] })],
    ['material without version evidence', () => ({ total: 1, rows: [{ ...child(), resultList: null,
      videoMaterials: [{ videoUrl: 'https://cdn.example/source.mp4' }] }] })],
  ] as const)('keeps %s unverified until the deadline', async (label, page) => {
    vi.useFakeTimers()
    const { client } = provider(path => path.includes('/sub/list')
      ? page(Number(new URL(`https://example.test${path}`).searchParams.get('pageNum')))
      : label === 'missing parent status' ? { ...task(), taskStatus: null } : task())
    const hook = start(client)
    await vi.advanceTimersByTimeAsync(100)
    expect(await hook.done).toMatchObject({ status: 'failed', detail: 'timeout: operation completion unverified' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('accepts the requested completed version when no latest-stage fields are recorded', async () => {
    const { client } = provider(path => path.includes('/sub/list') ? { total: 1, rows: [{ ...child(),
      resultList: [{ taskType: 20, resultStatus: 'succeeded', originalVideoUrl: 'https://cdn.example/source.mp4' }] }] }
      : task())
    expect(await start(client).done).toMatchObject({ status: 'completed' })
  })

  it.each([undefined, 2])('does not accept incomplete or unverified total %s', async (total) => {
    vi.useFakeTimers()
    const { client } = provider(path => path.includes('/sub/list') ? { total, rows: [child()] } : task())
    const hook = start(client)
    await vi.advanceTimersByTimeAsync(100)
    expect((await hook.done).status).toBe('failed')
  })

  it.each(['failed', 'no_all_failed', 'cancelled', 'expired'])('reports known provider failure %s without retries', async (status) => {
    const { client, calls } = provider(() => task(status))
    expect(await start(client).done).toMatchObject({ status: 'failed', detail: `provider operation ${status}` })
    expect(calls).toHaveLength(1)
  })

  it('cannot borrow an old version success for a newest URL with missing current status', async () => {
    vi.useFakeTimers()
    const row = child()
    delete (row.resultList[0] as Partial<typeof row.resultList[0]>).lastResultStatus
    const { client } = provider(path => path.includes('/sub/list') ? { total: 1, rows: [row] } : task())
    const hook = start(client)
    await vi.advanceTimersByTimeAsync(100)
    expect((await hook.done).status).toBe('failed')
  })

  it('reports an owned failed child', async () => {
    const { client } = provider(path => path.includes('/sub/list')
      ? { total: 1, rows: [child(51, 'failed')] } : task())
    expect(await start(client).done).toMatchObject({ status: 'failed', detail: 'provider child 51 failed' })
  })

  it('cancels the polling timer idempotently without another provider request', async () => {
    vi.useFakeTimers()
    const { client, calls } = provider(() => task('processing'))
    const hook = start(client)
    await vi.advanceTimersByTimeAsync(0)
    hook.cancel(); hook.cancel()
    expect((await hook.done).status).toBe('killed')
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['cancel', 'timeout'])('aborts an in-flight request on %s and settles after cleanup', async (mode) => {
    vi.useFakeTimers()
    let aborted = false
    const client = new JubianClient({ credential: async () => 'test-token', fetch: async (_url, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) }, { once: true })
      }) })
    const hook = start(client)
    await vi.advanceTimersByTimeAsync(0)
    if (mode === 'cancel') hook.cancel()
    else await vi.advanceTimersByTimeAsync(100)
    expect((await hook.done).status).toBe(mode === 'cancel' ? 'killed' : 'failed')
    expect(aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('accepts a succeeded generation operation with its owned base output without downstream markers', async () => {
    const { client } = provider(path => path.includes('/sub/list') ? { total: 1, rows: [{
      id: 51, aigcVideoTaskId: 42, taskStatus: 'succeeded',
      resultList: [{ tosVideoUrl: 'https://cdn.example/source.mp4' }],
    }] } : task('succeeded', 1))
    const hook = watchJob(client, { task_id: 42, stage: 'generate' }, config)
    hooks.push(hook)
    expect((await hook.done).status).toBe('completed')
  })

  it('rejects an unknown latest stage even with a succeeded generation version', async () => {
    vi.useFakeTimers()
    const { client } = provider(path => path.includes('/sub/list') ? { total: 1, rows: [{
      id: 51, aigcVideoTaskId: 42, taskStatus: 'succeeded', resultList: [{ taskType: 1,
        resultStatus: 'succeeded', lastTaskType: 2, tosVideoUrl: 'https://cdn.example/source.mp4',
        lastTosVideoUrl: 'https://cdn.example/other.mp4' }],
    }] } : task('succeeded', 1))
    const hook = watchJob(client, { task_id: 42, stage: 'generate' }, config)
    hooks.push(hook)
    await vi.advanceTimersByTimeAsync(100)
    expect((await hook.done).status).toBe('failed')
  })

  it.each(['generate', 'erase_subtitle'] as const)('accepts exact %s operation output, not visual QA', async (stage) => {
    const type = stage === 'generate' ? 1 : 10
    const { client } = provider(path => path.includes('/sub/list')
      ? { total: 1, rows: [child(51, 'succeeded', type)] } : task('succeeded', type))
    const hook = watchJob(client, { task_id: 42, stage }, config)
    hooks.push(hook)
    const parsed: unknown = JSON.parse((await hook.done).result!)
    const reviewGuidance: unknown = expect.stringContaining('not visual QA')
    expect(parsed).toMatchObject({ stage, next: reviewGuidance })
  })
})
