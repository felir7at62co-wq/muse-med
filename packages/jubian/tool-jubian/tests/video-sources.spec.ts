/** Existing videos remain extractable across model choices; incomplete inventory never establishes absence. */
import { describe, expect, it } from 'vitest'
import { JubianClient, JubianError, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { readVideoSources, resolveVideoSourceOptions } from '../src/video-sources.ts'
import { videoMethod } from '../src/methods.ts'

type Row = Record<string, unknown>
const task = (id = 77, extra: Row = {}): Row => ({ id, scriptId: 5542, storyboardId: 2165139,
  taskType: 1, taskStatus: 'succeeded', ...extra })
const child = (id = 88, extra: Row = {}): Row => ({ id, aigcVideoTaskId: 77, scriptId: 5542,
  storyboardId: 2165139, taskStatus: 'succeeded', modelId: 'old-model', resolution: '720p',
  resultList: [{ firstResultId: 99, tosVideoUrl: 'https://media.example/old.mp4' }], ...extra })
function fixture(overrides: (path: string, body: Row | undefined) => unknown = () => undefined) {
  const calls: { method: string; path: string; body: Row | undefined }[] = []
  const client = new JubianClient({ credential: async () => 'fixture-token', fetch: async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const path = url.pathname.replace('/prod-api', '') + url.search
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Row : undefined
    calls.push({ method: String(init?.method), path, body })
    const override = overrides(path, body)
    if (override instanceof Error) throw override
    let data = override
    if (data === undefined) {
      if (path === '/aigc/storyboard/2165139') data = { id: 2165139, scriptId: 5542 }
      else if (path === '/aigc/storyboard/byStoryboard/2165139') data = [task()]
      else if (path === '/admin/aigc/video/task/77') data = task()
      else if (path.startsWith('/admin/aigc/video/task/sub/list?')) data = { total: 1, rows: [child()] }
      else throw new Error(`Unexpected fixture read: ${path}`)
    }
    return new Response(JSON.stringify({ code: 200, data }))
  } })
  return { client, calls }
}
const args = { script_id: 5542, storyboard_id: 2165139 }
const defaults = resolveVideoSourceOptions()

/** Keep Vitest asymmetric values unknown-typed inside partial result assertions. */
function includesIssues(values: string[]): unknown {
  return expect.arrayContaining(values)
}

/** Match advisory wording without weakening the surrounding typed fixture. */
function includesText(value: string): unknown {
  return expect.stringContaining(value)
}

