/** Existing videos remain extractable across model choices; incomplete inventory never establishes absence. */
import { describe, expect, it, vi } from 'vitest'
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
    if (override instanceof Response) return override
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

describe('card-bound existing source discovery', () => {
  it('accepts the explicit storyboardId identity when a card omits id', async () => {
    const { client } = fixture(path => path === '/aigc/storyboard/2165139'
      ? { storyboardId: 2165139, scriptId: 5542 } : undefined)
    expect(await readVideoSources(client, args, defaults)).toMatchObject({ complete: true, sources: [{ task_id: 77 }] })
  })

  it('retains linked candidates after an incomplete project page without claiming a mismatch', async () => {
    const { client } = fixture(path => path.includes('/byStoryboard/') ? { total: 2, rows: [task()] }
      : path.includes('/task/list?') ? { total: 2, rows: [] } : undefined)
    const result = await readVideoSources(client, args, defaults)
    expect(result.complete).toBe(false)
    expect(result.issues).not.toContain('HISTORY_TASK_MISMATCH')
    expect(result.sources).toHaveLength(1)
  })

  it.each([{ linked: [] }, { linked: [task(), task()] }])('reconciles missing or repeated linked card hints %j', async ({ linked }) => {
    const rows = linked.length ? linked : [task(77, { storyboardId: undefined })]
    const { client } = fixture(path => path.includes('/byStoryboard/') ? { total: 3, rows }
      : path.includes('/task/list?') ? { total: 1, rows: [task(77, { storyboardId: undefined })] } : undefined)
    const result = await readVideoSources(client, args, defaults)
    expect(result.sources).toHaveLength(1)
    expect(result.issues).toEqual([])
  })

  it.each([
    [{ taskStatus: null }, 'CHILD_STATUS_UNKNOWN'],
    [{ id: null, subTaskId: null }, 'CHILD_IDENTITY_MISMATCH'],
    [{ resultList: [] }, 'SUCCESS_WITHOUT_MEDIA'],
    [{ resultList: [{ tosVideoUrl: 'https://' }] }, 'UNREADABLE_MEDIA_URL'],
    [{ resultList: [{ tosVideoUrl: 'http://media.example/old.mp4' }] }, 'UNREADABLE_MEDIA_URL'],
    [{ resultList: [{ tosVideoUrl: 'https://:secret@media.example/old.mp4' }] }, 'UNREADABLE_MEDIA_URL'],
    [{ resultList: [{ tosVideoUrl: 'https://media.example\\old.mp4' }] }, 'UNREADABLE_MEDIA_URL'],
  ])('retains incomplete child evidence %j', async (fields, issue) => {
    const { client } = fixture(path => path.includes('/sub/list?') ? { total: 1, rows: [child(88, fields)] } : undefined)
    const result = await readVideoSources(client, args, defaults)
    expect(result.complete).toBe(false)
    expect(result.issues).toContain(issue)
  })

  it.each([{ script_id: 0, storyboard_id: 2165139 }, { script_id: 5542, storyboard_id: 0 }])(
    'rejects invalid source identity before a request: %j', async (identity) => {
      const { client, calls } = fixture()
      await expect(readVideoSources(client, identity, defaults)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
      expect(calls).toEqual([])
    },
  )

  it('reports an unreadable card request while preserving the transport failure', async () => {
    const { client } = fixture()
    const request = vi.spyOn(client, 'request').mockRejectedValueOnce(new Error('socket unavailable'))
    try {
      expect(await readVideoSources(client, args, defaults)).toMatchObject({ status: 'unknown', complete: false, issues: ['READ_FAILED'] })
    } finally { request.mockRestore() }
  })

  it.each(['history', 'project', 'child'] as const)('retains transport failures at the %s lookup', async (stage) => {
    const { client } = fixture((path) => {
      if (path.includes('/byStoryboard/')) return stage === 'history' ? new JubianError('NETWORK_ERROR')
        : stage === 'project' ? { total: 2, rows: [] } : undefined
      if (path.includes('/task/list?')) return stage === 'project' ? new JubianError('NETWORK_ERROR') : { total: 0, rows: [] }
      if (path.includes('/sub/list?') && stage === 'child') return new JubianError('NETWORK_ERROR')
      return undefined
    })
    const result = await readVideoSources(client, args, defaults, new AbortController().signal)
    expect(result.complete).toBe(false)
    expect(result.issues).toContain('NETWORK_ERROR')
  })

  it.each([{}, { total: 'invalid', rows: [] }])('rejects an unreadable linked page: %j', async (page) => {
    const { client } = fixture(path => path.includes('/byStoryboard/') ? page
      : path.includes('/task/list?') ? new JubianError('NETWORK_ERROR') : undefined)
    const result = await readVideoSources(client, args, defaults)
    expect(result.complete).toBe(false)
    expect(result.sources).toEqual([])
  })

  it.each([{}, task(77, { storyboardId: 4 }), task(77, { scriptId: 9 })])(
    'retains contradictory linked inventory evidence: %j', async (candidate) => {
      const { client } = fixture(path => path.includes('/byStoryboard/') ? { total: 2, rows: [candidate] }
        : path.includes('/task/list?') ? { total: 1, rows: [task(77, { storyboardId: undefined })] } : undefined)
      const result = await readVideoSources(client, args, defaults)
      expect(result.complete).toBe(Object.keys(candidate).length === 0)
    },
  )

  it('limits task hydration without authorizing a new task', async () => {
    const { client } = fixture(path => path.includes('/byStoryboard/') ? [task(), task(78)] : undefined)
    const result = await readVideoSources(client, args, { ...defaults, taskLimit: 1 })
    expect(result.issues).toContain('TASK_LIMIT')
    expect(result.coverage.tasks_checked).toBe(1)
  })

  it('retains linked tasks missing from a complete project inventory as incomplete history', async () => {
    const { client } = fixture(path => path.includes('/byStoryboard/') ? { total: 2, rows: [task()] }
      : path.includes('/task/list?') ? { total: 0, rows: [] } : undefined)
    const result = await readVideoSources(client, args, defaults)
    expect(result.issues).toContain('HISTORY_TASK_MISMATCH')
    expect(result.sources).toHaveLength(1)
  })

  it('ignores unrelated child card ownership when the parent card is unknown', async () => {
    const { client } = fixture(path => path.includes('/byStoryboard/') ? [task(77, { storyboardId: undefined })]
      : path.endsWith('/task/77') ? task(77, { storyboardId: undefined })
        : path.includes('/sub/list?') ? { total: 1, rows: [child(88, { storyboardId: 4 })] } : undefined)
    const result = await readVideoSources(client, args, defaults)
    expect(result.issues).toContain('TASK_CARD_UNKNOWN')
    expect(result.issues).not.toContain('CHILD_CARD_MISMATCH')
  })

  it.each(['card', 'project'] as const)('reads actual single-row response envelopes from %s history', async (history) => {
    const { client } = fixture(path => path.includes('/byStoryboard/')
      ? history === 'card' ? new Response(JSON.stringify([task()])) : null
      : path.includes('/task/list?') ? new Response(JSON.stringify([task()])) : undefined)
    const result = await readVideoSources(client, args, defaults)
    expect(result.sources).toHaveLength(history === 'card' ? 1 : 0)
    expect(result.complete).toBe(history === 'card')
    if (history === 'project') expect(result.issues).toContain('UNSTABLE_TASK_TOTAL')
  })

  it('reads provider list aliases and source identity aliases', async () => {
    const { client } = fixture(path => path.includes('/byStoryboard/') ? { total: 1, list: [task()] }
      : path.includes('/sub/list?') ? { total: 1, list: [child(88, { id: undefined, subTaskId: 88 })] } : undefined)
    expect(await readVideoSources(client, args, defaults)).toMatchObject({ complete: true, sources: [{ subtask_id: 88 }] })
  })

  it.each([false, true])('reconciles linked ownership with a matching project task, conflicting project=%s', async (conflict) => {
    const { client } = fixture(path => path.includes('/byStoryboard/') ? { total: 2, rows: [task()] }
      : path.includes('/task/list?') ? { total: 1, rows: [task(77, { storyboardId: conflict ? 4 : undefined })] } : undefined)
    const result = await readVideoSources(client, args, defaults)
    expect(result.sources).toHaveLength(1)
    expect(result.complete).toBe(!conflict)
    if (conflict) expect(result.issues).toContain('HISTORY_TASK_MISMATCH')
  })

  it('keeps a task detail belonging to another card out of linked history', async () => {
    const { client } = fixture(path => path.includes('/byStoryboard/') ? [task(77, { storyboardId: undefined })]
      : path.endsWith('/task/77') ? task(77, { storyboardId: 4 }) : undefined)
    const result = await readVideoSources(client, args, defaults)
    expect(result.issues).toContain('LINKED_CARD_MISMATCH')
    expect(result.sources).toEqual([])
  })

  it('propagates direct request cancellation without replacing it with an incomplete report', async () => {
    const { client } = fixture()
    const cancellation = new DOMException('stopped', 'AbortError')
    const request = vi.spyOn(client, 'request').mockRejectedValueOnce(cancellation)
    try { await expect(readVideoSources(client, args, defaults)).rejects.toBe(cancellation) }
    finally { request.mockRestore() }
  })

  it.each([
    ['card data', '/aigc/storyboard/2165139', 'invalid', 'UNREADABLE_CARD'],
    ['task data', '/admin/aigc/video/task/77', 'invalid', 'UNREADABLE_TASK'],
    ['task identity', '/aigc/storyboard/byStoryboard/2165139', [{}], 'TASK_IDENTITY_MISMATCH'],
    ['repeated task', '/aigc/storyboard/byStoryboard/2165139', [task(), task()], 'TASK_IDENTITY_MISMATCH'],
    ['linked project', '/aigc/storyboard/byStoryboard/2165139', [task(77, { scriptId: 9 })], 'TASK_IDENTITY_MISMATCH'],
    ['child card', '/admin/aigc/video/task/sub/list?', { total: 1, rows: [child(88, { storyboardId: 4 })] }, 'CHILD_CARD_MISMATCH'],
    ['child status', '/admin/aigc/video/task/sub/list?', { total: 1, rows: [child(88, { taskStatus: '' })] }, 'CHILD_STATUS_UNKNOWN'],
    ['child results', '/admin/aigc/video/task/sub/list?', { total: 1, rows: [child(88, { resultList: [null] })] }, 'UNREADABLE_CHILD'],
    ['empty child page', '/admin/aigc/video/task/sub/list?', { total: 1, rows: [] }, 'INCOMPLETE_CHILD_PAGE'],
    ['overfull child page', '/admin/aigc/video/task/sub/list?', { total: 0, rows: [child()] }, 'INCOMPLETE_CHILD_PAGE'],
  ])('retains incomplete coverage for malformed %s', async (_name, endpoint, data, issue) => {
    const { client } = fixture(path => path.startsWith(endpoint) ? data : undefined)
    const result = await readVideoSources(client, args, defaults)
    expect(result.complete).toBe(false)
    expect(result.issues).toContain(issue)
  })

  it('reports absent parent status when neither listing nor detail identifies it', async () => {
    const { client } = fixture(path => path.includes('/byStoryboard/') ? [task(77, { taskStatus: '' })]
      : path.endsWith('/task/77') ? task(77, { taskStatus: '' }) : undefined)
    const result = await readVideoSources(client, args, defaults)
    expect(result.complete).toBe(false)
    expect(result.issues).toContain('TASK_STATUS_UNKNOWN')
  })

  it.each([
    [{ total: 0, rows: [task()] }, 'INCOMPLETE_TASK_PAGE'],
    [{ total: 1, rows: [] }, 'INCOMPLETE_TASK_PAGE'],
  ])('rejects an incomplete project inventory %j', async (page, issue) => {
    const { client } = fixture(path => path.includes('/byStoryboard/') ? null
      : path.includes('/task/list?') ? page : undefined)
    const result = await readVideoSources(client, args, defaults)
    expect(result.complete).toBe(false)
    expect(result.issues).toContain(issue)
  })

  it.each([true, false])('requires card ownership when parent ownership is absent, child absent=%s', async (absent) => {
    const { client } = fixture(path => path.includes('/byStoryboard/') ? [task(77, { storyboardId: undefined })]
      : path.endsWith('/task/77') ? task(77, { storyboardId: undefined })
        : path.includes('/sub/list?') ? { total: absent ? 0 : 1,
          rows: absent ? [] : [child(88, { storyboardId: undefined })] } : undefined)
    const result = await readVideoSources(client, args, defaults)
    expect(result.sources).toEqual([])
    expect(result.issues).toContain('TASK_CARD_UNKNOWN')
    if (!absent) expect(result.issues).toContain('CHILD_CARD_UNKNOWN')
  })

  it('drops oversized task-only output while retaining an explicit incomplete finding', async () => {
    const { client } = fixture(path => path.endsWith('/task/77') ? task(77, { taskStatus: 'x'.repeat(3000) })
      : path.includes('/sub/list?') ? { total: 0, rows: [] } : undefined)
    const result = await readVideoSources(client, args, { ...defaults, maxResultChars: 2048 })
    expect(result.tasks).toEqual([])
    expect(result.issues).toContain('OUTPUT_LIMIT')
    expect(result.status).toBe('unknown')
  })

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
    const inventory = await readVideoSources(client, args, defaults)
    expect(inventory).toMatchObject({ status: 'unknown', complete: false, sources: [] })
    expect(inventory.issues).toContain('HISTORY_TASK_MISMATCH')
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
    const inventory = await readVideoSources(client, args, defaults)
    expect(inventory).toMatchObject({ status: 'pending', complete: true,
      sources: [], tasks: [{ task_id: 77, status: 'running' }] })
    expect(inventory.next).toContain('继续查询原 task_id')
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
    const inventory = await readVideoSources(client, args, { ...defaults, pageSize: 1 })
    expect(inventory).toMatchObject({ status: 'available', complete: false })
    expect(inventory.issues).toEqual(expect.arrayContaining(['CHILD_IDENTITY_MISMATCH', 'CHILD_SCAN_INCOMPLETE']))
    expect(calls.filter(call => call.path.includes('/sub/list?'))).toHaveLength(2)
  })
  it('reports unknown after an unreadable lookup instead of declaring absence', async () => {
    const { client } = fixture(path => path.includes('/byStoryboard/') || path.includes('/task/list?') ? null : undefined)
    expect(await readVideoSources(client, args, defaults)).toMatchObject({ status: 'unknown', complete: false, sources: [] })
  })
  it('does not treat a bare project task page as the complete project history', async () => {
    const { client } = fixture(path => path.includes('/byStoryboard/') ? { total: 2, rows: [] }
      : path.includes('/task/list?') ? [task(76, { storyboardId: 2165140 })] : undefined)
    const inventory = await readVideoSources(client, args, defaults)
    expect(inventory).toMatchObject({ status: 'unknown', complete: false, sources: [] })
    expect(inventory.issues).toContain('TASK_SCAN_INCOMPLETE')
  })
  it('does not treat a bare child page as the complete task result history', async () => {
    const { client } = fixture(path => path.includes('/sub/list?') ? [child()] : undefined)
    const inventory = await readVideoSources(client, args, defaults)
    expect(inventory).toMatchObject({ status: 'unknown', complete: false, sources: [] })
    expect(inventory.issues).toContain('CHILD_SCAN_INCOMPLETE')
  })
  it('only reports none_found after an explicit complete empty original-card history', async () => {
    const { client } = fixture(path => path.includes('/byStoryboard/') ? [] : undefined)
    const inventory = await readVideoSources(client, args, defaults)
    expect(inventory).toMatchObject({ status: 'none_found', complete: true })
    expect(inventory.next).toContain('不是新生成授权')
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
    const inventory = await readVideoSources(client, args, { ...defaults, pageSize: 1 })
    expect(inventory).toMatchObject({ status: 'available', complete: false })
    expect(inventory.issues).toEqual(expect.arrayContaining(['TASK_IDENTITY_MISMATCH', 'TASK_SCAN_INCOMPLETE']))
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
  it.each([true, false])('uses the read-only dispatcher with explicit source bounds=%s', async (configured) => {
    const { client } = fixture()
    const ledger = new JubianLedger({ root: '/unused-video-sources-fixture' })
    expect(await videoMethod(client, ledger, { method: 'sources', ...args }, configured ? { videoSources: defaults } : {}))
      .toMatchObject({ sources: { status: 'available', sources: [{ task_id: 77 }] } })
  })
})

describe('task page coverage', () => {
  it('forwards cancellation through the task-page request', async () => {
    const { client } = fixture(path => path.includes('/task/list?') ? { total: 0, rows: [] } : undefined)
    const request = vi.spyOn(client, 'request')
    const signal = new AbortController().signal
    try {
      await videoMethod(client, new JubianLedger({ root: '/unused-video-page-fixture' }),
        { method: 'tasks', script_id: 5542 }, { signal })
      expect(request.mock.calls[0]?.[0].signal).toBe(signal)
    } finally { request.mockRestore() }
  })

  it('sends page_size and explicitly reports a partial project page', async () => {
    const { client, calls } = fixture(path => path.includes('/task/list?') ? { total: 26, rows: [task()] } : undefined)
    const ledger = new JubianLedger({ root: '/unused-video-page-fixture' })
    const page = await videoMethod(client, ledger, { method: 'tasks', script_id: 5542, page_num: 1, page_size: 50 })
    expect(page).toMatchObject({ tasks: { total: 26, returned: 1, page_num: 1, page_size: 50, complete: false,
      has_more: true, next_page: 2, total_verified: true } })
    expect(page.guidance).toContain('仅是本页')
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
