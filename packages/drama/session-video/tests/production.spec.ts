/** Production grouping uses logged provider identities, never video labels or filenames. */
import { expect, it } from 'vitest'
import { foldVideoSources, sourceStateSchema, type VideoSourceState } from '../src/sources.ts'
import { productionVideoEvents } from './fixtures/production.ts'
import { productionFacts, resolveVideoProduction, videoProduction } from '../src/production.ts'

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

it('reads the shipped Jubian catalog episode directory without requiring the retired tool name', () => {
  const events = productionVideoEvents('catalog.mp4').map(event => event.type !== 'tool/call' ? event
    : { ...event, data: { ...event.data as Record<string, unknown>,
      name: (event.data as { name: string }).name === 'jubian_model' ? 'jubian_catalog' : (event.data as { name: string }).name } })
  expect(output(fold(events))?.episodeNumber).toBe(31)
})

it('retains version-bound production and the current selected interval through checkpoints and tool metadata', () => {
  const production = { scriptId: 4660, episodeNumber: 46, shotNumbers: [10, 11, 12],
    shotRanges: [{ shotNumber: 12, startSeconds: 7, endSeconds: 10.958 }] }
  const state = fold([
    { seq: 1, type: 'deliverables/presented', data: { files: [{ path: 'video.mp4' }] } },
    { seq: 2, type: 'tool/call', data: { name: 'muse_video', callId: 'binding', arguments: '{"method":"bind"}' } },
    { seq: 3, type: 'tool/result', data: { message: { toolCallId: 'binding', content: [] },
      meta: { museVideoBinding: { key: '1:0', sourceVersion: 'v1', production } } } },
    { seq: 4, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text',
      text: '<muse-video-selection>[{"source_id":"selected","source_version":"v1","start_seconds":7,"end_seconds":10.958}]</muse-video-selection>' }] } },
    { seq: 5, type: 'user/message', data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Current time' }] } },
  ])
  expect(state.bindings?.['1:0']?.production).toEqual(production)
  expect(state.reviewTargets).toEqual([{ source_id: 'selected', source_version: 'v1', start_seconds: 7, end_seconds: 10.958 }])
  expect(sourceStateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state)
  expect(fold([{ seq: 6, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'A different request' }] } }], state).reviewTargets).toEqual([])
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

it('ignores malformed production rows and correlates only matching card snapshots', () => {
  const catalog = { name: 'jubian_catalog', method: 'episodes', scriptId: 10, taskId: null }
  expect(productionFacts(catalog, { episodes: { rows: [null, {}, { episode_id: 1 }, { episode_count: 2 }] } })).toEqual([])
  const plan = { name: 'muse_production', taskId: null }
  expect(productionFacts(plan, { method: 'read', episode: 31 })).toEqual([])
  expect(productionFacts(plan, { method: 'read', script_id: 10, episode: 31, section: 'packages', rows: [
    null, {}, { storyboard_id: 51 }, { index: 2 }, { storyboard_id: 51, index: 2 }, { storyboard_id: 52, index: 3, shots: [0] },
  ] })).toEqual([{ scriptId: 10, episodeNumber: 31, storyboardId: 51, packageIndex: 2 }])
  const card = { name: 'jubian_storyboard', method: 'read', taskId: null }
  const result = { storyboard: { script_id: 10, storyboard_id: 51, snapshot: { episodeId: 131 } } }
  expect(productionFacts(card, result)).toEqual([{ scriptId: 10, storyboardId: 51, episodeId: 131 }])
  expect(productionFacts({ ...card, storyboardId: 51 }, { storyboard: { script_id: 10, storyboard_id: 51 } }))
    .toEqual([{ scriptId: 10, storyboardId: 51 }])
  for (const malformed of [{}, { storyboard: { script_id: 10 } }, result]) {
    expect(productionFacts({ ...card, storyboardId: 99 }, malformed)).toEqual([])
  }
  expect(productionFacts({ name: 'jubian_video', taskId: null }, { task: { task_id: 17, script_id: 10 },
    sources: { script_id: 10, storyboard_id: 51, sources: [{}, { task_id: -1 }, { task_id: 18 }] } }))
    .toEqual([{ scriptId: 10, taskId: 17 }, { scriptId: 10, storyboardId: 51, taskId: 18 }])
})

it('rejects mismatched generated-source cards and retains observed timing without inventing missing identities', () => {
  const call = { name: 'jubian_video', taskId: null, storyboardId: 51 }
  expect(videoProduction(call, { sources: { script_id: 10, storyboard_id: 99 } }, undefined, [])).toBeUndefined()
  expect(videoProduction(call, { sources: { script_id: 10, storyboard_id: 51 } }, undefined, []))
    .toEqual({ scriptId: 10, storyboardId: 51 })
  const source = { scriptId: 10, shotNumbers: [1], shotRanges: [{ shotNumber: 1, startSeconds: 0, endSeconds: 1 }] }
  const enriched = resolveVideoProduction(source, [{ scriptId: 10, episodeId: 1 }, { scriptId: 10, episodeId: 2 }])
  expect(enriched).toEqual(source)
  expect(enriched?.shotRanges).not.toBe(source.shotRanges)
  expect(resolveVideoProduction({ scriptId: 10, taskId: 17, shotNumbers: [1] }, [
    { scriptId: 10, taskId: 17, episodeId: 1, storyboardId: 51, shotNumbers: [2] },
    { scriptId: 10, storyboardId: 51, episodeId: 2, shotNumbers: [2] },
  ])).toEqual({ scriptId: 10, taskId: 17, storyboardId: 51 })
})