describe('card-bound existing source discovery', () => {
  it('returns a verified old-model source without any generation or write', async () => {
    const { client, calls } = fixture()
    expect(await readVideoSources(client, args, defaults)).toMatchObject({ ...args, status: 'available', complete: true,
      sources: [{ task_id: 77, subtask_id: 88, first_result_id: 99, model_id: 'old-model', resolution: '720p',
        video_url: 'https://media.example/old.mp4' }] })
    expect(calls.every(call => call.method === 'GET'
      || (call.method === 'POST' && call.path.startsWith('/admin/aigc/video/task/sub/list?')))).toBe(true)
    expect(calls.at(-1)?.body).toEqual({ aigcVideoTaskId: 77 })
  })
  it('finds the original card on a later task page and reports complete coverage', async () => {
    const { client, calls } = fixture((path) => {
      if (path.includes('/byStoryboard/')) return { total: 2, rows: [] }
      if (path.includes('/task/list?')) return { total: 2, rows: path.includes('pageNum=1')
        ? [task(76, { storyboardId: 2165140 })] : [task()] }
      return undefined
    })
    const result = await readVideoSources(client, args, { ...defaults, pageSize: 1 })
    expect(result).toMatchObject({ status: 'available', complete: true, coverage: { history: 'project', tasks_checked: 1 } })
    expect(calls.filter(call => call.path.includes('/task/list?')).map(call => call.path)).toEqual([
      expect.stringContaining('pageNum=1&pageSize=1'), expect.stringContaining('pageNum=2&pageSize=1') ])
    expect(calls.some(call => call.path.endsWith('/task/76'))).toBe(false)
  })
  it('continues when the provider returns fewer rows than requested but has additional pages', async () => {
    const { client } = fixture((path) => {
      if (path.includes('/byStoryboard/')) return { total: 2, rows: [] }
      if (path.includes('/task/list?')) return { total: 2, rows: path.includes('pageNum=1')
        ? [task(76, { storyboardId: 2165140 })] : [task()] }
      return undefined
    })
    expect(await readVideoSources(client, args, defaults)).toMatchObject({ status: 'available', complete: true })
  })
  it.each([
    { total: 0, rows: [] },
    { total: 1, rows: [task(76, { storyboardId: 2165140 })] },
  ])('retains a linked task absent from the complete project inventory with $total rows', async (inventory) => {
    const { client, calls } = fixture(path => path.includes('/byStoryboard/') ? { total: 2, rows: [task()] }
      : path.includes('/task/list?') ? inventory : undefined)
    expect(await readVideoSources(client, args, defaults)).toMatchObject({ status: 'available', complete: false,
      sources: [{ task_id: 77, subtask_id: 88, video_url: 'https://media.example/old.mp4' }],
      issues: ['HISTORY_TASK_MISMATCH'], coverage: { history: 'project', tasks_checked: 1, results_found: 1 } })
    expect(calls.some(call => call.path.endsWith('/task/77'))).toBe(true)
    expect(calls.some(call => call.path.endsWith('/task/76'))).toBe(false)
  })
  it('hydrates matching linked and project tasks only once', async () => {
    const { client, calls } = fixture(path => path.includes('/byStoryboard/') ? { total: 2, rows: [task()] }
      : path.includes('/task/list?') ? { total: 1, rows: [task()] } : undefined)
    expect(await readVideoSources(client, args, defaults)).toMatchObject({ status: 'available', complete: true,
      sources: [{ task_id: 77 }], issues: [], coverage: { tasks_found: 1, tasks_checked: 1 } })
    expect(calls.filter(call => call.path.endsWith('/task/77'))).toHaveLength(1)
  })
  it('retains a nonconflicting linked card identity when the project task omits it', async () => {
    const { client } = fixture(path => path.includes('/byStoryboard/') ? { total: 2, rows: [task()] }
      : path.includes('/task/list?') ? { total: 1, rows: [task(77, { storyboardId: undefined })] }
        : path.endsWith('/task/77') ? task(77, { storyboardId: undefined })
          : path.includes('/sub/list?') ? { total: 1, rows: [child(88, { storyboardId: undefined })] } : undefined)
    expect(await readVideoSources(client, args, defaults)).toMatchObject({ status: 'available', complete: true,
      sources: [{ task_id: 77, subtask_id: 88 }], issues: [] })
  })
  it.each([task(), { id: 77 }])('reconciles same-task owner conflicts through independent detail and child reads: %j', async (linkedTask) => {
    const { client, calls } = fixture(path => path.includes('/byStoryboard/') ? { total: 2, rows: [linkedTask] }
      : path.includes('/task/list?') ? { total: 1, rows: [task(77, { storyboardId: 2165140 })] } : undefined)
    expect(await readVideoSources(client, args, defaults)).toMatchObject({ status: 'available', complete: false,
      sources: [{ task_id: 77, subtask_id: 88 }], issues: ['HISTORY_TASK_MISMATCH'] })
    expect(calls.filter(call => call.path.endsWith('/task/77'))).toHaveLength(1)
  })
  it('keeps same-task owner conflicts unknown when the independent detail belongs to another card', async () => {
    const { client, calls } = fixture(path => path.includes('/byStoryboard/') ? { total: 2, rows: [task()] }
      : path.includes('/task/list?') ? { total: 1, rows: [task(77, { storyboardId: 2165140 })] }
        : path.endsWith('/task/77') ? task(77, { storyboardId: 2165140 }) : undefined)
    expect(await readVideoSources(client, args, defaults)).toMatchObject({ status: 'unknown', complete: false,
      sources: [], issues: ['HISTORY_TASK_MISMATCH'] })
    expect(calls.filter(call => call.path.endsWith('/task/77'))).toHaveLength(1)
    expect(calls.some(call => call.path.includes('/sub/list?'))).toBe(false)
  })
  it.each([
    child(88, { storyboardId: 2165140 }), child(88, { aigcVideoTaskId: 123 }), child(88, { scriptId: 9 }),
  ])('rejects mismatched children after reconciling same-task owner conflicts: %j', async (result) => {
    const { client } = fixture(path => path.includes('/byStoryboard/') ? { total: 2, rows: [task()] }
      : path.includes('/task/list?') ? { total: 1, rows: [task(77, { storyboardId: 2165140 })] }
        : path.includes('/sub/list?') ? { total: 1, rows: [result] } : undefined)
    expect(await readVideoSources(client, args, defaults)).toMatchObject({ status: 'unknown', complete: false,
      sources: [], issues: includesIssues(['HISTORY_TASK_MISMATCH']) })
  })
  it('recovers complete coverage from a verified project inventory after unreadable linked history', async () => {
    const { client } = fixture(path => path.includes('/byStoryboard/') ? null
      : path.includes('/task/list?') ? { total: 1, rows: [task()] } : undefined)
    expect(await readVideoSources(client, args, defaults)).toMatchObject({ status: 'available', complete: true,
      sources: [{ task_id: 77 }], issues: [], coverage: { history: 'project', tasks_checked: 1 } })
  })
  it('keeps original running task identity and never asks for a new generation', async () => {
    const { client } = fixture(path => path.endsWith('/task/77') ? task(77, { taskStatus: 'running' })
      : path.includes('/sub/list?') ? { total: 0, rows: [] } : undefined)
    expect(await readVideoSources(client, args, defaults)).toMatchObject({ status: 'pending', complete: true,
      sources: [], tasks: [{ task_id: 77, status: 'running' }], next: includesText('继续查询原 task_id') })
  })
  it('keeps waiting for an independently running child even when the parent reports success', async () => {
    const { client } = fixture(path => path.includes('/sub/list?')
      ? { total: 1, rows: [child(88, { taskStatus: 'running', resultList: [] })] } : undefined)
    expect(await readVideoSources(client, args, defaults)).toMatchObject({ status: 'pending', complete: true, sources: [] })
  })
  it('marks a linked history that names another card unknown', async () => {
    const { client } = fixture(path => path.includes('/byStoryboard/') ? [task(77, { storyboardId: 2165140 })] : undefined)
    expect(await readVideoSources(client, args, defaults)).toMatchObject({ status: 'unknown', complete: false,
      issues: ['LINKED_CARD_MISMATCH'], sources: [] })
  })
  it('stops a repeated child page without exhausting every configured page', async () => {
    const { client, calls } = fixture(path => path.includes('/sub/list?') ? { total: 2, rows: [child()] } : undefined)
    expect(await readVideoSources(client, args, { ...defaults, pageSize: 1 })).toMatchObject({ status: 'available', complete: false,
      issues: includesIssues(['CHILD_IDENTITY_MISMATCH', 'CHILD_SCAN_INCOMPLETE']) })
    expect(calls.filter(call => call.path.includes('/sub/list?'))).toHaveLength(2)
  })
  it('reports unknown after an unreadable lookup instead of declaring absence', async () => {
    const { client } = fixture(path => path.includes('/byStoryboard/') || path.includes('/task/list?') ? null : undefined)
    expect(await readVideoSources(client, args, defaults)).toMatchObject({ status: 'unknown', complete: false, sources: [] })
  })
  it('does not treat a bare project task page as the complete project history', async () => {
    const { client } = fixture(path => path.includes('/byStoryboard/') ? { total: 2, rows: [] }
      : path.includes('/task/list?') ? [task(76, { storyboardId: 2165140 })] : undefined)
    expect(await readVideoSources(client, args, defaults)).toMatchObject({ status: 'unknown', complete: false,
      sources: [], issues: includesIssues(['TASK_SCAN_INCOMPLETE']) })
  })
  it('does not treat a bare child page as the complete task result history', async () => {
    const { client } = fixture(path => path.includes('/sub/list?') ? [child()] : undefined)
    expect(await readVideoSources(client, args, defaults)).toMatchObject({ status: 'unknown', complete: false,
      sources: [], issues: includesIssues(['CHILD_SCAN_INCOMPLETE']) })
  })
  it('only reports none_found after an explicit complete empty original-card history', async () => {
    const { client } = fixture(path => path.includes('/byStoryboard/') ? [] : undefined)
    expect(await readVideoSources(client, args, defaults)).toMatchObject({ status: 'none_found', complete: true,
      next: includesText('不是新生成授权') })
  })
  it.each([
    ['card', { id: 2165139, scriptId: 9 }],
    ['task', task(77, { scriptId: 9 })],
    ['task', task(77, { storyboardId: 2165140 })],
    ['child', child(88, { aigcVideoTaskId: 123 })],
    ['child', child(88, { scriptId: 9 })],
    ['child', child(88, { storyboardId: 2165140 })],
    ['child', child(88, { resultList: [{ tosVideoUrl: 'https://user:secret@media.example/old.mp4' }] })],
  ])('does not return media with mismatched %s evidence', async (kind, value) => {
    const { client } = fixture(path => kind === 'card' && path === '/aigc/storyboard/2165139' ? value
      : kind === 'task' && path.endsWith('/task/77') ? value
        : kind === 'child' && path.includes('/sub/list?') ? { total: 1, rows: [value] } : undefined)
    expect(await readVideoSources(client, args, defaults)).toMatchObject({ status: 'unknown', complete: false, sources: [] })
  })
  it('keeps verified sources while marking a bounded result list incomplete', async () => {
    const { client } = fixture(path => path.includes('/sub/list?') ? { total: 2, rows: [child(), child(89)] } : undefined)
    expect(await readVideoSources(client, args, { ...defaults, resultLimit: 1 })).toMatchObject({ status: 'available', complete: false,
      sources: [{ subtask_id: 88 }], issues: ['RESULT_LIMIT'], coverage: { results_found: 2 } })
  })
  it('keeps verified sources if a later task read fails', async () => {
    const { client } = fixture(path => path.includes('/byStoryboard/') ? [task(), task(78)]
      : path.endsWith('/task/78') ? new JubianError('NETWORK_ERROR') : undefined)
    expect(await readVideoSources(client, args, defaults)).toMatchObject({ status: 'available', complete: false,
      sources: [{ task_id: 77 }], issues: ['NETWORK_ERROR'] })
  })
  it('marks a repeated paginated task inventory unknown without looping indefinitely', async () => {
    const { client } = fixture(path => path.includes('/byStoryboard/') ? null
      : path.includes('/task/list?') ? { total: 2, rows: [task()] } : undefined)
    expect(await readVideoSources(client, args, { ...defaults, pageSize: 1 })).toMatchObject({ status: 'available', complete: false,
      issues: includesIssues(['TASK_IDENTITY_MISMATCH', 'TASK_SCAN_INCOMPLETE']) })
  })
  it('propagates cancellation before issuing a read', async () => {
    const { client, calls } = fixture()
    const controller = new AbortController(); controller.abort()
    await expect(readVideoSources(client, args, defaults, controller.signal)).rejects.toThrow()
    expect(calls).toEqual([])
  })
  it.each(['https://media.example/' + 'a'.repeat(10000) + '.mp4', 'https://media.example/old.mp4'])(
    'omits complete source rows when a URL or model makes the complete JSON too long', async (url) => {
      const { client } = fixture(path => path.includes('/sub/list?') ? { total: 1, rows: [child(88, {
        modelId: '模型'.repeat(5000), resultList: [{ tosVideoUrl: url }],
      })] } : undefined)
      const result = await readVideoSources(client, args, { ...defaults, maxResultChars: 2048 })
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(2048)
      expect(result).toMatchObject({ status: 'unknown', complete: false, sources: [], issues: ['OUTPUT_LIMIT'],
        coverage: { results_found: 1, tasks_found: 1, tasks_checked: 1 } })
    })
  it('retains complete source rows at the exact complete-result limit and omits them one character below', async () => {
    const { client } = fixture(path => path.includes('/sub/list?') ? { total: 1, rows: [child(88, {
      modelId: '中'.repeat(2400),
    })] } : undefined)
    const full = await readVideoSources(client, args, { ...defaults, maxResultChars: 1000000 })
    const length = JSON.stringify(full).length
    expect(length).toBeGreaterThanOrEqual(2048)
    expect(Buffer.byteLength(JSON.stringify(full), 'utf8')).toBeGreaterThan(length)
    const exact = await readVideoSources(client, args, { ...defaults, maxResultChars: length })
    expect(exact).toMatchObject({ status: 'available', complete: true, sources: [{ model_id: '中'.repeat(2400) }] })
    expect(JSON.stringify(exact).length).toBe(length)
    const under = await readVideoSources(client, args, { ...defaults, maxResultChars: length - 1 })
    expect(under).toMatchObject({ status: 'unknown', complete: false, sources: [], issues: ['OUTPUT_LIMIT'] })
    expect(JSON.stringify(under).length).toBeLessThanOrEqual(length - 1)
  })
  it('omits task rows when their status text exceeds the full result budget', async () => {
    const { client } = fixture(path => path.endsWith('/task/77') ? task(77, { taskStatus: '待处理'.repeat(3000) })
      : path.includes('/sub/list?') ? { total: 0, rows: [] } : undefined)
    const result = await readVideoSources(client, args, { ...defaults, maxResultChars: 2048 })
    expect(result).toMatchObject({ status: 'unknown', complete: false, tasks: [], sources: [], issues: ['OUTPUT_LIMIT'],
      coverage: { tasks_found: 1, tasks_checked: 1 } })
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(2048)
  })
  it('uses the same read-only reader through the public method dispatcher', async () => {
    const { client } = fixture()
    const ledger = new JubianLedger({ root: '/unused-video-sources-fixture' })
    expect(await videoMethod(client, ledger, { method: 'sources', ...args }, { videoSources: defaults }))
      .toMatchObject({ sources: { status: 'available', sources: [{ task_id: 77 }] } })
  })
})

