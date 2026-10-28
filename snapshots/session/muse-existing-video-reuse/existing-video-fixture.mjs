/** Offline video history with a reusable older-model result beyond the first task page. */
export const name = 'existing-video-fixture'

/** Mount isolated read-only responses and a deterministic query timestamp. */
export function apply(ctx) {
  ctx.effect(() => {
    const originalFetch = globalThis.fetch, OriginalDate = Date
    class FixtureDate extends OriginalDate {
      constructor(...args) { super(...(args.length === 0 ? [1793178000000] : args)) }
      static now() { return 1793178000000 }
    }
    globalThis.Date = FixtureDate
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (url.origin !== 'https://existing-video.invalid') throw new Error('Offline source fixture rejects external traffic')
      let data
      if (init?.method === 'GET' && url.pathname.endsWith('/aigc/storyboard/2165139')) {
        data = { id: 2165139, scriptId: 5542, episodeId: 116287 }
      } else if (init?.method === 'GET' && url.pathname.endsWith('/aigc/storyboard/byStoryboard/2165139')) {
        data = { total: 2, rows: [] }
      } else if (init?.method === 'GET' && url.pathname.endsWith('/admin/aigc/video/task/list')) {
        if (url.searchParams.get('scriptId') !== '5542' || url.searchParams.get('pageSize') !== '1') {
          throw new Error('The source query did not preserve its project or page size')
        }
        const page = url.searchParams.get('pageNum')
        if (page !== '1' && page !== '2') throw new Error('Unexpected source task page')
        data = { total: 2, rows: page === '1'
          ? [{ id: 681000, scriptId: 5542, storyboardId: 2165149, taskType: 1, taskStatus: 'succeeded' }]
          : [{ id: 681001, scriptId: 5542, storyboardId: 2165139, taskType: 1, taskStatus: 'succeeded' }] }
      } else if (init?.method === 'GET' && url.pathname.endsWith('/admin/aigc/video/task/681001')) {
        data = { id: 681001, scriptId: 5542, storyboardId: 2165139, taskType: 1, taskStatus: 'succeeded' }
      } else if (init?.method === 'POST' && url.pathname.endsWith('/admin/aigc/video/task/sub/list')) {
        if (String(JSON.parse(init.body).aigcVideoTaskId) !== '681001') throw new Error('Unexpected source parent task')
        data = { total: 1, rows: [{ id: 1200001, aigcVideoTaskId: 681001, scriptId: 5542,
          storyboardId: 2165139, taskStatus: 'succeeded', modelId: 'older-video-model', resolution: '720p',
          resultList: [{ firstResultId: 1201001,
            tosVideoUrl: 'https://jubian-aigc.tos-cn-beijing.volces.com/fixture/existing-ep07.mp4' }] }] }
      } else throw new Error('Offline source fixture rejects writes and unexpected traffic')
      return Response.json({ code: 200, data })
    }
    return () => { globalThis.fetch = originalFetch; globalThis.Date = OriginalDate }
  })
}
