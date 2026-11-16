/** Production grouping uses logged provider identities, never video labels or filenames. */
import { expect, it } from 'vitest'
import { foldVideoSources, sourceStateSchema, type VideoSourceState } from '../src/sources.ts'
import { productionVideoEvents } from './fixtures/production.ts'

const bounds = { maxSources: 20, maxResultBytes: 10_000 }
const empty = (): VideoSourceState => ({ sources: [], calls: [], complete: true, issues: [] })
const fold = (events: { seq: number; type: string; data: unknown }[], initial = empty()) =>
  events.reduce((state, event) => foldVideoSources(state, event, bounds), initial)
const output = (state: VideoSourceState, index = 0) => {
  const source = state.sources[index]
  return source === undefined ? undefined : state.productionBySource?.[source.key]
}
function tool(name: string, args: unknown, result: unknown, seq: number) {
  const callId = `call-${seq}`
  return [{ seq, type: 'tool/call', data: { callId, name, arguments: JSON.stringify(args) } },
    { seq: seq + 1, type: 'tool/result', data: { message: { toolCallId: callId, content: [{ type: 'text', text: JSON.stringify(result) }] } } }]
}

it('associates local downloads with exact project, task and display episode facts across multiple episodes', () => {
  const state = fold([...productionVideoEvents('first.mp4'), ...productionVideoEvents('second.mp4', 33, 133, 18, 7)])
  expect(output(state)).toEqual({ scriptId: 10, episodeId: 131, episodeNumber: 31, taskId: 17, subtaskId: 170 })
  expect(output(state, 1)).toEqual({ scriptId: 10, episodeId: 133, episodeNumber: 33, taskId: 18, subtaskId: 180 })
  expect(state.sources.map(source => source.key)).toEqual(['6:0', '12:0'])
  expect(sourceStateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state)
})

it('enriches an existing source when its episode directory is recorded later without changing its coordinate', () => {
  const events = productionVideoEvents('later.mp4')
  const state = fold(events.slice(2))
  expect(output(state)).toEqual({ scriptId: 10, taskId: 17, subtaskId: 170, episodeId: 131 })
  const next = fold(events.slice(0, 2).map(event => ({ ...event, seq: event.seq + 6 })), state)
  expect(output(next)?.episodeNumber).toBe(31)
  expect(next.sources[0]?.key).toBe(state.sources[0]?.key)
})

it('joins successful card history to recorded production package and authored shot numbers', () => {
  const state = fold([
    ...tool('muse_production', { method: 'read', plan_path: 'plan.json' }, { method: 'read', script_id: 10, episode: 31,
      package_index: [{ index: 2, storyboard_id: 51, shots: [3, 4] }] }, 1),
    ...tool('jubian_video', { method: 'sources', script_id: 10, storyboard_id: 51 }, {
      sources: { script_id: 10, storyboard_id: 51, sources: [{ task_id: 17, subtask_id: 170,
        status: 'completed', video_url: 'https://101.aigc.jubianai.net/clip.mp4' }] },
    }, 3),
  ])
  expect(output(state)).toEqual({ scriptId: 10, storyboardId: 51, taskId: 17, subtaskId: 170,
    episodeNumber: 31, packageIndex: 2, shotNumbers: [3, 4] })
})

it('keeps unassociated filenames and unknown provider tasks ungrouped', () => {
  const state = fold([{ seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '@EP31-P02.mp4' }] } },
    ...tool('jubian_media', { method: 'download', media_kind: 'video', task_id: 17 }, { path: 'EP33.mp4' }, 2)])
  expect(state.sources).toHaveLength(2)
  expect(output(state)).toBeUndefined()
  expect(output(state, 1)).toBeUndefined()
})

it('does not interpret an episode identity or task episode count as a display episode number', () => {
  const state = fold([
    ...tool('jubian_video', { method: 'task', task_id: 17 }, {
      task: { task_id: 17, script_id: 10, episode_id: 131, episode_count: 99 },
    }, 1),
    ...tool('jubian_media', { method: 'download', media_kind: 'video', task_id: 17 }, { path: 'episode.mp4' }, 3),
  ])
  expect(output(state)).toEqual({ scriptId: 10, taskId: 17, episodeId: 131 })
})

it('omits conflicting episode labels and refuses unrelated task results', () => {
  const state = fold([...productionVideoEvents('clip.mp4'),
    ...tool('jubian_model', { method: 'episodes', script_id: 10 }, {
      episodes: { rows: [{ episode_id: 131, episode_count: 32 }] },
    }, 7),
    ...tool('jubian_video', { method: 'task', task_id: 18 }, { task: { task_id: 99, script_id: 10, episode_id: 133 } }, 9),
    ...tool('jubian_media', { method: 'download', media_kind: 'video', task_id: 18 }, { path: 'unknown.mp4' }, 11),
  ])
  expect(output(state)).toEqual({ scriptId: 10, episodeId: 131, taskId: 17, subtaskId: 170 })
  expect(output(state, 1)).toBeUndefined()
})

it('reconstructs equivalent production facts and sources from committed PTC dispatch results', () => {
  const events = productionVideoEvents('ptc.mp4')
  const dispatches = events.flatMap((event, index) => {
    if (index % 2 !== 0) return []
    const call = event.data as { callId: string; name: string; arguments: string }
    const result = events[index + 1]?.data as { message: { content: unknown[] } }
    return [{ seq: event.seq + 1, type: 'tool/ptc-dispatch', data: { subCallId: call.callId,
      name: call.name, arguments: call.arguments, content: result.message.content, isError: false } }]
  })
  const state = fold(dispatches)
  expect(output(state)).toEqual(output(fold(events)))
  expect(state.sources[0]?.key).toBe('6:0')
  expect(state.calls).toEqual([])
})

it('marks bounded metadata as unavailable instead of retaining a misleading complete association', () => {
  const state = productionVideoEvents('bounded.mp4').reduce((previous, event) =>
    foldVideoSources(previous, event, { maxSources: 1, maxResultBytes: 10_000 }), empty())
  expect(state.productionUnavailable).toBe(true)
  expect(state.complete).toBe(false)
  expect(state.issues).toContain('video production metadata limit reached')
  expect(state.productionFacts).toHaveLength(1)
})