describe('task page coverage', () => {
  it('sends page_size and explicitly reports a partial project page', async () => {
    const { client, calls } = fixture(path => path.includes('/task/list?') ? { total: 26, rows: [task()] } : undefined)
    const ledger = new JubianLedger({ root: '/unused-video-page-fixture' })
    expect(await videoMethod(client, ledger, { method: 'tasks', script_id: 5542, page_num: 1, page_size: 50 }))
      .toMatchObject({ tasks: { total: 26, returned: 1, page_num: 1, page_size: 50, complete: false,
        has_more: true, next_page: 2, total_verified: true }, guidance: includesText('仅是本页') })
    expect(calls[0]?.path).toContain('taskType=1&pageNum=1&pageSize=50')
  })
  it('keeps a next page when the provider may have clamped a later page below the requested size', async () => {
    const { client } = fixture(path => path.includes('/task/list?')
      ? { total: 26, rows: Array.from({ length: 10 }, (_, index) => task(77 + index)) } : undefined)
    const ledger = new JubianLedger({ root: '/unused-video-page-fixture' })
    expect(await videoMethod(client, ledger, { method: 'tasks', script_id: 5542, page_num: 2, page_size: 50 }))
      .toMatchObject({ tasks: { total: 26, returned: 10, page_num: 2, page_size: 50, complete: false,
        has_more: null, next_page: 3 } })
  })
  it('uses an explicit valid provider page size to identify a final page without claiming full coverage', async () => {
    const { client } = fixture(path => path.includes('/task/list?')
      ? { total: 26, pageSize: 10, rows: Array.from({ length: 6 }, (_, index) => task(77 + index)) } : undefined)
    const ledger = new JubianLedger({ root: '/unused-video-page-fixture' })
    expect(await videoMethod(client, ledger, { method: 'tasks', script_id: 5542, page_num: 3, page_size: 50 }))
      .toMatchObject({ tasks: { complete: false, has_more: false, next_page: null } })
  })
  it('does not infer complete history when the provider omits total', async () => {
    const { client } = fixture(path => path.includes('/task/list?') ? { rows: [] } : undefined)
    const ledger = new JubianLedger({ root: '/unused-video-page-fixture' })
    expect(await videoMethod(client, ledger, { method: 'tasks', script_id: 5542 }))
      .toMatchObject({ tasks: { complete: false, total_verified: false, has_more: null } })
  })
  it.each([{ page_num: 0 }, { page_size: 0 }, { page_num: 1.5 }, { page_size: 1001 }])('rejects invalid page selection %j', async (extra) => {
    const { client, calls } = fixture()
    const ledger = new JubianLedger({ root: '/unused-video-page-fixture' })
    await expect(videoMethod(client, ledger, { method: 'tasks', script_id: 5542, ...extra })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(calls).toEqual([])
  })
})

it.each([0, -1, 1001, 1.5])('rejects invalid source bounds before querying: %s', (value) => {
  expect(() => resolveVideoSourceOptions({ videoSourcePageSize: value })).toThrow()
})

it.each([0, 2047, 1000001, 2048.5])('rejects invalid complete-result character bounds: %s', (value) => {
  expect(() => resolveVideoSourceOptions({ videoSourceMaxResultChars: value })).toThrow()
})
